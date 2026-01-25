
function norm(s) { return String(s || "").trim(); }

export function buildCancelTemplates({ brandName, country, accountEmail }) {
  const bn = norm(brandName) || "the service";
  const c = norm(country) || "your country";
  const email = norm(accountEmail) || "[your account email]";

  const subject = `Cancellation request for ${bn}`;
  const emailBody = `Hello ${bn} Support,

Please cancel my subscription effective immediately.

Account email: ${email}
Country: ${c}

Please confirm the cancellation and any final charges in writing.

Thanks,
${email}
`;

  const chatScript = `Hi! I want to cancel my ${bn} subscription. My account email is ${email}. Please confirm cancellation and effective date.`;

  const requiredInfo = ["Account email", "Plan name (if known)", "Last invoice ID (if available)", "Country/region"];
  return { subject, emailBody, chatScript, requiredInfo };
}
