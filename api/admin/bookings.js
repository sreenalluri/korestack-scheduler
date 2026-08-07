// /api/admin/bookings — GET ?from=&to= (calendar range), PATCH ?id= to
// cancel / complete / no_show. Cancelling notifies the customer and
// cancels any scheduled Twilio reminder.
import { corsAdmin, requireOwner, dbGet, dbUpdate } from "../_lib/db.js";
import { sendEmail, sendSms, cancelScheduledSms, fmtLocal, escapeHtml } from "../_lib/notify.js";

const STATUSES = ["cancelled", "completed", "no_show", "confirmed"];

export default async function handler(req, res) {
  if (corsAdmin(req, res)) return;
  const auth = await requireOwner(req, res);
  if (!auth) return;
  const t = auth.tenant.id;

  try {
    if (req.method === "GET") {
      const from = new Date(req.query.from || Date.now() - 7 * 24 * 3600 * 1000);
      const to = new Date(req.query.to || Date.now() + 30 * 24 * 3600 * 1000);
      const bookings = await dbGet(
        "bookings",
        `tenant_id=eq.${t}&starts_at=gte.${from.toISOString()}&starts_at=lt.${to.toISOString()}` +
        `&select=*,services(name,duration_min),providers(name)&order=starts_at`,
      );
      return res.status(200).json({ bookings });
    }

    if (req.method === "PATCH") {
      const id = req.query.id;
      const status = req.body?.status;
      if (!id || !STATUSES.includes(status)) return res.status(400).json({ error: "id and valid status required" });

      const [existing] = await dbGet("bookings", `id=eq.${id}&tenant_id=eq.${t}&select=*,services(name),providers(name)`);
      if (!existing) return res.status(404).json({ error: "Not found" });

      const [booking] = await dbUpdate("bookings", `id=eq.${id}&tenant_id=eq.${t}`, { status });

      if (status === "cancelled" && existing.status === "confirmed") {
        const when = fmtLocal(existing.starts_at, auth.tenant.timezone);
        try {
          if (existing.reminder_sid) await cancelScheduledSms(existing.reminder_sid);
          await sendEmail(existing.customer_email,
            `Cancelled: ${existing.services?.name || "your appointment"} on ${when}`,
            `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#2a2f28">
               <p>Hi ${escapeHtml(existing.customer_name.split(" ")[0])},</p>
               <p>Your ${escapeHtml(existing.services?.name || "appointment")} with
                  ${escapeHtml(existing.providers?.name || "us")} on <b>${when}</b> has been cancelled by
                  ${escapeHtml(auth.tenant.name)}.</p>
               <p>${auth.tenant.phone ? "Call " + escapeHtml(auth.tenant.phone) + " or " : ""}book a new time whenever you're ready.</p>
             </div>`);
          if (existing.customer_phone)
            await sendSms(existing.customer_phone,
              `${auth.tenant.name}: your ${existing.services?.name || "appointment"} on ${when} has been cancelled. ${auth.tenant.phone ? "Call " + auth.tenant.phone + " to rebook." : ""}`);
        } catch (e) { console.error("cancel notify:", e); }
      }

      return res.status(200).json({ booking });
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("admin/bookings:", e);
    res.status(500).json({ error: "Something went wrong" });
  }
}
