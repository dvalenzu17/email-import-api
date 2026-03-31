export { cleanEmailHtml, extractAmount, extractMerchant } from "./services/emailParser.js";

export async function listRecentMessages(accessToken) {
  const url =
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=500&q=newer_than:180d";
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`gmail_list_failed: ${res.status}`);
  const data = await res.json();
  return data.messages || [];
}

export async function fetchMessage(accessToken, messageId) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`gmail_fetch_failed: ${res.status}`);
  return res.json();
}

export function decodeBody(data) {
  if (!data) return "";
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}

export function extractText(payload) {
  if (!payload) return "";
  if (payload.body?.data) return decodeBody(payload.body.data);
  if (!payload.parts) return "";

  let html = "";
  let plain = "";
  for (const part of payload.parts) {
    if (part.mimeType === "text/html" && part.body?.data) {
      html += decodeBody(part.body.data);
    } else if (part.mimeType === "text/plain" && part.body?.data && !plain) {
      plain = decodeBody(part.body.data);
    } else if (part.parts) {
      const nested = extractText(part);
      if (nested) html += nested;
    }
  }
  return html || plain;
}


export function extractRenewalDate(text) {
  const patterns = [
    /starting from\s+(\d{1,2}\s+\w+\s+\d{4})/i,
    /renews on\s+(\w+\s+\d{1,2},?\s+\d{4})/i,
    /renews\s+(\w+\s+\d{1,2},?\s+\d{4})/i,
    /next billing date[:\s]+(\w+\s+\d{1,2},?\s+\d{4})/i,
    /renewal date[:\s]+(\w+\s+\d{1,2},?\s+\d{4})/i,
    /will renew on\s+(\w+\s+\d{1,2},?\s+\d{4})/i,
    /automatically renews\s+(?:on\s+)?(\w+\s+\d{1,2},?\s+\d{4})/i,
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const d = new Date(m[1]);
      if (!isNaN(d.getTime())) return d;
    }
  }

  return null;
}

