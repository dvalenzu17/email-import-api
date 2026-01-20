// src/server.js
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";

import { verifySupabaseJwt } from "./lib/jwt.js";
import { supabaseAdmin } from "./lib/supabaseAdmin.js";
import { getMerchantDirectoryCached, getUserOverrides } from "./lib/merchantData.js";
import { createScanSession, getScanSession } from "./lib/scanStore.js";
import { writeEvent, streamEvents } from "./lib/eventStore.js";
import { verifyImapConnection, scanImap } from "./lib/imap.js";
import { enqueueScanChunk } from "./queue/scanQueue.js";
import { upsertGoogleTokens } from "./lib/tokenStore.js";
import { metricsHandler } from "./telemetry/metrics.js";

export async function buildServer() {
  const server = Fastify({ logger: true });

  await server.register(cors, { origin: true });
  await server.register(rateLimit, { global: true, max: 200, timeWindow: "1 minute" });

  server.supabaseAdmin = supabaseAdmin;
  server.getMerchantDirectory = async () => getMerchantDirectoryCached({ supabase: supabaseAdmin });
  server.getUserOverrides = async (userId) => getUserOverrides({ supabase: supabaseAdmin, userId });

  const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

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

  server.get("/health", async () => ({ ok: true }));
  server.get("/metrics", metricsHandler);

  // ✅ keep your existing routes below (unchanged)
  // ... (merchant confirm, gmail scan start/stream/run, imap verify/scan)

  return server;
}
