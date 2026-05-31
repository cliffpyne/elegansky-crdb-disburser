import { runNmbCycle } from "./runNmbCycle.js";
import { runCrdbCycle } from "./runCrdbCycle.js";
import {
  reportCycle,
  NMB_SCREENSHOT_PATHS,
  CRDB_SCREENSHOT_PATHS,
} from "./cycleReport.js";
import { notifyAdminFailure } from "./loopControl.js";

/**
 * One full statement-pull tick: pull NMB first, then CRDB. The two are run
 * sequentially because:
 *   - both share the same SMS relay phone for OTPs; running in parallel
 *     creates ambiguity over which bank's OTP is "fresh"
 *   - the boss phone may rate-limit if both banks request 2FA at once
 *
 * NMB is the major payment channel, so we run it first. If NMB fails we
 * still try CRDB — they're independent banks.
 *
 * RETRY POLICY (per bank, applied to failures only):
 *   - Each attempt must occupy at least MIN_ATTEMPT_MIN minutes of
 *     wall-clock time. If the bot fails fast (e.g., a 4-minute crash),
 *     we sleep the remaining 6 minutes BEFORE retrying. This caps OTP
 *     consumption to 1 per bank per MIN_ATTEMPT_MIN minutes — protects
 *     us from burning OTPs against a deterministic bug and from the
 *     bank rate-limiting 2FA requests.
 *   - Up to MAX_RETRIES extra attempts after the initial failure
 *     (default 3 — so 4 attempts total per bank per tick).
 *   - Each attempt POSTs its own report to BRAIN, so the dashboard shows
 *     the entire retry chain. attempt_number is recorded in worker_id.
 *   - After the final failure: fire-and-forget notifyAdminFailure() to
 *     queue an SMS via the relay-phone gateway, then return false. The
 *     tick scheduler will fire the next normal 30-min cycle as if nothing
 *     happened. Policy (2026-05-31): we never self-disable. Failures here
 *     are almost always bank-side (UI shift, OTP relay offline, downtime)
 *     and our right response is to keep polling — they'll recover on their
 *     own clock. The admin only needs an alert, not a manual re-enable.
 */
const MIN_ATTEMPT_MIN = 10;
// 2 retries after the initial attempt → 3 attempts total per bank per cycle.
// At MIN_ATTEMPT_MIN=10 that's up to 30 min per bank, fitting comfortably
// inside the 60-min STATEMENT_INTERVAL_MINUTES window.
const MAX_RETRIES = 2;

export async function runAllCycles(): Promise<{ nmbOk: boolean; crdbOk: boolean }> {
  const nmbOk = await runBankWithRetry("NMB", runNmbCycle, NMB_SCREENSHOT_PATHS);
  const crdbOk = await runBankWithRetry("CRDB", runCrdbCycle, CRDB_SCREENSHOT_PATHS);

  console.log(
    `[runAllCycles] done — nmb=${nmbOk ? "ok" : "fail"} crdb=${crdbOk ? "ok" : "fail"}`,
  );
  return { nmbOk, crdbOk };
}

/**
 * Run a single bank cycle, retrying on failure per the policy above.
 * Returns true if any attempt succeeded. Never throws — failure is
 * surfaced via the BRAIN reports + the ADMIN_ALERT_NEEDED log line.
 */
async function runBankWithRetry(
  bank: "NMB" | "CRDB",
  fn: () => Promise<unknown>,
  screenshotPaths: string[],
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    const isRetry = attempt > 1;
    const startedAt = new Date();
    console.log(
      `[runAllCycles] ${isRetry ? `retry ${attempt - 1}/${MAX_RETRIES}` : "starting"} ${bank} cycle`,
    );

    let result: unknown = null;
    let err: Error | undefined;
    try {
      result = await fn();
      console.log(`[runAllCycles] ✅ ${bank} cycle complete (attempt ${attempt})`);
    } catch (e) {
      err = e as Error;
      console.error(
        `[runAllCycles] ❌ ${bank} cycle FAILED (attempt ${attempt}):`,
        err.message,
      );
    }

    const finishedAt = new Date();
    const durationMin = (finishedAt.getTime() - startedAt.getTime()) / 60_000;

    // Report this attempt before deciding whether to retry — operator should
    // see every attempt on the dashboard, including the fast-fail ones.
    await reportCycle({
      bank,
      status: err ? "fail" : "ok",
      startedAt,
      finishedAt,
      workerId:
        (process.env.WORKER_ID ?? "statement-pull") +
        (isRetry ? `#retry${attempt - 1}` : ""),
      stats: extractStats(result),
      processorResponse: result,
      screenshotPaths,
      errorText: err?.message,
    });

    if (!err) return true; // success — stop retrying

    // Out of retry budget → queue an admin SMS (best-effort, gateway is
    // task #23) and return. The tick scheduler will fire the next normal
    // 30-min cycle on schedule; we DO NOT touch the kill switch. Almost
    // every failure here is bank-side (UI shift, relay phone offline,
    // bank downtime) and the bank will recover on its own clock — our
    // loop should keep checking, not stop.
    if (attempt > MAX_RETRIES) {
      const reason = `${bank} failed ${attempt} attempts. Last: ${err.message.slice(0, 200)}`;
      await notifyAdminFailure(reason);
      return false;
    }

    // Pad the attempt to at least MIN_ATTEMPT_MIN minutes before retrying.
    // The premise: a fast-fail probably means a deterministic bug — retrying
    // immediately would just burn another OTP for the same bug. Sleeping
    // gives the bank's relay/queue time to recover too.
    const minutesToWait = Math.max(0, MIN_ATTEMPT_MIN - durationMin);
    if (minutesToWait > 0) {
      console.log(
        `[runAllCycles] ${bank} attempt ${attempt} took ${durationMin.toFixed(1)} min — ` +
          `sleeping ${minutesToWait.toFixed(1)} min to keep each attempt ≥ ${MIN_ATTEMPT_MIN} min`,
      );
      await sleep(minutesToWait * 60_000);
    } else {
      console.log(
        `[runAllCycles] ${bank} attempt ${attempt} took ${durationMin.toFixed(1)} min — ` +
          `≥ ${MIN_ATTEMPT_MIN} min, retrying immediately`,
      );
    }
  }
  return false; // unreachable, but TS happier
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
