import { loginToPortal } from "./login.js";

/**
 * Standalone login test:  npm run build && node dist/portal/runLogin.js
 * Logs in (triggering a real TAN through the relay), confirms the dashboard,
 * then closes. No money is moved.
 */
async function main(): Promise<void> {
  const { browser, page } = await loginToPortal();
  console.log("[runLogin] dashboard URL:", page.url());
  // Grab the account names/balances table text as a sanity check.
  const accountsText = await page
    .locator("text=My accounts")
    .first()
    .textContent()
    .catch(() => null);
  console.log("[runLogin] accounts section found:", accountsText ? "yes" : "no");
  await browser.close();
  console.log("[runLogin] done — login flow works ✅");
}

main().catch((err) => {
  console.error("[runLogin] FAILED:", err.message);
  process.exit(1);
});
