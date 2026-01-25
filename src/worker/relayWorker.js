
/**
 * Patch 6: Relay outbox processor
 * - Pulls queued rows from relay_outbox
 * - Sends via SMTP (nodemailer) if SMTP_HOST is set
 * - Otherwise runs in MOCK mode (marks sent without delivery)
 *
 * Env:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 *   RELAY_MODE=mock|smtp (default auto: smtp if SMTP_HOST else mock)
 */
async function getTransport() {
  const mode = process.env.RELAY_MODE || (process.env.SMTP_HOST ? "smtp" : "mock");
  if (mode !== "smtp") return { mode };

  const mod = await import("nodemailer").catch(() => null);
  if (!mod) return { mode: "mock" };
  const nodemailer = mod.default || mod;

  const port = Number(process.env.SMTP_PORT || 587);
  const secure = port === 465;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });

  return { mode: "smtp", transporter };
}

export async function processRelayOutbox({ supabase, limit = 10 }) {
  const { data: rows, error } = await supabase
    .from("relay_outbox")
    .select("*")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error(`processRelayOutbox: ${error.message}`);

  const transport = await getTransport();
  const results = [];

  for (const r of rows || []) {
    try {
      if (transport.mode === "smtp" && transport.transporter) {
        const from = process.env.SMTP_FROM || process.env.SMTP_USER || "relay@example.com";
        const info = await transport.transporter.sendMail({
          from,
          to: r.to_address,
          subject: r.subject || "",
          text: r.body || "",
        });

        await supabase.from("relay_outbox").update({
          status: "sent",
          updated_at: new Date().toISOString(),
          error: null,
        }).eq("id", r.id);

        results.push({ id: r.id, status: "sent", external: info?.messageId || null });
      } else {
        // MOCK: mark sent
        await supabase.from("relay_outbox").update({
          status: "sent",
          updated_at: new Date().toISOString(),
          error: null,
        }).eq("id", r.id);

        results.push({ id: r.id, status: "sent", external: "mock" });
      }
    } catch (e) {
      await supabase.from("relay_outbox").update({
        status: "failed",
        updated_at: new Date().toISOString(),
        error: String(e?.message || e),
      }).eq("id", r.id);

      results.push({ id: r.id, status: "failed", error: String(e?.message || e) });
    }
  }

  return { processed: results.length, results, mode: transport.mode };
}
