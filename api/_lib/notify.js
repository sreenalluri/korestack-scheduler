// Notifications: email via Resend, SMS via Twilio. Both are optional —
// missing env vars degrade to a no-op (logged), never a failed booking.
//   RESEND_API_KEY, FROM_EMAIL            confirmation + reminder emails
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID
//     — confirmation SMS now, reminder SMS scheduled via Twilio send_at
//       (no cron needed; Twilio supports scheduling up to 7 days out).

const fmtOpts = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

export function fmtLocal(iso, tz) {
  return new Intl.DateTimeFormat("en-US", { ...fmtOpts, timeZone: tz }).format(new Date(iso));
}

export async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY) { console.log("email skipped (no RESEND_API_KEY):", subject); return; }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.FROM_EMAIL || "bookings@korestack.tech", to: [to], subject, html }),
  });
  if (!r.ok) console.error("resend error:", r.status, await r.text());
}

async function twilioSend(body) {
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !tok || !process.env.TWILIO_MESSAGING_SERVICE_SID) {
    console.log("sms skipped (twilio not configured)"); return null;
  }
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid}:${tok}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error("twilio error:", r.status, JSON.stringify(j)); return null; }
  return j;
}

export async function sendSms(to, text) {
  if (!to) return null;
  return twilioSend({ To: to, MessagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID, Body: text });
}

/** Schedule a reminder SMS via Twilio's native scheduling (send_at must be
 *  between 15 min and 7 days in the future — otherwise we skip; the daily
 *  email-reminder cron still covers it). Returns the message SID or null. */
export async function scheduleReminderSms(to, text, sendAtIso) {
  if (!to) return null;
  const sendAt = new Date(sendAtIso).getTime();
  const now = Date.now();
  if (sendAt < now + 16 * 60 * 1000 || sendAt > now + 7 * 24 * 3600 * 1000 - 60000) return null;
  const j = await twilioSend({
    To: to,
    MessagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
    Body: text,
    ScheduleType: "fixed",
    SendAt: new Date(sendAt).toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
  return j?.sid || null;
}

export async function cancelScheduledSms(sid) {
  const acc = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN;
  if (!acc || !tok || !sid) return;
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${acc}/Messages/${sid}.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${acc}:${tok}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "Status=canceled",
  }).catch(() => {});
}

export function confirmationEmailHtml({ tenant, booking, service, provider }) {
  const when = fmtLocal(booking.starts_at, tenant.timezone);
  return `
  <div style="font-family:system-ui,sans-serif;font-size:15px;color:#2a2f28;max-width:520px">
    <h2 style="color:${tenant.brand_color}">You're booked, ${escapeHtml(booking.customer_name.split(" ")[0])}!</h2>
    <p><b>${escapeHtml(service.name)}</b> with ${escapeHtml(provider.name)}<br>
       ${when} (${escapeHtml(tenant.timezone)})</p>
    <p>${escapeHtml(tenant.name)}${tenant.address ? " · " + escapeHtml(tenant.address) : ""}${tenant.phone ? " · " + escapeHtml(tenant.phone) : ""}</p>
    <p style="color:#6b7466;font-size:13px">Need to change it? Reply to this email or call us
       and mention code <b>${booking.cancel_token.slice(0, 8)}</b>.</p>
  </div>`;
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
