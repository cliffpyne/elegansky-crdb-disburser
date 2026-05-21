import { runCycle } from "./runCycle.js";
import { pool } from "../db/pool.js";

/** Run a single disbursement cycle and exit. For testing:
 *   node --env-file=.env dist/disburse/runCycleOnce.js
 */
runCycle()
  .then(() => console.log("[once] cycle complete"))
  .catch((err) => {
    console.error("[once] cycle FAILED:", err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
