import Fastify from "fastify";
import "dotenv/config";

import { registerOAuthRoutes } from "./oauthRoutes.js";
import { registerScanRoutes } from "./routes/scanRoutes.js";
import { registerSubscriptionRoutes } from "./routes/subscriptionRoutes.js";

const server = Fastify({ logger: true });

// Register routes
registerOAuthRoutes(server);
registerScanRoutes(server);
registerSubscriptionRoutes(server);

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