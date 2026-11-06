// Additions to the shared motion kernel (vendor/motion.js). The kernel moves things on real springs. These are for what it
// does not do: CSS curves built from the same springs, one-shot Web Animations, and the flight of a token across the window.
(function () {
  var M = window.Motion;

  /** Returns a spring as `linear()` easing, and the time it takes to settle. */
  function buildCurve(k, c) {
    var dt = 1 / 120, x = 0, v = 0, t = 0, pts = [], quiet = 0;
    while (t < 2.5) {
      v += (k * (1 - x) - c * v) * dt;
      x += v * dt;
      t += dt;
      pts.push(x);
      quiet = Math.abs(1 - x) < 0.0015 && Math.abs(v) < 0.02 ? quiet + 1 : 0;
      if (quiet > 6) break;
    }
    var step = Math.max(1, Math.round(pts.length / 40)), out = ['0'];
    for (var i = step; i < pts.length; i += step) out.push(pts[i].toFixed(4));
    out.push('1');
    return { ease: 'linear(' + out.join(', ') + ')', ms: Math.round(t * 1000) };
  }

  var curves = {};
  Object.keys(M.SPRINGS).forEach(function (name) {
    curves[name] = buildCurve(M.SPRINGS[name].k, M.SPRINGS[name].c);
    document.documentElement.style.setProperty('--spring-' + name, curves[name].ease);
  });

  /** Runs a one-shot Web Animation unless reduced motion is on. Returns a promise for its end. */
  function animate(el, keyframes, options) {
    if (M.isReduced()) return Promise.resolve();
    return el.animate(keyframes, Object.assign({ fill: 'none' }, options)).finished.catch(function () {});
  }

  /** Flies a small token along an arc from one rectangle to another, then removes it. Returns a promise for its arrival. */
  function fly(html, from, to, options) {
    options = options || {};
    if (M.isReduced()) return Promise.resolve();
    var el = document.createElement('div');
    el.className = 'flight';
    el.innerHTML = html;
    document.body.appendChild(el);
    var w = el.offsetWidth, h = el.offsetHeight;
    var x0 = from.left + from.width / 2 - w / 2, y0 = from.top + from.height / 2 - h / 2;
    var x1 = to.left + to.width / 2 - w / 2, y1 = to.top + to.height / 2 - h / 2;
    var dist = Math.hypot(x1 - x0, y1 - y0);
    var lift = options.lift == null ? Math.min(90, dist * 0.22) : options.lift;
    var frames = [], n = 24;
    for (var i = 0; i <= n; i++) {
      var t = i / n, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t - Math.sin(t * Math.PI) * lift;
      // A mark going home grows back to its size; one leaving shrinks towards where it lands. It stays solid until contact.
      var scale = options.grow ? 0.55 + 0.45 * t * t : 1 - 0.45 * t * t;
      frames.push({ transform: 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0) scale(' + scale.toFixed(3) + ')', opacity: t > 0.97 ? (1 - t) / 0.03 : 1 });
    }
    var ms = options.ms || Math.max(420, Math.min(760, dist * 0.75));
    return el.animate(frames, { duration: ms, easing: 'cubic-bezier(.3,0,.8,.7)', fill: 'forwards' }).finished.then(function () { el.remove(); });
  }

  /** Gives a body one knock: it is sent downward at this speed and comes back to rest by itself, so the move peaks at once. */
  function knock(el, speed) {
    if (M.isReduced()) return;
    var b = M.body(el);
    b.to({ y: 0 }, 'hand');
    b.speed.y = speed;
  }

  M.curve = function (name) { return curves[name]; };
  M.knock = knock;
  M.animate = animate;
  M.fly = fly;
})();
