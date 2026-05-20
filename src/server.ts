import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";
import { scrapeTan } from "./tan/scrapeTan.js";
import { storeTan, peekLatest } from "./tan/store.js";

const tanBodySchema = z.object({
  forwarded: z.string().min(1).max(2000),
  sender: z.string().max(64).default(""),
  received_at: z.coerce.number().int().positive().optional(),
});

/** Constant-time secret comparison so we don't leak length/timing. */
function secretOk(provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(config.TAN_WEBHOOK_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The phone already filters, but double-check the sender server-side. */
function senderAllowed(sender: string): boolean {
  const cleaned = sender.toUpperCase().replace(/[-\s]/g, "");
  if (cleaned === "") return true; // sender optional; don't reject on absence
  return config.ALLOWED_SENDERS.some((a) => {
    const allowed = a.replace(/[-\s]/g, "");
    return cleaned.includes(allowed) || allowed.includes(cleaned);
  });
}

function requireSecret(req: FastifyRequest): boolean {
  return secretOk(req.headers["x-tan-secret"] as string | undefined);
}

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get("/healthz", async () => ({ ok: true }));

  // Receives the phone app's numbers+emojis string, scrapes the TAN, stores it.
  app.post("/internal/tan", async (req, reply) => {
    if (!requireSecret(req)) {
      return reply.code(401).send({ ok: false, error: "bad secret" });
    }

    const parsed = tanBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: "bad body", details: parsed.error.flatten() });
    }
    const { forwarded, sender, received_at } = parsed.data;

    if (!senderAllowed(sender)) {
      req.log.warn({ sender }, "rejected TAN: sender not allowed");
      return reply.code(403).send({ ok: false, error: "sender not allowed" });
    }

    const code = scrapeTan(forwarded, config.TAN_LENGTH);
    if (!code) {
      req.log.warn({ forwarded }, "no TAN found in forwarded message");
      return reply.code(422).send({ ok: false, error: "no TAN found" });
    }

    const stored = await storeTan({
      code,
      sender,
      receivedAt: received_at ?? Date.now(),
      storedAt: Date.now(),
    });

    req.log.info({ code: mask(code), stored }, stored ? "TAN stored" : "TAN duplicate, skipped");
    return reply.code(stored ? 201 : 200).send({ ok: true, code: mask(code), stored, duplicate: !stored });
  });

  // Read-only peek for debugging — never consumes the code.
  app.get("/internal/tan/latest", async (req, reply) => {
    if (!requireSecret(req)) return reply.code(401).send({ ok: false, error: "bad secret" });
    const latest = await peekLatest();
    return reply.send({ ok: true, latest: latest ? { ...latest, code: mask(latest.code) } : null });
  });

  return app;
}

/** Mask a code in logs/responses: 852456 → 85**56 */
function mask(code: string): string {
  if (code.length <= 3) return "*".repeat(code.length);
  return code.slice(0, 2) + "*".repeat(code.length - 4) + code.slice(-2);
}
