// src/lib/eventStore.js
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function writeEvent({ supabase, sessionId, userId, type, payload, dedupeKey = null }) {
  const row = {
    session_id: sessionId,
    user_id: userId,
    event_type: type, // ✅ DB expects event_type NOT NULL
    payload,
    dedupe_key: dedupeKey,
  };

  if (dedupeKey) {
    const { error } = await supabase
      .from("scan_events")
      .upsert(row, { onConflict: "session_id,dedupe_key" });

    if (error) throw new Error(`writeEvent(upsert): ${error.message}`);
    return;
  }

  const { error } = await supabase.from("scan_events").insert(row);
  if (error) throw new Error(`writeEvent(insert): ${error.message}`);
}

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
        .select("id,event_type,payload,created_at") // ✅ FIX
        .eq("session_id", sessionId)
        .eq("user_id", userId)
        .gt("id", cursor)
        .order("id", { ascending: true })
        .limit(200);

      if (error) {
        write?.({ type: "sse_error", payload: { message: error.message } });
        break;
      }

      if (data?.length) {
        for (const evt of data) {
          cursor = Math.max(cursor, evt.id);
          write?.({ type: evt.event_type, payload: evt.payload }); // ✅ FIX
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
