// PROTOTYPE - the keys. Every move has one, every button shows its key, and ? lists them all.
// A single-letter key acts only when the focus is on the page, never in a field or a dialog.
window.Keys = (function () {
  "use strict";
  var ROWS = [
    ["J  K", "Next and previous"],
    ["X", "Select; ⇧J ⇧K or ⇧-click select a range; ⌘A all"],
    ["↩", "The open ask’s suggested answer; on a group, unfold"],
    ["→  ←", "Unfold and fold a group"],
    ["[  ]", "The previous and next ask in the pane"],
    ["Space", "Scroll the pane; ⇧Space back"],
    ["L", "Link the selection, or link to…"],
    ["N", "Start a thread; ⌘↩ starts it"],
    ["T", "Take it on: a Task on Work"],
    ["H", "Hand off; 1 to 3 pick in the menu"],
    ["E", "Dismiss"],
    ["G", "Go to its Task"],
    ["O", "Open it at its source"],
    ["/", "Search; F narrows"],
    ["1 – 7", "Saved queries; 8 is Triage"],
    [".", "Show what is new"],
    ["Drag", "A row onto another links them"],
    ["⌘Z", "Undo"],
    ["Esc", "Step back"],
  ];

  var sheetBack = null;
  function sheet(show) {
    var el = document.getElementById("keys");
    if (show === undefined) show = el.hidden;
    if (show) { sheetBack = document.activeElement; el.innerHTML = '<h2 tabindex="-1">Keys</h2><dl>' + ROWS.map(function (r) { return "<div><dt>" + r[0].split("  ").map(function (k) { return "<kbd>" + k + "</kbd>"; }).join(" ") + "</dt><dd>" + r[1] + "</dd></div>"; }).join("") + "</dl>"; }
    el.hidden = !show;
    document.querySelector("[data-help]").setAttribute("aria-expanded", String(show));
    if (show) el.querySelector("h2").focus({ preventScroll: true });
    else if (sheetBack && sheetBack.isConnected) sheetBack.focus({ preventScroll: true });
  }

  /** Returns the thing ids a row stands for: a thing's own, or every member of a group. */
  function idsOf(r) { return !r ? [] : r.thing ? [r.thing.id] : r.type === "group" ? r.group.members.map(function (m) { return m.id; }) : []; }

  /** Selects every row from the anchor to the current row, as mail apps and issue trackers do. */
  function selectRange(fromKey, toKey) {
    var st = App.state, rows = st.rows;
    var a = rows.findIndex(function (r) { return r.key === fromKey; }), b = rows.findIndex(function (r) { return r.key === toKey; });
    if (a < 0 || b < 0) return;
    st.selection.clear();
    rows.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(function (r) { idsOf(r).forEach(function (id) { st.selection.add(id); }); });
  }

  function step(dir, extend) {
    var st = App.state;
    var rows = st.rows;
    var i = rows.findIndex(function (r) { return r.key === st.focus; });
    var next = rows[Math.max(0, Math.min(rows.length - 1, i + dir))];
    if (!next) return;
    if (extend) {
      if (!st.anchor || !rows.some(function (r) { return r.key === st.anchor; })) st.anchor = st.focus;
      App.focusRow(next.key, { keyboard: true, dir: dir > 0 ? "down" : "up" });
      selectRange(st.anchor, next.key);
      App.render({});
      return;
    }
    App.focusRow(next.key, { keyboard: true, dir: dir > 0 ? "down" : "up" });
  }

  function primaryAnswer() {
    var r = App.currentRow();
    if (!r) return;
    if (App.isStacked() && !App.isPaneOpen() && r.type !== "group" && r.type !== "more" && r.type !== "tmore") { App.setPaneOpen(true); return; }
    if (r.type === "group") return Moves.toggleGroup(r.key, true);
    if (r.type === "more") { App.state.showAll.add(r.groupKey); Moves.redraw(); return; }
    if (r.type === "tmore") { Moves.setScope({ triage: 1 }); return; }
    var btn = document.querySelector("#pane .sig.is-open .btn--answer") || document.querySelector("#pane .pn-foot .btn--answer");
    if (btn) { btn.click(); return; }
    // No suggested answer: put the focus on the open ask's first answer, so the next key chooses.
    var first = document.querySelector("#pane .sig.is-open .sig-answers .btn");
    if (first) { first.focus(); Moves.say("This ask has no suggested answer. Tab between its answers, and Space picks one."); }
  }

  /** Moves between the pane's ask sections: unfolds the next or previous one and puts the focus on it. */
  function section(dir) {
    var secs = Array.prototype.slice.call(document.querySelectorAll("#pane .sig"));
    if (!secs.length) return;
    var at = secs.findIndex(function (x) { return x.contains(document.activeElement); });
    if (at < 0) at = secs.findIndex(function (x) { return x.classList.contains("is-open"); });
    var next = secs[Math.max(0, Math.min(secs.length - 1, at + dir))];
    if (!next.classList.contains("is-open")) next.querySelector(".sig-head").click();
    next.querySelector(".sig-head").focus();
    next.scrollIntoView({ block: "nearest", behavior: Motion.isReduced() ? "auto" : "smooth" });
  }

  /** Refuses a key on a triage row, naming the keys it takes. Returns true when it refused. */
  function triageRefuses(k) {
    var r = App.currentRow();
    if (!r || App.state.selection.size) return false;
    if (r.type === "proposal" && "hxgl".indexOf(k) >= 0) { Moves.say("A Proposal takes T to accept, N to accept and start a thread, or E to dismiss."); return true; }
    if (r.type === "link" && "hxgtn".indexOf(k) >= 0) { Moves.say("A suggested link takes L to link them, or E: not related."); return true; }
    return false;
  }

  /** F6 and ⇧F6 move between the page's regions: the search, the rail, the list and the pane. */
  function cycle(back) {
    var spots = [document.getElementById("sx-input"), document.querySelector("#rail [tabindex='0']"), App.el.list.querySelector("[tabindex='0']") || App.el.list, document.querySelector("#pane .pn-title") || document.querySelector("#pane button")];
    spots = spots.filter(Boolean);
    var at = spots.findIndex(function (x) { return x.contains(document.activeElement) || (x === App.el.list.querySelector("[tabindex='0']") && App.el.list.contains(document.activeElement)) || (x.closest && x.closest("#pane") && document.getElementById("pane").contains(document.activeElement)) || (x.closest && x.closest("#rail") && document.getElementById("rail").contains(document.activeElement)); });
    var next = spots[(at + (back ? -1 : 1) + spots.length) % spots.length];
    if (next.matches(".pn-title")) next.tabIndex = -1;
    next.focus();
  }

  function onKey(e) {
    if (e.key === "F6") { cycle(e.shiftKey); e.preventDefault(); return; }
    if (Menus.key(e)) { e.preventDefault(); e.stopPropagation(); return; }
    if (Dialog.isOpen()) return;
    var t = e.target;
    // Single keys belong to the list and the pane. In the rail, the bar or a sheet they do nothing,
    // so speech input and a stray key never act on a row nobody is looking at. Esc goes back to the list.
    if (t.closest && t.closest("#rail, .ib-bar, #keys, #selbar, #undo")) {
      if (e.key === "Escape" && !t.closest(".ib-bar")) { var cur0 = App.el.list.querySelector("[tabindex='0']"); if (cur0) { cur0.focus(); e.preventDefault(); } }
      // ? and / still reach their sheet and the search from anywhere outside a field.
      if ((e.key !== "?" && e.key !== "/") || t.closest("input")) return;
    }
    var typing = t.closest && t.closest("input, textarea, [contenteditable], select");
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !typing) { Moves.undo(); e.preventDefault(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && !typing) { App.state.rows.forEach(function (r) { idsOf(r).forEach(function (id) { App.state.selection.add(id); }); }); App.render({}); e.preventDefault(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key;
    // A focused button or link outside the list answers ↩ and Space itself, as every button does.
    if ((k === "Enter" || k === " ") && t.closest && t.closest("button, a, [role=button], [role=separator]") && !t.closest("#rows")) return;
    var st = App.state;
    var lower = k.toLowerCase();
    if (k.length === 1 && triageRefuses(lower)) { e.preventDefault(); return; }
    if (lower === "j" || k === "ArrowDown") step(1, e.shiftKey);
    else if (lower === "k" || k === "ArrowUp") step(-1, e.shiftKey);
    else if (lower === "x") {
      var r = App.currentRow(), ids = idsOf(r);
      var all = ids.length && ids.every(function (id) { return st.selection.has(id); });
      ids.forEach(function (id) { if (all) st.selection.delete(id); else st.selection.add(id); });
      st.anchor = st.focus;
      App.render({});
    }
    else if (lower === "l") Moves.linkKey();
    else if (lower === "e") {
      var cur = App.currentRow();
      // A held-down E never rolls onto a group: a group takes its own, fresh press.
      if (e.repeat && cur && cur.type === "group") { e.preventDefault(); return; }
      Moves.dismiss();
    }
    else if (lower === "h") Moves.handOff();
    else if (lower === "t") Moves.takeOn();
    else if (lower === "g") Moves.goTo();
    else if (lower === "n") Moves.run("thread");
    else if (lower === "o") { var c0 = App.currentRow(); if (c0 && c0.thing) Moves.say("Opening " + (Draw.identifier(c0.thing) || "it") + " in " + Kinds.SOURCES[Model.sourceOf(c0.thing)].name + "…"); }
    else if (lower === "f") { var nb = document.querySelector("[data-narrow]"); if (nb) Bar.narrow(nb); }
    else if (k === "[" || k === "]") section(k === "]" ? 1 : -1);
    else if (k === " ") { var sc = document.querySelector("#pane .pn-scroll"); if (sc) sc.scrollBy({ top: (e.shiftKey ? -1 : 1) * sc.clientHeight * 0.8, behavior: Motion.isReduced() ? "auto" : "smooth" }); }
    else if (k === "Enter") primaryAnswer();
    else if (k === "ArrowRight") { var g = App.currentRow(); if (g && g.type === "group") Moves.toggleGroup(g.key, true); }
    else if (k === "ArrowLeft") {
      var c = App.currentRow();
      if (c && c.type === "group") Moves.toggleGroup(c.key, false);
      else if (c && (c.type === "member" || c.type === "more")) { App.focusRow("g:" + c.group.lead.id, { keyboard: true }); }
    }
    else if (k === "/") Bar.focus();
    else if (k === "?") sheet();
    else if (k === ".") Moves.showNew();
    else if (/^[1-7]$/.test(k)) Moves.setScope({ saved: Kinds.SAVED[+k - 1].id });
    else if (k === "8") Moves.setScope({ triage: 1 });
    else if (k === "Escape") {
      if (!document.getElementById("keys").hidden) sheet(false);
      else if (App.isStacked() && App.isPaneOpen()) App.setPaneOpen(false);
      else if (st.selection.size) { st.selection.clear(); App.render({}); }
      else if (st.search.clauses.length || st.search.text) Bar.clear(true);
      else return;
    } else return;
    e.preventDefault();
  }

  function start() {
    window.addEventListener("keydown", onKey);
    document.querySelector("[data-help]").addEventListener("click", function () { sheet(); });
    document.addEventListener("pointerdown", function (e) { var el = document.getElementById("keys"); if (!el.hidden && !e.target.closest("#keys, [data-help]")) sheet(false); });
  }

  return { start: start, sheet: sheet, selectRange: selectRange, idsOf: idsOf };
})();

// The pane's edge: drag it, or focus it and use the arrows, to make the pane wider or narrower. While
// dragging, the width follows the pointer one to one; a double click springs it back to 420px.
window.Edge = (function () {
  "use strict";
  function start() {
    var edge = document.getElementById("edge");
    var ib = document.getElementById("ib");
    var v = null;
    var set = function (w) { App.setPaneWidth(w); edge.setAttribute("aria-valuenow", App.state.paneW); };
    edge.addEventListener("pointerdown", function (e) {
      edge.setPointerCapture(e.pointerId);
      ib.classList.add("is-resizing");
    });
    edge.addEventListener("pointermove", function (e) {
      if (!edge.hasPointerCapture(e.pointerId)) return;
      set(ib.getBoundingClientRect().right - e.clientX);
    });
    edge.addEventListener("pointerup", function (e) { edge.releasePointerCapture(e.pointerId); ib.classList.remove("is-resizing"); });
    // Keys step a target, not the width on screen, so quick presses add up and the spring keeps its speed.
    var target = null;
    var springTo = function (w) {
      target = Math.max(360, Math.min(640, w));
      if (Motion.isReduced()) { set(target); return; }
      if (!v) v = Motion.value(App.state.paneW, function (x) { set(x); });
      v.to(target, "hand", function () { target = null; });
    };
    edge.addEventListener("pointerdown", function () { target = null; if (v) v.set(App.state.paneW); });
    edge.addEventListener("dblclick", function () { springTo(420); });
    edge.addEventListener("keydown", function (e) {
      var base = target == null ? App.state.paneW : target;
      if (e.key === "ArrowLeft") springTo(base + 40);
      else if (e.key === "ArrowRight") springTo(base - 40);
      else if (e.key === "Home") springTo(640);
      else if (e.key === "End") springTo(360);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }
  return { start: start };
})();
