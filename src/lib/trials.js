
export function isActiveTrial(t, now = new Date()) {
  if (!t?.ends_at) return false;
  return new Date(t.ends_at).getTime() >= now.getTime();
}

export function daysUntil(iso, now = new Date()) {
  const ms = new Date(iso).getTime() - now.getTime();
  return Math.ceil(ms / (24 * 3600 * 1000));
}

export function trialNudgeWindow(trials, windowDays = 7, now = new Date()) {
  const out = [];
  for (const t of trials || []) {
    if (!t?.ends_at) continue;
    const d = daysUntil(t.ends_at, now);
    if (d >= 0 && d <= windowDays) out.push({ ...t, daysUntilEnd: d });
  }
  out.sort((a, b) => new Date(a.ends_at) - new Date(b.ends_at));
  return out;
}

export function computeTrialNotifications(trials, now = new Date()) {
  const notifications = [];
  for (const t of trials || []) {
    if (!t?.ends_at) continue;
    const d = daysUntil(t.ends_at, now);
    if (d === 2) notifications.push({ trialId: t.id, kind: "T-2", when: now.toISOString() });
    if (d === 0) notifications.push({ trialId: t.id, kind: "T-0", when: now.toISOString() });
  }
  return notifications;
}
