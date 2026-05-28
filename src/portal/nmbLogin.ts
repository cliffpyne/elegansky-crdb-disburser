import { chromium, type Browser, type Page } from "playwright";
import { config } from "../config.js";
import { waitForFreshTan } from "./tanClient.js";
import { reportStep, reportShot } from "../worker/status.js";
import { makeBotLogger, type BotLogger } from "./botLog.js";

export interface NmbSession {
  browser: Browser;
  page: Page;
  log: BotLogger;
}

/**
 * Logs into NMB internet banking and clears the 2FA OTP step.
 * Heavily logged so we can watch each stage step-by-step.
 */
export async function nmbLogin(): Promise<NmbSession> {
  const log = makeBotLogger("NMB");

  if (!config.NMB_USERNAME || !config.NMB_PASSWORD) {
    log.error("NMB_USERNAME / NMB_PASSWORD not set — refusing to launch");
    throw new Error("NMB_USERNAME / NMB_PASSWORD not set (put them in .env)");
  }

  log.step("launch chromium");
  log.detail("headless flag", { headless: config.NMB_HEADLESS });
  const browser = await chromium.launch({ headless: config.NMB_HEADLESS });
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);

  // Mirror browser console + page errors into our log so a JS error in the
  // bank page surfaces in our line-by-line trace.
  page.on("console", (m) => log.detail(`console.${m.type()}`, { text: m.text().slice(0, 200) }));
  page.on("pageerror", (e) => log.warn("page error", { msg: e.message.slice(0, 200) }));
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) log.detail("navigated", { url: f.url() });
  });

  try {
    log.step("open NMB login page");
    log.detail("goto", { url: config.NMB_LOGIN_URL });
    await page.goto(config.NMB_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    log.detail("page loaded", { title: await page.title(), url: page.url() });
    await reportStep("NMB: opened login page");

    log.step("fill username");
    await fillFirstMatch(log, page, [
      'input[name="username"]',
      'input[id*="user" i]',
      'input[type="text"]:visible',
    ], config.NMB_USERNAME, "username");

    log.step("fill password");
    await fillFirstMatch(log, page, [
      'input[name="password"]',
      'input[id*="pass" i]',
      'input[type="password"]:visible',
    ], config.NMB_PASSWORD, "password", { sensitive: true });

    log.step("click Login button");
    const triggerTime = Date.now();
    log.detail("trigger time recorded", { triggerTime: new Date(triggerTime).toISOString() });
    await clickFirstMatch(log, page, [
      'button:has-text("Login")',
      'input[type="submit"][value*="Login" i]',
      'button[type="submit"]',
    ], "login-button");

    log.step("wait for OTP page (URL contains module=login)");
    await page.waitForURL(/module=login/i, { timeout: 45_000 });
    log.detail("URL now", { url: page.url() });

    log.step("wait for Verification Code label to appear");
    await page.waitForSelector('text=/verification code/i', { timeout: 30_000 });
    log.info("OTP page rendered — looking for code from relay webhook");
    await reportShot(page, "NMB: on OTP page");

    log.step(`poll webhook for fresh OTP (deadline 90s) — ${config.WEBHOOK_BASE_URL}/internal/tan/latest`);
    const code = await waitForFreshTan(triggerTime);
    log.info("received OTP from webhook", { codeLen: code.length });

    log.step("fill verification code input");
    await fillFirstMatch(log, page, [
      'input[name*="otp" i]',
      'input[name*="code" i]',
      'input[name*="verification" i]',
      'div:has-text("Verification Code") >> input[type="text"]:visible',
    ], code, "otp-code");

    log.step("click Submit on OTP");
    await clickFirstMatch(log, page, [
      'button:has-text("Submit")',
      'input[type="submit"][value*="Submit" i]',
    ], "otp-submit");

    log.step("wait for dashboard URL (module=view)");
    await page.waitForURL(/module=view/i, { timeout: 45_000 });
    log.info("dashboard reached", { url: page.url() });
    await reportShot(page, "NMB: dashboard reached");

    log.step("dismiss welcome / Attention modal if present");
    await dismissModalIfPresent(log, page);

    log.info("✅ login complete");
    return { browser, page, log };
  } catch (err) {
    log.error("login failed", { msg: (err as Error).message });
    // Capture a final screenshot before tearing down — useful for selector debugging.
    try {
      const shotPath = "/tmp/nmb_login_failure.png";
      await page.screenshot({ path: shotPath, fullPage: true });
      log.info("saved failure screenshot", { shotPath });
    } catch {}
    await browser.close();
    throw err;
  }
}

async function fillFirstMatch(
  log: BotLogger,
  page: Page,
  selectors: string[],
  value: string,
  fieldName: string,
  opts: { sensitive?: boolean } = {},
): Promise<void> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      log.detail(`fill ${fieldName}`, {
        selector: sel,
        value: opts.sensitive ? `<${value.length} chars hidden>` : value,
      });
      await loc.fill(value);
      return;
    }
  }
  log.error(`no selector matched for ${fieldName}`, { tried: selectors });
  throw new Error(`Could not find ${fieldName}: ${selectors.join(" | ")}`);
}

async function clickFirstMatch(log: BotLogger, page: Page, selectors: string[], action: string): Promise<void> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      log.detail(`click ${action}`, { selector: sel });
      await loc.click();
      return;
    }
  }
  log.error(`no selector matched for ${action}`, { tried: selectors });
  throw new Error(`Could not click ${action}: ${selectors.join(" | ")}`);
}

async function dismissModalIfPresent(log: BotLogger, page: Page): Promise<void> {
  for (const sel of [
    'div[role="dialog"] >> [aria-label*="close" i]',
    'div[role="dialog"] >> button:has-text("×")',
    'div:has-text("Attention") >> button:has-text("Close")',
  ]) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      log.detail("dismissing modal", { selector: sel });
      await loc.click().catch(() => {});
      await page.waitForTimeout(500);
      return;
    }
  }
  log.detail("no modal found — pressing Escape just in case");
  await page.keyboard.press("Escape").catch(() => {});
}
