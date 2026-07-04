/**
 * POC — CRDB live statement puller (Frank 2026-07-03).
 *
 * Mirror of nmbLivePuller.ts for CRDB. Keeps one CRDB Netteller session ALIVE
 * all day. Pulls today's statement every 5 minutes and ships it to the
 * transaction-processor (channel="CRDB"). The processor's dedup absorbs
 * overlap.
 *
 * WHY: full architectural parity with NMB — customer payments via CRDB flow
 * into the same reactivation pipeline, so the same 5-min freshness matters.
 *
 * DIFFERENCES vs NMB puller:
 *   - CRDB is a Java/PrimeFaces portal, not Oracle JET SPA — cycles don't
 *     need freshenPage() / DOM injection. crdbDownloadStatement handles
 *     all navigation on each call (navigateToBankStatement is called
 *     internally at cycle start).
 *   - Statement comes as .xls (not CSV) — convert to .xlsx before upload.
 *   - No amount split; CRDB has no Big Data popup.
 *
 * EXPLICIT NON-GOALS (mirror of NMB puller — same contract):
 *   - This file does NOT fire QB payments. Payment fires stay on the regular
 *     9-tick cron schedule.
 *   - This file does NOT modify existing crdbLogin / crdbDownloadStatement
 *     code paths. It composes them in a new loop.
 */

import type { BotLogger } from "../portal/botLog.js";
import { crdbLoginSmart, saveCrdbCookiesToBrain, deleteCrdbCookiesFromBrain } from "../portal/crdbCookieAuth.js";
import type { CrdbSession } from "../portal/crdbLogin.js";
import {
  crdbDownloadStatement,
  startCrdbSessionKeepalive,
  ymdToDdMmYyyy,
} from "../portal/crdbStatement.js";
import { xlsToXlsx } from "../statementPull/xlsToXlsx.js";
import { uploadStatement } from "../statementPull/uploadToProcessor.js";

const PULL_INTERVAL_MS = 5 * 60_000;   // 5 minutes
const BRAIN_POLL_INTERVAL_MS = 15_000; // 15 s

let stopping = false;
let pendingPullRequestedAt: string | null = null;
let lastSeenRequestedAt: string | null = null;

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function brainBase(): string {
  return (process.env.BRAIN_REPORT_URL ?? "").replace(/\/api\/cycles\/?$/, "/api");
}

/**
 * Poll BRAIN every BRAIN_POLL_INTERVAL_MS for on-demand CRDB pull requests
 * from the worker (statement-pull worker signals when it wants a fresh pull
 * before firing a scheduled tick). Mirror of NMB puller's poller.
 */
function startBrainRequestPoller(): () => void {
  const base = brainBase();
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!base || !secret) {
    console.warn(`[crdb-live-puller] BRAIN_REPORT_URL or STATEMENT_REPORT_SECRET missing — on-demand polling DISABLED`);
    return () => {};
  }
  const timer = setInterval(async () => {
    if (stopping) return;
    try {
      const r = await fetch(`${base}/crdb-pull/state`, {
        headers: { "X-Report-Secret": secret },
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) return;
      const body = (await r.json()) as { requested_at?: string | null; pending?: boolean };
      const requested = body.requested_at || null;
      if (!requested) return;
      if (lastSeenRequestedAt === requested) return;
      if (body.pending) {
        console.log(`[crdb-live-puller] 📥 on-demand pull request from BRAIN — requested_at=${requested}`);
        pendingPullRequestedAt = requested;
        lastSeenRequestedAt = requested;
      } else {
        lastSeenRequestedAt = requested;
      }
    } catch {
      /* polling errors non-fatal */
    }
  }, BRAIN_POLL_INTERVAL_MS);
  return () => clearInterval(timer);
}

async function notifyBrainPullComplete(
  result: { ok: boolean; durationMs: number; processorResponse?: unknown; error?: string },
): Promise<void> {
  const base = brainBase();
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!base || !secret) return;
  try {
    await fetch(`${base}/crdb-pull/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Report-Secret": secret },
      body: JSON.stringify(result),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.warn(`[crdb-live-puller] notifyBrainPullComplete threw: ${(err as Error).message.slice(0, 200)}`);
  }
}

function isSessionDeadError(err: Error): boolean {
  const msg = (err.message || "").toLowerCase();
  return (
    msg.includes("login.xhtml") ||
    msg.includes("session expired") ||
    msg.includes("session timeout") ||
    msg.includes("please login again") ||
    msg.includes("unauthorized") ||
    msg.includes("401") ||
    msg.includes("403")
  );
}

/**
 * Map a raw CRDB Netteller error into a human-readable failure description
 * for Frank's SMS. See categorizeNmbErrorMsg in nmbLivePuller.ts for rationale.
 */
function categorizeCrdbErrorMsg(msg: string): string {
  const low = (msg || "").toLowerCase();
  if (low.includes("passed header") && low.includes("only") && low.includes("lines")) {
    return "CRDB returned empty file (no txns)";
  }
  if (low.includes("actions") && low.includes("timeout")) {
    return "CRDB Bank Statement menu slow";
  }
  if (low.includes("periodid") || low.includes("accountid")) {
    return "CRDB dropdown load stalled";
  }
  if (low.includes("dateto") || low.includes("datefrom")) {
    return "CRDB Date field failed";
  }
  if (low.includes("searchbtnid") || low.includes("search")) {
    return "CRDB SEARCH button hung";
  }
  if (low.includes("excel file") || low.includes("balancetable")) {
    return "CRDB Excel export failed";
  }
  if (low.includes("login.xhtml") || low.includes("401") || low.includes("session expired")) {
    return "CRDB session expired — needs fresh OTP";
  }
  if (low.includes("norecords") || low.includes("no records")) {
    return "CRDB search returned no records";
  }
  if (low.includes("locator.click") && low.includes("timeout")) {
    return "CRDB button click timed out";
  }
  return "CRDB site unresponsive";
}

async function runOnePullCycle(session: CrdbSession, cycleNumber: number): Promise<{ ok: boolean; durationMs: number; sessionDead?: boolean; category?: string }> {
  const { page, log } = session;
  const t0 = Date.now();
  const today = ymd(new Date());
  // Cycle 1 on cold start covers yesterday→today range to catch any late
  // evening txns that would otherwise be missed during the puller's
  // startup gap. Subsequent cycles use today only (already fresh).
  const dateFromYmd = cycleNumber === 1
    ? (process.env.POC_PULL_YESTERDAY_ON_STARTUP === "false"
        ? today
        : ymd(new Date(Date.now() - 24 * 60 * 60 * 1000)))
    : today;
  const dateToYmd = today;
  const rangeLabel = dateFromYmd === dateToYmd ? `date=${today}` : `range=${dateFromYmd}→${dateToYmd}`;
  const xlsPath = `/tmp/crdb_live_poc_${today}_cycle${cycleNumber}.xls`;
  const xlsxPath = `/tmp/crdb_live_poc_${today}_cycle${cycleNumber}.xlsx`;
  log.step(`── PULL CYCLE ${cycleNumber} START (${rangeLabel}) ──`);
  try {
    await crdbDownloadStatement(page, log, {
      dateFromDdMmYyyy: ymdToDdMmYyyy(dateFromYmd),
      dateToDdMmYyyy: ymdToDdMmYyyy(dateToYmd),
      savePath: xlsPath,
    });
    log.step("convert .xls → .xlsx for processor");
    xlsToXlsx(xlsPath, xlsxPath);
    log.detail("wrote xlsx", { xlsxPath });
    log.step("upload xlsx to transaction-processor");
    const result = await uploadStatement(xlsxPath, "CRDB");
    log.info(`processor response for cycle ${cycleNumber}`, { result });
    return { ok: true, durationMs: Date.now() - t0 };
  } catch (err) {
    const e = err as Error;
    const sessionDead = isSessionDeadError(e);
    const category = categorizeCrdbErrorMsg(e.message);
    log.error(`pull cycle ${cycleNumber} threw (sessionDead=${sessionDead}, category="${category}"): ${e.message.slice(0, 300)}`);
    return { ok: false, durationMs: Date.now() - t0, sessionDead, category };
  }
}

async function main(): Promise<void> {
  console.log(`[crdb-live-puller] ════════════════════════════════════════════════`);
  console.log(`[crdb-live-puller] POC start — Frank's spec: persistent CRDB session`);
  console.log(`[crdb-live-puller] Pull cadence: every ${PULL_INTERVAL_MS / 60_000} min`);
  console.log(`[crdb-live-puller] NOTE: this script does NOT fire QB payments.`);
  console.log(`[crdb-live-puller]       Payments stay on the regular 9-tick cron.`);
  console.log(`[crdb-live-puller] ════════════════════════════════════════════════`);

  // Phase 1: try cookies first via crdbLoginSmart — cookies path → OTP
  // fallback → save-back. If both fail, sleep 30 min before letting the
  // error propagate to avoid restart-loop OTP burns.
  let session: CrdbSession;
  console.log(`[crdb-live-puller] Phase 1: crdbLoginSmart (cookies-first, OTP fallback)…`);
  try {
    session = await crdbLoginSmart();
    console.log(`[crdb-live-puller] ✅ logged in, dashboard reached`);
  } catch (err) {
    console.error(`[crdb-live-puller] ❌ initial login failed: ${(err as Error).message}`);
    console.error(`[crdb-live-puller] sleeping 30 min before exit to prevent OTP-burn restart loop. Suspend the service now via Render to stop entirely.`);
    await new Promise((r) => setTimeout(r, 30 * 60 * 1000));
    throw err;
  }
  // Explicit save (crdbLoginSmart already does this; harmless double-save
  // if cookies got refreshed during dashboard nav after the smart-login save).
  await saveCrdbCookiesToBrain(session, "worker");

  // Phase 2: keepalive.
  const stopKeepalive = startCrdbSessionKeepalive(session.log, session.page);

  // Phase 2b: BRAIN poller for on-demand pulls.
  const stopBrainPoller = startBrainRequestPoller();

  // Phase 3: shutdown hooks.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log(`[crdb-live-puller] received ${sig} — finishing current cycle then exiting`);
      stopping = true;
    });
  }

  // Phase 4: pull-loop. Single-fail tolerance = 3 consecutive (mirror NMB).
  let cycleNumber = 0;
  // Split counters (Frank 2026-07-04) — see nmbLivePuller.ts for rationale.
  // CRDB additionally benefits from the uploadToProcessor "empty statement"
  // handling: processor's "Passed header=[N]…only 10 lines" 500 is now
  // treated as success with 0 rows (see uploadToProcessor.ts), so it won't
  // even reach this failure path.
  let consecutiveSessionDead = 0;
  let consecutiveTransient = 0;
  const MAX_CONSECUTIVE_FAILURES = 3;
  const MAX_TRANSIENT_FAILURES = 5;    // Frank 2026-07-04: 25 min max before
                                       // container restart, so ticks don't fire
                                       // against a stale sheet.
  while (!stopping) {
    cycleNumber++;
    const t0 = Date.now();
    const triggeringRequestAt = pendingPullRequestedAt;
    pendingPullRequestedAt = null;
    const trigger = triggeringRequestAt ? `on-demand@${triggeringRequestAt}` : "scheduled";
    console.log(`[crdb-live-puller] ── cycle ${cycleNumber} @ ${new Date().toISOString()} (${trigger}) ──`);
    const result = await runOnePullCycle(session, cycleNumber);
    const elapsedSec = (result.durationMs / 1000).toFixed(1);
    if (result.ok) {
      console.log(`[crdb-live-puller] ✅ cycle ${cycleNumber} done in ${elapsedSec}s`);
      consecutiveSessionDead = 0;
      consecutiveTransient = 0;
    } else {
      const isSessionDead = result.sessionDead === true;
      if (isSessionDead) {
        consecutiveSessionDead++;
        consecutiveTransient = 0;
      } else {
        consecutiveTransient++;
      }
      await notifyBrainPullComplete({ ok: false, durationMs: result.durationMs, error: result.category || "CRDB site unresponsive" });
      if (consecutiveSessionDead >= MAX_CONSECUTIVE_FAILURES) {
        console.error(
          `[crdb-live-puller] ❌ cycle ${cycleNumber} FAILED in ${elapsedSec}s ` +
          `(${consecutiveSessionDead} consecutive SESSION-DEAD) — PURGING cookies + exiting for fresh OTP login`,
        );
        await deleteCrdbCookiesFromBrain(session.log);
        break;
      }
      if (consecutiveTransient >= MAX_TRANSIENT_FAILURES) {
        console.error(
          `[crdb-live-puller] ❌ cycle ${cycleNumber} FAILED in ${elapsedSec}s ` +
          `(${consecutiveTransient} consecutive TRANSIENT) — exiting for restart, NOT purging cookies`,
        );
        break;
      }
      console.error(
        `[crdb-live-puller] ⚠ cycle ${cycleNumber} FAILED in ${elapsedSec}s ` +
        `(session-dead=${consecutiveSessionDead}/${MAX_CONSECUTIVE_FAILURES} transient=${consecutiveTransient}/${MAX_TRANSIENT_FAILURES}) — sleeping till next tick, NOT exiting`,
      );
      const nextFire = t0 + PULL_INTERVAL_MS;
      const waitMs = Math.max(0, nextFire - Date.now());
      console.log(`[crdb-live-puller] sleeping ${(waitMs / 1000).toFixed(0)}s before retry cycle`);
      const sliceMs = 5_000;
      const deadline = Date.now() + waitMs;
      while (!stopping && Date.now() < deadline) {
        if (pendingPullRequestedAt) break;
        await sleep(Math.min(sliceMs, deadline - Date.now()));
      }
      continue;
    }
    await notifyBrainPullComplete({ ok: true, durationMs: result.durationMs });

    if (stopping) break;

    // Sleep until next 5-min mark. Cycle-start-anchored so we don't drift.
    // crdbDownloadStatement re-navigates to Bank Statement page on every
    // call — no between-cycle re-nav needed.
    const nextFire = t0 + PULL_INTERVAL_MS;
    const waitMs = Math.max(0, nextFire - Date.now());
    console.log(`[crdb-live-puller] sleeping ${(waitMs / 1000).toFixed(0)}s until next cycle`);
    const sliceMs = 5_000;
    const deadline = Date.now() + waitMs;
    while (!stopping && Date.now() < deadline) {
      if (pendingPullRequestedAt) {
        console.log(`[crdb-live-puller] on-demand request received — breaking sleep early`);
        break;
      }
      await sleep(Math.min(sliceMs, deadline - Date.now()));
    }
  }

  stopKeepalive();
  stopBrainPoller();
  console.log(`[crdb-live-puller] closing browser`);
  try {
    await session.browser.close();
  } catch { /* ignore */ }
  console.log(`[crdb-live-puller] shutdown complete (ran ${cycleNumber} cycle(s))`);
  // Silence unused import warning — BotLogger import is used for its type
  // via the CrdbSession structural shape.
  void ({} as BotLogger);
}

main().catch((err) => {
  console.error(`[crdb-live-puller] FATAL:`, err);
  process.exit(1);
});
