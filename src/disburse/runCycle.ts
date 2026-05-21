import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { writeMnoFile, type Payment } from "./buildMnoFile.js";
import {
  claimPending,
  releaseClaims,
  markCompleted,
  tryAcquireBankLock,
  releaseBankLock,
  logBatch,
  logDisbursements,
  type ClaimedRow,
} from "./queue.js";
import { loginToPortal } from "../portal/login.js";
import {
  navigateToBulkPayment,
  fillBulkPaymentForm,
  submitToConfirm,
  verifyConfirmation,
  completeConfirmation,
  scrapeBatchNumber,
  startSessionKeepalive,
} from "../portal/bulkPayment.js";
import { reportStep } from "../worker/status.js";

const CSV_PATH = "/tmp/crdb_disbursement_batch.txt";

function toPayments(rows: ClaimedRow[]): Payment[] {
  return rows.map((r) => ({
    transactionType: "B2C",
    amountTzs: r.amountTzs,
    phone: r.phone,
    beneficiaryName: r.name,
    description: `Loan ${r.loanId ?? ""}`.trim(),
  }));
}

/**
 * One disbursement cycle:
 *   acquire bank lock → claim pending → build CSV → login → fill → submit →
 *   VERIFY → (dry-run? release : confirm + mark completed + log) → release lock.
 * Any failure releases the claims back to 'pending' so they retry next cycle.
 */
export async function runCycle(): Promise<void> {
  const client = await pool.connect();
  let claimed: ClaimedRow[] = [];
  let lockHeld = false;
  let confirmClicked = false; // becomes true the instant the money Confirm is clicked
  try {
    lockHeld = await tryAcquireBankLock(client);
    if (!lockHeld) {
      await reportStep("another worker holds the bank lock — skipping this tick");
      return;
    }

    claimed = await claimPending(client, config.DISBURSE_BATCH_SIZE);
    if (claimed.length === 0) {
      await reportStep("nothing pending — idle");
      return;
    }
    const total = claimed.reduce((s, r) => s + r.amountTzs, 0);
    await reportStep(`claimed ${claimed.length} people, total ${total} TZS`);

    // Safety caps.
    if (claimed.length > config.DISBURSE_MAX_RECIPIENTS || total > config.DISBURSE_MAX_TOTAL_TZS) {
      await releaseClaims(client, claimed.map((c) => c.id));
      throw new Error(`caps exceeded (count ${claimed.length}, total ${total}) — released claims`);
    }

    const payments = toPayments(claimed);
    writeMnoFile(CSV_PATH, payments);

    const { browser, page } = await loginToPortal();
    const stopKeepalive = startSessionKeepalive(page);
    try {
      await reportStep("navigating to Bulk Payments");
      await navigateToBulkPayment(page);
      await reportStep("filling form + uploading CSV");
      await fillBulkPaymentForm(page, CSV_PATH);
      await reportStep("submitting → confirmation page");
      await submitToConfirm(page);
      await reportStep("verifying bank rows match our file");
      await verifyConfirmation(page, payments); // throws on any mismatch
      const bankBatch = await scrapeBatchNumber(page);

      if (config.DISBURSE_DRY_RUN) {
        await releaseClaims(client, claimed.map((c) => c.id));
        console.log(`[cycle] DRY_RUN — verified (bank batch ${bankBatch}), released claims, NO money moved ✅`);
        return;
      }

      const result = await completeConfirmation(page, () => {
        confirmClicked = true;
      });
      await markCompleted(client, claimed.map((c) => c.id));
      const batchId = await logBatch(client, {
        bankBatchNumber: bankBatch,
        count: claimed.length,
        total,
        status: "submitted",
        message: result,
      });
      await logDisbursements(client, batchId, claimed, "submitted");
      console.log(`[cycle] ✅ submitted ${claimed.length} payments (bank batch ${bankBatch}), logged`);
    } finally {
      stopKeepalive();
      await browser.close();
    }
  } catch (err) {
    const total = claimed.reduce((s, r) => s + r.amountTzs, 0);
    if (claimed.length && !confirmClicked) {
      // Failed BEFORE the money was submitted → safe to release for retry next cycle.
      await releaseClaims(client, claimed.map((c) => c.id)).catch(() => {});
      await logBatch(client, {
        bankBatchNumber: null, count: claimed.length, total,
        status: "failed", message: (err as Error).message,
      }).catch(() => {});
      await reportStep(`❌ failed before submit — released ${claimed.length} claims for retry: ${(err as Error).message}`);
    } else if (claimed.length && confirmClicked) {
      // Failed AFTER clicking Confirm → money MAY have been sent. DO NOT release
      // or auto-retry. Leave rows 'processing' (claimed) for manual review.
      await logBatch(client, {
        bankBatchNumber: null, count: claimed.length, total,
        status: "needs_review", message: "Confirm was clicked but post-confirm step failed: " + (err as Error).message,
      }).catch(() => {});
      await reportStep(`⚠️ NEEDS REVIEW — Confirm was clicked, money may have moved. ${claimed.length} rows left as 'processing'. Manual check required.`);
    }
    throw err;
  } finally {
    if (lockHeld) await releaseBankLock(client).catch(() => {});
    client.release();
  }
}
