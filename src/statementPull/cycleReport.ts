import { readFileSync, existsSync } from "node:fs";

/**
 * POST a cycle report to BRAIN's /api/cycles. Worker → dashboard pipe.
 *
 * The worker runs on Render and BRAIN runs at brain.eleganskyboda.com (also
 * on Render). The shared X-Report-Secret header authenticates the worker;
 * the dashboard UI uses a Supabase JWT for the GET side.
 *
 * Failures are swallowed (logged only) — a missed report should never break
 * the next cycle. The processor already has the actual transactions; this
 * report is just for visibility.
 */

export interface CycleReportInput {
  bank: "NMB" | "CRDB";
  status: "ok" | "fail";
  startedAt: Date;
  finishedAt: Date;
  workerId?: string;
  stats?: unknown;
  processorResponse?: unknown;
  /** Filesystem paths to screenshots already saved by the cycle. We read + base64 here. */
  screenshotPaths?: string[];
  errorText?: string;
}

export async function reportCycle(input: CycleReportInput): Promise<void> {
  const url = process.env.BRAIN_REPORT_URL;
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!url || !secret) {
    console.warn(
      `[reportCycle] skipping — BRAIN_REPORT_URL=${!!url} STATEMENT_REPORT_SECRET=${!!secret}`,
    );
    return;
  }

  // Read + base64 each screenshot path that actually exists. Cap at 10
  // (BRAIN side accepts up to 10 too — bumped from 6 so per-step screenshots
  // fit) and ~250KB each so the payload stays small.
  const screenshots: string[] = [];
  for (const p of (input.screenshotPaths ?? []).slice(0, 10)) {
    try {
      if (!existsSync(p)) continue;
      const buf = readFileSync(p);
      if (buf.length > 250_000) {
        console.log(`[reportCycle] dropping oversized screenshot ${p} (${buf.length} bytes)`);
        continue;
      }
      screenshots.push(`data:image/png;base64,${buf.toString("base64")}`);
    } catch (err) {
      console.warn(`[reportCycle] failed to read ${p}: ${(err as Error).message}`);
    }
  }

  const body = {
    bank: input.bank,
    status: input.status,
    started_at: input.startedAt.toISOString(),
    finished_at: input.finishedAt.toISOString(),
    worker_id: input.workerId ?? process.env.WORKER_ID ?? "statement-pull",
    stats: input.stats ?? null,
    processor_response: input.processorResponse ?? null,
    screenshots,
    error_text: input.errorText ?? null,
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Report-Secret": secret,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.warn(`[reportCycle] ${input.bank} report → ${res.status}: ${t.slice(0, 300)}`);
    } else {
      console.log(`[reportCycle] ✅ ${input.bank} report sent`);
    }
  } catch (err) {
    console.warn(`[reportCycle] network error: ${(err as Error).message}`);
  }
}

/** Screenshot paths the NMB cycle writes (in order — login → results table → post-download). */
export const NMB_SCREENSHOT_PATHS = [
  "/tmp/nmb_before_fill.png",            // login page just loaded
  "/tmp/nmb_before_login_click.png",     // creds filled, about to submit
  "/tmp/nmb_date_dropdown.png",          // date dropdown open
  "/tmp/nmb_after_select_daterange.png", // date range chosen
  "/tmp/nmb_before_creditdebit.png",     // about to apply Credits-only filter
  "/tmp/nmb_before_download.png",        // ← THE TABLE: results visible before Download click
  "/tmp/nmb_after_download.png",         // download completed, table still on screen
  "/tmp/nmb_bds_queued.png",             // (only when NMB queues to Big Data Statement)
  "/tmp/nmb_login_failure.png",          // (only on login failure)
];

/** Screenshot paths the CRDB cycle writes (in order — login → results table → export). */
export const CRDB_SCREENSHOT_PATHS = [
  "/tmp/crdb_2fa_page.png",              // OTP entry visible
  "/tmp/crdb_dashboard_ready.png",       // post-login dashboard
  "/tmp/crdb_statement_page.png",        // statement page loaded
  "/tmp/crdb_after_userdefined.png",     // date range set
  "/tmp/crdb_search_results.png",        // ← THE TABLE: search results visible
  "/tmp/crdb_after_export_click.png",    // export-to-CSV click happened
  "/tmp/crdb_login_failure.png",         // (only on login failure)
];
