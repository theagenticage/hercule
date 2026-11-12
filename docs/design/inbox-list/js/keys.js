// PROTOTYPE - the keys. Every move has one, every button shows its key, and ? lists them all.
// A single-letter key acts only when the focus is on the page, never in a field or a dialog.
window.Keys = (function () {
  "use strict";
  var ROWS = [
    ["J  K", "Next and previous"],
    ["X", "Select; ⇧X a whole group; ⇧J ⇧K or ⇧-click a range; ⌘A all"],
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
    ["P", "Pin the Browse value in focus"],
    ["F6", "The search, the rail, the list, the pane"],
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
    if (show) {
      el.querySelector("h2").focus({ preventScroll: true });
      // The sheet closes when the focus leaves it, so nothing focused ever hides under it.
      if (!el._watch) { el._watch = true; el.addEventListener("focusout", function (e) { if (!el.hidden && !el.contains(e.relatedTarget)) sheet(false); }); }
    }
    else if (sheetBack && sheetBack.isConnected) sheetBack.focus({ preventScroll: true });
  }

  /** Returns the thing ids a row stands for: a thing's own, or every member of a group. */
  /**
   * Returns the thing ids a row stands for: a thing's own, or a group's members that the list's query
   * holds. With whole, every member of a group, also those the query leaves out (⇧X).
   */
  function idsOf(r, whole) {
    if (!r) return [];
    if (r.thing) return [r.thing.id];
    if (r.type !== "group") return [];
    return (whole ? r.group.members : r.hits || r.group.members).map(function (m) { return m.id; });
  }

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
    if (!extend) st.anchor = null;
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
    if (r.type === "more") { showMore(r); return; }
    if (r.type === "tmore") { Moves.setScope({ triage: 1 }); return; }
    var ask = document.querySelector("#pane .sig.is-current-ask") || document.querySelector("#pane .sig.is-open");
    var btn = (ask && ask.querySelector(".btn--answer")) || document.querySelector("#pane .pn-foot .btn--answer");
    if (btn) { btn.click(); return; }
    // No suggested answer: put the focus on the open ask's first answer, so the next key chooses.
    var first = ask && ask.querySelector(".sig-answers .btn");
    if (first) { first.focus(); Moves.say("This ask has no suggested answer. Tab between its answers, and Space picks one."); return; }
    Moves.say("Nothing here asks you anything. N starts a thread on it, T takes it on.");
  }

  /**
   * Moves the pane's current ask to the next or previous section, unfolding it. The focus stays where it
   * is, so the next ↩ answers that ask.
   */
  function section(dir) {
    var secs = Array.prototype.slice.call(document.querySelectorAll("#pane .sig"));
    if (!secs.length) return;
    var at = secs.findIndex(function (x) { return x.classList.contains("is-current-ask"); });
    if (at < 0) at = secs.findIndex(function (x) { return x.classList.contains("is-open"); });
    var next = secs[Math.max(0, Math.min(secs.length - 1, at + dir))];
    Pane.setAsk(next.dataset.signal);
    next.scrollIntoView({ block: "nearest", behavior: Motion.isReduced() ? "auto" : "smooth" });
    Announce.say(next.querySelector(".sig-say").textContent + ". Enter answers.");
  }

  /** Shows the rest of a large group, with the first newly shown member current. */
  function showMore(r) {
    var st = App.state;
    var lead = r.group.lead.id;
    var mine = function (x) { return x.type === "member" && x.group.lead.id === lead; };
    var shown = st.rows.filter(mine).length;
    st.showAll.add(r.groupKey);
    st.focus = "g:" + lead;
    App.render({ flip: true });
    var members = st.rows.filter(mine);
    if (members[shown]) App.focusRow(members[shown].key, { keyboard: true });
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
    Menus.close();
    Bar.closeNarrow();
    Bar.closeScope();
    // When the rail is folded away, its place in the cycle is the scope button. Under 1032px the list
    // and the pane share one place: whichever is showing.
    var railStop = matchMedia("(max-width: 1329px)").matches ? document.getElementById("scope-btn") : document.querySelector("#rail [tabindex='0']");
    var list = App.el.list.querySelector("[tabindex='0']") || App.el.list;
    var pane = document.querySelector("#pane .pn-title") || document.querySelector("#pane button");
    if (App.isStacked()) { if (App.isPaneOpen()) list = null; else pane = null; }
    var spots = [document.getElementById("sx-input"), railStop, list, pane];
    spots = spots.filter(Boolean);
    var at = spots.findIndex(function (x) { return x.contains(document.activeElement) || (x === App.el.list.querySelector("[tabindex='0']") && App.el.list.contains(document.activeElement)) || (x.closest && x.closest("#pane") && document.getElementById("pane").contains(document.activeElement)) || (x.closest && x.closest("#rail") && document.getElementById("rail").contains(document.activeElement)); });
    var next = spots[(at + (back ? -1 : 1) + spots.length) % spots.length];
    if (next.matches(".pn-title")) next.tabIndex = -1;
    next.focus();
  }

  function onKey(e) {
    if (e.key === "F6") { cycle(e.shiftKey); e.preventDefault(); return; }
    var owned = Menus.key(e);
    if (owned === "own") return;
    if (owned) { e.preventDefault(); e.stopPropagation(); return; }
    if (Dialog.isOpen()) return;
    var t = e.target;
    // Single keys belong to the list and the pane, and to the page itself when nothing has the focus.
    // Anywhere else they do nothing (WCAG 2.1.4), so speech input or a stray key never acts on a row
    // nobody is looking at. From the rail the digits still pick a saved query; Esc goes back to the
    // list; / and ? reach the search and the keys from anywhere outside a field.
    var inPlace = t === document.body || t === document.documentElement || (t.closest && t.closest("#rows, #pane"));
    if (!inPlace) {
      var inRail = t.closest && t.closest("#rail, #scope-pop");
      if (e.key === "Escape" && t.closest && t.closest("#keys")) { sheet(false); e.preventDefault(); return; }
      if (e.key === "Escape" && !(t.closest && t.closest(".ib-bar, input"))) { if (App.state.focus) { App.focusCurrent(); e.preventDefault(); } return; }
      var reach = (e.key === "?" || e.key === "/") && !(t.closest && t.closest("input, textarea"));
      var digit = inRail && /^[1-8]$/.test(e.key);
      if (!reach && !digit && !((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z")) return;
    }
    var typing = t.closest && t.closest("input, textarea, [contenteditable], select");
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !typing) { Moves.undo(); e.preventDefault(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && !typing) {
      // ⌘A selects what the list shows: a group's members that the query holds, not the rest of it.
      App.state.rows.forEach(function (r) { if (r.type !== "member") idsOf(r).forEach(function (id) { App.state.selection.add(id); }); });
      App.render({});
      Announce.say(App.state.selection.size + " selected.");
      e.preventDefault();
      return;
    }
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
      var r = App.currentRow(), ids = idsOf(r, e.shiftKey);
      var all = ids.length && ids.every(function (id) { return st.selection.has(id); });
      ids.forEach(function (id) { if (all) st.selection.delete(id); else st.selection.add(id); });
      st.anchor = st.focus;
      App.render({});
      Announce.say((all ? "Unselected. " : "Selected. ") + st.selection.size + " selected in all.");
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
    else if (lower === "f") {
      // Narrow belongs to the list's head, so under 1032px the pane over the list slides away first.
      if (App.isStacked() && App.isPaneOpen()) App.setPaneOpen(false);
      var nb = document.querySelector("[data-narrow]");
      if (nb) Bar.narrow(nb);
    }
    else if (k === "[" || k === "]") section(k === "]" ? 1 : -1);
    else if (k === " ") { var sc = document.querySelector("#pane .pn-scroll"); if (sc) sc.scrollBy({ top: (e.shiftKey ? -1 : 1) * sc.clientHeight * 0.8, behavior: Motion.isReduced() ? "auto" : "smooth" }); }
    else if (k === "Enter") primaryAnswer();
    else if (k === "ArrowRight") { var g = App.currentRow(); if (g && g.type === "group") Moves.toggleGroup(g.key, true); }
    else if (k === "ArrowLeft") {
      var c = App.currentRow();
      if (c && c.type === "group") Moves.toggleGroup(c.key, false);
      else if (c && (c.type === "member" || c.type === "more")) { App.focusRow("g:" + c.group.lead.id, { keyboard: true }); }
    }
    else if (k === "/") {
      // Search results show in the list, so under 1032px the pane over it slides away first.
      if (App.isStacked() && App.isPaneOpen()) App.setPaneOpen(false, true);
      Bar.focus();
    }
    else if (k === "?") sheet();
    else if (k === ".") Moves.showNew();
    else if (/^[1-7]$/.test(k)) Moves.setScope({ saved: Kinds.SAVED[+k - 1].id });
    else if (k === "8") Moves.setScope({ triage: 1 });
    else if (k === "Escape") {
      if (!document.getElementById("keys").hidden) sheet(false);
      else if (App.isStacked() && App.isPaneOpen()) App.setPaneOpen(false);
      else if (st.selection.size) { st.selection.clear(); st.anchor = null; App.render({}); Announce.say("Selection cleared."); }
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

  return { start: start, sheet: sheet, selectRange: selectRange, idsOf: idsOf, showMore: showMore };
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
