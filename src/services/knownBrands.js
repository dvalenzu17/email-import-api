// Known subscription brands with metadata used to improve detection accuracy.
//
// interval      — the billing cycle we know this brand uses
// minAmount     — lowest plausible charge amount (USD); sanity-check lower bound
// maxAmount     — highest plausible charge amount (USD); sanity-check upper bound
// confirmSingle — if true, a single charge from this domain is enough to confirm
//                 a subscription (skips the "need 2+ charges" requirement).
//                 Only set for brands where a charge can only come from a
//                 recurring subscription (not one-time purchases).

const KNOWN_BRANDS = {
  "netflix":      { interval: "monthly",    minAmount: 6,    maxAmount: 30,   confirmSingle: true  },
  "spotify":      { interval: "monthly",    minAmount: 3,    maxAmount: 20,   confirmSingle: true  },
  "openai":       { interval: "monthly",    minAmount: 10,   maxAmount: 250,  confirmSingle: true  },
  "adobe":        { interval: "monthly",    minAmount: 10,   maxAmount: 900,  confirmSingle: true  },
  "microsoft":    { interval: "monthly",    minAmount: 5,    maxAmount: 400,  confirmSingle: true  },
  "dropbox":      { interval: "monthly",    minAmount: 10,   maxAmount: 25,   confirmSingle: true  },
  "hulu":         { interval: "monthly",    minAmount: 5,    maxAmount: 25,   confirmSingle: true  },
  "disney+":      { interval: "monthly",    minAmount: 7,    maxAmount: 25,   confirmSingle: true  },
  "notion":       { interval: "monthly",    minAmount: 8,    maxAmount: 20,   confirmSingle: true  },
  "figma":        { interval: "monthly",    minAmount: 12,   maxAmount: 150,  confirmSingle: true  },
  "github":       { interval: "monthly",    minAmount: 3,    maxAmount: 50,   confirmSingle: true  },
  "anthropic":    { interval: "monthly",    minAmount: 18,   maxAmount: 200,  confirmSingle: true  },
  "linkedin":     { interval: "monthly",    minAmount: 30,   maxAmount: 80,   confirmSingle: true  },
  "zoom":         { interval: "monthly",    minAmount: 13,   maxAmount: 250,  confirmSingle: true  },
  "slack":        { interval: "monthly",    minAmount: 7,    maxAmount: 500,  confirmSingle: true  },
  "shopify":      { interval: "monthly",    minAmount: 25,   maxAmount: 500,  confirmSingle: true  },
  "squarespace":  { interval: "monthly",    minAmount: 12,   maxAmount: 60,   confirmSingle: true  },
  "wix":          { interval: "monthly",    minAmount: 16,   maxAmount: 60,   confirmSingle: true  },
  "webflow":      { interval: "monthly",    minAmount: 14,   maxAmount: 250,  confirmSingle: true  },
  "youtube":      { interval: "monthly",    minAmount: 3,    maxAmount: 30,   confirmSingle: true  },
  "uber one":     { interval: "monthly",    minAmount: 9,    maxAmount: 30,   confirmSingle: true  },
  // Multi-product brands: not safe to confirm on a single charge because they
  // also send one-time purchase receipts.
  "apple":        { interval: "monthly",    minAmount: 0.99, maxAmount: 150,  confirmSingle: false },
  "google":       { interval: "monthly",    minAmount: 1,    maxAmount: 400,  confirmSingle: false },
  "amazon":       { interval: "yearly",     minAmount: 10,   maxAmount: 250,  confirmSingle: false },
};

/**
 * Returns the brand config for a normalised merchant name, or null if unknown.
 * @param {string} merchant - normalised merchant name (e.g. "netflix", "openai")
 */
export function getBrandInfo(merchant) {
  return KNOWN_BRANDS[merchant] ?? null;
}
