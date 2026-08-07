-- =============================================================================
-- KoreStack Book — multi-tenant scheduling schema (Supabase / Postgres)
--
-- Run this once in the Supabase SQL editor (Dashboard → SQL → New query).
-- Everything is tenant-scoped: owners see only their tenant via RLS;
-- the public widget goes through serverless functions using the service
-- role key, which scope every query by the tenant's public key.
-- =============================================================================

create extension if not exists pgcrypto;

-- ── Tenants (one row per customer business) ─────────────────────────────────
create table if not exists tenants (
  id          uuid primary key default gen_random_uuid(),
  public_key  text not null unique default ('pk_' || encode(gen_random_bytes(12), 'hex')),
  name        text not null,
  timezone    text not null default 'America/Chicago',
  phone       text,
  email       text,
  address     text,
  -- widget appearance
  brand_color text not null default '#5d7d55',
  -- soft switch: pause all new bookings without removing the widget
  accepting   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Owner/staff membership: which auth.users belong to which tenant.
create table if not exists members (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'owner' check (role in ('owner','staff')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

-- ── Providers (the people delivering services) ──────────────────────────────
create table if not exists providers (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  name       text not null,
  title      text,                       -- "DC", "LMT", "Dr."
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- ── Services ────────────────────────────────────────────────────────────────
create table if not exists services (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  name         text not null,
  description  text,
  duration_min integer not null default 30 check (duration_min between 5 and 480),
  price_cents  integer,                  -- display only in v1
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- Which providers can deliver which services (many-to-many).
create table if not exists service_providers (
  service_id  uuid not null references services(id) on delete cascade,
  provider_id uuid not null references providers(id) on delete cascade,
  primary key (service_id, provider_id)
);

-- ── Availability rules (weekly recurring, in the tenant's local timezone) ───
create table if not exists availability_rules (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  provider_id uuid not null references providers(id) on delete cascade,
  weekday     integer not null check (weekday between 0 and 6),  -- 0=Sunday
  start_time  time not null,             -- local wall-clock time
  end_time    time not null,
  check (start_time < end_time)
);

-- One-off blocked windows (vacation, lunch, meetings) — UTC instants.
create table if not exists time_blocks (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  provider_id uuid not null references providers(id) on delete cascade,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  reason      text,
  check (starts_at < ends_at)
);

-- ── Bookings ────────────────────────────────────────────────────────────────
create table if not exists bookings (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  provider_id    uuid not null references providers(id) on delete cascade,
  service_id     uuid not null references services(id) on delete cascade,
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  status         text not null default 'confirmed'
                 check (status in ('confirmed','cancelled','completed','no_show')),
  customer_name  text not null,
  customer_email text not null,
  customer_phone text,
  notes          text,
  cancel_token   text not null unique default encode(gen_random_bytes(16), 'hex'),
  reminder_sid   text,                   -- Twilio scheduled-message SID, if any
  created_at     timestamptz not null default now(),
  check (starts_at < ends_at)
);

create index if not exists idx_bookings_provider_time on bookings(provider_id, starts_at);
create index if not exists idx_bookings_tenant_time   on bookings(tenant_id, starts_at);

-- ── Atomic booking: conflict check + insert in one transaction ──────────────
-- The serverless layer calls this RPC; the overlap check and the insert
-- happen inside one statement, so two simultaneous requests for the same
-- slot cannot both succeed (second one sees the first's row).
create or replace function book_appointment(
  p_tenant_id      uuid,
  p_provider_id    uuid,
  p_service_id     uuid,
  p_starts_at      timestamptz,
  p_ends_at        timestamptz,
  p_customer_name  text,
  p_customer_email text,
  p_customer_phone text,
  p_notes          text
) returns bookings
language plpgsql
security definer
as $$
declare
  v_booking bookings;
begin
  -- serialize per-provider so concurrent checks can't interleave
  perform pg_advisory_xact_lock(hashtext(p_provider_id::text));

  if exists (
    select 1 from bookings
    where provider_id = p_provider_id
      and status = 'confirmed'
      and tstzrange(starts_at, ends_at) && tstzrange(p_starts_at, p_ends_at)
  ) then
    raise exception 'SLOT_TAKEN' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from time_blocks
    where provider_id = p_provider_id
      and tstzrange(starts_at, ends_at) && tstzrange(p_starts_at, p_ends_at)
  ) then
    raise exception 'SLOT_BLOCKED' using errcode = 'P0001';
  end if;

  insert into bookings (tenant_id, provider_id, service_id, starts_at, ends_at,
                        customer_name, customer_email, customer_phone, notes)
  values (p_tenant_id, p_provider_id, p_service_id, p_starts_at, p_ends_at,
          p_customer_name, p_customer_email, p_customer_phone, p_notes)
  returning * into v_booking;

  return v_booking;
end;
$$;

-- ── Row-level security ──────────────────────────────────────────────────────
-- Owners (authenticated Supabase users) may only touch rows of tenants they
-- belong to. The service role key (server-side only) bypasses RLS.
alter table tenants            enable row level security;
alter table members            enable row level security;
alter table providers          enable row level security;
alter table services           enable row level security;
alter table service_providers  enable row level security;
alter table availability_rules enable row level security;
alter table time_blocks        enable row level security;
alter table bookings           enable row level security;

create or replace function is_member(t uuid) returns boolean
language sql stable security definer as
$$ select exists (select 1 from members where tenant_id = t and user_id = auth.uid()) $$;

create policy member_select on tenants for select using (is_member(id));
create policy member_update on tenants for update using (is_member(id));

create policy members_self on members for select using (user_id = auth.uid());

create policy prov_all on providers          for all using (is_member(tenant_id)) with check (is_member(tenant_id));
create policy svc_all  on services           for all using (is_member(tenant_id)) with check (is_member(tenant_id));
create policy sp_all   on service_providers  for all
  using (exists (select 1 from services s where s.id = service_id and is_member(s.tenant_id)))
  with check (exists (select 1 from services s where s.id = service_id and is_member(s.tenant_id)));
create policy avail_all on availability_rules for all using (is_member(tenant_id)) with check (is_member(tenant_id));
create policy block_all on time_blocks        for all using (is_member(tenant_id)) with check (is_member(tenant_id));
create policy book_sel  on bookings for select using (is_member(tenant_id));
create policy book_upd  on bookings for update using (is_member(tenant_id));

-- ── Tenant signup helper ────────────────────────────────────────────────────
-- Called (as the authenticated user) right after first login to create their
-- business and make them its owner.
create or replace function create_tenant(p_name text, p_timezone text)
returns tenants
language plpgsql
security definer
as $$
declare
  v_tenant tenants;
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;
  insert into tenants (name, timezone) values (p_name, coalesce(p_timezone, 'America/Chicago'))
  returning * into v_tenant;
  insert into members (tenant_id, user_id, role) values (v_tenant.id, auth.uid(), 'owner');
  return v_tenant;
end;
$$;

grant execute on function create_tenant(text, text) to authenticated;
grant execute on function is_member(uuid) to authenticated;
-- book_appointment is invoked only with the service role key (server-side).
revoke execute on function book_appointment(uuid,uuid,uuid,timestamptz,timestamptz,text,text,text,text) from public, anon, authenticated;
