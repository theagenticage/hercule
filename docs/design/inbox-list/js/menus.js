// PROTOTYPE - the hand-off menu (spec 17's HandToMenu, unchanged) and the Link to… popover that L
// opens on a single thing. An open menu owns the keyboard; no key runs through to the page.
window.Menus = (function () {
  "use strict";
  var D = Draw;
  var open = null;

  function close() {
    if (!open) return;
    open.el.hidden = true;
    var back = open.back;
    open = null;
    if (back && back.focus) back.focus({ preventScroll: true });
  }

  function place(el, anchor) {
    var r = anchor.getBoundingClientRect();
    var w = el.offsetWidth || 320, h = el.offsetHeight || 200;
    var left = Math.min(innerWidth - w - 12, Math.max(12, r.right - w));
    var top = r.bottom + 6;
    if (top + h > innerHeight - 12) top = Math.max(12, r.top - h - 6);
    el.style.left = left + "px";
    el.style.top = top + "px";
  }

  /** Opens the menu of workflows a thing can be handed to, anchored to its row or the pane's button. */
  function hand(t, button) {
    var el = document.getElementById("handmenu");
    var offers = Model.offersFor(t);
    var ok = offers.filter(function (o) { return !o.off; });
    var off = offers.filter(function (o) { return o.off; });
    el.innerHTML = '<p class="hand-menu-heading">Hand to</p>' + ok.map(function (o, i) {
      return '<button type="button" role="menuitem" class="hand-row' + (i === 0 ? " is-active" : "") + '" data-hand-row="' + i + '">' + D.face(o.w.name, "idle", 28) + '<span class="hand-row-words"><b>' + D.esc(o.w.name) + "</b><small>" + D.esc(o.line) + "</small></span>" + (i < 3 ? "<kbd>" + (i + 1) + "</kbd>" : "") + "</button>";
    }).join("") + '<p class="hand-acct">' + D.icon("connections", 12) + 'Acts as <b>northwind-bot</b><button type="button" class="link">Change</button></p>' +
      (off.length ? '<i class="hand-menu-line"></i>' + off.map(function (o) { return '<div role="menuitem" aria-disabled="true" class="hand-row">' + D.face(o.w.name, "idle", 28) + '<span class="hand-row-words"><b>' + D.esc(o.w.name) + "</b><small>" + D.esc(o.off) + "</small></span></div>"; }).join("") : "");
    el.hidden = false;
    var row = App.el.list.querySelector('[data-id="' + t.id + '"] .row-time');
    place(el, button && button.getBoundingClientRect ? button : row || App.el.pane);
    open = { el: el, kind: "hand", active: 0, n: ok.length, back: document.activeElement, pick: function (i) { close(); Moves.handTo(t, ok[i]); } };
    el.onclick = function (e) { var b = e.target.closest("[data-hand-row]"); if (b) open.pick(+b.dataset.handRow); };
    el.onpointermove = function (e) { var b = e.target.closest("[data-hand-row]"); if (b) setActive(+b.dataset.handRow); };
    el.querySelector(".hand-row").focus({ preventScroll: true });
    if (!Motion.isReduced()) Motion.animate(el, [{ opacity: 0, transform: "translateY(-4px) scale(.98)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" });
  }
  function setActive(i) {
    if (!open) return;
    open.active = i;
    open.el.querySelectorAll("[data-hand-row]").forEach(function (b, j) { b.classList.toggle("is-active", j === i); });
  }

  /** Opens Link to…: a search over the Inbox for the thing to link this one to. */
  function linkTo(t) {
    var el = document.getElementById("linkto");
    el.innerHTML = '<div class="lt-field">' + D.icon("link", 14) + '<input id="lt-input" placeholder="Link ' + D.esc(D.identifier(t) || "it") + ' to…" aria-label="Search for a thing to link to" autocomplete="off"></div><div class="lt-list" role="listbox"></div><p class="lt-foot">Linking makes them one group here. The sources are not told.</p>';
    el.hidden = false;
    var row = App.el.list.querySelector('[data-key="' + App.state.focus + '"]');
    var r = row ? row.getBoundingClientRect() : App.el.list.getBoundingClientRect();
    el.style.left = Math.round(r.left + 40) + "px";
    el.style.top = Math.round(Math.min(r.bottom + 4, innerHeight - 340)) + "px";
    var input = el.querySelector("input"), list = el.querySelector(".lt-list");
    var hits = [];
    var drawHits = function () {
      var q = input.value.toLowerCase();
      var g = Model.groupOf(t.id);
      hits = Model.live().filter(function (x) { return x.id !== t.id && !(g && g.members.indexOf(x) >= 0); }).filter(function (x) { return !q || (x.title + " " + D.identifier(x)).toLowerCase().indexOf(q) >= 0; })
        .sort(function (a, b) { return a.updated - b.updated; }).slice(0, 6);
      list.innerHTML = hits.map(function (x, i) { return '<button type="button" class="lt-item' + (i === 0 ? " is-active" : "") + '" data-lt="' + i + '">' + D.mark(Model.sourceOf(x), 14) + '<span class="lt-title">' + D.esc(x.title) + '</span><span class="lt-id">' + D.esc(D.identifier(x)) + "</span></button>"; }).join("") || '<p class="lt-none">Nothing matches.</p>';
      if (open) open.n = hits.length, open.active = 0;
    };
    open = { el: el, kind: "link", active: 0, n: 0, back: document.activeElement, pick: function (i) { if (!hits[i]) return; close(); Moves.link([t.id, hits[i].id], "search"); } };
    drawHits();
    input.addEventListener("input", drawHits);
    input.focus();
    el.onclick = function (e) { var b = e.target.closest("[data-lt]"); if (b) open.pick(+b.dataset.lt); };
    if (!Motion.isReduced()) Motion.animate(el, [{ opacity: 0, transform: "translateY(-4px) scale(.98)" }, { opacity: 1, transform: "none" }], { duration: 200, easing: "cubic-bezier(.2,.8,.2,1)" });
  }

  /** Handles a key while a menu is open. Returns true when the menu took it. */
  function key(e) {
    if (!open) return false;
    var k = e.key;
    if (k === "Escape") { close(); return true; }
    var sel = open.kind === "hand" ? "[data-hand-row]" : "[data-lt]";
    if (k === "ArrowDown" || k === "ArrowUp") {
      var i = Math.max(0, Math.min(open.n - 1, open.active + (k === "ArrowDown" ? 1 : -1)));
      open.active = i;
      open.el.querySelectorAll(sel).forEach(function (b, j) { b.classList.toggle("is-active", j === i); if (j === i && open.kind === "hand") b.focus({ preventScroll: true }); });
      return true;
    }
    if (k === "Enter") { open.pick(open.active); return true; }
    if (open.kind === "hand" && /^[1-9]$/.test(k)) { var n = +k - 1; if (n < Math.min(3, open.n)) open.pick(n); return true; }
    return open.kind === "hand";
  }

  document.addEventListener("pointerdown", function (e) { if (open && !e.target.closest("#handmenu, #linkto")) close(); });

  return { hand: hand, linkTo: linkTo, key: key, close: close, isOpen: function () { return !!open; } };
})();
