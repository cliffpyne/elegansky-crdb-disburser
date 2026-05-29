import { chromium, type Browser, type Page } from "playwright";
import { config } from "../config.js";
import { waitForFreshTan } from "./tanClient.js";
// removed: import { reportStep, reportShot } — fire-and-forget HTTP was hanging on cold-start Render
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

  log.step("launch Chrome");
  log.detail("headless flag", { headless: config.NMB_HEADLESS });
  // Use the system Chrome (channel: 'chrome') rather than bundled Chromium —
  // the bank sometimes treats Chromium as a bot. Real Chrome has the right
  // user-agent and fingerprint.
  const browser = await chromium.launch({
    headless: config.NMB_HEADLESS,
    channel: "chrome",
  });
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
    // (removed reportStep "NMB: opened login page" — botLog covers it)

    // NMB is an Oracle JET SPA — wait until the form's id appears and the SPA
    // settles. login_username|input is the real DOM id (the | is intentional).
    log.step("wait for username input by DOM id");
    await page.waitForSelector('[id="login_username|input"]', { state: "visible", timeout: 45_000 });
    log.detail("username input visible — pausing 1.5s for SPA to settle");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: "/tmp/nmb_before_fill.png", fullPage: true }).catch(() => {});
    log.detail("saved /tmp/nmb_before_fill.png");

    log.step("fill username");
    log.detail("typing into [id=login_username|input]", { value: config.NMB_USERNAME });
    // Click first then type — many Oracle JET fields ignore .fill() without focus.
    await page.locator('[id="login_username|input"]').click();
    await page.locator('[id="login_username|input"]').fill(config.NMB_USERNAME);
    log.detail("username after fill", {
      value: await page.locator('[id="login_username|input"]').inputValue(),
    });

    log.step("fill password");
    log.detail("typing into [id=login_password|input]");
    await page.locator('[id="login_password|input"]').click();
    await page.locator('[id="login_password|input"]').fill(config.NMB_PASSWORD);

    log.step("click Login button");
    const triggerTime = Date.now();
    log.detail("trigger time recorded", { triggerTime: new Date(triggerTime).toISOString() });
    await page.screenshot({ path: "/tmp/nmb_before_login_click.png", fullPage: true }).catch(() => {});
    await page.getByRole("button", { name: /^login$/i }).click();

    log.step("wait for OTP page (URL contains module=login)");
    await page.waitForURL(/module=login/i, { timeout: 45_000 });
    log.detail("URL now", { url: page.url() });

    log.step("wait for Verification Code label to appear");
    await page.waitForSelector('text=/verification code/i', { timeout: 30_000 });
    log.info("OTP page rendered — looking for code from relay webhook");
    // (removed reportShot page, "NMB: on OTP page" — botLog covers it)

    // NMB → SMS → boss phone → forward-SMS → relay phone → POST to webhook
    // takes ~100-150 s on a slow network. Give it 4 min.
    const NMB_OTP_TIMEOUT_MS = 240_000;
    log.step(`poll webhook for fresh OTP (deadline ${NMB_OTP_TIMEOUT_MS / 1000}s) — ${config.WEBHOOK_BASE_URL}/internal/tan/latest`);
    const code = await waitForFreshTan(triggerTime, NMB_OTP_TIMEOUT_MS);
    log.info("received OTP from webhook", { codeLen: code.length });

    log.step("fill verification code input");
    // The NMB OTP page also shows a 'Reference Number' field that is
    // DISABLED — earlier selectors matched it by accident and Playwright
    // hung trying to .fill() a disabled input. Target only enabled inputs
    // and prefer the by-label match.
    const otpField = page
      .getByLabel(/verification code/i)
      .or(page.locator('input[id*="verification" i]:not([disabled])'))
      .or(page.locator('input[type="text"]:not([disabled]):not([readonly])'))
      .first();
    await otpField.waitFor({ state: "visible", timeout: 30_000 });
    log.detail("typing OTP", { codeLen: code.length });
    await otpField.click();
    await otpField.fill(code);
    log.detail("OTP field value after fill", {
      value: await otpField.inputValue(),
    });

    log.step("click Submit on OTP");
    await page.getByRole("button", { name: /^submit$/i }).click();

    log.step("wait for dashboard URL (module=view)");
    await page.waitForURL(/module=view/i, { timeout: 45_000 });
    log.info("dashboard reached", { url: page.url() });
    // (removed reportShot page, "NMB: dashboard reached" — botLog covers it)

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
