// GET /api/cron/reminders — Vercel daily cron (see vercel.json).
// Emails a reminder for every confirmed booking happening tomorrow
// (tenant-local "tomorrow"). SMS reminders are handled at booking time via
// Twilio's scheduled messages; this cron is the email counterpart + safety net.
// Secured with CRON_SECRET: Vercel sends it as Authorization: Bearer <secret>.
import { dbGet } from "../_lib/db.js";
import { sendEmail, fmtLocal, escapeHtml } from "../_lib/notify.js";

export default async function handler(req, res) {
  if (process.env.CRON_SECRET &&
      req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const now = Date.now();
    const from = new Date(now + 20 * 3600 * 1000);   // ~tomorrow window
    const to = new Date(now + 44 * 3600 * 1000);
    const bookings = await dbGet(
      "bookings",
      `status=eq.confirmed&starts_at=gte.${from.toISOString()}&starts_at=lt.${to.toISOString()}` +
      `&select=*,services(name),providers(name),tenants(name,timezone,phone,address,brand_color)`,
    );

    let sent = 0;
    for (const b of bookings) {
      const tn = b.tenants;
      const when = fmtLocal(b.starts_at, tn.timezone);
      await sendEmail(b.customer_email, `Reminder: ${b.services?.name || "appointment"} tomorrow at ${tn.name}`,
        `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#2a2f28;max-width:520px">
           <h2 style="color:${tn.brand_color || "#5d7d55"}">See you tomorrow, ${escapeHtml(b.customer_name.split(" ")[0])}!</h2>
           <p><b>${escapeHtml(b.services?.name || "Appointment")}</b> with ${escapeHtml(b.providers?.name || "us")}<br>
              ${when} (${escapeHtml(tn.timezone)})</p>
           <p>${escapeHtml(tn.name)}${tn.address ? " · " + escapeHtml(tn.address) : ""}${tn.phone ? " · " + escapeHtml(tn.phone) : ""}</p>
         </div>`);
      sent++;
    }
    res.status(200).json({ ok: true, sent });
  } catch (e) {
    console.error("cron/reminders:", e);
    res.status(500).json({ error: "Something went wrong" });
  }
}
