import Fastify from "fastify";
import "dotenv/config";
import jwt from "jsonwebtoken";
import { pool } from "./db/index.js";
import { registerScanRoutes } from "./routes/scanRoutes.js";
import { registerSubscriptionRoutes } from "./routes/subscriptionRoutes.js";

const server = Fastify({ logger: true });

// Register routes
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


server.post("/gmail/connect", async (req, reply) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.split(" ")[1];

    if (!token) {
      return reply.code(401).send({ error: "missing_token" });
    }

    // 🔐 Verify Supabase JWT
    const decoded = jwt.verify(
      token,
      process.env.SUPABASE_JWT_SECRET
    );

    const supabaseUserId = decoded.sub;

    const { accessToken, refreshToken, expiresIn } = req.body;

    if (!accessToken || !refreshToken) {
      return reply.code(400).send({ error: "missing_tokens" });
    }

    await pool.query(
      `
      INSERT INTO oauth_tokens (user_id, provider, access_token, refresh_token, expiry_date)
      VALUES ($1, 'google', $2, $3, NOW() + ($4 || ' seconds')::interval)
      ON CONFLICT (user_id, provider)
      DO UPDATE SET
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        expiry_date = EXCLUDED.expiry_date
      `,
      [
        supabaseUserId,
        accessToken,
        refreshToken,
        expiresIn
      ]
    );

    return { success: true };

  } catch (err) {
    console.error("GMAIL CONNECT ERROR:", err);
    return reply.code(500).send({ error: "connect_failed" });
  }
});

start();