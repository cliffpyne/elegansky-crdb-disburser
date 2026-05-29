import { chromium, type Browser, type Page } from "playwright";
import { config } from "../config.js";
import { waitForFreshTan } from "./tanClient.js";
import { makeBotLogger, type BotLogger } from "./botLog.js";

export interface CrdbSession {
  browser: Browser;
  page: Page;
  log: BotLogger;
}

/**
 * Logs into the CRDB Omnichannels (Netteller) portal and clears the 2FA OTP
 * step. Mirrors nmbLogin.ts: per-step trace through makeBotLogger, real Chrome
 * (channel: "chrome") to dodge bot fingerprinting, and the OTP is requested
 * with the SEND ME TAN button before we start polling the webhook (so the
 * triggerTime / freshness check excludes any stale code).
 *
 * Flow:
 *   1. Login.xhtml      → #username2 / #password2 / form1:loginBtn
 *   2. LoginTwoFA.xhtml → click SEND ME TAN, wait for relayed OTP, fill, Submit
 *   3. DashboardPage    → ready for caller to drive Bank Statement page
 */
export async function crdbLogin(): Promise<CrdbSession> {
  const log = makeBotLogger("CRDB");

  if (!config.CRDB_USERNAME || !config.CRDB_PASSWORD) {
    log.error("CRDB_USERNAME / CRDB_PASSWORD not set — refusing to launch");
    throw new Error("CRDB_USERNAME / CRDB_PASSWORD not set (put them in .env)");
  }

  log.step("launch Chrome");
  log.detail("headless flag", { headless: config.CRDB_HEADLESS });
  const browser = await chromium.launch({
    headless: config.CRDB_HEADLESS,
    channel: "chrome",
  });
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);

  page.on("console", (m) => log.detail(`console.${m.type()}`, { text: m.text().slice(0, 200) }));
  page.on("pageerror", (e) => log.warn("page error", { msg: e.message.slice(0, 200) }));
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) log.detail("navigated", { url: f.url() });
  });

  try {
    log.step("open CRDB login page");
    log.detail("goto", { url: config.CRDB_LOGIN_URL });
    await page.goto(config.CRDB_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    log.detail("page loaded", { title: await page.title(), url: page.url() });

    log.step("fill username");
    await page.waitForSelector("#username2", { state: "visible", timeout: 30_000 });
    await page.fill("#username2", config.CRDB_USERNAME);

    log.step("fill password");
    await page.fill("#password2", config.CRDB_PASSWORD);

    log.step("click Sign In");
    await page.click('[id="form1:loginBtn"]');

    log.step("wait for 2FA page (URL contains LoginTwoFA)");
    await page.waitForURL(/LoginTwoFA/i, { timeout: 45_000 });
    log.detail("URL now", { url: page.url() });
    await page.screenshot({ path: "/tmp/crdb_2fa_page.png", fullPage: true }).catch(() => {});

    log.step("click SEND ME TAN — request login OTP");
    const triggerTime = Date.now();
    log.detail("trigger time recorded", { triggerTime: new Date(triggerTime).toISOString() });
    await page.getByText(/send me tan/i).click();

    // CRDB → SMS → boss phone → forward-SMS → relay phone → webhook
    // gives ~100-150 s on a slow network. Same generous budget as NMB.
    const CRDB_OTP_TIMEOUT_MS = 240_000;
    log.step(`poll webhook for fresh OTP (deadline ${CRDB_OTP_TIMEOUT_MS / 1000}s) — ${config.WEBHOOK_BASE_URL}/internal/tan/latest`);
    const code = await waitForFreshTan(triggerTime, CRDB_OTP_TIMEOUT_MS);
    log.info("received OTP from webhook", { codeLen: code.length });

    log.step("fill OTP input");
    await page.getByPlaceholder(/insert otp/i).fill(code);
    log.detail("OTP filled, value length", { codeLen: code.length });

    log.step("click Submit on OTP");
    await page.getByText(/^\s*submit\s*$/i).click();

    log.step("wait for dashboard (URL contains DashboardPage)");
    await page.waitForURL(/DashboardPage/i, { timeout: 45_000 });
    log.info("dashboard reached", { url: page.url() });

    log.info("✅ login complete");
    return { browser, page, log };
  } catch (err) {
    log.error("login failed", { msg: (err as Error).message });
    try {
      const shotPath = "/tmp/crdb_login_failure.png";
      await page.screenshot({ path: shotPath, fullPage: true });
      log.info("saved failure screenshot", { shotPath });
    } catch {}
    await browser.close();
    throw err;
  }
}
