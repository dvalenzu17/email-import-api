import jwt from "jsonwebtoken";
import {
  getSubscriptions,
  getLatestScanMetadata,
} from "../db/index.js";

export function registerSubscriptionRoutes(server) {
  server.get("/subscriptions", async (req, reply) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.split(" ")[1];

    if (!token) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    let userId;

    try {
      const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET);
      userId = decoded.sub;
    } catch {
      return reply.code(401).send({ error: "invalid_token" });
    }

    if (!userId) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    try {
      const subs = await getSubscriptions(userId);
      const latestScan = await getLatestScanMetadata(userId);

      return {
        subscriptions: subs.map((s) => ({
          id: s.id,
          merchant: s.merchant,
          renewalAmount: Number(s.renewal_amount),
          currency: s.currency,
          renewalDate: s.renewal_date
            ? new Date(s.renewal_date).toISOString()
            : null,
          confidence: Number(s.confidence),
          isActive: s.is_active,
          isSuggested: s.is_suggested,
          source: s.source,
        })),
        meta: latestScan
          ? {
              scannedMessages: latestScan.scanned_messages,
              detectedCharges: latestScan.detected_charges,
              executionTimeMs: latestScan.execution_time_ms,
            }
          : {
              scannedMessages: 0,
              detectedCharges: 0,
              executionTimeMs: 0,
            },
      };
    } catch (err) {
      server.log.error(err);
      return reply.code(500).send({ error: "fetch_failed" });
    }
  });
}
