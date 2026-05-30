/**
 * Loop kill switch — backed by BRAIN's app_settings table.
 *
 *   isLoopEnabled()           — read on each tick start; false → skip tick
 *   autoDisableLoop(reason)   — worker self-disables after retry exhaustion
 *
 * Both use the shared X-Report-Secret to authenticate against BRAIN.
 * Failures are conservative: if BRAIN is unreachable we ASSUME the loop is
 * enabled (better to run when we shouldn't than block legitimate ticks).
 */

function brainUrl(): string | null {
  // Same env var the cycle reporter uses, but rewritten to the settings endpoints.
  const reportUrl = process.env.BRAIN_REPORT_URL;
  if (!reportUrl) return null;
  // BRAIN_REPORT_URL = "https://elegansky-brain.onrender.com/api/cycles"
  return reportUrl.replace(/\/api\/cycles\/?$/, "/api");
}

export async function isLoopEnabled(): Promise<boolean> {
  const base = brainUrl();
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!base || !secret) {
    console.warn(
      `[loopControl] no BRAIN config (base=${!!base} secret=${!!secret}) — assuming enabled`,
    );
    return true;
  }
  try {
    const res = await fetch(`${base}/settings/statement_pull_enabled`, {
      headers: { "X-Report-Secret": secret },
    });
    if (!res.ok) {
      console.warn(`[loopControl] GET → ${res.status} — assuming enabled`);
      return true;
    }
    const body = (await res.json()) as { setting?: { value?: string } };
    const enabled = body.setting?.value !== "false";
    return enabled;
  } catch (err) {
    console.warn(`[loopControl] network error: ${(err as Error).message} — assuming enabled`);
    return true;
  }
}

export async function autoDisableLoop(reason: string): Promise<void> {
  const base = brainUrl();
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!base || !secret) {
    console.warn(`[loopControl] cannot auto-disable — no BRAIN config`);
    return;
  }
  try {
    const res = await fetch(`${base}/settings/auto-disable-loop`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Report-Secret": secret,
      },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.warn(`[loopControl] auto-disable → ${res.status}: ${t.slice(0, 200)}`);
      return;
    }
    console.log(`[loopControl] 🛑 loop auto-disabled — reason: ${reason}`);
  } catch (err) {
    console.warn(`[loopControl] auto-disable network error: ${(err as Error).message}`);
  }
}
