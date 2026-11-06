// The motion language in code: springs written as CSS linear() curves, so a transition stays on the compositor and can be
// reversed mid-flight, plus the flight of a token from one place to another. MOTION.md has the reasoning.
(function () {
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  /**
   * Returns a critically-tuned spring as `linear()` easing and the time it needs to settle.
   * `stiffness` and `damping` follow the usual mass-spring model with a mass of 1.
   */
  function buildSpring(stiffness, damping) {
    var w = Math.sqrt(stiffness), z = damping / (2 * w), dt = 1 / 120;
    var x = 0, v = 0, t = 0, pts = [], quiet = 0;
    while (t < 2.5) {
      var a = stiffness * (1 - x) - damping * v;
      v += a * dt; x += v * dt; t += dt;
      pts.push(x);
      quiet = Math.abs(1 - x) < 0.0015 && Math.abs(v) < 0.02 ? quiet + 1 : 0;
      if (quiet > 6) break;
    }
    var step = Math.max(1, Math.round(pts.length / 40)), out = ['0'];
    for (var i = step; i < pts.length; i += step) out.push(pts[i].toFixed(4));
    out.push('1');
    return { ease: 'linear(' + out.join(', ') + ')', ms: Math.round(t * 1000), ratio: z };
  }

  // The shared springs of Work and the Inbox, as stiffness and damping at mass 1. SHARED.md has the table.
  var SPRINGS = {
    carry: buildSpring(900, 48),   // follows the pointer, a hair behind
    glide: buildSpring(420, 36),   // neighbours moving aside
    drop: buildSpring(520, 30),    // settling into a slot, slight overshoot
    return: buildSpring(300, 30),  // going home after a cancel
    open: buildSpring(260, 28),    // a card opening into its details
    fan: buildSpring(340, 26),     // a pile opening
    fold: buildSpring(300, 32),    // a pile closing
    bump: buildSpring(900, 28),    // a small acknowledgement
  };
  Object.keys(SPRINGS).forEach(function (k) {
    document.documentElement.style.setProperty('--spring-' + k, SPRINGS[k].ease);
  });

  /** Runs a Web Animation unless reduced motion is on, and returns a promise for its end. */
  function animate(el, keyframes, options) {
    if (reduced.matches) return Promise.resolve();
    var a = el.animate(keyframes, Object.assign({ fill: 'none' }, options));
    return a.finished.catch(function () {});
  }

  /** Flies a small token along an arc from one rectangle to another, then removes it. Returns a promise for its arrival. */
  function fly(html, from, to, options) {
    options = options || {};
    if (reduced.matches) return Promise.resolve();
    var el = document.createElement('div');
    el.className = 'flight';
    el.innerHTML = html;
    document.body.appendChild(el);
    var w = el.offsetWidth, h = el.offsetHeight;
    var x0 = from.left + from.width / 2 - w / 2, y0 = from.top + from.height / 2 - h / 2;
    var x1 = to.left + to.width / 2 - w / 2, y1 = to.top + to.height / 2 - h / 2;
    var lift = options.lift == null ? Math.min(90, Math.hypot(x1 - x0, y1 - y0) * 0.22) : options.lift;
    var frames = [], n = 24;
    for (var i = 0; i <= n; i++) {
      var t = i / n, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t - Math.sin(t * Math.PI) * lift;
      var s = 1 - 0.45 * t * t;
      frames.push({ transform: 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0) scale(' + s.toFixed(3) + ')', opacity: t > 0.92 ? (1 - t) / 0.08 : 1 });
    }
    var ms = options.ms || Math.max(420, Math.min(760, Math.hypot(x1 - x0, y1 - y0) * 0.75));
    return el.animate(frames, { duration: ms, easing: 'cubic-bezier(.45,.05,.2,1)', fill: 'forwards' }).finished.then(function () { el.remove(); });
  }

  window.Motion = { buildSpring: buildSpring, SPRINGS: SPRINGS, animate: animate, fly: fly, reduced: reduced };
})();
