
const PROVIDERS = ["brandfetch", "logo_dev", "favicon"];

function timeout(ms) {
  return new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms));
}

async function fetchJson(url, opts = {}, ms = 3500) {
  const res = await Promise.race([fetch(url, opts), timeout(ms)]);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function googleFavicon(domain) {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=256`;
}

async function tryBrandfetch(domain) {
  const key = process.env.BRANDFETCH_API_KEY;
  if (!key) return null;
  // Brandfetch Logo API: https://brandfetch.com/
  const url = `https://api.brandfetch.io/v2/brands/${encodeURIComponent(domain)}`;
  const j = await fetchJson(url, { headers: { Authorization: `Bearer ${key}` } });
  const logo = j?.logos?.find((l) => l.type === "logo")?.formats?.[0]?.src || null;
  const color = j?.colors?.[0]?.hex || null;
  return logo ? { logo_url: logo, color, provider: "brandfetch" } : null;
}

async function tryLogoDev(domain) {
  const key = process.env.LOGO_DEV_API_KEY;
  // logo.dev supports key in query: https://logo.dev/
  // If no key, still returns for many domains but may be rate-limited; keep optional.
  const url = `https://img.logo.dev/${encodeURIComponent(domain)}?token=${encodeURIComponent(key || "")}`;
  // We can't HEAD reliably without CORS; store as URL if it looks plausible.
  return { logo_url: url, color: null, provider: "logo_dev" };
}

export async function getBrandAssets({ supabase, brandId }) {
  const { data: brand, error: bErr } = await supabase.from("brands").select("*").eq("id", brandId).single();
  if (bErr) throw new Error(`getBrandAssets: ${bErr.message}`);

  if (brand.logo_url) {
    return { brandId, logo_url: brand.logo_url, color: brand.color || null, provider: brand.assets_provider || "stored", refreshed_at: brand.assets_refreshed_at || null };
  }

  const { data: aliases } = await supabase.from("brand_aliases").select("kind,alias").eq("brand_id", brandId);
  const domain = aliases?.find((a) => a.kind === "domain")?.alias || null;
  const logo = domain ? googleFavicon(domain) : null;

  return { brandId, logo_url: logo, color: brand.color || null, provider: domain ? "favicon" : "none", refreshed_at: brand.assets_refreshed_at || null };
}

export async function refreshBrandAssets({ supabase, brandId }) {
  const { data: aliases } = await supabase.from("brand_aliases").select("kind,alias").eq("brand_id", brandId);
  const domain = aliases?.find((a) => a.kind === "domain")?.alias || null;

  let chosen = null;

  if (domain) {
    // provider order
    try { chosen = await tryBrandfetch(domain); } catch (_) {}
    if (!chosen) {
      try { chosen = await tryLogoDev(domain); } catch (_) {}
    }
    if (!chosen) {
      chosen = { logo_url: googleFavicon(domain), color: null, provider: "favicon" };
    }
  }

  if (chosen?.logo_url) {
    await supabase
      .from("brands")
      .update({
        logo_url: chosen.logo_url,
        color: chosen.color,
        assets_provider: chosen.provider,
        assets_refreshed_at: new Date().toISOString(),
      })
      .eq("id", brandId);
  }

  return { brandId, tried: PROVIDERS, ...chosen, domain };
}

export async function resolveBrand({ supabase, input }) {
  const fromDomain = String(input?.fromDomain || "").toLowerCase().trim();
  const senderName = String(input?.senderName || "").toLowerCase().trim();

  if (fromDomain) {
    const { data: a1 } = await supabase
      .from("brand_aliases")
      .select("brand_id,kind,alias")
      .eq("kind", "domain")
      .ilike("alias", fromDomain)
      .limit(1);
    if (a1?.[0]?.brand_id) return { brand_id: a1[0].brand_id, confidence: 0.9, matched: { kind: "domain", alias: a1[0].alias } };
  }

  if (senderName) {
    const { data: a2 } = await supabase
      .from("brand_aliases")
      .select("brand_id,kind,alias")
      .eq("kind", "sender")
      .ilike("alias", senderName)
      .limit(1);
    if (a2?.[0]?.brand_id) return { brand_id: a2[0].brand_id, confidence: 0.75, matched: { kind: "sender", alias: a2[0].alias } };
  }

  return { brand_id: null, confidence: 0, matched: null };
}
