
/**
 * Patch 6: LLM extraction adapter (edge cases)
 * Uses OpenAI Responses API via fetch (no SDK dependency).
 * Official docs: https://platform.openai.com/docs/api-reference/responses
 *
 * Enable with:
 *   ENABLE_LLM_EXTRACTION=true
 *   OPENAI_API_KEY=...
 * Optional:
 *   OPENAI_MODEL=gpt-5
 */
function pick(obj, keys) {
  for (const k of keys) if (obj && obj[k] != null) return obj[k];
  return null;
}

export async function extractWithLLM({ email }) {
  if (process.env.ENABLE_LLM_EXTRACTION !== "true") return null;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const model = process.env.OPENAI_MODEL || "gpt-5";

  const payload = {
    model,
    reasoning: { effort: "low" },
    // Ask for JSON only to keep this safe/deterministic.
    instructions:
      "You are an extraction engine. Output ONLY valid JSON. No markdown. No extra keys.",
    input: [
      {
        role: "developer",
        content:
          "Extract subscription/billing signals from an email. Return JSON: {type, extracted, confidence, raw_spans}. " +
          "type must be one of receipt|renewal|trial|price_change|cancel_confirm or null if unknown. " +
          "extracted keys: merchant, amount, currency, plan, billing_period, effective_date, next_charge_at, new_amount, trial_end_at, manage_url, cancel_url, support_email, invoice_id. " +
          "confidence is 0..1.",
      },
      {
        role: "user",
        content: JSON.stringify({
          subject: pick(email, ["subject"]),
          fromName: pick(email, ["fromName", "from_name"]),
          fromDomain: pick(email, ["fromDomain", "from_domain"]),
          text: pick(email, ["text"]),
          html: pick(email, ["html"]),
        }),
      },
    ],
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) return null;
  const json = await res.json();
  const outText = json?.output_text || null;
  if (!outText) return null;

  try {
    const parsed = JSON.parse(outText);
    if (!parsed || !parsed.type) return null;
    return {
      type: parsed.type,
      extracted: parsed.extracted || {},
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.6,
      raw_spans: parsed.raw_spans || {},
    };
  } catch {
    return null;
  }
}
