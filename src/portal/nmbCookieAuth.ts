/**
 * Cookie-based NMB auth (Frank 2026-07-01).
 *
 * The OTP-burn cycle happens because every Playwright restart does a fresh
 * login flow that requires an OTP TAN forwarded via the boss's phone. Any
 * hiccup in that chain (phone offline, relay app crashed, NMB missed the SMS)
 * kills the login and forces a 30-min sleep + another OTP.
 *
 * Frank's manual browser stays logged in for hours without OTP because the
 * session cookies stick. This module gives BRAIN's puller the same trick:
 *
 *   1. On startup, GET the last-known cookies from BRAIN.
 *   2. Inject into a fresh Playwright context, navigate to the dashboard.
 *   3. If URL still contains module=login → cookies dead, throw so caller
 *      falls back to the full nmbLogin() + OTP flow.
 *   4. If URL is at Viewer/dashboard → we're in. Skip the OTP entirely.
 *
 * After ANY successful login (via cookies OR fresh OTP), the caller calls
 * saveCookiesToBrain() so BRAIN always has the freshest cookie set for the
 * next restart.
 */

import { chromium, type Browser, type Page, type BrowserContext } from "playwright";
import { config } from "../config.js";
import { makeBotLogger, type BotLogger } from "./botLog.js";

export interface NmbSession {
  browser: Browser;
  page: Page;
  log: BotLogger;
}

const LOGIN_PAGE_HINT = "module=login";
const CANONICAL_DASHBOARD_PATH = "/pages/home.html?module=Viewer";

function brainCookiesUrl(): string {
  const base = (process.env.BRAIN_REPORT_URL || "").replace(/\/+$/, "");
  return base ? `${base}/internal/nmb-cookies` : "";
}

function brainCookiesSaveUrl(): string {
  const base = (process.env.BRAIN_REPORT_URL || "").replace(/\/+$/, "");
  return base ? `${base}/admin/nmb-cookies` : "";
}

/**
 * Fetch cookies from BRAIN. Returns [] if none stored or endpoint unreachable.
 */
async function fetchCookiesFromBrain(log: BotLogger): Promise<Array<Record<string, unknown>>> {
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
      log.detail("no cookies stored in BRAIN yet — will fall back to fresh login");
      return [];
    }
    if (!r.ok) {
      log.warn(`BRAIN cookie fetch failed: ${r.status}`);
      return [];
    }
    const body = (await r.json()) as { cookies?: Array<Record<string, unknown>>; saved_at?: string; source?: string };
    const cookies = body.cookies || [];
    log.detail("fetched cookies from BRAIN", { count: cookies.length, saved_at: body.saved_at, source: body.source });
    return cookies;
  } catch (e) {
    log.warn(`BRAIN cookie fetch threw: ${(e as Error).message}`);
    return [];
  }
}

/**
 * Post the current browser context cookies back to BRAIN so the next restart
 * uses the freshest set. Called after ANY successful login (cookies OR OTP).
 * Never throws — cookie save is best-effort.
 */
export async function saveCookiesToBrain(session: NmbSession, source: "puller" | "browser" = "puller"): Promise<void> {
  const url = brainCookiesSaveUrl();
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!url || !secret) return;
  try {
    const ctx = session.page.context();
    const cookies = await ctx.cookies();
    if (cookies.length === 0) {
      session.log.warn("no cookies in context — skipping save");
      return;
    }
    const r = await fetch(url, {
      method: "POST",
      headers: { "X-Report-Secret": secret, "content-type": "application/json" },
      body: JSON.stringify({ cookies, source }),
      signal: AbortSignal.timeout(15_000),
    });
    if (r.ok) {
      session.log.detail("saved fresh cookies to BRAIN", { count: cookies.length });
    } else {
      session.log.warn(`save cookies to BRAIN failed: ${r.status}`);
    }
  } catch (e) {
    session.log.warn(`save cookies to BRAIN threw: ${(e as Error).message}`);
  }
}

/**
 * Try to authenticate using cookies from BRAIN — no OTP needed if cookies
 * are still valid. Throws if cookies are missing/invalid so the caller can
 * fall back to nmbLogin().
 */
export async function nmbLoginWithCookies(): Promise<NmbSession> {
  const log = makeBotLogger("NMB");
  const cookies = await fetchCookiesFromBrain(log);
  if (cookies.length === 0) {
    throw new Error("no cookies available from BRAIN — need fresh login");
  }

  log.step("launch Chrome (cookie-auth path)");
  const browser = await chromium.launch({
    headless: config.NMB_HEADLESS,
    channel: "chrome",
  });
  let ctx: BrowserContext;
  try {
    ctx = await browser.newContext({ acceptDownloads: true });
    // Playwright's addCookies expects an array — pass through as-is. Cookies
    // saved from a prior Playwright context are already in the right shape.
    // If ANY cookie is malformed, addCookies throws; catch and bail so caller
    // does a fresh login instead of leaving a half-initialized context.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctx.addCookies(cookies as any);
    log.detail("injected cookies into context", { count: cookies.length });

    const page = await ctx.newPage();
    page.setDefaultTimeout(60_000);
    page.on("console", (m) => log.detail(`console.${m.type()}`, { text: m.text().slice(0, 200) }));
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) log.detail("navigated", { url: f.url() });
    });

    log.step("navigate to canonical dashboard URL");
    const base = new URL(config.NMB_LOGIN_URL);
    const dashUrl = `${base.protocol}//${base.host}${CANONICAL_DASHBOARD_PATH}`;
    await page.goto(dashUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2500);
    let currentUrl = page.url();
    log.detail("after nav", { url: currentUrl });

    // NMB's SPA may briefly reroute through module=login on load — wait up to
    // 15s for either (a) URL to leave login (cookies OK) or (b) URL to stick
    // on login (cookies dead).
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      currentUrl = page.url();
      if (!currentUrl.toLowerCase().includes(LOGIN_PAGE_HINT)) break;
      await page.waitForTimeout(500);
    }
    currentUrl = page.url();

    if (currentUrl.toLowerCase().includes(LOGIN_PAGE_HINT)) {
      log.warn("cookies didn't hold — SPA still on login page. Falling back to fresh login.");
      await ctx.close().catch(() => {});
      await browser.close().catch(() => {});
      throw new Error("cookies expired or invalid — fresh login needed");
    }

    log.info("cookie-based login succeeded — no OTP burned", { url: currentUrl });
    return { browser, page, log };
  } catch (err) {
    // Best-effort cleanup if we threw after opening browser
    try { await browser.close(); } catch { /* ignore */ }
    throw err;
  }
}
