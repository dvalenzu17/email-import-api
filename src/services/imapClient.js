import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { cleanEmailHtml, extractAmount, extractMerchant, extractCurrencyCode, extractRenewalDate, extractBillingInterval, extractAppleAppNameFromHtml, extractAppleIconUrl } from "./emailParser.js";
import { getBrandInfo, getKnownDomains } from "./knownBrands.js";
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
// Derived from KNOWN_BRANDS — add the domain field there to expand this set.
const IMAP_KNOWN_DOMAINS = getKnownDomains();

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

    // Server-side SEARCH: union subject keywords + Apple billing sender.
    // Replaces the old "fetch all envelopes, slice-1500, filter locally" approach
    // so the full daysBack window is covered regardless of inbox size.
    const IMAP_SUBJECT_KEYWORDS = [
      "subscription", "renewal", "receipt", "invoice",
      "membership", "billing", "welcome", "confirmed", "confirmation",
    ];
    const IMAP_BILLING_SENDERS = ["email.apple.com"];

    const uidSet = new Set();
    for (const kw of IMAP_SUBJECT_KEYWORDS) {
      const uids = await client.search({ since, subject: kw }, { uid: true });
      for (const uid of uids) uidSet.add(uid);
    }
    for (const sender of IMAP_BILLING_SENDERS) {
      const uids = await client.search({ since, from: sender }, { uid: true });
      for (const uid of uids) uidSet.add(uid);
    }

    const relevantUids = [...uidSet].sort((a, b) => a - b);
    scannedCount = relevantUids.length;

    if (!relevantUids.length) return { charges, cancellations, cancelledCharges, scannedCount };

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

        const fromParsed = parsed.from?.value?.[0];
        const fromHeader = fromParsed?.name
          ? `${fromParsed.name} <${fromParsed.address ?? ""}>`
          : (fromParsed?.address ?? "");
        const subject = parsed.subject ?? "";

        // ── Promotional / newsletter filter ───────────────────────────────────
        // Reject emails that are clearly promotional discounts or newsletters —
        // they often mention subscription amounts in a non-billing context and
        // produce false positives.
        const subjectLow = subject.toLowerCase();
        const fromLow2   = fromHeader.toLowerCase();
        const isPromoEmail =
          /\b\d+\s*%\s*off\b/i.test(subject) ||          // "40% off"
          /\$\d+\s*off\b/i.test(subject) ||               // "$40 off"
          /\bfinal\s+hours?\b/i.test(subject) ||          // "FINAL HOURS"
          /\blast\s+chance\b/i.test(subject) ||            // "LAST CHANCE"
          /\blast\s+day\b/i.test(subject) ||               // "LAST DAY"
          /\bflash\s+sale\b/i.test(subject) ||
          /\blimited[\s-]time\s+offer\b/i.test(subject) ||
          /\bnewsletter\b/i.test(fromHeader) ||            // "Sentry Newsletter <...>"
          // One-time purchase / order confirmations — never subscriptions
          /\bprocessing your order\b/i.test(subject) ||
          /\border\s+(acknowledgment|confirmed|confirmation|received)\b/i.test(subject) ||
          /\bthank you for (your )?(purchase|order)\b/i.test(subject);
        if (isPromoEmail) continue;

        const parsedDate = parsed.date ?? null;

        // ── Lifecycle classification ──────────────────────────────────────────
        // Detect cancellation/expiry emails so we can mark the subscription as
        // inactive even if we also have a charge email for it. This mirrors the
        // Gmail scan's lifecycle handling.
        const emailType = classifyEmail(subject, text);
        if (emailType === EMAIL_TYPES.FAILED_PAYMENT) {
          // A failed payment means the subscription existed — save it as inactive
          // so it appears in the app (e.g. Disney+ which only sends payment-failed
          // emails and no separate receipt emails).
          const failedAmount = extractAmount(text);
          if (failedAmount) {
            const failedMerchant = extractMerchant(fromHeader, text, subject);
            if (failedMerchant && failedMerchant !== "unknown") {
              const failedDate = parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate : new Date();
              cancelledCharges.push({
                merchant:        failedMerchant,
                renewalAmount:   failedAmount,
                currency:        extractCurrencyCode(text),
                renewalDate:     extractRenewalDate(text),
                billingInterval: extractBillingInterval(text),
                senderDomain:    extractSenderDomain(fromHeader),
                iconUrl:         null,
                date:            failedDate,
              });
            }
          }
          continue; // not a successful charge
        }
        if (emailType === EMAIL_TYPES.CANCELLATION) {
          // Extract the app/merchant and amount so we can save it as an inactive
          // subscription — important for Apple "Your Subscription is Expiring" emails
          // where the subscription may not have been seen before (first iCloud scan).
          const isAppleSenderC = (fromParsed?.address ?? "").toLowerCase().endsWith("@email.apple.com");
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
                !/^(apple|receipt|invoice|payment|free|trial|subscription|premium|annual|monthly|yearly|weekly|plan|plus|pro|basic|standard|elite|essential|lite)$/i.test(rawName) &&
                !/^(annual|monthly|yearly|weekly)\s+(subscription|plan)$/i.test(rawName)) {
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
                senderDomain:    isAppleSenderC ? null : extractSenderDomain(fromHeader),
                iconUrl:         isAppleSenderC && parsed.html ? extractAppleIconUrl(parsed.html) : null,
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
        // Apple billing/receipt emails always originate from @email.apple.com.
        // Marketing emails come from other Apple domains (InsideApple.Apple.com,
        // store.apple.com, news.apple.com etc.) and must not be treated as receipts.
        const fromAddr = (fromParsed?.address ?? "").toLowerCase();
        const isAppleSender = fromAddr.endsWith("@email.apple.com");
        let appleAppName = isAppleSender && parsed.html
          ? extractAppleAppNameFromHtml(parsed.html)
          : null;

        // Belt-and-suspenders: reject legal entity names that slip through any
        // extraction strategy (e.g. from Strategy C's "Subscription" label row).
        if (appleAppName) {
          const LEGAL_ENTITY = /\b(uab|llc|ltd|limited|inc|incorporated|corporation|corp|corporate|gmbh|bv|srl|sarl|sa|ag|nv|ou|oü|as|aps|ab|oy|sas|spa|kft|sprl|pvt)\b\.?$/i;
          if (LEGAL_ENTITY.test(appleAppName)) {
            console.log(`[imap] rejected_legal_entity: "${appleAppName}" subject="${subject}"`);
            appleAppName = null;
          } else {
            console.log(`[imap] apple_app_name: "${appleAppName}" subject="${subject}"`);
          }
        }

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
              !/^(apple|receipt|invoice|payment|free|trial|subscription|premium|annual|monthly|yearly|weekly|plan|plus|pro|basic|standard|elite|essential|lite)$/i.test(rawName) &&
              !/^(annual|monthly|yearly|weekly)\s+(subscription|plan)$/i.test(rawName)) {
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

        // Apple marketing/hardware emails (InsideApple.Apple.com, orders.apple.com, etc.)
        // match IMAP_KNOWN_DOMAINS via "apple.com" even though they are not billing senders.
        // Only @email.apple.com is a real Apple billing domain — treat all other Apple
        // addresses the same as unknown domains for the hard billing signal check.
        const isBillingKnownDomain = isKnownDomain &&
          !(fromAddr.includes("apple.com") && !isAppleSender);

        // For non-Apple, non-known-domain senders require at least one hard billing
        // signal in the text. Marketing emails, newsletters, and nurture sequences
        // often mention prices and subscription words without being actual receipts.
        // NOTE: brandInfo.confirmSingle is intentionally NOT exempted here — it is a
        // subscription-engine hint (1 charge = enough to confirm a subscription) and
        // has nothing to do with whether an email is a billing email. Exempting it
        // caused Apple marketing emails (whose merchant resolved to "apple" via the
        // display name) to bypass this filter entirely.
        if (!isAppleSender && !isBillingKnownDomain) {
          const hasHardBillingSignal =
            text.includes("receipt") ||
            text.includes("you have been charged") ||
            text.includes("you've been charged") ||
            text.includes("your payment of") ||
            text.includes("payment confirmation") ||
            text.includes("payment successful") ||
            text.includes("payment received") ||
            text.includes("billed to") ||
            text.includes("invoice number") ||
            text.includes("order number") ||
            text.includes("thank you for your payment") ||
            text.includes("your card ending") ||
            subjectLow.includes("receipt") ||
            subjectLow.includes("invoice") ||
            subjectLow.includes("your subscription") ||
            subjectLow.includes("subscription renewal") ||
            subjectLow.includes("subscription confirmed");
          if (!hasHardBillingSignal) continue;
        }

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
        // For Apple IAP emails the sender domain is always apple.com, which would
        // cause BrandAvatar to show the Apple logo for every app. Leave it null so
        // the brand resolver falls back to the merchant name instead.
        const senderDomain = isAppleSender ? null : extractSenderDomain(fromHeader);
        // Extract the actual app icon embedded in the Apple receipt HTML.
        // This is an mzstatic.com CDN image — use it directly in the UI so we
        // don't need any external brand lookup for Apple IAP apps.
        const iconUrl = isAppleSender && parsed.html ? extractAppleIconUrl(parsed.html) : null;

        // Threshold lowered from 3 → 2: a single billing keyword + known domain,
        // or any two subscription signals, is enough intent evidence for IMAP.
        console.log(`[imap] charge: merchant="${merchant}" amount=${amount} subject="${subject}" from="${fromHeader.substring(0, 80)}" iconUrl=${iconUrl ? "yes" : "null"} interval=${billingInterval ?? "null"}`);
        charges.push({
          merchant,
          amount,
          currency: extractCurrencyCode(text),
          date,
          renewalDate,
          billingInterval,
          senderDomain,
          iconUrl,
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