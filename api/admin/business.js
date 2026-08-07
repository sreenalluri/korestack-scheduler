// /api/admin/business — GET current tenant, PATCH settings.
// (Tenant creation happens client-side via the create_tenant RPC as the
// authenticated user; RLS + SECURITY DEFINER handle membership.)
import { corsAdmin, requireOwner, dbUpdate } from "../_lib/db.js";

const EDITABLE = ["name", "timezone", "phone", "email", "address", "brand_color", "accepting"];

export default async function handler(req, res) {
  if (corsAdmin(req, res)) return;
  const auth = await requireOwner(req, res);
  if (!auth) return;

  try {
    if (req.method === "GET") {
      return res.status(200).json({ tenant: auth.tenant, role: auth.role });
    }
    if (req.method === "PATCH") {
      const patch = {};
      for (const k of EDITABLE) if (k in (req.body || {})) patch[k] = req.body[k];
      if (!Object.keys(patch).length) return res.status(400).json({ error: "Nothing to update" });
      const [tenant] = await dbUpdate("tenants", `id=eq.${auth.tenant.id}`, patch);
      return res.status(200).json({ tenant });
    }
    res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("admin/business:", e);
    res.status(500).json({ error: "Something went wrong" });
  }
}
