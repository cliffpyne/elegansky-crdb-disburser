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

import { nmbLogin, dismissModalIfPresent, type NmbSession } from "../portal/nmbLogin.js";
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
 * Open a fresh browser tab in the same context (cookies preserved → no OTP)
 * and close the old one. NMB's SPA caches per-account view state across
 * navigations on the same tab — after cycle 1 sets "Select Date Range",
 * cycle 2 lands on the statement view directly, where the date-period
 * combobox the existing scrapper expects isn't present. A new tab gets a
 * fresh SPA state.
 *
 * If the new tab still bounces to module=login, cookies have expired and
 * the caller should bail (Frank restarts for fresh OTP).
 */
async function freshenPage(session: NmbSession): Promise<boolean> {
  const { log } = session;
  const ctx = session.page.context();
  try {
    log.step("open fresh tab for next pull cycle (resets SPA state)");
    const newPage = await ctx.newPage();
    newPage.setDefaultTimeout(60_000);
    // Mirror console + nav events into our log so we can see SPA state changes.
    newPage.on("console", (m) => log.detail(`console.${m.type()}`, { text: m.text().slice(0, 200) }));
    newPage.on("framenavigated", (f) => {
      if (f === newPage.mainFrame()) log.detail("navigated", { url: f.url() });
    });

    await newPage.goto(config.NMB_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    // Give the SPA a moment to do its post-cookie redirect (login → Viewer).
    await newPage.waitForTimeout(2500);
    let url = newPage.url();
    const loggedIn = !url.toLowerCase().includes(LOGIN_PAGE_HINT);
    if (!loggedIn) {
      log.warn(`fresh tab still on login page: ${url} — session likely expired`);
      await newPage.close().catch(() => {});
      return false;
    }

    // Frank 2026-06-15 cycle 2 bug: index.html?module=Viewer renders the
    // CACHED Account Details view (not Accounts Summary), so the scrapper's
    // "click account row" is a no-op and the date-period combobox isn't
    // present. Force-navigate to the canonical dashboard URL the real
    // post-login flow lands on — /pages/home.html?module=Viewer — so the
    // scrapper sees the Accounts Summary list it expects.
    const base = new URL(config.NMB_LOGIN_URL);
    const canonicalDashboard = `${base.protocol}//${base.host}/pages/home.html?module=Viewer`;
    if (url !== canonicalDashboard && !url.includes('/pages/home.html')) {
      log.detail(`fresh tab landed at non-canonical URL — force-navigating to ${canonicalDashboard}`);
      await newPage.goto(canonicalDashboard, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      await newPage.waitForTimeout(2500);
      url = newPage.url();
    }
    log.detail(`fresh tab ready at ${url}`);

    // Frank 2026-06-15: the "Attention / NMB Direct" promo modal re-renders
    // on every fresh dashboard load — same one nmbLogin dismisses after the
    // first login. If we don't dismiss it here too, cycle 2's "click account
    // row in Accounts Summary" gets intercepted by the modal overlay.
    await dismissModalIfPresent(log, newPage);

    // Close the old tab and swap.
    const oldPage = session.page;
    session.page = newPage;
    try {
      await oldPage.close();
    } catch {
      /* old tab might already be detached after the statement download */
    }
    return true;
  } catch (err) {
    log.error(`freshenPage threw: ${(err as Error).message.slice(0, 200)}`);
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

    // Open a fresh tab so the next cycle starts from a clean SPA state
    // (cookies are preserved, so no OTP needed).
    const navOk = await freshenPage(session);
    if (!navOk) {
      console.error(`[nmb-live-puller] ❌ could not freshen tab — session likely dead, exiting`);
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
