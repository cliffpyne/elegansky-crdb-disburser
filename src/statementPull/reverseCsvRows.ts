import { readFileSync, writeFileSync } from "node:fs";

/**
 * Reverse the data rows of a CSV file in place, preserving the header (row 0).
 *
 * Why: NMB's web "Download → CSV" emits rows newest-first (latest at top),
 * but the destination sheet is append-only ascending by time, and the
 * processor appends rows in CSV order. Without this reversal the sheet's
 * chronological ordering breaks every NMB upload.
 *
 * Safe-no-op cases:
 *   - empty file → no-op
 *   - one line (header only, no data) → no-op
 *   - trailing empty line → preserved
 */
export function reverseCsvDataRowsInPlace(filePath: string): {
  rowsReversed: number;
} {
  const raw = readFileSync(filePath, "utf8");
  if (!raw) return { rowsReversed: 0 };

  // Preserve the trailing newline pattern so the file stays well-formed.
  const hadTrailingNewline = raw.endsWith("\n");
  const lines = raw.split(/\r?\n/);
  // If split yielded a trailing empty element from a final newline, drop it
  // while remembering to put one back.
  if (hadTrailingNewline && lines[lines.length - 1] === "") lines.pop();

  if (lines.length <= 2) return { rowsReversed: 0 };

  const header = lines[0];
  const data = lines.slice(1).reverse();
  const out = [header, ...data].join("\n") + (hadTrailingNewline ? "\n" : "");
  writeFileSync(filePath, out, "utf8");
  return { rowsReversed: data.length };
}
