import { writeFileSync } from "node:fs";
import { loginToPortal } from "./login.js";

/**
 * One-off: log in, open Payments > Bulk Payments, and dump the form HTML so we
 * can write precise PrimeFaces selectors. Run:
 *   node --env-file=.env dist/portal/explore.js
 */
async function main(): Promise<void> {
  const { browser, page } = await loginToPortal();
  console.log("[explore] navigating to Payments > Bulk Payments");

  try {
    // Hover the Payments top-nav item so its submenu opens, then click the item.
    await page.getByText(/^\s*Payments\s*$/i).first().hover();
    await page.waitForTimeout(800);
    await page.getByText(/^\s*Bulk Payments\s*$/i).first().click({ timeout: 8000 });
    await page.waitForURL(/MassPayment/i, { timeout: 20_000 });
  } catch {
    // Fallback: navigate straight to the bulk-payment view (JSF views are GET-able).
    console.log("[explore] menu hover failed — trying direct URL");
    const base = process.env.BANK_LOGIN_URL!.replace(/Login\.xhtml.*$/, "");
    await page.goto(`${base}MassPayment.xhtml?cs=1`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  }
  await page.waitForLoadState("networkidle").catch(() => {});
  console.log("[explore] on:", page.url());

  const html = await page.content();
  writeFileSync("/tmp/crdb_bulk.html", html, "utf8");
  console.log("[explore] saved /tmp/crdb_bulk.html (", html.length, "bytes )");

  // Print the IDs of dropdowns, the file input, and radios to speed up selectoring.
  const ids = await page.evaluate(`(() => {
    const q = (sel) => Array.from(document.querySelectorAll(sel)).map((e) => e.id).filter(Boolean);
    return {
      selectMenus: q('.ui-selectonemenu'),
      fileInputs: q('input[type="file"]'),
      radios: Array.from(document.querySelectorAll('input[type=radio]')).map((e) => e.id + '=' + e.value),
      uploads: q(".ui-fileupload, [id*='upload'], [id*='Upload']"),
    };
  })()`);
  console.log("[explore] component ids:", JSON.stringify(ids, null, 2));

  await browser.close();
  console.log("[explore] done");
}

main().catch((err) => {
  console.error("[explore] FAILED:", err.message);
  process.exit(1);
});
