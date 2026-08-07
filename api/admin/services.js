// /api/admin/services — GET list (with provider links), POST create,
// PATCH ?id= (fields + provider_ids), DELETE ?id= (soft-deactivate).
import { corsAdmin, requireOwner, dbGet, dbInsert, dbUpdate, dbDelete } from "../_lib/db.js";

async function setProviders(tenantId, serviceId, providerIds) {
  // validate all providers belong to this tenant, then replace the links
  const valid = await dbGet("providers", `tenant_id=eq.${tenantId}&select=id`);
  const ok = new Set(valid.map(p => p.id));
  const wanted = (providerIds || []).filter(id => ok.has(id));
  await dbDelete("service_providers", `service_id=eq.${serviceId}`);
  if (wanted.length) await dbInsert("service_providers", wanted.map(pid => ({ service_id: serviceId, provider_id: pid })));
  return wanted;
}

export default async function handler(req, res) {
  if (corsAdmin(req, res)) return;
  const auth = await requireOwner(req, res);
  if (!auth) return;
  const t = auth.tenant.id;

  try {
    if (req.method === "GET") {
      const [services, links] = await Promise.all([
        dbGet("services", `tenant_id=eq.${t}&select=*&order=created_at`),
        dbGet("service_providers", `select=service_id,provider_id`),
      ]);
      const ids = new Set(services.map(s => s.id));
      const byService = {};
      for (const l of links) if (ids.has(l.service_id)) (byService[l.service_id] ||= []).push(l.provider_id);
      return res.status(200).json({ services: services.map(s => ({ ...s, provider_ids: byService[s.id] || [] })) });
    }
    if (req.method === "POST") {
      const name = String(req.body?.name || "").trim().slice(0, 120);
      const duration = parseInt(req.body?.duration_min, 10);
      if (!name || !(duration >= 5 && duration <= 480))
        return res.status(400).json({ error: "Name and duration (5–480 min) required" });
      const [service] = await dbInsert("services", {
        tenant_id: t, name, duration_min: duration,
        description: String(req.body?.description || "").trim().slice(0, 500) || null,
        price_cents: Number.isFinite(+req.body?.price_cents) ? Math.max(0, Math.round(+req.body.price_cents)) : null,
      });
      const provider_ids = await setProviders(t, service.id, req.body?.provider_ids);
      return res.status(201).json({ service: { ...service, provider_ids } });
    }
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: "id required" });
    if (req.method === "PATCH") {
      const patch = {};
      for (const k of ["name", "description", "duration_min", "price_cents", "active"])
        if (k in (req.body || {})) patch[k] = req.body[k];
      let service = null;
      if (Object.keys(patch).length) {
        [service] = await dbUpdate("services", `id=eq.${id}&tenant_id=eq.${t}`, patch);
        if (!service) return res.status(404).json({ error: "Not found" });
      } else {
        [service] = await dbGet("services", `id=eq.${id}&tenant_id=eq.${t}&select=*`);
        if (!service) return res.status(404).json({ error: "Not found" });
      }
      let provider_ids;
      if ("provider_ids" in (req.body || {})) provider_ids = await setProviders(t, id, req.body.provider_ids);
      return res.status(200).json({ service: { ...service, ...(provider_ids ? { provider_ids } : {}) } });
    }
    if (req.method === "DELETE") {
      await dbUpdate("services", `id=eq.${id}&tenant_id=eq.${t}`, { active: false });
      return res.status(200).json({ ok: true });
    }
    res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("admin/services:", e);
    res.status(500).json({ error: "Something went wrong" });
  }
}
