// GET /api/public/slots?key=pk_...&service=<uuid>&provider=<uuid|any>&from=YYYY-MM-DD&days=7
// Open slots for a service (optionally a specific provider) over a date range.
// Returns slots grouped so the widget can render a day/time picker; each slot
// carries the provider able to take it (needed when provider=any).
import { corsPublic, tenantByKey, dbGet } from "../_lib/db.js";
import { computeSlots } from "../_lib/slots.js";

const UUID_RE = /^[0-9a-f-]{36}$/;

export default async function handler(req, res) {
  if (corsPublic(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const tenant = await tenantByKey(req.query.key);
    if (!tenant) return res.status(404).json({ error: "Unknown key" });
    if (!tenant.accepting) return res.status(200).json({ slots: [] });

    const serviceId = req.query.service;
    if (!UUID_RE.test(serviceId || "")) return res.status(400).json({ error: "service required" });
    const services = await dbGet("services", `id=eq.${serviceId}&tenant_id=eq.${tenant.id}&select=*`);
    const service = services[0];
    if (!service || !service.active) return res.status(404).json({ error: "Unknown service" });

    // which providers?
    const links = await dbGet("service_providers", `service_id=eq.${service.id}&select=provider_id`);
    let providerIds = links.map(l => l.provider_id);
    if (UUID_RE.test(req.query.provider || "")) {
      providerIds = providerIds.filter(id => id === req.query.provider);
    }
    if (!providerIds.length) return res.status(200).json({ slots: [] });

    // date range (max 31 days per request)
    const from = req.query.from ? new Date(`${req.query.from}T00:00:00Z`) : new Date();
    const days = Math.min(Math.max(parseInt(req.query.days || "7", 10) || 7, 1), 31);
    const fromUtc = isNaN(from) ? new Date() : from;
    const toUtc = new Date(fromUtc.getTime() + days * 24 * 3600 * 1000);

    const inList = `in.(${providerIds.join(",")})`;
    const [rules, bookings, blocks] = await Promise.all([
      dbGet("availability_rules", `provider_id=${inList}&select=provider_id,weekday,start_time,end_time`),
      dbGet("bookings", `provider_id=${inList}&status=eq.confirmed&starts_at=lt.${toUtc.toISOString()}&ends_at=gt.${fromUtc.toISOString()}&select=provider_id,starts_at,ends_at`),
      dbGet("time_blocks", `provider_id=${inList}&starts_at=lt.${toUtc.toISOString()}&ends_at=gt.${fromUtc.toISOString()}&select=provider_id,starts_at,ends_at`),
    ]);

    // compute per provider, then merge (keep earliest-provider per start time)
    const merged = new Map();
    for (const pid of providerIds) {
      const slots = computeSlots(
        tenant.timezone,
        rules.filter(r => r.provider_id === pid),
        [...bookings, ...blocks].filter(b => b.provider_id === pid),
        service.duration_min,
        fromUtc, toUtc,
      );
      for (const s of slots) if (!merged.has(s.start)) merged.set(s.start, { ...s, provider_id: pid });
    }

    const out = [...merged.values()].sort((a, b) => a.start.localeCompare(b.start));
    res.status(200).json({ timezone: tenant.timezone, duration_min: service.duration_min, slots: out });
  } catch (e) {
    console.error("slots endpoint:", e);
    res.status(500).json({ error: "Something went wrong" });
  }
}
