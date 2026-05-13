// Known subscription brands with metadata used to improve detection accuracy.
//
// domain        — primary billing/email domain used by this brand; drives the
//                 IMAP known-domain set (single source of truth — no separate list)
// interval      — the billing cycle we know this brand uses
// minAmount     — lowest plausible charge amount (USD); sanity-check lower bound
// maxAmount     — highest plausible charge amount (USD); sanity-check upper bound
// confirmSingle — if true, a single charge from this domain is enough to confirm
//                 a subscription (skips the "need 2+ charges" requirement).
//                 Only set for brands where a charge can only come from a
//                 recurring subscription (not one-time purchases).
// displayName   — properly capitalised name for UI display

const KNOWN_BRANDS = {
  // Streaming
  "netflix":        { domain: "netflix.com",        interval: "monthly",    minAmount: 6,    maxAmount: 30,   confirmSingle: true,  displayName: "Netflix"         },
  "hulu":           { domain: "hulu.com",            interval: "monthly",    minAmount: 5,    maxAmount: 25,   confirmSingle: true,  displayName: "Hulu"            },
  "disney+":        { domain: "disneyplus.com",      interval: "monthly",    minAmount: 7,    maxAmount: 25,   confirmSingle: true,  displayName: "Disney+"         },
  "hbo":            { domain: "hbo.com",             interval: "monthly",    minAmount: 9,    maxAmount: 20,   confirmSingle: true,  displayName: "Max"             },
  "max":            { domain: "max.com",             interval: "monthly",    minAmount: 9,    maxAmount: 20,   confirmSingle: true,  displayName: "Max"             },
  "peacock":        { domain: "peacocktv.com",       interval: "monthly",    minAmount: 5,    maxAmount: 15,   confirmSingle: true,  displayName: "Peacock"         },
  "paramount":      { domain: "paramountplus.com",   interval: "monthly",    minAmount: 5,    maxAmount: 15,   confirmSingle: true,  displayName: "Paramount+"      },
  "youtube":        { domain: "youtube.com",         interval: "monthly",    minAmount: 3,    maxAmount: 30,   confirmSingle: true,  displayName: "YouTube Premium"  },
  "crunchyroll":    { domain: "crunchyroll.com",     interval: "monthly",    minAmount: 7,    maxAmount: 15,   confirmSingle: true,  displayName: "Crunchyroll"     },
  "twitch":         { domain: "twitch.tv",           interval: "monthly",    minAmount: 4,    maxAmount: 30,   confirmSingle: true,  displayName: "Twitch"          },
  // Music
  "spotify":        { domain: "spotify.com",         interval: "monthly",    minAmount: 3,    maxAmount: 20,   confirmSingle: true,  displayName: "Spotify"         },
  "audible":        { domain: "audible.com",         interval: "monthly",    minAmount: 7,    maxAmount: 25,   confirmSingle: true,  displayName: "Audible"         },
  // AI / Productivity
  "openai":         { domain: "openai.com",          interval: "monthly",    minAmount: 10,   maxAmount: 250,  confirmSingle: true,  displayName: "OpenAI"          },
  "anthropic":      { domain: "anthropic.com",       interval: "monthly",    minAmount: 18,   maxAmount: 200,  confirmSingle: true,  displayName: "Anthropic"       },
  "notion":         { domain: "notion.so",           interval: "monthly",    minAmount: 8,    maxAmount: 20,   confirmSingle: true,  displayName: "Notion"          },
  "figma":          { domain: "figma.com",           interval: "monthly",    minAmount: 12,   maxAmount: 150,  confirmSingle: true,  displayName: "Figma"           },
  "github":         { domain: "github.com",          interval: "monthly",    minAmount: 3,    maxAmount: 50,   confirmSingle: true,  displayName: "GitHub"          },
  "adobe":          { domain: "adobe.com",           interval: "monthly",    minAmount: 10,   maxAmount: 900,  confirmSingle: true,  displayName: "Adobe"           },
  "canva":          { domain: "canva.com",           interval: "monthly",    minAmount: 12,   maxAmount: 30,   confirmSingle: true,  displayName: "Canva"           },
  "grammarly":      { domain: "grammarly.com",       interval: "monthly",    minAmount: 12,   maxAmount: 30,   confirmSingle: true,  displayName: "Grammarly"       },
  // Cloud / Dev tools
  "microsoft":      { domain: "microsoft.com",       interval: "monthly",    minAmount: 5,    maxAmount: 400,  confirmSingle: true,  displayName: "Microsoft"       },
  "dropbox":        { domain: "dropbox.com",         interval: "monthly",    minAmount: 10,   maxAmount: 25,   confirmSingle: true,  displayName: "Dropbox"         },
  "slack":          { domain: "slack.com",           interval: "monthly",    minAmount: 7,    maxAmount: 500,  confirmSingle: true,  displayName: "Slack"           },
  "zoom":           { domain: "zoom.us",             interval: "monthly",    minAmount: 13,   maxAmount: 250,  confirmSingle: true,  displayName: "Zoom"            },
  "shopify":        { domain: "shopify.com",         interval: "monthly",    minAmount: 25,   maxAmount: 500,  confirmSingle: true,  displayName: "Shopify"         },
  "squarespace":    { domain: "squarespace.com",     interval: "monthly",    minAmount: 12,   maxAmount: 60,   confirmSingle: true,  displayName: "Squarespace"     },
  "wix":            { domain: "wix.com",             interval: "monthly",    minAmount: 16,   maxAmount: 60,   confirmSingle: true,  displayName: "Wix"             },
  "webflow":        { domain: "webflow.io",          interval: "monthly",    minAmount: 14,   maxAmount: 250,  confirmSingle: true,  displayName: "Webflow"         },
  "linkedin":       { domain: "linkedin.com",        interval: "monthly",    minAmount: 30,   maxAmount: 80,   confirmSingle: true,  displayName: "LinkedIn"        },
  "datadog":        { domain: "datadoghq.com",       interval: "monthly",    minAmount: 15,   maxAmount: 2000, confirmSingle: true,  displayName: "Datadog"         },
  "sentry":         { domain: "sentry.io",           interval: "monthly",    minAmount: 26,   maxAmount: 500,  confirmSingle: true,  displayName: "Sentry"          },
  "vercel":         { domain: "vercel.com",          interval: "monthly",    minAmount: 20,   maxAmount: 400,  confirmSingle: true,  displayName: "Vercel"          },
  "netlify":        { domain: "netlify.com",         interval: "monthly",    minAmount: 19,   maxAmount: 500,  confirmSingle: true,  displayName: "Netlify"         },
  "airtable":       { domain: "airtable.com",        interval: "monthly",    minAmount: 10,   maxAmount: 200,  confirmSingle: true,  displayName: "Airtable"        },
  "hubspot":        { domain: "hubspot.com",         interval: "monthly",    minAmount: 18,   maxAmount: 2000, confirmSingle: true,  displayName: "HubSpot"         },
  "intercom":       { domain: "intercom.io",         interval: "monthly",    minAmount: 39,   maxAmount: 500,  confirmSingle: true,  displayName: "Intercom"        },
  "zendesk":        { domain: "zendesk.com",         interval: "monthly",    minAmount: 19,   maxAmount: 500,  confirmSingle: true,  displayName: "Zendesk"         },
  // Wellness / Learning
  "duolingo":       { domain: "duolingo.com",        interval: "monthly",    minAmount: 6,    maxAmount: 20,   confirmSingle: true,  displayName: "Duolingo"        },
  "headspace":      { domain: "headspace.com",       interval: "monthly",    minAmount: 12,   maxAmount: 100,  confirmSingle: true,  displayName: "Headspace"       },
  "calm":           { domain: "calm.com",            interval: "yearly",     minAmount: 40,   maxAmount: 100,  confirmSingle: true,  displayName: "Calm"            },
  "peloton":        { domain: "onepeloton.com",      interval: "monthly",    minAmount: 12,   maxAmount: 50,   confirmSingle: true,  displayName: "Peloton"         },
  // Creator / Publishing
  "substack":       { domain: "substack.com",        interval: "monthly",    minAmount: 5,    maxAmount: 100,  confirmSingle: true,  displayName: "Substack"        },
  "patreon":        { domain: "patreon.com",         interval: "monthly",    minAmount: 1,    maxAmount: 200,  confirmSingle: true,  displayName: "Patreon"         },
  "medium":         { domain: "medium.com",          interval: "monthly",    minAmount: 5,    maxAmount: 20,   confirmSingle: true,  displayName: "Medium"          },
  // Commerce
  "uber one":       { domain: "uber.com",            interval: "monthly",    minAmount: 9,    maxAmount: 30,   confirmSingle: true,  displayName: "Uber One"        },
  // Multi-product brands: Apple one-time purchase receipts have no /month or /year
  // amount pattern and different subjects, so false positives are low.
  "apple":          { domain: "apple.com",           interval: "monthly",    minAmount: 0.99, maxAmount: 150,  confirmSingle: true,  displayName: "Apple"           },
  "google":         { domain: "google.com",          interval: "monthly",    minAmount: 1,    maxAmount: 400,  confirmSingle: false, displayName: "Google"          },
  "amazon":         { domain: "amazon.com",          interval: "yearly",     minAmount: 10,   maxAmount: 250,  confirmSingle: false, displayName: "Amazon"          },
};

/**
 * Returns a Set of all known billing domains, derived from KNOWN_BRANDS.
 * Use this instead of a separate hardcoded domain list.
 */
export function getKnownDomains() {
  return new Set(Object.values(KNOWN_BRANDS).map((b) => b.domain).filter(Boolean));
}

/**
 * Returns the brand config for a normalised merchant name, or null if unknown.
 * @param {string} merchant - normalised merchant name (e.g. "netflix", "openai")
 */
export function getBrandInfo(merchant) {
  return KNOWN_BRANDS[merchant] ?? null;
}

/**
 * Returns the properly-capitalised display name for a merchant key.
 * Falls back to title-casing the raw key if not found.
 * @param {string} merchant - normalised merchant key
 * @returns {string}
 */
export function getBrandDisplayName(merchant) {
  const brand = KNOWN_BRANDS[merchant];
  if (brand?.displayName) return brand.displayName;
  // Title-case unknown merchants: "some brand" → "Some Brand"
  return String(merchant)
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
