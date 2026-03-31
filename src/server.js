import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import fastifySse from "fastify-sse-v2";
import "dotenv/config";
import { registerScanRoutes } from "./routes/scanRoutes.js";
import { registerSubscriptionRoutes } from "./routes/subscriptionRoutes.js";
import { registerOAuthRoutes } from "./routes/oauthRoutes.js";
import { registerImapScanRoutes } from "./routes/imapScanRoutes.js";

const QUEUE_ENABLED = process.env.QUEUE_ENABLED === "true";

const server = Fastify({ logger: true });

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

server.get("/", async () => {
  return { status: "ok" };
});

const start = async () => {
  try {
    // Start BullMQ Worker if queue mode is enabled
    if (QUEUE_ENABLED) {
      const { startWorker } = await import("./services/scanQueue.js");
      startWorker(server.log);
      server.log.info("BullMQ Worker started (gmail-scan queue)");
    }

    await server.listen({ port: 8787, host: "0.0.0.0" });
    server.log.info(`Server running on http://localhost:8787 [queue=${QUEUE_ENABLED}]`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
