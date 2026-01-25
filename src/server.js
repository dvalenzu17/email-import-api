// src/server.js
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";

import observability from "./plugins/observability.js";
import { verifySupabaseJwt } from "./lib/jwt.js";
import { supabaseAdmin } from "./lib/supabaseAdmin.js";
import { getPlanOptimization, getDuplicateCoverage } from "./lib/optimization.js";
import { getRegionalOptimizations } from "./lib/optimization.js";
import { getCancelPlaybook } from "./lib/cancelPlaybooks.js";
import { ingestCandidateSignals } from "./lib/signalIngest.js";
import { buildCancelTemplates } from "./lib/cancelTemplates.js";
import { queueRelayEmail, recordCancelMessage } from "./lib/conciergeRelay.js";
import { processRelayOutbox } from "./worker/relayWorker.js";
import { getBrandAssets, refreshBrandAssets, resolveBrand } from "./lib/brandAssets.js";
import { isActiveTrial, trialNudgeWindow, computeTrialNotifications } from "./lib/trials.js";
import { weeklyTotal } from "./lib/renewals.js";
import { confirmCandidateAsSubscription, manualAddSubscription } from "./lib/subscriptionStore.js";
import { parseReceiptUpload } from "./lib/uploadParser.js";

import { getMerchantDirectoryCached, getUserOverrides } from "./lib/merchantData.js";
import { enforceBudgets } from "./lib/slo.js";

import { createScanSession, getScanSession } from "./lib/scanStore.js";
import { writeEvent, streamEvents } from "./lib/eventStore.js";
import { enqueueScanChunk } from "./queue/scanQueue.js";

import { getGoogleTokens, upsertGoogleTokens } from "./lib/tokenStore.js";
import { getFreshGoogleAccessToken } from "./lib/googleAuth.js";
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
    // auth is optional: if omitted, backend will use stored tokens (refresh -> access).
    // This fixes the common Supabase behavior where provider_token is not present after app relaunch.
    auth: z
      .object({
        accessToken: z.string().min(10).optional(),
        refreshToken: z.string().min(10).optional(),
        expiresAt: z.number().int().optional(),
      })
      .optional(),
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

    // Stage 1: token storage OR token hydrate.
    // If client supplied tokens, store them.
    // If client did not, ensure we have stored tokens and can mint an access token.
    try {
      const auth = parsed.data.auth || {};

      if (auth.accessToken) {
        await upsertGoogleTokens({
          supabase: supabaseAdmin,
          userId,
          accessToken: auth.accessToken,
          refreshToken: auth.refreshToken ?? null,
          expiresAt: auth.expiresAt ? new Date(auth.expiresAt).toISOString() : null,
        });
      } else {
        // No access token provided: rely on stored tokens.
        const stored = await getGoogleTokens({ supabase: supabaseAdmin, userId });
        if (!stored?.accessToken && !stored?.refreshToken) {
          return reply.code(400).send({
            error: "missing_google_tokens",
            message: "Missing Google tokens. Please reconnect Gmail.",
          });
        }

        // If we have a refresh token, rotate access token to ensure it's valid.
        if (stored?.refreshToken) {
          await getFreshGoogleAccessToken({ supabase: supabaseAdmin, userId });
        }
      }
    } catch (e) {
      e.statusCode = e.statusCode || 500;
      e.code = e.code || "TOKEN_BOOTSTRAP_FAILED";
      throw e;
    }

    // Stage 2: create session
    let session;
    try {
      session = await createScanSession({
        supabase: supabaseAdmin,
        userId,
        provider: "gmail",
        cursor: parsed.data.options.cursor ?? null,
        options: { ...parsed.data.options },
      });
    } catch (e) {
      e.statusCode = 500;
      e.code = e.code || "SESSION_CREATE_FAILED";
      throw e;
    }

    // Stage 3: hello event
    try {
      await writeEvent({
        supabase: supabaseAdmin,
        sessionId: session.id,
        userId,
        type: "hello",
        payload: { ok: true, sessionId: session.id },
        dedupeKey: `hello:${session.id}`,
      });
    } catch (e) {
      // Not fatal, but loggable
      req.log.warn({ err: e }, "writeEvent_failed");
    }

    // Stage 4: enqueue first chunk (this is the #1 failure source)
    try {
      await enqueueScanChunk({ sessionId: session.id });
    } catch (e) {
      // ✅ Return a useful error instead of opaque 500
      return reply.code(e.statusCode || 503).send({
        error: "queue_unavailable",
        code: e.code || "QUEUE_ENQUEUE_FAILED",
        message: process.env.DEBUG_ERRORS === "true" ? e.message : "Queue unavailable",
        sessionId: session.id, // still return so you can show UI state
      });
    }

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
    // Patch 3: persist extracted signals (price_change/trial/receipt) for downstream views.
  try {
    const list = Array.isArray(candidates) ? candidates : [];
    for (const c of list) {
      await ingestCandidateSignals({ supabase: supabaseAdmin, userId: req.userId, candidate: c });
    }
  } catch (_) {}

  return { ok: true };
  });

// ✅ Canonicalize: confirm candidate → real subscription (idempotent)
const ConfirmSubscriptionSchema = z.object({
  sessionId: z.string().uuid().optional(),
  fingerprint: z.string().optional(),
  candidate: z.any().optional(),
  overrides: z.any().optional(),
  provider: z.string().optional(),
});

server.post("/v1/subscriptions/confirm", async (req, reply) => {
  const parsed = ConfirmSubscriptionSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });

  const userId = req.userId;
  const { sessionId, fingerprint, candidate: candIn, provider } = parsed.data;

  let candidate = candIn || null;

  // Prefer pulling from scan_candidates to avoid client spoofing + keep proofs consistent
  if (!candidate && sessionId && fingerprint) {
    const { data: row, error } = await supabaseAdmin
      .from("scan_candidates")
      .select("candidate")
      .eq("session_id", sessionId)
      .eq("user_id", userId)
      .eq("fingerprint", fingerprint)
      .maybeSingle();

    if (error) return reply.code(500).send({ error: "db_error", message: error.message });
    candidate = row?.candidate || null;
  }

  if (!candidate) return reply.code(400).send({ error: "missing_candidate" });

  // Contract: evidenceSamples always present (array)
  if (!Array.isArray(candidate.evidenceSamples)) candidate.evidenceSamples = candidate.evidence ? [candidate.evidence] : [];

  const out = await confirmCandidateAsSubscription({
    supabase: supabaseAdmin,
    userId,
    candidate,
    provider: provider || "gmail",
  });

  return out;
});

// ✅ Manual add fallback (“can’t find it”)
const ManualSubscriptionSchema = z.object({
  brandName: z.string().min(1),
  plan: z.string().optional(),
  amount: z.number().optional(),
  currency: z.string().optional(),
  cadence: z.string().optional(),
  nextChargeAt: z.string().optional(),
});

server.post("/v1/subscriptions/manual", async (req, reply) => {
  const parsed = ManualSubscriptionSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });

  const userId = req.userId;
  const out = await manualAddSubscription({ supabase: supabaseAdmin, userId, payload: parsed.data });
  return out;
});

// ✅ Upload receipt screenshot/PDF (alpha contract: JSON base64; multipart can come later)
const UploadSchema = z.object({
  filename: z.string().optional(),
  mimeType: z.string().optional(),
  base64: z.string().min(10),
});

server.post("/v1/subscriptions/upload", async (req, reply) => {
  const parsed = UploadSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });

  const buf = Buffer.from(parsed.data.base64, "base64");
  const result = await parseReceiptUpload({
    filename: parsed.data.filename || "upload",
    mimeType: parsed.data.mimeType || "application/octet-stream",
    buffer: buf,
  });

  return result;
});

// ✅ Price changes view (pull from signals)
server.get("/v1/price-changes", async (req, reply) => {
  const userId = req.userId;
  const { data, error } = await supabaseAdmin
    .from("signals")
    .select("id,type,confidence,extracted,created_at,email_message_id")
    .eq("user_id", userId)
    .eq("type", "price_change")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) return reply.code(500).send({ error: "db_error", message: error.message });
  return { items: data || [] };
});

/** Patch 2: Renewals views (product surface) */
server.get("/v1/renewals/upcoming", async (req, reply) => {
  const windowDays = Math.min(Math.max(Number(req.query?.windowDays ?? 30), 1), 365);
  const now = new Date();
  const end = new Date(now);
  end.setUTCDate(end.getUTCDate() + windowDays);

  const { data: subs, error } = await supabaseAdmin
    .from("subscriptions")
    .select("*")
    .eq("user_id", req.userId)
    .not("next_charge_at", "is", null);

  if (error) return reply.code(500).send({ error: "db_error", message: error.message });

  const upcoming = (subs || [])
    .filter((s) => {
      const t = new Date(s.next_charge_at).getTime();
      return t >= now.getTime() && t <= end.getTime();
    })
    .sort((a, b) => new Date(a.next_charge_at) - new Date(b.next_charge_at));

  return { ok: true, windowDays, count: upcoming.length, items: upcoming };
});

server.get("/v1/renewals/week-total", async (req, reply) => {
  const weekStart = req.query?.weekStart || new Date().toISOString();

  const { data: subs, error } = await supabaseAdmin
    .from("subscriptions")
    .select("*")
    .eq("user_id", req.userId)
    .not("next_charge_at", "is", null);

  if (error) return reply.code(500).send({ error: "db_error", message: error.message });

  return { ok: true, ...weeklyTotal(subs || [], weekStart) };
});

/** Patch 2: Trials views + notification preview (scheduler stub) */
server.get("/v1/trials", async (req, reply) => {
  const { data: trials, error } = await supabaseAdmin.from("trials").select("*").eq("user_id", req.userId);
  if (error) return reply.code(500).send({ error: "db_error", message: error.message });

  const now = new Date();
  const active = (trials || []).filter((t) => isActiveTrial(t, now)).sort((a, b) => new Date(a.ends_at) - new Date(b.ends_at));
  return { ok: true, count: active.length, items: active };
});

server.get("/v1/trials/upcoming", async (req, reply) => {
  const windowDays = Math.min(Math.max(Number(req.query?.windowDays ?? 7), 1), 60);
  const { data: trials, error } = await supabaseAdmin.from("trials").select("*").eq("user_id", req.userId);
  if (error) return reply.code(500).send({ error: "db_error", message: error.message });

  const upcoming = trialNudgeWindow(trials || [], windowDays, new Date());
  return { ok: true, windowDays, count: upcoming.length, items: upcoming };
});

server.get("/v1/trials/notifications/preview", async (req, reply) => {
  const { data: trials, error } = await supabaseAdmin.from("trials").select("*").eq("user_id", req.userId);
  if (error) return reply.code(500).send({ error: "db_error", message: error.message });

  const notifications = computeTrialNotifications(trials || [], new Date());
  return { ok: true, count: notifications.length, items: notifications };
});

/** Patch 2: Brand resolve + assets (logo pipeline stub) */
server.post("/v1/brand/resolve", async (req, reply) => {
  const schema = z.object({
    fromDomain: z.string().optional(),
    senderName: z.string().optional(),
    subject: z.string().optional(),
    unsubscribeDomain: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });

  const out = await resolveBrand({ supabase: supabaseAdmin, input: parsed.data });
  return { ok: true, ...out };
});

server.get("/v1/brand/:brandId/assets", async (req, reply) => {
  const out = await getBrandAssets({ supabase: supabaseAdmin, brandId: req.params.brandId });
  return { ok: true, ...out };
});

server.post("/v1/brand/:brandId/refresh-assets", async (req, reply) => {
  const out = await refreshBrandAssets({ supabase: supabaseAdmin, brandId: req.params.brandId });
  return { ok: true, ...out };
});


  // ✅ Debug endpoint: “why stuck / why 0 results”


/** Patch 3: Bill optimization (v0) */
server.get("/v1/optimization/plan/:subscriptionId", async (req, reply) => {
  try {
    const out = await getPlanOptimization({ supabase: supabaseAdmin, userId: req.userId, subscriptionId: req.params.subscriptionId });
    return { ok: true, ...out };
  } catch (e) {
    return reply.code(500).send({ error: "optimization_error", message: String(e?.message || e) });
  }
});


server.get("/v1/optimization/regional", async (req, reply) => {
  const country = req.query?.country || null;
  const out = await getRegionalOptimizations({ country });
  return { ok: true, ...out };
});
server.get("/v1/optimization/duplicates", async (req, reply) => {
  const out = await getDuplicateCoverage({ supabase: supabaseAdmin, userId: req.userId });
  return { ok: true, ...out };
});

/** Patch 3: Cancellation playbooks Tier 0 */

/** Patch 4: Cancellation templates Tier 1 */
server.post("/v1/cancel/templates", async (req, reply) => {
  const schema = z.object({
    brandName: z.string().optional(),
    country: z.string().optional(),
    accountEmail: z.string().email().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });

  const out = buildCancelTemplates(parsed.data);
  return { ok: true, ...out };
});
server.get("/v1/cancel/playbook/:brandId", async (req, reply) => {
  const country = req.query?.country || null;
  try {
    const out = await getCancelPlaybook({ supabase: supabaseAdmin, userId: req.userId, brandId: req.params.brandId, country });
    return { ok: true, ...out };
  } catch (e) {
    return reply.code(500).send({ error: "playbook_error", message: String(e?.message || e) });
  }
});

/** Patch 4: Cancellation concierge Tier 2 (request tracking only) */
server.post("/v1/cancel/requests", async (req, reply) => {
  const schema = z.object({
    brandId: z.string().uuid().optional(),
    country: z.string().optional(),
    notes: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });

  const { data, error } = await supabaseAdmin
    .from("cancel_requests")
    .insert({
      user_id: req.userId,
      brand_id: parsed.data.brandId ?? null,
      country: parsed.data.country ?? null,
      notes: parsed.data.notes ?? null,
      status: "queued",
    })
    .select("*")
    .single();

  if (error) return reply.code(500).send({ error: "db_error", message: error.message });
  return { ok: true, request: data };
});

server.get("/v1/cancel/requests/:id", async (req, reply) => {
  const { data, error } = await supabaseAdmin
    .from("cancel_requests")
    .select("*")
    .eq("id", req.params.id)
    .eq("user_id", req.userId)
    .single();

  if (error) return reply.code(404).send({ error: "not_found", message: error.message });

  const { data: updates } = await supabaseAdmin
    .from("cancel_request_updates")
    .select("*")
    .eq("request_id", req.params.id)
    .order("created_at", { ascending: false });

  return { ok: true, request: data, updates: updates || [] };
});

// Internal/admin-style update endpoint (still auth-gated by your JWT middleware)

server.post("/v1/cancel/requests/:id/send", async (req, reply) => {
  const schema = z.object({
    to: z.string().email(),
    subject: z.string().min(1),
    body: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });

  // Verify ownership
  const { data: reqRow, error: rErr } = await supabaseAdmin
    .from("cancel_requests")
    .select("*")
    .eq("id", req.params.id)
    .eq("user_id", req.userId)
    .single();
  if (rErr) return reply.code(404).send({ error: "not_found", message: rErr.message });

  const queued = await queueRelayEmail({
    supabase: supabaseAdmin,
    requestId: req.params.id,
    to: parsed.data.to,
    subject: parsed.data.subject,
    body: parsed.data.body,
  });

  await recordCancelMessage({
    supabase: supabaseAdmin,
    requestId: req.params.id,
    direction: "outbound",
    channel: "email",
    subject: parsed.data.subject,
    body: parsed.data.body,
    toAddress: parsed.data.to,
    fromAddress: reqRow.relay_email || null,
    externalId: queued.id,
  });

  return { ok: true, queued };
});

server.post("/v1/cancel/requests/:id/inbound", async (req, reply) => {
  // Inbound webhook placeholder (e.g., from your relay inbox provider)
  const schema = z.object({
    from: z.string().email().optional(),
    subject: z.string().optional(),
    body: z.string().optional(),
    externalId: z.string().optional(),
    status: z.enum(["queued","in_progress","waiting_user","done","failed"]).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });

  // Ownership check
  const { data: reqRow, error: rErr } = await supabaseAdmin
    .from("cancel_requests")
    .select("*")
    .eq("id", req.params.id)
    .eq("user_id", req.userId)
    .single();
  if (rErr) return reply.code(404).send({ error: "not_found", message: rErr.message });

  await recordCancelMessage({
    supabase: supabaseAdmin,
    requestId: req.params.id,
    direction: "inbound",
    channel: "email",
    subject: parsed.data.subject ?? null,
    body: parsed.data.body ?? null,
    toAddress: reqRow.relay_email || null,
    fromAddress: parsed.data.from ?? null,
    externalId: parsed.data.externalId ?? null,
  });

  if (parsed.data.status) {
    await supabaseAdmin
      .from("cancel_requests")
      .update({ status: parsed.data.status, updated_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .eq("user_id", req.userId);
  }

  return { ok: true };
});
server.post("/v1/cancel/requests/:id/updates", async (req, reply) => {
  const schema = z.object({
    status: z.enum(["queued","in_progress","waiting_user","done","failed"]).optional(),
    note: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });

  // Update request status if provided
  if (parsed.data.status) {
    await supabaseAdmin
      .from("cancel_requests")
      .update({ status: parsed.data.status, updated_at: new Date().toISOString() })
      .eq("id", req.params.id);
  }

  const { data, error } = await supabaseAdmin
    .from("cancel_request_updates")
    .insert({ request_id: req.params.id, status: parsed.data.status ?? null, note: parsed.data.note ?? null })
    .select("*")
    .single();

  if (error) return reply.code(500).send({ error: "db_error", message: error.message });
  return { ok: true, update: data };
});

/** Patch 6: Admin relay outbox processing (for alpha) */
server.post("/v1/admin/relay/process", async (req, reply) => {
  const limit = Math.min(Math.max(Number(req.query?.limit ?? 10), 1), 50);
  try {
    const out = await processRelayOutbox({ supabase: supabaseAdmin, limit });
    return { ok: true, ...out };
  } catch (e) {
    return reply.code(500).send({ error: "relay_error", message: String(e?.message || e) });
  }
});
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
