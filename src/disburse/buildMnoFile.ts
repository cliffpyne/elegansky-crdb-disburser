import { writeFileSync } from "node:fs";

/** One disbursement row. Amount is whole TZS. */
export interface Payment {
  /** "B2C" (mobile money to person) or "AIRTIME" */
  transactionType: "B2C" | "AIRTIME";
  amountTzs: number;
  phone: string;
  beneficiaryName: string;
  description: string;
}

/**
 * Build the CRDB MNO bulk-payment file (comma-separated), matching the bank's
 * MNOSampleBulkPayment.txt format:
 *
 *   ID,Transaction Type,Amount,Phone number,Beneficiary Name,Description
 *   1,B2C,1000,0752900450,CLIFORD DENIS MASUI,Loan disbursement
 *
 * The header row IS included (the sample file has it). IDs are 1-based.
 */
export function buildMnoCsv(payments: Payment[]): string {
  const header = "ID,Transaction Type,Amount,Phone number,Beneficiary Name,Description";
  const rows = payments.map((p, i) =>
    [i + 1, p.transactionType, p.amountTzs, p.phone, p.beneficiaryName, p.description].join(","),
  );
  return [header, ...rows].join("\n") + "\n";
}

/** Build and write the file to disk; returns the path. */
export function writeMnoFile(path: string, payments: Payment[]): string {
  writeFileSync(path, buildMnoCsv(payments), "utf8");
  return path;
}
