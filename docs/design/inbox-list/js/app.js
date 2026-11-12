// PROTOTYPE - the page's state and how it is drawn. Rail, list and pane each draw from App.state;
// a move changes the state through Moves, and App.render draws what changed.
window.App = (function () {
  "use strict";
  var params = new URLSearchParams(location.search);

  var state = {
    load: params.get("load") || "normal",
    scope: { saved: "waits" },
    search: { text: "", clauses: [] },
    focus: null, // the key of the current row
    selection: new Set(), // thing ids
    anchor: null, // the row a ⇧-range starts from
    open: new Set(), // group keys that are unfolded
    showAll: new Set(), // large groups shown whole
    folded: new Set(), // the declared setting inbox.browseFolded
    pins: [], // the declared setting inbox.pins: { source, account, field, value }
    paneW: Number(params.get("pane")) || 420,
    pending: [], // arrivals the list holds back behind the "N new" bar
    offline: false,
    failing: null, // a source that cannot be read
    loading: false,
    rows: [], // the flat list as drawn: { key, type, ... }
    built: null,
  };

  var el = {};

  function boot() {
    document.getElementById("side").outerHTML = window.SIDEBAR_HTML;
    el.main = document.getElementById("main");
    el.ib = document.getElementById("ib");
    el.rail = document.getElementById("rail");
    el.list = document.getElementById("rows");
    el.listHead = document.getElementById("list-head");
    el.pane = document.getElementById("pane");
    el.newbar = document.getElementById("newbar");
    Model.load(World.build(state.load));
    state.pins = World.SETTINGS.pins.slice();
    state.folded = new Set(World.SETTINGS.browseFolded);
    setPaneWidth(state.paneW);
    Scenes.apply(params.get("scene"), state);
    render();
    document.documentElement.dataset.ready = "";
  }

  /** Describes the current scope in words, for the list head. */
  function scopeTitle() {
    if (state.scope.triage) return "Triage";
    if (state.scope.saved) return Kinds.SAVED.find(function (s) { return s.id === state.scope.saved; }).name;
    var b = state.scope.browse;
    return b.value;
  }

  /** Builds the flat rows the list draws: triage, then things and groups, with the members of unfolded groups. */
  function buildFlat() {
    var built = Model.buildRows(state.scope, state.search);
    var flat = [];
    built.rows.forEach(function (u, i) {
      if (u.type === "proposal" || u.type === "link") { flat.push({ key: u.key, type: u.type, item: u.item, things: u.things, lastTriage: i === built.triage - 1 }); return; }
      if (u.type === "tmore") { flat.push({ key: u.key, type: "tmore", n: u.n, lastTriage: true }); return; }
      if (u.type === "thing") { flat.push({ key: u.key, type: "thing", thing: u.thing }); return; }
      var g = u.group;
      // While searching, a group whose hit is one of its members opens, so the hit is in sight.
      var searching = state.search.text || state.search.clauses.length;
      var isOpen = state.open.has(u.key) || (searching && u.hits.some(function (h) { return h !== g.lead; }));
      flat.push({ key: u.key, type: "group", group: g, hits: u.hits, best: u.best, open: !!isOpen });
      if (!isOpen) return;
      var hitIds = new Set(u.hits.map(function (h) { return h.id; }));
      // Members that answer the query first, then the rest, each by the saved query's order.
      var members = g.members.slice().sort(function (a, b) {
        return (hitIds.has(b.id) - hitIds.has(a.id)) || ((Model.waitOf(b) || 0) - (Model.waitOf(a) || 0)) || (a.updated - b.updated);
      });
      var limit = state.showAll.has(u.key) || members.length <= 7 ? members.length : 5;
      members.slice(0, limit).forEach(function (m, j) {
        flat.push({ key: "m:" + g.lead.id + ":" + m.id, type: "member", thing: m, group: g, pos: j + 1, outside: !hitIds.has(m.id), last: j === limit - 1 && limit === members.length });
      });
      if (limit < members.length) flat.push({ key: "x:" + g.lead.id, type: "more", group: g, groupKey: u.key, n: members.length - limit });
    });
    state.built = built;
    return flat;
  }

  function render(opts) {
    opts = opts || {};
    var ae = document.activeElement;
    // Where the focus was decides whether the new current row takes it: from the list always, and from
    // the pane or the selection bar when the control it was on is gone.
    var was = !el.list ? null : el.list.contains(ae) ? "list" : el.pane.contains(ae) || document.getElementById("selbar").contains(ae) ? "pane" : null;
    var before = state.focus;
    var oldRows = state.rows || [];
    state.rows = buildFlat();
    var after = state.focusAfter;
    // After a move, the row after the handled one in the old order becomes current: when the handled
    // row is gone, and also when a move keeps its place and the handled thing is elsewhere in the list.
    var hint = state.focusHint;
    var rowAt = function (key) { return state.rows.find(function (r) { return r.key === key; }); };
    var gone = !rowAt(state.focus);
    if (hint != null && (opts.keepPlace || gone)) {
      var at = (after && rowAt(nextInPlace(after, hint, oldRows, state.rows))) || (hint >= 0 ? state.rows[Math.min(hint, state.rows.length - 1)] : null);
      // "Show N more" is not a thing to act on: the member above it takes the place instead.
      if (at && at.type === "more") at = state.rows[Math.max(0, state.rows.indexOf(at) - 1)];
      if (at) state.focus = at.key;
    }
    if (!rowAt(state.focus)) state.focus = (state.rows.find(function (r) { return r.type !== "more"; }) || {}).key || null;
    if (state.focus !== before && state.focusHint != null) state.movedAt = performance.now();
    state.focusHint = null;
    state.focusAfter = null;
    var paneless = !state.focus && !state.selection.size && !state.loading;
    if (paneless !== el.ib.classList.contains("is-paneless") && opts.flip && !Motion.isReduced()) {
      if (paneless) fadePaneOut(); else el.pane.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: "ease-out" });
    }
    el.ib.classList.toggle("is-paneless", paneless);
    Rail.draw(el.rail, state);
    List.draw(el.list, el.listHead, state, opts);
    Pane.draw(el.pane, state, opts);
    Bar.draw(state);
    var n = Model.countSaved("waits");
    var c = document.querySelector("[data-inbox-count]");
    if (c) { c.textContent = n; c.style.display = n ? "" : "none"; }
    var cur = el.list.querySelector('[data-key="' + state.focus + '"]');
    if (!Dialog.isOpen() && cur) {
      var now = document.activeElement;
      if ((was === "list" && now !== cur) || (was === "pane" && (now === document.body || !now || !now.isConnected))) focusCurrent();
      // The current row is never left out of sight. Its place is measured where it will rest, not where
      // a move's motion still holds it, and the list scrolls by the least distance. While rows move, the
      // scroll is smooth too, so no row jumps in one frame.
      // A move brings the undo line, and the rows beside it fade out, so after a move the row keeps
      // clear of the line's room as well.
      var scroller = el.list.parentElement, box = scroller.getBoundingClientRect(), r = Motion.layoutRect(cur);
      var foot = Math.max(parseFloat(getComputedStyle(scroller).scrollPaddingBottom) || 0, opts.flip ? 96 : 28);
      var by = r.top < box.top + 4 ? r.top - box.top - 4 : r.top + r.height > box.bottom - foot ? r.top + r.height - box.bottom + foot : 0;
      if (by && !opts.scrolls) scroller.scrollBy({ top: by, behavior: opts.flip && !Motion.isReduced() ? "smooth" : "instant" });
    }
  }

  /**
   * Returns the key of the row that becomes current after a move that keeps its place: the first row
   * after the handled one, in the old order, that is still in the list. A row that travels far with a
   * re-sorted group is passed over, so the highlight stays where the eyes are; when every row travels,
   * the first one is taken.
   */
  function nextInPlace(after, from, oldRows, rows) {
    var oldAt = new Map(oldRows.map(function (r, i) { return [r.key, i]; }));
    var newAt = new Map(rows.map(function (r, i) { return [r.key, i]; }));
    var here = after.filter(function (k) { return newAt.has(k) && oldAt.has(k); });
    if (!here.length) return null;
    // Most rows below the handled one shift by the same amount (the rows that left above them); a row
    // that shifts by much more is travelling with its group.
    var below = here.filter(function (k) { return oldAt.get(k) > from; });
    var shifts = new Map();
    (below.length ? below : here).forEach(function (k) { var d = newAt.get(k) - oldAt.get(k); shifts.set(d, (shifts.get(d) || 0) + 1); });
    var usual = Array.from(shifts).sort(function (a, b) { return b[1] - a[1]; })[0][0];
    return here.find(function (k) { return Math.abs(newAt.get(k) - oldAt.get(k) - usual) <= 1; }) || here[0];
  }

  /** Fades a copy of the pane where it stood, so the pane steps aside rather than vanishing in one frame. */
  function fadePaneOut() {
    var r = el.pane.getBoundingClientRect(), at = el.ib.getBoundingClientRect();
    if (!r.width) return;
    var copy = el.pane.cloneNode(true);
    copy.removeAttribute("id");
    copy.querySelectorAll("[id]").forEach(function (n) { n.removeAttribute("id"); });
    copy.setAttribute("aria-hidden", "true");
    copy.inert = true;
    Object.assign(copy.style, { position: "absolute", left: r.left - at.left + "px", top: r.top - at.top + "px", width: r.width + "px", height: r.height + "px", zIndex: 4, pointerEvents: "none" });
    el.ib.appendChild(copy);
    copy.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: "ease-out", fill: "forwards" }).finished.then(function () { copy.remove(); });
  }

  function currentRow() { return state.rows.find(function (r) { return r.key === state.focus; }) || null; }

  /** Returns the things a move acts on: the selection, else the current row's thing or group. */
  function acted() {
    if (state.selection.size) return Array.from(state.selection).map(Model.byId).filter(Boolean);
    var r = currentRow();
    if (!r) return [];
    if (r.type === "group") return r.group.members;
    if (r.type === "thing" || r.type === "member") return [r.thing];
    return r.things || [];
  }

  /**
   * Sets the pane's width: 360 to 640, and never so wide that the list gets less than 400px. The width
   * asked for is kept, so the pane grows back to it when the window grows.
   */
  var asked = 420;
  function setPaneWidth(w) {
    if (w != null) asked = w;
    var main = el.ib.getBoundingClientRect().width || innerWidth - 272;
    var rail = matchMedia("(max-width: 1329px)").matches ? 0 : 240;
    var max = Math.max(360, Math.min(640, main - rail - 400));
    state.paneW = Math.round(Math.max(360, Math.min(max, asked)));
    el.ib.style.setProperty("--pane-w", state.paneW + "px");
    var edge = document.getElementById("edge");
    if (edge) { edge.setAttribute("aria-valuenow", state.paneW); edge.setAttribute("aria-valuemax", max); }
  }
  // The bar's tokens and hint fit the field, so they are fitted again when the window changes.
  window.addEventListener("resize", function () { setPaneWidth(); Bar.draw(state); });

  // Under 900px (or at 200% zoom) the pane lies over the list: ↩ or a click opens it, Esc closes it.
  var stacked = matchMedia("(max-width: 899px)");
  function isStacked() { return stacked.matches; }
  function setPaneOpen(on) {
    el.ib.classList.toggle("is-pane-open", !!on);
    if (on) { var t = el.pane.querySelector(".pn-title"); if (t) { t.tabIndex = -1; t.focus({ preventScroll: true }); } }
    else { var cur = el.list.querySelector('[data-key="' + state.focus + '"]'); if (cur) cur.focus({ preventScroll: true }); }
  }

  function focusRow(key, opts) {
    if (!key) return;
    state.focus = key;
    List.markFocus(el.list, state, opts);
    Pane.draw(el.pane, state, { walk: opts && opts.dir });
    if (opts && opts.keyboard && isStacked() && isPaneOpen()) focusCurrent();
  }

  /**
   * Puts the keyboard focus on the current row, or on the pane's title while the pane lies over the
   * list (under 900px), so the focus is never on a row nobody can see. Does nothing with no current row.
   */
  function focusCurrent() {
    var target = isStacked() && isPaneOpen() ? el.pane.querySelector(".pn-title") : el.list.querySelector('[data-key="' + state.focus + '"]');
    if (!target) return;
    if (target.matches(".pn-title")) target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }
  function isPaneOpen() { return el.ib.classList.contains("is-pane-open"); }

  return { isStacked: isStacked, setPaneOpen: setPaneOpen, isPaneOpen: isPaneOpen, focusCurrent: focusCurrent, state: state, boot: boot, render: render, currentRow: currentRow, acted: acted, scopeTitle: scopeTitle, setPaneWidth: setPaneWidth, focusRow: focusRow, el: el };
})();
