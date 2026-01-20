// src/server.js
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";

import observability from "./plugins/observability.js";
import { verifySupabaseJwt } from "./lib/jwt.js";
import { supabaseAdmin } from "./lib/supabaseAdmin.js";

import { getMerchantDirectoryCached, getUserOverrides } from "./lib/merchantData.js";
import { enforceBudgets } from "./lib/slo.js";

import { createScanSession, getScanSession } from "./lib/scanStore.js";
import { writeEvent, streamEvents } from "./lib/eventStore.js";
import { enqueueScanChunk } from "./queue/scanQueue.js";

import { upsertGoogleTokens } from "./lib/tokenStore.js";
import { metricsHandler } from "./telemetry/metrics.js";

import { verifyImapConnection, scanImap } from "./lib/imap.js";

export async function buildServer() {
  const server = Fastify({ logger: { level: process.env.LOG_LEVEL || "info" } });

  await server.register(observability);
  await server.register(cors, { origin: true });
  await server.register(rateLimit, { global: true, max: 200, timeWindow: "1 minute" });

  server.get("/health", async () => ({ ok: true }));
  server.get("/metrics", metricsHandler);

  const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

  // Auth hook
  server.addHook("preHandler", async (req, reply) => {
    if (req.url.startsWith("/health") || req.url.startsWith("/metrics")) return;

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) return reply.code(401).send({ error: "missing_bearer_token" });

    const token = authHeader.slice("Bearer ".length);
    try {
      const payload = await verifySupabaseJwt(token, JWT_SECRET);
      req.userId = payload.sub;
    } catch {
      return reply.code(401).send({ error: "invalid_token" });
    }
  });

  /** ---------------------------
   * Merchant confirm
   * -------------------------- */
  const ConfirmMerchantSchema = z.object({
    canonicalName: z.string().min(2),
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

  server.post("/v1/merchant/confirm", async (req, reply) => {
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
      if (r?.error) return reply.code(400).send({ ok: false, error: "db_error", message: r.error.message });
    }

    return { ok: true, canonicalName, senderEmail, senderDomain };
  });

  /** ---------------------------
   * Gmail job start + SSE stream + run + diagnostics
   * -------------------------- */
  const StartGmailSchema = z.object({
    auth: z.object({
      accessToken: z.string().min(10),
      refreshToken: z.string().min(10).optional(),
      expiresAt: z.number().int().optional(),
    }),
    options: z
      .object({
        mode: z.enum(["quick", "deep"]).optional(),
        daysBack: z.number().int().optional(),
        pageSize: z.number().int().optional(),
        chunkMs: z.number().int().optional(),
        fullFetchCap: z.number().int().optional(),
        concurrency: z.number().int().optional(),
        maxPages: z.number().int().optional(),
        maxCandidates: z.number().int().optional(),
        cursor: z.string().nullable().optional(),
        queryMode: z.enum(["transactions", "broad"]).optional(),
        includePromotions: z.boolean().optional(),
        maxListIds: z.number().int().optional(),
        clusterCap: z.number().int().optional(),
        debug: z.boolean().optional(),
        maxMerchants: z.number().int().optional(),
      })
      .default({}),
  });

  server.post("/v1/gmail/scan/start", async (req, reply) => {
    const parsed = StartGmailSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });

    const userId = req.userId;

    await upsertGoogleTokens({
      supabase: supabaseAdmin,
      userId,
      accessToken: parsed.data.auth.accessToken,
      refreshToken: parsed.data.auth.refreshToken ?? null,
      expiresAt: parsed.data.auth.expiresAt ? new Date(parsed.data.auth.expiresAt).toISOString() : null,
    });

    // ✅ Enforce SLO budgets server-side (never trust client)
    const safeOptions = enforceBudgets(parsed.data.options || {});
    safeOptions.cursor = parsed.data.options?.cursor ?? null;

    const session = await createScanSession({
      supabase: supabaseAdmin,
      userId,
      provider: "gmail",
      cursor: safeOptions.cursor,
      options: safeOptions,
    });

    await writeEvent({
      supabase: supabaseAdmin,
      sessionId: session.id,
      userId,
      type: "hello",
      payload: { ok: true, sessionId: session.id, mode: safeOptions.mode || "quick" },
      dedupeKey: `hello:${session.id}`,
    });

    await enqueueScanChunk({ sessionId: session.id });
    return { ok: true, sessionId: session.id, status: session.status };
  });

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
    reply.raw.write(`: ok\n\n`);

    const cancel = await streamEvents({
      supabase: supabaseAdmin,
      sessionId,
      userId,
      afterId,
      write: (evt) => {
        reply.raw.write(`event: ${evt.type}\n`);
        reply.raw.write(`data: ${JSON.stringify(evt.payload)}\n\n`);
      },
    });

    reply.raw.on("close", () => {
      try { cancel?.(); } catch {}
    });
  });

  server.post("/v1/gmail/scan/run", async (req, reply) => {
    const userId = req.userId;
    const { sessionId } = req.body || {};
    if (!sessionId) return reply.code(400).send({ error: "missing_sessionId" });

    const session = await getScanSession({ supabase: supabaseAdmin, sessionId, userId });
    if (!session) return reply.code(404).send({ error: "not_found" });

    await enqueueScanChunk({ sessionId });
    return { ok: true };
  });

  // ✅ Debug endpoint: “why stuck / why 0 results”
  server.get("/v1/gmail/scan/diagnostics/:sessionId", async (req, reply) => {
    const userId = req.userId;
    const sessionId = req.params.sessionId;

    const { data: session, error: sErr } = await supabaseAdmin
      .from("scan_sessions")
      .select("*")
      .eq("id", sessionId)
      .eq("user_id", userId)
      .maybeSingle();

    if (sErr) return reply.code(500).send({ error: sErr.message });
    if (!session) return reply.code(404).send({ error: "not_found" });

    const { data: chunks } = await supabaseAdmin
      .from("scan_chunk_logs")
      .select("*")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .limit(20);

    const { data: events } = await supabaseAdmin
      .from("scan_events")
      .select("id,type,payload,created_at")
      .eq("session_id", sessionId)
      .order("id", { ascending: false })
      .limit(50);

    const summary = {
      status: session.status,
      pages: session.pages ?? 0,
      scanned_total: session.scanned_total ?? 0,
      found_total: session.found_total ?? 0,
      cursor: session.cursor ?? null,
      last_stats: session.last_stats ?? null,
      last_chunk: chunks?.[0] ?? null,
      last_event: events?.[0] ?? null,
      commonStuckReasons: [
        session.status === "queued" && (!chunks || chunks.length === 0) ? "No worker consuming jobs" : null,
        chunks?.[0]?.error ? "Chunk error (see chunk_logs.error)" : null,
        (session.scanned_total ?? 0) > 500 && (session.found_total ?? 0) === 0 ? "No billing signals: try deep mode" : null,
      ].filter(Boolean),
    };

    return { session: summary, chunks: chunks || [], events: events || [] };
  });

  /** ---------------------------
   * IMAP verify + scan
   * -------------------------- */
  const ImapVerifySchema = z.object({
    provider: z.string().optional(),
    imap: z.object({
      host: z.string().min(3),
      port: z.number().int().min(1).max(65535),
      secure: z.boolean().default(true),
    }),
    auth: z.object({
      user: z.string().min(3),
      pass: z.string().min(1),
    }),
  });

  const ImapScanSchema = ImapVerifySchema.extend({
    options: z
      .object({
        daysBack: z.number().int().min(1).max(3650).default(365),
        maxMessages: z.number().int().min(50).max(50000).default(4000),
        maxCandidates: z.number().int().min(10).max(400).default(120),
        cursor: z.string().nullable().optional(),
      })
      .default({}),
  });

  server.post("/v1/email/verify", async (req, reply) => {
    const parsed = ImapVerifySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
    const out = await verifyImapConnection(parsed.data);
    return { ok: true, ...out };
  });

  server.post("/v1/email/scan", async (req, reply) => {
    const parsed = ImapScanSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });

    const out = await scanImap({
      ...parsed.data,
      options: parsed.data.options,
      userId: req.userId,
    });

    return { ok: true, ...out };
  });

  // Fix server.* helpers to match your merchantData.js signatures
  server.getMerchantDirectory = async () => getMerchantDirectoryCached();
  server.getUserOverrides = async (userId) => getUserOverrides(userId);

  return server;
}
