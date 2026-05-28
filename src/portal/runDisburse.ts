import { writeFileSync } from "node:fs";
import { loginToPortal } from "./login.js";
import {
  navigateToBulkPayment,
  fillBulkPaymentForm,
  submitToConfirm,
  verifyConfirmation,
  startSessionKeepalive,
} from "./bulkPayment.js";
import { writeMnoFile, type Payment } from "../disburse/buildMnoFile.js";
import { config } from "../config.js";

const CSV_PATH = "/home/clifforddennis/Downloads/disbursement_test.txt";

// Test batch: 3 × 1000 TZS to 0752900450 (CLIFORD DENIS MASUI), per your instruction.
const TEST_PAYMENTS: Payment[] = [
  { transactionType: "B2C", amountTzs: 1000, phone: "0752900450", beneficiaryName: "CLIFORD DENIS MASUI", description: "Loan disbursement 1" },
  { transactionType: "B2C", amountTzs: 1000, phone: "0752900450", beneficiaryName: "CLIFORD DENIS MASUI", description: "Loan disbursement 2" },
  { transactionType: "B2C", amountTzs: 1000, phone: "0752900450", beneficiaryName: "CLIFORD DENIS MASUI", description: "Loan disbursement 3" },
];

async function main(): Promise<void> {
  // Safety: enforce caps.
  const total = TEST_PAYMENTS.reduce((s, p) => s + p.amountTzs, 0);
  if (TEST_PAYMENTS.length > config.DISBURSE_MAX_RECIPIENTS) throw new Error("too many recipients");
  if (total > config.DISBURSE_MAX_TOTAL_TZS) throw new Error(`total ${total} exceeds cap`);

  writeMnoFile(CSV_PATH, TEST_PAYMENTS);
  console.log(`[disburse] wrote ${TEST_PAYMENTS.length} rows (${total} TZS) → ${CSV_PATH}`);

  const { browser, page } = await loginToPortal();
  const stopKeepalive = startSessionKeepalive(page); // auto-clicks YES on session-timeout dialog
  try {
    await navigateToBulkPayment(page);
    console.log("[disburse] on bulk payment page:", page.url());

    await fillBulkPaymentForm(page, CSV_PATH);

    // Reaching the confirmation page does NOT move money — money only moves
    // after the transaction TAN is entered and Confirm is clicked.
    await submitToConfirm(page);

    // Capture the confirmation page for inspection.
    await page.screenshot({ path: "/tmp/crdb_confirm.png" });
    writeFileSync("/tmp/crdb_confirm.html", await page.content(), "utf8");
    console.log("[disburse] saved confirmation screenshot + HTML");

    // SAFETY: verify the bank's confirmation matches our file exactly.
    await verifyConfirmation(page, TEST_PAYMENTS);

    // This script is a verification-only harness. It STOPS before the money TAN
    // so it never moves money. Real disbursement runs through the worker
    // (runWorker → runCycle), which is gated by DISBURSE_PAUSED.
    console.log("[disburse] verified — stopping before money TAN. No money moved. ✅");
  } finally {
    stopKeepalive();
    await browser.close();
  }
  console.log("[disburse] done");
}

main().catch((err) => {
  console.error("[disburse] FAILED:", err.message);
  process.exit(1);
});
