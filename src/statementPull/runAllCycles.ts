import { runNmbCycle } from "./runNmbCycle.js";
import { runCrdbCycle } from "./runCrdbCycle.js";

/**
 * One full statement-pull tick: pull NMB first, then CRDB. The two are run
 * sequentially because:
 *   - both share the same SMS relay phone for OTPs; running in parallel
 *     creates ambiguity over which bank's OTP is "fresh"
 *   - the boss phone may rate-limit if both banks request 2FA at once
 *
 * NMB is the major payment channel, so we run it first. If NMB fails (e.g.,
 * the relay is offline or a TAN times out), we still try CRDB — they're
 * independent banks. Both successes/failures are logged but never thrown,
 * because a failed cycle is normal (next 30-min slot will retry).
 */
export async function runAllCycles(): Promise<{ nmbOk: boolean; crdbOk: boolean }> {
  let nmbOk = false;
  let crdbOk = false;

  console.log("[runAllCycles] starting NMB cycle");
  try {
    await runNmbCycle();
    nmbOk = true;
    console.log("[runAllCycles] ✅ NMB cycle complete");
  } catch (err) {
    console.error("[runAllCycles] ❌ NMB cycle FAILED:", (err as Error).message);
  }

  console.log("[runAllCycles] starting CRDB cycle");
  try {
    await runCrdbCycle();
    crdbOk = true;
    console.log("[runAllCycles] ✅ CRDB cycle complete");
  } catch (err) {
    console.error("[runAllCycles] ❌ CRDB cycle FAILED:", (err as Error).message);
  }

  console.log(`[runAllCycles] done — nmb=${nmbOk ? "ok" : "fail"} crdb=${crdbOk ? "ok" : "fail"}`);
  return { nmbOk, crdbOk };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runAllCycles()
    .then((r) => process.exit(r.nmbOk || r.crdbOk ? 0 : 1))
    .catch((err) => {
      console.error("[runAllCycles] uncaught:", err);
      process.exit(1);
    });
}
