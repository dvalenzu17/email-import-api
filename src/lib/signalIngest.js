
import { insertSignal } from "./evidenceStore.js";

export async function ingestCandidateSignals({ supabase, userId, candidate, emailMessageId = null }) {
  const signals = Array.isArray(candidate?.signals) ? candidate.signals : [];
  const out = [];
  for (const s of signals) {
    if (!s?.type) continue;
    const row = await insertSignal({
      supabase,
      userId,
      emailMessageId,
      type: s.type,
      extracted: s.extracted || {},
      confidence: s.confidence ?? 0,
      rawSpans: s.raw_spans || s.rawSpans || {},
    }).catch(() => null);
    if (row) out.push(row);
  }
  return out;
}
