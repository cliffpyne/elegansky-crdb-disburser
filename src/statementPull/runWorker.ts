import { config } from "../config.js";
import { runAllCycles, runBankWithRetry } from "./runAllCycles.js";
import { isLoopEnabled } from "./loopControl.js";
import { runNmbCycle } from "./runNmbCycle.js";
import { runCrdbCycle } from "./runCrdbCycle.js";
import { NMB_SCREENSHOT_PATHS, CRDB_SCREENSHOT_PATHS } from "./cycleReport.js";

// On-demand fires: the dashboard's Fire NMB / Fire CRDB buttons write a
// value to app_settings.fire_request via BRAIN. The long-running worker
// polls between heartbeats and runs the requested bank in-process — on
// THIS service's Standard plan (2GB), not on Render's default Starter
// plan that one-off jobs use.
async function checkFireRequest(): Promise<"NMB" | "CRDB" | null> {
  const base = (process.env.BRAIN_REPORT_URL ?? "").replace(/\/api\/cycles\/?$/, "/api");
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!base || !secret) return null;
  try {
    const r = await fetch(`${base}/cycles/fire-request`, {
      headers: { "X-Report-Secret": secret },
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { value?: string };
    const v = (body.value || "").toUpperCase().trim();
    if (v === "NMB" || v === "CRDB") return v;
    return null;
  } catch {
    return null;
  }
}

async function clearFireRequest(): Promise<void> {
  const base = (process.env.BRAIN_REPORT_URL ?? "").replace(/\/api\/cycles\/?$/, "/api");
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!base || !secret) return;
  try {
    await fetch(`${base}/cycles/fire-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Report-Secret": secret },
      body: JSON.stringify({ value: "" }),
    });
  } catch {}
}

/**
 * Long-running statement-pull worker. Cycles are wall-clock-aligned so the
 * schedule survives restarts and so the operator knows exactly when files
 * land. Default: every 30 minutes at :00 and :30 of every hour.
 *
 * Each tick runs NMB first, then CRDB (sequentially — see runAllCycles for
 * why parallel doesn't work with a single OTP relay phone).
 *
 * Kill switch: STATEMENT_PULL_PAUSED=true skips all cycles. Fail-safe
 * default — if the env var is missing the bot does NOT run.
 */

const INTERVAL_MS = config.STATEMENT_INTERVAL_MINUTES * 60_000;
const OFFSET_MS = config.STATEMENT_OFFSET_MINUTES * 60_000;
let stopping = false;

function msUntilNextSlot(): number {
  const now = Date.now();
  let next = Math.ceil((now - OFFSET_MS) / INTERVAL_MS) * INTERVAL_MS + OFFSET_MS;
  if (next <= now) next += INTERVAL_MS;
  return next - now;
}

async function loop(): Promise<void> {
  console.log(
    `[statement-worker] started — every ${config.STATEMENT_INTERVAL_MINUTES} min, ` +
      `offset ${config.STATEMENT_OFFSET_MINUTES} min, paused=${config.STATEMENT_PULL_PAUSED}`,
  );

  while (!stopping) {
    const waitMs = msUntilNextSlot();
    const at = new Date(Date.now() + waitMs);
    const pausedNote = config.STATEMENT_PULL_PAUSED ? " (STATEMENT_PULL_PAUSED=true — will skip)" : "";
    console.log(
      `[statement-worker] next tick at ${at.toISOString()} (in ${Math.round(waitMs / 60_000)} min)${pausedNote}`,
    );

    // Sleep with a heartbeat every 60s so logs prove the worker is alive.
    // Between heartbeats, also poll for on-demand fire requests from the
    // dashboard — if set, drop the scheduled wait and run the requested bank
    // in-process (avoids Render Jobs which run on Starter / OOM-prone).
    let remaining = waitMs;
    let fireBank: "NMB" | "CRDB" | null = null;
    while (remaining > 0 && !stopping) {
      const slice = Math.min(remaining, 60_000);
      await sleep(slice);
      remaining -= slice;
      fireBank = await checkFireRequest();
      if (fireBank) break;
      if (remaining > 0 && !stopping) {
        console.log(`[statement-worker] heartbeat — next tick in ${Math.round(remaining / 60_000)} min`);
      }
    }
    if (stopping) break;

    if (fireBank) {
      console.log(`[statement-worker] 🔥 on-demand fire received — bank=${fireBank}`);
      await clearFireRequest();
      const t0 = Date.now();
      try {
        if (fireBank === "NMB") {
          await runBankWithRetry("NMB", runNmbCycle, NMB_SCREENSHOT_PATHS);
        } else {
          await runBankWithRetry("CRDB", runCrdbCycle, CRDB_SCREENSHOT_PATHS);
        }
        console.log(`[statement-worker] on-demand ${fireBank} done in ${((Date.now() - t0) / 60_000).toFixed(1)} min`);
      } catch (err) {
        console.error(`[statement-worker] on-demand ${fireBank} threw:`, err);
      }
      continue;
    }

    if (config.STATEMENT_PULL_PAUSED) {
      console.log("[statement-worker] STATEMENT_PULL_PAUSED=true → skipping this tick");
      continue;
    }

    // Loop kill switch (BRAIN app_settings). Admin-only: the worker no
    // longer self-disables on retry exhaustion (policy change 2026-05-31).
    // Failing OPEN (assume enabled) on network errors so a BRAIN outage
    // doesn't halt syncing.
    if (!(await isLoopEnabled())) {
      console.log(
        "[statement-worker] 🛑 statement_pull_enabled=false in app_settings — " +
          "skipping tick. Admin must re-enable from the dashboard.",
      );
      continue;
    }

    const tickStart = Date.now();
    console.log(`[statement-worker] ── TICK START ${new Date().toISOString()} ──`);
    try {
      const result = await runAllCycles();
      const elapsedMin = ((Date.now() - tickStart) / 60_000).toFixed(1);
      console.log(
        `[statement-worker] ── TICK DONE in ${elapsedMin} min — ` +
          `nmb=${result.nmbOk ? "ok" : "fail"} crdb=${result.crdbOk ? "ok" : "fail"}`,
      );
    } catch (err) {
      console.error("[statement-worker] tick threw (should not happen, runAllCycles swallows):", err);
    }
  }

  console.log("[statement-worker] stopping cleanly");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[statement-worker] received ${sig} — shutting down after current tick`);
    stopping = true;
  });
}

loop().catch((err) => {
  console.error("[statement-worker] FATAL loop error:", err);
  process.exit(1);
});
