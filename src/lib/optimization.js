
function toNumber(x) {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}
function norm(s) { return String(s || "").trim(); }
function lc(s) { return norm(s).toLowerCase(); }

const CATEGORY_RULES = [
  {
    id: "cloud_storage",
    label: "Cloud storage",
    keywords: ["icloud", "google one", "dropbox", "onedrive", "box"],
  },
  {
    id: "music",
    label: "Music streaming",
    keywords: ["spotify", "apple music", "youtube music", "tidal", "deezer"],
  },
  {
    id: "video_streaming",
    label: "Video streaming",
    keywords: ["netflix", "disney", "hulu", "max", "hbo", "prime video", "paramount", "peacock"],
  },
];

function detectCategory(brandName) {
  const n = lc(brandName);
  for (const c of CATEGORY_RULES) {
    if (c.keywords.some((k) => n.includes(k))) return c;
  }
  return null;
}

export async function getPlanOptimization({ supabase, userId, subscriptionId }) {
  const { data: sub, error } = await supabase
    .from("subscriptions")
    .select("id,user_id,brand_id,plan,amount,currency,cadence,next_charge_at,status,last_evidence_id,brands:brand_id(id,slug,canonical_name)")
    .eq("id", subscriptionId)
    .eq("user_id", userId)
    .single();
  if (error) throw new Error(`getPlanOptimization: ${error.message}`);

  const amount = toNumber(sub.amount);
  const cadence = sub.cadence || null;
  const plan = sub.plan || null;
  const planLc = lc(plan);

  const options = [];
  const recommendations = [];

  if (cadence === "monthly" && amount != null) {
    options.push({
      action: "annual_switch",
      label: "Switch to annual billing",
      est_savings_year: Math.round(amount * 12 * 0.1),
      rationale: "Annual plans often discount vs monthly. Confirm in billing settings.",
    });
    recommendations.push("annual_switch");
  }

  if (planLc.includes("premium") || planLc.includes("family") || planLc.includes("plus")) {
    options.push({
      action: "downgrade",
      label: "Try a cheaper tier",
      rationale: "Your emails suggest a higher tier. If you don't use the extra features, downgrade.",
      suggested_tier: "basic",
    });
    recommendations.push("downgrade");
  }

  if (!plan) {
    options.push({
      action: "confirm_fields",
      label: "Confirm your plan details",
      rationale: "We couldn't detect a plan name reliably from emails yet.",
    });
  }

  return { subscription: sub, detectedPlan: plan, options, recommendedActions: recommendations };
}

export async function getDuplicateCoverage({ supabase, userId }) {
  const { data: subs, error } = await supabase
    .from("subscriptions")
    .select("id,brand_id,plan,amount,currency,cadence,status,brands:brand_id(id,slug,canonical_name)")
    .eq("user_id", userId)
    .neq("status", "canceled");
  if (error) throw new Error(`getDuplicateCoverage: ${error.message}`);

  const buckets = new Map(); // categoryId -> list
  for (const s of subs || []) {
    const name = s?.brands?.canonical_name || s?.brands?.slug || "";
    const cat = detectCategory(name);
    if (!cat) continue;
    const arr = buckets.get(cat.id) || [];
    arr.push({
      subscriptionId: s.id,
      brandId: s.brand_id,
      brand: name,
      amount: s.amount,
      currency: s.currency,
      cadence: s.cadence,
      plan: s.plan,
    });
    buckets.set(cat.id, arr);
  }

  const groups = [];
  for (const c of CATEGORY_RULES) {
    const items = buckets.get(c.id) || [];
    if (items.length < 2) continue;
    groups.push({
      category: { id: c.id, label: c.label },
      items,
      suggestion: "Pick one primary provider; cancel the rest if you don't need redundancy.",
    });
  }

  return {
    groups,
    notes: groups.length
      ? []
      : ["No obvious duplicate coverage detected (or categories not recognized yet)."],
  };
}

export async function getRegionalOptimizations({ country }) {
  const c = lc(country || "");
  // Patch 4: curated safe/legit ideas (no shady arbitrage).
  const base = [
    {
      id: "student_plans",
      title: "Check student plans",
      detail: "Many services offer verified student discounts.",
      safe: true,
    },
    {
      id: "bundles",
      title: "Look for bundles",
      detail: "Telecom or device bundles often include streaming/cloud storage.",
      safe: true,
    },
    {
      id: "family_plan_split",
      title: "Family plan split",
      detail: "If allowed, split a family plan with your household.",
      safe: true,
    },
  ];

  if (c === "pa" || c.includes("panama")) {
    base.push({
      id: "local_telco",
      title: "Check +Movil/Tigo bundles",
      detail: "Telcos sometimes bundle music/video services. Verify current offers.",
      safe: true,
    });
  }

  return { country: country || null, items: base };
}
