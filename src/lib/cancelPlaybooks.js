
const PLAYBOOKS = {
  // You can expand this by country + brand slug.
  // brand slug examples: 'netflix', 'spotify', etc.
  default: {
    steps: [
      { title: "Open the account settings", detail: "Go to the service's account/billing settings page." },
      { title: "Find billing/subscription", detail: "Look for 'Subscription', 'Billing', or 'Plan'." },
      { title: "Cancel subscription", detail: "Select Cancel. Take a screenshot of the confirmation." },
      { title: "Verify cancellation email", detail: "Make sure you receive a cancellation confirmation email." },
    ],
    requiredInfo: ["Account email", "Last 4 digits of payment method (if asked)", "Billing address (sometimes)"],
  },
};

export async function getCancelPlaybook({ supabase, userId, brandId, country }) {
  const { data: brand, error: bErr } = await supabase.from("brands").select("id,slug,canonical_name").eq("id", brandId).single();
  if (bErr) throw new Error(`getCancelPlaybook: ${bErr.message}`);

  // Pull last evidence signal extracted fields for deep links (manage/cancel) if present.
  const { data: subs } = await supabase
    .from("subscriptions")
    .select("id,last_evidence_id")
    .eq("user_id", userId)
    .eq("brand_id", brandId)
    .limit(10);

  const lastEvidenceId = subs?.find(s => s.last_evidence_id)?.last_evidence_id || null;

  let extracted = {};
  if (lastEvidenceId) {
    const { data: sig } = await supabase.from("signals").select("extracted").eq("id", lastEvidenceId).single();
    extracted = sig?.extracted || {};
  }

  const pb = PLAYBOOKS[brand.slug] || PLAYBOOKS.default;
  const deepLinks = {
    manage_url: extracted.manage_url || null,
    cancel_url: extracted.cancel_url || null,
    support_email: extracted.support_email || null,
  };

  const steps = [...pb.steps];
  if (deepLinks.cancel_url) {
    steps.unshift({ title: "Open cancellation link", detail: deepLinks.cancel_url });
  } else if (deepLinks.manage_url) {
    steps.unshift({ title: "Open manage link", detail: deepLinks.manage_url });
  }

  return {
    brand: { id: brand.id, slug: brand.slug, name: brand.canonical_name },
    country: country || null,
    tier: "tier0_self_serve",
    deepLinks,
    steps,
    requiredInfo: pb.requiredInfo,
  };
}
