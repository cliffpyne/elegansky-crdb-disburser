import { nmbLogin } from "../portal/nmbLogin.js";
import { nmbDownloadStatement } from "../portal/nmbStatement.js";
import { sortNmbCsvByDateInPlace } from "./sortNmbCsv.js";
import { copyFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * LOCAL TEST: pull NMB statement, amount-split (with auto-halve on Big
 * Data Statement popup), combine + sort ascending, drop into ~/Downloads.
 * Does NOT upload to the processor.
 */
function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function main() {
  // Env overrides:
  //   DATE_YMD=YYYY-MM-DD          target day used to name the output file
  //   QUERY_FROM_YMD=YYYY-MM-DD    NMB Date From
  //   QUERY_TO_YMD=YYYY-MM-DD      NMB Date To
  // Defaults: target=yesterday, query window=same-day (target → target).
  const target = process.env.DATE_YMD || ymd(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const dateFromYmd = process.env.QUERY_FROM_YMD || target;
  const dateToYmd = process.env.QUERY_TO_YMD || target;
  const tmpPath = `/tmp/nmb_test_meru_${target}_query_${dateFromYmd}_to_${dateToYmd}.csv`;

  console.log(`[test] NMB query window: ${dateFromYmd} → ${dateToYmd}`);
  console.log(`[test] keeping ALL rows NMB returns (no Value-Date filter)`);
  console.log(`[test] tmp savePath: ${tmpPath}`);

  const { browser, page, log } = await nmbLogin();
  try {
    await nmbDownloadStatement(page, log, { dateFromYmd, dateToYmd, savePath: tmpPath });
    log.step("sort CSV ascending by Value Date");
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
