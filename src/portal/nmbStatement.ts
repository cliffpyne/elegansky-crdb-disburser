import type { Page, Download } from "playwright";
import { config } from "../config.js";
import { reportStep, reportShot } from "../worker/status.js";
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
  await reportShot(page, "NMB: account details page");

  log.step("open date-period dropdown (currently 'Current Month')");
  await page
    .locator('select, [role="combobox"], div')
    .filter({ hasText: /current month/i })
    .first()
    .click();

  log.step("pick 'Select Date Range' option");
  await page
    .getByRole("option", { name: /select date range/i })
    .or(page.getByText(/select date range/i))
    .first()
    .click();

  log.step(`fill Date From → ${opts.dateFromYmd}`);
  await fillDateField(log, page, "Date From", opts.dateFromYmd);

  log.step(`fill Date To → ${opts.dateToYmd}`);
  await fillDateField(log, page, "Date To", opts.dateToYmd);

  log.step("open credit/debit dropdown");
  await page
    .locator('select, [role="combobox"], div')
    .filter({ hasText: /^(all|credits|debits)/i })
    .first()
    .click();

  log.step("pick 'Credits Only'");
  await page
    .getByRole("option", { name: /credits only/i })
    .or(page.getByText(/credits only/i))
    .first()
    .click();

  log.step("click Apply Filter");
  await page.getByRole("button", { name: /apply filter/i }).click();
  await reportStep("NMB: applied filter");

  log.step("wait for filtered table to render");
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await reportShot(page, "NMB: filtered table");

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

async function fillDateField(log: BotLogger, page: Page, label: string, ymd: string): Promise<void> {
  const byLabel = page.getByLabel(new RegExp(label, "i")).first();
  if (await byLabel.isVisible().catch(() => false)) {
    log.detail(`${label}: using getByLabel`, { value: ymd });
    await byLabel.click();
    await byLabel.fill(ymd);
    await page.keyboard.press("Escape");
    return;
  }
  log.detail(`${label}: falling back to following-input xpath`, { value: ymd });
  const labeled = page.locator(`div:has-text("${label}") >> xpath=following::input[1]`).first();
  await labeled.click();
  await labeled.fill(ymd);
  await page.keyboard.press("Escape");
}

async function saveDownload(d: Download, path: string): Promise<void> {
  await d.saveAs(path);
}
