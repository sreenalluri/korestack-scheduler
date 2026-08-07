// /api/admin/providers — GET list, POST create, PATCH ?id=, DELETE ?id=
// DELETE soft-deactivates (bookings reference providers; history must survive).
import { corsAdmin, requireOwner, dbGet, dbInsert, dbUpdate } from "../_lib/db.js";

export default async function handler(req, res) {
  if (corsAdmin(req, res)) return;
  const auth = await requireOwner(req, res);
  if (!auth) return;
  const t = auth.tenant.id;

  try {
    if (req.method === "GET") {
      const providers = await dbGet("providers", `tenant_id=eq.${t}&select=*&order=created_at`);
      return res.status(200).json({ providers });
    }
    if (req.method === "POST") {
      const name = String(req.body?.name || "").trim().slice(0, 120);
      if (!name) return res.status(400).json({ error: "Name required" });
      const [provider] = await dbInsert("providers", {
        tenant_id: t, name, title: String(req.body?.title || "").trim().slice(0, 60) || null,
      });
      return res.status(201).json({ provider });
    }
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: "id required" });
    if (req.method === "PATCH") {
      const patch = {};
      for (const k of ["name", "title", "active"]) if (k in (req.body || {})) patch[k] = req.body[k];
      const [provider] = await dbUpdate("providers", `id=eq.${id}&tenant_id=eq.${t}`, patch);
      if (!provider) return res.status(404).json({ error: "Not found" });
      return res.status(200).json({ provider });
    }
    if (req.method === "DELETE") {
      await dbUpdate("providers", `id=eq.${id}&tenant_id=eq.${t}`, { active: false });
      return res.status(200).json({ ok: true });
    }
    res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("admin/providers:", e);
    res.status(500).json({ error: "Something went wrong" });
  }
}
