// Shared server-side helpers. Zero dependencies — plain fetch against
// Supabase's REST (PostgREST) and Auth APIs using env vars:
//   SUPABASE_URL              https://<project>.supabase.co
//   SUPABASE_SERVICE_KEY      service-role key (server only — bypasses RLS;
//                             every query here MUST scope by tenant_id)
//   ALLOWED_ORIGIN            origin of the admin app, e.g. https://book.korestack.tech

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;

// Legacy service_role keys are JWTs and go in both headers; newer
// `sb_secret_…` keys must only be sent as `apikey` (they aren't JWTs).
const KEY_IS_JWT = /^eyJ/.test(KEY || "");

function headers(extra = {}) {
  return {
    apikey: KEY,
    ...(KEY_IS_JWT ? { Authorization: `Bearer ${KEY}` } : {}),
    "Content-Type": "application/json",
    ...extra,
  };
}

/** GET rows. `query` is a PostgREST query string (already URL-encoded). */
export async function dbGet(table, query) {
  const r = await fetch(`${URL_}/rest/v1/${table}?${query}`, { headers: headers() });
  if (!r.ok) throw new Error(`db get ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}

/** INSERT rows (array or object). Returns inserted rows. */
export async function dbInsert(table, rows) {
  const r = await fetch(`${URL_}/rest/v1/${table}`, {
    method: "POST",
    headers: headers({ Prefer: "return=representation" }),
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`db insert ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}

/** PATCH rows matching `query`. Returns updated rows. */
export async function dbUpdate(table, query, patch) {
  const r = await fetch(`${URL_}/rest/v1/${table}?${query}`, {
    method: "PATCH",
    headers: headers({ Prefer: "return=representation" }),
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`db update ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}

/** DELETE rows matching `query`. */
export async function dbDelete(table, query) {
  const r = await fetch(`${URL_}/rest/v1/${table}?${query}`, {
    method: "DELETE",
    headers: headers(),
  });
  if (!r.ok) throw new Error(`db delete ${table}: ${r.status} ${await r.text()}`);
}

/** Call a Postgres function (RPC). Throws {code:'SLOT_TAKEN'|...} on P0001. */
export async function dbRpc(fn, args) {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(args),
  });
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try { msg = JSON.parse(text).message || text; } catch {}
    const err = new Error(msg);
    if (/SLOT_TAKEN/.test(msg)) err.code = "SLOT_TAKEN";
    if (/SLOT_BLOCKED/.test(msg)) err.code = "SLOT_BLOCKED";
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

/** Resolve a tenant by its public widget key. Returns null if not found. */
export async function tenantByKey(publicKey) {
  if (!/^pk_[a-f0-9]{24}$/.test(publicKey || "")) return null;
  const rows = await dbGet("tenants", `public_key=eq.${publicKey}&select=*`);
  return rows[0] || null;
}

/** Validate an owner's Supabase JWT; returns {userId} or null. */
export async function userFromToken(token) {
  if (!token) return null;
  const r = await fetch(`${URL_}/auth/v1/user`, {
    headers: { apikey: KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u?.id ? { userId: u.id, email: u.email } : null;
}

/** Auth an admin request: verifies JWT and membership. Returns
 *  {userId, tenant} or sends a 401/403 and returns null. */
export async function requireOwner(req, res) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const user = await userFromToken(token);
  if (!user) { res.status(401).json({ error: "Not signed in" }); return null; }
  const memberships = await dbGet("members", `user_id=eq.${user.userId}&select=tenant_id,role`);
  if (!memberships.length) { res.status(403).json({ error: "No business yet", code: "NO_TENANT" }); return null; }
  const tenants = await dbGet("tenants", `id=eq.${memberships[0].tenant_id}&select=*`);
  return { ...user, tenant: tenants[0], role: memberships[0].role };
}

/** CORS for public widget endpoints (widget iframe is same-origin, but the
 *  embed script may fetch from customer sites): allow any origin, GET/POST. */
export function corsPublic(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return true; }
  return false;
}

/** CORS for admin endpoints: restrict to our own origin. */
export function corsAdmin(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(204).end(); return true; }
  return false;
}
