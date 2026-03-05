import Fastify from "fastify";
import "dotenv/config";
import jwt from "jsonwebtoken";
import { pool } from "./db/index.js";
import { registerScanRoutes } from "./routes/scanRoutes.js";
import { registerSubscriptionRoutes } from "./routes/subscriptionRoutes.js";
import { exchangeCodeForTokens } from "./googleOAuth.js";
import { registerOAuthRoutes } from "./routes/oauthRoutes.js";


const server = Fastify({ logger: true });

// Register routes
registerScanRoutes(server);
registerSubscriptionRoutes(server);
registerOAuthRoutes(server);


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

    const decoded = jwt.verify(
      token,
      process.env.SUPABASE_JWT_SECRET
    );

    const userId = decoded.sub;

    const { code, redirectUri } = req.body;

    const tokens = await exchangeCodeForTokens({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      redirectUri,
      code,
    });

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
        userId,
        tokens.accessToken,
        tokens.refreshToken,
        tokens.expiresIn
      ]
    );

    return { success: true };

  } catch (err) {
    console.error(err);
    return reply.code(500).send({ error: "connect_failed" });
  }
});

start();