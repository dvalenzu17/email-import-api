// src/lib/eventStore.js
// Supabase-backed scan event helpers used by SSE.

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Write a scan event.
 * Tables expected:
 *   scan_events(session_id, user_id, event_type, payload)
 */
export async function writeEvent({ supabase, sessionId, userId, type, payload }) {
  const row = {
    session_id: sessionId,
    user_id: userId,
    event_type: type,
    payload: payload ?? {},
  };

  const { data, error } = await supabase.from("scan_events").insert(row).select("id").single();
  if (error) throw new Error(`writeEvent: ${error.message}`);
  return data;
}

/**
 * Poll scan_events and push them to an SSE writer.
 * Returns a cancel() function.
 */
export async function streamEvents({
  supabase,
  sessionId,
  userId,
  afterId = 0,
  write,
  heartbeatMs = 800,
  signal,
}) {
  let cursor = Number(afterId) || 0;
  let canceled = false;

  const cancel = () => {
    canceled = true;
  };

  // Run the loop async so the caller can attach cancel handlers.
  (async () => {
    while (!canceled && !(signal?.aborted)) {
      const { data, error } = await supabase
        .from("scan_events")
        .select("id,event_type,payload,created_at")
        .eq("session_id", sessionId)
        .eq("user_id", userId)
        .gt("id", cursor)
        .order("id", { ascending: true })
        .limit(200);

      if (error) {
        write?.({ type: "error", payload: { message: error.message } });
        break;
      }

      if (data?.length) {
        for (const evt of data) {
          cursor = Math.max(cursor, evt.id);
          write?.({ type: evt.event_type, payload: evt.payload });
        }
      }

      // Heartbeat so proxies don't kill the connection
      write?.({ type: "ping", payload: { t: Date.now() } });

      await sleep(heartbeatMs);
    }
  })().catch((e) => {
    write?.({ type: "error", payload: { message: e?.message || "stream_failed" } });
  });

  return cancel;
}
