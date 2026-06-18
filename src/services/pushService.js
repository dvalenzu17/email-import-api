/**
 * Minimal Expo push notification sender.
 *
 * Sends to the Expo push service (https://exp.host/--/api/v2/push/send) in
 * batches of 100 (Expo's per-request cap). Best-effort: this never throws into
 * the scan flow — failures are logged and swallowed.
 *
 * Security: never logs raw tokens (only counts), per the no-credential-logging rule.
 */

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const CHUNK_SIZE = 100;
const FETCH_TIMEOUT_MS = 10_000;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * @param {string[]} tokens   Expo push tokens
 * @param {{ title: string, body: string, data?: object }} payload
 * @param {object} [logger]   pino-like logger (optional)
 * @returns {Promise<{ sent: number, failed: number }>}
 */
export async function sendExpoPush(tokens, { title, body, data = {} }, logger = console) {
  const valid = (tokens || []).filter(
    (t) => typeof t === "string" && t.startsWith("ExponentPushToken")
  );
  if (!valid.length) return { sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;

  for (const batch of chunk(valid, CHUNK_SIZE)) {
    const messages = batch.map((to) => ({
      to,
      title,
      body,
      sound: "default",
      priority: "high",
      channelId: "new-subscriptions",
      data,
    }));

    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(messages),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!res.ok) {
        failed += batch.length;
        logger?.warn?.({ status: res.status, count: batch.length }, "expo_push_batch_failed");
        continue;
      }

      const json = await res.json().catch(() => null);
      const tickets = json?.data ?? [];
      for (const ticket of tickets) {
        if (ticket?.status === "ok") sent += 1;
        else failed += 1;
      }
      // If the response shape was unexpected, count the batch as sent optimistically.
      if (!tickets.length) sent += batch.length;
    } catch (err) {
      failed += batch.length;
      logger?.warn?.({ err: err?.message, count: batch.length }, "expo_push_send_error");
    }
  }

  return { sent, failed };
}
