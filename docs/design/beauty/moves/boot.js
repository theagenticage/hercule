// PROTOTYPE - turns moves on and off. Runs in <head>, before any stylesheet applies, so a page
// asked for with ?m=paper,type paints with its moves on from the first frame.
//
// A move is one attribute on <html>, data-b-<id>. Every rule in moves.css sits behind its
// attribute and every listener in moves.js starts in a move's on(), so with no move on the page
// is the clean build, pixel for pixel. tools/identity.mjs checks that.
window.Beauty = (function () {
  "use strict";

  var root = document.documentElement;
  var hooks = {};
  var ready = false;
  var isOn = {};

  /** Checks whether the reader asked for no movement. */
  function isCalm() {
    return root.dataset.motion === "reduced" || matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /** Turns one move on or off, in the attribute and in its script. */
  function set(id, on) {
    if (!!isOn[id] === !!on) return;
    isOn[id] = !!on;
    root.toggleAttribute("data-b-" + id, !!on);
    var hook = hooks[id];
    if (ready && hook && hook[on ? "on" : "off"]) hook[on ? "on" : "off"]();
  }

  /** Registers what a move does in script: { on, off, play(name) }. */
  function move(id, hook) {
    hooks[id] = hook;
  }

  /** Sets the moves to exactly this list. */
  function setAll(ids) {
    Object.keys(isOn).forEach(function (id) { if (ids.indexOf(id) === -1) set(id, false); });
    ids.forEach(function (id) { set(id, true); });
  }

  /** Runs on() for every move switched on before the page's own scripts had finished. */
  function start() {
    ready = true;
    Object.keys(isOn).forEach(function (id) {
      if (isOn[id] && hooks[id] && hooks[id].on) hooks[id].on();
    });
  }

  var asked = new URLSearchParams(location.search).get("m");
  if (asked) asked.split(",").forEach(function (id) { if (id) set(id, true); });

  // postMessage, because frames opened from disk are cross-origin to the page that holds them.
  window.addEventListener("message", function (e) {
    var d = e.data || {};
    if (d.moves) setAll(d.moves);
    if (d.theme) root.dataset.theme = d.theme;
    if ("motion" in d) { if (d.motion) root.dataset.motion = d.motion; else delete root.dataset.motion; }
    if (d.scrollTo) {
      var scroller = document.getElementById("scroll") || document.getElementById("page");
      if (scroller) scroller.scrollTo({ top: d.scrollTo, behavior: isCalm() ? "auto" : "smooth" });
    }
    if (d.play && hooks[d.play.id] && hooks[d.play.id].play) hooks[d.play.id].play(d.play.name, d.play.value);
  });

  // Inside the study, Option and backslash belong to the panel, even while the board has the keys.
  if (window.top !== window) {
    ["keydown", "keyup"].forEach(function (type) {
      window.addEventListener(type, function (e) {
        if (e.key === "Alt" || e.key === "\\") window.top.postMessage({ studyKey: e.key, down: type === "keydown" }, "*");
      });
    });
  }

  return { move: move, set: set, setAll: setAll, start: start, isOn: function (id) { return !!isOn[id]; }, isCalm: isCalm };
})();
