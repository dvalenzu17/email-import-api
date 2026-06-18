import { requireUser } from "../lib/auth.js";
import { getUserDataExport } from "../db/index.js";

export function registerAccountRoutes(server) {
  // ── GET /account/export ─────────────────────────────────────────────────
  // GDPR data export — returns all user data as JSON.
  // Includes subscriptions, scan metadata, subscription events, feedback,
  // and connected account metadata (no raw tokens or passwords).
  server.get("/account/export", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    try {
      const data = await getUserDataExport(userId);
      return {
        exportedAt: new Date().toISOString(),
        userId,
        ...data,
      };
    } catch (err) {
      req.log.error({ err }, "gdpr_export_error");
      return reply.code(500).send({ error: "export_failed" });
    }
  });
}
