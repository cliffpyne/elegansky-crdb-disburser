import { chromium, type Browser, type Page } from "playwright";
import { config } from "../config.js";
import { waitForFreshTan } from "./tanClient.js";
import { reportStep, reportShot } from "../worker/status.js";

export interface PortalSession {
  browser: Browser;
  page: Page;
}

/**
 * Logs into the CRDB Internet Banking portal and completes 2FA automatically.
 *
 * Flow (matches the portal screenshots):
 *   1. Login.xhtml      → fill #username2 / #password2, click form1:loginBtn
 *                         (the page's calcInput1() JS encrypts creds — handled
 *                          for free because Playwright is a real browser).
 *   2. LoginTwoFA.xhtml → click "SEND ME TAN"; the OTP travels via the relay
 *                         pipeline to the webhook; we poll for it and type it.
 *   3. SUBMIT           → land on DashboardPage.xhtml.
 *
 * Returns the live browser/page so the caller can proceed to bulk payment.
 */
export async function loginToPortal(): Promise<PortalSession> {
  if (!config.BANK_USERNAME || !config.BANK_PASSWORD) {
    throw new Error("BANK_USERNAME / BANK_PASSWORD are not set (put them in .env)");
  }

  const browser = await chromium.launch({ headless: config.BANK_HEADLESS });
  const page = await browser.newPage();
  page.setDefaultTimeout(60_000); // no single action hangs forever

  try {
    // ── 1. Username + password ───────────────────────────────────────────
    await reportStep("opening login page");
    await page.goto(config.BANK_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.fill("#username2", config.BANK_USERNAME);
    await page.fill("#password2", config.BANK_PASSWORD);
    await reportStep("submitting credentials");
    await page.click('[id="form1:loginBtn"]');

    // ── 2. Two-factor page ───────────────────────────────────────────────
    await page.waitForURL(/LoginTwoFA/i, { timeout: 45_000 });
    await reportShot(page, "on 2FA page — requesting login TAN");

    // Mark the instant we ask for the code, so we only accept a TAN that
    // arrives after this moment (defeats stale codes).
    const triggerTime = Date.now();
    await page.getByText(/send me tan/i).click();

    // ── 3. Wait for the relayed OTP, type it, submit ─────────────────────
    await reportStep("waiting for the relayed login OTP…");
    const code = await waitForFreshTan(triggerTime);
    await reportStep(`got login OTP — entering and submitting`);
    await page.getByPlaceholder(/insert otp/i).fill(code);
    await page.getByText(/^\s*submit\s*$/i).click();

    // ── 4. Dashboard ─────────────────────────────────────────────────────
    await page.waitForURL(/DashboardPage/i, { timeout: 45_000 });
    await reportShot(page, "✅ logged in — dashboard reached");
    return { browser, page };
  } catch (err) {
    await browser.close();
    throw err;
  }
}
