/* KoreStack Book — owner dashboard.
 * Auth: Supabase magic link (supabase-js, auth only).
 * Data: our /api/admin endpoints, Authorization: Bearer <access_token>.
 * Views: login → onboarding (create business) → tabs
 *   Schedule (week) · Bookings · Providers · Services · Hours · Settings/Embed
 */
(function () {
  "use strict";

  var CFG = window.KB_CONFIG || {};
  var app = document.getElementById("app");
  if (!/^https:\/\//.test(CFG.SUPABASE_URL || "")) {
    app.innerHTML = '<div class="card login center"><h2>Almost there</h2>' +
      '<p class="muted" style="margin-top:8px">This deployment isn’t configured yet: fill in ' +
      "<code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> in <code>admin/index.html</code> " +
      "(see the README, step 2).</p></div>";
    return;
  }
  var sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  var state = { session: null, tenant: null, providers: [], services: [], tab: "schedule", weekStart: startOfWeek(new Date()) };

  /* ---------- helpers -------------------------------------------------- */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function toast(msg) {
    var t = document.querySelector(".toast") || document.body.appendChild(Object.assign(document.createElement("div"), { className: "toast" }));
    t.textContent = msg; t.classList.add("show");
    clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ "Content-Type": "application/json", Authorization: "Bearer " + state.session.access_token }, opts.headers || {});
    if (opts.body && typeof opts.body !== "string") opts.body = JSON.stringify(opts.body);
    return fetch("/api/admin/" + path, opts).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) { j.status = r.status; throw j; } return j; });
    });
  }
  function startOfWeek(d) {
    var x = new Date(d); x.setHours(0, 0, 0, 0);
    x.setDate(x.getDate() - x.getDay()); // Sunday
    return x;
  }
  function fmtT(iso) { return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: state.tenant.timezone }).format(new Date(iso)); }
  function fmtD(iso) { return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: state.tenant.timezone }).format(new Date(iso)); }
  var WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  /* ---------- login ---------------------------------------------------- */
  function renderLogin() {
    app.innerHTML =
      '<div class="card login center">' +
      '<svg class="logo64" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#5d7d55"/><circle cx="32" cy="32" r="19" fill="none" stroke="#fff" stroke-opacity=".4" stroke-width="2.5"/><path fill="#fff" d="M32 12l6.5 17.5L32 26l-6.5 3.5z"/><path fill="#dce8d4" d="M32 52l-6.5-17.5L32 38l6.5-3.5z"/></svg>' +
      "<h1>KoreStack Book</h1>" +
      '<p class="muted" style="margin:6px 0 18px">Sign in with a magic link — no password needed.</p>' +
      '<label for="lg-email" style="text-align:left">Work email</label>' +
      '<input id="lg-email" type="email" placeholder="you@yourpractice.com" autocomplete="email"/>' +
      '<button class="btn" id="lg-send" style="margin-top:14px;width:100%">Email me a sign-in link</button>' +
      '<p class="muted" id="lg-msg" style="margin-top:12px;font-size:.85rem"></p>' +
      "</div>";
    document.getElementById("lg-send").addEventListener("click", function () {
      var email = document.getElementById("lg-email").value.trim();
      var msg = document.getElementById("lg-msg");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { msg.textContent = "Please enter a valid email."; return; }
      this.disabled = true;
      sb.auth.signInWithOtp({ email: email, options: { emailRedirectTo: location.origin + "/admin/" } })
        .then(function (r) {
          msg.textContent = r.error ? r.error.message : "Check your inbox — the link signs you straight in.";
        });
    });
  }

  /* ---------- onboarding ----------------------------------------------- */
  function renderOnboard() {
    var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago";
    app.innerHTML =
      '<div class="card login">' +
      "<h1>Welcome! Set up your business</h1>" +
      '<p class="muted" style="margin:6px 0 10px">You can change all of this later in Settings.</p>' +
      '<label for="ob-name">Business name</label><input id="ob-name" placeholder="True North Chiropractic"/>' +
      '<label for="ob-tz">Timezone</label><input id="ob-tz" value="' + esc(tz) + '"/>' +
      '<button class="btn" id="ob-go" style="margin-top:16px;width:100%">Create my business</button>' +
      '<p class="muted" id="ob-msg" style="margin-top:10px;font-size:.85rem"></p></div>';
    document.getElementById("ob-go").addEventListener("click", function () {
      var name = document.getElementById("ob-name").value.trim();
      if (!name) { document.getElementById("ob-msg").textContent = "Please enter a name."; return; }
      this.disabled = true;
      sb.rpc("create_tenant", { p_name: name, p_timezone: document.getElementById("ob-tz").value.trim() })
        .then(function (r) {
          if (r.error) { document.getElementById("ob-msg").textContent = r.error.message; return; }
          boot();
        });
    });
  }

  /* ---------- shell ----------------------------------------------------- */
  var TABS = [["schedule", "Schedule"], ["bookings", "Bookings"], ["providers", "Providers"], ["services", "Services"], ["hours", "Hours"], ["settings", "Settings"]];

  function renderShell() {
    app.innerHTML =
      '<div class="topbar">' +
      '<div class="brand"><svg width="34" height="34" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#5d7d55"/><path fill="#fff" d="M32 12l6.5 17.5L32 26l-6.5 3.5z"/><path fill="#dce8d4" d="M32 52l-6.5-17.5L32 38l6.5-3.5z"/></svg>' +
      "<span>" + esc(state.tenant.name) + "</span></div>" +
      '<div class="tabs">' + TABS.map(function (t) {
        return '<button class="tab ' + (state.tab === t[0] ? "on" : "") + '" data-t="' + t[0] + '">' + t[1] + "</button>";
      }).join("") + "</div>" +
      '<button class="btn ghost small" id="signout">Sign out</button>' +
      "</div><div id='view'></div>";
    app.querySelectorAll(".tab").forEach(function (b) {
      b.addEventListener("click", function () { state.tab = b.dataset.t; renderShell(); });
    });
    document.getElementById("signout").addEventListener("click", function () {
      sb.auth.signOut().then(function () { location.reload(); });
    });
    var view = document.getElementById("view");
    ({ schedule: vSchedule, bookings: vBookings, providers: vProviders, services: vServices, hours: vHours, settings: vSettings }[state.tab])(view);
  }

  /* ---------- Schedule (week calendar) ---------------------------------- */
  function vSchedule(view) {
    var ws = state.weekStart, we = new Date(ws.getTime() + 7 * 864e5);
    view.innerHTML = '<div class="card"><div class="rowflex" style="margin-bottom:12px">' +
      '<button class="btn ghost small" id="prev">← Prev</button>' +
      "<b>Week of " + fmtD(ws.toISOString()) + "</b>" +
      '<button class="btn ghost small" id="next">Next →</button>' +
      '<button class="btn ghost small right" id="today">Today</button></div>' +
      '<div class="week" id="wk"><p class="muted">Loading…</p></div></div>';
    document.getElementById("prev").onclick = function () { state.weekStart = new Date(ws.getTime() - 7 * 864e5); renderShell(); };
    document.getElementById("next").onclick = function () { state.weekStart = we; renderShell(); };
    document.getElementById("today").onclick = function () { state.weekStart = startOfWeek(new Date()); renderShell(); };

    api("bookings?from=" + ws.toISOString() + "&to=" + we.toISOString()).then(function (j) {
      var byDay = {};
      j.bookings.forEach(function (b) {
        var k = new Intl.DateTimeFormat("en-CA", { timeZone: state.tenant.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(b.starts_at));
        (byDay[k] = byDay[k] || []).push(b);
      });
      var wk = document.getElementById("wk");
      wk.innerHTML = "";
      for (var i = 0; i < 7; i++) {
        var day = new Date(ws.getTime() + i * 864e5);
        var k = new Intl.DateTimeFormat("en-CA", { timeZone: state.tenant.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(day);
        var col = document.createElement("div"); col.className = "col";
        col.innerHTML = "<h4>" + WEEKDAYS[day.getDay()].slice(0, 3) + " " + (day.getMonth() + 1) + "/" + day.getDate() + "</h4>";
        (byDay[k] || []).forEach(function (b) {
          var e = document.createElement("div");
          e.className = "evt" + (b.status !== "confirmed" ? " cancelled" : "");
          e.innerHTML = "<b>" + fmtT(b.starts_at) + " " + esc(b.customer_name) + "</b>" +
            esc((b.services && b.services.name) || "") + " · " + esc((b.providers && b.providers.name) || "");
          e.addEventListener("click", function () { bookingActions(b); });
          col.appendChild(e);
        });
        if (!(byDay[k] || []).length) col.innerHTML += '<p class="muted center" style="font-size:.75rem">—</p>';
        wk.appendChild(col);
      }
    }).catch(function (e) { toast(e.error || "Failed to load"); });
  }

  function bookingActions(b) {
    if (b.status !== "confirmed") return;
    if (!confirm("Cancel " + b.customer_name + "'s " + ((b.services && b.services.name) || "appointment") + " on " + fmtD(b.starts_at) + " at " + fmtT(b.starts_at) + "?\n\nThe customer will be notified.")) return;
    api("bookings?id=" + b.id, { method: "PATCH", body: { status: "cancelled" } })
      .then(function () { toast("Cancelled + customer notified"); renderShell(); })
      .catch(function (e) { toast(e.error || "Failed"); });
  }

  /* ---------- Bookings list --------------------------------------------- */
  function vBookings(view) {
    view.innerHTML = '<div class="card"><h2>Upcoming bookings</h2><div class="list" id="ls"><p class="muted">Loading…</p></div></div>';
    api("bookings?from=" + new Date().toISOString() + "&to=" + new Date(Date.now() + 60 * 864e5).toISOString()).then(function (j) {
      var ls = document.getElementById("ls");
      if (!j.bookings.length) { ls.innerHTML = '<div class="empty">No upcoming bookings yet. Share your widget!</div>'; return; }
      ls.innerHTML = "";
      j.bookings.forEach(function (b) {
        var it = document.createElement("div"); it.className = "item";
        it.innerHTML = "<b>" + esc(b.customer_name) + "</b>" +
          "<small>" + fmtD(b.starts_at) + " " + fmtT(b.starts_at) + " · " + esc((b.services && b.services.name) || "") + " · " + esc((b.providers && b.providers.name) || "") + "</small>" +
          '<span class="pill ' + (b.status === "confirmed" ? "" : "cancelled") + '">' + b.status + "</span>";
        if (b.status === "confirmed") {
          var btn = document.createElement("button"); btn.className = "btn danger small"; btn.textContent = "Cancel";
          btn.addEventListener("click", function () { bookingActions(b); });
          it.appendChild(btn);
        }
        ls.appendChild(it);
      });
    });
  }

  /* ---------- Providers -------------------------------------------------- */
  function vProviders(view) {
    view.innerHTML =
      '<div class="card"><h2>Providers</h2><div class="list" id="ls"></div>' +
      '<div class="rowflex" style="margin-top:14px"><input id="p-name" placeholder="Name (e.g. Dr. Elena Vance)" style="max-width:280px"/>' +
      '<input id="p-title" placeholder="Title (DC, LMT…)" style="max-width:160px"/>' +
      '<button class="btn" id="p-add">Add provider</button></div></div>';
    function load() {
      api("providers").then(function (j) {
        state.providers = j.providers;
        var ls = document.getElementById("ls"); ls.innerHTML = "";
        if (!j.providers.length) ls.innerHTML = '<div class="empty">Add the people who take appointments.</div>';
        j.providers.forEach(function (p) {
          var it = document.createElement("div"); it.className = "item";
          it.innerHTML = "<b>" + esc(p.name) + "</b><small>" + esc(p.title || "") + "</small>" +
            '<span class="pill ' + (p.active ? "" : "off") + '">' + (p.active ? "active" : "inactive") + "</span>";
          var tog = document.createElement("button"); tog.className = "btn ghost small";
          tog.textContent = p.active ? "Deactivate" : "Activate";
          tog.addEventListener("click", function () {
            api("providers?id=" + p.id, { method: "PATCH", body: { active: !p.active } }).then(load);
          });
          it.appendChild(tog); ls.appendChild(it);
        });
      });
    }
    document.getElementById("p-add").addEventListener("click", function () {
      var name = document.getElementById("p-name").value.trim();
      if (!name) return toast("Enter a name");
      api("providers", { method: "POST", body: { name: name, title: document.getElementById("p-title").value.trim() } })
        .then(function () { document.getElementById("p-name").value = ""; document.getElementById("p-title").value = ""; load(); });
    });
    load();
  }

  /* ---------- Services --------------------------------------------------- */
  function vServices(view) {
    view.innerHTML =
      '<div class="card"><h2>Services</h2><div class="list" id="ls"></div>' +
      '<h2 style="margin-top:18px">Add a service</h2>' +
      '<div class="grid2"><div><label>Name</label><input id="s-name" placeholder="Adjustment Visit"/></div>' +
      '<div><label>Duration (minutes)</label><input id="s-dur" type="number" value="30" min="5" max="480"/></div></div>' +
      '<div class="grid2"><div><label>Price (optional, $)</label><input id="s-price" type="number" min="0" placeholder="65"/></div>' +
      '<div><label>Providers who offer it</label><div id="s-provs" class="rowflex" style="padding-top:6px"></div></div></div>' +
      '<button class="btn" id="s-add" style="margin-top:14px">Add service</button></div>';

    api("providers").then(function (j) {
      state.providers = j.providers;
      var box = document.getElementById("s-provs");
      box.innerHTML = j.providers.filter(function (p) { return p.active; }).map(function (p) {
        return '<label style="display:inline-flex;align-items:center;gap:6px;font-weight:400;margin:0">' +
          '<input type="checkbox" style="width:auto" value="' + p.id + '" checked/> ' + esc(p.name) + "</label>";
      }).join("") || '<span class="muted">Add providers first.</span>';
    });

    function load() {
      api("services").then(function (j) {
        state.services = j.services;
        var ls = document.getElementById("ls"); ls.innerHTML = "";
        if (!j.services.length) ls.innerHTML = '<div class="empty">Add the services customers can book.</div>';
        j.services.forEach(function (s) {
          var it = document.createElement("div"); it.className = "item";
          it.innerHTML = "<b>" + esc(s.name) + "</b><small>" + s.duration_min + " min" +
            (s.price_cents != null ? " · $" + (s.price_cents / 100) : "") + " · " + s.provider_ids.length + " provider(s)</small>" +
            '<span class="pill ' + (s.active ? "" : "off") + '">' + (s.active ? "active" : "inactive") + "</span>";
          var tog = document.createElement("button"); tog.className = "btn ghost small";
          tog.textContent = s.active ? "Deactivate" : "Activate";
          tog.addEventListener("click", function () {
            api("services?id=" + s.id, { method: "PATCH", body: { active: !s.active } }).then(load);
          });
          it.appendChild(tog); ls.appendChild(it);
        });
      });
    }
    document.getElementById("s-add").addEventListener("click", function () {
      var name = document.getElementById("s-name").value.trim();
      var dur = parseInt(document.getElementById("s-dur").value, 10);
      var price = document.getElementById("s-price").value;
      var provs = [].map.call(document.querySelectorAll("#s-provs input:checked"), function (c) { return c.value; });
      if (!name || !dur) return toast("Name + duration required");
      if (!provs.length) return toast("Pick at least one provider");
      api("services", { method: "POST", body: { name: name, duration_min: dur, provider_ids: provs, price_cents: price ? Math.round(+price * 100) : null } })
        .then(function () { document.getElementById("s-name").value = ""; load(); toast("Service added"); });
    });
    load();
  }

  /* ---------- Hours (availability + blocks) ------------------------------ */
  function vHours(view) {
    view.innerHTML =
      '<div class="card"><h2>Weekly hours</h2><p class="muted" style="margin-bottom:10px;font-size:.85rem">Recurring windows when each provider takes bookings (local time, ' + esc(state.tenant.timezone) + ').</p>' +
      '<div class="list" id="rules"></div>' +
      '<div class="rowflex" style="margin-top:12px">' +
      '<select id="r-prov" style="max-width:200px"></select>' +
      '<select id="r-day" style="max-width:140px">' + WEEKDAYS.map(function (d, i) { return '<option value="' + i + '"' + (i === 1 ? " selected" : "") + ">" + d + "</option>"; }).join("") + "</select>" +
      '<input id="r-start" type="time" value="09:00" style="max-width:120px"/>' +
      '<input id="r-end" type="time" value="17:00" style="max-width:120px"/>' +
      '<button class="btn" id="r-add">Add hours</button></div></div>' +
      '<div class="card"><h2>Blocked time</h2><p class="muted" style="margin-bottom:10px;font-size:.85rem">One-off exceptions — lunch, vacation, meetings.</p>' +
      '<div class="list" id="blocks"></div>' +
      '<div class="rowflex" style="margin-top:12px">' +
      '<select id="b-prov" style="max-width:200px"></select>' +
      '<input id="b-start" type="datetime-local" style="max-width:210px"/>' +
      '<input id="b-end" type="datetime-local" style="max-width:210px"/>' +
      '<input id="b-reason" placeholder="Reason (optional)" style="max-width:170px"/>' +
      '<button class="btn" id="b-add">Block</button></div></div>';

    api("providers").then(function (j) {
      state.providers = j.providers.filter(function (p) { return p.active; });
      var opts = state.providers.map(function (p) { return '<option value="' + p.id + '">' + esc(p.name) + "</option>"; }).join("");
      document.getElementById("r-prov").innerHTML = opts;
      document.getElementById("b-prov").innerHTML = opts;
      load();
    });

    function provName(id) { var p = state.providers.find(function (x) { return x.id === id; }); return p ? p.name : "?"; }

    function load() {
      api("availability").then(function (j) {
        var rules = document.getElementById("rules"); rules.innerHTML = "";
        if (!j.rules.length) rules.innerHTML = '<div class="empty">No hours yet — the widget shows no open times until you add some.</div>';
        j.rules.forEach(function (r) {
          var it = document.createElement("div"); it.className = "item";
          it.innerHTML = "<b>" + esc(provName(r.provider_id)) + "</b><small>" + WEEKDAYS[r.weekday] + " " + r.start_time.slice(0, 5) + "–" + r.end_time.slice(0, 5) + "</small>";
          var del = document.createElement("button"); del.className = "btn danger small"; del.textContent = "Remove";
          del.addEventListener("click", function () { api("availability?type=rule&id=" + r.id, { method: "DELETE" }).then(load); });
          it.appendChild(del); rules.appendChild(it);
        });
        var blocks = document.getElementById("blocks"); blocks.innerHTML = "";
        if (!j.blocks.length) blocks.innerHTML = '<div class="empty">No upcoming blocked time.</div>';
        j.blocks.forEach(function (b) {
          var it = document.createElement("div"); it.className = "item";
          it.innerHTML = "<b>" + esc(provName(b.provider_id)) + "</b><small>" + fmtD(b.starts_at) + " " + fmtT(b.starts_at) + " → " + fmtT(b.ends_at) + (b.reason ? " · " + esc(b.reason) : "") + "</small>";
          var del = document.createElement("button"); del.className = "btn danger small"; del.textContent = "Remove";
          del.addEventListener("click", function () { api("availability?type=block&id=" + b.id, { method: "DELETE" }).then(load); });
          it.appendChild(del); blocks.appendChild(it);
        });
      });
    }

    document.getElementById("r-add").addEventListener("click", function () {
      api("availability", { method: "POST", body: {
        type: "rule", provider_id: document.getElementById("r-prov").value,
        weekday: +document.getElementById("r-day").value,
        start_time: document.getElementById("r-start").value, end_time: document.getElementById("r-end").value,
      } }).then(load).catch(function (e) { toast(e.error || "Failed"); });
    });
    document.getElementById("b-add").addEventListener("click", function () {
      var s = document.getElementById("b-start").value, e = document.getElementById("b-end").value;
      if (!s || !e) return toast("Pick start and end");
      api("availability", { method: "POST", body: {
        type: "block", provider_id: document.getElementById("b-prov").value,
        starts_at: new Date(s).toISOString(), ends_at: new Date(e).toISOString(),
        reason: document.getElementById("b-reason").value,
      } }).then(load).catch(function (e2) { toast(e2.error || "Failed"); });
    });
  }

  /* ---------- Settings + embed snippet ----------------------------------- */
  function vSettings(view) {
    var t = state.tenant;
    var snippet = '<script src="' + location.origin + '/embed.js" data-key="' + t.public_key + '" async><\/script>';
    view.innerHTML =
      '<div class="card"><h2>Your booking widget</h2>' +
      '<p class="muted" style="margin-bottom:10px;font-size:.9rem">Paste this one line into any website where the booking form should appear:</p>' +
      '<div class="code" id="snippet">' + esc(snippet) + "</div>" +
      '<div class="rowflex" style="margin-top:10px"><button class="btn small" id="copy">Copy snippet</button>' +
      '<a class="btn ghost small" href="/widget/?k=' + t.public_key + '" target="_blank">Preview widget</a>' +
      '<label style="display:inline-flex;align-items:center;gap:8px;margin:0;font-weight:600">' +
      '<input type="checkbox" id="accepting" style="width:auto" ' + (t.accepting ? "checked" : "") + "/> Accepting online bookings</label></div></div>" +
      '<div class="card"><h2>Business details</h2>' +
      '<div class="grid2"><div><label>Name</label><input id="st-name" value="' + esc(t.name) + '"/></div>' +
      '<div><label>Timezone (IANA)</label><input id="st-tz" value="' + esc(t.timezone) + '"/></div>' +
      '<div><label>Phone</label><input id="st-phone" value="' + esc(t.phone || "") + '"/></div>' +
      '<div><label>Email</label><input id="st-email" value="' + esc(t.email || "") + '"/></div>' +
      '<div><label>Address</label><input id="st-addr" value="' + esc(t.address || "") + '"/></div>' +
      '<div><label>Widget brand color</label><input id="st-color" type="color" value="' + esc(t.brand_color) + '" style="height:42px;padding:4px"/></div></div>' +
      '<button class="btn" id="st-save" style="margin-top:14px">Save settings</button></div>';

    document.getElementById("copy").addEventListener("click", function () {
      navigator.clipboard.writeText(snippet).then(function () { toast("Copied!"); });
    });
    document.getElementById("accepting").addEventListener("change", function () {
      api("business", { method: "PATCH", body: { accepting: this.checked } })
        .then(function (j) { state.tenant = j.tenant; toast(j.tenant.accepting ? "Bookings on" : "Bookings paused"); });
    });
    document.getElementById("st-save").addEventListener("click", function () {
      api("business", { method: "PATCH", body: {
        name: document.getElementById("st-name").value.trim(),
        timezone: document.getElementById("st-tz").value.trim(),
        phone: document.getElementById("st-phone").value.trim(),
        email: document.getElementById("st-email").value.trim(),
        address: document.getElementById("st-addr").value.trim(),
        brand_color: document.getElementById("st-color").value,
      } }).then(function (j) { state.tenant = j.tenant; toast("Saved"); renderShell(); })
        .catch(function (e) { toast(e.error || "Failed"); });
    });
  }

  /* ---------- boot ------------------------------------------------------- */
  function boot() {
    sb.auth.getSession().then(function (r) {
      state.session = r.data.session;
      if (!state.session) return renderLogin();
      api("business").then(function (j) {
        state.tenant = j.tenant;
        renderShell();
      }).catch(function (e) {
        if (e.code === "NO_TENANT") return renderOnboard();
        if (e.status === 401) return renderLogin();
        app.innerHTML = '<div class="card login center"><p>' + esc(e.error || "Something went wrong") + "</p></div>";
      });
    });
  }

  sb.auth.onAuthStateChange(function (_evt, session) {
    var had = !!state.session;
    state.session = session;
    if (!had && session) boot();
  });
  boot();
})();
