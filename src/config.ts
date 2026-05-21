import { z } from "zod";

/** Parse "true"/"false"/"1"/"0" strings into real booleans (z.coerce.boolean treats "false" as true). */
const zBool = (def: boolean) =>
  z.preprocess((v) => {
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return ["true", "1", "yes"].includes(v.trim().toLowerCase());
    return def;
  }, z.boolean());

/**
 * Environment config, validated once at boot. Fails fast with a clear message
 * if anything required is missing — better than a vague crash mid-request.
 */
const schema = z.object({
  // Server
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),

  // Shared secret the phone app sends in the X-Tan-Secret header.
  TAN_WEBHOOK_SECRET: z.string().min(8, "TAN_WEBHOOK_SECRET must be at least 8 chars"),

  // Redis. Render injects REDIS_URL when you attach a Redis instance.
  REDIS_URL: z.string().url().default("redis://127.0.0.1:6379"),

  // TAN scraping + storage.
  TAN_LENGTH: z.coerce.number().int().min(4).max(10).default(6),
  TAN_TTL_SECONDS: z.coerce.number().int().positive().default(300), // 5 min
  TAN_DEDUPE_SECONDS: z.coerce.number().int().positive().default(120),
  // A code whose issue-time is older than this is treated as expired and never
  // becomes "latest". 5-min validity + 2-min clock-skew tolerance.
  TAN_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(420),

  // CRDB sender IDs we accept TANs from (comma-separated). Defense in depth:
  // the phone already filters, but the server double-checks.
  ALLOWED_SENDERS: z
    .string()
    .default("CRDB,CRDB-BANK,CRDB BANK,CRDBBANK")
    .transform((s) => s.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean)),

  // ── Disburse worker (Playwright) — all OPTIONAL so the webhook server boots
  //    without them. The worker validates they exist before running. ──────────
  BANK_LOGIN_URL: z
    .string()
    .url()
    .default("https://omnichannels.crdbbank.co.tz/netteller-war/Login.xhtml"),
  BANK_USERNAME: z.string().optional(),
  BANK_PASSWORD: z.string().optional(),
  BANK_FROM_ACCOUNT: z.string().default("10346845061"),
  BANK_HEADLESS: zBool(true).default(true),

  // Where the worker reads the relayed TAN from (the webhook's public URL).
  WEBHOOK_BASE_URL: z.string().url().default("https://elegansky-crdb-disburser.onrender.com"),

  // Safety rails for moving real money.
  DISBURSE_DRY_RUN: zBool(true).default(true), // do everything EXCEPT the final submit
  DISBURSE_MAX_RECIPIENTS: z.coerce.number().int().positive().default(200),
  DISBURSE_MAX_TOTAL_TZS: z.coerce.number().int().positive().default(5_000_000),

  // ── Database (Supabase Postgres) + scheduler ──
  DATABASE_URL: z.string().optional(),
  WORKER_ID: z.string().default(`worker-${process.pid}`),
  DISBURSE_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  DISBURSE_INTERVAL_MINUTES: z.coerce.number().int().positive().default(30),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
