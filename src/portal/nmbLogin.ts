import { chromium, type Browser, type Page } from "playwright";
import { config } from "../config.js";
import { waitForFreshTan } from "./tanClient.js";
import { reportStep, reportShot } from "../worker/status.js";

export interface NmbSession {
  browser: Browser;
  page: Page;
}

/**
 * Logs into NMB internet banking and clears the 2FA OTP step.
 *
 * Flow (from NMB screenshots in BANK PROCEDURES/NMB):
 *   1. /oliveline.html?module=login → fill username + password, click Login
 *   2. /pages/home.html?module=login → OTP page; fetch a fresh code from the
 *      relay webhook (sender will be tagged NMB at the relay) and submit
 *   3. /pages/home.html?module=view → dashboard reached; dismiss any
 *      welcome/security modal that pops up
 *
 * Returns the live browser/page so the caller can navigate to statements.
 */
export async function nmbLogin(): Promise<NmbSession> {
  if (!config.NMB_USERNAME || !config.NMB_PASSWORD) {
    throw new Error("NMB_USERNAME / NMB_PASSWORD not set (put them in .env)");
  }

  const browser = await chromium.launch({ headless: config.NMB_HEADLESS });
  const ctx = await browser.newContext({
    acceptDownloads: true, // the statement download step needs this
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);

  try {
    // ── 1. Username + password ───────────────────────────────────────────
    await reportStep("NMB: opening login page");
    await page.goto(config.NMB_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });

    // The username field had "FRANKWILIAM" pre-filled in the screenshot — implies
    // saved-credentials or autofill. We still fill explicitly so the bot is deterministic.
    // Selectors fall back through several common patterns since the NMB DOM
    // isn't documented in the screenshots.
    await fillFirstMatch(page, [
      'input[name="username"]',
      'input[id*="user" i]',
      'input[type="text"]:visible',
    ], config.NMB_USERNAME);

    await fillFirstMatch(page, [
      'input[name="password"]',
      'input[id*="pass" i]',
      'input[type="password"]:visible',
    ], config.NMB_PASSWORD);

    // Mark BEFORE we click login so the OTP poller only accepts codes that
    // arrived after this moment.
    const triggerTime = Date.now();
    await reportStep("NMB: submitting credentials");
    await clickFirstMatch(page, [
      'button:has-text("Login")',
      'input[type="submit"][value*="Login" i]',
      'button[type="submit"]',
    ]);

    // ── 2. OTP page ──────────────────────────────────────────────────────
    await page.waitForURL(/module=login/i, { timeout: 45_000 });
    await page.waitForSelector('text=/verification code/i', { timeout: 30_000 });
    await reportShot(page, "NMB: on OTP page — waiting for relayed code");

    const code = await waitForFreshTan(triggerTime);
    await reportStep(`NMB: got OTP — entering and submitting`);

    // Verification Code input is right under the heading.
    await fillFirstMatch(page, [
      'input[name*="otp" i]',
      'input[name*="code" i]',
      'input[name*="verification" i]',
      // Last resort: the only visible text input that isn't the username field.
      'div:has-text("Verification Code") >> input[type="text"]:visible',
    ], code);

    await clickFirstMatch(page, [
      'button:has-text("Submit")',
      'input[type="submit"][value*="Submit" i]',
    ]);

    // ── 3. Dashboard ─────────────────────────────────────────────────────
    await page.waitForURL(/module=view/i, { timeout: 45_000 });
    await reportShot(page, "NMB: dashboard reached");

    // The "Attention" modal sometimes pops up — dismiss it if present.
    // Don't fail if it's absent.
    await dismissModalIfPresent(page);

    return { browser, page };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

/**
 * Try a list of selectors in order; fill the first one that matches a visible element.
 * Throws if none matched — that's a real DOM change worth surfacing.
 */
async function fillFirstMatch(page: Page, selectors: string[], value: string): Promise<void> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.fill(value);
      return;
    }
  }
  throw new Error(`Could not find any element matching: ${selectors.join(" | ")}`);
}

async function clickFirstMatch(page: Page, selectors: string[]): Promise<void> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.click();
      return;
    }
  }
  throw new Error(`Could not click — no element matched: ${selectors.join(" | ")}`);
}

/**
 * NMB shows an "Attention" modal pushing customers to set up Security Questions.
 * It only blocks clicks until dismissed. We try the X icon, then any "Close"
 * button, then Escape — whatever wins, returns silently if no modal exists.
 */
async function dismissModalIfPresent(page: Page): Promise<void> {
  for (const sel of [
    'div[role="dialog"] >> [aria-label*="close" i]',
    'div[role="dialog"] >> button:has-text("×")',
    'div:has-text("Attention") >> button:has-text("Close")',
  ]) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.click().catch(() => {});
      await page.waitForTimeout(500);
      return;
    }
  }
  // Last-resort: hit Escape — works on most generic modal dialogs.
  await page.keyboard.press("Escape").catch(() => {});
}
