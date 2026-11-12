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
      var isOpen = state.open.has(u.key);
      flat.push({ key: u.key, type: "group", group: g, hits: u.hits, best: u.best, open: isOpen });
      if (!isOpen) return;
      var hitIds = new Set(u.hits.map(function (h) { return h.id; }));
      // Members that answer the query first, then the rest, each by the saved query's order.
      var members = g.members.slice().sort(function (a, b) {
        return (hitIds.has(b.id) - hitIds.has(a.id)) || ((Model.waitOf(b) || 0) - (Model.waitOf(a) || 0)) || (a.updated - b.updated);
      });
      var limit = state.showAll.has(u.key) || members.length <= 7 ? members.length : 5;
      members.slice(0, limit).forEach(function (m, j) {
        flat.push({ key: "m:" + g.lead.id + ":" + m.id, type: "member", thing: m, group: g, outside: !hitIds.has(m.id), last: j === limit - 1 && limit === members.length });
      });
      if (limit < members.length) flat.push({ key: "x:" + g.lead.id, type: "more", group: g, groupKey: u.key, n: members.length - limit });
    });
    state.built = built;
    return flat;
  }

  function render(opts) {
    opts = opts || {};
    state.rows = buildFlat();
    if (!state.rows.some(function (r) { return r.key === state.focus; })) {
      var hint = state.focusHint;
      var at = hint != null && hint >= 0 ? state.rows[Math.min(hint, state.rows.length - 1)] : null;
      if (at && at.type === "more") at = state.rows[Math.max(0, state.rows.indexOf(at) - 1)];
      state.focus = at ? at.key : state.rows.length ? (state.rows.find(function (r) { return r.type !== "more"; }) || {}).key || null : null;
    }
    state.focusHint = null;
    Rail.draw(el.rail, state);
    List.draw(el.list, el.listHead, state, opts);
    Pane.draw(el.pane, state, opts);
    Bar.draw(state);
    var n = Model.countSaved("waits");
    var c = document.querySelector("[data-inbox-count]");
    if (c) { c.textContent = n; c.hidden = n === 0; }
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

  function setPaneWidth(w) {
    state.paneW = Math.round(Math.max(360, Math.min(640, w)));
    el.ib.style.setProperty("--pane-w", state.paneW + "px");
  }

  function focusRow(key, opts) {
    if (!key) return;
    state.focus = key;
    List.markFocus(el.list, state, opts);
    Pane.draw(el.pane, state, { walk: opts && opts.dir });
  }

  return { state: state, boot: boot, render: render, currentRow: currentRow, acted: acted, scopeTitle: scopeTitle, setPaneWidth: setPaneWidth, focusRow: focusRow, el: el };
})();
