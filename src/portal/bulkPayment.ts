import type { Page } from "playwright";
import { config } from "../config.js";
import type { Payment } from "../disburse/buildMnoFile.js";
import { waitForFreshTan } from "./tanClient.js";
import { reportStep, reportShot } from "../worker/status.js";

/**
 * Drives the CRDB MassPayment (bulk payment) page, matching the walkthrough:
 *   Debit Account Option → Multiple Debit Accounts
 *   File Type            → Comma Separated
 *   Transfer Type        → MNO
 *   From Account         → <BANK_FROM_ACCOUNT>
 *   Narration            → (left empty)
 *   radios               → left at default (Create New)
 *   Upload File          → the generated CSV
 *
 * Selecting + uploading is reversible; ACTUALLY SUBMITTING moves money and is
 * handled separately, gated by DISBURSE_PAUSED (kill switch on the worker).
 */

const BASE = config.BANK_LOGIN_URL.replace(/Login\.xhtml.*$/, "");

/** Navigate to the bulk payment page (menu hover, with direct-URL fallback). */
export async function navigateToBulkPayment(page: Page): Promise<void> {
  try {
    await page.getByText(/^\s*Payments\s*$/i).first().hover();
    await page.waitForTimeout(800);
    await page.getByText(/^\s*Bulk Payments\s*$/i).first().click({ timeout: 8000 });
    await page.waitForURL(/MassPayment/i, { timeout: 20_000 });
  } catch {
    await page.goto(`${BASE}MassPayment.xhtml?cs=1`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  }
  await page.waitForLoadState("networkidle").catch(() => {});
}

/**
 * Pick an option in a PrimeFaces selectOneMenu by its visible label.
 * Clicks the menu trigger (which lazy-loads the panel items), then the item.
 */
async function selectMenu(page: Page, baseId: string, optionText: string | RegExp): Promise<void> {
  await page.locator(`[id="${baseId}:selectId_label"]`).click();
  const panel = page.locator(`[id="${baseId}:selectId_panel"]`);
  await panel.waitFor({ state: "visible", timeout: 10_000 });
  await panel.locator("li.ui-selectonemenu-item", { hasText: optionText }).first().click();
  // let the PrimeFaces AJAX update settle
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(400);
}

/** Fill all dropdowns and upload the CSV. Does NOT submit. */
export async function fillBulkPaymentForm(page: Page, csvPath: string): Promise<void> {
  log("selecting Debit Account Option → Multiple Debit Accounts");
  await selectMenu(page, "multiAccountOptionId", "Multiple Debit Accounts");

  log("selecting File Type → Comma Separated");
  await selectMenu(page, "fileTypeId", "Comma Separated");

  log("selecting Transfer Type → MNO");
  await selectMenu(page, "fileDDId", /^\s*MNO\s*$/);

  log(`selecting From Account → ${config.BANK_FROM_ACCOUNT}`);
  await selectMenu(page, "accountId", config.BANK_FROM_ACCOUNT);

  // Narration left empty, radios left at default (Create New) per the walkthrough.

  log(`uploading file: ${csvPath}`);
  // Target the BULK CSV upload input specifically (id starts with "fileUploadId:"),
  // NOT the page's other image-only file input. The j_idt suffix is generated,
  // so match by prefix for stability.
  await page.locator('input[type="file"][id^="fileUploadId:"]').first().setInputFiles(csvPath);
  // PrimeFaces auto-uploads + parses the file; wait for the rows to be fetched
  // into the table below (or a clear timeout).
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(3000);
  await reportShot(page, "form filled + CSV uploaded");
}

/** Click SUBMIT on the form → land on the confirmation page (no money yet). */
export async function submitToConfirm(page: Page): Promise<void> {
  log("clicking SUBMIT (→ confirmation page, money NOT sent yet)");
  await page.locator('[id="buttonPanelId:button1Id"]').click();
  await page.waitForURL(/MassPaymentConfirm/i, { timeout: 30_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await reportShot(page, "on confirmation page (money NOT sent yet)");
}

export interface ConfirmRow {
  phone: string;
  amountTzs: number;
}

/** Scrape the bank's BATCH NUMBER from the confirmation page (for our log). */
export async function scrapeBatchNumber(page: Page): Promise<string | null> {
  return (await page.evaluate(`(() => {
    const cells = Array.from(document.querySelectorAll('td,th,div,span,label'));
    for (let i = 0; i < cells.length; i++) {
      if (/BATCH NUMBER/i.test(cells[i].textContent || '')) {
        for (let j = i; j < Math.min(i + 6, cells.length); j++) {
          const m = (cells[j].textContent || '').match(/\\b(\\d{8,})\\b/);
          if (m) return m[1];
        }
      }
    }
    return null;
  })()`)) as string | null;
}

/** Scrape the phone+amount rows shown on the confirmation page. */
export async function scrapeConfirmation(page: Page): Promise<ConfirmRow[]> {
  const rows = (await page.evaluate(`(() => {
    const out = [];
    document.querySelectorAll('tr').forEach((tr) => {
      const txt = tr.textContent || '';
      if (/TZS/.test(txt)) {
        const phone = (txt.match(/0\\d{9}/) || [])[0];
        const amt = txt.match(/([\\d,]+)\\.\\d{2}\\s*TZS/);
        if (phone && amt) out.push({ phone, amountTzs: Math.round(parseFloat(amt[1].replace(/,/g, ''))) });
      }
    });
    return out;
  })()`)) as ConfirmRow[];
  return rows;
}

/**
 * SAFETY CHECK: confirm the bank's confirmation page exactly matches the file
 * we uploaded — same number of rows, same {phone, amount} multiset. Throws on
 * any mismatch so we never confirm a batch that doesn't match our intent.
 */
export async function verifyConfirmation(page: Page, payments: Payment[]): Promise<void> {
  const scraped = await scrapeConfirmation(page);
  const key = (r: { phone: string; amountTzs: number }) => `${r.phone}@${r.amountTzs}`;
  const want = payments.map((p) => key({ phone: p.phone, amountTzs: p.amountTzs })).sort();
  const got = scraped.map(key).sort();

  log(`verification — expected ${want.length} rows, bank shows ${got.length}`);
  console.log("  expected:", want);
  console.log("  on bank :", got);

  if (want.length !== got.length || want.some((w, i) => w !== got[i])) {
    throw new Error(
      `CONFIRMATION MISMATCH — refusing to submit. Expected ${JSON.stringify(want)}, ` +
        `bank shows ${JSON.stringify(got)}`,
    );
  }
  await reportStep("✅ verification passed — bank matches our file exactly");
}

/**
 * Complete the confirmation: request the transaction TAN, read it from the
 * relay, enter it, and click Confirm. THIS MOVES MONEY. Only call after
 * verifyConfirmation passes and only when not in dry-run.
 */
export async function completeConfirmation(page: Page, onConfirmClick?: () => void): Promise<string> {
  const triggerTime = Date.now();
  await reportStep("requesting transaction TAN (SEND ME TAN)");
  await page.getByText(/send me tan/i).click();

  const code = await waitForFreshTan(triggerTime);
  await reportStep("got transaction TAN — entering it");
  // The OTP field (tokenPgId:insertTan) is disabled until SEND ME TAN is clicked;
  // fill() auto-waits for it to become editable.
  await page.locator('[id="tokenPgId:insertTan"]').fill(code);

  // ── POINT OF NO RETURN ── once Confirm is clicked, money may have moved.
  // Signal the caller BEFORE clicking so a later failure is treated as
  // "do not retry / needs manual review", never an auto-resend.
  onConfirmClick?.();
  await reportStep("clicking CONFIRM (money submitted)");
  await page.getByRole("button", { name: /^\s*confirm\s*$/i }).click();

  // Wait for the success notice.
  await page
    .getByText(/request has been submitted|batch is currently being processed/i)
    .waitFor({ timeout: 45_000 });
  const msg =
    (await page
      .getByText(/request has been submitted|batch is currently being processed/i)
      .first()
      .textContent()) ?? "submitted";
  await reportShot(page, "✅ batch submitted");
  return msg.trim();
}

/**
 * Watches for the "your session is about to be terminated" dialog and clicks
 * YES to extend the session. Returns a stop() to clear the watcher.
 */
export function startSessionKeepalive(page: Page): () => void {
  const timer = setInterval(() => {
    void (async () => {
      try {
        const dialog = page.getByText(/session.*(terminat|expir)|about to (be )?(terminat|expir)/i);
        if (await dialog.first().isVisible().catch(() => false)) {
          const yes = page.getByRole("button", { name: /^\s*yes\s*$/i });
          if (await yes.first().isVisible().catch(() => false)) {
            await yes.first().click();
            log("session keepalive → clicked YES (extended session)");
          }
        }
      } catch {
        /* ignore */
      }
    })();
  }, 5000);
  return () => clearInterval(timer);
}

function log(msg: string): void {
  console.log(`[bulk] ${msg}`);
}
