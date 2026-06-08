import { crdbLogin } from "../portal/crdbLogin.js";
import { crdbDownloadStatement, startCrdbSessionKeepalive, ymdToDdMmYyyy } from "../portal/crdbStatement.js";
import { xlsToXlsx } from "./xlsToXlsx.js";
import { uploadStatement } from "./uploadToProcessor.js";

/**
 * CRDB meru0300 cycle (Frank 2026-06-08 spec):
 *   - Two distinct sync phases per fire (yesterday-only, today-only)
 *   - CRDB has no amount-split (no Big Data popup) — one download per phase
 *   - 2 raw .xls files → 2 .xlsx converts → 2 separate uploads
 *   - Upload yesterday FIRST so sheet appends preserve chronological order
 *   - One login session reused (saves session-expiry churn)
 *
 * Why two days: catches late iPhone-bank entries that operator records on the
 * date AFTER the actual transaction, plus any genuine bank tail not seen by
 * yesterday's last regular tick.
 *
 * NOT for normal ticks (hanang0700, kili1615, etc.) — those still use
 * runCrdbCycle.ts which queries today-only.
 */
export async function runCrdbMeruCycle(): Promise<{
  yesterday: unknown;
  today: unknown;
}> {
  const today = ymd(new Date());
  const yesterday = ymd(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const yXls = `/tmp/crdb_statement_meru_${yesterday}.xls`;
  const yXlsx = `/tmp/crdb_statement_meru_${yesterday}.xlsx`;
  const tXls = `/tmp/crdb_statement_meru_${today}.xls`;
  const tXlsx = `/tmp/crdb_statement_meru_${today}.xlsx`;

  const { browser, page, log } = await crdbLogin();
  const stopKeepalive = startCrdbSessionKeepalive(log, page);
  try {
    // ── PHASE 1: YESTERDAY ────────────────────────────────────────────────
    log.step(`MERU PHASE 1/2 — scrape YESTERDAY ${yesterday}`);
    await crdbDownloadStatement(page, log, {
      dateFromDdMmYyyy: ymdToDdMmYyyy(yesterday),
      dateToDdMmYyyy: ymdToDdMmYyyy(yesterday),
      savePath: yXls,
    });
    log.step("convert yesterday .xls → .xlsx");
    xlsToXlsx(yXls, yXlsx);
    log.step("upload YESTERDAY statement to processor");
    const yResult = await uploadStatement(yXlsx, "CRDB");
    log.info("yesterday processor response", { result: yResult });

    // ── PHASE 2: TODAY ────────────────────────────────────────────────────
    log.step(`MERU PHASE 2/2 — scrape TODAY ${today}`);
    await crdbDownloadStatement(page, log, {
      dateFromDdMmYyyy: ymdToDdMmYyyy(today),
      dateToDdMmYyyy: ymdToDdMmYyyy(today),
      savePath: tXls,
    });
    log.step("convert today .xls → .xlsx");
    xlsToXlsx(tXls, tXlsx);
    log.step("upload TODAY statement to processor");
    const tResult = await uploadStatement(tXlsx, "CRDB");
    log.info("today processor response", { result: tResult });

    log.info("✅ CRDB meru cycle complete — 2 syncs done (yesterday + today)");
    return { yesterday: yResult, today: tResult };
  } finally {
    stopKeepalive();
    if (browser.isConnected()) {
      log.info("closing browser");
      await browser.close().catch(() => {});
    }
  }
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
