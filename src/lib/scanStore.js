// src/lib/scanStore.js

export async function createScanSession({ supabase, userId, provider, cursor, options }) {
    const { data, error } = await supabase
      .from("scan_sessions")
      .insert({
        user_id: userId,
        provider,
        status: "queued",
        cursor: cursor ?? null,
        options: options ?? {},
      })
      .select("*")
      .single();
  
    if (error) throw new Error(`createScanSession: ${error.message}`);
    return data;
  }
  
  /**
   * If userId is provided, enforce ownership.
   * If not provided (worker use), just fetch by id.
   */
  export async function getScanSession({ supabase, sessionId, userId }) {
    let q = supabase.from("scan_sessions").select("*").eq("id", sessionId);
    if (userId) q = q.eq("user_id", userId);
  
    const { data, error } = await q.maybeSingle();
    if (error) throw new Error(`getScanSession: ${error.message}`);
    return data;
  }
  
  
  export async function cancelScanSession({ supabase, sessionId, userId }) {
    const { error } = await supabase
      .from("scan_sessions")
      .update({ status: "canceled" })
      .eq("id", sessionId)
      .eq("user_id", userId)
      .in("status", ["queued", "running"]);
  
    if (error) throw new Error(`cancelScanSession: ${error.message}`);
    return true;
  }
  
  export async function leaseNextQueuedSession({ supabase, instanceId, leaseSeconds = 30 }) {
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  
    const { data, error } = await supabase
      .from("scan_sessions")
      .update({
        status: "running",
        leased_by: instanceId,
        lease_expires_at: leaseExpiresAt,
      })
      .eq("status", "queued")
      .select("*")
      .limit(1);
  
    if (error) throw new Error(`leaseNextQueuedSession: ${error.message}`);
    return (data && data[0]) || null;
  }
  
  export async function renewLease({ supabase, sessionId, instanceId, leaseSeconds = 30 }) {
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  
    const { error } = await supabase
      .from("scan_sessions")
      .update({ lease_expires_at: leaseExpiresAt })
      .eq("id", sessionId)
      .eq("leased_by", instanceId)
      .eq("status", "running");
  
    if (error) throw new Error(`renewLease: ${error.message}`);
  }
  
  export async function updateSessionProgress({ supabase, sessionId, patch }) {
    const { data, error } = await supabase
      .from("scan_sessions")
      .update(patch)
      .eq("id", sessionId)
      .select("*")
      .single();
  
    if (error) throw new Error(`updateSessionProgress: ${error.message}`);
    return data;
  }
  
  export async function upsertCandidates({ supabase, sessionId, userId, candidates }) {
    if (!candidates?.length) return { inserted: 0 };
  
    const seen = new Set();
    const rows = [];
    for (const c of candidates) {
      const fp = c?.fingerprint;
      if (!fp || seen.has(fp)) continue;
      seen.add(fp);
      rows.push({
        session_id: sessionId,
        user_id: userId,
        fingerprint: fp,
        candidate: c,
      });
    }
    if (!rows.length) return { inserted: 0 };
  
    const { error } = await supabase
      .from("scan_candidates")
      .upsert(rows, { onConflict: "session_id,fingerprint", ignoreDuplicates: true });
  
    if (error) throw new Error(`upsertCandidates: ${error.message}`);
    return { inserted: rows.length };
  }
  