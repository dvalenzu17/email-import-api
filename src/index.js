// API/src/index.js
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";

import { verifySupabaseJwt } from "./lib/jwt.js";
import { supabaseAdmin } from "./lib/supabaseAdmin.js";
import { getMerchantDirectoryCached, getUserOverrides, getUserSubscriptionSignals } from "./lib/merchantData.js";
import { scanGmail } from "./lib/gmail.js";
import { createScanSession, getScanSession, updateScanSession } from "./lib/scanStore.js";
import { writeEvent, streamEvents } from "./lib/eventStore.js";
import { runScanWorker } from "./worker/scanWorker.js";

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

const server = Fastify({ logger: true });

await server.register(cors, { origin: true });
await server.register(rateLimit, { global: true, max: 200, timeWindow: "1 minute" });

// auth hook
server.addHook("preHandler", async (req, reply) => {
  if (req.url.startsWith("/health")) return;

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return reply.code(401).send({ error: "missing_bearer_token" });
  }

  const token = authHeader.slice("Bearer ".length);
  try {
    const payload = await verifySupabaseJwt(token, JWT_SECRET);
    req.userId = payload.sub;
  } catch (e) {
    req.log.warn({ err: e }, "jwt_verify_failed");
    return reply.code(401).send({ error: "invalid_token" });
  }
});

server.get("/health", async () => ({ ok: true }));

/** ---------------------------
 * Merchant confirm (human-in-the-loop training)
 * -------------------------- */
const ConfirmMerchantSchema = z.object({
  canonicalName: z.string().min(2),
  // optional helpers
  from: z.string().optional(),
  senderEmail: z.string().email().optional(),
  senderDomain: z.string().min(3).optional(),
});

function parseSenderEmail(fromHeader = "") {
  const m = String(fromHeader).match(/<([^>]+)>/);
  const email = (m?.[1] || fromHeader).trim();
  if (!email.includes("@")) return null;
  return email.replace(/^mailto:/i, "").trim();
}

function parseSenderDomain(fromHeader = "") {
  const email = parseSenderEmail(fromHeader);
  if (!email) return null;
  return email.split("@").pop()?.toLowerCase() || null;
}

server.post(
  "/v1/merchant/confirm",
  { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
  async (req, reply) => {
    const parsed = ConfirmMerchantSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });

    const userId = req.userId;
    const canonicalName = String(parsed.data.canonicalName).trim();
    const from = String(parsed.data.from || "");

    const senderEmail = (parsed.data.senderEmail || parseSenderEmail(from) || "").trim() || null;
    const senderDomain = (parsed.data.senderDomain || parseSenderDomain(from) || "").trim().toLowerCase() || null;

    if (!senderEmail && !senderDomain) {
      return reply.code(400).send({ error: "missing_sender", message: "Provide senderEmail/senderDomain or a parsable from." });
    }

    // Store both (when available).
    const ops = [];
    if (senderEmail) {
      ops.push(
        supabaseAdmin
          .from("user_merchant_overrides")
          .upsert(
            { user_id: userId, sender_email: senderEmail, sender_domain: null, canonical_name: canonicalName },
            { onConflict: "user_id,sender_email" }
          )
      );
    }
    if (senderDomain) {
      ops.push(
        supabaseAdmin
          .from("user_merchant_overrides")
          .upsert(
            { user_id: userId, sender_email: null, sender_domain: senderDomain, canonical_name: canonicalName },
            { onConflict: "user_id,sender_domain" }
          )
      );
    }

    const results = await Promise.all(ops);
    for (const r of results) {
      if (r?.error) {
        req.log.warn({ err: r.error }, "merchant_confirm_failed");
        return reply.code(400).send({ ok: false, error: "db_error", message: r.error.message });
      }
    }

    return { ok: true, canonicalName, senderEmail, senderDomain };
  }
);

/** ---------------------------
 * Gmail job: start/status/cancel
 * -------------------------- */
const StartGmailSchema = z.object({
  auth: z.object({ accessToken: z.string().min(10) }),
  options: z
    .object({
      daysBack: z.number().int().min(1).max(3650).default(365),
      pageSize: z.number().int().min(50).max(500).default(500),
      chunkMs: z.number().int().min(8000).max(20000).default(9000),
      fullFetchCap: z.number().int().min(10).max(120).default(25),
      concurrency: z.number().int().min(2).max(10).default(6),
      maxPages: z.number().int().min(1).max(400).default(120),
      maxCandidates: z.number().int().min(10).max(400).default(200),
      cursor: z.string().optional(),
      queryMode: z.enum(["transactions", "broad"]).optional(),
      includePromotions: z.boolean().optional(),
      maxListIds: z.number().int().min(300).max(25000).optional(),
      clusterCap: z.number().int().min(10).max(200).optional(),
    })
    .default({}),
});

server.post(
  "/v1/gmail/scan/start",
  { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
  async (req, reply) => {
    const parsed = StartGmailSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });

    const userId = req.userId;
    const session = await createScanSession({
      supabase: supabaseAdmin,
      userId,
      provider: "gmail",
      cursor: parsed.data.options.cursor ?? null,
      options: { ...parsed.data.options },
    });

    // token cache for worker lifetime
    server.scanTokenCache ??= new Map();
    server.scanTokenCache.set(session.id, parsed.data.auth.accessToken);

    await writeEvent({
      supabase: supabaseAdmin,
      sessionId: session.id,
      userId,
      type: "hello",
      payload: { ok: true, sessionId: session.id },
    });

    return { ok: true, sessionId: session.id, status: session.status };
  }
);

server.get("/v1/gmail/scan/stream", async (req, reply) => {
  const userId = req.userId;
  const sessionId = String(req.query?.sessionId || "");
  const afterId = Number(req.query?.afterId || 0);

  if (!sessionId) return reply.code(400).send({ error: "missing_sessionId" });

  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  await streamEvents({
    supabase: supabaseAdmin,
    sessionId,
    userId,
    afterId,
    write: (evt) => {
      reply.raw.write(`event: ${evt.type}\n`);
      reply.raw.write(`data: ${JSON.stringify(evt.payload)}\n\n`);
    },
  });
});

server.post("/v1/gmail/scan/run", async (req, reply) => {
  // worker trigger endpoint (optional) — if you use cron/queue you can remove this
  const { sessionId } = req.body || {};
  if (!sessionId) return reply.code(400).send({ error: "missing_sessionId" });

  const session = await getScanSession({ supabase: supabaseAdmin, sessionId });
  if (!session) return reply.code(404).send({ error: "not_found" });

  // kick worker inline
  runScanWorker({ server, sessionId, logger: server.log }).catch((e) => server.log.error(e));
  return { ok: true };
});

server.listen({ port: PORT, host: "0.0.0.0" });
