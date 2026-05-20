import { z } from "zod";

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

  // CRDB sender IDs we accept TANs from (comma-separated). Defense in depth:
  // the phone already filters, but the server double-checks.
  ALLOWED_SENDERS: z
    .string()
    .default("CRDB,CRDB-BANK,CRDB BANK,CRDBBANK")
    .transform((s) => s.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean)),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
