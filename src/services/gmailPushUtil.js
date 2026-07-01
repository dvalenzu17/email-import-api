/**
 * Pure helpers for Gmail real-time push (Pub/Sub). No DB/env/network imports so
 * the fiddly envelope decoding and auth checks are unit-testable in isolation.
 *
 * Real-time flow: Gmail `users.watch` publishes a message to a Pub/Sub topic on
 * every inbox change; Pub/Sub POSTs it to our webhook. The push body looks like:
 *   { message: { data: <base64 JSON>, messageId, publishTime }, subscription }
 * where the decoded data is { emailAddress, historyId }.
 */

/**
 * Decodes a Pub/Sub push body into { emailAddress, historyId }, or null if the
 * shape is not what Gmail sends. Never throws.
 *
 * @param {any} body  parsed JSON request body
 * @returns {{ emailAddress: string, historyId: string } | null}
 */
export function parsePushEnvelope(body) {
  const data = body?.message?.data;
  if (typeof data !== "string" || !data) return null;
  let json;
  try {
    json = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
  } catch {
    return null;
  }
  const emailAddress = json?.emailAddress;
  const historyId = json?.historyId;
  if (!emailAddress || historyId == null) return null;
  return { emailAddress: String(emailAddress).toLowerCase(), historyId: String(historyId) };
}

/**
 * Verifies the shared secret carried in the push endpoint URL (?token=...).
 * Fails closed: an unconfigured secret rejects everything. Length-checked
 * before compare to avoid leaking length via early exit.
 *
 * @param {string|undefined} expected  configured secret (env)
 * @param {string|undefined} provided  token from the request query
 */
export function verifyPushToken(expected, provided) {
  if (!expected || typeof provided !== "string") return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

/**
 * Builds the request body for Gmail `users.watch`. Restricts to INBOX so we
 * aren't woken by label churn elsewhere.
 *
 * @param {string} topicName  projects/<project>/topics/<topic>
 */
export function buildWatchRequest(topicName) {
  return {
    topicName,
    labelIds: ["INBOX"],
    labelFilterBehavior: "INCLUDE",
  };
}
