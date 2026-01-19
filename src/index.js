// src/index.js
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import "dotenv/config";
import fastifySSE from "@fastify/sse";

import { verifySupabaseJwt } from "./lib/jwt.js";
import { verifyImapConnection, scanImap } from "./lib/imap.js";
import { scanGmail } from "./lib/gmail.js";
import { getMerchantDirectoryCached, getUserOverrides } from "./lib/merchantData.js";

const PORT = Number(process.env.PORT ?? 8787);
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error("Missing env SUPABASE_JWT_SECRET");
}

const server = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.x-gmail-access-token",
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
await server.register(fastifySSE); // ✅ SSE support :contentReference[oaicite:2]{index=2}

// Global limiter: conservative for “normal” endpoints
await server.register(rateLimit, {
  max: 30,
  timeWindow: "1 minute",
  keyGenerator: (req) => req.userId ?? req.ip,
});

// ---- Auth hook (required) ----
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

server.get("/health", async () => ({ ok: true }));

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
      maxMessages: z.number().int().min(1).max(5000).default(500),
      maxCandidates: z.number().int().min(1).max(200).default(60),
      cursor: z.string().optional(),
    })
    .default({}),
});

server.post(
  "/v1/email/scan",
  { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
  async (req, reply) => {
    const parsed = ScanBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
    }

    const { provider, imap, auth, options } = parsed.data;

    try {
      const result = await scanImap({ provider, imap, auth, options, userId: req.userId });
      return { ok: true, stats: result.stats, candidates: result.candidates, nextCursor: result.nextCursor };
    } catch (e) {
      req.log.warn({ err: e }, "imap_scan_failed");
      return reply.code(400).send({ ok: false, error: mapImapError(e) });
    }
  }
);

/** --------------------------
 * Gmail OAuth: scan (chunked)
 * -------------------------- */
const GmailScanBodySchema = z.object({
  auth: z.object({
    accessToken: z.string().min(10),
  }),
  options: z
    .object({
      daysBack: z.number().int().min(1).max(3650).default(365),
      maxCandidates: z.number().int().min(1).max(200).default(80),
      cursor: z.string().optional(),
      pageSize: z.number().int().min(50).max(500).optional(), // max 500 :contentReference[oaicite:3]{index=3}
      deadlineMs: z.number().int().min(8000).max(45000).optional(),
      fullFetchCap: z.number().int().min(10).max(120).optional(),
      concurrency: z.number().int().min(2).max(10).optional(),
      timeouts: z
        .object({
          listMs: z.number().int().min(3000).max(15000).optional(),
          metaMs: z.number().int().min(3000).max(15000).optional(),
          fullMs: z.number().int().min(3000).max(20000).optional(),
          attachMs: z.number().int().min(3000).max(20000).optional(),
        })
        .optional(),
    })
    .default({}),
});

server.post(
  "/v1/gmail/scan",
  { config: { rateLimit: { max: 180, timeWindow: "1 minute" } } },
  async (req, reply) => {
    const parsed = GmailScanBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
    }

    try {
      const directory = await getMerchantDirectoryCached();
      const overrides = await getUserOverrides(req.userId);

      const result = await scanGmail({
        accessToken: parsed.data.auth.accessToken,
        options: parsed.data.options,
        context: { directory, overrides },
      });

      return { ok: true, stats: result.stats, candidates: result.candidates, nextCursor: result.nextCursor };
    } catch (e) {
      req.log.warn({ err: e }, "gmail_scan_failed");
      return reply.code(400).send({
        ok: false,
        error: { code: "GMAIL_SCAN_FAILED", message: String(e?.message ?? e) },
      });
    }
  }
);

/** --------------------------
 * Gmail OAuth: SSE stream (LIVE results)
 * -------------------------- */
const GmailStreamQuerySchema = z.object({
  cursor: z.string().optional(),
  daysBack: z.coerce.number().int().min(1).max(3650).optional(),
  pageSize: z.coerce.number().int().min(50).max(500).optional(),
  deadlineMs: z.coerce.number().int().min(8000).max(45000).optional(),
  fullFetchCap: z.coerce.number().int().min(10).max(120).optional(),
  concurrency: z.coerce.number().int().min(2).max(10).optional(),
  maxPages: z.coerce.number().int().min(1).max(60).optional(),
});

server.get(
  "/v1/gmail/scan/stream",
  { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
  async (req, reply) => {
    const parsed = GmailStreamQuerySchema.safeParse(req.query || {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
    }

    const accessToken = req.headers["x-gmail-access-token"];
    if (!accessToken || typeof accessToken !== "string" || accessToken.length < 10) {
      return reply.code(400).send({ error: "missing_x_gmail_access_token" });
    }

    const directory = await getMerchantDirectoryCached();
    const overrides = await getUserOverrides(req.userId);

    const baseOptions = {
      daysBack: parsed.data.daysBack ?? 365,
      pageSize: parsed.data.pageSize ?? 500,
      deadlineMs: parsed.data.deadlineMs ?? 25000,
      fullFetchCap: parsed.data.fullFetchCap ?? 70,
      concurrency: parsed.data.concurrency ?? 6,
      maxCandidates: 120,
    };

    let cursor = parsed.data.cursor ?? null;
    let pages = 0;
    const maxPages = parsed.data.maxPages ?? 30;

    let totalFound = 0;
    let totalScanned = 0;

    return reply.sse((async function* () {
      yield { event: "hello", data: { ok: true } };

      try {
        while (pages < maxPages) {
          pages += 1;

          const result = await scanGmail({
            accessToken,
            options: { ...baseOptions, cursor: cursor || undefined },
            context: { directory, overrides },
          });

          cursor = result?.nextCursor ?? null;
          totalFound += (result?.candidates?.length || 0);
          totalScanned += Number(result?.stats?.scanned || 0);

          yield {
            event: "progress",
            data: {
              ...result.stats,
              pages,
              scannedTotal: totalScanned,
              foundTotal: totalFound,
              cursor,
            },
          };

          if (result?.candidates?.length) {
            yield { event: "candidates", data: { candidates: result.candidates } };
          }

          if (!cursor) break;
        }

        yield { event: "done", data: { ok: true, pages, scannedTotal: totalScanned, foundTotal: totalFound } };
      } catch (e) {
        yield { event: "error", data: { ok: false, message: String(e?.message ?? e) } };
      }
    })());
  }
);

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
