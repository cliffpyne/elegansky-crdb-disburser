import type { Page, Download } from "playwright";
import { config } from "../config.js";
import type { BotLogger } from "./botLog.js";

/**
 * From the CRDB dashboard, drill into the configured savings account, pick a
 * user-defined date range (credits + debits both), and download the Excel
 * statement. CRDB's portal is PrimeFaces (Netteller-war) — same framework as
 * the disburser's bulk-payment page — so dropdown panels use ":selectId_label"
 * triggers + ":selectId_panel" lists. Date inputs are PrimeFaces calendars.
 *
 * Returns the path to the downloaded .xls (caller is responsible for converting
 * to .xlsx before posting to the processor).
 */
export async function crdbDownloadStatement(
  page: Page,
  log: BotLogger,
  opts: { dateFromDdMmYyyy: string; dateToDdMmYyyy: string; savePath: string },
): Promise<string> {
  if (!config.CRDB_ACCOUNT_NUMBER) {
    log.error("CRDB_ACCOUNT_NUMBER not set");
    throw new Error("CRDB_ACCOUNT_NUMBER not set");
  }

  log.step("wait for dashboard to settle");
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await dismissSessionPopupIfPresent(log, page);
  await page.screenshot({ path: "/tmp/crdb_dashboard_ready.png", fullPage: true }).catch(() => {});

  // ── Navigate to Bank Statement page ──────────────────────────────────
  // The user walkthrough clicks Actions → BANK STATEMENT on the account row,
  // but that PrimeFaces menu re-renders during AJAX and locators detach
  // mid-click. The page itself (TransactionHistory.xhtml) is reachable by
  // direct URL — same pattern the disburser uses to fall back to MassPayment.
  // We try the menu first (it's what the user walked us through), then fall
  // back to direct goto if the menu interaction throws.
  await navigateToBankStatement(log, page);
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await page.screenshot({ path: "/tmp/crdb_statement_page.png", fullPage: true }).catch(() => {});
  await dumpVisibleControls(log, page, "bank statement page");

  // ── Account dropdown → the configured savings account ────────────────
  log.step(`open Account dropdown (accountId) and pick ${config.CRDB_ACCOUNT_NUMBER}`);
  await selectMenu(log, page, "accountId", new RegExp(`^\\s*${config.CRDB_ACCOUNT_NUMBER}\\b`));

  // ── Period dropdown → User Defined ────────────────────────────────────
  // The account does ~2000 transactions/day, so presets ("Last 10", etc.)
  // miss most traffic. Same-day User-Defined is the only way to get all of
  // today's rows in a single export. The search is slow — give it real time.
  log.step("open Period dropdown (periodId) and pick 'User Defined'");
  await selectMenu(log, page, "periodId", /^\s*User Defined\s*$/i);
  await page.waitForTimeout(600);
  await page.screenshot({ path: "/tmp/crdb_after_userdefined.png", fullPage: true }).catch(() => {});

  // ── From / To dates ──────────────────────────────────────────────────
  log.step(`fill From date (dateFrom:calendarId_input) → ${opts.dateFromDdMmYyyy}`);
  await fillCalendarInput(log, page, "dateFrom:calendarId_input", opts.dateFromDdMmYyyy);
  log.step(`fill To date (dateTo:calendarId_input) → ${opts.dateToDdMmYyyy}`);
  await fillCalendarInput(log, page, "dateTo:calendarId_input", opts.dateToDdMmYyyy);

  // ── Search, with retry on transient "Something went wrong" ───────────
  log.step("click SEARCH (retrying on transient errors)");
  await searchWithRetry(log, page, /* maxAttempts */ 3);

  // ── Click Export by ID (we got it from the prior DOM probe) ──────────
  // The DataTable footer renders the Export button as
  //   <button id="balanceTable:exportBtn" class="ui-button ...">
  // It can measure as 0x0 immediately after search (lazy footer render), so
  // we wait a beat, force a page-end scroll, and click via JS so PrimeFaces
  // executes its overlay-popup script even if Playwright thinks the button
  // is "not actionable".
  log.step("scroll to bottom of page so DataTable footer paints");
  await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
  await page.waitForTimeout(1500);

  log.step("click Export button (balanceTable:exportBtn) via JS dispatch");
  await dismissSessionPopupIfPresent(log, page);
  await page.evaluate(`(() => {
    const btn = document.getElementById('balanceTable:exportBtn');
    if (!btn) throw new Error('balanceTable:exportBtn not in DOM');
    btn.scrollIntoView({ block: 'center', behavior: 'instant' });
    btn.click();
  })()`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: "/tmp/crdb_after_export_click.png", fullPage: true }).catch(() => {});

  log.step(`probe + click 'Excel File' menu item → ${opts.savePath}`);
  // The Export dropdown is a PrimeFaces overlay menu — the PDF/Excel items
  // are usually in <a> tags wrapping the label span. Find every "Excel File"
  // bearer, pick the first <a> with a useful id, JS-click it.
  const excelCandidates = (await page.evaluate(`(() => {
    const out = [];
    const re = /^\\s*Excel File\\s*$/i;
    document.querySelectorAll('a,button,li,span').forEach((el) => {
      const text = (el.innerText || el.textContent || '').trim();
      if (!re.test(text)) return;
      let target = el;
      for (let i = 0; i < 6 && target && target.tagName !== 'A' && target.tagName !== 'BUTTON' && target.tagName !== 'LI'; i++) target = target.parentElement;
      if (!target) return;
      const rect = target.getBoundingClientRect();
      const cs = window.getComputedStyle(target);
      out.push({
        tag: target.tagName,
        id: target.id || '',
        classes: (target.className || '').toString().slice(0, 100),
        rectWxH: rect.width + 'x' + rect.height,
        display: cs.display,
        visibility: cs.visibility,
      });
    });
    return out;
  })()`)) as Array<Record<string, string | number>>;
  log.detail(`Excel File candidates (${excelCandidates.length})`);
  for (const c of excelCandidates) log.detail(`  ${JSON.stringify(c)}`);

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    page.evaluate(`(() => {
      const re = /^\\s*Excel File\\s*$/i;
      // Walk every clickable that contains "Excel File" text and click the
      // most-specific (deepest) one whose parent overlay is displayed.
      const matches = [];
      document.querySelectorAll('a,button,li').forEach((el) => {
        const text = (el.innerText || el.textContent || '').trim();
        if (re.test(text)) matches.push(el);
      });
      if (!matches.length) throw new Error('Excel File menu item not in DOM');
      // Prefer one whose ancestor .ui-overlaypanel / .ui-menu is not display:none.
      const isVisible = (el) => {
        for (let cur = el; cur; cur = cur.parentElement) {
          const cs = window.getComputedStyle(cur);
          if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        }
        return true;
      };
      const target = matches.find(isVisible) || matches[0];
      target.scrollIntoView({ block: 'center', behavior: 'instant' });
      target.click();
    })()`),
  ]);

  log.detail("download event received", {
    suggestedFilename: download.suggestedFilename(),
  });
  await download.saveAs(opts.savePath);
  log.info("✅ statement saved", { path: opts.savePath });
  return opts.savePath;
}

/**
 * Mirrors the disburser's navigateToBulkPayment: try the in-page menu, fall
 * back to direct URL if it fails or the menu is mid-render.
 *
 *   Primary  → Actions row button → BANK STATEMENT menuitem
 *   Fallback → goto TransactionHistory.xhtml (the bank's stable deep link)
 */
async function navigateToBankStatement(log: BotLogger, page: Page): Promise<void> {
  const BASE = config.CRDB_LOGIN_URL.replace(/Login\.xhtml.*$/, "");
  const deepLink = `${BASE}TransactionHistory.xhtml`;

  try {
    log.step("try menu path: Actions → BANK STATEMENT");
    // Only consider VISIBLE matches — hidden nav menu items like "My Accounts"
    // can otherwise shadow the dashboard row controls.
    const actionsBtn = page.locator(":visible").getByText(/^\s*Actions\s*$/i).first();
    await actionsBtn.waitFor({ state: "visible", timeout: 10_000 });
    await actionsBtn.click({ timeout: 8_000 });
    await page.waitForTimeout(500);

    const bankStmt = page.locator(":visible").getByText(/^\s*BANK STATEMENT\s*$/i).first();
    await bankStmt.waitFor({ state: "visible", timeout: 6_000 });
    await bankStmt.click({ timeout: 6_000 });
    await page.waitForURL(/TransactionHistory/i, { timeout: 15_000 });
    log.info("menu path worked", { url: page.url() });
    return;
  } catch (err) {
    log.warn("menu path failed — falling back to direct deep link", {
      msg: (err as Error).message.slice(0, 200),
      deepLink,
    });
  }

  log.step(`goto ${deepLink}`);
  await page.goto(deepLink, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForURL(/TransactionHistory/i, { timeout: 15_000 });
  log.info("fallback path worked", { url: page.url() });
}

/**
 * Dump every visible input + button + selectOneMenu label on the page to the
 * bot log. Used to identify PrimeFaces ids/placeholders/aria-labels without
 * another bot run. Mirrors the inputs-dump from nmbStatement.ts.
 */
async function dumpVisibleControls(log: BotLogger, page: Page, where: string): Promise<void> {
  // String-literal evaluate: tsx wraps named helper functions with __name()
  // which doesn't exist in the browser. The disburser's scrapeBatchNumber
  // uses the same trick for the same reason.
  const controls = (await page.evaluate(`(() => {
    const visible = (el) => !!(el.offsetParent || el.offsetWidth || el.offsetHeight);
    const acc = [];
    document.querySelectorAll('input').forEach((el) => {
      if (!visible(el)) return;
      acc.push({
        kind: 'input',
        id: el.id || '',
        name: el.name || '',
        type: el.type || '',
        placeholder: el.placeholder || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        value: (el.value || '').slice(0, 40),
      });
    });
    document.querySelectorAll('.ui-selectonemenu-label, [role="combobox"], button, .ui-button').forEach((el) => {
      if (!visible(el)) return;
      acc.push({
        kind: el.tagName.toLowerCase() + (el.className && el.className.indexOf && el.className.indexOf('selectonemenu') > -1 ? '.selectonemenu-label' : ''),
        id: el.id || '',
        text: (el.innerText || el.textContent || '').trim().slice(0, 60),
      });
    });
    return acc;
  })()`)) as Array<Record<string, string>>;
  log.detail(`visible controls @ ${where} (${controls.length})`);
  for (const c of controls) {
    log.detail(`  ${JSON.stringify(c)}`);
  }
}

/**
 * Click an element matched by text, retrying on stale-element / not-attached
 * failures. PrimeFaces panels re-render asynchronously after every AJAX call,
 * so a locator resolved a moment ago can be detached by the time we act on it.
 * Each attempt re-resolves the locator and lets Playwright's auto-scroll do
 * its job (we don't pre-scroll, that's what was racing the re-render).
 */
async function clickWithRetry(
  log: BotLogger,
  page: Page,
  textRe: RegExp,
  maxAttempts: number,
  label: string,
): Promise<void> {
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const loc = page.getByText(textRe).first();
      await loc.waitFor({ state: "visible", timeout: 10_000 });
      await loc.click({ timeout: 8_000 });
      return;
    } catch (err) {
      lastErr = err as Error;
      log.warn(`click '${label}' attempt ${attempt}/${maxAttempts} failed`, { msg: lastErr.message.slice(0, 160) });
      await page.waitForTimeout(800);
    }
  }
  throw lastErr ?? new Error(`failed to click '${label}'`);
}

/**
 * Pick an option in a PrimeFaces selectOneMenu by baseId — same pattern the
 * disburser uses for the bulk-payment dropdowns. Triggers a click on the
 * "<baseId>:selectId_label" element (which lazy-loads the panel), waits for
 * "<baseId>:selectId_panel" to be visible, then clicks the matching li item.
 */
async function selectMenu(log: BotLogger, page: Page, baseId: string, optionText: RegExp): Promise<void> {
  const trigger = page.locator(`[id="${baseId}:selectId_label"]`);
  await trigger.waitFor({ state: "visible", timeout: 15_000 });
  await trigger.click();

  const panel = page.locator(`[id="${baseId}:selectId_panel"]`);
  await panel.waitFor({ state: "visible", timeout: 10_000 });
  const item = panel.locator("li.ui-selectonemenu-item", { hasText: optionText }).first();
  await item.waitFor({ state: "visible", timeout: 8_000 });
  await item.click();
  log.detail(`${baseId} → picked ${optionText.source}`);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(400);
}

/**
 * Set the value of a PrimeFaces calendar input. The widget is typically
 * configured with readonlyInput=true so .type() lands characters but the
 * widget rejects them on blur. The reliable path is:
 *   1. Set the visible input's .value programmatically.
 *   2. Fire 'input' + 'change' so the widget syncs its internal model.
 *   3. Blur so server-side validation runs.
 *
 * Falls back to opening the calendar and clicking the day cell if the JS
 * path doesn't stick — some widget builds rebind change handlers.
 */
async function fillCalendarInput(log: BotLogger, page: Page, exactId: string, value: string): Promise<void> {
  // Open the PrimeFaces calendar visually and click the matching day cell.
  // JS-set-value+trigger('change') updates the visible input but does NOT
  // fire the widget's partial-AJAX update — so the server keeps the original
  // empty value and search returns 0 rows. Clicking a day cell engages the
  // widget's own click handler which invokes the AJAX callback correctly.
  const [dd, mm, yyyy] = value.split("/");
  const day = parseInt(dd ?? "0", 10);
  const month = parseInt(mm ?? "0", 10); // 1-12
  const year = parseInt(yyyy ?? "0", 10);
  if (!day || !month || !year) throw new Error(`Bad date value '${value}' — expected DD/MM/YYYY`);

  const input = page.locator(`[id="${exactId}"]`);
  await input.waitFor({ state: "visible", timeout: 15_000 });
  await input.click();
  await page.waitForTimeout(500);

  // Ensure the panel is showing the right month/year. PrimeFaces puts the
  // header in .ui-datepicker-title with span.ui-datepicker-month and
  // span.ui-datepicker-year — click ‹ / › to navigate.
  const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const wantedMonth = monthNames[month - 1]!;
  const wantedYear = String(year);

  // The calendar overlay is appended near body; find the visible one tied to this input.
  const panel = page.locator(".ui-datepicker:visible").first();
  await panel.waitFor({ state: "visible", timeout: 8_000 });

  for (let i = 0; i < 24; i++) {
    const monthText = (await panel.locator(".ui-datepicker-month").first().textContent().catch(() => "")) ?? "";
    const yearText = (await panel.locator(".ui-datepicker-year").first().textContent().catch(() => "")) ?? "";
    if (monthText.trim() === wantedMonth && yearText.trim() === wantedYear) break;
    // Decide direction: compute current (y*12+m-1) vs wanted.
    const curMonthIdx = monthNames.indexOf(monthText.trim());
    const curYear = parseInt(yearText.trim() || "0", 10);
    const cur = curYear * 12 + (curMonthIdx >= 0 ? curMonthIdx : 0);
    const want = year * 12 + (month - 1);
    const navSel = cur > want ? ".ui-datepicker-prev" : ".ui-datepicker-next";
    await panel.locator(navSel).first().click();
    await page.waitForTimeout(200);
  }

  // Click the day cell. Use exact text match and avoid other-month padding cells.
  const dayCell = panel
    .locator("td:not(.ui-datepicker-other-month) a.ui-state-default", {
      hasText: new RegExp(`^\\s*${day}\\s*$`),
    })
    .first();
  await dayCell.waitFor({ state: "visible", timeout: 8_000 });
  await dayCell.click();
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(400);
  log.detail(`${exactId} value after click-day`, {
    value: await input.inputValue().catch(() => "?"),
  });
}

/**
 * Click SEARCH and confirm results appear. If the page shows "Something went
 * wrong. Please try again." (CRDB's intermittent backend hiccup, see screenshot)
 * we click search again — up to maxAttempts.
 */
async function searchWithRetry(log: BotLogger, page: Page, maxAttempts: number): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log.detail(`search attempt ${attempt}/${maxAttempts}`);
    await page.locator('[id="searchBtnId"]').click();

    // Step 1: hard-wait so the spinner is actually rendered, not still pending
    // a frame. CSS animationName came back empty — CRDB uses a JS-rotated SVG
    // arc or animated img/canvas instead. Probe explicitly for SVG/IMG that
    // sits inside the data-table region and is sized roughly square (spinner
    // is typically ~40x40 → 80x80, centred).
    await page.waitForTimeout(1500);
    const spinDump = await page.evaluate(`(() => {
      const out = [];
      const table = document.getElementById('balanceTable') || document.body;
      const tableRect = table.getBoundingClientRect();
      document.querySelectorAll('svg, img, canvas, [role="progressbar"], [aria-busy="true"], i.fa-spin, i[class*="circle"]').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return;
        // Only those inside (or near) the table region.
        const cy = r.top + r.height / 2;
        if (cy < tableRect.top - 100 || cy > tableRect.bottom + 800) return;
        out.push({
          tag: el.tagName,
          id: el.id || '',
          classes: (el.getAttribute('class') || '').slice(0, 100),
          ariaBusy: el.getAttribute('aria-busy') || '',
          role: el.getAttribute('role') || '',
          w: Math.round(r.width),
          h: Math.round(r.height),
          y: Math.round(r.top),
        });
      });
      return out.slice(0, 30);
    })()`);
    log.detail(`spinner-candidates after click (${(spinDump as unknown[]).length}):`);
    for (const s of (spinDump as Array<Record<string, string>>)) log.detail(`  ${JSON.stringify(s)}`);

    // Step 2: poll for real data up to 120s. Same-day User-Defined with ~2k
    // rows can take 30-60s on CRDB. We screenshot every 15s so we can see
    // exactly when the spinner clears.
    log.detail("poll for table data (deadline 120s)");
    const dataDeadline = Date.now() + 120_000;
    let shotsTaken = 0;
    while (Date.now() < dataDeadline) {
      const r = await page.evaluate(`(() => {
        const tbody = document.getElementById('balanceTable_data');
        if (!tbody) return { rows: 0, hasData: false, noRecords: false };
        let rows = 0, hasData = false, noRecords = false;
        tbody.querySelectorAll('tr').forEach((tr) => {
          rows++;
          const t = (tr.textContent || '').trim();
          if (/there are no records fetched/i.test(t)) noRecords = true;
          if (/REF:/i.test(t) || /\\d[\\d,]*\\.\\d{2}/.test(t)) hasData = true;
        });
        return { rows, hasData, noRecords };
      })()`) as { rows: number; hasData: boolean; noRecords: boolean };
      if (r.hasData) {
        log.detail(`data appeared after ${((Date.now() - (dataDeadline - 120_000)) / 1000).toFixed(1)}s — ${r.rows} rows`);
        break;
      }
      // every ~15s take a screenshot so we can see whether spinner still spinning
      const elapsed = 120_000 - (dataDeadline - Date.now());
      if (Math.floor(elapsed / 15_000) > shotsTaken) {
        shotsTaken++;
        await page.screenshot({ path: `/tmp/crdb_poll_${attempt}_${shotsTaken}.png`, fullPage: true }).catch(() => {});
        log.detail(`screenshot #${shotsTaken} at ~${(elapsed/1000).toFixed(0)}s — noRecords=${r.noRecords} rows=${r.rows}`);
      }
      await page.waitForTimeout(2000);
    }
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.screenshot({ path: `/tmp/crdb_post_search_${attempt}.png`, fullPage: true }).catch(() => {});

    const wentWrong = await page
      .getByText(/something went wrong\.?\s*please try again/i)
      .first()
      .isVisible()
      .catch(() => false);
    if (wentWrong) {
      log.warn(`attempt ${attempt}: 'Something went wrong' — retrying`);
      await page.waitForTimeout(2000);
      continue;
    }

    // The Export button is in the DOM from page load (size 0x0 until data),
    // so it's NOT a render signal. The real signals are:
    //  - PrimeFaces loading overlay (.ui-datatable-loading-content / .ui-blockui)
    //    has cleared, AND
    //  - tbody has at least one row whose cells contain real money/REF content,
    //    OR explicit "no records fetched" placeholder is showing.
    // CRDB's datatable empty-state still produces 1 tr in tbody, so a row count
    // alone is meaningless.
    const probeTable = async (): Promise<{ rows: number; hasData: boolean; noRecords: boolean; loading: boolean }> => {
      return (await page.evaluate(`(() => {
        const tbody = document.getElementById('balanceTable_data');
        if (!tbody) return { rows: 0, hasData: false, noRecords: false, loading: true };
        const trs = tbody.querySelectorAll('tr');
        let rows = 0;
        let hasData = false;
        let noRecords = false;
        trs.forEach((tr) => {
          rows++;
          const text = (tr.textContent || '').trim();
          if (/there are no records fetched/i.test(text)) noRecords = true;
          if (/REF:/i.test(text) || /\\d[\\d,]*\\.\\d{2}/.test(text)) hasData = true;
        });
        // Find ANY visible spinner-ish overlay. CRDB shows a rotating spinner
        // inside the table viewport during search AJAX — it survives the
        // .ui-datatable-loading-content classname check, so we cast a wide
        // net: anything with 'loading' or 'spinner' in its class, anywhere
        // inside the bank-statement area, that's actually rendered.
        const isVisible = (el) => {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) return false;
          const cs = window.getComputedStyle(el);
          return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0.1;
        };
        let loading = false;
        const sels = [
          '.ui-datatable-loading-content',
          '.ui-datatable-loading',
          '.ui-blockui',
          '[class*="loading"]',
          '[class*="spinner"]',
          '[class*="Loader"]',
          '[class*="loader"]',
        ];
        for (const s of sels) {
          const nodes = document.querySelectorAll(s);
          for (const n of nodes) {
            if (isVisible(n)) { loading = true; break; }
          }
          if (loading) break;
        }
        return { rows, hasData, noRecords, loading };
      })()`)) as { rows: number; hasData: boolean; noRecords: boolean; loading: boolean };
    };

    const deadline = Date.now() + 60_000;
    let lastLog = 0;
    while (Date.now() < deadline) {
      const probe = await probeTable();
      // Throttled log so we can see if loading=true is observed.
      const now = Date.now();
      if (now - lastLog > 2500) {
        log.detail(`probe: rows=${probe.rows} hasData=${probe.hasData} noRecords=${probe.noRecords} loading=${probe.loading}`);
        lastLog = now;
      }
      // Keep waiting while spinner/overlay is visible. The "no records" text
      // can sit on the page from the prior state even while AJAX is loading,
      // so we never trust noRecords unless loading has cleared.
      if (probe.loading) {
        await page.waitForTimeout(500);
        continue;
      }
      if (probe.hasData) {
        log.detail(`search populated: ${probe.rows} tbody row(s), data confirmed`);
        await page.screenshot({ path: "/tmp/crdb_search_results.png", fullPage: true }).catch(() => {});
        return;
      }
      if (probe.noRecords) {
        log.warn("search returned 'no records fetched' — proceeding (empty range)");
        return;
      }
      await page.waitForTimeout(750);
    }
    await page.screenshot({ path: `/tmp/crdb_search_timeout_${attempt}.png`, fullPage: true }).catch(() => {});
    log.warn(`attempt ${attempt}: table didn't populate with real data in 30s — retrying`);
    await page.waitForTimeout(2000);
  }
  throw new Error(`search failed after ${maxAttempts} attempts (table never populated)`);
}

/**
 * Watch for the "session is about to expire / request more time" popup that
 * CRDB shows after a couple of minutes idle. Clicks YES so the session stays.
 * Safe to call defensively at any step boundary.
 */
async function dismissSessionPopupIfPresent(log: BotLogger, page: Page): Promise<void> {
  try {
    const dialog = page.getByText(/session.*(terminat|expir)|about to (be )?(terminat|expir)|request more time/i);
    if (await dialog.first().isVisible().catch(() => false)) {
      const yes = page.getByRole("button", { name: /^\s*yes\s*$/i }).first();
      if (await yes.isVisible().catch(() => false)) {
        log.detail("session-keepalive popup found → clicking YES");
        await yes.click().catch(() => {});
        await page.waitForTimeout(500);
      }
    }
  } catch {
    /* never break the cycle on a defensive check */
  }
}

/**
 * Background poller: every 5s, checks for the session-expiry popup and
 * clicks YES if present. Returns a stop() to clear the timer.
 */
export function startCrdbSessionKeepalive(log: BotLogger, page: Page): () => void {
  const timer = setInterval(() => {
    void dismissSessionPopupIfPresent(log, page);
  }, 5000);
  return () => clearInterval(timer);
}

/**
 * Suggested type for callers — convert YMD to CRDB's expected DD/MM/YYYY.
 * Centralised here so runCrdbCycle stays bank-agnostic.
 */
export function ymdToDdMmYyyy(ymd: string): string {
  const [y, m, d] = ymd.split("-");
  return `${d}/${m}/${y}`;
}
