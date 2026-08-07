// Slot computation. Availability rules are weekly recurring windows in the
// tenant's local timezone; bookings and time blocks are UTC instants.
// We expand rules into concrete UTC slot candidates for a date range, then
// subtract existing confirmed bookings and blocks.

/** Offset (ms) of `timeZone` from UTC at the given UTC date. DST-safe. */
function tzOffsetMs(timeZone, utcDate) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(utcDate).map(x => [x.type, x.value]));
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour === "24" ? 0 : p.hour, p.minute, p.second);
  return asUTC - utcDate.getTime();
}

/** Convert a local wall-clock time on a local calendar date to a UTC Date. */
function localToUtc(timeZone, y, m, d, hh, mm) {
  // first guess: treat local as UTC, then correct by the zone offset at that instant
  let guess = new Date(Date.UTC(y, m - 1, d, hh, mm));
  const off = tzOffsetMs(timeZone, guess);
  return new Date(guess.getTime() - off);
}

/** The tenant-local calendar date parts + weekday for a UTC instant. */
function localParts(timeZone, utcDate) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  });
  const p = Object.fromEntries(dtf.formatToParts(utcDate).map(x => [x.type, x.value]));
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { y: +p.year, m: +p.month, d: +p.day, weekday: wd };
}

/**
 * Compute open slots.
 * @param tz         tenant IANA timezone
 * @param rules      [{weekday,start_time,end_time,provider_id}]
 * @param busy       [{starts_at,ends_at}] confirmed bookings + blocks (UTC ISO)
 * @param durationMin service duration
 * @param fromUtc,toUtc  Date range to search
 * @param minLeadMs  don't offer slots sooner than this from now
 * @returns [{start,end}] UTC ISO strings, sorted
 */
export function computeSlots(tz, rules, busy, durationMin, fromUtc, toUtc, minLeadMs = 60 * 60 * 1000) {
  const busyRanges = busy
    .map(b => [new Date(b.starts_at).getTime(), new Date(b.ends_at).getTime()])
    .sort((a, b) => a[0] - b[0]);
  const durMs = durationMin * 60 * 1000;
  const earliest = Date.now() + minLeadMs;
  const out = [];

  // Walk each local calendar day in the range (step from range start, day by day).
  for (let t = fromUtc.getTime(); t <= toUtc.getTime() + 24 * 3600 * 1000; t += 24 * 3600 * 1000) {
    const day = localParts(tz, new Date(t));
    for (const r of rules) {
      if (r.weekday !== day.weekday) continue;
      const [sh, sm] = r.start_time.split(":").map(Number);
      const [eh, em] = r.end_time.split(":").map(Number);
      const winStart = localToUtc(tz, day.y, day.m, day.d, sh, sm);
      const winEnd = localToUtc(tz, day.y, day.m, day.d, eh, em);
      // slots on service-duration grid within the window
      for (let s = winStart.getTime(); s + durMs <= winEnd.getTime(); s += durMs) {
        const e = s + durMs;
        if (s < earliest) continue;
        if (s < fromUtc.getTime() || e > toUtc.getTime()) continue;
        const clash = busyRanges.some(([bs, be]) => s < be && e > bs);
        if (!clash) out.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString() });
      }
    }
  }
  // dedupe (overlapping rules) + sort
  const seen = new Set();
  return out
    .filter(s => (seen.has(s.start) ? false : (seen.add(s.start), true)))
    .sort((a, b) => a.start.localeCompare(b.start));
}
