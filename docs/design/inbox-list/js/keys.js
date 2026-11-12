// PROTOTYPE - the keys. Every move has one, every button shows its key, and ? lists them all.
// A single-letter key acts only when the focus is on the page, never in a field or a dialog.
window.Keys = (function () {
  "use strict";
  var ROWS = [
    ["J  K", "Next and previous"],
    ["X", "Select; ⇧J and ⇧K select as they move"],
    ["↩", "The ask’s suggested answer, or unfold a group"],
    ["→  ←", "Unfold and fold a group"],
    ["L", "Link the selection, or link to…"],
    ["N", "Start a thread"],
    ["T", "Take it on: a Task on Work"],
    ["H", "Hand off to a workflow"],
    ["E", "Dismiss"],
    ["G", "Go to its Task"],
    ["/", "Search"],
    ["1 – 7", "Saved queries; 8 is Triage"],
    [".", "Show what is new"],
    ["⌘Z", "Undo"],
    ["Esc", "Step back"],
  ];

  function sheet(show) {
    var el = document.getElementById("keys");
    if (show === undefined) show = el.hidden;
    if (show) el.innerHTML = '<h2>Keys</h2><dl>' + ROWS.map(function (r) { return "<div><dt>" + r[0].split("  ").map(function (k) { return "<kbd>" + k + "</kbd>"; }).join(" ") + "</dt><dd>" + r[1] + "</dd></div>"; }).join("") + "</dl>";
    el.hidden = !show;
    document.querySelector("[data-help]").setAttribute("aria-expanded", String(show));
  }

  function step(dir, extend) {
    var st = App.state;
    var rows = st.rows.filter(function (r) { return r.type !== "more" || true; });
    var i = rows.findIndex(function (r) { return r.key === st.focus; });
    var next = rows[Math.max(0, Math.min(rows.length - 1, i + dir))];
    if (!next) return;
    if (extend) {
      var cur = rows[i];
      if (cur && cur.thing) st.selection.add(cur.thing.id);
      if (next.thing) st.selection.add(next.thing.id);
      App.render({});
    }
    App.focusRow(next.key, { keyboard: true, dir: dir > 0 ? "down" : "up" });
  }

  function primaryAnswer() {
    var r = App.currentRow();
    if (!r) return;
    if (r.type === "group") return Moves.toggleGroup(r.key, true);
    if (r.type === "more") { App.state.showAll.add(r.groupKey); Moves.redraw(); return; }
    if (r.type === "tmore") { Moves.setScope({ triage: 1 }); return; }
    var btn = document.querySelector("#pane .sig.is-open .btn--answer") || document.querySelector("#pane .pn-foot .btn--answer");
    if (btn) btn.click();
  }

  function onKey(e) {
    if (Menus.key(e)) { e.preventDefault(); e.stopPropagation(); return; }
    if (Dialog.isOpen()) { if (e.key === "Escape") { Dialog.close(); e.preventDefault(); } return; }
    var t = e.target;
    var typing = t.closest && t.closest("input, textarea, [contenteditable], select");
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !typing) { Moves.undo(); e.preventDefault(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    var st = App.state;
    var k = e.key;
    var lower = k.toLowerCase();
    if (lower === "j" || k === "ArrowDown") step(1, e.shiftKey);
    else if (lower === "k" || k === "ArrowUp") step(-1, e.shiftKey);
    else if (lower === "x") { var r = App.currentRow(); if (r && r.thing) Moves.toggleSelect(r.thing.id); else if (r && r.type === "group") { r.group.members.forEach(function (m) { st.selection.add(m.id); }); App.render({}); } }
    else if (lower === "l") Moves.linkKey();
    else if (lower === "e") Moves.dismiss();
    else if (lower === "h") Moves.handOff();
    else if (lower === "t") Moves.takeOn();
    else if (lower === "g") Moves.goTo();
    else if (lower === "n") Moves.run("thread");
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

  return { start: start, sheet: sheet };
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
    var springTo = function (w) {
      if (Motion.isReduced()) { set(w); return; }
      if (!v) v = Motion.value(App.state.paneW, function (x) { set(x); });
      v.set(App.state.paneW);
      v.to(Math.max(360, Math.min(640, w)), "hand");
    };
    edge.addEventListener("dblclick", function () { springTo(420); });
    edge.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft") springTo(App.state.paneW + 40);
      else if (e.key === "ArrowRight") springTo(App.state.paneW - 40);
      else if (e.key === "Home") springTo(640);
      else if (e.key === "End") springTo(360);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }
  return { start: start };
})();
