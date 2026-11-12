// PROTOTYPE - linking by drag: lift a row past 6px, carry it onto another row or group, and let go
// to link the two. Esc, or letting go anywhere else, sends it home. The page holds still meanwhile.
window.Drag = (function () {
  "use strict";
  var carry = null;
  var dropped = 0;

  function rowAt(x, y) {
    var el = document.elementFromPoint(x, y);
    var row = el && el.closest("#rows [data-key]");
    if (!row || row.classList.contains("row--more") || row.classList.contains("row--triage")) return null;
    return row;
  }

  function begin(e, row) {
    var layer = document.getElementById("flight");
    var ghost = Motion.ghost(row, layer);
    ghost.classList.add("is-carried");
    ghost.classList.remove("is-current");
    row.classList.add("is-lifted");
    var r = row.getBoundingClientRect();
    carry = { row: row, id: row.dataset.id, ghost: ghost, dx: e.clientX - r.left, dy: e.clientY - r.top, x0: r.left, y0: r.top, lastX: e.clientX, lastY: e.clientY, vx: 0, vy: 0, target: null, relax: 0 };
    var b = Motion.body(ghost);
    b.to({ s: 1.02 }, "hand");
    if (!Motion.isReduced()) ghost.animate([{ boxShadow: "none" }, { boxShadow: getComputedStyle(ghost).boxShadow }], { duration: 160, easing: "cubic-bezier(.2,.8,.2,1)" });
    document.documentElement.classList.add("is-carrying");
  }

  function move(e) {
    var b = Motion.body(carry.ghost);
    carry.vx = carry.vx * 0.7 + (e.clientX - carry.lastX) * 0.3;
    carry.vy = carry.vy * 0.7 + (e.clientY - carry.lastY) * 0.3;
    carry.lastX = e.clientX;
    carry.lastY = e.clientY;
    b.follow(e.clientX - carry.dx - carry.x0, e.clientY - carry.dy - carry.y0);
    if (!Motion.isReduced()) b.to({ r: Math.max(-2.5, Math.min(2.5, carry.vx * 0.35)) }, "hand");
    // A card held still stands up straight again.
    clearTimeout(carry.relax);
    var c = carry;
    carry.relax = setTimeout(function () { c.vx = 0; c.vy = 0; Motion.body(c.ghost).to({ r: 0 }, "hand"); }, 90);
    var t = rowAt(e.clientX, e.clientY);
    if (t && (t === carry.row || t.dataset.id === carry.id)) t = null;
    if (t !== carry.target) {
      if (carry.target) carry.target.classList.remove("is-drop");
      carry.target = t;
      if (t) t.classList.add("is-drop");
      carry.ghost.classList.toggle("is-over", !!t);
    }
  }

  function end(e, cancel) {
    var c = carry;
    carry = null;
    document.documentElement.classList.remove("is-carrying");
    dropped = performance.now();
    if (c.target) c.target.classList.remove("is-drop");
    c.ghost.classList.remove("is-over");
    var b = Motion.body(c.ghost);
    clearTimeout(c.relax);
    if (!cancel && c.target) {
      var targetId = c.target.dataset.id || c.target.dataset.group;
      c.row.classList.remove("is-lifted");
      // The carried copy itself flies into the group, from where it is, with its tilt and speed.
      // It flies on with the speed the hand gave it.
      b.speed.x = c.vx * 60;
      b.speed.y = c.vy * 60;
      if (Moves.link([targetId, c.id], "drag", { id: c.id, ghost: c.ghost })) return;
      Moves.say("These are linked already.");
    }
    // Home with the speed the hand gave it.
    b.speed.x = c.vx * 60;
    b.speed.y = c.vy * 60;
    b.to({ x: 0, y: 0, s: 1, r: 0 }, "travel", { done: function () { c.ghost.remove(); c.row.classList.remove("is-lifted"); } });
    if (Motion.isReduced()) { c.ghost.remove(); c.row.classList.remove("is-lifted"); }
  }

  function start(host) {
    host.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      var row = e.target.closest("[data-key]");
      if (!row || !row.dataset.id || row.classList.contains("row--triage") || e.target.closest("[data-tick], [data-fold-group], [data-row-act], button, a")) return;
      var x0 = e.clientX, y0 = e.clientY, started = false;
      var onMove = function (ev) {
        if (!started && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 6) { started = true; begin(ev, row); }
        if (started) move(ev);
      };
      var onUp = function (ev) {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("keydown", onKey, true);
        if (started && carry) end(ev, false);
      };
      var onKey = function (ev) { if (ev.key === "Escape" && carry) { ev.stopPropagation(); ev.preventDefault(); end(ev, true); window.removeEventListener("pointermove", onMove); } };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("keydown", onKey, true);
    });
    host.addEventListener("dragstart", function (e) { e.preventDefault(); });
  }

  return { start: start, justDropped: function () { return performance.now() - dropped < 200; }, isCarrying: function () { return !!carry; } };
})();
