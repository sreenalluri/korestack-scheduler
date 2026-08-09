#!/usr/bin/env python3
"""Local demo server for KoreStack Book — NOT part of the product.

Serves the repo's static files (embed.js, widget/, admin/, demo/) and
implements BOTH the public widget API and the owner admin API in-memory with
seeded demo data, so the whole product can be exercised without Supabase.
Bookings live in RAM; email/SMS sends are printed to stdout. The admin
endpoints ignore auth (pair with demo/admin.html, which sets KB_CONFIG.DEMO).

Run:  python3 demo/mock-server.py
  patient side:  http://localhost:4180/demo/customer-site.html
  owner side:    http://localhost:4180/demo/admin.html
"""
import json
import re
import threading
import uuid
from datetime import datetime, timedelta, timezone, time as dtime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
PORT = 4180
TZ = "America/Chicago"
KEY = "pk_demo000000000000000000"
LOCK = threading.Lock()

# ── Seed data: True North Chiropractic ──────────────────────────────────────
TENANT = {
    "id": "t0000000-0000-0000-0000-000000000000",
    "public_key": KEY,
    "name": "True North Chiropractic",
    "timezone": TZ,
    "phone": "(214) 555-0163",
    "email": "hello@truenorthchiro.example",
    "address": "3800 McKinney Ave, Suite 240, Dallas, TX",
    "brand_color": "#5d7d55",
    "accepting": True,
}
P_VANCE = "11111111-1111-1111-1111-111111111111"
P_MARCUS = "22222222-2222-2222-2222-222222222222"
PROVIDERS = [
    {"id": P_VANCE, "name": "Dr. Elena Vance", "title": "DC", "active": True},
    {"id": P_MARCUS, "name": "Dr. Marcus Oyelaran", "title": "DC, CCSP", "active": True},
]
S_EXAM, S_ADJ, S_SPORT = ("aaaaaaaa-1111-1111-1111-111111111111",
                          "aaaaaaaa-2222-2222-2222-222222222222",
                          "aaaaaaaa-3333-3333-3333-333333333333")
SERVICES = [
    {"id": S_EXAM, "name": "New Patient Exam", "description": "Exam, posture scan & first adjustment",
     "duration_min": 60, "price_cents": 9500, "active": True, "provider_ids": [P_VANCE, P_MARCUS]},
    {"id": S_ADJ, "name": "Adjustment Visit", "description": "Returning patients",
     "duration_min": 30, "price_cents": 6500, "active": True, "provider_ids": [P_VANCE, P_MARCUS]},
    {"id": S_SPORT, "name": "Sports Injury Evaluation", "description": "Assessment & rehab plan",
     "duration_min": 45, "price_cents": 8500, "active": True, "provider_ids": [P_MARCUS]},
]
RULES = [  # weekday: 0=Sunday (matches the JS convention)
    *[{"id": str(uuid.uuid4()), "provider_id": P_VANCE, "weekday": wd,
       "start_time": "09:00:00", "end_time": "17:00:00"} for wd in (1, 2, 3, 4, 5)],
    *[{"id": str(uuid.uuid4()), "provider_id": P_MARCUS, "weekday": wd,
       "start_time": "07:30:00", "end_time": "15:00:00"} for wd in (1, 3, 5)],
]
BLOCKS = []    # {id, provider_id, starts_at, ends_at, reason}
BOOKINGS = []  # {id, provider_id, service_id, starts_at, ends_at, status, customer_*}


def _local_dt(day, hhmm):
    h, m = map(int, hhmm.split(":"))
    return datetime.combine(day, dtime(h, m), ZoneInfo(TZ))


def _iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _seed():
    """A believable week: bookings on the next few weekdays + one block."""
    today = datetime.now(ZoneInfo(TZ)).date()
    def next_wd(py_wd):           # python Mon=0 … Sun=6
        for i in range(1, 8):
            d = today + timedelta(days=i)
            if d.weekday() == py_wd:
                return d
    mon, tue, wed = next_wd(0), next_wd(1), next_wd(2)
    fri = next_wd(4)
    rows = [
        (P_VANCE,  S_EXAM,  mon, "09:00", "Maya R.",     "maya@example.com",  "(214) 555-1001", "confirmed"),
        (P_VANCE,  S_ADJ,   mon, "10:30", "James C.",    "james@example.com", "(214) 555-1002", "confirmed"),
        (P_MARCUS, S_SPORT, mon, "07:30", "Rahul B.",    "rahul@example.com", None,             "confirmed"),
        (P_VANCE,  S_ADJ,   mon, "15:00", "Danielle K.", "dk@example.com",    "(214) 555-1004", "cancelled"),
        (P_VANCE,  S_ADJ,   tue, "14:00", "Sam Demo",    "sam@example.com",   "(214) 555-7788", "confirmed"),
        (P_MARCUS, S_ADJ,   wed, "09:30", "Lena N.",     "lena@example.com",  "(214) 555-1006", "confirmed"),
        (P_VANCE,  S_EXAM,  fri, "11:00", "Alicia M.",   "alicia@example.com","(214) 555-1007", "confirmed"),
    ]
    for prov, svc_id, day, hhmm, name, email, phone, status in rows:
        svc = next(s for s in SERVICES if s["id"] == svc_id)
        start = _local_dt(day, hhmm)
        BOOKINGS.append({
            "id": str(uuid.uuid4()), "provider_id": prov, "service_id": svc_id,
            "starts_at": _iso(start), "ends_at": _iso(start + timedelta(minutes=svc["duration_min"])),
            "status": status, "customer_name": name, "customer_email": email,
            "customer_phone": phone, "notes": None,
        })
    BLOCKS.append({"id": str(uuid.uuid4()), "provider_id": P_VANCE,
                   "starts_at": _iso(_local_dt(wed, "12:00")), "ends_at": _iso(_local_dt(wed, "13:00")),
                   "reason": "Lunch"})


_seed()


def _dtp(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


def _overlaps(pid, start, end):
    for b in BOOKINGS:
        if b["provider_id"] == pid and b["status"] == "confirmed" and start < _dtp(b["ends_at"]) and end > _dtp(b["starts_at"]):
            return True
    for bl in BLOCKS:
        if bl["provider_id"] == pid and start < _dtp(bl["ends_at"]) and end > _dtp(bl["starts_at"]):
            return True
    return False


def compute_slots(service, provider_ids, days=14):
    tz = ZoneInfo(TZ)
    now = datetime.now(timezone.utc)
    earliest = now + timedelta(hours=1)
    dur = timedelta(minutes=service["duration_min"])
    out = {}
    for d in range(days + 1):
        local_day = (now.astimezone(tz) + timedelta(days=d)).date()
        weekday = (local_day.weekday() + 1) % 7
        for r in RULES:
            if r["provider_id"] not in provider_ids or r["weekday"] != weekday:
                continue
            s = _local_dt(local_day, r["start_time"][:5])
            end = _local_dt(local_day, r["end_time"][:5])
            while s + dur <= end:
                s_utc = s.astimezone(timezone.utc)
                with LOCK:
                    ok = s_utc >= earliest and not _overlaps(r["provider_id"], s_utc, s_utc + dur)
                if ok and _iso(s_utc) not in out:
                    out[_iso(s_utc)] = {"start": _iso(s_utc), "end": _iso(s_utc + dur), "provider_id": r["provider_id"]}
                s += dur
    return sorted(out.values(), key=lambda x: x["start"])


def _joined(b):
    svc = next((s for s in SERVICES if s["id"] == b["service_id"]), None)
    prov = next((p for p in PROVIDERS if p["id"] == b["provider_id"]), None)
    return {**b, "services": {"name": svc["name"], "duration_min": svc["duration_min"]} if svc else None,
            "providers": {"name": prov["name"]} if prov else None}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, fmt, *args):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_OPTIONS(self):
        self._json(204, {})

    # ── GET ────────────────────────────────────────────────────────────────
    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}

        if u.path == "/api/public/tenant":
            if q.get("key") != KEY:
                return self._json(404, {"error": "Unknown key"})
            return self._json(200, {
                "business": {"name": TENANT["name"], "timezone": TENANT["timezone"], "phone": TENANT["phone"],
                             "address": TENANT["address"], "brandColor": TENANT["brand_color"],
                             "accepting": TENANT["accepting"]},
                "services": [s for s in SERVICES if s["active"]],
                "providers": [p for p in PROVIDERS if p["active"]],
            })

        if u.path == "/api/public/slots":
            if q.get("key") != KEY:
                return self._json(404, {"error": "Unknown key"})
            svc = next((s for s in SERVICES if s["id"] == q.get("service") and s["active"]), None)
            if not svc:
                return self._json(404, {"error": "Unknown service"})
            pids = [q["provider"]] if q.get("provider") in svc["provider_ids"] else svc["provider_ids"]
            return self._json(200, {"timezone": TZ, "duration_min": svc["duration_min"],
                                    "slots": compute_slots(svc, pids, int(q.get("days", "14")))})

        if u.path == "/api/admin/business":
            return self._json(200, {"tenant": TENANT, "role": "owner"})

        if u.path == "/api/admin/providers":
            return self._json(200, {"providers": PROVIDERS})

        if u.path == "/api/admin/services":
            return self._json(200, {"services": SERVICES})

        if u.path == "/api/admin/availability":
            return self._json(200, {"rules": sorted(RULES, key=lambda r: (r["weekday"], r["start_time"])),
                                    "blocks": BLOCKS})

        if u.path == "/api/admin/bookings":
            frm = _dtp(q["from"]) if "from" in q else datetime.now(timezone.utc) - timedelta(days=7)
            to = _dtp(q["to"]) if "to" in q else datetime.now(timezone.utc) + timedelta(days=30)
            rows = [b for b in BOOKINGS if frm <= _dtp(b["starts_at"]) < to]
            rows.sort(key=lambda b: b["starts_at"])
            return self._json(200, {"bookings": [_joined(b) for b in rows]})

        if u.path == "/widget":
            self.path = "/widget/index.html"
        return super().do_GET()

    # ── POST ───────────────────────────────────────────────────────────────
    def do_POST(self):
        u = urlparse(self.path)
        body = self._body()

        if u.path == "/api/public/book":
            if body.get("key") != KEY:
                return self._json(404, {"error": "Unknown key"})
            svc = next((s for s in SERVICES if s["id"] == body.get("service_id")), None)
            prov = next((p for p in PROVIDERS if p["id"] == body.get("provider_id")), None)
            if not svc or not prov:
                return self._json(404, {"error": "Unknown service or provider"})
            if not body.get("name") or not re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", body.get("email", "")):
                return self._json(400, {"error": "Name and a valid email are required"})
            start = _dtp(body["start"])
            end = start + timedelta(minutes=svc["duration_min"])
            with LOCK:
                if _overlaps(prov["id"], start, end):
                    return self._json(409, {"error": "That time was just taken — please pick another slot.",
                                            "code": "SLOT_TAKEN"})
                BOOKINGS.append({
                    "id": str(uuid.uuid4()), "provider_id": prov["id"], "service_id": svc["id"],
                    "starts_at": _iso(start), "ends_at": _iso(end), "status": "confirmed",
                    "customer_name": body["name"], "customer_email": body["email"],
                    "customer_phone": body.get("phone") or None, "notes": body.get("notes") or None,
                })
            when = start.astimezone(ZoneInfo(TZ)).strftime("%a, %b %-d, %-I:%M %p")
            print(f"[email] to={body['email']} :: Confirmed: {svc['name']} on {when}", flush=True)
            if body.get("phone"):
                print(f"[sms]   to={body['phone']} :: confirmed + reminder scheduled (mock)", flush=True)
            return self._json(201, {"booking": {"id": BOOKINGS[-1]["id"], "starts_at": body["start"],
                                                "service": svc["name"], "provider": prov["name"],
                                                "when": when, "timezone": TZ}})

        if u.path == "/api/admin/providers":
            p = {"id": str(uuid.uuid4()), "name": body.get("name", "").strip(),
                 "title": (body.get("title") or "").strip() or None, "active": True}
            PROVIDERS.append(p)
            return self._json(201, {"provider": p})

        if u.path == "/api/admin/services":
            s = {"id": str(uuid.uuid4()), "name": body.get("name", "").strip(),
                 "description": (body.get("description") or "").strip() or None,
                 "duration_min": int(body.get("duration_min") or 30),
                 "price_cents": body.get("price_cents"), "active": True,
                 "provider_ids": [pid for pid in (body.get("provider_ids") or [])
                                  if any(p["id"] == pid for p in PROVIDERS)]}
            SERVICES.append(s)
            return self._json(201, {"service": s})

        if u.path == "/api/admin/availability":
            if body.get("type") == "rule":
                r = {"id": str(uuid.uuid4()), "provider_id": body["provider_id"],
                     "weekday": int(body["weekday"]),
                     "start_time": body["start_time"] + ":00", "end_time": body["end_time"] + ":00"}
                RULES.append(r)
                return self._json(201, {"rule": r})
            if body.get("type") == "block":
                bl = {"id": str(uuid.uuid4()), "provider_id": body["provider_id"],
                      "starts_at": body["starts_at"], "ends_at": body["ends_at"],
                      "reason": (body.get("reason") or "").strip() or None}
                BLOCKS.append(bl)
                return self._json(201, {"block": bl})
            return self._json(400, {"error": "type must be 'rule' or 'block'"})

        return self._json(404, {"error": "Not found"})

    # ── PATCH / DELETE ─────────────────────────────────────────────────────
    def do_PATCH(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        body = self._body()

        if u.path == "/api/admin/business":
            for k in ("name", "timezone", "phone", "email", "address", "brand_color", "accepting"):
                if k in body:
                    TENANT[k] = body[k]
            return self._json(200, {"tenant": TENANT})

        if u.path == "/api/admin/providers":
            p = next((x for x in PROVIDERS if x["id"] == q.get("id")), None)
            if not p:
                return self._json(404, {"error": "Not found"})
            for k in ("name", "title", "active"):
                if k in body:
                    p[k] = body[k]
            return self._json(200, {"provider": p})

        if u.path == "/api/admin/services":
            s = next((x for x in SERVICES if x["id"] == q.get("id")), None)
            if not s:
                return self._json(404, {"error": "Not found"})
            for k in ("name", "description", "duration_min", "price_cents", "active", "provider_ids"):
                if k in body:
                    s[k] = body[k]
            return self._json(200, {"service": s})

        if u.path == "/api/admin/bookings":
            b = next((x for x in BOOKINGS if x["id"] == q.get("id")), None)
            if not b:
                return self._json(404, {"error": "Not found"})
            old = b["status"]
            b["status"] = body.get("status", b["status"])
            if b["status"] == "cancelled" and old == "confirmed":
                print(f"[email] to={b['customer_email']} :: Cancelled: your appointment", flush=True)
                if b["customer_phone"]:
                    print(f"[sms]   to={b['customer_phone']} :: cancellation notice (mock)", flush=True)
            return self._json(200, {"booking": b})

        return self._json(404, {"error": "Not found"})

    def do_DELETE(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if u.path == "/api/admin/availability":
            global RULES, BLOCKS
            if q.get("type") == "block":
                BLOCKS = [b for b in BLOCKS if b["id"] != q.get("id")]
            else:
                RULES = [r for r in RULES if r["id"] != q.get("id")]
            return self._json(200, {"ok": True})
        return self._json(404, {"error": "Not found"})


if __name__ == "__main__":
    print(f"KoreStack Book demo:", flush=True)
    print(f"  patient → http://localhost:{PORT}/demo/customer-site.html", flush=True)
    print(f"  owner   → http://localhost:{PORT}/demo/admin.html", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
