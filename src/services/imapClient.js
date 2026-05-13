import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { cleanEmailHtml, extractAmount, extractMerchant, extractCurrencyCode, extractRenewalDate, extractAppleAppNameFromHtml } from "./emailParser.js";
import { getBrandInfo } from "./knownBrands.js";
import { classifyEmail, EMAIL_TYPES } from "./emailClassifier.js";
import { withRetry } from "./retryUtil.js";

const IMAP_CONFIGS = {
  gmail:   { host: "imap.gmail.com",           port: 993, secure: true },
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
  "uber.com",
]);

// Extract billing interval from email text.
function extractBillingInterval(text) {
  const t = text.toLowerCase();
  if (/\b(annual|annually|yearly|year|1[- ]year|12[- ]month)\b/.test(t)) return "yearly";
  if (/\b(semi[- ]?annual|every 6 months|half[- ]?year)\b/.test(t))       return "semiannual";
  if (/\b(quarter|quarterly|every 3 months)\b/.test(t))                    return "quarterly";
  if (/\b(biweekly|bi[- ]?weekly|every 2 weeks|every two weeks)\b/.test(t)) return "biweekly";
  if (/\b(weekly|per week|every week)\b/.test(t))                          return "weekly";
  if (/\b(monthly|per month|\/month|month[- ]to[- ]month)\b/.test(t))      return "monthly";
  return null;
}

// Extract primary sender domain (e.g. "apple.com" from "noreply@email.apple.com").
function extractSenderDomain(fromHeader) {
  const match = fromHeader.match(/@([\w.-]+\.\w+)/);
  if (!match) return null;
  // Return the last two parts: email.apple.com → apple.com
  const parts = match[1].split(".");
  return parts.length >= 2 ? parts.slice(-2).join(".") : match[1];
}

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

function isRetriableImapError(err) {
  // imapflow NoConnection — connection dropped mid-scan (common on Render after
  // hibernation wakeup or Apple IMAP dropping idle connections)
  if (err?.code === "NoConnection") return true;
  // Apple [UNAVAILABLE] response
  if (err?.responseText?.toLowerCase().includes("unavailable")) return true;
  const attrs = err?.response?.attributes;
  if (Array.isArray(attrs)) {
    return attrs.some(
      (a) => Array.isArray(a.section) && a.section.some((s) => s.value === "UNAVAILABLE")
    );
  }
  // Generic transient network errors
  const msg = err?.message?.toLowerCase() ?? "";
  return msg.includes("timeout") || msg.includes("econnreset") || msg.includes("enotfound");
}

export async function scanImapInbox(params) {
  return withRetry(() => _scanImapInbox(params), {
    maxAttempts: 3,
    baseDelayMs: 5000,
    retryOn: isRetriableImapError,
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
  const cancellations = [];
  const cancelledCharges = []; // subscriptions detected from cancellation/expiry emails
  let scannedCount = 0;

  try {
    const mailbox = await client.mailboxOpen("INBOX");

    const since = new Date();
    since.setDate(since.getDate() - daysBack);

    // Use UID search explicitly
    const allUids = await client.search({ since }, { uid: true });
    if (!allUids.length) return { charges, cancellations, cancelledCharges, scannedCount };

    const uids = allUids.slice(-1500);

    // Pass 1 — envelopes only, UID mode
    const relevant = [];

    for await (const msg of client.fetch(
      uids,
      { envelope: true, uid: true },
      { uid: true }
    )) {
      scannedCount++;
      const subject = msg.envelope?.subject?.toLowerCase() ?? "";
      const senderAddress = msg.envelope?.from?.[0]?.address?.toLowerCase() ?? "";
      const isKnownSender = [...IMAP_KNOWN_DOMAINS].some(d => senderAddress.includes(d));

      // Always include emails from known subscription domains regardless of subject —
      // e.g. Disney+ welcome emails ("Welcome to Disney+") don't have billing keywords
      // in the subject but carry cadence, price, and renewal date in the body.
      const looksRelevant =
        isKnownSender ||
        subject.includes("receipt") ||
        subject.includes("invoice") ||
        subject.includes("subscription") ||
        subject.includes("renewal") ||
        subject.includes("membership") ||
        subject.includes("billing") ||
        subject.includes("auto-renew") ||
        subject.includes("your plan") ||
        subject.includes("charged") ||
        subject.includes("payment") ||
        subject.includes("welcome");
        // NOTE: "order confirmation" deliberately excluded — fires on one-time purchases

      if (looksRelevant) {
        relevant.push({ uid: msg.uid, envelope: msg.envelope });
      }
    }

    if (!relevant.length) return { charges, cancellations, cancelledCharges, scannedCount };

    const relevantUids = relevant.map((r) => r.uid);
    const envelopeMap = Object.fromEntries(
      relevant.map((r) => [r.uid, r.envelope])
    );

    // Pass 2 — full source, UID mode
    // mailparser decodes MIME structure and base64 parts correctly — cheerio
    // on the raw RFC 2822 source cannot see base64-encoded HTML bodies at all.
    for await (const msg of client.fetch(
      relevantUids,
      { source: true, uid: true },
      { uid: true }
    )) {
      try {
        const rawBuffer = msg.source;
        if (!rawBuffer) continue;

        const parsed = await simpleParser(rawBuffer);

        // Prefer HTML body (richer content); fall back to plain text.
        const bodySource = parsed.html || parsed.textAsHtml || parsed.text || "";
        if (!bodySource) continue;

        const text = cleanEmailHtml(bodySource);
        if (!text || text.length < 30) continue;

        if (
          text.includes("trip with uber") ||
          text.includes("thanks for riding") ||
          text.includes("your uber eats order")
        ) continue;

        // mailparser already parsed From + Subject from the MIME headers —
        // prefer these over the envelope (which comes from IMAP FETCH ENVELOPE
        // and can be lossy with non-ASCII names).
        const fromParsed = parsed.from?.value?.[0];
        const fromHeader = fromParsed?.name
          ? `${fromParsed.name} <${fromParsed.address ?? ""}>`
          : (fromParsed?.address ?? (envelopeMap[msg.uid]?.from?.[0]?.address ?? ""));
        const subject = parsed.subject ?? envelopeMap[msg.uid]?.subject ?? "";

        const parsedDate = parsed.date ?? (envelopeMap[msg.uid]?.date ? new Date(envelopeMap[msg.uid].date) : null);

        // ── Lifecycle classification ──────────────────────────────────────────
        // Detect cancellation/expiry emails so we can mark the subscription as
        // inactive even if we also have a charge email for it. This mirrors the
        // Gmail scan's lifecycle handling.
        const emailType = classifyEmail(subject, text);
        if (emailType === EMAIL_TYPES.FAILED_PAYMENT) {
          continue; // payment failed — not a successful charge
        }
        if (emailType === EMAIL_TYPES.CANCELLATION) {
          // Extract the app/merchant and amount so we can save it as an inactive
          // subscription — important for Apple "Your Subscription is Expiring" emails
          // where the subscription may not have been seen before (first iCloud scan).
          const isAppleSenderC = fromHeader.toLowerCase().includes("apple.com");
          let appleAppNameC = isAppleSenderC && parsed.html
            ? extractAppleAppNameFromHtml(parsed.html)
            : null;
          if (!appleAppNameC && isAppleSenderC && subject) {
            const sub = subject.trim();
            const m1 = sub.match(/^Your\s+(.+?)\s+receipt(?:\s+from\s+Apple)?\.?$/i);
            const m2 = sub.match(/^Your\s+(.+?)\s+subscription\b/i);
            const m3 = sub.match(/subscription\s+to\s+(.+?)\s+(?:has\s+been|renewal|confirmation)/i);
            const rawName = (m1 || m2 || m3)?.[1]?.trim();
            if (rawName && rawName.length > 1 && rawName.length < 50 &&
                !/^(apple|receipt|invoice|payment|free|trial|subscription)$/i.test(rawName)) {
              appleAppNameC = rawName;
            }
          }
          const cancelMerchant = appleAppNameC
            ? appleAppNameC.toLowerCase().trim()
            : extractMerchant(fromHeader, text, subject);
          if (cancelMerchant && cancelMerchant !== "unknown") {
            cancellations.push(cancelMerchant);
            const cancelAmount = extractAmount(text);
            if (cancelAmount) {
              const cancelDate = parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate : new Date();
              cancelledCharges.push({
                merchant:        cancelMerchant,
                renewalAmount:   cancelAmount,
                currency:        extractCurrencyCode(text),
                renewalDate:     extractRenewalDate(text),
                billingInterval: extractBillingInterval(text),
                senderDomain:    extractSenderDomain(fromHeader),
                date:            cancelDate,
              });
            }
          }
          continue; // not a successful charge
        }

        const amount = extractAmount(text);
        if (!amount) continue;

        // For Apple IAP emails parse the app name from raw HTML table cells —
        // the cleaned-text strategies are confused by Apple's repeated app name
        // across multiple table rows (icon alt, App row, Subscription row).
        const isAppleSender = fromHeader.toLowerCase().includes("apple.com");
        let appleAppName = isAppleSender && parsed.html
          ? extractAppleAppNameFromHtml(parsed.html)
          : null;

        // Subject-based fallback for Apple emails where HTML extraction fails.
        // Apple subjects often embed the app name:
        //   "Your SketchUp Go receipt from Apple."
        //   "Your Paramount+ Essential subscription is expiring."
        //   "Your subscription to Couple Joy has been confirmed."
        if (!appleAppName && isAppleSender && subject) {
          const sub = subject.trim();
          const m1 = sub.match(/^Your\s+(.+?)\s+receipt(?:\s+from\s+Apple)?\.?$/i);
          const m2 = sub.match(/^Your\s+(.+?)\s+subscription\b/i);
          const m3 = sub.match(/subscription\s+to\s+(.+?)\s+(?:has\s+been|renewal|confirmation)/i);
          const rawName = (m1 || m2 || m3)?.[1]?.trim();
          if (rawName && rawName.length > 1 && rawName.length < 50 &&
              !/^(apple|receipt|invoice|payment|free|trial)$/i.test(rawName)) {
            appleAppName = rawName;
          }
        }

        // For Apple emails where we couldn't identify the specific app/service,
        // require a subscription signal in the body text before processing.
        // This filters out one-time purchase receipts, order confirmations,
        // hardware invoices, and marketing emails that slip through.
        if (isAppleSender && !appleAppName) {
          const hasSubSignal =
            text.includes("subscription") ||
            text.includes("renewal") ||
            text.includes("automatically renew") ||
            text.includes("next billing") ||
            text.includes("suscripci");  // Spanish "suscripción"
          if (!hasSubSignal) continue;
        }

        const merchant = appleAppName
          ? appleAppName.toLowerCase().trim()
          : extractMerchant(fromHeader, text, subject);
        if (merchant === "unknown") continue;

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

        const renewalDate = extractRenewalDate(text);
        const billingInterval = extractBillingInterval(text);
        const senderDomain = extractSenderDomain(fromHeader);

        // Threshold lowered from 3 → 2: a single billing keyword + known domain,
        // or any two subscription signals, is enough intent evidence for IMAP.
        charges.push({
          merchant,
          amount,
          currency: extractCurrencyCode(text),
          date,
          renewalDate,
          billingInterval,
          senderDomain,
          isAppleIAP: isAppleSender,
          subscriptionIntent: intentScore >= 2,
        });
      } catch {
        continue;
      }
    }
    console.log(`[imap] scan_complete: provider=${provider} scanned=${scannedCount} charges=${charges.length} cancellations=${cancellations.length}`);
    if (charges.length > 0) {
      const byMerchant = {};
      for (const c of charges) byMerchant[c.merchant] = (byMerchant[c.merchant] ?? 0) + 1;
      console.log(`[imap] charges_by_merchant:`, JSON.stringify(byMerchant));
    }
  } finally {
    try { await client.logout(); } catch { /* connection may already be closed */ }
  }

  return { charges, cancellations, cancelledCharges, scannedCount };
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