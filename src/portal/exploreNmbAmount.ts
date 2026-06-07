import { nmbLogin } from "./nmbLogin.js";
import { config } from "../config.js";

/**
 * Frank 2026-06-07 — one-shot exploration: open the NMB statement page,
 * stop at the filter panel, dump every visible input on the page so we
 * can identify the Amount From / Amount To fields by id/placeholder/aria
 * without screen-sharing.
 *
 * Run: NMB_HEADLESS=false npm --prefix /var/www/html/eleganskyCrdb run
 *      --silent -- exec node --env-file=.env --import tsx
 *      src/portal/exploreNmbAmount.ts
 *
 * Frank uses the live browser window to click Filter / Amount / etc.
 * After each click, the script re-dumps inputs so we see what appeared.
 */
async function main() {
  const { browser, page, log } = await nmbLogin();
  try {
    if (!config.NMB_ACCOUNT_NUMBER) throw new Error("NMB_ACCOUNT_NUMBER not set");

    log.step("click account row → account-details page");
    const row = page.locator(`tr:has-text("${config.NMB_ACCOUNT_NUMBER}")`).first();
    if (await row.isVisible().catch(() => false)) {
      await row.click();
    } else {
      await page.locator(`text=${config.NMB_ACCOUNT_NUMBER}`).first().click();
    }
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);

    log.step("EXPLORATION — periodically dumping every visible input on the page");
    log.info("Frank: use the browser window to find Amount filter UI.");
    log.info("Every 5s the script dumps visible inputs + label texts so we can spot the amount fields.");

    let tick = 0;
    setInterval(async () => {
      tick++;
      try {
        const dump = await page.evaluate(() => {
          const acc: Array<Record<string, string | boolean>> = [];
          document.querySelectorAll<HTMLInputElement>("input, select, textarea").forEach((el) => {
            const visible = !!(el.offsetParent || el.offsetWidth || el.offsetHeight);
            if (!visible) return;
            acc.push({
              tag: el.tagName.toLowerCase(),
              id: el.id ?? "",
              name: el.name ?? "",
              type: (el as HTMLInputElement).type ?? "",
              placeholder: (el as HTMLInputElement).placeholder ?? "",
              ariaLabel: el.getAttribute("aria-label") ?? "",
              value: ((el as HTMLInputElement).value || "").slice(0, 40),
            });
          });
          // Capture labels near these inputs too
          const labels: string[] = [];
          document.querySelectorAll("label").forEach((l) => {
            const txt = (l.textContent || "").trim();
            if (txt && txt.length < 60) labels.push(txt);
          });
          return { inputs: acc, labels };
        });
        log.info(`[tick ${tick}] visible inputs: ${dump.inputs.length}, labels: ${dump.labels.length}`);
        log.detail(`labels (first 40): ${JSON.stringify(dump.labels.slice(0, 40))}`);
        log.detail(`inputs: ${JSON.stringify(dump.inputs).slice(0, 2400)}`);
      } catch (e) {
        log.info(`[tick ${tick}] dump failed: ${String((e as Error).message || e).slice(0, 100)}`);
      }
    }, 5_000);

    // Park forever — Frank kills the script with Ctrl-C when done exploring.
    log.info("Browser ready — kill with Ctrl-C when done. Logs at /tmp/nmb_bot.log");
    await new Promise(() => {});
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
