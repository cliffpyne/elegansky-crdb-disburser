/**
 * POC — NMB live statement puller (Frank 2026-06-15).
 *
 * Purpose: keep one NMB session ALIVE all day. Pull today's statement every
 * 5 minutes (3-batch amount split via existing nmbDownloadStatement) and ship
 * each pull to the transaction-processor. The processor's dedup absorbs the
 * 95%+ overlap, so only the last 5 minutes of new transactions actually
 * land in the PASSED sheet on each cycle.
 *
 * WHY: Frank runs a service that turns OFF customer motorcycles when their
 * invoices go past due. Once they pay, the bikes need to come back on
 * quickly — but the current setup only refreshes the sheet every ~3 hours
 * (at the cron ticks). 5-min sheet refresh closes that gap.
 *
 * EXPLICIT NON-GOALS (per Frank):
 *   - This file does NOT fire QB payments. Payment fires stay on the regular
 *     9-tick schedule (meru0100..kibo2100). That contract is preserved.
 *   - This file is NOT wired into runWorker.ts. It's a separate standalone
 *     script for local proof-of-concept testing. Frank runs it manually.
 *   - This file does NOT modify the existing nmbLogin / nmbDownloadStatement
 *     code paths. It just composes them in a new loop.
 *
 * USAGE (local):
 *   cd eleganskyCrdb
 *   npm run nmb:live:poc
 *
 * Frank's phone gets one OTP push at startup. After that, the keepalive
 * keeps the session warm and pulls run automatically every 5 min until
 * Ctrl-C. If the session dies (NMB server-side timeout, browser crash,
 * etc.) the script logs the failure and exits — restart manually to
 * trigger a fresh OTP.
 */

import { nmbLogin, type NmbSession } from "../portal/nmbLogin.js";
import { nmbDownloadStatement } from "../portal/nmbStatement.js";
import { uploadStatement } from "../statementPull/uploadToProcessor.js";
import { sortNmbCsvByDateInPlace } from "../statementPull/sortNmbCsv.js";
import { config } from "../config.js";

const PULL_INTERVAL_MS = 5 * 60_000; // 5 minutes
const KEEPALIVE_INTERVAL_MS = 60_000; // 60 seconds — ping the page so NMB doesn't time us out
// Confirms we're past the login page. NMB's post-login URL is module=Viewer
// (capital V — observed 2026-06-15 cycle 1). Treat "anywhere except login"
// as a logged-in state — robust against future module-name tweaks.
const LOGIN_PAGE_HINT = "module=login";

let stopping = false;

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Background ping every KEEPALIVE_INTERVAL_MS to keep the NMB session alive.
 * Just a trivial DOM evaluation — cheap, but enough to bump server-side
 * activity timers. If NMB introduces an explicit /heartbeat endpoint later,
 * point this at that instead.
 */
function startSessionKeepalive(session: NmbSession): () => void {
  const { page, log } = session;
  const timer = setInterval(async () => {
    if (stopping) return;
    try {
      const title = await page.evaluate(() => document.title).catch(() => null);
      const url = page.url();
      const loggedIn = !url.toLowerCase().includes(LOGIN_PAGE_HINT);
      log.detail(`keepalive ping — title="${title}" loggedIn=${loggedIn}`);
    } catch (err) {
      log.warn(`keepalive ping threw: ${(err as Error).message.slice(0, 120)}`);
    }
  }, KEEPALIVE_INTERVAL_MS);
  return () => clearInterval(timer);
}

/**
 * After nmbDownloadStatement runs, the page sits on the statement page (with
 * date controls, results table, etc.). To run another pull, we need to go
 * back to the dashboard so the existing scrapper can do its "click account
 * row → drill into details" flow from a known starting state.
 *
 * NMB's index.html is the SPA root — visiting it while a session cookie is
 * present resolves to module=view (dashboard) automatically. If the cookie
 * has expired, it'll bounce us back to module=login and the next pull will
 * throw — which is the cue to exit and let Frank restart with a fresh OTP.
 */
async function navigateToDashboard(session: NmbSession): Promise<boolean> {
  const { page, log } = session;
  try {
    log.step("nav back to NMB dashboard for next pull cycle");
    await page.goto(config.NMB_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    // Give the SPA a moment to do its post-cookie redirect (login → Viewer).
    await page.waitForTimeout(2500);
    const url = page.url();
    const loggedIn = !url.toLowerCase().includes(LOGIN_PAGE_HINT);
    if (!loggedIn) {
      log.warn(`expected to land logged-in, but URL still on login page: ${url}`);
      return false;
    }
    log.detail(`dashboard ready at ${url}`);
    return true;
  } catch (err) {
    log.error(`navigateToDashboard threw: ${(err as Error).message.slice(0, 200)}`);
    return false;
  }
}

async function runOnePullCycle(session: NmbSession, cycleNumber: number): Promise<{ ok: boolean; durationMs: number }> {
  const { page, log } = session;
  const t0 = Date.now();
  const today = ymd(new Date());
  const savePath = `/tmp/nmb_live_poc_${today}_cycle${cycleNumber}.csv`;
  log.step(`── PULL CYCLE ${cycleNumber} START (date=${today}) ──`);
  try {
    await nmbDownloadStatement(page, log, {
      dateFromYmd: today,
      dateToYmd: today,
      savePath,
    });
    log.step("sort CSV by Value Date");
    const sortRes = sortNmbCsvByDateInPlace(savePath);
    log.detail(`sorted ${sortRes.rowsSorted} rows (${sortRes.rowsUnparsed} unparseable)`);
    log.step("upload CSV to transaction-processor");
    const result = await uploadStatement(savePath, "NMB");
    log.info(`processor response for cycle ${cycleNumber}`, { result });
    return { ok: true, durationMs: Date.now() - t0 };
  } catch (err) {
    log.error(`pull cycle ${cycleNumber} threw: ${(err as Error).message.slice(0, 300)}`);
    return { ok: false, durationMs: Date.now() - t0 };
  }
}

async function main(): Promise<void> {
  console.log(`[nmb-live-puller] ════════════════════════════════════════════════`);
  console.log(`[nmb-live-puller] POC start — Frank's spec: persistent NMB session`);
  console.log(`[nmb-live-puller] Pull cadence: every ${PULL_INTERVAL_MS / 60_000} min`);
  console.log(`[nmb-live-puller] Keepalive:    every ${KEEPALIVE_INTERVAL_MS / 1000} sec`);
  console.log(`[nmb-live-puller] NOTE: this script does NOT fire QB payments.`);
  console.log(`[nmb-live-puller]       Payments stay on the regular 9-tick cron.`);
  console.log(`[nmb-live-puller] ════════════════════════════════════════════════`);

  // Phase 1: log in once. OTP push will hit Frank's phone here.
  console.log(`[nmb-live-puller] Phase 1: fresh login — approve OTP on your phone…`);
  const session = await nmbLogin();
  console.log(`[nmb-live-puller] ✅ logged in, dashboard reached`);

  // Phase 2: arm keepalive.
  const stopKeepalive = startSessionKeepalive(session);

  // Phase 3: install shutdown hooks.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log(`[nmb-live-puller] received ${sig} — finishing current cycle then exiting`);
      stopping = true;
    });
  }

  // Phase 4: pull-loop.
  let cycleNumber = 0;
  while (!stopping) {
    cycleNumber++;
    const t0 = Date.now();
    console.log(`[nmb-live-puller] ── cycle ${cycleNumber} @ ${new Date().toISOString()} ──`);
    const result = await runOnePullCycle(session, cycleNumber);
    const elapsedSec = (result.durationMs / 1000).toFixed(1);
    if (result.ok) {
      console.log(`[nmb-live-puller] ✅ cycle ${cycleNumber} done in ${elapsedSec}s`);
    } else {
      console.error(`[nmb-live-puller] ❌ cycle ${cycleNumber} FAILED in ${elapsedSec}s — exiting (restart for fresh OTP)`);
      break;
    }

    if (stopping) break;

    // Navigate back to dashboard so the next cycle starts from a known state.
    const navOk = await navigateToDashboard(session);
    if (!navOk) {
      console.error(`[nmb-live-puller] ❌ could not return to dashboard — session likely dead, exiting`);
      break;
    }

    // Sleep until the next 5-min mark. Use the cycle-start time so we don't
    // drift further into the next slot when a pull takes longer than usual.
    const nextFire = t0 + PULL_INTERVAL_MS;
    const waitMs = Math.max(0, nextFire - Date.now());
    const waitSec = (waitMs / 1000).toFixed(0);
    console.log(`[nmb-live-puller] sleeping ${waitSec}s until next cycle`);
    // Chunk the sleep so SIGINT is responsive within ~5s.
    const sliceMs = 5_000;
    const deadline = Date.now() + waitMs;
    while (!stopping && Date.now() < deadline) {
      await sleep(Math.min(sliceMs, deadline - Date.now()));
    }
  }

  stopKeepalive();
  console.log(`[nmb-live-puller] closing browser`);
  try {
    await session.browser.close();
  } catch {
    /* ignore close-on-shutdown errors */
  }
  console.log(`[nmb-live-puller] shutdown complete (ran ${cycleNumber} cycle(s))`);
}

main().catch((err) => {
  console.error(`[nmb-live-puller] FATAL:`, err);
  process.exit(1);
});
