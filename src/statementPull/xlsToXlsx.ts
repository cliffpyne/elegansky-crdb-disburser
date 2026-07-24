import * as XLSX from "xlsx";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * The transaction-processor reads CRDB statements with the column-header row
 * ("Posting Date | Details | ...") at this fixed index. Account 1's export
 * naturally lands there; other accounts' preamble blocks differ in height
 * (2026-07-24: account 2's 3-line company address pushed the header to row
 * 14 and the processor 400'd with "Missing required columns ... [nan, nan]"),
 * so we pin the header back to the expected row before upload.
 */
const EXPECTED_HEADER_ROW = 13;

/**
 * CRDB's "Export → Excel File" produces a legacy .xls (BIFF) file. The
 * transaction-processor only sniffs .xlsx (OOXML ZIP). Re-emit the workbook
 * in OOXML so the processor recognises it — same rows, just a different
 * container format — normalising the header position on the way (no-op for
 * exports that already match).
 */
export function xlsToXlsx(srcPath: string, destPath: string): string {
  const buf = readFileSync(srcPath);
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheetName = wb.SheetNames[0];
  const sheet = sheetName ? wb.Sheets[sheetName] : undefined;
  if (!sheetName || !sheet) throw new Error(`no sheets in ${srcPath}`);
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];

  const headerIdx = rows.findIndex((r) => String((r as unknown[])?.[0] ?? "").trim() === "Posting Date");
  if (headerIdx >= 0 && headerIdx !== EXPECTED_HEADER_ROW) {
    if (headerIdx > EXPECTED_HEADER_ROW) {
      // Too much preamble — trim title rows off the top until the header
      // sits where the processor looks for it.
      rows.splice(0, headerIdx - EXPECTED_HEADER_ROW);
    } else {
      // Too little preamble — pad blank rows on top.
      rows.unshift(...Array.from({ length: EXPECTED_HEADER_ROW - headerIdx }, () => [] as unknown[]));
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wb.Sheets[sheetName] = XLSX.utils.aoa_to_sheet(rows as any[][]);
  }

  const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  writeFileSync(destPath, out as Buffer);
  return destPath;
}
