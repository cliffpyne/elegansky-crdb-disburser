import type { Page, Download } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { config } from "../config.js";
// removed: import { reportStep, reportShot } — fire-and-forget HTTP was hanging on cold-start Render
import type { BotLogger } from "./botLog.js";

/**
 * From the dashboard, drill into the configured account and download a
 * credits-only CSV statement for [dateFromYmd .. dateToYmd]. Every action
 * is logged so we can step through the trace.
 */
export async function nmbDownloadStatement(
  page: Page,
  log: BotLogger,
  opts: { dateFromYmd: string; dateToYmd: string; savePath: string },
): Promise<string> {
  if (!config.NMB_ACCOUNT_NUMBER) {
    log.error("NMB_ACCOUNT_NUMBER not set");
    throw new Error("NMB_ACCOUNT_NUMBER not set");
  }

  log.step("click account row in Accounts Summary");
  log.detail("looking for row containing", { accountNumber: config.NMB_ACCOUNT_NUMBER });
  const accountRow = page.locator(`tr:has-text("${config.NMB_ACCOUNT_NUMBER}")`).first();
  if (await accountRow.isVisible().catch(() => false)) {
    log.detail("found tr by account number, clicking");
    await accountRow.click();
  } else {
    log.detail("no tr match — falling back to text locator");
    await page.locator(`text=${config.NMB_ACCOUNT_NUMBER}`).first().click();
  }
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  log.detail("after click", { url: page.url() });
  // (removed reportShot page, "NMB: account details page" — botLog covers it)

  log.step("scroll to date-period control under View Options");
  // The "Current Month" combobox lives under a "View Options" label in the
  // left-side filter panel. Anchor by that label, not by the inner text,
  // because clicking on the inner text only sometimes opens the popup.
  const datePeriodAnchor = page
    .locator('label:has-text("View Options") ~ * >> .oj-select-choice')
    .or(page.locator('.oj-select-choice').filter({ hasText: /current month/i }))
    .or(page.locator('[role="combobox"]').filter({ hasText: /current month/i }))
    .first();
  await datePeriodAnchor.scrollIntoViewIfNeeded({ timeout: 15_000 });
  log.detail("scrolled to date-period control");

  log.step("open date-period dropdown and select 'Select Date Range' via keyboard");
  // Click to focus, then use keyboard navigation. The default sequence is
  // Current Month → Previous Month → Previous Quarter → Select Date Range,
  // so 3× ArrowDown then Enter lands on the right option regardless of
  // whether the popup auto-closes on click.
  await datePeriodAnchor.click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/nmb_date_dropdown.png" }).catch(() => {});
  log.detail("saved /tmp/nmb_date_dropdown.png");
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(120);
  }
  await page.keyboard.press("Enter");
  log.detail("pressed 3×ArrowDown + Enter on date-period combobox");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "/tmp/nmb_after_select_daterange.png", fullPage: true }).catch(() => {});
  log.detail("saved /tmp/nmb_after_select_daterange.png");
  // Also dump every visible <input> on the page so we can identify the date
  // fields by id/placeholder/name without another roundtrip.
  const inputs = await page.evaluate(() => {
    const acc: Array<Record<string, string | boolean>> = [];
    document.querySelectorAll<HTMLInputElement>("input").forEach((el) => {
      const visible = !!(el.offsetParent || el.offsetWidth || el.offsetHeight);
      if (!visible) return;
      acc.push({
        id: el.id ?? "",
        name: el.name ?? "",
        type: el.type ?? "",
        placeholder: el.placeholder ?? "",
        ariaLabel: el.getAttribute("aria-label") ?? "",
        classes: (el.className ?? "").toString().slice(0, 100),
        disabled: el.disabled,
      });
    });
    return acc;
  });
  log.detail(`visible inputs: ${JSON.stringify(inputs).slice(0, 1800)}`);

  log.step(`fill Date From → ${opts.dateFromYmd}`);
  await fillDateField(log, page, "Date From", opts.dateFromYmd);

  log.step(`fill Date To → ${opts.dateToYmd}`);
  await fillDateField(log, page, "Date To", opts.dateToYmd);

  log.step("open credit/debit dropdown ('All') and pick 'Credits Only' via keyboard");
  // The credit/debit combobox displays exactly "All". There's only one
  // visible element on the filter panel with that exact text (the period
  // combobox shows "Select Date Range" now, the sort one shows "Ascending").
  // Take a screenshot first so we can debug if this still misses.
  await page.screenshot({ path: "/tmp/nmb_before_creditdebit.png", fullPage: true }).catch(() => {});
  const creditDebitAnchor = page.getByText("All", { exact: true }).first();
  await creditDebitAnchor.scrollIntoViewIfNeeded({ timeout: 10_000 });
  await creditDebitAnchor.click();
  await page.waitForTimeout(500);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(120);
  await page.keyboard.press("Enter");
  log.detail("pressed 1×ArrowDown + Enter — should now be 'Credits Only'");
  await page.waitForTimeout(500);

  // ── AMOUNT RANGE SPLIT (Frank 2026-06-07) ──────────────────────────────
  // Downloading a wide date range (yesterday → today) often trips NMB's
  // "Big Data Statement" exceed-limit dialog: the inline CSV is rejected
  // and the file is queued for 10-20 min. Splitting by AMOUNT range keeps
  // each download under NMB's inline-row threshold.
  // Three passes per cycle (Frank 2026-06-09 — was 2):
  //   pass 1: amount       1 ..     12,000   (small payments, high volume)
  //   pass 2: amount  12,001 ..     12,500   (mid sliver — was bleeding into large+small via the amount-filter leak)
  //   pass 3: amount  12,501 .. 10,000,000   (large payments, lower volume)
  // CSVs are combined + sorted ascending BEFORE handing to the processor —
  // never sync before combine (operator rule: out-of-order rows = bad).
  // Queue of amount ranges. When the "Big Data Statement" popup appears on
  // a range (Frank 2026-06-14), we push two halved sub-ranges back onto the
  // front of the queue and continue. The recursion bottoms out at 1-wide
  // ranges (cannot split further); those get skipped with a warning.
  type Range = { from: number; to: number; label: string };
  const queue: Range[] = [
    { from: 1,       to: 12_000,       label: "small" },
    { from: 12_001,  to: 12_500,       label: "mid"   },
    { from: 12_501,  to: 100_000_000,  label: "large" },
  ];
  const partPaths: string[] = [];
  let passNum = 0;
  while (queue.length > 0) {
    const range = queue.shift()!;
    passNum++;
    log.step(`AMOUNT PASS ${range.label} (${range.from}–${range.to}) [#${passNum}, queue=${queue.length}]`);

    // Between passes (NOT before the first), dismiss any lingering JET
    // dropdown overlay. Frank 2026-06-13: the Download dropdown stayed
    // in "open" state after the small pass; the next pass's Download
    // click hit the open menu instead of the button and timed out.
    // First pass MUST skip this — we're still in the dropdown-open
    // state from selecting the date period above and Escape would
    // close it.
    if (passNum > 1) {
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(200);
      await page.locator("body").click({ position: { x: 1, y: 1 }, force: true }).catch(() => {});
      await page.waitForTimeout(300);
    }

    // Dismiss any leftover modal-window from prior iteration BEFORE typing
    // Amount fields. The "excessTransactionDialog" / offlineStatementNotification
    // popup (Frank 2026-06-09): appears after a small-pass download nears the
    // result limit; NMB leaves it open across iterations and it intercepts
    // every click on the underlying form. We dismiss by trying Close → OK → X
    // → Escape in order. All best-effort; no throw.
    try {
      const modal = page.locator(".modal-window-viewport, modal-window").first();
      if (await modal.isVisible({ timeout: 500 }).catch(() => false)) {
        log.detail(`modal popup detected before ${range.label} pass — dismissing`);
        await page.screenshot({ path: `/tmp/nmb_modal_before_${range.label}.png`, fullPage: true }).catch(() => {});
        const closeButtons = [
          page.getByRole("button", { name: /^\s*close\s*$/i }).first(),
          page.getByRole("button", { name: /^\s*ok\s*$/i }).first(),
          page.getByRole("button", { name: /^\s*cancel\s*$/i }).first(),
          page.locator(".oj-dialog-close-icon, [aria-label='Close'], button.close").first(),
        ];
        let dismissed = false;
        for (const btn of closeButtons) {
          if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
            await btn.click({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(500);
            if (!(await modal.isVisible({ timeout: 300 }).catch(() => false))) {
              log.detail("modal dismissed via button");
              dismissed = true;
              break;
            }
          }
        }
        if (!dismissed) {
          await page.keyboard.press("Escape").catch(() => {});
          await page.waitForTimeout(500);
          if (!(await modal.isVisible({ timeout: 300 }).catch(() => false))) {
            log.detail("modal dismissed via Escape");
            dismissed = true;
          }
        }
        if (!dismissed) {
          log.warn("modal popup persists despite dismiss attempts — proceeding anyway");
        }
      }
    } catch (e) {
      log.detail(`pre-pass modal-dismiss skipped: ${String((e as Error).message || e).slice(0, 80)}`);
    }

    await fillAmountField(log, page, "Amount From", range.from);
    await fillAmountField(log, page, "Amount To", range.to);

    log.step(`click Apply Filter (${range.label})`);
    await page.getByRole("button", { name: /apply filter/i }).click();
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

    // Big Data Statement popup detection (Frank 2026-06-14): the popup
    // surfaces LATE — after the underlying CSV download may already have
    // started — so a 2s wait was missing it and we got partial data.
    // Sleep a hard 5s, then check. If popup present → dismiss + halve
    // this range + push both halves to the FRONT of the queue + skip
    // download for this iteration.
    log.detail(`waiting 5s for Big Data Statement popup detection (${range.label})`);
    await page.waitForTimeout(5000);

    // CRITICAL (Frank 2026-06-14): scope detection to a MODAL/DIALOG element.
    // NMB has a STATIC "Big Data Statement" button at the bottom of the
    // filter panel (manual offline-statement request). A naive
    // getByText(/big data statement/i) always matched the button → false
    // positive → infinite-split loop. Real popup is wrapped in
    // .modal-window-viewport / oj-dialog / role=dialog.
    const bdsPopup = page
      .locator('.modal-window-viewport, modal-window, oj-dialog, .oj-dialog, [role="dialog"]')
      .filter({ hasText: /big data statement|exceeds limit/i })
      .first();
    if (await bdsPopup.isVisible().catch(() => false)) {
      const noteText = (await bdsPopup.textContent().catch(() => "")) ?? "";
      const refMatch = noteText.match(/[A-Z]{2,}[0-9]{4,}/);
      log.warn(`Big Data Statement on ${range.label} (${range.from}–${range.to}) — SPLITTING`, {
        reference: refMatch?.[0] ?? "unknown",
        noteText: noteText.slice(0, 200),
      });
      await page.screenshot({ path: `/tmp/nmb_bds_popup_${range.label}_${passNum}.png`, fullPage: true }).catch(() => {});

      // Dismiss the popup (best effort): OK button → Close → Escape.
      const okBtn = page.getByRole("button", { name: /^\s*ok\s*$/i }).first();
      if (await okBtn.isVisible().catch(() => false)) {
        await okBtn.click().catch(() => {});
      } else {
        await page.keyboard.press("Escape").catch(() => {});
      }
      await page.waitForTimeout(800);

      // Split logic: bottom-out at 1-wide ranges so we never infinite-loop.
      if (range.to <= range.from) {
        log.warn(`cannot split single-amount range ${range.from} — skipping`);
        continue;
      }
      const mid = Math.floor((range.from + range.to) / 2);
      const lo: Range = { from: range.from, to: mid,        label: `${range.label}-lo` };
      const hi: Range = { from: mid + 1,    to: range.to,   label: `${range.label}-hi` };
      log.detail(`split ${range.label} → ${lo.label} (${lo.from}–${lo.to}) + ${hi.label} (${hi.from}–${hi.to})`);
      // unshift in reverse so lo is processed first, hi second.
      queue.unshift(hi);
      queue.unshift(lo);
      continue;
    }

    log.step(`wait for results panel to settle (${range.label}) — stable row count`);
    // FIX (Frank 2026-06-07): the previous heuristic returned 'no-activity' as
    // soon as the literal "No Activity found" text appeared ANYWHERE on the
    // page — but NMB leaves that text in stale dialog/info panels, so we
    // bailed instantly with the OLD filter's rows (or none). On the 07-Jun
    // test we got 39 rows instead of 700+. Fix:
    //   1. Always wait a minimum 3s after Apply Filter so the new AJAX result
    //      has time to render.
    //   2. Count TZS-amount rows in the table. Only proceed once that count
    //      has been STABLE for 2 consecutive 500ms polls. That guarantees
    //      AJAX has finished writing rows.
    //   3. Only accept "no-activity" if (a) the message persists for >3s
    //      AND (b) row count is still 0.
    const filterAppliedAt = Date.now();
    const resultsDeadline = filterAppliedAt + 60_000;
    let lastCount = -1;
    let stableSince = 0;
    let settled = false;
    while (Date.now() < resultsDeadline) {
      const state = (await page.evaluate(`(() => {
        const txt = document.body && document.body.innerText || '';
        const hasNoActivity = /no activity found/i.test(txt);
        let rowCount = 0;
        const trs = document.querySelectorAll('tr');
        for (const tr of trs) {
          const tds = tr.querySelectorAll('td');
          if (tds.length < 3) continue;
          const t = (tr.textContent || '').trim();
          if (/\\b\\d[\\d,]*\\.\\d{2}\\b/.test(t)) rowCount++;
        }
        return { rowCount: rowCount, hasNoActivity: hasNoActivity };
      })()`)) as { rowCount: number; hasNoActivity: boolean };

      const elapsed = Date.now() - filterAppliedAt;
      if (state.rowCount > 0) {
        if (state.rowCount === lastCount) {
          if (Date.now() - stableSince >= 2_000) {
            log.detail(`${range.label} settled — ${state.rowCount} rows (stable 2s)`);
            settled = true;
            break;
          }
        } else {
          lastCount = state.rowCount;
          stableSince = Date.now();
        }
      } else if (state.hasNoActivity && elapsed > 3_000) {
        log.detail(`${range.label} settled — no-activity (after ${elapsed}ms wait)`);
        settled = true;
        break;
      }
      await page.waitForTimeout(500);
    }
    if (!settled) {
      log.warn(`${range.label} results never settled within 60s — proceeding with current state (lastCount=${lastCount})`);
    }

    const partPath = opts.savePath.replace(/\.csv$/i, `_${range.label}.csv`);
    await page.screenshot({ path: `/tmp/nmb_before_download_${range.label}.png`, fullPage: true }).catch(() => {});

    log.step(`click Download dropdown (${range.label})`);
    await clickDownloadWithFallback(log, page);

    log.step(`click CSV option + capture download → ${partPath}`);
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      page
        .getByRole("menuitem", { name: /^csv$/i })
        .or(page.getByText(/^csv$/i))
        .first()
        .click(),
    ]);
    log.detail(`${range.label} download received`, { suggestedFilename: download.suggestedFilename() });
    await saveDownload(download, partPath);
    await page.screenshot({ path: `/tmp/nmb_after_download_${range.label}.png`, fullPage: true }).catch(() => {});
    log.info(`✅ ${range.label} part saved`, { path: partPath });
    partPaths.push(partPath);
  }

  // ── Combine + sort BEFORE sync (per Frank's explicit rule) ─────────────
  log.step("combine amount-split CSVs (concat data, preserve header from first)");
  combineNmbCsvParts(partPaths, opts.savePath);
  log.info("✅ combined statement saved", { path: opts.savePath, parts: partPaths.length });
  return opts.savePath;
}

/**
 * Click NMB's "Download" dropdown trigger with multi-strategy fallback.
 *
 * Why this is hairy: the page can have multiple Download-flavoured buttons
 * (some in collapsed panels, some in hidden side menus). The accessible
 * name on the real trigger is sometimes "Download" plus an icon, sometimes
 * "Download ▼", sometimes wrapped in a span. A strict /^download$/i regex
 * misses these variants. Previous code hung 60s on the wrong button.
 *
 * Strategy:
 *   1. Look up every visible "Download" candidate via DOM evaluate. Log them
 *      so failures show the candidate list.
 *   2. Try regular .click() on the most-likely candidate (lenient regex, scoped
 *      to visible elements only).
 *   3. If that times out (20s), JS-dispatch a click on the candidate id directly.
 *   4. If that still fails, throw with the candidate dump so the operator can
 *      see in BRAIN what we tried.
 */
async function clickDownloadWithFallback(log: BotLogger, page: Page): Promise<void> {
  const candidates = (await page.evaluate(`(() => {
    const out = [];
    document.querySelectorAll('button, a, oj-button, [role="button"]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const text = (el.innerText || el.textContent || '').trim();
      const aria = (el.getAttribute('aria-label') || '').trim();
      if (!/download/i.test(text) && !/download/i.test(aria)) return;
      out.push({
        tag: el.tagName,
        id: el.id || '',
        text: text.slice(0, 60),
        aria: aria.slice(0, 60),
        y: Math.round(r.top),
      });
    });
    return out.slice(0, 20);
  })()`)) as Array<{ tag: string; id: string; text: string; aria: string; y: number }>;

  log.detail(`Download candidates (${candidates.length}):`);
  for (const c of candidates) log.detail(`  ${JSON.stringify(c)}`);

  // Strategy 1: lenient by-text click. The /download/i regex allows trailing
  // characters (▼, whitespace, etc.) — previous /^download$/i was too strict.
  try {
    const btn = page
      .locator(":visible")
      .getByRole("button", { name: /download/i })
      .first();
    await btn.click({ timeout: 20_000 });
    log.detail("Download: regular click landed");
    return;
  } catch (err) {
    log.warn("Download: regular click failed — trying JS dispatch", {
      msg: (err as Error).message.slice(0, 140),
    });
  }

  // Strategy 2: JS-dispatch on the first candidate with an id.
  const target = candidates.find((c) => c.id);
  if (target) {
    await page.evaluate(`(() => {
      const el = document.getElementById(${JSON.stringify(target.id)});
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.click();
    })()`);
    log.detail(`Download: JS-dispatched click on #${target.id}`);
    await page.waitForTimeout(800);
    return;
  }

  // Strategy 3: NMB stripped the id from the Download button (UI change
  // mid-June 2026). Walk the DOM ourselves, find the first visible
  // "Download" element by text/aria, and dispatch a click on it.
  if (candidates.length > 0) {
    const clicked = (await page.evaluate(`(() => {
      const els = document.querySelectorAll('button, a, oj-button, [role="button"]');
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const text = (el.innerText || el.textContent || '').trim();
        const aria = (el.getAttribute('aria-label') || '').trim();
        if (!/download/i.test(text) && !/download/i.test(aria)) continue;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.click();
        return { tag: el.tagName, text: text.slice(0, 60) };
      }
      return null;
    })()`)) as { tag: string; text: string } | null;
    if (clicked) {
      log.detail(`Download: by-text JS click on ${clicked.tag} "${clicked.text}"`);
      await page.waitForTimeout(800);
      return;
    }
  }

  throw new Error(
    `Download button click failed: no clickable candidate found. ` +
      `Candidates: ${JSON.stringify(candidates).slice(0, 400)}`,
  );
}

/**
 * Fill an Oracle JET date input. Real DOM ids are like
 *   fromDate<random>|input    and    toDate<random>|input
 * so we anchor on the prefix and (DD MMM YYYY) typed format the widget
 * accepts. Press Escape afterwards so the calendar overlay doesn't capture
 * the next click.
 */
async function fillDateField(log: BotLogger, page: Page, label: string, ymd: string): Promise<void> {
  const formatted = ymdToDdMmmYyyy(ymd); // "28 May 2026"

  // Prefix selector: "Date From" → fromDate..., "Date To" → toDate...
  const prefix = /from/i.test(label) ? "fromDate" : "toDate";
  const ojInput = page.locator(`input[id^="${prefix}"][id$="|input"]`).first();

  await ojInput.waitFor({ state: "visible", timeout: 15_000 });
  log.detail(`${label}: focusing input`, { selector: `input[id^="${prefix}"]`, value: formatted });

  // FIX (Frank 2026-06-09): operator observed dates being typed and then
  // deleted on retry, leading to 400 Bad Request on the CSV download. Root
  // cause: previous code used `Escape` to dismiss the calendar — but in
  // Oracle JET's date widget Escape is "cancel last edit" → reverts the
  // typed value. New strategy:
  //   1. Triple-click to select all (safer than Ctrl+A on JET widgets).
  //   2. Fill with empty via Playwright .fill('') — atomic, no race.
  //   3. Type the formatted date.
  //   4. Commit with Tab (NOT Escape) — Tab triggers the widget's "blur
  //      and commit" handler.
  //   5. Verify .inputValue() === formatted; if not, retry up to 3 times.
  //   6. If still wrong after 3 retries, throw with a clear message so the
  //      caller can surface "scraper couldn't set date" to the operator
  //      instead of failing 30s later on a 400 download.
  for (let attempt = 1; attempt <= 3; attempt++) {
    await ojInput.click({ clickCount: 3 }).catch(() => {});
    await ojInput.fill("").catch(() => {});
    await page.waitForTimeout(150);
    await ojInput.type(formatted, { delay: 40 });
    await page.keyboard.press("Tab");
    await page.waitForTimeout(400);

    const got = await ojInput.inputValue().catch(() => "");
    log.detail(`${label}: attempt ${attempt}/3 value after type`, { got, want: formatted });

    // Oracle JET sometimes normalises "28 May 2026" → "28-May-2026" or
    // "28 MAY 2026" — accept any case + space/hyphen separator variant.
    const norm = (s: string) => s.replace(/[-\s]/g, "").toUpperCase();
    if (norm(got) === norm(formatted)) {
      log.detail(`${label}: value committed OK (attempt ${attempt})`);
      return;
    }

    log.warn(`${label}: value mismatch on attempt ${attempt}`, { got, want: formatted });
    await page.waitForTimeout(300);
  }

  // 3 attempts failed — throw with a clear message so the caller fails
  // FAST instead of crashing 30s later on the malformed download request.
  const finalVal = await ojInput.inputValue().catch(() => "?");
  throw new Error(
    `fillDateField(${label}): could not set value to "${formatted}" after 3 attempts (last value: "${finalVal}")`,
  );
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

async function fillAmountField(log: BotLogger, page: Page, label: "Amount From" | "Amount To", value: number): Promise<void> {
  // NMB uses Oracle JET form controls. Inputs have id prefixes that match
  // their semantic label, suffixed with "|input". The amount fields use
  // "amountFrom" / "amountTo" — matched here with multiple selector
  // strategies to survive any small ID variance.
  const prefix = /from/i.test(label) ? "amountFrom" : "amountTo";
  // Try id-based first (matches the date-field selector style), then label-based
  const byId = page.locator(`input[id^="${prefix}"][id$="|input"]`).first();
  const byLabel = page.getByLabel(label, { exact: true }).first();

  let target = byId;
  if (!(await byId.isVisible().catch(() => false))) {
    log.detail(`${label}: id-prefix selector not visible, falling back to getByLabel`);
    target = byLabel;
  }

  await target.waitFor({ state: "visible", timeout: 10_000 });
  await target.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await target.type(String(value), { delay: 25 });
  await page.keyboard.press("Tab");
  await page.waitForTimeout(200);
  log.detail(`${label}: value after type`, {
    value: await target.inputValue().catch(() => "?"),
  });
}

/**
 * Combine N NMB CSV parts (downloaded from different amount-range filter
 * passes) into one CSV at outPath. Preserves the first part's 4-row
 * header block; concatenates every subsequent data row verbatim.
 *
 * Frank 2026-06-14: NO dedup at the scraper. The transaction-processor
 * owns ALL dedup. Any same-ref overlap from NMB's amount-filter leak
 * passes through; the processor catches it downstream.
 *
 * Output is unsorted at this stage. sortNmbCsvByDateInPlace runs after.
 */
function combineNmbCsvParts(partPaths: string[], outPath: string): { totalDataRows: number } {
  if (partPaths.length === 0) {
    writeFileSync(outPath, "");
    return { totalDataRows: 0 };
  }
  const allParts = partPaths.map((p) => readFileSync(p, "utf8"));
  const lineSep = allParts[0]!.includes("\r\n") ? "\r\n" : "\n";
  const firstLines = allParts[0]!.split(/\r?\n/);
  const headerBlock = firstLines.slice(0, 4);

  const allDataRows: string[] = [];
  for (const raw of allParts) {
    const lines = raw.split(/\r?\n/);
    for (let i = 4; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.trim().length === 0) continue;
      allDataRows.push(line);
    }
  }

  const out = [...headerBlock, ...allDataRows].join(lineSep) + lineSep;
  writeFileSync(outPath, out);
  return { totalDataRows: allDataRows.length };
}

/** "2026-05-28" → "28 May 2026" */
function ymdToDdMmmYyyy(ymd: string): string {
  const [y, m, d] = ymd.split("-");
  const monthIdx = Math.max(0, Math.min(11, parseInt(m ?? "0", 10) - 1));
  return `${parseInt(d ?? "0", 10)} ${MONTH_NAMES[monthIdx]} ${y}`;
}

async function saveDownload(d: Download, path: string): Promise<void> {
  await d.saveAs(path);
}
