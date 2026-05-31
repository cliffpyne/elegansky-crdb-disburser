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
  const PROCESS_TIMEOUT_MS = 240_000;

  const uploadUrl = `${config.TRANSACTION_PROCESSOR_URL}/upload`;
  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!uploadRes.ok) {
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
  const processUrl = `${config.TRANSACTION_PROCESSOR_URL}/process`;
  const processRes = await fetch(processUrl, {
    method: "POST",
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    signal: AbortSignal.timeout(PROCESS_TIMEOUT_MS),
  });
  if (!processRes.ok) {
    throw new Error(`process ${processUrl} → ${processRes.status}: ${await processRes.text()}`);
  }
  const body = await processRes.json();
  console.log(`[uploadToProcessor] ${bankType} processed:`, body);
  return body;
}
