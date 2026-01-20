// src/lib/eventStore.js
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Expected table: scan_events(session_id, user_id, type, payload, dedupe_key)
 * If you used event_type before, rename column or update selects accordingly.
 */
export async function writeEvent({ supabase, sessionId, userId, type, payload, dedupeKey = null }) {
  const row = {
    session_id: sessionId,
    user_id: userId,
    type,
    payload,
    dedupe_key: dedupeKey,
  };

  if (dedupeKey) {
    const { error } = await supabase.from("scan_events").upsert(row, {
      onConflict: "session_id,dedupe_key",
    });
    if (error) throw new Error(`writeEvent(upsert): ${error.message}`);
    return;
  }

  const { error } = await supabase.from("scan_events").insert(row);
  if (error) throw new Error(`writeEvent(insert): ${error.message}`);
}

/**
 * Poll scan_events and push them to SSE writer.
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

  (async () => {
    while (!canceled && !(signal?.aborted)) {
      const { data, error } = await supabase
        .from("scan_events")
        .select("id,type,payload,created_at")
        .eq("session_id", sessionId)
        .eq("user_id", userId)
        .gt("id", cursor)
        .order("id", { ascending: true })
        .limit(200);

      if (error) {
        // Don’t emit SSE event name "error" (browsers treat it as transport failure)
        write?.({ type: "sse_error", payload: { message: error.message } });
        break;
      }

      if (data?.length) {
        for (const evt of data) {
          cursor = Math.max(cursor, evt.id);
          write?.({ type: evt.type, payload: evt.payload });
        }
      }

      write?.({ type: "ping", payload: { t: Date.now() } });
      await sleep(heartbeatMs);
    }
  })().catch((e) => {
    write?.({ type: "sse_error", payload: { message: e?.message || "stream_failed" } });
  });

  return cancel;
}
