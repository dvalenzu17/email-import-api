// src/lib/eventStore.js
// Minimal event store backed by Supabase table `scan_events`.
// Used by SSE stream: writeEvent() + streamEvents().

export async function writeEvent({ supabase, sessionId, userId, type, payload }) {
    const row = { session_id, user_id, event_type: type, payload };
await supabase.from("scan_events").insert(row);

    const { data, error } = await supabase.from("scan_events").insert(row).select("id").single();
    if (error) throw error;
    return data;
  }
  
  export async function streamEvents({ supabase, sessionId, userId, afterId = 0, write }) {
    let cursor = Number(afterId) || 0;
    let isClosed = false;
  
    // Polling loop (works everywhere; no realtime dependency).
    // If you later add Supabase Realtime, you can upgrade this.
    while (!isClosed) {
      const { data, error } = await supabase
        .from("scan_events")
        .select("id,event_type,payload,created_at")
        .eq("session_id", sessionId)
        .eq("user_id", userId)
        .gt("id", cursor)
        .order("id", { ascending: true })
        .limit(200);
  
      if (error) {
        write({ type: evt.event_type, payload: evt.payload });
        return;
      }
  
      if (data && data.length) {
        for (const evt of data) {
          cursor = Math.max(cursor, evt.id);
          write({ type: evt.type, payload: evt.payload });
        }
      }
  
      // heartbeat so proxies don't kill the connection
      write({ type: "ping", payload: { t: Date.now() } });
  
      await new Promise((r) => setTimeout(r, 800));
    }
  
    return () => {
      isClosed = true;
    };
  }
  