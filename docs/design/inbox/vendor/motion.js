// PROTOTYPE - the motion kernel. One clock, real springs, and one rule that everything else
// follows: the board measures what you can see, not where a thing was meant to be. Reversing an
// animation is therefore never a special case: it is one more change, starting from the frame
// on screen with the velocity it already has.
//
// Everything moves by transform and opacity. MOTION.md has the language; this file is its engine.
window.Motion = (function () {
  "use strict";

  // Three springs, stiffness and damping at mass 1. Overshoot is never built in: a slight overshoot
  // appears only where a thing lands with the speed of your hand.
  var SPRINGS = {
    hand: { k: 632, c: 43 }, // under your hand, or answering it at once (ratio 0.86)
    travel: { k: 305, c: 31 }, // crossing the screen because you asked (0.89)
    self: { k: 90, c: 19 }, // moving by itself, slow and unhurried (1.00)
  };

  var params = new URLSearchParams(location.search);
  // ?slow=8 runs every spring eight times slower: for judging motion frame by frame.
  var speed = 1 / (Number(params.get("slow")) || 1);
  var active = new Set();
  var frame = 0;
  var last = 0;
  var manual = false;

  /** Checks whether the reader asked for no movement. The board swaps movement for short fades. */
  function isReduced() {
    return document.documentElement.dataset.motion === "reduced" || matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function loop(now) {
    frame = 0;
    // The first frame's timestamp can fall before the moment the clock woke, so dt can come out negative.
    var dt = Math.max(0, Math.min(0.034, (now - last) / 1000 || 0.016));
    last = now;
    advance(dt * speed);
    if (active.size && !manual) frame = requestAnimationFrame(loop);
  }

  function advance(dt) {
    active.forEach(function (body) {
      body.step(dt);
    });
  }

  function wake(body) {
    active.add(body);
    if (!frame && !manual) {
      last = performance.now();
      frame = requestAnimationFrame(loop);
    }
  }

  var bodies = new WeakMap();
  // Position, scale, tilt, opacity and lift. Lift is a card's height while it is in your hand,
  // from 0 to 1. It rides the same spring as everything else, so a card visibly rises and settles.
  var CHANNELS = ["x", "y", "s", "r", "o", "l"];
  var SETTLED = { x: 0.08, y: 0.08, s: 0.0006, r: 0.02, o: 0.004, l: 0.004 };

  /**
   * A thing on screen with a position offset, a scale, a tilt and an opacity, each on its own
   * spring. Asking it to go somewhere new while it moves keeps its velocity, so a reversal
   * looks like one continuous motion.
   */
  function Body(el) {
    this.el = el;
    this.value = { x: 0, y: 0, s: 1, r: 0, o: 1, l: 0 };
    this.speed = { x: 0, y: 0, s: 0, r: 0, o: 0, l: 0 };
    this.goal = { x: 0, y: 0, s: 1, r: 0, o: 1, l: 0 };
    this.spring = { x: SPRINGS.hand, y: SPRINGS.hand, s: SPRINGS.hand, r: SPRINGS.hand, o: SPRINGS.hand, l: SPRINGS.hand };
    this.tolerance = SETTLED;
    this.wait = 0;
    this.pending = null;
    this.onRest = null;
  }

  Body.prototype.write = function () {
    var v = this.value;
    var moved = v.x !== 0 || v.y !== 0 || v.s !== 1 || v.r !== 0;
    this.el.style.transform = moved ? "translate3d(" + v.x.toFixed(2) + "px," + v.y.toFixed(2) + "px,0) scale(" + v.s.toFixed(4) + ") rotate(" + v.r.toFixed(3) + "deg)" : "";
    this.el.style.opacity = v.o === 1 ? "" : v.o.toFixed(3);
    if (v.l !== 0 || this.lifted) {
      this.el.style.setProperty("--lift", v.l.toFixed(3));
      this.lifted = v.l !== 0;
    }
  };

  Body.prototype.step = function (dt) {
    if (this.wait > 0) {
      this.wait -= dt * 1000;
      if (this.wait > 0) return;
      if (this.pending) {
        var p = this.pending;
        this.pending = null;
        this.apply(p.goal, p.spring);
      }
    }
    var settled = true;
    var steps = Math.max(1, Math.ceil(dt / 0.004));
    var h = dt / steps;
    for (var i = 0; i < CHANNELS.length; i++) {
      var c = CHANNELS[i];
      var x = this.value[c];
      var v = this.speed[c];
      var g = this.goal[c];
      var k = this.spring[c].k;
      var d = this.spring[c].c;
      for (var n = 0; n < steps; n++) {
        v += (-k * (x - g) - d * v) * h;
        x += v * h;
      }
      if (Math.abs(x - g) < this.tolerance[c] && Math.abs(v) < this.tolerance[c] * 12) {
        x = g;
        v = 0;
      } else {
        settled = false;
      }
      this.value[c] = x;
      this.speed[c] = v;
    }
    this.write();
    if (settled) {
      active.delete(this);
      this.el.classList.remove("is-moving");
      var done = this.onRest;
      this.onRest = null;
      if (done) done();
    }
  };

  Body.prototype.apply = function (goal, spring) {
    for (var c in goal) {
      this.goal[c] = goal[c];
      this.spring[c] = spring;
    }
  };

  /** Jumps to these values with no velocity. Used for the first frame of a change. */
  Body.prototype.set = function (values) {
    for (var c in values) {
      this.value[c] = values[c];
      this.goal[c] = values[c];
      this.speed[c] = 0;
    }
    this.write();
    return this;
  };

  /** Puts the body exactly here, this frame. A carried card follows the pointer one to one. */
  Body.prototype.follow = function (x, y) {
    this.speed.x = 0;
    this.speed.y = 0;
    this.value.x = x;
    this.value.y = y;
    this.goal.x = x;
    this.goal.y = y;
    this.write();
    return this;
  };

  /**
   * Sends the body to these values on a named spring, after delay milliseconds. Reduced motion
   * jumps to the end at once, except opacity, which fades.
   */
  Body.prototype.to = function (goal, name, opts) {
    opts = opts || {};
    var spring = SPRINGS[name || "hand"];
    if (isReduced()) {
      var fade = "o" in goal ? { o: goal.o } : null;
      var jump = {};
      for (var c in goal) if (c !== "o") jump[c] = goal[c];
      this.set(jump);
      if (fade) {
        this.apply(fade, SPRINGS.travel);
        this.wait = 0;
      } else {
        if (opts.done) opts.done();
        return this;
      }
    } else if (opts.delay) {
      this.wait = opts.delay;
      this.pending = { goal: goal, spring: spring };
    } else {
      this.wait = 0;
      this.pending = null;
      this.apply(goal, spring);
    }
    this.onRest = opts.done || null;
    this.el.classList.add("is-moving");
    wake(this);
    return this;
  };

  /** Hands the element back to the style sheet. */
  Body.prototype.clear = function () {
    active.delete(this);
    this.value = { x: 0, y: 0, s: 1, r: 0, o: 1, l: 0 };
    this.goal = { x: 0, y: 0, s: 1, r: 0, o: 1, l: 0 };
    this.speed = { x: 0, y: 0, s: 0, r: 0, o: 0, l: 0 };
    this.wait = 0;
    this.pending = null;
    this.onRest = null;
    this.el.style.transform = "";
    this.el.style.opacity = "";
    this.el.style.removeProperty("--lift");
    this.el.classList.remove("is-moving");
  };

  /** Returns the body of an element, making one on first use. */
  function body(el) {
    var b = bodies.get(el);
    if (!b) {
      b = new Body(el);
      bodies.set(el, b);
    }
    return b;
  }

  /**
   * Returns a single number on a spring, for what a transform cannot do, such as a sheet changing
   * shape. onChange gets each new value. Call .to(goal, name) to send it somewhere, at any time.
   */
  function value(start, onChange) {
    var b = new Body(document.createElement("i"));
    b.tolerance = { x: 0.0005, y: 1, s: 1, r: 1, o: 1, l: 1 };
    b.write = function () {
      onChange(this.value.x);
    };
    b.value.x = start;
    b.goal.x = start;
    return {
      to: function (goal, name, done) {
        if (isReduced()) {
          b.value.x = goal;
          b.goal.x = goal;
          b.speed.x = 0;
          b.write();
          if (done) done();
          return;
        }
        b.apply({ x: goal }, SPRINGS[name || "travel"]);
        b.onRest = done || null;
        wake(b);
      },
      get: function () { return b.value.x; },
      set: function (v) {
        b.set({ x: v });
      },
    };
  }

  /** Returns the rectangle an element would have with no animation offset applied. */
  function layoutRect(el) {
    var r = el.getBoundingClientRect();
    var b = bodies.get(el);
    if (!b || (b.value.x === 0 && b.value.y === 0 && b.value.s === 1)) return r;
    var w = r.width / b.value.s;
    var h = r.height / b.value.s;
    return { left: r.left - b.value.x - (w - r.width) / 2, top: r.top - b.value.y - (h - r.height) / 2, width: w, height: h, right: r.right, bottom: r.bottom };
  }

  /**
   * Runs mutate, then moves every given element from where it was on screen to its new place.
   * els is a list, or a function returning the list to measure after the change.
   * Returns a map from element to the rectangle it had, so callers can animate what appeared.
   */
  function flip(els, mutate, opts) {
    opts = opts || {};
    var before = new Map();
    els.forEach(function (el) {
      before.set(el, el.getBoundingClientRect());
    });
    mutate();
    before.forEach(function (r0, el) {
      if (!el.isConnected) return;
      var b = body(el);
      var r1 = layoutRect(el);
      var dx = r0.left - r1.left;
      var dy = r0.top - r1.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
        if (b.value.x !== 0 || b.value.y !== 0) b.to({ x: 0, y: 0 }, opts.spring || "hand");
        return;
      }
      // A move of more than a screen is a jump in place, not a journey anyone could follow.
      if (isReduced() || Math.abs(dy) > 1400) {
        b.set({ x: 0, y: 0 });
        return;
      }
      b.value.x = dx;
      b.value.y = dy;
      b.write();
      var delay = opts.stagger ? opts.stagger(el, r0, r1) : 0;
      b.to({ x: 0, y: 0 }, opts.spring || "hand", { delay: delay });
    });
    return before;
  }

  /**
   * Draws a copy of an element in the flight layer, exactly as it looks now, so it can keep moving
   * after the original has left the page. Returns the copy. The caller removes it.
   */
  function ghost(el, layer) {
    var r = layoutRect(el);
    var host = layer.getBoundingClientRect();
    var from = bodies.get(el);
    var copy = el.cloneNode(true);
    copy.removeAttribute("id");
    copy.removeAttribute("tabindex");
    copy.classList.add("is-ghost");
    copy.classList.remove("is-moving", "is-focus");
    copy.style.position = "absolute";
    copy.style.margin = "0";
    copy.style.left = r.left - host.left + "px";
    copy.style.top = r.top - host.top + "px";
    copy.style.width = r.width + "px";
    copy.style.height = r.height + "px";
    copy.style.transform = "";
    copy.style.opacity = "";
    layer.appendChild(copy);
    if (from) body(copy).set({ x: from.value.x, y: from.value.y, s: from.value.s, r: from.value.r, o: from.value.o });
    return copy;
  }

  /** Calls fn on the next frame after layout has settled. */
  function nextFrame(fn) {
    requestAnimationFrame(function () {
      requestAnimationFrame(fn);
    });
  }

  return {
    SPRINGS: SPRINGS,
    body: body,
    value: value,
    flip: flip,
    ghost: ghost,
    layoutRect: layoutRect,
    isReduced: isReduced,
    nextFrame: nextFrame,
    // Runs the clock by hand: for capturing exact frames of an animation.
    freeze: function () {
      manual = true;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    },
    advance: function (ms) {
      for (var t = 0; t < ms; t += 16) advance(0.016);
    },
    resume: function () {
      manual = false;
      if (active.size) {
        last = performance.now();
        frame = requestAnimationFrame(loop);
      }
    },
  };
})();
