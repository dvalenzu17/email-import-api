import { parsePushEnvelope, verifyPushToken } from "../services/gmailPushUtil.js";
import { handleGmailPush } from "../services/gmailPush.js";

/**
 * Pub/Sub push endpoint for Gmail real-time notifications.
 *
 * Not behind requireUser — Google Pub/Sub calls it with no Supabase JWT.
 * Authenticated by a shared secret in the URL (?token=...) that only Pub/Sub
 * and this server know. Always ACK (2xx) once authenticated so Pub/Sub doesn't
 * redeliver; processing happens in the background.
 */
export function registerGmailPushRoutes(server) {
  server.post("/webhooks/gmail/push", async (req, reply) => {
    if (!verifyPushToken(process.env.GMAIL_PUSH_VERIFICATION_TOKEN, req.query?.token)) {
      return reply.code(403).send({ error: "forbidden" });
    }

    const decoded = parsePushEnvelope(req.body);
    if (!decoded) {
      // Malformed/unknown shape — ack so Pub/Sub stops retrying a bad message.
      req.log.warn("gmail_push_unparseable");
      return reply.code(204).send();
    }

    try {
      await handleGmailPush(decoded, req.log);
    } catch (err) {
      req.log.error({ err: err?.message }, "gmail_push_handle_error");
      // Still ack: a redelivery would hit the same error. The renewal cron and
      // the 6h fallback scan will recover any missed mailbox.
    }
    return reply.code(204).send();
  });
}
