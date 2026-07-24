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
import { nmbLoginWithCookies, saveCookiesToBrain, deleteCookiesFromBrain } from "../portal/nmbCookieAuth.js";
import { nmbDownloadStatement } from "../portal/nmbStatement.js";
import { uploadStatement } from "../statementPull/uploadToProcessor.js";
import { sortNmbCsvByDateInPlace } from "../statementPull/sortNmbCsv.js";
import { config } from "../config.js";

const PULL_INTERVAL_MS = 5 * 60_000; // 5 minutes
const KEEPALIVE_INTERVAL_MS = 60_000; // 60 seconds — ping the page so NMB doesn't time us out
const BRAIN_POLL_INTERVAL_MS = 15_000; // 15 seconds — poll BRAIN for on-demand pull requests
// Confirms we're past the login page. NMB's post-login URL is module=Viewer
// (capital V — observed 2026-06-15 cycle 1). Treat "anywhere except login"
// as a logged-in state — robust against future module-name tweaks.
const LOGIN_PAGE_HINT = "module=login";

let stopping = false;
// On-demand pull request signal — set by the BRAIN poller, drained by
// the main pull loop. When the poller sees a new requested_at from BRAIN,
// it stashes it here; the main loop checks each tick and skips the rest
// of its sleep so the next cycle fires immediately.
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
    // Frank 2026-06-16: on Render's network the NMB SPA's post-cookie
    // redirect (?module=login → ?module=Viewer) takes 3-7 seconds, often
    // more than the prior static 2.5s wait — so the URL check fired while
    // the page was still mid-redirect, returning a false "session dead"
    // every single cycle and forcing a service restart + OTP each time.
    // Wait actively for the URL to leave the login module instead of
    // guessing a timeout. Up to 20s; if we still see ?module=login after
    // that, the session really is dead.
    let url = newPage.url();
    try {
      await newPage.waitForURL((u) => !u.toString().toLowerCase().includes(LOGIN_PAGE_HINT), { timeout: 20_000 });
      url = newPage.url();
    } catch {
      url = newPage.url();
    }
    const loggedIn = !url.toLowerCase().includes(LOGIN_PAGE_HINT);
    if (!loggedIn) {
      log.warn(`fresh tab still on login page after 20s: ${url} — session likely expired`);
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

    // Frank 2026-06-15: even with popup dismissed, cycle 2's "click account
    // row" was matching a non-clickable summary tile instead of the
    // Accounts Summary panel's clickable tr. Dump every <tr> that contains
    // the account number so we can SEE which ones the SPA has rendered,
    // and screenshot the fresh dashboard for visual verification before
    // returning control to the cycle loop.
    try {
      const trDump = (await newPage.evaluate(`(() => {
        const acct = ${JSON.stringify(config.NMB_ACCOUNT_NUMBER)};
        const out = [];
        document.querySelectorAll('tr').forEach((tr) => {
          const text = (tr.innerText || '').trim();
          if (!text.includes(acct)) return;
          const r = tr.getBoundingClientRect();
          const hasClickHandler = !!tr.onclick || tr.style.cursor === 'pointer' ||
            window.getComputedStyle(tr).cursor === 'pointer';
          out.push({
            tag: tr.tagName,
            ancestor_panel: (function () {
              let p = tr.parentElement;
              for (let i = 0; i < 8 && p; i++, p = p.parentElement) {
                const id = (p.id || '').toLowerCase();
                const cls = (p.className || '').toString().toLowerCase();
                if (id.includes('account') || id.includes('summary') || cls.includes('account') || cls.includes('summary')) {
                  return (p.tagName + ' #' + p.id + ' .' + (p.className || '').toString().slice(0, 40)).slice(0, 80);
                }
              }
              return 'unknown';
            })(),
            rect: { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) },
            visible: r.width > 0 && r.height > 0,
            cursor: window.getComputedStyle(tr).cursor,
            has_click_handler: hasClickHandler,
            text: text.slice(0, 80),
          });
        });
        return out;
      })()`)) as Array<Record<string, unknown>>;
      log.detail(`fresh tab DOM: ${trDump.length} <tr> contain account number ${config.NMB_ACCOUNT_NUMBER}`);
      for (const t of trDump) log.detail(`  ${JSON.stringify(t)}`);
      await newPage.screenshot({ path: "/tmp/nmb_live_poc_fresh_tab.png", fullPage: true }).catch(() => {});
      log.detail("saved /tmp/nmb_live_poc_fresh_tab.png");

      // Frank 2026-06-15 v4: the DDSummaryTable lazy-loads — sometimes
      // its rows are in the DOM at this point, sometimes they only show
      // up 30-60s later (during the 5-min sleep before the next cycle).
      // Install a MutationObserver that auto-wires the click-forwarder
      // onto ANY matching <tr> that appears, now or later, so cycle N
      // always has a clickable row by the time it runs. The observer
      // outlives this function because it's attached to the page DOM.
      const injected = await newPage.evaluate(`(() => {
        const acct = ${JSON.stringify(config.NMB_ACCOUNT_NUMBER)};
        function wireTr(tr) {
          if (tr._nmbForwarderInstalled) return false;
          if (!(tr.innerText || '').includes(acct)) return false;
          const a = tr.querySelector('a');
          if (!a) return false;
          tr.addEventListener('click', function (e) {
            if (e.target && (e.target.tagName === 'A' || (e.target.closest && e.target.closest('a')))) return;
            a.click();
          }, true);
          tr.style.cursor = 'pointer';
          tr._nmbForwarderInstalled = true;
          return true;
        }
        let initial = 0;
        document.querySelectorAll('tr').forEach((tr) => { if (wireTr(tr)) initial++; });
        if (window._nmbForwarderObs) { try { window._nmbForwarderObs.disconnect(); } catch (e) {} }
        const obs = new MutationObserver(function () {
          document.querySelectorAll('tr').forEach(wireTr);
        });
        obs.observe(document.body, { childList: true, subtree: true });
        window._nmbForwarderObs = obs;
        return { initial_rows_wired: initial };
      })()`);
      log.detail(`click-forwarder + MutationObserver installed (initial rows wired=${(injected as { initial_rows_wired: number }).initial_rows_wired})`);
    } catch (e) {
      log.warn(`DOM inspection threw: ${(e as Error).message.slice(0, 200)}`);
    }

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

/**
 * Background poller — every BRAIN_POLL_INTERVAL_MS, check BRAIN for an
 * on-demand pull request. When the worker's scheduled tick wants fresh
 * NMB data right before firing payments, it POSTs /api/nmb-pull/request
 * with a new requested_at timestamp. We see it here, stash it in
 * pendingPullRequestedAt, and the main loop breaks its sleep early to
 * fire an immediate cycle.
 */
function startBrainRequestPoller(): () => void {
  const base = brainBase();
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!base || !secret) {
    console.warn(`[nmb-live-puller] BRAIN_REPORT_URL or STATEMENT_REPORT_SECRET missing — on-demand polling DISABLED`);
    return () => {};
  }
  const timer = setInterval(async () => {
    if (stopping) return;
    try {
      const r = await fetch(`${base}/nmb-pull/state`, {
        headers: { "X-Report-Secret": secret },
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) return;
      const body = (await r.json()) as { requested_at?: string | null; completed_at?: string | null; pending?: boolean };
      const requested = body.requested_at || null;
      if (!requested) return;
      if (lastSeenRequestedAt === requested) return; // already handled this one
      if (body.pending) {
        console.log(`[nmb-live-puller] 📥 on-demand pull request from BRAIN — requested_at=${requested}`);
        pendingPullRequestedAt = requested;
        lastSeenRequestedAt = requested;
      } else {
        // Not pending (we already completed it) — just remember we've seen this id.
        lastSeenRequestedAt = requested;
      }
    } catch {
      /* polling errors are non-fatal — just try again next interval */
    }
  }, BRAIN_POLL_INTERVAL_MS);
  return () => clearInterval(timer);
}

async function notifyBrainPullComplete(result: { ok: boolean; durationMs: number; processorResponse?: unknown; error?: string }): Promise<void> {
  const base = brainBase();
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!base || !secret) return;
  try {
    await fetch(`${base}/nmb-pull/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Report-Secret": secret },
      body: JSON.stringify(result),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.warn(`[nmb-live-puller] notifyBrainPullComplete threw: ${(err as Error).message.slice(0, 200)}`);
  }
}

function brainBase(): string {
  return (process.env.BRAIN_REPORT_URL ?? "").replace(/\/api\/cycles\/?$/, "/api");
}

/**
 * Distinguish session-dead errors (require cookie purge + fresh OTP) from
 * transient SPA/upload glitches that just need a retry. Frank 2026-07-04:
 * SPA rendering timeouts on the NMB SPA (locator.click, elementFromPoint
 * non-finite, scrollIntoViewIfNeeded) do NOT mean cookies are dead — the
 * session is fine, the DOM just glitched. Purging cookies on a glitch
 * burns an OTP unnecessarily. Only true session-dead signals should
 * trigger the auto-heal cookie purge.
 */
function isSessionDeadError(err: Error): boolean {
  const msg = (err.message || "").toLowerCase();
  return (
    msg.includes("module=login") ||
    msg.includes("session expired") ||
    msg.includes("user session") ||
    msg.includes("please login again") ||
    msg.includes("unauthorized") ||
    msg.includes("401") ||
    msg.includes("403")
  );
}

/**
 * Map a raw Playwright/Chrome/upload error to a human-readable NMB site
 * failure description that ends up in Frank's failure SMS instead of the
 * generic "worker: nmb_scrapper_failed". Frank 2026-07-04: "a worker can
 * never fail — it's the NMB site that's misbehaving; SMS should say
 * exactly what's wrong on their side."
 */
function categorizeNmbErrorMsg(msg: string): string {
  const low = (msg || "").toLowerCase();
  if (low.includes("download") && (low.includes("timeout") || low.includes("time out"))) {
    return "NMB Download button unresponsive";
  }
  if (low.includes("date from") || low.includes("date to")) {
    return "NMB Date field format changed";
  }
  if (low.includes("scrollintoview")) {
    return "NMB dropdown scroll frozen";
  }
  if (low.includes("elementfrompoint") || low.includes("non-finite")) {
    return "NMB page rendering glitched";
  }
  if (low.includes("account") && (low.includes("row") || low.includes("summary")) && low.includes("timeout")) {
    return "NMB Account list slow to load";
  }
  if (low.includes("module=login") || low.includes("401") || low.includes("session expired")) {
    return "NMB session expired — needs fresh OTP";
  }
  if (low.includes("csv download") || low.includes("suggestedfilename")) {
    return "NMB CSV download failed";
  }
  if (low.includes("passed header") && low.includes("only") && low.includes("lines")) {
    return "NMB processor rejected empty file";
  }
  if (low.includes("locator.click") && low.includes("timeout")) {
    return "NMB button click timed out (SPA slow)";
  }
  if (low.includes("locator.waitfor") && low.includes("timeout")) {
    return "NMB element load timed out";
  }
  // Frank 2026-07-16: added specific network + processor rules so unclassified
  // errors don't get swept into "NMB site unresponsive". Always include the
  // raw error tail if we still can't classify — no more useless SMS.
  if (low.includes("err_connection_reset")) return "NMB bank connection dropped (ERR_CONNECTION_RESET)";
  if (low.includes("err_network_changed") || low.includes("err_internet_disconnected")) return "NMB our internet dropped";
  if (low.includes("err_too_many_redirects")) return "NMB SPA redirect loop";
  if (low.includes("fetch failed") || low.includes("socket hang up") || low.includes("econnreset")) return "NMB processor connection dropped";
  if (low.includes("→ 502") || low.includes("status of 502") || low.includes("bad gateway")) return "NMB processor 502 bad gateway";
  if (low.includes("→ 503") || low.includes("status of 503") || low.includes("service unavailable")) return "NMB processor 503 down";
  if (low.includes("→ 504") || low.includes("gateway time-out")) return "NMB processor 504 timeout";
  if (low.includes("→ 500") || low.includes("status of 500")) return "NMB processor 500 error";
  if (low.includes("aborted due to timeout") || low.includes("aborterror")) return "NMB processor took >600s (client abort)";
  // Fallback: include the FIRST 120 chars of the raw error so we always know.
  const tail = (msg || "unknown").slice(0, 120).replace(/\s+/g, " ").trim();
  return `NMB unclassified: ${tail}`;
}

async function runOnePullCycle(session: NmbSession, cycleNumber: number): Promise<{ ok: boolean; durationMs: number; sessionDead?: boolean; category?: string }> {
  const { page, log } = session;
  const t0 = Date.now();
  const today = ymd(new Date());
  // Frank 2026-06-24: cycle 1 (first cycle after startup) queries a
  // yesterday→today RANGE in a single pull so late-evening transactions
  // from yesterday that POC missed during an overnight outage are
  // captured without burning a second OTP. nmbDownloadStatement supports
  // date ranges natively (its amount-pass split + Big Data popup handler
  // keeps wide-range downloads under NMB's row limit). Subsequent cycles
  // (≥2) go back to today-only — the persistent session is already
  // covering today via 5-min cycles, so range mode would just be wasted
  // bandwidth.
  const dateFromYmd = cycleNumber === 1
    ? (process.env.POC_PULL_YESTERDAY_ON_STARTUP === "false"
        ? today
        : ymd(new Date(Date.now() - 24 * 60 * 60 * 1000)))
    : today;
  const dateToYmd = today;
  const rangeLabel = dateFromYmd === dateToYmd ? `date=${today}` : `range=${dateFromYmd}→${dateToYmd}`;
  const savePath = `/tmp/nmb_live_poc_${today}_cycle${cycleNumber}.csv`;
  log.step(`── PULL CYCLE ${cycleNumber} START (${rangeLabel}) ──`);
  try {
    await nmbDownloadStatement(page, log, {
      dateFromYmd,
      dateToYmd,
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
    const e = err as Error;
    const sessionDead = isSessionDeadError(e);
    const category = categorizeNmbErrorMsg(e.message);
    log.error(`pull cycle ${cycleNumber} threw (sessionDead=${sessionDead}, category="${category}"): ${e.message.slice(0, 300)}`);
    return { ok: false, durationMs: Date.now() - t0, sessionDead, category };
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

  // Phase 1: try cookies first (Frank 2026-07-01) — skip the OTP burn if we
  // have a valid session from a prior successful login (either by BRAIN's
  // last save-back or Frank's manual browser paste).
  let session: NmbSession;
  console.log(`[nmb-live-puller] Phase 1a: trying cookie-based login (no OTP if valid)…`);
  try {
    session = await nmbLoginWithCookies();
    console.log(`[nmb-live-puller] ✅ cookie-based login succeeded — dashboard reached, NO OTP burned`);
  } catch (cookieErr) {
    console.log(`[nmb-live-puller] cookies unavailable/expired (${(cookieErr as Error).message}) — falling back to fresh OTP login`);
    // Fix 3 (2026-06-18): "1 strike, you're out". If the initial login throws,
    // Render auto-restarts the worker → fresh login → another OTP → cascade
    // burning operator OTPs while nobody is awake to suspend the service.
    // Sleep 30 min before letting the error propagate so the operator has a
    // window to suspend the service manually and stop the restart loop.
    console.log(`[nmb-live-puller] Phase 1b: fresh login — approve OTP on your phone…`);
    try {
      session = await nmbLogin();
    } catch (err) {
      console.error(`[nmb-live-puller] ❌ initial login failed: ${(err as Error).message}`);
      console.error(`[nmb-live-puller] sleeping 30 min before exit to prevent OTP-burn restart loop. Suspend the service now via Render to stop entirely.`);
      await new Promise((r) => setTimeout(r, 30 * 60 * 1000));
      throw err;
    }
    console.log(`[nmb-live-puller] ✅ logged in via OTP, dashboard reached`);
  }
  // Regardless of path, save the current cookies back to BRAIN so the NEXT
  // restart uses the freshest set — even if we logged in with old cookies
  // (they may have been refreshed by NMB's server during nav) and definitely
  // if we did a fresh OTP login (no cookies existed before).
  await saveCookiesToBrain(session, 'puller');

  // Phase 2: arm keepalive.
  const stopKeepalive = startSessionKeepalive(session);

  // Phase 2b: arm BRAIN poller for on-demand pull requests from the worker.
  const stopBrainPoller = startBrainRequestPoller();

  // Phase 3: install shutdown hooks.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log(`[nmb-live-puller] received ${sig} — finishing current cycle then exiting`);
      stopping = true;
    });
  }

  // Phase 4: pull-loop.
  let cycleNumber = 0;
  // 2026-06-18: track consecutive cycle failures. A single failure is
  // almost always transient NMB flakiness (CSV download timeout — same
  // bug that hit meru0300 worker-side this morning), not a dead session.
  // Exiting on a single fail caused Render to restart → fresh login →
  // burn another OTP. Instead, only exit after 3 consecutive failures
  // (likely session truly dead). Single failures just log and skip to
  // next 5-min tick.
  // Counters + poisoned-session flag (Frank 2026-07-04 v2).
  //
  // The v1 auto-heal had a hole: cookies can get poisoned MID-CYCLE. When
  // that happens, the FIRST failed cycle detects session-dead (URL/401),
  // but every subsequent cycle fails with "locator.click Timeout" — the
  // dead session's SPA renders in a way that looks like SPA slowness to
  // our classifier. Session-dead counter stuck at 1/3 forever → cookies
  // never get purged → we loop and require operator intervention.
  //
  // Fix — TWO reinforcing signals promote to purge:
  //   (a) sessionPoisonedFlag: once we see one session-dead error, treat
  //       every subsequent failure as session-dead too. A success clears
  //       the flag. This catches the "poisoned → SPA-looking symptoms" case.
  //   (b) cycle 1 post-restart failure: fresh Chrome + fresh SPA state
  //       should never fail cycle 1 unless the cookies we loaded are bad.
  //       Any failure on cycle 1 = definitive cookie poisoning → purge.
  let consecutiveSessionDead = 0;
  let consecutiveTransient = 0;
  let sessionPoisonedFlag = false;
  let lastCycleBurnedOtp = false;    // Frank 2026-07-24: max 1 OTP escalation per failure streak / circuit window
  const MAX_CONSECUTIVE_FAILURES = 3;
  const MAX_TRANSIENT_FAILURES = 3;   // Frank 2026-07-15 circuit breaker: 3 strikes → 30-min pause
  while (!stopping) {
    cycleNumber++;
    const t0 = Date.now();
    // If this cycle was triggered by a BRAIN on-demand request, snapshot the
    // request id before we run so we can ack the right one on completion
    // even if another request lands mid-cycle.
    const triggeringRequestAt = pendingPullRequestedAt;
    pendingPullRequestedAt = null;
    const trigger = triggeringRequestAt ? `on-demand@${triggeringRequestAt}` : "scheduled";
    console.log(`[nmb-live-puller] ── cycle ${cycleNumber} @ ${new Date().toISOString()} (${trigger}) ──`);
    let result = await runOnePullCycle(session, cycleNumber);

    // Frank 2026-07-15+16: on-failure cascade. Cookie relogin fires on ANY
    // failure (scheduled OR on-demand) — it's cheap (no OTP burn if cookies
    // still valid on server side). Fresh OTP escalation stays gated to
    // on-demand only so scheduled cycles never spam OTPs.
    if (!result.ok) {
      const trig = triggeringRequestAt ? 'on-demand' : 'scheduled';
      console.warn(`[nmb-live-puller] ⚠️ ${trig} pull failed (${result.category || 'unknown'}) — attempt 2: cookie relogin`);
      let cookieReloginFailed = false;
      try {
        const newSess = await nmbLoginWithCookies();
        try { await session.browser.close(); } catch { /* old browser might already be dead */ }
        session.browser = newSess.browser;
        session.page = newSess.page;
        result = await runOnePullCycle(session, cycleNumber);
        if (result.ok) console.log(`[nmb-live-puller] ✅ ${trig} recovered via cookie relogin`);
      } catch (reloginErr) {
        cookieReloginFailed = true;
        console.warn(`[nmb-live-puller] cookie relogin threw: ${(reloginErr as Error).message.slice(0, 200)}`);
      }
      if (!result.ok) {
        // Frank 2026-07-24: OTP escalation is GATED now. The 07-16
        // unconditional burn turned an NMB-side degradation (23:15→07:00
        // overnight) into an OTP storm — one code per failed cycle, dozens
        // total — which plausibly made NMB's fraud layer kill our sessions
        // even faster. Burn an OTP only when the session is provably dead
        // (session-dead classifier, poisoned flag, or the cookie relogin
        // itself rejected the cookies), and never on consecutive cycles —
        // repeated transients belong to the circuit breaker.
        const failIsPortalDeath = result.sessionDead === true || cookieReloginFailed || sessionPoisonedFlag;
        if (!failIsPortalDeath) {
          console.warn(`[nmb-live-puller] ⚠️ ${trig} still failing after cookie relogin — not portal-death (${result.category || 'unknown'}); skipping OTP, circuit breaker handles it`);
        } else if (lastCycleBurnedOtp) {
          console.warn(`[nmb-live-puller] ⚠️ ${trig} still failing but an OTP was already burned this failure streak — skipping OTP to avoid a storm; circuit breaker handles it`);
        } else {
          console.warn(`[nmb-live-puller] ⚠️ ${trig} still failing after cookie relogin — attempt 3: fresh OTP login (burns an OTP)`);
          lastCycleBurnedOtp = true;
          try {
            const newSess = await nmbLogin();
            try { await session.browser.close(); } catch {}
            session.browser = newSess.browser;
            session.page = newSess.page;
            await saveCookiesToBrain(session, 'puller');
            result = await runOnePullCycle(session, cycleNumber);
            if (result.ok) console.log(`[nmb-live-puller] ✅ ${trig} recovered via fresh OTP login`);
          } catch (otpErr) {
            console.error(`[nmb-live-puller] fresh OTP login threw: ${(otpErr as Error).message.slice(0, 200)}`);
          }
        }
      }
    }

    const elapsedSec = (result.durationMs / 1000).toFixed(1);
    if (result.ok) {
      console.log(`[nmb-live-puller] ✅ cycle ${cycleNumber} done in ${elapsedSec}s`);
      consecutiveSessionDead = 0;
      consecutiveTransient = 0;
      sessionPoisonedFlag = false;   // success proves the session is alive
      lastCycleBurnedOtp = false;    // streak over — next failure streak may burn one OTP again
    } else {
      const isSessionDead = result.sessionDead === true;

      // Fix v2 (a): once we see any session-dead signal, the session is
      // poisoned. Subsequent failures — even ones our classifier labels as
      // "SPA slow" — are really the poisoned session manifesting as broken
      // UI. Promote them to session-dead so the purge threshold triggers.
      if (isSessionDead) sessionPoisonedFlag = true;

      if (isSessionDead || sessionPoisonedFlag) {
        consecutiveSessionDead++;
        consecutiveTransient = 0;
      } else {
        consecutiveTransient++;
      }

      await notifyBrainPullComplete({ ok: false, durationMs: result.durationMs, error: result.category || "NMB site unresponsive" });

      // Frank 2026-07-15 fix: cycle 1 post-restart poison rule ONLY fires
      // when the classifier ACTUALLY detects session death — not on any
      // cycle-1 failure. Old behaviour: any cycle-1 transient (SPA slow,
      // dropdown frozen, processor 502, network blip) triggered purge+exit
      // → systemd restart → burn OTP → same transient fires again → loop.
      // Now: only session-dead signal counts. Transient errors fall through
      // to the circuit-breaker path below (3 strikes → 30-min pause).
      if (cycleNumber === 1 && (isSessionDead || sessionPoisonedFlag)) {
        console.error(
          `[nmb-live-puller] ❌ cycle 1 post-restart FAILED with SESSION-DEAD signal (cookies definitively poisoned) — PURGING + exiting for fresh OTP login`,
        );
        await deleteCookiesFromBrain(session.log);
        break;
      }

      // Session-dead threshold → purge cookies + OTP restart.
      if (consecutiveSessionDead >= MAX_CONSECUTIVE_FAILURES) {
        console.error(
          `[nmb-live-puller] ❌ cycle ${cycleNumber} FAILED in ${elapsedSec}s ` +
          `(${consecutiveSessionDead} consecutive SESSION-DEAD) — PURGING cookies + exiting for fresh OTP login`,
        );
        await deleteCookiesFromBrain(session.log);
        break;
      }
      // Transient threshold → CIRCUIT OPEN: sleep 30 min without touching NMB
      // (session preserved, no OTP burn). Frank 2026-07-15: replaces the old
      // "exit for restart" which triggered systemd → fresh OTP login → OTP
      // burn cascade every time NMB SPA got flaky. Bank sites recover in
      // minutes; 30 min is generous. On-demand tick requests break the sleep
      // early so we still respond to operator fires during the pause.
      if (consecutiveTransient >= MAX_TRANSIENT_FAILURES) {
        console.error(
          `[nmb-live-puller] 🔴 CIRCUIT OPEN — cycle ${cycleNumber} FAILED in ${elapsedSec}s ` +
          `(${consecutiveTransient} consecutive TRANSIENT) — sleeping 30 min without touching NMB, session preserved`,
        );
        const circuitOpenMs = 30 * 60_000;
        const circuitDeadline = Date.now() + circuitOpenMs;
        const sliceMs = 5_000;
        while (!stopping && Date.now() < circuitDeadline) {
          if (pendingPullRequestedAt) {
            console.log(`[nmb-live-puller] 🔵 on-demand request received during circuit-open — breaking early to serve tick`);
            break;
          }
          await sleep(Math.min(sliceMs, circuitDeadline - Date.now()));
        }
        console.log(`[nmb-live-puller] 🟢 CIRCUIT CLOSED — resuming normal cycles (transient counter reset)`);
        consecutiveTransient = 0;
        lastCycleBurnedOtp = false;  // after a 30-min quiet window, one fresh OTP attempt is allowed again
        continue;
      }
      console.error(
        `[nmb-live-puller] ⚠ cycle ${cycleNumber} FAILED in ${elapsedSec}s ` +
        `(session-dead=${consecutiveSessionDead}/${MAX_CONSECUTIVE_FAILURES} transient=${consecutiveTransient}/${MAX_TRANSIENT_FAILURES}) — sleeping till next tick, NOT exiting`,
      );
      // Frank 2026-07-16: MUST re-nav to dashboard after failure, not skip it.
      // The old comment said "state is unknown / mid-failure, skip re-nav" but
      // that was the "works for a while then dies" bug: cycle N leaves the SPA
      // on the transaction-list view with dropdown half-open / filter applied.
      // Cycle N+1 starts on that broken DOM → date-period dropdown scrollInto-
      // ViewIfNeeded times out → cycle N+1 also fails → skip re-nav again →
      // DOM degrades further → 3 strikes → 30-min circuit-open. "Unknown DOM"
      // is exactly WHY we need a reset, not why we should skip one.
      try {
        const base = new URL(session.page.url());
        const dashboardUrl = `${base.protocol}//${base.host}/pages/home.html?module=Viewer`;
        await session.page.goto(dashboardUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await dismissModalIfPresent(session.log, session.page);
        session.log.detail("post-failure: navigated back to dashboard for next cycle", { url: session.page.url() });
      } catch (err) {
        console.error(`[nmb-live-puller] ⚠ post-failure re-nav failed (will still try next cycle): ${(err as Error).message.slice(0, 200)}`);
      }
      const nextFire = t0 + PULL_INTERVAL_MS;
      const waitMs = Math.max(0, nextFire - Date.now());
      console.log(`[nmb-live-puller] sleeping ${(waitMs / 1000).toFixed(0)}s before retry cycle`);
      const sliceMs = 5_000;
      const deadline = Date.now() + waitMs;
      while (!stopping && Date.now() < deadline) {
        if (pendingPullRequestedAt) break;
        await sleep(Math.min(sliceMs, deadline - Date.now()));
      }
      continue; // back to top of while-loop, no re-nav, no normal sleep code
    }
    // Always report success (scheduled + on-demand) so BRAIN's
    // last_ok_completed_at reflects true sheet freshness.
    await notifyBrainPullComplete({ ok: true, durationMs: result.durationMs });

    if (stopping) break;

    // 2026-06-18 (cycle 2 SPA-state failure): the previous tail of this
    // function is a story of trade-offs:
    //   1. ORIGINAL freshenPage() — opened a fresh TAB → 419 "User session
    //      expired" because NMB doesn't tolerate two concurrent tabs.
    //   2. 06-17 fix — removed freshenPage entirely → cycle 2 failed at
    //      the date-period dropdown locator (15 s timeout) because the
    //      SPA still had cycle 1's transaction-list state, not the fresh
    //      dashboard state that cycle 2 expects.
    //
    // This fix: navigate the EXISTING page back to the dashboard URL
    // before the next cycle. page.goto reuses the session cookie (no new
    // tab) but resets the SPA route to a known state, so cycle 2's
    // "click account row → scroll to date-period dropdown" sequence
    // starts from the same DOM cycle 1 saw.
    try {
      const base = new URL(session.page.url());
      const dashboardUrl = `${base.protocol}//${base.host}/pages/home.html?module=Viewer`;
      await session.page.goto(dashboardUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      // dismiss any post-navigation popup that re-appears.
      await dismissModalIfPresent(session.log, session.page);
      session.log.detail("navigated back to dashboard for next cycle", { url: session.page.url() });
    } catch (err) {
      console.error(`[nmb-live-puller] ⚠ between-cycle re-nav failed (will still try next cycle): ${(err as Error).message.slice(0, 200)}`);
    }

    // Sleep until the next 5-min mark. Use the cycle-start time so we don't
    // drift further into the next slot when a pull takes longer than usual.
    const nextFire = t0 + PULL_INTERVAL_MS;
    const waitMs = Math.max(0, nextFire - Date.now());
    const waitSec = (waitMs / 1000).toFixed(0);
    console.log(`[nmb-live-puller] sleeping ${waitSec}s until next cycle`);
    // Chunk the sleep so SIGINT is responsive within ~5s AND so we can
    // break out early when the BRAIN poller flags an on-demand pull request.
    const sliceMs = 5_000;
    const deadline = Date.now() + waitMs;
    while (!stopping && Date.now() < deadline) {
      if (pendingPullRequestedAt) {
        console.log(`[nmb-live-puller] on-demand request received — breaking sleep early`);
        break;
      }
      await sleep(Math.min(sliceMs, deadline - Date.now()));
    }
  }

  stopKeepalive();
  stopBrainPoller();
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
