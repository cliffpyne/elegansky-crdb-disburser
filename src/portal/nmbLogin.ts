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
  // Frank 2026-07-03: Oracle JET / NMB dashboard was silently NOT rendering
  // the Accounts Summary in headless mode (headed worked locally). Same
  // credentials, same URL — only headless vs headed differed. Fix:
  // (a) use Playwright's newer 'headless: "new"' mode which behaves much
  //     closer to headed Chrome (fewer bot fingerprints),
  // (b) pass anti-automation launch args + user-agent overrides so JET
  //     doesn't route us into a "reduced UI" fallback path,
  // (c) set a real desktop viewport so the SPA's responsive rules render
  //     the Accounts Summary section (small viewports may hide it).
  const isHeadless = config.NMB_HEADLESS;
  const browser = await chromium.launch({
    headless: isHeadless ? "new" as unknown as boolean : false,
    channel: "chrome",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
  const ctx = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/131.0.0.0 Safari/537.36",
    locale: "en-US",
    timezoneId: "Africa/Dar_es_Salaam",
  });
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

    // Fix 1 (2026-06-18): waitForURL with the default waitUntil:"load" hangs
    // on NMB's SPA-style navigation — the URL DOES change to
    // /pages/home.html?module=Viewer but the load event never fires, so the
    // 45 s timer always expires. Poll page.url() directly instead. Bumped
    // to 90 s in case Render's network adds latency.
    log.step("wait for dashboard URL (module=view)");
    {
      const start = Date.now();
      const deadlineMs = 90_000;
      while (Date.now() - start < deadlineMs) {
        if (/module=view/i.test(page.url())) break;
        await page.waitForTimeout(500);
      }
      if (!/module=view/i.test(page.url())) {
        throw new Error(`dashboard URL never appeared after ${deadlineMs}ms; current url=${page.url()}`);
      }
    }
    log.info("dashboard reached", { url: page.url() });

    log.step("dismiss welcome / Attention modal if present");
    await dismissModalIfPresent(log, page);

    log.info("✅ login complete");
    return { browser, page, log };
  } catch (err) {
    // Fix 2 (2026-06-18): emit durable diagnostic info INTO the log message
    // so it survives the Render instance restart that follows the throw.
    // The /tmp screenshot is lost when the instance dies, but log lines
    // persist in Render's log store and we can inspect them later.
    let diagUrl = "(unknown)";
    let diagTitle = "(unknown)";
    let diagBodySnippet = "(unknown)";
    try { diagUrl = page.url(); } catch {}
    try { diagTitle = await page.title(); } catch {}
    try {
      diagBodySnippet = await page.evaluate(
        () => (document.body?.innerText || "").slice(0, 800),
      );
    } catch {}
    log.error("login failed", {
      msg: (err as Error).message,
      diag: { url: diagUrl, title: diagTitle, bodySnippet: diagBodySnippet },
    });
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

export async function dismissModalIfPresent(log: BotLogger, page: Page): Promise<void> {
  // Frank 2026-06-14: the post-login popup is NMB's "Attention" promo
  // (NMB Direct password-control onboarding). The previous text-match
  // attempts kept missing because the title sits in an Oracle JET shadow/
  // template that getByText doesn't traverse cleanly. Move to a DOM-level
  // detector: poll every 500ms for up to 12s scanning the page for any
  // element whose innerText contains a fingerprint of the promo body
  // ("NMB Direct" or "Banking made EASY"). When found, do a DOM-level
  // brute-force close: scan all visible buttons and close-icon-shaped
  // elements above the fold-right, click each.

  log.detail("polling for post-login promo popup (NMB Direct / Attention, up to 12s)");
  const DETECT_EVAL = `(() => {
    const body = document.body ? (document.body.innerText || '') : '';
    return /attention\\b/i.test(body)
      || /nmb\\s*direct/i.test(body.slice(0, 5000))
      || /banking\\s+made\\s+easy/i.test(body);
  })()`;
  let foundPass = -1;
  for (let i = 0; i < 24; i++) {
    const visible = await page.evaluate(DETECT_EVAL);
    if (visible) {
      foundPass = i;
      break;
    }
    await page.waitForTimeout(500);
  }
  if (foundPass < 0) {
    log.detail("no promo popup surfaced in 12s — proceeding");
    return;
  }
  log.detail(`promo popup detected on poll ${foundPass} — taking screenshot + dismissing`);
  await page.screenshot({ path: "/tmp/nmb_promo_detected.png", fullPage: true }).catch(() => {});

  // Dismiss by walking the DOM ourselves. Pass the evaluate body as a
  // STRING — tsx wraps named function declarations with __name() helpers
  // for source maps that don't exist in the browser context, so inline
  // function syntax inside page.evaluate(()=>...) throws ReferenceError.
  const CLOSE_EVAL = `(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden';
    };
    const cand = [];
    document.querySelectorAll('[aria-label*="close" i]').forEach((el) => {
      if (vis(el)) cand.push(el);
    });
    document.querySelectorAll('[class*="close" i]').forEach((el) => {
      if (vis(el) && el.getBoundingClientRect().width < 80) cand.push(el);
    });
    document.querySelectorAll('button, a, span, div').forEach((el) => {
      const t = (el.textContent || '').trim();
      if (t === '×' || t === '✕' || t === 'X' || t === 'x') {
        if (vis(el)) cand.push(el);
      }
    });
    const seen = new Set();
    const uniq = cand.filter((el) => seen.has(el) ? false : (seen.add(el), true));
    if (uniq.length === 0) return { clicked: 0 };
    uniq.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      if (Math.abs(ra.top - rb.top) > 30) return ra.top - rb.top;
      return rb.left - ra.left;
    });
    const t = uniq[0];
    t.click();
    return { clicked: 1, tag: t.tagName, text: (t.textContent || '').slice(0, 30), aria: t.getAttribute('aria-label') };
  })()`;

  const STILL_THERE_EVAL = `(() => {
    const body = document.body ? (document.body.innerText || '') : '';
    return /nmb\\s*direct/i.test(body.slice(0, 5000)) || /banking\\s+made\\s+easy/i.test(body);
  })()`;

  for (let pass = 1; pass <= 4; pass++) {
    const clicked = await page.evaluate(CLOSE_EVAL);
    log.detail(`pass ${pass} close-click result`, clicked as Record<string, unknown>);
    await page.waitForTimeout(800);

    const stillThere = await page.evaluate(STILL_THERE_EVAL);
    if (!stillThere) {
      log.detail(`✅ promo popup dismissed on pass ${pass}`);
      return;
    }
  }

  log.warn("promo popup STILL visible after 4 brute-force dismiss passes — saving screenshot");
  await page.screenshot({ path: "/tmp/nmb_promo_stuck.png", fullPage: true }).catch(() => {});
}
