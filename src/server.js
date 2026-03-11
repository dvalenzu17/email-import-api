import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import "dotenv/config";
import { registerScanRoutes } from "./routes/scanRoutes.js";
import { registerSubscriptionRoutes } from "./routes/subscriptionRoutes.js";
import { registerOAuthRoutes } from "./routes/oauthRoutes.js";
import { registerImapScanRoutes } from "./routes/imapScanRoutes.js";

const server = Fastify({ logger: true });

await server.register(rateLimit, {
  global: false, // only apply where explicitly set
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
    await server.listen({ port: 8787, host: "0.0.0.0" });
    console.log("Server running on http://localhost:8787");
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();