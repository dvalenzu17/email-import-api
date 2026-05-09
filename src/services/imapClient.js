import { ImapFlow } from "imapflow";
import { cleanEmailHtml, extractAmount, extractMerchant, extractCurrencyCode } from "./emailParser.js";
import { getBrandInfo } from "./knownBrands.js";
import { withRetry } from "./retryUtil.js";

const IMAP_CONFIGS = {
  yahoo:   { host: "imap.mail.yahoo.com",      port: 993, secure: true },
  outlook: { host: "outlook.office365.com",    port: 993, secure: true },
  icloud:  { host: "imap.mail.me.com",         port: 993, secure: true },
};

const SEARCH_KEYWORDS = [
  "subscription", "renewal", "receipt", "invoice",
  "billing", "payment", "charged", "membership",
  "billed", "your plan", "auto-renew", "next billing",
];

// Domains where any charge email is a subscription by definition.
// Used to boost intent score so single receipts aren't filtered out.
const IMAP_KNOWN_DOMAINS = new Set([
  "netflix.com", "spotify.com", "openai.com", "adobe.com",
  "apple.com", "microsoft.com", "dropbox.com", "slack.com",
  "notion.so", "figma.com", "github.com", "anthropic.com",
  "hulu.com", "disneyplus.com", "youtube.com", "linkedin.com",
  "zoom.us", "shopify.com", "squarespace.com", "webflow.io",
  "canva.com", "grammarly.com", "duolingo.com", "headspace.com",
  "calm.com", "peloton.com", "substack.com", "patreon.com",
  "medium.com", "crunchyroll.com", "twitch.tv", "audible.com",
  "vercel.com", "netlify.com", "airtable.com", "hubspot.com",
]);

export function getImapConfig(provider) {
  const config = IMAP_CONFIGS[provider];
  if (!config) throw new Error(`unsupported_provider: ${provider}`);
  return config;
}

export async function verifyImapCredentials({ provider, user, pass }) {
  const { host, port, secure } = getImapConfig(provider);

  const client = new ImapFlow({
    host, port, secure,
    auth: { user, pass },
    logger: false,
    connectionTimeout: 10000,
    authTimeout: 10000,
  });

  try {
    await client.connect();
    await client.logout();
    return { ok: true };
  } catch (err) {
    throw new Error(normaliseImapError(err));
  }
}

function isUnavailableError(err) {
  if (err?.responseText?.toLowerCase().includes("unavailable")) return true;
  const attrs = err?.response?.attributes;
  if (Array.isArray(attrs)) {
    return attrs.some(
      (a) => Array.isArray(a.section) && a.section.some((s) => s.value === "UNAVAILABLE")
    );
  }
  return false;
}

export async function scanImapInbox(params) {
  return withRetry(() => _scanImapInbox(params), {
    maxAttempts: 2,
    baseDelayMs: 4000,
    retryOn: isUnavailableError,
  });
}

async function _scanImapInbox({ provider, user, pass, daysBack = 365 }) {
  const { host, port, secure } = getImapConfig(provider);

  const client = new ImapFlow({
    host, port, secure,
    auth: { user, pass },
    logger: false,
    connectionTimeout: 15000,
    authTimeout: 15000,
  });

  await client.connect();

  const charges = [];
  let scannedCount = 0;

  try {
    const mailbox = await client.mailboxOpen("INBOX");

    const since = new Date();
    since.setDate(since.getDate() - daysBack);

    // Use UID search explicitly
    const allUids = await client.search({ since }, { uid: true });
    if (!allUids.length) return { charges, scannedCount };

    const uids = allUids.slice(-500);

    // Pass 1 — envelopes only, UID mode
    const relevant = [];

    for await (const msg of client.fetch(
      uids,
      { envelope: true, uid: true },
      { uid: true }
    )) {
      scannedCount++;
      const subject = msg.envelope?.subject?.toLowerCase() ?? "";

      const looksRelevant =
        subject.includes("receipt") ||
        subject.includes("invoice") ||
        subject.includes("subscription") ||
        subject.includes("renewal") ||
        subject.includes("membership") ||
        subject.includes("billing") ||
        subject.includes("auto-renew") ||
        subject.includes("your plan") ||
        subject.includes("charged");
        // NOTE: "payment", "order confirmation" deliberately excluded —
        // they fire on one-time purchases (Amazon etc.) and dominate results

      if (looksRelevant) {
        relevant.push({ uid: msg.uid, envelope: msg.envelope });
      }
    }

    if (!relevant.length) return { charges, scannedCount };

    const relevantUids = relevant.map((r) => r.uid);
    const envelopeMap = Object.fromEntries(
      relevant.map((r) => [r.uid, r.envelope])
    );

    // Pass 2 — full source, UID mode
    for await (const msg of client.fetch(
      relevantUids,
      { source: true, uid: true },
      { uid: true }
    )) {
      try {
        const raw = msg.source?.toString("utf8") ?? "";
        if (!raw) continue;

        const text = cleanEmailHtml(raw);
        if (!text || text.length < 30) continue;

        if (
          text.includes("trip with uber") ||
          text.includes("thanks for riding") ||
          text.includes("your uber eats order")
        ) continue;

        const amount = extractAmount(text);
        if (!amount) continue;

        const envelope = envelopeMap[msg.uid] ?? msg.envelope;
        const from = envelope?.from?.[0];
        const fromHeader = from?.name
          ? `${from.name} <${from.address ?? ""}>`
          : (from?.address ?? "");
        const subject = envelope?.subject ?? "";
        const merchant = extractMerchant(fromHeader, text, subject);
        const parsedDate = envelope?.date ? new Date(envelope.date) : null;
        const date = parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate : new Date();

        // Check if this sender is a known subscription domain — same logic as
        // the Gmail scan so that single receipts from Spotify, Netflix etc.
        // are not dropped by the intent threshold.
        const fromLow = fromHeader.toLowerCase();
        const isKnownDomain = [...IMAP_KNOWN_DOMAINS].some(d => fromLow.includes(d));
        const brandInfo = merchant !== "unknown" ? getBrandInfo(merchant) : null;

        let intentScore = 0;
        if (isKnownDomain || brandInfo?.confirmSingle) intentScore += 3;
        if (text.includes("subscription"))              intentScore += 2;
        if (text.includes("membership"))                intentScore += 2;
        if (text.includes("automatically renew"))        intentScore += 2;
        if (text.includes("renews on"))                  intentScore += 2;
        if (text.includes("next billing"))               intentScore += 2;
        if (text.includes("/month") || text.includes("per month")) intentScore += 2;
        if (text.includes("/year")  || text.includes("per year"))  intentScore += 2;
        if (text.includes("cancel anytime"))             intentScore += 2;
        if (text.includes("valid until"))                intentScore += 1;
        if (text.includes("plan"))                       intentScore += 1;
        if (text.includes("charged"))                    intentScore += 1;
        if (text.includes("receipt"))                    intentScore += 1;
        if (text.includes("billing"))                    intentScore += 1;

        // Threshold lowered from 3 → 2: a single billing keyword + known domain,
        // or any two subscription signals, is enough intent evidence for IMAP.
        charges.push({
          merchant,
          amount,
          currency: extractCurrencyCode(text),
          date,
          subscriptionIntent: intentScore >= 2,
        });
      } catch {
        continue;
      }
    }
  } finally {
    try { await client.logout(); } catch { /* connection may already be closed */ }
  }

  return { charges, scannedCount };
}

function normaliseImapError(err) {
  const msg = err.message?.toLowerCase() ?? "";

  // Auth failures — Apple returns [AUTHENTICATIONFAILED], others vary
  if (
    msg.includes("invalid credentials") ||
    msg.includes("authentication failed") ||
    msg.includes("authenticationfailed") ||
    msg.includes("login failed") ||
    msg.includes("access denied") ||
    msg.includes("no [auth") ||
    msg.includes("incorrect password") ||
    msg.includes("username or password")
  ) {
    return "invalid_credentials";
  }
  // Apple-specific: account requires app-specific password
  if (msg.includes("application-specific") || msg.includes("app-specific") || msg.includes("app password")) {
    return "app_password_required";
  }
  if (msg.includes("too many") || msg.includes("rate limit") || msg.includes("flood")) {
    return "rate_limited";
  }
  if (msg.includes("unavailable") || msg.includes("temporarily")) {
    return "service_unavailable";
  }
  // Network / TLS / connection errors
  if (
    msg.includes("connect") || msg.includes("timeout") ||
    msg.includes("network") || msg.includes("tls") ||
    msg.includes("ssl") || msg.includes("econnrefused") ||
    msg.includes("enotfound") || msg.includes("socket") ||
    msg.includes("cert") || msg.includes("eproto")
  ) {
    return "connection_failed";
  }
  // Unknown — return a known code so the frontend shows a human-readable message
  return "imap_error";
}