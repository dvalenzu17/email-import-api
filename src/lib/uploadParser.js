
/**
 * Patch 6: Receipt upload parsing
 * - Strong contract: image uploads MUST include textHint unless ENABLE_SERVER_OCR=true
 * - PDF uploads: try server pdf-parse best-effort, else require textHint
 */
function parseFromText(t) {
  const extracted = {
    merchant: null,
    amount: null,
    currency: null,
    cadence: null,
    next_charge_at: null,
    invoice_id: null,
    support_email: null,
    manage_url: null,
    cancel_url: null,
  };

  const m1 = t.match(/\b(USD|EUR|GBP)\s*([0-9]+(?:[\.,][0-9]{1,2})?)\b/i);
  const m2 = t.match(/\b([0-9]+(?:[\.,][0-9]{1,2})?)\s*(USD|EUR|GBP)\b/i);
  const m3 = t.match(/\$\s*([0-9]+(?:\.[0-9]{1,2})?)\b/);
  if (m1) { extracted.currency = m1[1].toUpperCase(); extracted.amount = Number(String(m1[2]).replace(",", ".")); }
  else if (m2) { extracted.currency = m2[2].toUpperCase(); extracted.amount = Number(String(m2[1]).replace(",", ".")); }
  else if (m3) { extracted.currency = "USD"; extracted.amount = Number(m3[1]); }

  if (/\bmonthly\b/i.test(t)) extracted.cadence = "monthly";
  if (/\bannual\b|\byearly\b/i.test(t)) extracted.cadence = "annual";

  const inv = t.match(/\b(invoice|receipt)\s*(#|no\.?|id)?\s*[:#]?\s*([A-Z0-9-]{5,})\b/i);
  if (inv) extracted.invoice_id = inv[3];

  const email = t.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (email) extracted.support_email = email[0];

  const urls = t.match(/https?:\/\/[^\s]+/gi) || [];
  if (urls.length) extracted.manage_url = urls[0];
  if (urls.length > 1) extracted.cancel_url = urls[1];

  return extracted;
}

async function tryPdfParse(base64) {
  try {
    const mod = await import("pdf-parse");
    const pdfParse = mod.default || mod;
    const buf = Buffer.from(base64, "base64");
    const out = await pdfParse(buf);
    return out?.text || "";
  } catch {
    return "";
  }
}

export async function parseReceiptUpload({ filename, contentType, base64, textHint }) {
  const ct = (contentType || "").toLowerCase();
  const kind = ct.includes("pdf") ? "pdf" : ct.startsWith("image/") ? "image" : "unknown";

  const enableServerOCR = process.env.ENABLE_SERVER_OCR === "true";

  let text = typeof textHint === "string" ? textHint.trim() : "";
  const notes = [];

  if (!text && kind === "pdf" && typeof base64 === "string" && base64.length > 50) {
    const parsed = await tryPdfParse(base64);
    if (parsed.trim()) {
      text = parsed.trim();
      notes.push("Parsed PDF text server-side (best-effort).");
    }
  }

  // Enforce: images require textHint unless server OCR enabled (not implemented yet)
  if (!text && kind === "image" && !enableServerOCR) {
    return {
      ok: false,
      error: "needs_textHint",
      message: "Image uploads require textHint (on-device OCR). Server OCR is disabled.",
      kind,
      filename,
      contentType: ct,
    };
  }

  const extracted = text ? parseFromText(text) : parseFromText("");
  let confidence = 0.1;
  if (extracted.amount && extracted.currency) confidence = 0.6;
  if (extracted.invoice_id) confidence = Math.min(0.75, confidence + 0.1);

  return {
    ok: true,
    filename,
    contentType: ct,
    kind,
    extracted,
    confidence,
    needsReview: true,
    notes: notes.length ? notes : ["Provide textHint (on-device OCR/PDF text extraction) for best results."],
  };
}
