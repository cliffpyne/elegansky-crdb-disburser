import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { config } from "../config.js";

/**
 * POST a downloaded statement file to the transaction-processor's /upload
 * endpoint, then trigger /process. Mimics what a human operator does in the
 * browser today, so server-side semantics are identical.
 *
 * Returns the processor's JSON response from /process.
 */
export async function uploadStatement(filePath: string, bankType: "NMB" | "CRDB"): Promise<unknown> {
  const fileSize = statSync(filePath).size;
  if (fileSize === 0) throw new Error(`Statement file is empty: ${filePath}`);
  const fileName = basename(filePath);
  const fileBytes = readFileSync(filePath);

  // ── Step 1: POST /upload with multipart form-data ─────────────────────
  const form = new FormData();
  form.append("file", new Blob([fileBytes]), fileName);
  form.append("bank_type", bankType);

  const uploadUrl = `${config.TRANSACTION_PROCESSOR_URL}/upload`;
  const uploadRes = await fetch(uploadUrl, { method: "POST", body: form });
  if (!uploadRes.ok) {
    throw new Error(`upload ${uploadUrl} → ${uploadRes.status}: ${await uploadRes.text()}`);
  }
  console.log(`[uploadToProcessor] ${bankType} upload OK (${fileSize} bytes)`);

  // ── Step 2: POST /process to actually run the pipeline ────────────────
  const processUrl = `${config.TRANSACTION_PROCESSOR_URL}/process`;
  const processRes = await fetch(processUrl, { method: "POST" });
  if (!processRes.ok) {
    throw new Error(`process ${processUrl} → ${processRes.status}: ${await processRes.text()}`);
  }
  const body = await processRes.json();
  console.log(`[uploadToProcessor] ${bankType} processed:`, body);
  return body;
}
