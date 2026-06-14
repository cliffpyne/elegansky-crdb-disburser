import { nmbLogin } from "../portal/nmbLogin.js";
import { nmbDownloadStatement } from "../portal/nmbStatement.js";
import { sortNmbCsvByDateInPlace } from "./sortNmbCsv.js";
import { copyFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * LOCAL gap-fill smoke test (Frank 2026-06-14 — per-day login pattern):
 *   1. Take LAST_PASSED_DATE from env (BRAIN endpoint returns it in prod).
 *   2. Enumerate gap days [LAST_PASSED_DATE .. today] inclusive.
 *   3. For each gap day: FRESH login + download + sort + drop to ~/Downloads.
 *      One OTP per day. Frank's call: accept the time cost for reliability —
 *      single-session multi-day kept tripping on the welcome-modal that
 *      only fires on first navigation post-login.
 */

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function enumerateYmd(fromYmd: string, toYmd: string): string[] {
  const out: string[] = [];
  const from = new Date(fromYmd + "T00:00:00Z");
  const to = new Date(toYmd + "T00:00:00Z");
  for (let i = 0; i <= 31; i++) {
    const d = new Date(from.getTime() + i * 24 * 60 * 60 * 1000);
    out.push(ymd(d));
    if (d.getTime() >= to.getTime()) break;
  }
  return out;
}

async function pullOneDay(day: string, idx: number, total: number): Promise<void> {
  console.log(`\n>>>>>>>> DAY ${day} (${idx}/${total}) — fresh login >>>>>>>>`);
  const { browser, page, log } = await nmbLogin();
  try {
    const tmpPath = `/tmp/nmb_gapfill_${day}.csv`;
    await nmbDownloadStatement(page, log, { dateFromYmd: day, dateToYmd: day, savePath: tmpPath });
    log.step(`sort ${day} CSV ascending`);
    const r = sortNmbCsvByDateInPlace(tmpPath);
    log.detail(`sorted ${r.rowsSorted} rows, ${r.rowsUnparsed} unparseable`);
    const outPath = join(homedir(), "Downloads", `nmb-gapfill-${day}.csv`);
    copyFileSync(tmpPath, outPath);
    log.info(`✅ ${day} dropped → ${outPath} (${statSync(outPath).size.toLocaleString()} bytes)`);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  const lastPassed = process.env.LAST_PASSED_DATE;
  if (!lastPassed || !/^\d{4}-\d{2}-\d{2}$/.test(lastPassed)) {
    console.error(`[test] LAST_PASSED_DATE env var required (YYYY-MM-DD)`);
    process.exit(1);
  }
  const today = process.env.TODAY_OVERRIDE || ymd(new Date());
  const gap = enumerateYmd(lastPassed, today);
  console.log(`[test] last_passed=${lastPassed}, today=${today}`);
  console.log(`[test] gap days (${gap.length}): ${gap.join(", ")}`);

  for (let i = 0; i < gap.length; i++) {
    await pullOneDay(gap[i]!, i + 1, gap.length);
  }
  console.log(`\n>>> ${gap.length} file(s) in ~/Downloads/nmb-gapfill-*.csv <<<\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
