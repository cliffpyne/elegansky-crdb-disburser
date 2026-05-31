/**
 * Tiny structured logger for the statement-pull bots. Every entry is one line
 * that includes:
 *   - wall-clock time
 *   - bank tag (NMB / CRDB)
 *   - numbered step within the cycle
 *   - elapsed ms since the cycle started (so slow steps stand out)
 *   - the message
 *
 * Mirrors output to both stdout AND /tmp/<bank>_bot.log so we can tail the
 * file from another terminal while the browser is running.
 */

import { appendFileSync, writeFileSync } from "node:fs";

export interface BotLogger {
  step(label: string): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
  /** Mark a sub-action with no step-counter bump (for context inside one step). */
  detail(message: string, extra?: Record<string, unknown>): void;
}

export function makeBotLogger(bank: "NMB" | "CRDB"): BotLogger {
  const startedAt = Date.now();
  const file = `/tmp/${bank.toLowerCase()}_bot.log`;
  let stepNum = 0;
  const workerId = process.env.WORKER_ID ?? "statement-pull";
  const brainBase = (process.env.BRAIN_REPORT_URL ?? "").replace(/\/api\/cycles\/?$/, "/api");
  const secret = process.env.STATEMENT_REPORT_SECRET ?? "";

  // Fire-and-forget heartbeat. Never blocks, never throws into the cycle.
  function heartbeat(currentStep: string): void {
    if (!brainBase || !secret) return;
    fetch(`${brainBase}/cycles/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Report-Secret": secret },
      body: JSON.stringify({ bank, worker_id: workerId, step_num: stepNum, current_step: currentStep }),
    }).catch(() => {});
  }

  // Truncate the log on every cycle so we don't read yesterday's leftovers.
  writeFileSync(file, `── ${bank} bot started ${new Date().toISOString()} ──\n`);

  function emit(level: string, msg: string, extra?: Record<string, unknown>): void {
    const elapsedMs = Date.now() - startedAt;
    const elapsed = `+${(elapsedMs / 1000).toFixed(1)}s`;
    const stamp = new Date().toISOString().slice(11, 23); // HH:mm:ss.sss
    const tag = `[${bank}#${String(stepNum).padStart(2, "0")} ${stamp} ${elapsed}]`;
    const extraStr = extra ? "  " + JSON.stringify(extra) : "";
    const line = `${tag} ${level} ${msg}${extraStr}`;
    console.log(line);
    try {
      appendFileSync(file, line + "\n");
    } catch {
      // logging never breaks the bot
    }
  }

  return {
    step(label) {
      stepNum += 1;
      emit("STEP", label);
      heartbeat(label);
    },
    info(msg, extra) {
      emit("info", msg, extra);
    },
    detail(msg, extra) {
      emit("  ·", msg, extra);
    },
    warn(msg, extra) {
      emit("WARN", msg, extra);
    },
    error(msg, extra) {
      emit("ERR ", msg, extra);
    },
  };
}
