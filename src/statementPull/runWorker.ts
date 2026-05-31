import { config } from "../config.js";
import { runAllCycles } from "./runAllCycles.js";
import { isLoopEnabled } from "./loopControl.js";

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
    let remaining = waitMs;
    while (remaining > 0 && !stopping) {
      const slice = Math.min(remaining, 60_000);
      await sleep(slice);
      remaining -= slice;
      if (remaining > 0 && !stopping) {
        console.log(`[statement-worker] heartbeat — next tick in ${Math.round(remaining / 60_000)} min`);
      }
    }
    if (stopping) break;

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
