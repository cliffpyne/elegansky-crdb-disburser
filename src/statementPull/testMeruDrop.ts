/**
 * Frank 2026-06-08 SIMULATION — pretend it's 02:45 EAT (pre-meru0300 tick).
 *
 * Runs the EXACT meru cycle code paths for NMB + CRDB but DOES NOT upload
 * to the processor. Instead, the combined CSVs (NMB) and .xlsx files (CRDB)
 * land in ~/Downloads/ so Frank can inspect what the production scraper
 * would actually push at meru time.
 *
 *  Produces:
 *    ~/Downloads/meru-nmb-{yesterday}.csv     ← NMB phase 1 (yesterday) combined+sorted
 *    ~/Downloads/meru-nmb-{today}.csv         ← NMB phase 2 (today) combined+sorted
 *    ~/Downloads/meru-crdb-{yesterday}.xlsx   ← CRDB phase 1 (yesterday)
 *    ~/Downloads/meru-crdb-{today}.xlsx       ← CRDB phase 2 (today)
 *
 * Banks run sequentially (NMB first, then CRDB), each reuses one login
 * session across both phases.
 */
import { copyFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { nmbLogin } from "../portal/nmbLogin.js";
import { nmbDownloadStatement } from "../portal/nmbStatement.js";
import { sortNmbCsvByDateInPlace } from "./sortNmbCsv.js";
import { crdbLogin } from "../portal/crdbLogin.js";
import { crdbDownloadStatement, startCrdbSessionKeepalive, ymdToDdMmYyyy } from "../portal/crdbStatement.js";
import { xlsToXlsx } from "./xlsToXlsx.js";

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function nmbDrop(yesterday: string, today: string, downloadsDir: string) {
  const yTmp = `/tmp/meru_nmb_${yesterday}.csv`;
  const tTmp = `/tmp/meru_nmb_${today}.csv`;
  const yOut = join(downloadsDir, `meru-nmb-${yesterday}.csv`);
  const tOut = join(downloadsDir, `meru-nmb-${today}.csv`);

  // Each phase = its own login session (NMB UI quirk: reusing one session
  // between phases breaks the date-picker on phase 2).
  {
    const { browser, page, log } = await nmbLogin();
    try {
      log.step(`[SIM] NMB PHASE 1/2 — YESTERDAY ${yesterday}`);
      await nmbDownloadStatement(page, log, { dateFromYmd: yesterday, dateToYmd: yesterday, savePath: yTmp });
      log.step("sort yesterday by Value Date ↗");
      const ySort = sortNmbCsvByDateInPlace(yTmp);
      log.info(`yesterday: ${ySort.rowsSorted} rows sorted, ${ySort.rowsUnparsed} unparseable`);
      copyFileSync(yTmp, yOut);
      log.info(`✅ DROPPED ${yOut} (${statSync(yOut).size.toLocaleString()} bytes)`);
    } finally {
      if (browser.isConnected()) await browser.close().catch(() => {});
    }
  }

  {
    const { browser, page, log } = await nmbLogin();
    try {
      log.step(`[SIM] NMB PHASE 2/2 — TODAY ${today}`);
      await nmbDownloadStatement(page, log, { dateFromYmd: today, dateToYmd: today, savePath: tTmp });
      log.step("sort today by Value Date ↗");
      const tSort = sortNmbCsvByDateInPlace(tTmp);
      log.info(`today: ${tSort.rowsSorted} rows sorted, ${tSort.rowsUnparsed} unparseable`);
      copyFileSync(tTmp, tOut);
      log.info(`✅ DROPPED ${tOut} (${statSync(tOut).size.toLocaleString()} bytes)`);
      log.info("✅ NMB simulation complete — 2 files dropped (no processor upload)");
    } finally {
      if (browser.isConnected()) await browser.close().catch(() => {});
    }
  }
}

async function crdbDrop(yesterday: string, today: string, downloadsDir: string) {
  const yXls = `/tmp/meru_crdb_${yesterday}.xls`;
  const yXlsx = `/tmp/meru_crdb_${yesterday}.xlsx`;
  const tXls = `/tmp/meru_crdb_${today}.xls`;
  const tXlsx = `/tmp/meru_crdb_${today}.xlsx`;
  const yOut = join(downloadsDir, `meru-crdb-${yesterday}.xlsx`);
  const tOut = join(downloadsDir, `meru-crdb-${today}.xlsx`);

  const { browser, page, log } = await crdbLogin();
  const stopKeepalive = startCrdbSessionKeepalive(log, page);
  try {
    log.step(`[SIM] CRDB PHASE 1/2 — YESTERDAY ${yesterday}`);
    await crdbDownloadStatement(page, log, {
      dateFromDdMmYyyy: ymdToDdMmYyyy(yesterday),
      dateToDdMmYyyy: ymdToDdMmYyyy(yesterday),
      savePath: yXls,
    });
    xlsToXlsx(yXls, yXlsx);
    copyFileSync(yXlsx, yOut);
    log.info(`✅ DROPPED ${yOut} (${statSync(yOut).size.toLocaleString()} bytes)`);

    log.step(`[SIM] CRDB PHASE 2/2 — TODAY ${today}`);
    await crdbDownloadStatement(page, log, {
      dateFromDdMmYyyy: ymdToDdMmYyyy(today),
      dateToDdMmYyyy: ymdToDdMmYyyy(today),
      savePath: tXls,
    });
    xlsToXlsx(tXls, tXlsx);
    copyFileSync(tXlsx, tOut);
    log.info(`✅ DROPPED ${tOut} (${statSync(tOut).size.toLocaleString()} bytes)`);

    log.info("✅ CRDB simulation complete — 2 files dropped (no processor upload)");
  } finally {
    stopKeepalive();
    if (browser.isConnected()) await browser.close().catch(() => {});
  }
}

async function main() {
  const downloadsDir = join(homedir(), "Downloads");
  const today = ymd(new Date());
  const yesterday = ymd(new Date(Date.now() - 24 * 60 * 60 * 1000));
  console.log(`[meru-sim] today=${today}  yesterday=${yesterday}`);
  console.log(`[meru-sim] dropping to: ${downloadsDir}\n`);

  const bank = (process.env.BANK || "both").toLowerCase();
  if (bank === "nmb" || bank === "both") await nmbDrop(yesterday, today, downloadsDir);
  if (bank === "crdb" || bank === "both") await crdbDrop(yesterday, today, downloadsDir);

  console.log("\n>>> All meru files dropped — open ~/Downloads to inspect <<<");
}

main().catch((e) => { console.error(e); process.exit(1); });
