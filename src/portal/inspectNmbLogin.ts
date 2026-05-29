/**
 * Throw-away inspector — opens the NMB login page in real Chrome and dumps the
 * real DOM of every <input>, <button> and clickable element on the page so we
 * can pick selectors from reality instead of guessing.
 *
 * Run with:  node --env-file=.env --import tsx src/portal/inspectNmbLogin.ts
 */
import { chromium } from "playwright";
import { config } from "../config.js";
import { writeFileSync } from "node:fs";

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(45_000);

  console.log("→ opening", config.NMB_LOGIN_URL);
  await page.goto(config.NMB_LOGIN_URL, { waitUntil: "domcontentloaded" });

  // SPA — wait for the form to actually render by polling for ANY input element.
  console.log("→ waiting for inputs to render…");
  await page.waitForFunction(() => document.querySelectorAll("input").length > 0, { timeout: 45_000 });

  // Give SPA framework one more tick to settle.
  await page.waitForTimeout(2000);

  console.log("\n=== inputs ===");
  const inputs = await page.$$eval("input", (els) =>
    els.map((el) => ({
      tag: el.tagName,
      type: el.getAttribute("type"),
      name: el.getAttribute("name"),
      id: el.id || null,
      placeholder: el.getAttribute("placeholder"),
      ariaLabel: el.getAttribute("aria-label"),
      autocomplete: el.getAttribute("autocomplete"),
      visible: (el as HTMLInputElement).offsetParent !== null,
      value: ((el as HTMLInputElement).value || "").slice(0, 20),
      classes: el.className?.split?.(" ")?.slice(0, 5)?.join(" "),
    })),
  );
  for (const i of inputs) console.log(JSON.stringify(i));

  console.log("\n=== buttons & clickable submit-like elements ===");
  const buttons = await page.$$eval(
    'button, input[type="submit"], a[role="button"], [role="button"]',
    (els) =>
      els.map((el) => ({
        tag: el.tagName,
        type: el.getAttribute("type"),
        text: (el.textContent || "").trim().slice(0, 60),
        id: el.id || null,
        classes: el.className?.split?.(" ")?.slice(0, 4)?.join(" "),
        ariaLabel: el.getAttribute("aria-label"),
        visible: (el as HTMLElement).offsetParent !== null,
      })),
  );
  for (const b of buttons) if (b.visible) console.log(JSON.stringify(b));

  console.log("\n=== labels (text + for-id) ===");
  const labels = await page.$$eval("label", (els) =>
    els
      .map((el) => ({
        text: (el.textContent || "").trim().slice(0, 60),
        forId: el.getAttribute("for"),
      }))
      .filter((l) => l.text),
  );
  for (const l of labels) console.log(JSON.stringify(l));

  // Save full rendered HTML so we can grep it later.
  const html = await page.content();
  writeFileSync("/tmp/nmb_login.html", html);
  await page.screenshot({ path: "/tmp/nmb_login_inspected.png", fullPage: true });
  console.log("\n→ saved /tmp/nmb_login.html and /tmp/nmb_login_inspected.png");

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
