// PROTOTYPE - Colleagues who notice. Heads get depth and a lean of their own, and while the pointer
// moves near them their eyes glance at it. At rest nothing runs: there is one pointermove listener,
// and one frame loop that stops as soon as every eye has settled.
(function () {
  "use strict";

  var FACES = ".card-head .cr, .side-row .cr, .c-holder .cr";
  var NOTICE_RADIUS = 260;
  // How far the eyes travel, in the face's own units: about 1px on screen at the size a head is drawn.
  var GLANCE = 1.4;
  // The lowered eyes of a colleague at work come up this far, to about where they sit at rest.
  var LOOK_UP = 1.3;
  // A pointer that has stopped has stopped asking for attention, so they go back to what they were doing.
  var PATIENCE_MS = 1300;

  var root = document.documentElement;
  var faces = [];
  var known = new WeakMap();
  var pointer = { x: 0, y: 0, moved: 0 };
  var isStale = true;
  var frame = 0;
  var last = 0;
  var patience = 0;
  var observer = null;
  var defs = null;
  var dressQueued = 0;

  /** Reads a colleague's name from the label their face is drawn with: "Ada, working". */
  function readName(svg) {
    var label = svg.getAttribute("aria-label") || "";
    return label.slice(0, label.lastIndexOf(","));
  }

  /** Returns the lean a colleague always has, from -3 to 3 degrees, the same for them on every card. */
  function computeLean(name) {
    return ((Crew.hash(name + "lean") % 601) / 100 - 3).toFixed(2) + "deg";
  }

  /** Draws the crevice inside a head: its own outline, darkening towards the sheet's edge. */
  function drawCrevice(svg) {
    var outline = svg.querySelector("path");
    var shade = document.createElementNS("http://www.w3.org/2000/svg", "path");
    shade.setAttribute("class", "b-crevice");
    shade.setAttribute("d", outline.getAttribute("d"));
    shade.setAttribute("fill", "url(#b-crevice)");
    shade.setAttribute("pointer-events", "none");
    // Above the skin and under the eyes, so the features stay crisp.
    var eyes = svg.querySelector(':scope > g[style*="animation-delay"]');
    svg.insertBefore(shade, eyes);
  }

  /** Sets a face up once, and returns what the loop needs to move its eyes. */
  function dress(svg) {
    var face = known.get(svg);
    if (face) return face;
    var eyes = svg.querySelector(':scope > g[style*="animation-delay"]');
    var name = readName(svg);
    var pose = /cr--(\w+)/.exec(svg.getAttribute("class"));
    svg.style.setProperty("--b-lean", computeLean(name));
    if (svg.closest(".card-head")) drawCrevice(svg);
    // Each colleague has their own reaction time, so a row of them never moves as one.
    var stiffness = 62 + (Crew.hash(name + "eyes") % 58);
    face = { svg: svg, eyes: eyes, isWorking: !!pose && pose[1] === "working", x: 0, y: 0, cx: 0, cy: 0, vx: 0, vy: 0, k: stiffness, c: 2 * 0.92 * Math.sqrt(stiffness) };
    known.set(svg, face);
    return face;
  }

  /** Finds every face on the page. A face that a redraw replaced drops out here. */
  function collect() {
    dressQueued = 0;
    faces = Array.prototype.map.call(document.querySelectorAll(FACES), dress).filter(function (f) { return f.eyes; });
    isStale = true;
  }

  function queueCollect() {
    if (!dressQueued) dressQueued = requestAnimationFrame(collect);
  }

  /** Measures where every face is. Runs only after a scroll or a redraw, never inside each frame. */
  function measure() {
    isStale = false;
    faces.forEach(function (f) {
      var r = f.svg.getBoundingClientRect();
      f.cx = r.left + r.width / 2;
      f.cy = r.top + r.height / 2;
      f.isShown = r.width > 0;
    });
  }

  /** Works out where a face's eyes want to be, given where the pointer is now. */
  function aim(f, isWatching) {
    f.gx = 0;
    f.gy = 0;
    if (!isWatching || !f.isShown) return;
    var dx = pointer.x - f.cx;
    var dy = pointer.y - f.cy;
    var distance = Math.sqrt(dx * dx + dy * dy);
    if (distance > NOTICE_RADIUS) return;
    // Interest fades out towards the edge of the radius, so nobody snaps to attention. Right on top
    // of a face the direction means nothing, so the eyes come back to the middle.
    var interest = Math.min(1, (NOTICE_RADIUS - distance) / 90) * Math.min(1, distance / 16);
    var reach = GLANCE * interest / (distance || 1);
    f.gx = dx * reach;
    f.gy = dy * reach * 0.75;
    if (f.isWorking) f.gy -= LOOK_UP * Math.min(1, (NOTICE_RADIUS - distance) / 90);
  }

  /** Moves one face's eyes a step along their spring, and returns whether they are still moving. */
  function stepEyes(f, dt) {
    f.vx += (f.k * (f.gx - f.x) - f.c * f.vx) * dt;
    f.vy += (f.k * (f.gy - f.y) - f.c * f.vy) * dt;
    f.x += f.vx * dt;
    f.y += f.vy * dt;
    var isSettled = Math.abs(f.gx - f.x) < 0.01 && Math.abs(f.gy - f.y) < 0.01 && Math.abs(f.vx) < 0.05 && Math.abs(f.vy) < 0.05;
    if (isSettled) {
      f.x = f.gx;
      f.y = f.gy;
      f.vx = f.vy = 0;
    }
    // translate, not transform: the blink is an animation on transform, and the two have to add up.
    if (f.x === 0 && f.y === 0) f.eyes.style.removeProperty("translate");
    else f.eyes.style.translate = f.x.toFixed(2) + "px " + f.y.toFixed(2) + "px";
    return !isSettled;
  }

  /** Puts a face's eyes back at once, for when movement has been turned off. */
  function sendEyesHome(f) {
    f.x = f.y = f.vx = f.vy = 0;
    f.eyes.style.removeProperty("translate");
  }

  function isHeld() {
    return Beauty.isCalm() || root.dataset.still === "1";
  }

  function tick(now) {
    frame = 0;
    var dt = Math.max(0, Math.min(0.034, (now - last) / 1000 || 0.016));
    last = now;
    if (isStale) measure();
    var isHeldStill = isHeld();
    var isWatching = now - pointer.moved < PATIENCE_MS && !isHeldStill;
    var isMoving = false;
    faces.forEach(function (f) {
      if (isHeldStill) return sendEyesHome(f);
      aim(f, isWatching);
      if (stepEyes(f, dt)) isMoving = true;
    });
    if (isMoving) wake();
  }

  function wake() {
    if (frame) return;
    last = last && performance.now() - last < 64 ? last : performance.now();
    frame = requestAnimationFrame(tick);
  }

  function onPointerMove(e) {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.moved = performance.now();
    wake();
    // One timer, not a running loop: the eyes go back to the work with nothing ticking until then.
    clearTimeout(patience);
    patience = setTimeout(wake, PATIENCE_MS + 20);
  }

  function markStale() {
    isStale = true;
  }

  /** Adds the shared gradient the crevices paint with. It sits in the page, so it follows the theme. */
  function drawDefs() {
    defs = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    defs.setAttribute("width", "0");
    defs.setAttribute("height", "0");
    defs.setAttribute("aria-hidden", "true");
    defs.style.position = "absolute";
    defs.innerHTML = '<defs><linearGradient id="b-crevice" gradientUnits="userSpaceOnUse" x1="0" y1="25.5" x2="0" y2="32.5">' +
      '<stop offset="0" stop-color="var(--b-crevice)" stop-opacity="0"/><stop offset="0.55" stop-color="var(--b-crevice)" stop-opacity="0.42"/><stop offset="1" stop-color="var(--b-crevice)"/></linearGradient></defs>';
    document.body.appendChild(defs);
  }

  Beauty.move("colleagues", {
    on: function () {
      drawDefs();
      collect();
      document.addEventListener("pointermove", onPointerMove, { passive: true });
      document.addEventListener("scroll", markStale, { passive: true, capture: true });
      window.addEventListener("resize", markStale);
      observer = new MutationObserver(queueCollect);
      observer.observe(document.body, { childList: true, subtree: true });
    },
    off: function () {
      observer.disconnect();
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("scroll", markStale, { capture: true });
      window.removeEventListener("resize", markStale);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(dressQueued);
      clearTimeout(patience);
      frame = dressQueued = 0;
      defs.remove();
      document.querySelectorAll(".b-crevice").forEach(function (shade) { shade.remove(); });
      document.querySelectorAll(FACES).forEach(function (svg) {
        svg.style.removeProperty("--b-lean");
        var eyes = svg.querySelector(':scope > g[style*="animation-delay"]');
        if (eyes) eyes.style.removeProperty("translate");
        known.delete(svg);
      });
      faces = [];
    },
  });
})();
