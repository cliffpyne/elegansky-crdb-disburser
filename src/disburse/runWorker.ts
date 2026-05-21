import { runCycle } from "./runCycle.js";
import { config } from "../config.js";

/**
 * Long-running worker: runs a disbursement cycle now, then every
 * DISBURSE_INTERVAL_MINUTES (default 30). Safe to run more than one instance —
 * the bank advisory lock + atomic claiming prevent double-sends. Run under a
 * process manager (systemd/pm2) so it auto-restarts on crash → no lost cycles.
 */
const INTERVAL_MS = config.DISBURSE_INTERVAL_MINUTES * 60_000;
let stopping = false;

async function loop(): Promise<void> {
  console.log(`[worker] ${config.WORKER_ID} started — interval ${config.DISBURSE_INTERVAL_MINUTES} min, dryRun=${config.DISBURSE_DRY_RUN}`);
  while (!stopping) {
    const start = Date.now();
    try {
      await runCycle();
    } catch (err) {
      console.error("[worker] cycle error (will retry next tick):", (err as Error).message);
    }
    const wait = Math.max(0, INTERVAL_MS - (Date.now() - start));
    console.log(`[worker] next cycle in ${Math.round(wait / 60000)} min`);
    await sleep(wait);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[worker] ${sig} — stopping after current wait`);
    stopping = true;
    process.exit(0);
  });
}

loop();
