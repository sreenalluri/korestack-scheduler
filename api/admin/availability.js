// /api/admin/availability — weekly rules + one-off time blocks.
//   GET                     → { rules, blocks }
//   POST {type:'rule'|'block', ...}
//   DELETE ?type=rule|block&id=
import { corsAdmin, requireOwner, dbGet, dbInsert, dbDelete } from "../_lib/db.js";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export default async function handler(req, res) {
  if (corsAdmin(req, res)) return;
  const auth = await requireOwner(req, res);
  if (!auth) return;
  const t = auth.tenant.id;

  try {
    if (req.method === "GET") {
      const [rules, blocks] = await Promise.all([
        dbGet("availability_rules", `tenant_id=eq.${t}&select=*&order=weekday,start_time`),
        dbGet("time_blocks", `tenant_id=eq.${t}&ends_at=gt.${new Date().toISOString()}&select=*&order=starts_at`),
      ]);
      return res.status(200).json({ rules, blocks });
    }

    if (req.method === "POST") {
      const b = req.body || {};
      // provider must belong to tenant
      const prov = await dbGet("providers", `id=eq.${b.provider_id}&tenant_id=eq.${t}&select=id`);
      if (!prov.length) return res.status(400).json({ error: "Unknown provider" });

      if (b.type === "rule") {
        const weekday = parseInt(b.weekday, 10);
        if (!(weekday >= 0 && weekday <= 6) || !TIME_RE.test(b.start_time || "") || !TIME_RE.test(b.end_time || ""))
          return res.status(400).json({ error: "weekday (0–6), start_time and end_time (HH:MM) required" });
        if (b.start_time >= b.end_time) return res.status(400).json({ error: "start must be before end" });
        const [rule] = await dbInsert("availability_rules", {
          tenant_id: t, provider_id: b.provider_id, weekday,
          start_time: b.start_time, end_time: b.end_time,
        });
        return res.status(201).json({ rule });
      }

      if (b.type === "block") {
        const starts = new Date(b.starts_at || ""), ends = new Date(b.ends_at || "");
        if (isNaN(starts) || isNaN(ends) || starts >= ends)
          return res.status(400).json({ error: "Valid starts_at/ends_at required" });
        const [block] = await dbInsert("time_blocks", {
          tenant_id: t, provider_id: b.provider_id,
          starts_at: starts.toISOString(), ends_at: ends.toISOString(),
          reason: String(b.reason || "").trim().slice(0, 200) || null,
        });
        return res.status(201).json({ block });
      }

      return res.status(400).json({ error: "type must be 'rule' or 'block'" });
    }

    if (req.method === "DELETE") {
      const { type, id } = req.query;
      if (!id) return res.status(400).json({ error: "id required" });
      const table = type === "block" ? "time_blocks" : "availability_rules";
      await dbDelete(table, `id=eq.${id}&tenant_id=eq.${t}`);
      return res.status(200).json({ ok: true });
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("admin/availability:", e);
    res.status(500).json({ error: "Something went wrong" });
  }
}
