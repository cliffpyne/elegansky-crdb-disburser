/**
 * Cookie-based CRDB auth (Frank 2026-07-03).
 *
 * Same pattern as nmbCookieAuth.ts — save session cookies to BRAIN after every
 * successful login (cookie OR fresh OTP), fetch on next start. Cron-driven CRDB
 * ticks burn a fresh OTP every fire if session isn't preserved; this eliminates
 * the burn as long as CRDB's session cookies are still valid.
 *
 *   1. crdbLoginWithCookies(): pull cookies from BRAIN, inject, navigate to
 *      DashboardPage. If URL sticks on Login → cookies dead, throw.
 *   2. saveCrdbCookiesToBrain(): POST current context cookies to BRAIN.
 *   3. crdbLoginSmart(): tries cookies first, falls back to OTP on failure.
 *      Drop-in replacement for crdbLogin() at call sites.
 */

import fs from "node:fs";
import { chromium, type BrowserContext } from "playwright";
import { config } from "../config.js";
import { crdbLogin, type CrdbSession } from "./crdbLogin.js";
import { makeBotLogger, type BotLogger } from "./botLog.js";

const LOGIN_PATH_HINT = "Login";  // Login.xhtml or LoginTwoFA.xhtml both contain "Login"
const DASHBOARD_PATH_HINT = "DashboardPage";

// BRAIN_REPORT_URL is set to `.../api/cycles` throughout the codebase —
// strip that suffix so cookie endpoints land at `/api/admin/crdb-cookies`.
function brainApiBase(): string {
  return (process.env.BRAIN_REPORT_URL || "").replace(/\/api\/cycles\/?$/, "/api").replace(/\/+$/, "");
}

function brainCookiesUrl(): string {
  const base = brainApiBase();
  return base ? `${base}/internal/crdb-cookies` : "";
}

function brainCookiesSaveUrl(): string {
  const base = brainApiBase();
  return base ? `${base}/admin/crdb-cookies` : "";
}

// ── File-based cookie store (Frank 2026-07-24, second-account POC) ─────────
// BRAIN's crdb-cookies endpoint holds exactly ONE account's cookies. A second
// CRDB instance must never read/write it (it would resume the wrong account's
// session), so when CRDB_COOKIES_FILE is set ALL cookie persistence goes to
// that local file and BRAIN is never touched.

function cookieFileFetch(log: BotLogger): Array<Record<string, unknown>> {
  const file = config.CRDB_COOKIES_FILE!;
  try {
    if (!fs.existsSync(file)) {
      log.detail("no cookie file yet — will fall back to fresh login", { file });
      return [];
    }
    const body = JSON.parse(fs.readFileSync(file, "utf8")) as { cookies?: Array<Record<string, unknown>>; saved_at?: string };
    const cookies = body.cookies || [];
    log.detail("fetched CRDB cookies from local file", { count: cookies.length, saved_at: body.saved_at, file });
    return cookies;
  } catch (e) {
    log.warn(`cookie file read threw: ${(e as Error).message}`);
    return [];
  }
}

function cookieFileSave(session: CrdbSession, cookies: unknown[]): void {
  const file = config.CRDB_COOKIES_FILE!;
  fs.writeFileSync(file, JSON.stringify({ cookies, saved_at: new Date().toISOString() }), { mode: 0o600 });
  session.log.detail("saved fresh CRDB cookies to local file", { count: cookies.length, file });
}

function cookieFileDelete(log: BotLogger): void {
  const file = config.CRDB_COOKIES_FILE!;
  try {
    fs.unlinkSync(file);
    log.info("🧹 purged CRDB cookie file (session poisoned; next restart will OTP)");
  } catch {
    /* already gone — fine */
  }
}

async function fetchCookiesFromBrain(log: BotLogger): Promise<Array<Record<string, unknown>>> {
  if (config.CRDB_COOKIES_FILE) return cookieFileFetch(log);
  const url = brainCookiesUrl();
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!url || !secret) {
    log.detail("no BRAIN_REPORT_URL or STATEMENT_REPORT_SECRET — skipping cookie fetch");
    return [];
  }
  try {
    const r = await fetch(url, {
      headers: { "X-Report-Secret": secret },
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status === 404) {
      log.detail("no CRDB cookies stored in BRAIN yet — will fall back to fresh login");
      return [];
    }
    if (!r.ok) {
      log.warn(`BRAIN CRDB cookie fetch failed: ${r.status}`);
      return [];
    }
    const body = (await r.json()) as { cookies?: Array<Record<string, unknown>>; saved_at?: string; source?: string };
    const cookies = body.cookies || [];
    log.detail("fetched CRDB cookies from BRAIN", { count: cookies.length, saved_at: body.saved_at, source: body.source });
    return cookies;
  } catch (e) {
    log.warn(`BRAIN CRDB cookie fetch threw: ${(e as Error).message}`);
    return [];
  }
}

/**
 * Post the current context cookies to BRAIN so the next tick reuses them.
 * Never throws — cookie save is best-effort.
 */
export async function saveCrdbCookiesToBrain(session: CrdbSession, source: "worker" | "browser" = "worker"): Promise<void> {
  if (config.CRDB_COOKIES_FILE) {
    try {
      const cookies = await session.page.context().cookies();
      if (cookies.length === 0) {
        session.log.warn("no CRDB cookies in context — skipping save");
        return;
      }
      cookieFileSave(session, cookies);
    } catch (e) {
      session.log.warn(`cookie file save threw: ${(e as Error).message}`);
    }
    return;
  }
  const url = brainCookiesSaveUrl();
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!url || !secret) return;
  try {
    const ctx = session.page.context();
    const cookies = await ctx.cookies();
    if (cookies.length === 0) {
      session.log.warn("no CRDB cookies in context — skipping save");
      return;
    }
    const r = await fetch(url, {
      method: "POST",
      headers: { "X-Report-Secret": secret, "content-type": "application/json" },
      body: JSON.stringify({ cookies, source }),
      signal: AbortSignal.timeout(15_000),
    });
    if (r.ok) {
      session.log.detail("saved fresh CRDB cookies to BRAIN", { count: cookies.length });
    } else {
      session.log.warn(`save CRDB cookies to BRAIN failed: ${r.status}`);
    }
  } catch (e) {
    session.log.warn(`save CRDB cookies to BRAIN threw: ${(e as Error).message}`);
  }
}

/**
 * Purge CRDB cookies from BRAIN. Called when the puller detects 3+ consecutive
 * failures — session poisoned, next restart should hit OTP flow instead of
 * re-fetching the same dead cookies. Never throws — best-effort.
 */
export async function deleteCrdbCookiesFromBrain(log: BotLogger): Promise<void> {
  if (config.CRDB_COOKIES_FILE) {
    cookieFileDelete(log);
    return;
  }
  const url = brainCookiesSaveUrl();
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!url || !secret) return;
  try {
    const r = await fetch(url, {
      method: "DELETE",
      headers: { "X-Report-Secret": secret },
      signal: AbortSignal.timeout(15_000),
    });
    if (r.ok) {
      log.info("🧹 purged CRDB cookies from BRAIN (session poisoned; next restart will OTP)");
    } else {
      log.warn(`delete CRDB cookies HTTP ${r.status}`);
    }
  } catch (e) {
    log.warn(`delete CRDB cookies threw: ${(e as Error).message}`);
  }
}

/**
 * Try to authenticate using cookies from BRAIN — no OTP needed if cookies are
 * still valid. Throws if cookies are missing / invalid so caller can fall back
 * to full crdbLogin().
 */
export async function crdbLoginWithCookies(): Promise<CrdbSession> {
  const log = makeBotLogger("CRDB");
  const cookies = await fetchCookiesFromBrain(log);
  if (cookies.length === 0) {
    throw new Error("no CRDB cookies available from BRAIN — need fresh login");
  }

  log.step("launch Chrome (cookie-auth path)");
  const browser = await chromium.launch({
    headless: config.CRDB_HEADLESS,
    channel: "chrome",
  });
  let ctx: BrowserContext;
  try {
    ctx = await browser.newContext({ acceptDownloads: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctx.addCookies(cookies as any);
    log.detail("injected CRDB cookies into context", { count: cookies.length });

    const page = await ctx.newPage();
    page.setDefaultTimeout(60_000);
    page.on("console", (m) => log.detail(`console.${m.type()}`, { text: m.text().slice(0, 200) }));
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) log.detail("navigated", { url: f.url() });
    });

    // Navigate to the dashboard URL — if cookies are valid the SPA lands there;
    // if not it 302s back to Login.xhtml.
    const loginUrl = new URL(config.CRDB_LOGIN_URL);
    const dashUrl = `${loginUrl.protocol}//${loginUrl.host}${loginUrl.pathname.replace(/Login\.xhtml.*$/i, "DashboardPage.xhtml")}`;
    log.step("navigate to CRDB dashboard URL");
    log.detail("goto", { url: dashUrl });
    await page.goto(dashUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2500);

    // Wait up to 15s for URL to settle — either DashboardPage (valid) or Login (dead).
    const deadline = Date.now() + 15_000;
    let currentUrl = page.url();
    while (Date.now() < deadline) {
      currentUrl = page.url();
      if (currentUrl.includes(DASHBOARD_PATH_HINT)) break;
      if (currentUrl.includes(LOGIN_PATH_HINT) && !currentUrl.includes(DASHBOARD_PATH_HINT)) {
        // Still on Login — give it one more moment then bail.
        await page.waitForTimeout(500);
        currentUrl = page.url();
        if (!currentUrl.includes(DASHBOARD_PATH_HINT)) break;
      }
      await page.waitForTimeout(500);
    }
    currentUrl = page.url();

    if (!currentUrl.includes(DASHBOARD_PATH_HINT)) {
      log.warn(`CRDB cookies didn't hold — URL=${currentUrl}. Falling back to fresh login.`);
      await ctx.close().catch(() => {});
      await browser.close().catch(() => {});
      throw new Error("CRDB cookies expired or invalid — fresh login needed");
    }

    log.info("CRDB cookie-based login succeeded — no OTP burned", { url: currentUrl });
    return { browser, page, log };
  } catch (err) {
    try { await browser.close(); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Smart CRDB login: try cookies first, fall back to full OTP flow on failure.
 * After ANY successful login, save fresh cookies to BRAIN so the next call
 * skips OTP. Drop-in replacement for `crdbLogin()`.
 */
export async function crdbLoginSmart(): Promise<CrdbSession> {
  let session: CrdbSession;
  try {
    session = await crdbLoginWithCookies();
  } catch (e) {
    const log = makeBotLogger("CRDB");
    log.info(`cookies unavailable/expired (${(e as Error).message}) — falling back to fresh OTP login`);
    session = await crdbLogin();
  }
  // Best-effort save of the freshest cookies (whether cookies-path or OTP-path).
  await saveCrdbCookiesToBrain(session, "worker");
  return session;
}
