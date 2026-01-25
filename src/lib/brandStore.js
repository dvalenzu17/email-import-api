import { stableHash } from "./cryptoBox.js";

function slugify(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export async function upsertBrand({ supabase, canonicalName, logoUrl = null, color = null }) {
  const slug = slugify(canonicalName) || stableHash(String(canonicalName || "brand")).slice(0, 12);

  const { data: existing } = await supabase
    .from("brands")
    .select("*")
    .ilike("slug", slug)
    .maybeSingle();

  if (existing) return existing;

  const { data, error } = await supabase
    .from("brands")
    .insert({ slug, canonical_name: canonicalName, logo_url: logoUrl, color })
    .select("*")
    .single();

  if (error) throw new Error(`upsertBrand: ${error.message}`);
  return data;
}

export async function upsertBrandAliases({ supabase, brandId, aliases }) {
  const rows = (aliases || [])
    .filter((a) => a?.kind && a?.alias)
    .map((a) => ({ brand_id: brandId, kind: a.kind, alias: String(a.alias).trim() }));

  if (!rows.length) return { inserted: 0 };

  const { error } = await supabase
    .from("brand_aliases")
    .upsert(rows, { onConflict: "kind,alias", ignoreDuplicates: true });

  if (error) throw new Error(`upsertBrandAliases: ${error.message}`);
  return { inserted: rows.length };
}
