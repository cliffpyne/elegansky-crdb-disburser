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

  // Read + base64 each screenshot path that actually exists. Cap at 6 (the
  // POST endpoint also caps at 6) and ~250KB each so the payload stays small.
  const screenshots: string[] = [];
  for (const p of (input.screenshotPaths ?? []).slice(0, 6)) {
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

/** Screenshot paths the NMB cycle writes (in order — most useful first). */
export const NMB_SCREENSHOT_PATHS = [
  "/tmp/nmb_before_fill.png",
  "/tmp/nmb_after_select_daterange.png",
  "/tmp/nmb_before_creditdebit.png",
  "/tmp/nmb_login_failure.png", // only present on failure
];

/** Screenshot paths the CRDB cycle writes (in order — most useful first). */
export const CRDB_SCREENSHOT_PATHS = [
  "/tmp/crdb_dashboard_ready.png",
  "/tmp/crdb_search_results.png",
  "/tmp/crdb_after_export_click.png",
  "/tmp/crdb_login_failure.png", // only present on failure
];
