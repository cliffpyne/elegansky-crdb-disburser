import { crdbLogin } from "../portal/crdbLogin.js";
import {
  crdbDownloadStatement,
  startCrdbSessionKeepalive,
  ymdToDdMmYyyy,
} from "../portal/crdbStatement.js";
import { copyFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * LOCAL CRDB gap-fill smoke test (Frank 2026-06-14 — per-day login pattern):
 *   1. Take LAST_PASSED_DATE from env (BRAIN endpoint returns it in prod).
 *   2. Enumerate gap days [LAST_PASSED_DATE .. today] inclusive.
 *   3. For each gap day: FRESH login + full-day download (no amount split)
 *      + drop .xls to ~/Downloads.
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
  console.log(`\n>>>>>>>> CRDB DAY ${day} (${idx}/${total}) — fresh login >>>>>>>>`);
  const { browser, page, log } = await crdbLogin();
  const stopKeepalive = startCrdbSessionKeepalive(log, page);
  try {
    const tmpXls = `/tmp/crdb_gapfill_${day}.xls`;
    const ddmmyyyy = ymdToDdMmYyyy(day);
    await crdbDownloadStatement(page, log, {
      dateFromDdMmYyyy: ddmmyyyy,
      dateToDdMmYyyy: ddmmyyyy,
      savePath: tmpXls,
    });
    const outPath = join(homedir(), "Downloads", `crdb-gapfill-${day}.xls`);
    copyFileSync(tmpXls, outPath);
    log.info(`✅ ${day} dropped → ${outPath} (${statSync(outPath).size.toLocaleString()} bytes)`);
  } finally {
    stopKeepalive();
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
  console.log(`[test] CRDB gap days (${gap.length}): ${gap.join(", ")}`);

  for (let i = 0; i < gap.length; i++) {
    await pullOneDay(gap[i]!, i + 1, gap.length);
  }
  console.log(`\n>>> ${gap.length} file(s) in ~/Downloads/crdb-gapfill-*.xls <<<\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
