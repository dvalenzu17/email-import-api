
export function startOfISOWeek(d) {
  const date = new Date(d);
  const day = (date.getUTCDay() + 6) % 7; // Mon=0
  date.setUTCDate(date.getUTCDate() - day);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

export function endOfISOWeek(d) {
  const s = startOfISOWeek(d);
  const e = new Date(s);
  e.setUTCDate(e.getUTCDate() + 7);
  return e;
}

export function weeklyTotal(subscriptions, weekStartISO) {
  const start = startOfISOWeek(new Date(weekStartISO));
  const end = endOfISOWeek(start);

  let total = 0;
  let count = 0;

  for (const s of subscriptions || []) {
    if (!s?.next_charge_at) continue;
    const t = new Date(s.next_charge_at).getTime();
    if (t >= start.getTime() && t < end.getTime() && typeof s.amount === "number") {
      total += s.amount;
      count += 1;
    }
  }

  return { weekStart: start.toISOString(), weekEnd: end.toISOString(), total, count };
}
