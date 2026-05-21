import { redis } from "../redis.js";

/** Server-side store for live worker status (Redis, short TTL), keyed PER worker. */
const TTL = 1800; // 30 min
const IDS_KEY = "worker:ids";

export interface WorkerReport {
  step: string;
  worker?: string;
  ts: number;
  screenshotB64?: string;
  [k: string]: unknown;
}

export async function saveReport(r: WorkerReport): Promise<void> {
  const id = (r.worker as string) || "unknown";
  const { screenshotB64, ...meta } = r;
  const pipe = redis.multi();
  pipe.sadd(IDS_KEY, id);
  pipe.set(`worker:status:${id}`, JSON.stringify(meta), "EX", TTL);
  pipe.lpush(`worker:steps:${id}`, JSON.stringify({ step: r.step, ts: r.ts }));
  pipe.ltrim(`worker:steps:${id}`, 0, 49);
  pipe.expire(`worker:steps:${id}`, TTL);
  if (screenshotB64) pipe.set(`worker:shot:${id}`, screenshotB64, "EX", TTL);
  await pipe.exec();
}

export interface WorkerView {
  id: string;
  status: Omit<WorkerReport, "screenshotB64">;
  steps: { step: string; ts: number }[];
}

/** All workers that have reported recently (expired ones are dropped). */
export async function getAllStatus(): Promise<WorkerView[]> {
  const ids = (await redis.smembers(IDS_KEY)).sort();
  const out: WorkerView[] = [];
  for (const id of ids) {
    const s = await redis.get(`worker:status:${id}`);
    if (!s) {
      await redis.srem(IDS_KEY, id); // stale → forget it
      continue;
    }
    const steps = (await redis.lrange(`worker:steps:${id}`, 0, 49)).map((x) => JSON.parse(x));
    out.push({ id, status: JSON.parse(s), steps });
  }
  return out;
}

export async function getShot(id: string): Promise<Buffer | null> {
  const b64 = await redis.get(`worker:shot:${id}`);
  return b64 ? Buffer.from(b64, "base64") : null;
}
