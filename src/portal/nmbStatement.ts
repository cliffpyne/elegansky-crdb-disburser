import type { Page, Download } from "playwright";
import { config } from "../config.js";
import { reportStep, reportShot } from "../worker/status.js";

/**
 * From the dashboard, drill into the configured account and download a
 * credits-only CSV statement for the date range [from..to].
 *
 * Steps (NMB screenshots):
 *   • Click account row in Accounts Summary
 *   • On Account Details: change "Current Month" → "Select Date Range"
 *   • Fill Date From, Date To
 *   • Switch credit/debit selector to "Credits Only"
 *   • Click Apply Filter, wait for table
 *   • Click Download dropdown → click "csv"
 *
 * Returns the saved CSV file path.
 */
export async function nmbDownloadStatement(
  page: Page,
  opts: { dateFromYmd: string; dateToYmd: string; savePath: string },
): Promise<string> {
  // ── 1. Click the account row in Accounts Summary ──────────────────────
  await reportStep("NMB: selecting account from Accounts Summary");
  if (!config.NMB_ACCOUNT_NUMBER) {
    throw new Error("NMB_ACCOUNT_NUMBER not set — must specify which account to open");
  }
  // The Accounts Summary row contains the account number; clicking it (or the
  // account-holder name in the same row) drills in.
  const accountRow = page
    .locator(`tr:has-text("${config.NMB_ACCOUNT_NUMBER}")`)
    .first();
  if (await accountRow.isVisible().catch(() => false)) {
    await accountRow.click();
  } else {
    // Fallback: click any link/cell containing the account number.
    await page.locator(`text=${config.NMB_ACCOUNT_NUMBER}`).first().click();
  }
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await reportShot(page, "NMB: account details page");

  // ── 2. Open the date-range view-option dropdown ──────────────────────
  await reportStep("NMB: opening date range selector");
  // The "Current Month" dropdown is the date-period selector. Click it.
  await page
    .locator('select, [role="combobox"], div')
    .filter({ hasText: /current month/i })
    .first()
    .click();

  // Pick "Select Date Range"
  await page
    .getByRole("option", { name: /select date range/i })
    .or(page.getByText(/select date range/i))
    .first()
    .click();

  // ── 3. Date From / Date To ───────────────────────────────────────────
  await reportStep(`NMB: setting date range ${opts.dateFromYmd} → ${opts.dateToYmd}`);

  // The fields appear after "Select Date Range" is chosen. Their labels in
  // the screenshots read "Date From" / "Date To".
  await fillDateField(page, "Date From", opts.dateFromYmd);
  await fillDateField(page, "Date To", opts.dateToYmd);

  // ── 4. Credit/Debit → Credits Only ───────────────────────────────────
  await reportStep("NMB: setting filter to Credits Only");
  await page
    .locator('select, [role="combobox"], div')
    .filter({ hasText: /^(all|credits|debits)/i })
    .first()
    .click();
  await page
    .getByRole("option", { name: /credits only/i })
    .or(page.getByText(/credits only/i))
    .first()
    .click();

  // ── 5. Apply Filter ──────────────────────────────────────────────────
  await reportStep("NMB: applying filter");
  await page.getByRole("button", { name: /apply filter/i }).click();

  // ── 6. Wait for table to populate ────────────────────────────────────
  // Heuristic: at least one row in the transactions table or the "no records"
  // message appears within 30s.
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(2000); // ensure render finishes
  await reportShot(page, "NMB: filtered table ready");

  // ── 7. Open Download dropdown + click csv ────────────────────────────
  await reportStep("NMB: triggering CSV download");
  await page.getByRole("button", { name: /^download$/i }).click();

  // The dropdown shows "pdf / xlsx / csv".
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    page
      .getByRole("menuitem", { name: /^csv$/i })
      .or(page.getByText(/^csv$/i))
      .first()
      .click(),
  ]);

  await saveDownload(download, opts.savePath);
  await reportStep(`NMB: statement saved to ${opts.savePath}`);
  return opts.savePath;
}

/**
 * Fill a date input identified by its visible label text. Tries label-for
 * association first, then a sibling input.
 */
async function fillDateField(page: Page, label: string, ymd: string): Promise<void> {
  // Strategy 1: aria-label / accessible name
  const byLabel = page.getByLabel(new RegExp(label, "i")).first();
  if (await byLabel.isVisible().catch(() => false)) {
    await byLabel.click();
    await byLabel.fill(ymd);
    await page.keyboard.press("Escape"); // close any picker the click opened
    return;
  }
  // Strategy 2: input that follows a div containing the label text
  const labeled = page
    .locator(`div:has-text("${label}") >> xpath=following::input[1]`)
    .first();
  await labeled.click();
  await labeled.fill(ymd);
  await page.keyboard.press("Escape");
}

async function saveDownload(d: Download, path: string): Promise<void> {
  await d.saveAs(path);
}
