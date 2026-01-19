// src/index.js
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import "dotenv/config";
import { FastifySSEPlugin } from "fastify-sse-v2";

import { verifySupabaseJwt } from "./lib/jwt.js";
import { supabaseAdmin } from "./lib/supabaseAdmin.js";
import { getMerchantDirectoryCached, getUserOverrides } from "./lib/merchantData.js";
import {
  createScanSession,
  getScanSession,
  cancelScanSession,
  listNewEvents,
  writeEvent,
} from "./lib/scanStore.js";
import { startScanWorker } from "./worker/scanWorker.js";

const PORT = Number(process.env.PORT ?? 8787);
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
if (!JWT_SECRET) throw new Error("Missing env SUPABASE_JWT_SECRET");

const server = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
});

await server.register(cors, { origin: true, credentials: true });
await server.register(FastifySSEPlugin);

await server.register(rateLimit, {
  max: 60,
  timeWindow: "1 minute",
  keyGenerator: (req) => req.userId ?? req.ip,
});

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
      options: {
        ...parsed.data.options,
        // store token in-memory only? nope. keep it in session options? also nope.
        // we do NOT store access tokens in DB. we pass it via events start and keep in worker cache.
      },
    });

    // Store access token in memory for worker (per-session)
    // (worker reads this cache; if process restarts, client must restart the job)
    server.scanTokenCache ??= new Map();
    server.scanTokenCache.set(session.id, parsed.data.auth.accessToken);

    // seed hello event so UI updates instantly
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

server.get(
  "/v1/gmail/scan/status",
  { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
  async (req, reply) => {
    const sessionId = String(req.query?.sessionId || "");
    if (!sessionId) return reply.code(400).send({ error: "missing_sessionId" });

    const session = await getScanSession({ supabase: supabaseAdmin, sessionId, userId: req.userId });
    if (!session) return reply.code(404).send({ error: "not_found" });

    return { ok: true, session };
  }
);

server.post(
  "/v1/gmail/scan/cancel",
  { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
  async (req, reply) => {
    const sessionId = String(req.body?.sessionId || "");
    if (!sessionId) return reply.code(400).send({ error: "missing_sessionId" });

    const ok = await cancelScanSession({ supabase: supabaseAdmin, sessionId, userId: req.userId });
    return { ok };
  }
);

/** ---------------------------
 * Gmail job: SSE stream
 * -------------------------- */
server.get(
  "/v1/gmail/scan/stream",
  { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } },
  async (req, reply) => {
    const sessionId = String(req.query?.sessionId || "");
    const afterId = Number(req.query?.afterId || 0);

    if (!sessionId) return reply.code(400).send({ error: "missing_sessionId" });

    // anti-buffer headers
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");

    let closed = false;
    req.socket.on("close", () => (closed = true));

    return reply.sse(
      (async function* () {
        let cursor = afterId;
        let lastPing = 0;

        while (!closed) {
          const now = Date.now();
          if (now - lastPing > 2000) {
            lastPing = now;
            yield { event: "ping", data: JSON.stringify({ t: now }) };
          }

          const batch = await listNewEvents({
            supabase: supabaseAdmin,
            sessionId,
            userId: req.userId,
            afterId: cursor,
            limit: 100,
          });

          if (batch.length) {
            for (const ev of batch) {
              cursor = ev.id;
              yield { event: ev.event_type, data: JSON.stringify({ id: ev.id, ...ev.payload }) };
            }

            const last = batch[batch.length - 1];
            if (last.event_type === "done" || last.event_type === "error") break;
          }

          await new Promise((r) => setTimeout(r, 350));
        }
      })()
    );
  }
);

// ---- Boot worker ----
startScanWorker({
  server,
  supabase: supabaseAdmin,
  getDirectory: getMerchantDirectoryCached,
  getOverrides: getUserOverrides,
});

await server.listen({ port: PORT, host: "0.0.0.0" });
server.log.info({ port: PORT }, "email-import-api listening");
