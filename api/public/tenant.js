// GET /api/public/tenant?key=pk_...
// Widget bootstrap: business info + active services + the providers who
// deliver each. Public, read-only, cacheable for a minute.
import { corsPublic, tenantByKey, dbGet } from "../_lib/db.js";

export default async function handler(req, res) {
  if (corsPublic(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const tenant = await tenantByKey(req.query.key);
    if (!tenant) return res.status(404).json({ error: "Unknown key" });

    const [services, providers, links] = await Promise.all([
      dbGet("services", `tenant_id=eq.${tenant.id}&active=is.true&select=id,name,description,duration_min,price_cents&order=name`),
      dbGet("providers", `tenant_id=eq.${tenant.id}&active=is.true&select=id,name,title&order=name`),
      dbGet("service_providers", `select=service_id,provider_id`),
    ]);
    const provIds = new Set(providers.map(p => p.id));
    const byService = {};
    for (const l of links) {
      if (!provIds.has(l.provider_id)) continue;
      (byService[l.service_id] ||= []).push(l.provider_id);
    }

    res.setHeader("Cache-Control", "public, max-age=60");
    res.status(200).json({
      business: {
        name: tenant.name, timezone: tenant.timezone, phone: tenant.phone,
        address: tenant.address, brandColor: tenant.brand_color, accepting: tenant.accepting,
      },
      services: services.map(s => ({ ...s, provider_ids: byService[s.id] || [] })),
      providers,
    });
  } catch (e) {
    console.error("tenant endpoint:", e);
    res.status(500).json({ error: "Something went wrong" });
  }
}
