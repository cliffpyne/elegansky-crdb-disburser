import { redis } from "../redis.js";

/** Server-side store for the worker's live status (Redis, short TTL). */
const TTL = 1800; // 30 min
const STATUS_KEY = "worker:status";
const STEPS_KEY = "worker:steps";
const SHOT_KEY = "worker:shot";

export interface WorkerReport {
  step: string;
  worker?: string;
  ts: number;
  screenshotB64?: string;
  [k: string]: unknown;
}

export async function saveReport(r: WorkerReport): Promise<void> {
  const { screenshotB64, ...meta } = r;
  const pipe = redis.multi();
  pipe.set(STATUS_KEY, JSON.stringify(meta), "EX", TTL);
  pipe.lpush(STEPS_KEY, JSON.stringify({ step: r.step, ts: r.ts }));
  pipe.ltrim(STEPS_KEY, 0, 99);
  pipe.expire(STEPS_KEY, TTL);
  if (screenshotB64) pipe.set(SHOT_KEY, screenshotB64, "EX", TTL);
  await pipe.exec();
}

export async function getStatus(): Promise<{ status: WorkerReport | null; steps: { step: string; ts: number }[] }> {
  const s = await redis.get(STATUS_KEY);
  const steps = (await redis.lrange(STEPS_KEY, 0, 99)).map((x) => JSON.parse(x));
  return { status: s ? JSON.parse(s) : null, steps };
}

export async function getShot(): Promise<Buffer | null> {
  const b64 = await redis.get(SHOT_KEY);
  return b64 ? Buffer.from(b64, "base64") : null;
}
