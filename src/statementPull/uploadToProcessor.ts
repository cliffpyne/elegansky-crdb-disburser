import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { config } from "../config.js";

/**
 * POST a downloaded statement file to the transaction-processor's /upload
 * endpoint, then trigger /process. Mimics what a human operator does in the
 * browser today, so server-side semantics are identical.
 *
 * Returns the processor's JSON response from /process.
 */
/**
 * 2026-07-26: the processor now serializes per-channel work with a lock and
 * returns 409 "already_processing" when another upload for the channel is
 * mid-flight (two CRDB accounts post the same channel every 5 min). That's
 * not a failure — the next 5-min cycle re-uploads the full day and dedup
 * absorbs the overlap. Treat as a benign skip so it never counts against the
 * circuit breaker or triggers relogin/OTP escalation.
 */
function processorBusySkip(bankType: string, stage: string): unknown {
  console.log(`[uploadToProcessor] ${bankType} ${stage} → 409 processor busy (another ${bankType} upload in flight) — skipping this cycle, next cycle covers it`);
  return {
    message: `Processed 0 transactions: 0 passed, 0 failed [processor-busy-skip]`,
    stats: { total: 0, passed: 0, failed: 0, skipped: 0 },
    success: true,
    processor_busy: true,
  };
}

export async function uploadStatement(filePath: string, bankType: "NMB" | "CRDB"): Promise<unknown> {
  const fileSize = statSync(filePath).size;
  if (fileSize === 0) throw new Error(`Statement file is empty: ${filePath}`);
  const fileName = basename(filePath);
  const fileBytes = readFileSync(filePath);

  // ── Step 1: POST /upload with multipart form-data ─────────────────────
  // The processor uses Flask sessions to remember the uploaded file across
  // /upload → /process, so we must propagate the Set-Cookie back on the
  // second request. Node's global fetch doesn't share a cookie jar.
  const form = new FormData();
  form.append("file", new Blob([fileBytes]), fileName);
  form.append("bank_type", bankType);

  // Hard timeouts. Without these the worker can hang indefinitely waiting on
  // a wedged processor, and Render's instance restart (which happens on
  // every redeploy or routine maintenance) silently kills the cycle. With a
  // timeout the worker throws cleanly, runBankWithRetry catches it, and
  // reportCycle fires a 'fail' row to BRAIN with the real reason.
  const UPLOAD_TIMEOUT_MS = 90_000;
  // Frank 2026-07-16: bumped 240s → 600s. Both pullers running concurrently
  // against 4 gunicorn workers means /process contends for a worker slot; the
  // server processes the file, but the reply can take 4-5+ min. The old 240s
  // AbortSignal killed the client wait mid-processing, and 3 timeouts in a
  // row would open the 30-min circuit even though the sheet writes succeeded.
  const PROCESS_TIMEOUT_MS = 600_000;

  const uploadUrl = `${config.TRANSACTION_PROCESSOR_URL}/upload`;
  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!uploadRes.ok) {
    if (uploadRes.status === 409) return processorBusySkip(bankType, "upload");
    throw new Error(`upload ${uploadUrl} → ${uploadRes.status}: ${await uploadRes.text()}`);
  }
  console.log(`[uploadToProcessor] ${bankType} upload OK (${fileSize} bytes)`);

  // Capture the session cookie(s) so /process sees the same session.
  const setCookies = uploadRes.headers.getSetCookie?.() ?? [];
  const cookieHeader = setCookies
    .map((c) => c.split(";")[0]) // strip Path, HttpOnly, etc.
    .filter(Boolean)
    .join("; ");
  if (cookieHeader) console.log(`[uploadToProcessor] forwarding session cookie(s) to /process`);

  // ── Step 2: POST /process to actually run the pipeline ────────────────
  // 2026-07-28: the processor's lock is GLOBAL across channels, and the three
  // pullers' 5-min cycles are phase-sticky — skipping on the first 409 made
  // NMB lose the lock lottery 9 cycles out of 10 (45 min with zero NMB rows).
  // Wait out the holder (CRDB processes take ~40s) and retry twice before
  // conceding the cycle.
  const processUrl = `${config.TRANSACTION_PROCESSOR_URL}/process`;
  let processRes!: Response;
  for (let attempt = 1; attempt <= 3; attempt++) {
    processRes = await fetch(processUrl, {
      method: "POST",
      headers: cookieHeader ? { cookie: cookieHeader } : {},
      signal: AbortSignal.timeout(PROCESS_TIMEOUT_MS),
    });
    if (processRes.status !== 409) break;
    if (attempt < 3) {
      console.log(`[uploadToProcessor] ${bankType} process → 409 busy (attempt ${attempt}/3) — waiting 75s for the lock holder to finish`);
      await new Promise((r) => setTimeout(r, 75_000));
    }
  }
  if (!processRes.ok) {
    if (processRes.status === 409) return processorBusySkip(bankType, "process");
    const errText = await processRes.text();
    // Frank 2026-07-04: CRDB sometimes returns a near-empty xls (10 lines,
    // no data rows) when there are no transactions in the queried window.
    // The processor rejects it with:
    //   "Passed header=[N], len of 1, but only 10 lines in file (sheet: 0)"
    // That's a "no txns" signal, not a broken scraper. Treat as success
    // with zero rows so the auto-heal doesn't burn an OTP misdiagnosing.
    if (
      processRes.status === 500 &&
      /Passed header=\[\d+\], len of \d+, but only \d+ lines in file/i.test(errText)
    ) {
      console.log(`[uploadToProcessor] ${bankType} processor "no transactions in file" signal — treating as empty statement (0 rows)`);
      return {
        message: `Processed 0 transactions: 0 passed, 0 passed (SAV), 0 failed, 0 iPhone passed, 0 iPhone failed, 0 fuzzy rescued 🟢 [empty-statement]`,
        stats: { total: 0, passed: 0, failed: 0, skipped: 0, iphone_passed: 0, iphone_failed: 0 },
        success: true,
        empty_statement: true,
      };
    }
    throw new Error(`process ${processUrl} → ${processRes.status}: ${errText}`);
  }
  const body = await processRes.json();
  console.log(`[uploadToProcessor] ${bankType} processed:`, body);
  return body;
}
