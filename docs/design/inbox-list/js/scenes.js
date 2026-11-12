// PROTOTYPE - every state of the drawing by URL, so the story page and the captures can show it:
// desktop.html?scene=<name>&theme=<theme>&load=light|normal|extreme&motion=reduced
window.Scenes = (function () {
  "use strict";
  var params = new URLSearchParams(location.search);
  if (params.get("motion") === "reduced") document.documentElement.dataset.motion = "reduced";

  var BEFORE = {
    pr: function (s) { s.open.add("g:shop-142"); s.focus = "m:shop-142:pr-6244"; },
    "pr-second": function (s) { s.open.add("g:shop-142"); s.focus = "m:shop-142:pr-6244"; },
    linear: function (s) { s.scope = { saved: "mine" }; s.focus = "r:shop-150"; },
    sentry: function (s) { s.scope = { saved: "errors" }; s.focus = "r:sn-21c"; },
    email: function (s) { s.focus = "r:gm-quote"; },
    "sentry-group": function (s) { s.open.add("g:shop-142"); s.focus = "m:shop-142:sn-1z9"; },
    "linear-group": function (s) { s.open.add("g:shop-142"); s.focus = "m:shop-142:shop-142"; },
    group: function (s) { s.focus = "g:shop-142"; },
    "group-open": function (s) { s.open.add("g:shop-142"); s.focus = "g:shop-142"; },
    "group-member": function (s) { s.open.add("g:shop-142"); s.focus = "m:shop-142:pr-6244"; },
    large: function (s) { s.open.add("g:pay-88"); s.focus = "g:pay-88"; },
    "large-all": function (s) { s.open.add("g:pay-88"); s.showAll.add("g:pay-88"); s.focus = "g:pay-88"; },
    triage: function (s) { s.scope = { triage: 1 }; s.focus = "t:prop-kp"; },
    proposal: function (s) { s.focus = "t:prop-kp"; },
    suggestion: function (s) { s.focus = "t:link-6251"; },
    browse: function (s) { s.scope = Rail.browseScope("linear", null, "project", "Checkout revamp"); s.folded.delete("linear"); },
    accounts: function (s) { s.folded.delete("sentry"); s.folded.add("linear"); s.scope = Rail.browseScope("sentry", "northwind-labs", "team", "Checkout"); },
    selection: function (s) { ["pr-6213", "pr-6230", "pr-6260"].forEach(function (id) { s.selection.add(id); }); s.focus = "r:pr-6230"; },
    search: function (s) { s.search = { text: "", clauses: [{ key: "team", value: "Checkout" }, { key: "waiting", value: ">2h" }] }; },
    held: function (s) { s.scope = { saved: "hercule" }; },
    updates: function (s) { s.scope = { saved: "updates" }; },
    everything: function (s) { s.scope = { saved: "all" }; },
    empty: function (s) { Model.live().forEach(function (t) { if (Model.asks(t) && !t.held) Model.gone.add(t.id); }); Model.triage().forEach(function (x) { Model.gone.add(x.id); }); },
    zero: function (s) { Model.all().forEach(function (t) { Model.gone.add(t.id); }); Model.triage().forEach(function (x) { Model.gone.add(x.id); }); },
    nosearch: function (s) { s.search = { text: "", clauses: [{ key: "team", value: "Checkout" }, { key: "events", value: ">100000" }] }; },
    loading: function (s) { s.loading = true; },
    offline: function (s) { s.offline = true; },
    failing: function (s) { s.failing = "github"; s.folded.delete("github"); },
    new: function (s) { s.pending = World.arrivals(); },
    wide: function (s) { s.open.add("g:shop-142"); s.focus = "m:shop-142:pr-6244"; App.setPaneWidth(620); },
    narrow: function (s) { App.setPaneWidth(360); },
  };

  /** Calls fn with the element once it exists, checking each frame for up to two seconds. */
  function when(sel, fn) {
    var t0 = performance.now();
    (function look() { var el = document.querySelector(sel); if (el) fn(el); else if (performance.now() - t0 < 2000) requestAnimationFrame(look); })();
  }

  var AFTER = {
    "pr-second": function () { when('#pane [data-sig-fold="s2"]', function (b) { b.click(); }); },
    hand: function () { App.state.open.add("g:shop-142"); App.render({}); App.focusRow("m:shop-142:pr-6244"); Moves.handOff(document.querySelector("#pane .pn-move--hand")); },
    linkto: function () { App.focusRow("r:pr-6213"); Moves.linkKey(); },
    narrowmenu: function () { var b = document.querySelector("[data-narrow]"); Bar.narrow(b); var f = document.querySelector('#narrow [data-nf="linear|project"]'); if (f) f.click(); },
    searchmenu: function () { var i = document.getElementById("sx-input"); i.focus(); i.value = "team:"; i.dispatchEvent(new Event("input")); },
    keys: function () { Keys.sheet(true); },
    dialog: function () { App.focusRow("g:shop-142"); Moves.run("thread"); },
    "dialog-one": function () { App.focusRow("r:pr-1302"); Moves.run("thread"); },
    "dialog-unpicked": function () { App.focusRow("t:prop-kp"); Moves.run("thread"); },
    "dialog-why": function () { App.focusRow("g:shop-142"); Moves.run("thread"); when('#dialog [data-why="project"]', function (b) { b.click(); }); },
    "dialog-started": function () { App.focusRow("g:shop-142"); Moves.run("thread"); when("#dialog [data-send]", function (b) { b.click(); }); },
    "dialog-context": function () { App.focusRow("g:shop-142"); Moves.run("thread"); when("#dialog [data-send]", function (b) { b.click(); when("#dialog [data-ctx]", function (c) { c.click(); }); }); },
    reply: function () { App.focusRow("r:gm-quote"); when('#pane [data-answer="reply"]', function (b) { b.click(); }); },
    undo: function () { App.focusRow("r:pr-6230"); Moves.dismiss(); },
    arrive: function () { setTimeout(function () { Live.arrive(World.arrivals()); }, 1200); },
  };

  function apply(name, state) {
    (name || "").split(",").forEach(function (n) { if (BEFORE[n]) BEFORE[n](state); });
  }
  function after(name) {
    (name || "").split(",").forEach(function (n) { if (AFTER[n]) AFTER[n](); });
  }
  return { apply: apply, after: after, names: Object.keys(BEFORE).concat(Object.keys(AFTER)) };
})();
