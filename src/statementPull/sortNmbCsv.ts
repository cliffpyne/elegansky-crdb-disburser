import { readFileSync, writeFileSync } from "node:fs";

/**
 * Sort an NMB statement CSV's data rows by Value Date ascending — in place.
 *
 * NMB exports rows newest-first. Sheets are append-only ascending, so the
 * processor's appends look "out of order" in the sheet unless we flip the
 * CSV first. (Earlier attempt commit 9065904 just blindly reversed rows
 * 1..end — that broke pandas because NMB CSVs have 3 metadata rows BEFORE
 * the header at row 3.)
 *
 * NMB CSV shape (confirmed against /home/clifforddennis/Downloads/bankkk.csv):
 *
 *   row 0: account_number,name                           (metadata)
 *   row 1: Opening Balance,TZS amount                    (metadata)
 *   row 2: Closing Balance,TZS amount                    (metadata)
 *   row 3: Value Date,Narration/Description,...          (HEADER)
 *   row 4+: data rows, newest-first
 *
 * We preserve rows 0..3 exactly. We sort rows 4..end by parsed "Value Date"
 * ascending. Unparseable dates go to the END (so they don't pollute
 * chronology of valid rows). We re-emit using \r\n line endings to match
 * NMB's original encoding.
 *
 * Returns { rowsSorted, rowsUnparsed } so the caller can log.
 */
export function sortNmbCsvByDateInPlace(filePath: string): {
  rowsSorted: number;
  rowsUnparsed: number;
} {
  const raw = readFileSync(filePath, "utf8");
  if (!raw) return { rowsSorted: 0, rowsUnparsed: 0 };

  // Detect line ending — NMB uses CRLF, preserve it.
  const lineSep = raw.includes("\r\n") ? "\r\n" : "\n";
  // Trailing newline preservation.
  const hadTrailing = raw.endsWith(lineSep);
  const lines = raw.split(/\r?\n/);
  if (hadTrailing && lines[lines.length - 1] === "") lines.pop();

  if (lines.length <= 4) return { rowsSorted: 0, rowsUnparsed: 0 };

  // Rows 0..3 = metadata + header (preserved exactly as bytes).
  const headerBlock = lines.slice(0, 4);
  const dataLines = lines.slice(4);

  // NMB date format in the Value Date column: "DD Mon YYYY". The column is
  // date-only — same-day rows need the TIME extracted from the description
  // (column 2) to get a stable chronological order. Otherwise hundreds of
  // 31-May rows all tie and the sort decays to original (newest-first) order.
  const MONTHS: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  // Parse a CSV line into cells, handling quoted fields with embedded commas.
  function parseCells(line: string): string[] {
    const out: string[] = [];
    let cur = "";
    let inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === "," && !inQ) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  }
  function parseValueDate(s: string): number | null {
    const m = s.trim().match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
    if (!m) return null;
    const mo = MONTHS[m[2]!.slice(0, 3).toLowerCase()];
    if (mo == null) return null;
    return Date.UTC(+m[3]!, mo, +m[1]!);
  }
  // Pull time-of-day (and verify date) from the description. Two NMB formats:
  //   Agency banking - DDMM HH MM SS agency
  //   on DD.MM.YYYY HH MM SS!!
  //   Funds Transfer - DD MM HH MM SS FUND-TRANSFER
  function extractTimestamp(desc: string, fallbackYear: number): number | null {
    let m = desc.match(/Agency banking\s*-\s*(\d{2})(\d{2})\s+(\d{2})\s+(\d{2})\s+(\d{2})\s+agency/);
    if (m) {
      const [d, mo, hh, mi, ss] = [+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        return Date.UTC(fallbackYear, mo - 1, d, hh, mi, ss);
      }
    }
    m = desc.match(/\bon (\d{2})\.(\d{2})\.(\d{4})\s+(\d{2})\s+(\d{2})\s+(\d{2})\b/);
    if (m) {
      const [d, mo, y, hh, mi, ss] = [+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +m[6]!];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        return Date.UTC(y, mo - 1, d, hh, mi, ss);
      }
    }
    m = desc.match(/Funds Transfer\s*-\s*(\d{2})\s+(\d{2})\s+(\d{2})\s+(\d{2})\s+(\d{2})\s+FUND-TRANSFER/);
    if (m) {
      const [d, mo, hh, mi, ss] = [+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        return Date.UTC(fallbackYear, mo - 1, d, hh, mi, ss);
      }
    }
    return null;
  }

  let unparsedCount = 0;
  const enriched = dataLines.map((line, idx) => {
    const cells = parseCells(line);
    const dateOnly = parseValueDate(cells[0] ?? "");
    const fallbackYear = dateOnly == null ? new Date().getUTCFullYear() : new Date(dateOnly).getUTCFullYear();
    // Prefer the full timestamp from the description; fall back to the
    // date-only from Value Date if the description doesn't match any known
    // pattern; if both fail, null → goes to end of sort.
    const ts = extractTimestamp(cells[1] ?? "", fallbackYear) ?? dateOnly;
    if (ts == null) unparsedCount++;
    return { line, ts, idx };
  });

  // Sort ascending; unparseable rows pushed to the end with their original
  // relative order preserved.
  enriched.sort((a, b) => {
    if (a.ts == null && b.ts == null) return a.idx - b.idx;
    if (a.ts == null) return 1;
    if (b.ts == null) return -1;
    const at = a.ts as number;
    const bt = b.ts as number;
    if (at !== bt) return at - bt;
    return a.idx - b.idx;
  });

  const out = [
    ...headerBlock,
    ...enriched.map((e) => e.line),
  ].join(lineSep) + (hadTrailing ? lineSep : "");

  writeFileSync(filePath, out, "utf8");
  return { rowsSorted: dataLines.length, rowsUnparsed: unparsedCount };
}
