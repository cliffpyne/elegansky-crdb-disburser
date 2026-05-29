import type { Page, Download } from "playwright";
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

  log.step("click Apply Filter");
  await page.getByRole("button", { name: /apply filter/i }).click();
  // (removed reportStep "NMB: applied filter" — botLog covers it)

  log.step("wait for filtered table to render");
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // ── Detect NMB's "exceeds limit" / Big Data Statement note ─────────────
  // When the chosen date range produces more rows than NMB's inline-download
  // threshold, NMB pops a Note dialog:
  //   "The activity for the specified period exceeds limit. Hence it will be
  //    available under the 'Big Data Statement' section after 15-20 minutes.
  //    The reference number for it is [LACTION...]"
  // We surface this clearly so the operator/cron knows today's data was too
  // large for inline CSV and a BDS request has been queued.
  log.step("check for NMB 'exceeds limit' (Big Data Statement queued) note");
  const exceedsNote = page.getByText(/exceeds limit/i).first();
  if (await exceedsNote.isVisible().catch(() => false)) {
    const noteText = (await exceedsNote.textContent().catch(() => "")) ?? "";
    const refMatch = noteText.match(/[A-Z]{2,}[0-9]{4,}/);
    const reference = refMatch?.[0] ?? "unknown";
    log.warn("NMB queued this request as Big Data Statement", { reference, noteText: noteText.slice(0, 300) });
    // Take a screenshot for the audit trail before dismissing.
    await page.screenshot({ path: "/tmp/nmb_bds_queued.png", fullPage: true }).catch(() => {});
    // OK out so we don't leave the modal blocking the next cycle.
    const okBtn = page.getByRole("button", { name: /^\s*ok\s*$/i }).first();
    if (await okBtn.isVisible().catch(() => false)) await okBtn.click().catch(() => {});
    throw new Error(
      `NMB queued this period as a Big Data Statement (ref=${reference}). ` +
        `File will be available via the BDS section in 15-20 minutes — but the bot ` +
        `runs today-only so this should not normally happen. If it does, today's ` +
        `volume exceeded NMB's inline threshold and we need to add BDS retrieval.`,
    );
  }
  log.detail("no 'exceeds limit' note — proceeding with inline CSV");
  // (removed reportShot page, "NMB: filtered table" — botLog covers it)

  log.step("click Download dropdown");
  await page.getByRole("button", { name: /^download$/i }).click();

  log.step(`click CSV option and capture download → ${opts.savePath}`);
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    page
      .getByRole("menuitem", { name: /^csv$/i })
      .or(page.getByText(/^csv$/i))
      .first()
      .click(),
  ]);

  log.detail("download event received", {
    suggestedFilename: download.suggestedFilename(),
  });
  await saveDownload(download, opts.savePath);
  log.info("✅ statement saved", { path: opts.savePath });
  return opts.savePath;
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

  await ojInput.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await ojInput.type(formatted, { delay: 25 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  log.detail(`${label}: value after type`, {
    value: await ojInput.inputValue().catch(() => "?"),
  });
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-05-28" → "28 May 2026" */
function ymdToDdMmmYyyy(ymd: string): string {
  const [y, m, d] = ymd.split("-");
  const monthIdx = Math.max(0, Math.min(11, parseInt(m ?? "0", 10) - 1));
  return `${parseInt(d ?? "0", 10)} ${MONTH_NAMES[monthIdx]} ${y}`;
}

async function saveDownload(d: Download, path: string): Promise<void> {
  await d.saveAs(path);
}
