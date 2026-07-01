import * as Sentry from "@sentry/node";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifySse from "fastify-sse-v2";
import "dotenv/config";
import { registerScanRoutes } from "./routes/scanRoutes.js";
import { registerSubscriptionRoutes } from "./routes/subscriptionRoutes.js";
import { registerOAuthRoutes } from "./routes/oauthRoutes.js";
import { registerImapScanRoutes } from "./routes/imapScanRoutes.js";
import { registerAdminRoutes } from "./routes/adminRoutes.js";
import { registerAccountRoutes } from "./routes/accountRoutes.js";
import { registerGmailPushRoutes } from "./routes/gmailPushRoutes.js";
import { pool } from "./db/index.js";
// TASK 3: Load merchant alias cache from DB on startup so extractMerchant()
// can resolve domain → canonical_name mappings without a per-email DB query.
import { loadMerchantAliasCache } from "./services/emailParser.js";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "production",
    tracesSampleRate: 0.1,
  });
}

const QUEUE_ENABLED = process.env.QUEUE_ENABLED === "true";
const BACKGROUND_SCAN_ENABLED = process.env.BACKGROUND_SCAN_ENABLED === "true";

const server = Fastify({ logger: true });

server.setErrorHandler((error, request, reply) => {
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(error, {
      extra: { userId: request.userId, method: request.method, url: request.url },
    });
  }
  request.log.error({ err: error }, "unhandled_error");
  reply.code(error.statusCode || 500).send({ error: "internal_error" });
});

const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
  : true;

await server.register(cors, { origin: corsOrigins });

await server.register(rateLimit, {
  global: false, // only apply where explicitly set
});

// SSE support — used by GET /scan/:jobId/events
await server.register(fastifySse);

// Add Retry-After header to all 429 responses (rate limit windows are 15 minutes)
server.addHook("onSend", async (_req, reply) => {
  if (reply.statusCode === 429) {
    reply.header("Retry-After", "900");
  }
});

registerScanRoutes(server);
registerSubscriptionRoutes(server);
registerOAuthRoutes(server);
registerImapScanRoutes(server);
registerAdminRoutes(server);
registerAccountRoutes(server);
registerGmailPushRoutes(server);

server.get("/", async () => {
  return { status: "ok" };
});

const start = async () => {
  try {
    // TASK 3: Pre-load merchant alias cache so the first scan request doesn't
    // have to wait for a DB round-trip. Fails silently if the table doesn't
    // exist yet (before the migration runs).
    await loadMerchantAliasCache(pool);
    server.log.info("Merchant alias cache loaded");

    // Start BullMQ Worker if queue mode is enabled
    if (QUEUE_ENABLED) {
      const { startWorker } = await import("./services/scanQueue.js");
      startWorker(server.log);
      server.log.info("BullMQ Worker started (gmail-scan queue)");
    }

    // Start the background (cron) scanner if enabled. Re-scans connected
    // accounts periodically so new-subscription pushes fire even when the app
    // is closed.
    if (BACKGROUND_SCAN_ENABLED) {
      const { startBackgroundScanner, startAlertScheduler } = await import("./services/backgroundScanner.js");
      startBackgroundScanner(server.log);
      // Escalating renewal/trial reminders run on their own tighter cadence.
      startAlertScheduler(server.log);
    }

    const port = parseInt(process.env.PORT, 10) || 8787;
    await server.listen({ port, host: "0.0.0.0" });
    server.log.info(`Server running on http://localhost:${port} [queue=${QUEUE_ENABLED}]`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
