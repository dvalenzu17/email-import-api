// src/lib/scanDebugStore.js
export async function upsertChunkLog({
    supabase,
    sessionId,
    chunkKey,
    cursorIn,
    cursorOut,
    listed,
    screened,
    fullFetched,
    matched,
    tookMs,
    error = null,
  }) {
    const row = {
      session_id: sessionId,
      chunk_key: chunkKey,
      cursor_in: cursorIn,
      cursor_out: cursorOut,
      listed: listed ?? 0,
      screened: screened ?? 0,
      full_fetched: fullFetched ?? 0,
      matched: matched ?? 0,
      took_ms: tookMs ?? 0,
      error,
    };
  
    const { error: e } = await supabase
      .from("scan_chunk_logs")
      .upsert(row, { onConflict: "session_id,chunk_key" });
  
    if (e) throw new Error(`upsertChunkLog: ${e.message}`);
  }
  