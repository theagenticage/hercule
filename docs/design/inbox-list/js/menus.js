// PROTOTYPE - the hand-off menu (spec 17's HandToMenu, unchanged) and the Link to… popover that L
// opens on a single thing. An open menu owns the keyboard; no key runs through to the page.
window.Menus = (function () {
  "use strict";
  var D = Draw;
  var open = null;

  function close() {
    if (!open) return;
    var el = open.el;
    if (Motion.isReduced()) el.hidden = true;
    else el.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(-2px) scale(.99)" }], { duration: 120, easing: "ease-in" }).finished.then(function () { if (!open || open.el !== el) el.hidden = true; });
    var back = open.back;
    if (back && back.getAttribute && back.hasAttribute("aria-expanded")) back.setAttribute("aria-expanded", "false");
    if (open.trigger) open.trigger.setAttribute("aria-expanded", "false");
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

  // Past this many workflows that can take the thing, the menu gets a field to find one by name.
  var FIND_FROM = 6;

  /**
   * Opens the menu of workflows a thing can be handed to, anchored to its row or the pane's button.
   * The workflows come best fit first (Model.offersFor), each with its face, its name and what it would
   * end. With many, a field at the top finds one by name or by what it does.
   */
  function hand(t, button) {
    var el = document.getElementById("handmenu");
    var offers = Model.offersFor(t);
    var ok = offers.filter(function (o) { return !o.off; });
    var off = offers.filter(function (o) { return o.off; });
    var finds = ok.length >= FIND_FROM;
    // A list found by typing is a listbox the field controls; a short list is a menu of items.
    var item = finds ? 'role="option"' : 'role="menuitem" tabindex="-1"';
    // The workflows are the menu; the account picker sits after it, outside the menu, which may hold
    // only its items.
    el.innerHTML = '<p class="hand-menu-heading" id="hand-h">Hand to</p>' +
      (finds ? '<div class="lt-field hand-find">' + D.icon("search", 14) + '<input id="hand-find" role="combobox" aria-expanded="true" aria-controls="hand-list" aria-autocomplete="list" aria-activedescendant="hand-o0" aria-labelledby="hand-h" placeholder="Find a workflow" autocomplete="off"></div>' : "") +
      '<div id="hand-list" role="' + (finds ? "listbox" : "menu") + '" aria-labelledby="hand-h">' + ok.map(function (o, i) {
        return '<button type="button" ' + item + ' id="hand-o' + i + '" class="hand-row' + (i === 0 ? " is-active" : "") + '" data-hand-row="' + i + '" data-find="' + D.esc((o.w.name + " " + o.w.line).toLowerCase()) + '" aria-label="' + D.esc(o.w.name + ". " + o.line) + '" aria-keyshortcuts="' + (i + 1) + '"><span aria-hidden="true">' + D.face(o.w.name, "idle", 28) + '</span><span class="hand-row-words"><b>' + D.esc(o.w.name) + "</b><small>" + D.esc(o.line) + "</small></span>" + (i < 3 ? '<kbd aria-hidden="true">' + (i + 1) + "</kbd>" : "") + "</button>";
      }).join("") + (finds ? '<p class="lt-none" hidden>No workflow by that name. Esc closes.</p>' : "") +
      (off.length ? '<i class="hand-menu-line" role="separator"></i>' + off.map(function (o) { return '<div ' + (finds ? 'role="option"' : 'role="menuitem" tabindex="-1"') + ' aria-disabled="true" class="hand-row" data-find="' + D.esc(o.w.name.toLowerCase()) + '">' + D.face(o.w.name, "idle", 28) + '<span class="hand-row-words"><b>' + D.esc(o.w.name) + "</b><small>" + D.esc(o.off) + "</small></span></div>"; }).join("") : "") +
      '</div><label class="hand-account hand-acct"><span>as</span><select aria-label="Account to act as"><option>northwind-bot</option><option>northwind-release</option></select></label>';
    el.classList.toggle("is-finding", false);
    el.hidden = false;
    var row = App.el.list.querySelector('[data-id="' + t.id + '"] .row-time');
    place(el, button && button.getBoundingClientRect ? button : row || App.el.pane);
    // The pane's hand-off button says its menu is open, however the menu was opened.
    var trigger = document.querySelector('#pane [data-move="hand"][aria-haspopup]');
    if (trigger) trigger.setAttribute("aria-expanded", "true");
    open = { el: el, kind: "hand", active: 0, n: ok.length, back: document.activeElement, trigger: trigger, find: finds ? el.querySelector("#hand-find") : null, pick: function (i) { close(); Moves.handTo(t, ok[i]); } };
    el.onclick = function (e) { var b = e.target.closest("[data-hand-row]"); if (b) open.pick(+b.dataset.handRow); };
    el.onpointermove = function (e) { var b = e.target.closest("[data-hand-row]"); if (b) setActive(+b.dataset.handRow); };
    if (open.find) {
      open.find.addEventListener("input", findWorkflows);
      open.find.focus({ preventScroll: true });
    } else el.querySelector(".hand-row").focus({ preventScroll: true });
    if (!Motion.isReduced()) Motion.animate(el, [{ opacity: 0, transform: "translateY(-4px) scale(.98)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" });
  }

  /** Shows only the workflows whose name or line holds what is typed, with the first of them highlighted. */
  function findWorkflows() {
    var q = open.find.value.trim().toLowerCase();
    open.el.classList.toggle("is-finding", !!q);
    var first = -1;
    open.el.querySelectorAll(".hand-row").forEach(function (r) {
      var hit = !q || r.dataset.find.indexOf(q) >= 0;
      r.hidden = !hit;
      if (hit && first < 0 && r.dataset.handRow != null) first = +r.dataset.handRow;
    });
    open.el.querySelector(".lt-none").hidden = first >= 0;
    var line = open.el.querySelector(".hand-menu-line");
    if (line) line.hidden = !!q;
    setActive(first);
  }
  /** Returns the hand-off rows that can be picked and are shown, in order. */
  function shownRows() {
    return Array.prototype.slice.call(open.el.querySelectorAll("[data-hand-row]")).filter(function (r) { return !r.hidden; });
  }

  function setActive(i) {
    if (!open) return;
    open.active = i;
    // The pointer and the focus are one place, so ↩ picks the row under the pointer. With the find
    // field, the focus stays in the field and the field points at the row.
    open.el.querySelectorAll("[data-hand-row]").forEach(function (b) {
      var on = +b.dataset.handRow === i;
      b.classList.toggle("is-active", on);
      if (open.find) b.setAttribute("aria-selected", String(on));
      else if (on) b.focus({ preventScroll: true });
    });
    if (open.find) { if (i >= 0) open.find.setAttribute("aria-activedescendant", "hand-o" + i); else open.find.removeAttribute("aria-activedescendant"); }
  }

  /** Opens Link to…: a search over the Inbox for the thing to link this one to. */
  function linkTo(t) {
    var el = document.getElementById("linkto");
    el.innerHTML = '<div class="lt-field">' + D.icon("link", 14) + '<input id="lt-input" role="combobox" aria-expanded="true" aria-controls="lt-list" aria-autocomplete="list" placeholder="Link ' + D.esc(D.identifier(t) || "it") + ' to…" aria-label="Search for a thing to link ' + D.esc(D.identifier(t) || t.title) + ' to" autocomplete="off"></div><div class="lt-list" id="lt-list" role="listbox" aria-label="Things to link to"></div><p class="lt-foot">Linking makes them one group here. The sources are not told.</p>';
    el.hidden = false;
    var row = App.el.list.querySelector('[data-key="' + App.state.focus + '"]');
    var r = row ? row.getBoundingClientRect() : App.el.list.getBoundingClientRect();
    el.style.left = Math.round(r.left) + "px";
    el.style.width = Math.round(r.width) + "px";
    el.style.top = Math.round(Math.min(r.bottom + 4, innerHeight - 340)) + "px";
    var input = el.querySelector("input"), list = el.querySelector(".lt-list");
    var hits = [];
    var drawHits = function () {
      var q = input.value.toLowerCase();
      var g = Model.groupOf(t.id);
      hits = Model.live().filter(function (x) { return x.id !== t.id && !(g && g.members.indexOf(x) >= 0); }).filter(function (x) { return !q || (x.title + " " + D.identifier(x)).toLowerCase().indexOf(q) >= 0; })
        .sort(function (a, b) { return a.updated - b.updated; }).slice(0, 6);
      list.innerHTML = hits.map(function (x, i) { return '<div role="option" id="lt-o' + i + '" aria-selected="' + (i === 0) + '" class="lt-item' + (i === 0 ? " is-active" : "") + '" data-lt="' + i + '">' + D.mark(Model.sourceOf(x), 14) + '<span class="lt-title">' + D.esc(x.title) + '</span><span class="lt-id">' + D.esc(D.identifier(x)) + "</span></div>"; }).join("") || '<p class="lt-none">Nothing matches.</p>';
      if (hits.length) input.setAttribute("aria-activedescendant", "lt-o0"); else input.removeAttribute("aria-activedescendant");
      if (open) open.n = hits.length, open.active = 0;
    };
    open = { el: el, kind: "link", active: 0, n: 0, back: document.activeElement, pick: function (i) { if (!hits[i]) return; close(); Moves.link([t.id, hits[i].id], "search"); } };
    drawHits();
    input.addEventListener("input", drawHits);
    input.focus();
    el.onclick = function (e) { var b = e.target.closest("[data-lt]"); if (b) open.pick(+b.dataset.lt); };
    if (!Motion.isReduced()) Motion.animate(el, [{ opacity: 0, transform: "translateY(-4px) scale(.98)" }, { opacity: 1, transform: "none" }], { duration: 200, easing: "cubic-bezier(.2,.8,.2,1)" });
  }

  /**
   * Handles keys for the simple popovers, Narrow and the narrow window's scope menu: ↑ and ↓ move, ↩
   * picks, Esc closes, and no other key reaches the page. Returns true when one is open.
   */
  function popoverKey(e) {
    var pop = ["narrow", "scope-pop"].map(function (id) { return document.getElementById(id); }).find(function (el) { return el && !el.hidden; });
    if (!pop) return false;
    // A menu handles keys only while the focus is in it; Tab leaves and closes it.
    if (!pop.contains(document.activeElement) || e.key === "Tab") {
      if (pop.id === "narrow") Bar.closeNarrow(); else { pop.hidden = true; var sb0 = document.getElementById("scope-btn"); if (sb0) sb0.setAttribute("aria-expanded", "false"); }
      return false;
    }
    if (e.key === "Enter" || e.key === " ") {
      var f = document.activeElement;
      if (f && pop.contains(f) && f.matches("button")) { var keep = f.matches("[data-fold], [data-more], [data-nf], [data-nback]"); f.click(); if (keep) setTimeout(function () { var again = pop.querySelector(".menu-pick, [data-scope]"); if (again && !pop.contains(document.activeElement)) again.focus(); }, 0); return true; }
    }
    var items = Array.prototype.slice.call(pop.querySelectorAll(".menu-pick, [data-scope], [data-fold], [data-more]"));
    var at = items.findIndex(function (b) { return b.classList.contains("is-active"); });
    var k = e.key;
    var mark = function (i) { items.forEach(function (b, j) { b.classList.toggle("is-active", j === i); }); if (items[i]) items[i].scrollIntoView({ block: "nearest" }); };
    if (k === "Escape") {
      if (pop.id === "narrow") { Bar.closeNarrow(); return true; }
      pop.hidden = true;
      var sb = document.getElementById("scope-btn");
      if (sb) { sb.setAttribute("aria-expanded", "false"); sb.focus({ preventScroll: true }); }
      return true;
    }
    if (k === "ArrowDown" || k === "ArrowUp") { var ni = Math.max(0, Math.min(items.length - 1, at + (k === "ArrowDown" ? 1 : -1))); mark(ni); if (items[ni]) items[ni].focus({ preventScroll: true }); return true; }
    if (k === "Tab") return false;
    // The scope menu's entries show their digits, and the digits pick them, as in the rail.
    if (pop.id === "scope-pop" && /^[1-8]$/.test(k)) {
      pop.hidden = true;
      var sb1 = document.getElementById("scope-btn");
      if (sb1) sb1.setAttribute("aria-expanded", "false");
      Moves.setScope(k === "8" ? { triage: 1 } : { saved: Kinds.SAVED[+k - 1].id });
      App.focusCurrent();
      return true;
    }
    if (k === "Enter" && items[at]) { var keepOpen = items[at].matches("[data-fold], [data-more], [data-nf], [data-nback]"); items[at].click(); if (keepOpen) setTimeout(function () { var again = pop.querySelectorAll(".menu-pick, [data-scope], [data-fold], [data-more]"); if (again[Math.min(at, again.length - 1)]) again[Math.min(at, again.length - 1)].classList.add("is-active"); }, 0); return true; }
    return true;
  }

  /** Handles a key while a menu is open. Returns true when the menu took it. */
  function key(e) {
    if (!open) return popoverKey(e);
    // The hand-off menu's account picker is its one other stop: Tab goes between it and the rows, and
    // it keeps its own keys. The page never sees them.
    var picker = open.kind === "hand" && open.el.querySelector("select");
    if (picker && e.key === "Tab" && open.el.contains(document.activeElement)) {
      (document.activeElement === picker ? open.find || open.el.querySelector("[data-hand-row].is-active") : picker).focus({ preventScroll: true });
      return true;
    }
    // In the find field the arrows move the highlight, ↩ hands to it, and the digits pick while
    // nothing is typed; every other key types.
    if (open.find && document.activeElement === open.find) {
      var rows = shownRows(), at = rows.findIndex(function (r) { return +r.dataset.handRow === open.active; });
      if (e.key === "Escape") { close(); return true; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { var to = rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))]; if (to) { setActive(+to.dataset.handRow); to.scrollIntoView({ block: "nearest" }); } return true; }
      if (e.key === "Enter") { if (open.active >= 0) open.pick(open.active); return true; }
      if (/^[1-3]$/.test(e.key) && !open.find.value && +e.key <= open.n) { open.pick(+e.key - 1); return true; }
      return "own";
    }
    if (picker && document.activeElement === picker) { if (e.key === "Escape") { close(); return true; } return "own"; }
    // A menu handles keys only while the focus is in it; Tab, or the focus going anywhere else, closes it.
    if (e.key === "Tab" || !open.el.contains(document.activeElement)) { close(); return false; }
    if (e.key === "Enter") {
      var f = document.activeElement;
      var all = Array.prototype.slice.call(open.el.querySelectorAll(open.kind === "hand" ? "[data-hand-row]" : open.kind === "pane" ? ".menu-pick" : "[data-lt]"));
      var fi = all.indexOf(f);
      if (fi >= 0) { open.pick(fi); return true; }
      if (f && f.matches("button") && !f.matches("[data-hand-row]")) return false;
    }
    var k = e.key;
    if (k === "Escape") { close(); return true; }
    var sel = open.kind === "hand" ? "[data-hand-row]" : open.kind === "pane" ? ".menu-pick" : "[data-lt]";
    if (k === "ArrowDown" || k === "ArrowUp") {
      var i = Math.max(0, Math.min(open.n - 1, open.active + (k === "ArrowDown" ? 1 : -1)));
      open.active = i;
      open.el.querySelectorAll(sel).forEach(function (b, j) { b.classList.toggle("is-active", j === i); b.setAttribute("aria-selected", String(j === i)); if (j === i && open.kind !== "link") b.focus({ preventScroll: true }); });
      if (open.kind === "link") { var li = document.getElementById("lt-input"); if (li) li.setAttribute("aria-activedescendant", "lt-o" + i); }
      return true;
    }
    if (k === "Enter") { open.pick(open.active); return true; }
    if (k === " ") return false;
    if (open.kind === "hand" && /^[1-9]$/.test(k)) { var n = +k - 1; if (n < Math.min(3, open.n)) open.pick(n); return true; }
    if (k === "Tab") return false;
    return open.kind === "hand" || open.kind === "pane";
  }

  /**
   * Opens the pane's ⋯ menu: open at the source, and the pane's width without a drag. Under 1032px the
   * pane lies over the list at its full width, so no width is offered.
   */
  function paneMenu(button) {
    var el = document.getElementById("panemenu");
    var r = App.currentRow();
    var src = r && r.thing ? Kinds.SOURCES[Model.sourceOf(r.thing)] : null;
    var w = App.state.paneW;
    var widths = [["Narrow", 360], ["Default", 420], ["Wide", 560]];
    // The check sits on the width the pane really has; a width the window cannot give is not offered.
    var room = Math.max(360, Math.min(640, App.el.ib.getBoundingClientRect().width - (matchMedia("(max-width: 1329px)").matches ? 0 : 240) - 400));
    el.innerHTML = (src ? '<button type="button" role="menuitem" tabindex="-1" class="menu-pick" data-pm="open">' + D.icon("external", 14) + "<span>" + D.esc(src.open) + '</span><kbd aria-hidden="true">O</kbd></button>' + (App.isStacked() ? "" : '<i class="menu-line"></i>') : "") +
      (App.isStacked() ? "" : '<p class="menu-h">Pane width</p>' + widths.map(function (x) { var off = x[1] > room;
        return '<button type="button" role="menuitemradio" tabindex="-1" aria-checked="' + (w === x[1]) + '"' + (off ? ' aria-disabled="true" title="The window is too narrow for it"' : "") + ' class="menu-pick" data-pm-w="' + x[1] + '"><span>' + x[0] + "</span><small>" + x[1] + "px</small>" + (w === x[1] ? D.icon("check", 14) : "") + "</button>"; }).join(""));
    el.hidden = false;
    place(el, button);
    button.setAttribute("aria-expanded", "true");
    open = { el: el, kind: "pane", active: 0, n: el.querySelectorAll(".menu-pick").length, back: button, pick: function (i) { el.querySelectorAll(".menu-pick")[i].click(); } };
    el.querySelectorAll(".menu-pick").forEach(function (b, i) { b.classList.toggle("is-active", i === 0); });
    el.querySelector(".menu-pick").focus({ preventScroll: true });
    el.onclick = function (e) {
      var o = e.target.closest("[data-pm]"), pw = e.target.closest("[data-pm-w]");
      if (o) { close(); Moves.say("Opening it at its source…"); }
      if (pw && pw.getAttribute("aria-disabled") !== "true") { close(); App.setPaneWidth(+pw.dataset.pmW); }
    };
  }

  document.addEventListener("pointerdown", function (e) { if (open && !e.target.closest("#handmenu, #linkto, #panemenu")) close(); });

  return { paneMenu: paneMenu, hand: hand, linkTo: linkTo, key: key, close: close, isOpen: function () { return !!open; } };
})();
