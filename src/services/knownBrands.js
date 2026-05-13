// Known subscription brands with metadata used to improve detection accuracy.
//
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
  "netflix":        { interval: "monthly",    minAmount: 6,    maxAmount: 30,   confirmSingle: true,  displayName: "Netflix"        },
  "hulu":           { interval: "monthly",    minAmount: 5,    maxAmount: 25,   confirmSingle: true,  displayName: "Hulu"           },
  "disney+":        { interval: "monthly",    minAmount: 7,    maxAmount: 25,   confirmSingle: true,  displayName: "Disney+"        },
  "hbo":            { interval: "monthly",    minAmount: 9,    maxAmount: 20,   confirmSingle: true,  displayName: "Max"            },
  "max":            { interval: "monthly",    minAmount: 9,    maxAmount: 20,   confirmSingle: true,  displayName: "Max"            },
  "peacock":        { interval: "monthly",    minAmount: 5,    maxAmount: 15,   confirmSingle: true,  displayName: "Peacock"        },
  "paramount":      { interval: "monthly",    minAmount: 5,    maxAmount: 15,   confirmSingle: true,  displayName: "Paramount+"     },
  "youtube":        { interval: "monthly",    minAmount: 3,    maxAmount: 30,   confirmSingle: true,  displayName: "YouTube Premium" },
  "crunchyroll":    { interval: "monthly",    minAmount: 7,    maxAmount: 15,   confirmSingle: true,  displayName: "Crunchyroll"    },
  "twitch":         { interval: "monthly",    minAmount: 4,    maxAmount: 30,   confirmSingle: true,  displayName: "Twitch"         },
  // Music
  "spotify":        { interval: "monthly",    minAmount: 3,    maxAmount: 20,   confirmSingle: true,  displayName: "Spotify"        },
  "audible":        { interval: "monthly",    minAmount: 7,    maxAmount: 25,   confirmSingle: true,  displayName: "Audible"        },
  // AI / Productivity
  "openai":         { interval: "monthly",    minAmount: 10,   maxAmount: 250,  confirmSingle: true,  displayName: "OpenAI"         },
  "anthropic":      { interval: "monthly",    minAmount: 18,   maxAmount: 200,  confirmSingle: true,  displayName: "Anthropic"      },
  "notion":         { interval: "monthly",    minAmount: 8,    maxAmount: 20,   confirmSingle: true,  displayName: "Notion"         },
  "figma":          { interval: "monthly",    minAmount: 12,   maxAmount: 150,  confirmSingle: true,  displayName: "Figma"          },
  "github":         { interval: "monthly",    minAmount: 3,    maxAmount: 50,   confirmSingle: true,  displayName: "GitHub"         },
  "adobe":          { interval: "monthly",    minAmount: 10,   maxAmount: 900,  confirmSingle: true,  displayName: "Adobe"          },
  "canva":          { interval: "monthly",    minAmount: 12,   maxAmount: 30,   confirmSingle: true,  displayName: "Canva"          },
  "grammarly":      { interval: "monthly",    minAmount: 12,   maxAmount: 30,   confirmSingle: true,  displayName: "Grammarly"      },
  // Cloud / Dev tools
  "microsoft":      { interval: "monthly",    minAmount: 5,    maxAmount: 400,  confirmSingle: true,  displayName: "Microsoft"      },
  "dropbox":        { interval: "monthly",    minAmount: 10,   maxAmount: 25,   confirmSingle: true,  displayName: "Dropbox"        },
  "slack":          { interval: "monthly",    minAmount: 7,    maxAmount: 500,  confirmSingle: true,  displayName: "Slack"          },
  "zoom":           { interval: "monthly",    minAmount: 13,   maxAmount: 250,  confirmSingle: true,  displayName: "Zoom"           },
  "shopify":        { interval: "monthly",    minAmount: 25,   maxAmount: 500,  confirmSingle: true,  displayName: "Shopify"        },
  "squarespace":    { interval: "monthly",    minAmount: 12,   maxAmount: 60,   confirmSingle: true,  displayName: "Squarespace"    },
  "wix":            { interval: "monthly",    minAmount: 16,   maxAmount: 60,   confirmSingle: true,  displayName: "Wix"            },
  "webflow":        { interval: "monthly",    minAmount: 14,   maxAmount: 250,  confirmSingle: true,  displayName: "Webflow"        },
  "linkedin":       { interval: "monthly",    minAmount: 30,   maxAmount: 80,   confirmSingle: true,  displayName: "LinkedIn"       },
  "datadog":        { interval: "monthly",    minAmount: 15,   maxAmount: 2000, confirmSingle: true,  displayName: "Datadog"        },
  "sentry":         { interval: "monthly",    minAmount: 26,   maxAmount: 500,  confirmSingle: true,  displayName: "Sentry"         },
  "vercel":         { interval: "monthly",    minAmount: 20,   maxAmount: 400,  confirmSingle: true,  displayName: "Vercel"         },
  "netlify":        { interval: "monthly",    minAmount: 19,   maxAmount: 500,  confirmSingle: true,  displayName: "Netlify"        },
  "airtable":       { interval: "monthly",    minAmount: 10,   maxAmount: 200,  confirmSingle: true,  displayName: "Airtable"       },
  "hubspot":        { interval: "monthly",    minAmount: 18,   maxAmount: 2000, confirmSingle: true,  displayName: "HubSpot"        },
  "intercom":       { interval: "monthly",    minAmount: 39,   maxAmount: 500,  confirmSingle: true,  displayName: "Intercom"       },
  "zendesk":        { interval: "monthly",    minAmount: 19,   maxAmount: 500,  confirmSingle: true,  displayName: "Zendesk"        },
  // Wellness / Learning
  "duolingo":       { interval: "monthly",    minAmount: 6,    maxAmount: 20,   confirmSingle: true,  displayName: "Duolingo"       },
  "headspace":      { interval: "monthly",    minAmount: 12,   maxAmount: 100,  confirmSingle: true,  displayName: "Headspace"      },
  "calm":           { interval: "yearly",     minAmount: 40,   maxAmount: 100,  confirmSingle: true,  displayName: "Calm"           },
  "peloton":        { interval: "monthly",    minAmount: 12,   maxAmount: 50,   confirmSingle: true,  displayName: "Peloton"        },
  // Creator / Publishing
  "substack":       { interval: "monthly",    minAmount: 5,    maxAmount: 100,  confirmSingle: true,  displayName: "Substack"       },
  "patreon":        { interval: "monthly",    minAmount: 1,    maxAmount: 200,  confirmSingle: true,  displayName: "Patreon"        },
  "medium":         { interval: "monthly",    minAmount: 5,    maxAmount: 20,   confirmSingle: true,  displayName: "Medium"         },
  // Commerce
  "uber one":       { interval: "monthly",    minAmount: 9,    maxAmount: 30,   confirmSingle: true,  displayName: "Uber One"       },
  // Multi-product brands: Apple one-time purchase receipts have no /month or /year
  // amount pattern and different subjects, so false positives are low.
  "apple":          { interval: "monthly",    minAmount: 0.99, maxAmount: 150,  confirmSingle: true,  displayName: "Apple"          },
  "google":         { interval: "monthly",    minAmount: 1,    maxAmount: 400,  confirmSingle: false, displayName: "Google"         },
  "amazon":         { interval: "yearly",     minAmount: 10,   maxAmount: 250,  confirmSingle: false, displayName: "Amazon"         },
};

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
