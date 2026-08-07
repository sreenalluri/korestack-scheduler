// POST /api/public/book
// { key, service_id, provider_id, start, name, email, phone?, notes? }
// Books atomically via the book_appointment RPC (409 if the slot was taken),
// then sends confirmation email + SMS and schedules the reminder SMS.
import { corsPublic, tenantByKey, dbGet, dbRpc, dbUpdate } from "../_lib/db.js";
import { sendEmail, sendSms, scheduleReminderSms, confirmationEmailHtml, fmtLocal } from "../_lib/notify.js";

const UUID_RE = /^[0-9a-f-]{36}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  if (corsPublic(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const b = req.body || {};
    const tenant = await tenantByKey(b.key);
    if (!tenant) return res.status(404).json({ error: "Unknown key" });
    if (!tenant.accepting) return res.status(409).json({ error: "This business is not accepting online bookings right now." });

    // validate input
    if (!UUID_RE.test(b.service_id || "") || !UUID_RE.test(b.provider_id || ""))
      return res.status(400).json({ error: "service_id and provider_id required" });
    const start = new Date(b.start || "");
    if (isNaN(start) || start.getTime() < Date.now())
      return res.status(400).json({ error: "Valid future start time required" });
    const name = String(b.name || "").trim().slice(0, 120);
    const email = String(b.email || "").trim().slice(0, 200);
    const phone = String(b.phone || "").trim().slice(0, 30) || null;
    const notes = String(b.notes || "").trim().slice(0, 1000) || null;
    if (!name || !EMAIL_RE.test(email))
      return res.status(400).json({ error: "Name and a valid email are required" });

    // service must belong to tenant; provider must deliver it
    const [service] = await dbGet("services", `id=eq.${b.service_id}&tenant_id=eq.${tenant.id}&active=is.true&select=*`);
    if (!service) return res.status(404).json({ error: "Unknown service" });
    const link = await dbGet("service_providers", `service_id=eq.${service.id}&provider_id=eq.${b.provider_id}&select=provider_id`);
    if (!link.length) return res.status(400).json({ error: "That provider doesn't offer this service" });
    const [provider] = await dbGet("providers", `id=eq.${b.provider_id}&tenant_id=eq.${tenant.id}&active=is.true&select=*`);
    if (!provider) return res.status(404).json({ error: "Unknown provider" });

    const end = new Date(start.getTime() + service.duration_min * 60 * 1000);

    let booking;
    try {
      booking = await dbRpc("book_appointment", {
        p_tenant_id: tenant.id,
        p_provider_id: provider.id,
        p_service_id: service.id,
        p_starts_at: start.toISOString(),
        p_ends_at: end.toISOString(),
        p_customer_name: name,
        p_customer_email: email,
        p_customer_phone: phone,
        p_notes: notes,
      });
    } catch (e) {
      if (e.code === "SLOT_TAKEN" || e.code === "SLOT_BLOCKED")
        return res.status(409).json({ error: "That time was just taken — please pick another slot.", code: "SLOT_TAKEN" });
      throw e;
    }

    // Notifications — never fail the booking over them.
    const when = fmtLocal(booking.starts_at, tenant.timezone);
    try {
      await sendEmail(email, `Confirmed: ${service.name} on ${when}`,
        confirmationEmailHtml({ tenant, booking, service, provider }));
      if (phone) {
        await sendSms(phone, `${tenant.name}: you're confirmed for ${service.name} with ${provider.name} on ${when}. Questions? ${tenant.phone || ""}`);
        const remindAt = new Date(new Date(booking.starts_at).getTime() - 24 * 3600 * 1000);
        const sid = await scheduleReminderSms(phone,
          `${tenant.name}: reminder — ${service.name} with ${provider.name} tomorrow, ${when}. ${tenant.phone ? "Call " + tenant.phone + " to reschedule." : ""}`,
          remindAt.toISOString());
        if (sid) await dbUpdate("bookings", `id=eq.${booking.id}`, { reminder_sid: sid });
      }
    } catch (e) { console.error("notify error:", e); }

    res.status(201).json({
      booking: {
        id: booking.id, starts_at: booking.starts_at, ends_at: booking.ends_at,
        service: service.name, provider: provider.name, when, timezone: tenant.timezone,
      },
    });
  } catch (e) {
    console.error("book endpoint:", e);
    res.status(500).json({ error: "Something went wrong" });
  }
}
