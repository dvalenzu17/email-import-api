import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";

import { supabaseAdmin } from "./lib/supabaseAdmin.js";
import { verifySupabaseJwt } from "./lib/jwt.js";
import { verifyImapConnection, scanImap } from "./lib/imap.js";
import { scanGmail } from "./lib/gmail.js";
import {
  getMerchantDirectoryCached,
  getUserOverrides,
  getUserSubscriptionSignals,
} from "./lib/merchantData.js";

const PORT = Number(process.env.PORT ?? 8787);
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!JWT_SECRET) throw new Error("Missing env SUPABASE_JWT_SECRET");

const server = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: [
        "req.headers.authorization",
        "req.body.auth.pass",
        "req.body.auth.password",
        "req.body.auth.accessToken",
        "req.body.auth.refreshToken",
      ],
      remove: true,
    },
  },
});

await server.register(cors, { origin: true, credentials: true });

await server.register(rateLimit, {
  max: 30,
  timeWindow: "1 minute",
  keyGenerator: (req) => req.userId ?? req.ip,
});

// ---- Public health ----
server.get("/health", async () => ({ ok: true }));

// ---- Auth hook (required for everything else) ----
server.addHook("preHandler", async (req, reply) => {
  if (req.url === "/health") return;

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

/** --------------------------
 * IMAP: verify + scan
 * -------------------------- */
const ProviderSchema = z.enum(["icloud", "yahoo", "aol", "other"]);

const ImapSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
});

const AuthSchema = z.object({
  user: z.string().min(3),
  pass: z.string().min(3),
});

const VerifyBodySchema = z.object({
  provider: ProviderSchema,
  imap: ImapSchema,
  auth: AuthSchema,
});

server.post("/v1/email/verify", async (req, reply) => {
  const parsed = VerifyBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
  }

  const { provider, imap, auth } = parsed.data;

  try {
    const result = await verifyImapConnection({ provider, imap, auth });
    return { ok: true, mailbox: result.mailbox, capabilities: result.capabilities };
  } catch (e) {
    req.log.warn({ err: e, provider }, "imap_verify_failed");
    return reply.code(400).send({ ok: false, error: mapImapError(e) });
  }
});

const ScanBodySchema = z.object({
  provider: ProviderSchema,
  imap: ImapSchema,
  auth: AuthSchema,
  options: z
    .object({
      daysBack: z.number().int().min(1).max(3650).default(180),
      maxMessages: z.number().int().min(1).max(500).default(250),
      maxCandidates: z.number().int().min(1).max(200).default(60),
      cursor: z.string().optional(),
    })
    .default({}),
});

server.post("/v1/email/scan", async (req, reply) => {
  const parsed = ScanBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
  }

  const { provider, imap, auth, options } = parsed.data;

  try {
    const directory = await getMerchantDirectoryCached();
    const overrides = await getUserOverrides(req.userId);
    const knownSubs = await getUserSubscriptionSignals(req.userId);

    const result = await scanImap({
      provider,
      imap,
      auth,
      options,
      context: { directory, overrides, knownSubs },
    });

    return { ok: true, stats: result.stats, candidates: result.candidates, nextCursor: result.nextCursor };
  } catch (e) {
    req.log.warn({ err: e, provider }, "imap_scan_failed");
    return reply.code(400).send({ ok: false, error: mapImapError(e) });
  }
});

/** --------------------------
 * Gmail OAuth: scan
 * -------------------------- */
const GmailScanBodySchema = z.object({
  auth: z.object({
    accessToken: z.string().min(10),
  }),
  options: z
    .object({
      daysBack: z.number().int().min(1).max(3650).default(365),
      maxMessages: z.number().int().min(1).max(500).default(300),
      maxCandidates: z.number().int().min(1).max(200).default(80),
      cursor: z.string().optional(), // pageToken
    })
    .default({}),
});

server.post("/v1/gmail/scan", async (req, reply) => {
  const parsed = GmailScanBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
  }

  try {
    const directory = await getMerchantDirectoryCached();
    const overrides = await getUserOverrides(req.userId);
    const knownSubs = await getUserSubscriptionSignals(req.userId);

    const result = await scanGmail({
      accessToken: parsed.data.auth.accessToken,
      options: parsed.data.options,
      context: { directory, overrides, knownSubs },
    });

    return { ok: true, stats: result.stats, candidates: result.candidates, nextCursor: result.nextCursor };
  } catch (e) {
    req.log.warn({ err: e }, "gmail_scan_failed");
    return reply.code(400).send({
      ok: false,
      error: { code: "GMAIL_SCAN_FAILED", message: String(e?.message ?? e) },
    });
  }
});

/** --------------------------
 * Confirm merchant override
 * -------------------------- */
const ConfirmMerchantSchema = z.object({
  from: z.string().optional(), // raw From header like: "WaterLlama <billing@waterllama.com>"
  senderEmail: z.string().email().optional(),
  senderDomain: z.string().min(3).optional(),
  canonicalName: z.string().min(2).max(80),
});

function extractSender(from) {
  const s = String(from || "");
  const m = s.match(/<([^>]+)>/);
  const email = String(m?.[1] ?? s).trim().toLowerCase();
  const at = email.lastIndexOf("@");
  const domain = at === -1 ? null : email.slice(at + 1);
  return { email: email || null, domain: domain || null };
}

server.post("/v1/merchant/confirm", async (req, reply) => {
  const parsed = ConfirmMerchantSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
  }

  const { canonicalName } = parsed.data;

  let senderEmail = parsed.data.senderEmail?.toLowerCase() ?? null;
  let senderDomain = parsed.data.senderDomain?.toLowerCase() ?? null;

  if ((!senderEmail && !senderDomain) && parsed.data.from) {
    const derived = extractSender(parsed.data.from);
    senderEmail = derived.email;
    senderDomain = derived.domain;
  }

  if (!senderEmail && !senderDomain) {
    return reply.code(400).send({ error: "missing_sender", message: "Provide from OR senderEmail OR senderDomain" });
  }

  // Your rule: gmail.com is NOT a company identity signal
  if (senderDomain === "gmail.com" || (senderEmail && senderEmail.endsWith("@gmail.com"))) {
    return reply.code(400).send({ error: "consumer_sender_not_allowed", message: "gmail.com senders cannot be used as merchant identity" });
  }

  const row = senderEmail
    ? { user_id: req.userId, sender_email: senderEmail, sender_domain: null, canonical_name: canonicalName }
    : { user_id: req.userId, sender_email: null, sender_domain: senderDomain, canonical_name: canonicalName };

  const { data, error } = await supabaseAdmin
    .from("user_merchant_overrides")
    .upsert(row, { onConflict: senderEmail ? "user_id,sender_email" : "user_id,sender_domain" })
    .select("id, user_id, sender_email, sender_domain, canonical_name")
    .single();

  if (error) {
    req.log.warn({ err: error }, "confirm_merchant_failed");
    return reply.code(500).send({ error: "confirm_failed" });
  }

  return { ok: true, override: data };
});

function mapImapError(e) {
  const msg = String(e?.message ?? e);

  if (/AUTHENTICATIONFAILED|Invalid credentials|Login failed/i.test(msg)) {
    return { code: "AUTH_FAILED", message: "Login failed. Check email + app password." };
  }
  if (/Application-specific password|app password|2-step|two-factor|2fa/i.test(msg)) {
    return { code: "NEEDS_APP_PASSWORD", message: "Provider requires an app-specific password." };
  }
  if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND/i.test(msg)) {
    return { code: "NETWORK_ERROR", message: "Network error connecting to mail server." };
  }
  return { code: "UNKNOWN", message: "Could not connect. Try again or check server settings." };
}

await server.listen({ port: PORT, host: "0.0.0.0" });
server.log.info({ port: PORT }, "sublytics-email-import-api listening");
