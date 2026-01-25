export async function upsertEmailMessage({ supabase, userId, provider, sample }) {
  if (!sample?.messageId) return null;

  const row = {
    user_id: userId,
    provider,
    message_id: sample.messageId,
    thread_id: sample.threadId || null,
    from_domain: sample.senderDomain || null,
    from_name: sample.fromName || null,
    subject: sample.subject || null,
    sent_at: sample.dateMs ? new Date(sample.dateMs).toISOString() : null,
    attachments_meta: sample.attachmentsMeta || null,
    html: sample.html || null,
    text: sample.text || null,
  };

  const { data, error } = await supabase
    .from("email_messages")
    .upsert(row, { onConflict: "user_id,provider,message_id" })
    .select("*")
    .single();

  if (error) throw new Error(`upsertEmailMessage: ${error.message}`);
  return data;
}

export async function insertSignal({ supabase, userId, emailMessageId, type, extracted, confidence, rawSpans }) {
  const { data, error } = await supabase
    .from("signals")
    .insert({
      user_id: userId,
      email_message_id: emailMessageId || null,
      type,
      extracted: extracted || {},
      confidence: Number(confidence || 0),
      raw_spans: rawSpans || {},
    })
    .select("*")
    .single();

  if (error) throw new Error(`insertSignal: ${error.message}`);
  return data;
}
