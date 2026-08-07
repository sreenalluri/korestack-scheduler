# KoreStack Book

Multi-tenant appointment scheduling, sold as a service. Each customer
(a dental practice, chiropractor, plumber…) is a **tenant** with their own
providers, services, and hours — and embeds a booking widget on their site
with one script tag:

```html
<script src="https://book.korestack.tech/embed.js" data-key="pk_..." async></script>
```

## What's in the box

| Piece | Path | Notes |
|---|---|---|
| Embed script | `embed.js` | Replaces itself with an auto-resizing iframe |
| Booking widget | `widget/` | service → provider → time → details → confirmed |
| Owner dashboard | `admin/` | magic-link login, setup, week calendar, cancel, block time |
| Public API | `api/public/` | tenant bootstrap, open slots, atomic booking |
| Admin API | `api/admin/` | business, providers, services, availability, bookings |
| Reminder cron | `api/cron/reminders.js` | daily email reminders (SMS reminders are scheduled per-booking via Twilio `SendAt`) |
| Schema | `db/schema.sql` | tables, RLS, `book_appointment` + `create_tenant` RPCs |

Zero npm dependencies — vanilla ESM serverless functions calling Supabase's
REST API with plain `fetch`, same style as korestack.tech.

## Architecture notes

- **Tenant isolation**: owners authenticate with Supabase (magic link); RLS
  restricts them to tenants they're members of. Public widget traffic flows
  through serverless functions that use the service-role key and scope every
  query by the tenant resolved from the `pk_…` public key.
- **No double bookings**: `book_appointment` is a Postgres function that takes
  a per-provider advisory lock, checks overlap against confirmed bookings and
  time blocks, and inserts — all in one transaction. Losers get a 409 and the
  widget refreshes its slot list.
- **Timezones**: weekly availability rules are stored as local wall-clock
  times + the tenant's IANA timezone; bookings/blocks are UTC instants.
  `api/_lib/slots.js` expands rules to UTC slots DST-safely via `Intl`.
- **Notifications degrade gracefully**: no Resend key → no emails; no Twilio →
  no SMS. A booking never fails because a notification did.

## Setup (one time, ~15 minutes)

1. **Supabase**: create a project at https://supabase.com → SQL editor →
   paste and run `db/schema.sql`. In **Auth → URL Configuration** set the
   site URL to your deployment (e.g. `https://book.korestack.tech/admin/`).
2. **Fill the admin config**: in `admin/index.html`, replace
   `__SUPABASE_URL__` and `__SUPABASE_ANON_KEY__` with the values from
   Supabase → Settings → API (the anon key is safe in browsers).
3. **GitHub + Vercel**: create an empty GitHub repo, push this folder, import
   it in Vercel. Add the env vars from `.env.example` (at minimum
   `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`; add Resend/Twilio when ready).
4. **Domain**: point `book.korestack.tech` at the Vercel project.

### Onboarding a customer

1. They (or you) open `/admin/`, sign in with email, name the business.
2. Add providers → services (mapped to providers) → weekly hours.
3. Settings tab → copy the embed snippet → paste into their website.
4. Done — bookings appear in the dashboard; confirmations go out
   automatically.

## Local development

Use `vercel dev` (needs the Vercel CLI + linked project + env vars) — the
serverless functions and static files then run at `localhost:3000`. There is
deliberately no separate local server: functions are plain Vercel handlers.

## v2 backlog

- Customer self-service reschedule/cancel links (the `cancel_token` column
  is already there).
- Stripe deposits per service.
- Multi-location tenants; staff roles beyond owner.
- Per-tenant custom sender identities for email/SMS.
