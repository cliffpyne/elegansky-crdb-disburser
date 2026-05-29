import { runNmbCycle } from "./runNmbCycle.js";
import { runCrdbCycle } from "./runCrdbCycle.js";
import {
  reportCycle,
  NMB_SCREENSHOT_PATHS,
  CRDB_SCREENSHOT_PATHS,
} from "./cycleReport.js";

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
 *
 * After each cycle (success OR failure) the outcome is POSTed to BRAIN's
 * /api/cycles so the dashboard shows live status + screenshots.
 */
export async function runAllCycles(): Promise<{ nmbOk: boolean; crdbOk: boolean }> {
  let nmbOk = false;
  let crdbOk = false;

  // ── NMB ──
  console.log("[runAllCycles] starting NMB cycle");
  const nmbStart = new Date();
  let nmbResult: unknown = null;
  let nmbErr: Error | undefined;
  try {
    nmbResult = await runNmbCycle();
    nmbOk = true;
    console.log("[runAllCycles] ✅ NMB cycle complete");
  } catch (err) {
    nmbErr = err as Error;
    console.error("[runAllCycles] ❌ NMB cycle FAILED:", nmbErr.message);
  }
  await reportCycle({
    bank: "NMB",
    status: nmbOk ? "ok" : "fail",
    startedAt: nmbStart,
    finishedAt: new Date(),
    stats: extractStats(nmbResult),
    processorResponse: nmbResult,
    screenshotPaths: NMB_SCREENSHOT_PATHS,
    errorText: nmbErr?.message,
  });

  // ── CRDB ──
  console.log("[runAllCycles] starting CRDB cycle");
  const crdbStart = new Date();
  let crdbResult: unknown = null;
  let crdbErr: Error | undefined;
  try {
    crdbResult = await runCrdbCycle();
    crdbOk = true;
    console.log("[runAllCycles] ✅ CRDB cycle complete");
  } catch (err) {
    crdbErr = err as Error;
    console.error("[runAllCycles] ❌ CRDB cycle FAILED:", crdbErr.message);
  }
  await reportCycle({
    bank: "CRDB",
    status: crdbOk ? "ok" : "fail",
    startedAt: crdbStart,
    finishedAt: new Date(),
    stats: extractStats(crdbResult),
    processorResponse: crdbResult,
    screenshotPaths: CRDB_SCREENSHOT_PATHS,
    errorText: crdbErr?.message,
  });

  console.log(`[runAllCycles] done — nmb=${nmbOk ? "ok" : "fail"} crdb=${crdbOk ? "ok" : "fail"}`);
  return { nmbOk, crdbOk };
}

/**
 * The processor returns { result: { message, stats, success } } on /process.
 * Pull just the stats blob if we have it; otherwise null.
 */
function extractStats(processorResult: unknown): Record<string, unknown> | null {
  if (!processorResult || typeof processorResult !== "object") return null;
  const obj = processorResult as Record<string, unknown>;
  if (obj.stats && typeof obj.stats === "object") return obj.stats as Record<string, unknown>;
  if (obj.result && typeof obj.result === "object") {
    const r = obj.result as Record<string, unknown>;
    if (r.stats && typeof r.stats === "object") return r.stats as Record<string, unknown>;
  }
  return null;
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
