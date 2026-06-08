import { nmbLogin } from "../portal/nmbLogin.js";
import { nmbDownloadStatement } from "../portal/nmbStatement.js";
import { uploadStatement } from "./uploadToProcessor.js";
import { sortNmbCsvByDateInPlace } from "./sortNmbCsv.js";

/**
 * NMB meru0300 cycle (Frank 2026-06-08 spec):
 *   - Two distinct sync phases per fire (yesterday-only, today-only)
 *   - Each phase internally does TWO amount-pass downloads (1..12k +
 *     12,001..10M) which nmbDownloadStatement combines + dedupes by Ref-No
 *   - 4 raw downloads → 2 combined CSVs → 2 separate uploads to processor
 *   - Upload yesterday FIRST so sheet appends preserve chronological order
 *   - One login session reused (saves OTP cost)
 *
 * Why two days: late-evening yesterday transactions POST on today (NMB filters
 * by POSTED date) → querying today catches them; querying yesterday catches
 * the on-time ones. Both ensure no row is lost in the boundary.
 *
 * NOT for normal ticks (hanang0700, kili1615, etc.) — those still use
 * runNmbCycle.ts which queries today-only.
 */
export async function runNmbMeruCycle(): Promise<{
  yesterday: { rowsSorted: number; uploadResult: unknown };
  today: { rowsSorted: number; uploadResult: unknown };
}> {
  const today = ymd(new Date());
  const yesterday = ymd(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const yPath = `/tmp/nmb_statement_meru_${yesterday}.csv`;
  const tPath = `/tmp/nmb_statement_meru_${today}.csv`;

  const { browser, page, log } = await nmbLogin();
  try {
    // ── PHASE 1: YESTERDAY ────────────────────────────────────────────────
    log.step(`MERU PHASE 1/2 — scrape YESTERDAY ${yesterday}`);
    await nmbDownloadStatement(page, log, {
      dateFromYmd: yesterday,
      dateToYmd: yesterday,
      savePath: yPath,
    });
    log.step("sort yesterday CSV ascending by Value Date");
    const ySort = sortNmbCsvByDateInPlace(yPath);
    log.detail(`yesterday sorted ${ySort.rowsSorted} rows, ${ySort.rowsUnparsed} unparseable`);

    log.step("upload YESTERDAY statement to processor");
    const yResult = await uploadStatement(yPath, "NMB");
    log.info("yesterday processor response", { result: yResult });

    // ── PHASE 2: TODAY ────────────────────────────────────────────────────
    log.step(`MERU PHASE 2/2 — scrape TODAY ${today}`);
    await nmbDownloadStatement(page, log, {
      dateFromYmd: today,
      dateToYmd: today,
      savePath: tPath,
    });
    log.step("sort today CSV ascending by Value Date");
    const tSort = sortNmbCsvByDateInPlace(tPath);
    log.detail(`today sorted ${tSort.rowsSorted} rows, ${tSort.rowsUnparsed} unparseable`);

    log.step("upload TODAY statement to processor");
    const tResult = await uploadStatement(tPath, "NMB");
    log.info("today processor response", { result: tResult });

    log.info("✅ meru cycle complete — 2 syncs done (yesterday + today)");
    return {
      yesterday: { rowsSorted: ySort.rowsSorted, uploadResult: yResult },
      today: { rowsSorted: tSort.rowsSorted, uploadResult: tResult },
    };
  } finally {
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
