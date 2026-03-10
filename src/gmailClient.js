import * as cheerio from "cheerio";
import he from "he";


export async function listRecentMessages(accessToken) {
  const url =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=500&q=newer_than:180d";

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  
    const data = await res.json();
    return data.messages || [];
  }
  
  

  export async function fetchMessage(accessToken, messageId) {
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`;
  
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  
    return res.json();
  }
  
  export function decodeBody(data) {
    if (!data) return "";
    const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(b64, "base64").toString("utf8");
  }
  
  export function extractText(payload) {
    if (!payload) return "";
  
    // Direct body
    if (payload.body?.data) {
      return decodeBody(payload.body.data);
    }
  
    if (payload.parts) {
      for (const part of payload.parts) {
        if (
          (part.mimeType === "text/plain" ||
           part.mimeType === "text/html") &&
          part.body?.data
        ) {
          return decodeBody(part.body.data);
        }
  
        // Nested multipart
        if (part.parts) {
          for (const nested of part.parts) {
            if (
              (nested.mimeType === "text/plain" ||
               nested.mimeType === "text/html") &&
              nested.body?.data
            ) {
              return decodeBody(nested.body.data);
            }
          }
        }
      }
    }
  
    return "";
  }
  export function cleanEmailHtml(html) {
    if (!html) return "";
  
    const $ = cheerio.load(html);
  
    // Remove non-content
    $("style").remove();
    $("script").remove();
    $("head").remove();
    $("meta").remove();
    $("link").remove();
  
    let text = $("body").text();
  
    // Decode entities
    text = he.decode(text);
  
    // Normalize whitespace
    text = text
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  
    return text;
  }
  
  export function extractAmount(text) {
    const totalMatch = text.match(/total\s*[:\-]?\s*\$([0-9]+(?:\.[0-9]{2})?)/i);
    if (totalMatch) return parseFloat(totalMatch[1]);
  
    const chargedMatch = text.match(/charged\s*\$([0-9]+(?:\.[0-9]{2})?)/i);
    if (chargedMatch) return parseFloat(chargedMatch[1]);
  
    // Plan price — catches "$8.99/month", "$99/year"
    const planMatch = text.match(/\$([0-9]+(?:\.[0-9]{2})?)\s*(?:\/|\s*per\s*)(?:month|year|mo|yr)/i);
    if (planMatch) return parseFloat(planMatch[1]);
  
    const allMatches = [...text.matchAll(/\$([0-9]+(?:\.[0-9]{2})?)/g)];
    if (!allMatches.length) return null;
  
    // Filter out suspiciously large amounts before returning last match
    const filtered = allMatches.filter(m => parseFloat(m[1]) <= 100);
    if (!filtered.length) return null;
  
    return parseFloat(filtered[filtered.length - 1][1]);
  }
  
  export function extractMerchant(headers) {
    const from = headers.find((h) => h.name === "From")?.value;
    if (!from) return "unknown";
  
    const emailMatch = from.match(/<(.+?)>/);
    const address = emailMatch ? emailMatch[1] : from;
    const domain = address.split("@")[1]?.toLowerCase() ?? "";
  
    const parts = domain.split(".");
    const root = parts.length >= 2 ? parts[parts.length - 2] : domain;
  
    if (root.includes("uber") || parts.some(p => p.includes("uber"))) {
      return from.toLowerCase().includes("uber one") ? "uber one" : "uber";
    }
  
    const blocked = new Set([
      "klaviyo", "mailchimp", "sendgrid", "constantcontact",
      "interactivebrokers", "hoyoverse", "gelato", "brevo",
      "hubspot", "salesforce", "marketo",
    ]);
  
    if (blocked.has(root)) return "unknown";
  
    const knownMap = {
      openai: "openai",
      chatgpt: "openai",
      netflix: "netflix",
      spotify: "spotify",
      apple: "apple",
      google: "google",
      youtube: "google",
      microsoft: "microsoft",
      adobe: "adobe",
      dropbox: "dropbox",
      slack: "slack",
      amazon: "amazon",
      hulu: "hulu",
      disney: "disney+",
      notion: "notion",
      figma: "figma",
      github: "github",
      anthropic: "anthropic",
      linkedin: "linkedin",
      zoom: "zoom",
    };
  
    // Check every part of the domain, not just root
    // Catches tm.openai.com → openai, info.netflix.com → netflix
    for (const part of parts) {
      if (knownMap[part]) return knownMap[part];
      if (blocked.has(part)) return "unknown";
    }
  
    return knownMap[root] ?? root;
  }