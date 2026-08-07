/* KoreStack Book — booking widget.
 * Flow: service → provider (or "first available") → day → time → details → done.
 * Runs inside the embed iframe; reports its height to the parent page.
 */
(function () {
  "use strict";

  var API = ""; // same origin
  var KEY = new URLSearchParams(location.search).get("k") || "";
  var app = document.getElementById("app");

  var state = {
    data: null,          // bootstrap payload
    service: null,
    provider: null,      // provider id or "any"
    dayKey: null,        // YYYY-MM-DD (tenant-local)
    slot: null,          // {start,end,provider_id}
    slots: [],           // fetched slots for current selection
    slotsByDay: {},
    step: 0,             // 0 service, 1 provider, 2 time, 3 details, 4 done
    submitting: false,
  };

  /* ---- height reporting to the embed parent -------------------------- */
  function reportHeight() {
    var h = document.documentElement.scrollHeight;
    try { parent.postMessage({ type: "korestack-book:height", height: h + 8 }, "*"); } catch (e) {}
  }
  new MutationObserver(function () { requestAnimationFrame(reportHeight); })
    .observe(document.body, { childList: true, subtree: true });
  window.addEventListener("load", reportHeight);

  /* ---- utils ---------------------------------------------------------- */
  function el(html) { var d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstChild; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function fmtTime(iso, tz) { return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso)); }
  function fmtDayLabel(key, tz) {
    var d = new Date(key + "T12:00:00Z");
    return {
      wd: new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(d),
      md: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(d),
    };
  }
  function dayKeyOf(iso, tz) {
    var p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
    return p; // en-CA gives YYYY-MM-DD
  }
  function price(cents) { return cents == null ? "" : " · $" + (cents / 100).toFixed(cents % 100 ? 2 : 0); }

  function get(url) {
    return fetch(API + url).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || "Request failed"); return j; });
    });
  }

  /* ---- rendering ------------------------------------------------------ */
  function stepsBar() {
    var out = '<div class="steps">';
    for (var i = 0; i < 4; i++) out += '<span class="' + (i <= state.step ? "on" : "") + '"></span>';
    return out + "</div>";
  }

  function header() {
    var b = state.data.business;
    return '<h2>Book with ' + esc(b.name) + "</h2>" +
      '<p class="sub">' + (b.address ? esc(b.address) + " · " : "") + "Times shown in " + esc(b.timezone.replace(/_/g, " ")) + "</p>" + stepsBar();
  }

  function footer() {
    return '<p class="powered">Powered by <a href="https://www.korestack.tech" target="_blank" rel="noopener">KoreStack Book</a></p>';
  }

  function render(html) { app.innerHTML = header() + html + footer(); reportHeight(); }

  function renderService() {
    state.step = 0;
    var opts = state.data.services.filter(function (s) { return s.provider_ids.length; }).map(function (s) {
      return '<button class="opt" data-id="' + s.id + '"><b>' + esc(s.name) + "</b><small>" +
        s.duration_min + " min" + price(s.price_cents) + (s.description ? " — " + esc(s.description) : "") + "</small></button>";
    }).join("");
    render("<h3>What do you need?</h3><div class='opts'>" + (opts || "<p class='muted'>No services are bookable right now.</p>") + "</div>");
    app.querySelectorAll(".opt").forEach(function (b) {
      b.addEventListener("click", function () {
        state.service = state.data.services.find(function (s) { return s.id === b.dataset.id; });
        renderProvider();
      });
    });
  }

  function renderProvider() {
    state.step = 1;
    var provs = state.data.providers.filter(function (p) { return state.service.provider_ids.indexOf(p.id) !== -1; });
    var opts = '<button class="opt" data-id="any"><b>First available</b><small>Any provider</small></button>' +
      provs.map(function (p) {
        return '<button class="opt" data-id="' + p.id + '"><b>' + esc(p.name) + "</b>" + (p.title ? "<small>" + esc(p.title) + "</small>" : "") + "</button>";
      }).join("");
    render("<h3>Who would you like to see?</h3><div class='opts'>" + opts + "</div>" +
      '<div class="nav"><button class="btn ghost" id="back">Back</button></div>');
    app.querySelector("#back").addEventListener("click", renderService);
    app.querySelectorAll(".opt").forEach(function (b) {
      b.addEventListener("click", function () { state.provider = b.dataset.id; loadSlots(); });
    });
  }

  function loadSlots() {
    state.step = 2;
    render('<div class="spin">Finding open times…</div>');
    var url = "/api/public/slots?key=" + encodeURIComponent(KEY) +
      "&service=" + state.service.id + "&days=14" +
      (state.provider !== "any" ? "&provider=" + state.provider : "");
    get(url).then(function (j) {
      state.slots = j.slots;
      state.slotsByDay = {};
      j.slots.forEach(function (s) {
        var k = dayKeyOf(s.start, state.data.business.timezone);
        (state.slotsByDay[k] = state.slotsByDay[k] || []).push(s);
      });
      var days = Object.keys(state.slotsByDay).sort();
      state.dayKey = days[0] || null;
      renderTimes();
    }).catch(function (e) { renderError(e.message, renderProvider); });
  }

  function renderTimes() {
    state.step = 2;
    var tz = state.data.business.timezone;
    var days = Object.keys(state.slotsByDay).sort();
    if (!days.length) {
      render("<h3>No open times in the next two weeks</h3><p class='muted'>Please call " +
        esc(state.data.business.phone || "the office") + " to book.</p>" +
        '<div class="nav"><button class="btn ghost" id="back">Back</button></div>');
      app.querySelector("#back").addEventListener("click", renderProvider);
      return;
    }
    var dayBtns = days.map(function (k) {
      var l = fmtDayLabel(k, tz);
      return '<button class="day ' + (k === state.dayKey ? "on" : "") + '" data-k="' + k + '"><small>' + l.wd + "</small>" + l.md + "</button>";
    }).join("");
    var times = (state.slotsByDay[state.dayKey] || []).map(function (s) {
      var on = state.slot && state.slot.start === s.start;
      return '<button class="time ' + (on ? "on" : "") + '" data-start="' + s.start + '">' + fmtTime(s.start, tz) + "</button>";
    }).join("");
    render("<h3>" + esc(state.service.name) + " — pick a time</h3>" +
      '<div class="days">' + dayBtns + '</div><div class="times">' + times + "</div>" +
      '<div class="nav"><button class="btn ghost" id="back">Back</button>' +
      '<button class="btn primary" id="next" ' + (state.slot ? "" : "disabled") + ">Continue</button></div>");
    app.querySelector("#back").addEventListener("click", renderProvider);
    app.querySelector("#next").addEventListener("click", function () { if (state.slot) renderDetails(); });
    app.querySelectorAll(".day").forEach(function (b) {
      b.addEventListener("click", function () { state.dayKey = b.dataset.k; state.slot = null; renderTimes(); });
    });
    app.querySelectorAll(".time").forEach(function (b) {
      b.addEventListener("click", function () {
        state.slot = state.slots.find(function (s) { return s.start === b.dataset.start; });
        renderTimes();
      });
    });
  }

  function renderDetails() {
    state.step = 3;
    var tz = state.data.business.timezone;
    var when = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(state.slot.start));
    render("<h3>" + esc(state.service.name) + " · " + when + "</h3>" +
      '<label for="kb-name">Full name *</label><input id="kb-name" autocomplete="name" placeholder="Jordan Rivera"/>' +
      '<div class="row"><div><label for="kb-email">Email *</label><input id="kb-email" type="email" autocomplete="email" placeholder="you@email.com"/></div>' +
      '<div><label for="kb-phone">Mobile (for confirmations)</label><input id="kb-phone" type="tel" autocomplete="tel" placeholder="(214) 555-0000"/></div></div>' +
      '<label for="kb-notes">Anything we should know?</label><textarea id="kb-notes" rows="2"></textarea>' +
      '<p class="err" id="kb-err"></p>' +
      '<div class="nav"><button class="btn ghost" id="back">Back</button>' +
      '<button class="btn primary" id="confirm">Confirm booking</button></div>');
    app.querySelector("#back").addEventListener("click", renderTimes);
    app.querySelector("#confirm").addEventListener("click", submit);
  }

  function showErr(msg) {
    var e = app.querySelector("#kb-err");
    if (e) { e.textContent = msg; e.classList.add("show"); reportHeight(); }
  }

  function submit() {
    if (state.submitting) return;
    var name = app.querySelector("#kb-name").value.trim();
    var email = app.querySelector("#kb-email").value.trim();
    var phone = app.querySelector("#kb-phone").value.trim();
    var notes = app.querySelector("#kb-notes").value.trim();
    if (!name) return showErr("Please enter your name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showErr("Please enter a valid email.");

    state.submitting = true;
    app.querySelector("#confirm").disabled = true;
    fetch(API + "/api/public/book", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: KEY, service_id: state.service.id, provider_id: state.slot.provider_id,
        start: state.slot.start, name: name, email: email, phone: phone, notes: notes,
      }),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); })
      .then(function (res) {
        state.submitting = false;
        if (res.ok) return renderDone(res.j.booking);
        if (res.status === 409 && res.j.code === "SLOT_TAKEN") {
          state.slot = null;
          loadSlots();
          return;
        }
        app.querySelector("#confirm").disabled = false;
        showErr(res.j.error || "Something went wrong — please try again.");
      })
      .catch(function () {
        state.submitting = false;
        app.querySelector("#confirm").disabled = false;
        showErr("Network problem — please try again.");
      });
  }

  function renderDone(b) {
    state.step = 4;
    render('<div class="done">' +
      '<div class="tick"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></div>' +
      "<h3>You're booked!</h3>" +
      "<p><b>" + esc(b.service) + "</b> with " + esc(b.provider) + "<br>" + esc(b.when) + "</p>" +
      '<p class="muted">A confirmation is on its way to your email' + (b ? "" : "") + ".</p></div>");
  }

  function renderError(msg, retry) {
    render("<p class='muted'>" + esc(msg) + "</p>" +
      '<div class="nav"><button class="btn primary" id="retry">Try again</button></div>');
    app.querySelector("#retry").addEventListener("click", retry);
  }

  /* ---- boot ----------------------------------------------------------- */
  if (!KEY) {
    app.innerHTML = "<p class='muted' style='padding:20px'>Missing widget key.</p>";
  } else {
    get("/api/public/tenant?key=" + encodeURIComponent(KEY)).then(function (j) {
      state.data = j;
      document.documentElement.style.setProperty("--brand", j.business.brandColor || "#5d7d55");
      if (!j.business.accepting) {
        app.innerHTML = header() + "<p class='muted'>Online booking is paused — please call " + esc(j.business.phone || "the office") + ".</p>" + footer();
        return;
      }
      renderService();
    }).catch(function (e) {
      app.innerHTML = "<p class='muted' style='padding:20px'>" + esc(e.message) + "</p>";
    });
  }
})();
