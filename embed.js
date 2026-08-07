/* KoreStack Book — embed script.
 * Customers paste ONE tag anywhere in their page:
 *
 *   <script src="https://book.korestack.tech/embed.js" data-key="pk_..." async></script>
 *
 * It replaces itself with a responsive iframe running the booking widget.
 * Optional attributes:
 *   data-key    (required) the tenant's public widget key
 *   data-height minimum height in px (default 640)
 * The iframe autosizes via postMessage from the widget.
 */
(function () {
  "use strict";
  var script = document.currentScript;
  if (!script) return;
  var key = script.getAttribute("data-key");
  if (!key) { console.error("[korestack-book] missing data-key"); return; }

  var origin = new URL(script.src).origin;
  var minH = parseInt(script.getAttribute("data-height") || "640", 10);

  var frame = document.createElement("iframe");
  frame.src = origin + "/widget/?k=" + encodeURIComponent(key);
  frame.title = "Book an appointment";
  frame.style.cssText = "width:100%;border:0;display:block;min-height:" + minH + "px;border-radius:12px;";
  frame.setAttribute("loading", "lazy");
  frame.setAttribute("allowtransparency", "true");

  script.parentNode.insertBefore(frame, script);

  window.addEventListener("message", function (e) {
    if (e.origin !== origin || !e.data || e.data.type !== "korestack-book:height") return;
    if (e.source === frame.contentWindow) {
      frame.style.height = Math.max(minH, e.data.height) + "px";
    }
  });
})();
