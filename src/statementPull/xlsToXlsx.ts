import * as XLSX from "xlsx";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * CRDB's "Export → Excel File" produces a legacy .xls (BIFF) file. The
 * transaction-processor only sniffs .xlsx (OOXML ZIP). Re-emit the workbook
 * in OOXML so the processor recognises it — same rows, just a different
 * container format.
 */
export function xlsToXlsx(srcPath: string, destPath: string): string {
  const buf = readFileSync(srcPath);
  const wb = XLSX.read(buf, { type: "buffer" });
  const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  writeFileSync(destPath, out as Buffer);
  return destPath;
}
