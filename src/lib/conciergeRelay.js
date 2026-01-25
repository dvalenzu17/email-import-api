
export async function queueRelayEmail({ supabase, requestId, to, subject, body }) {
  const { data, error } = await supabase
    .from("relay_outbox")
    .insert({ request_id: requestId, to_address: to, subject, body, status: "queued" })
    .select("*")
    .single();
  if (error) throw new Error(`queueRelayEmail: ${error.message}`);
  return data;
}

export async function recordCancelMessage({ supabase, requestId, direction, channel = "email", subject, body, toAddress, fromAddress, externalId }) {
  const { data, error } = await supabase
    .from("cancel_request_messages")
    .insert({
      request_id: requestId,
      direction,
      channel,
      subject: subject ?? null,
      body: body ?? null,
      to_address: toAddress ?? null,
      from_address: fromAddress ?? null,
      external_id: externalId ?? null,
    })
    .select("*")
    .single();
  if (error) throw new Error(`recordCancelMessage: ${error.message}`);
  return data;
}
