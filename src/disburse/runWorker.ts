import { runCycle } from "./runCycle.js";
import { config } from "../config.js";

/**
 * Long-running worker. Cycles are aligned to the WALL CLOCK with an offset, so
 * multiple workers stagger cleanly and the schedule survives restarts:
 *   interval=30, offset=0  → fires at :00, :30
 *   interval=30, offset=15 → fires at :15, :45
 * Safe to run many instances — the bank advisory lock + atomic claiming prevent
 * double-sends. Run each under a process manager so it auto-restarts.
 */
const INTERVAL_MS = config.DISBURSE_INTERVAL_MINUTES * 60_000;
const OFFSET_MS = config.DISBURSE_OFFSET_MINUTES * 60_000;
let stopping = false;

/** ms until the next clock-aligned slot ( (t - offset) is a multiple of interval ). */
function msUntilNextSlot(): number {
  const now = Date.now();
  let next = Math.ceil((now - OFFSET_MS) / INTERVAL_MS) * INTERVAL_MS + OFFSET_MS;
  if (next <= now) next += INTERVAL_MS;
  return next - now;
}

async function loop(): Promise<void> {
  console.log(
    `[worker] ${config.WORKER_ID} started — every ${config.DISBURSE_INTERVAL_MINUTES} min, ` +
      `offset ${config.DISBURSE_OFFSET_MINUTES} min, dryRun=${config.DISBURSE_DRY_RUN}`,
  );
  while (!stopping) {
    const wait = msUntilNextSlot();
    console.log(`[worker] next cycle at ${new Date(Date.now() + wait).toISOString()} (in ${Math.round(wait / 60000)} min)`);
    await sleep(wait);
    if (stopping) break;
    try {
      await runCycle();
    } catch (err) {
      console.error("[worker] cycle error (will retry next tick):", (err as Error).message);
    }
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
