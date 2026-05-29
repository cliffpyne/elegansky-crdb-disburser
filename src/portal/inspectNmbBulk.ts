import { nmbLogin } from "./nmbLogin.js";
import { config } from "../config.js";
import type { BrowserContext, Page } from "playwright";

/**
 * One-shot diagnostic that triggers NMB's Big Data Statement flow the way
 * a real user does:
 *
 *   1. Drill into the account.
 *   2. Pick a 7-day date range (today-7 → today). With ~2k tx/day this is
 *      large enough that NMB rejects the inline download and tells the user
 *      to use Big Data Statement instead.
 *   3. Pick Credits Only.
 *   4. Click Apply Filter — watch for the "too big" notification.
 *   5. Click Download → CSV — capture whatever NMB says.
 *   6. Click Big Data Statement, pick Year + Month, click Search.
 *   7. Screenshot/dump every 10s for 2 min so we can see whether the file
 *      downloads inline, queues with a status row, or opens a separate page.
 */
export async function inspectNmbBulk(): Promise<void> {
  const { browser, page, log } = await nmbLogin();

  const ctx = browser.contexts()[0] as BrowserContext;
  ctx.on("page", (p) => log.info("NEW PAGE opened", { url: p.url() }));
  page.on("download", (d) => log.info("page-level DOWNLOAD event", { url: d.url(), name: d.suggestedFilename() }));
  page.on("dialog", (d) => log.info("dialog", { type: d.type(), msg: d.message() }));

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

    // Set Period = Select Date Range, then fill From = today-7, To = today.
    log.step("open period dropdown and choose 'Select Date Range'");
    const periodAnchor = page
      .locator('label:has-text("View Options") ~ * >> .oj-select-choice')
      .or(page.locator(".oj-select-choice").filter({ hasText: /current month/i }))
      .first();
    await periodAnchor.scrollIntoViewIfNeeded({ timeout: 15_000 });
    await periodAnchor.click();
    await page.waitForTimeout(400);
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(120);
    }
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);

    const today = new Date();
    const weekAgo = new Date(today);
    weekAgo.setDate(today.getDate() - 7);
    const fromYmd = ymd(weekAgo);
    const toYmd = ymd(today);
    log.step(`fill Date From → ${fromYmd} (week ago) and Date To → ${toYmd} (today)`);
    await fillDate(page, "fromDate", ddMmmYyyy(fromYmd));
    await fillDate(page, "toDate", ddMmmYyyy(toYmd));

    log.step("pick Credits Only");
    const cdAnchor = page.getByText("All", { exact: true }).first();
    await cdAnchor.scrollIntoViewIfNeeded({ timeout: 10_000 });
    await cdAnchor.click();
    await page.waitForTimeout(500);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(120);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);

    await page.screenshot({ path: "/tmp/nmb_bds_00_before_apply.png", fullPage: true }).catch(() => {});

    log.step("click Apply Filter");
    await page.getByRole("button", { name: /apply filter/i }).click();
    log.detail("waiting up to 90s for results (large range = slow)");
    await page.waitForLoadState("networkidle", { timeout: 90_000 }).catch(() => {});
    await page.waitForTimeout(3000);
    await page.screenshot({ path: "/tmp/nmb_bds_01_after_apply.png", fullPage: true }).catch(() => {});

    log.step("dump any visible 'too big / bulk / big data' notification");
    const notifs = (await page.evaluate(`(() => {
      const out = [];
      document.querySelectorAll('div, span, p, label, h1, h2, h3').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return;
        const cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
        const t = (el.innerText || el.textContent || '').trim();
        if (!t || t.length > 240) return;
        if (/big data|bulk|too (big|large|many)|huge|exceed|maximum|limit/i.test(t)) {
          out.push({ tag: el.tagName, id: el.id || '', text: t.slice(0, 200) });
        }
      });
      return out.slice(0, 20);
    })()`)) as Array<Record<string, string>>;
    log.detail(`'too big' candidates (${notifs.length}):`);
    for (const n of notifs) log.detail(`  ${JSON.stringify(n)}`);

    log.step("click Download → CSV and see what NMB says");
    await page.getByRole("button", { name: /^download$/i }).click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: "/tmp/nmb_bds_02_download_open.png", fullPage: true }).catch(() => {});
    await page.getByRole("menuitem", { name: /^csv$/i }).or(page.getByText(/^csv$/i)).first().click();
    await page.waitForTimeout(5000);
    await page.screenshot({ path: "/tmp/nmb_bds_03_after_csv_click.png", fullPage: true }).catch(() => {});

    log.step("click 'Big Data Statement' link");
    const bdsLink = page.getByText(/^\s*Big Data Statement\s*$/i).first();
    await bdsLink.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => {});
    await bdsLink.click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: "/tmp/nmb_bds_04_dialog_open.png", fullPage: true }).catch(() => {});

    log.step("pick Year = 2026, Month = May");
    await pickOjSelect(log, page, "selectYear", "2026", "Year");
    await page.screenshot({ path: "/tmp/nmb_bds_05_year_picked.png", fullPage: true }).catch(() => {});
    await pickOjSelect(log, page, "selectMonth", "May", "Month");
    await page.screenshot({ path: "/tmp/nmb_bds_06_month_picked.png", fullPage: true }).catch(() => {});

    log.step("click Search inside the dialog");
    await page.getByRole("button", { name: /^\s*Search\s*$/i }).first().click();

    log.step("watch post-Search for 120s (screenshot + visible-text every 10s)");
    for (let i = 1; i <= 12; i++) {
      await page.waitForTimeout(10_000);
      const shot = `/tmp/nmb_bds_${String(i).padStart(2, "0")}.png`;
      const txt = `/tmp/nmb_bds_${String(i).padStart(2, "0")}.txt`;
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      const visible = (await page.evaluate(`(() => {
        const out = [];
        document.querySelectorAll('button, a, span, div, h1, h2, h3, p, td, th, li, label, oj-button').forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return;
          const cs = window.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') return;
          const t = (el.innerText || el.textContent || '').trim();
          if (!t || t.length > 200) return;
          if (/bulk|big data|download|report|request|prepar|generat|ready|complete|pending|status|file|in progress|process|queue|available/i.test(t)) {
            out.push({ tag: el.tagName, id: el.id || '', text: t.slice(0, 160) });
          }
        });
        return out.slice(0, 50);
      })()`)) as Array<Record<string, string>>;
      const fs = await import("node:fs");
      fs.writeFileSync(txt, visible.map((v) => JSON.stringify(v)).join("\n"));
      log.info(`bds tick ${i}/12 — shot=${shot} txt=${txt} matches=${visible.length} url=${page.url()}`);
    }

    log.info("✅ BDS diagnostic complete — review /tmp/nmb_bds_*.png + .txt");
  } finally {
    if (browser.isConnected()) {
      log.info("closing browser");
      await browser.close().catch(() => {});
    }
  }
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ddMmmYyyy(ymdStr: string): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [y, m, d] = ymdStr.split("-");
  return `${parseInt(d ?? "0", 10)} ${months[parseInt(m ?? "0", 10) - 1]} ${y}`;
}

async function fillDate(page: Page, prefix: string, displayValue: string): Promise<void> {
  const input = page.locator(`input[id^="${prefix}"][id$="|input"]`).first();
  await input.waitFor({ state: "visible", timeout: 15_000 });
  await input.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await input.type(displayValue, { delay: 25 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

async function pickOjSelect(
  log: { step: (s: string) => void; detail: (s: string, extra?: Record<string, unknown>) => void; warn: (s: string, extra?: Record<string, unknown>) => void },
  page: Page,
  key: string,
  wantedText: string,
  label: string,
): Promise<void> {
  const triggerId = `oj-select-choice-${key}`;
  const trigger = page.locator(`[id="${triggerId}"]`).first();
  await trigger.waitFor({ state: "visible", timeout: 10_000 });
  await trigger.click();
  await page.waitForTimeout(600);

  const exact = page
    .locator("li.oj-listbox-result, [role='option']", { hasText: new RegExp(`^\\s*${wantedText}\\s*$`, "i") })
    .first();
  if (await exact.isVisible().catch(() => false)) {
    await exact.click();
    log.detail(`${label} → picked exact '${wantedText}'`);
  } else {
    const opts = page.locator("li.oj-listbox-result:visible, [role='option']:visible");
    const count = await opts.count().catch(() => 0);
    log.detail(`${label} → exact '${wantedText}' not visible; ${count} options listed`);
    for (let i = 0; i < Math.min(count, 14); i++) {
      const t = (await opts.nth(i).textContent().catch(() => ""))?.trim() ?? "";
      log.detail(`  option[${i}] = ${JSON.stringify(t)}`);
    }
    if (count >= 2) {
      await opts.nth(1).click();
      log.detail(`${label} → picked option[1] as fallback`);
    } else if (count === 1) {
      await opts.nth(0).click();
      log.detail(`${label} → only 1 option, picked it`);
    } else {
      log.warn(`${label} → no options visible`);
    }
  }
  await page.waitForTimeout(600);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  inspectNmbBulk()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[inspectNmbBulk] FAILED:", err.message);
      process.exit(1);
    });
}
