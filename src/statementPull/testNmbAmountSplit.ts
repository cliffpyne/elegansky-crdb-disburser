import { nmbLogin } from "../portal/nmbLogin.js";
import { nmbDownloadStatement } from "../portal/nmbStatement.js";
import { sortNmbCsvByDateInPlace } from "./sortNmbCsv.js";
import { copyFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Convert "YYYY-MM-DD" → "DD Mon YYYY" matching NMB's Value Date column.
 *  NMB keeps the leading zero on day-of-month (e.g. "06 Jun 2026"). */
function ymdToDdMmmYyyy(ymd: string): string {
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [y, m, d] = ymd.split("-");
  const mi = Math.max(0, Math.min(11, parseInt(m ?? "0", 10) - 1));
  return `${(d ?? "00").padStart(2, "0")} ${MONTHS[mi]} ${y}`;
}

/** Filter a sorted NMB CSV in place: keep only rows whose Value Date matches. */
function filterValueDateInPlace(filePath: string, targetValueDate: string): { kept: number; dropped: number } {
  const raw = readFileSync(filePath, "utf8");
  const lineSep = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  const trailing = lines.length > 0 && lines[lines.length - 1] === "" ? lineSep : "";
  if (lines.length <= 4) return { kept: 0, dropped: 0 };
  const headerBlock = lines.slice(0, 4);
  let kept = 0, dropped = 0;
  const filtered: string[] = [];
  for (let i = 4; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.trim() === "") continue;
    // First column = Value Date. Cheap startsWith check on the date string.
    if (line.startsWith(targetValueDate + ",") || line.startsWith(`"${targetValueDate}",`)) {
      filtered.push(line);
      kept++;
    } else {
      dropped++;
    }
  }
  writeFileSync(filePath, [...headerBlock, ...filtered].join(lineSep) + trailing);
  return { kept, dropped };
}

/**
 * Frank 2026-06-07 LOCAL TEST: pull NMB yesterday → today using the new
 * amount-range split (1..12k + 12,001..10M), combine + sort ascending,
 * then DROP THE FILE INTO ~/Downloads so Frank can inspect.
 *
 * Does NOT upload to the processor (no sync).
 */
function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function main() {
  // Meru-style "Upload 1" pattern (Frank 2026-06-08): query yesterday →
  // today so NMB returns BOTH posted-on-yesterday + posted-on-today rows,
  // then filter to ONLY keep rows whose Value Date is yesterday. This
  // catches late-evening yesterday transactions that posted on today
  // (NMB filters by POSTED date, not Value Date — confirmed on 06-Jun
  // where 274 rows from 19:38-23:54 were absent from a single-day query
  // but present in the next-day window).
  //
  // Override via env:
  //   DATE_YMD=YYYY-MM-DD          target day (the Value Date we keep)
  //   QUERY_FROM_YMD=YYYY-MM-DD    NMB filter Date From
  //   QUERY_TO_YMD=YYYY-MM-DD      NMB filter Date To
  // Defaults: target=yesterday, query window=target → target+1
  const target = process.env.DATE_YMD || ymd(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const targetDate = new Date(target + "T00:00:00Z");
  const dateFromYmd = process.env.QUERY_FROM_YMD || target;
  const dateToYmd = process.env.QUERY_TO_YMD || ymd(new Date(targetDate.getTime() + 24 * 60 * 60 * 1000));
  const tmpPath = `/tmp/nmb_test_meru_${target}_query_${dateFromYmd}_to_${dateToYmd}.csv`;

  const targetValueDate = ymdToDdMmmYyyy(target);
  console.log(`[test] NMB query window: ${dateFromYmd} → ${dateToYmd}`);
  console.log(`[test] target Value Date (keep only this): ${target} → "${targetValueDate}"`);
  console.log(`[test] tmp savePath: ${tmpPath}`);

  const { browser, page, log } = await nmbLogin();
  try {
    await nmbDownloadStatement(page, log, { dateFromYmd, dateToYmd, savePath: tmpPath });
    log.step(`filter Value Date = ${targetValueDate} (drop other-day late posts)`);
    const f = filterValueDateInPlace(tmpPath, targetValueDate);
    log.info(`✅ filter kept ${f.kept}, dropped ${f.dropped}`);
    log.step("sort filtered CSV ascending by Value Date");
    const r = sortNmbCsvByDateInPlace(tmpPath);
    log.detail(`sorted ${r.rowsSorted} rows, ${r.rowsUnparsed} unparseable`);

    const downloadsDir = join(homedir(), "Downloads");
    const outName = `nmb-test-merged-${target}.csv`;
    const outPath = join(downloadsDir, outName);
    copyFileSync(tmpPath, outPath);
    const sz = statSync(outPath).size;
    log.info(`✅ DROPPED MERGED CSV → ${outPath} (${sz.toLocaleString()} bytes)`);
    console.log(`\n>>> open the file: ${outPath} <<<\n`);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
