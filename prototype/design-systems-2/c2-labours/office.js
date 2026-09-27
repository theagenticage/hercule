// PROTOTYPE - the Office: a sunlit courtyard where every live session sits as a colleague.
// Renders into <div data-office>. Plan coordinates: x runs along the colonnade (the right-hand back
// side), y along the aqueduct (the left-hand back side), z is height; one unit is one floor slab.
// ?state=swarm draws the courtyard at ten times today's load.
//
// The event flow layer - the Connections feeding the aqueduct, and its water falling into the
// Triage fountain - is always drawn, and CSS shows it only while html[data-flow="on"]. The page's
// switch therefore flips one attribute and never redraws the scene.
(function () {
  "use strict";
  var Crew = window.Crew;
  var W = 24;
  var D = 16;
  var H = 3; // the height of the colonnade and the aqueduct
  var DESK = 0.74; // desk top height
  var STOA = 5.2; // where the colonnade starts along the back wall
  var U = 32;
  var C = 0;
  var S = 0;
  var OX = 0;
  var OY = 0;

  /* ------------------------------------------------------------------ geometry */

  function P(x, y, z) {
    return [OX + (x - y) * C, OY + (x + y) * S - (z || 0) * U];
  }
  function f1(n) {
    return n.toFixed(1);
  }
  function f3(n) {
    return Number(n.toFixed(3));
  }
  function points(list) {
    return list
      .map(function (p) {
        return f1(p[0]) + "," + f1(p[1]);
      })
      .join(" ");
  }
  function quad(a, b, c, d, cls, style) {
    return '<polygon class="' + cls + '" points="' + points([a, b, c, d]) + '"' + (style ? ' style="' + style + '"' : "") + "/>";
  }
  function line(a, b) {
    return "M" + f1(a[0]) + " " + f1(a[1]) + "L" + f1(b[0]) + " " + f1(b[1]);
  }
  /** Returns an iso box: its two visible sides and its top, all shaded from one --c colour. */
  function box(x, y, z, w, d, h, color, cls) {
    return (
      '<g class="bx' + (cls ? " " + cls : "") + '" style="--c:' + color + '">' +
      quad(P(x, y + d, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x, y + d, z + h), "l") +
      quad(P(x + w, y, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x + w, y, z + h), "r") +
      quad(P(x, y, z + h), P(x + w, y, z + h), P(x + w, y + d, z + h), P(x, y + d, z + h), "t") +
      "</g>"
    );
  }
  function patch(x, y, w, d, cls, style) {
    return quad(P(x, y, 0), P(x + w, y, 0), P(x + w, y + d, 0), P(x, y + d, 0), cls, style);
  }
  /** Returns the ellipse a circle of plan radius r makes when it lies flat at (x, y, z). */
  function ellipse(x, y, z, r, cls, style) {
    var p = P(x, y, z);
    return '<ellipse class="' + cls + '" cx="' + f1(p[0]) + '" cy="' + f1(p[1]) + '" rx="' + f1(r * C * 1.414) + '" ry="' + f1(r * S * 1.414) + '"' + (style ? ' style="' + style + '"' : "") + "/>";
  }
  /** Returns an upright cylinder standing on (x, y, z): its rounded side and its top. */
  function cylinder(x, y, z, r, h, color, cls) {
    var b = P(x, y, z);
    var t = P(x, y, z + h);
    var rx = r * C * 1.414;
    var ry = r * S * 1.414;
    var side = "M" + f1(b[0] - rx) + " " + f1(t[1]) + "V" + f1(b[1]) + "A" + f1(rx) + " " + f1(ry) + " 0 0 0 " + f1(b[0] + rx) + " " + f1(b[1]) + "V" + f1(t[1]) + "Z";
    return (
      '<g class="cyl' + (cls ? " " + cls : "") + '" style="--c:' + color + '">' +
      '<path class="cyl-side" d="' + side + '"/><path class="cyl-shade" d="' + side + '"/>' +
      '<ellipse class="cyl-top" cx="' + f1(t[0]) + '" cy="' + f1(t[1]) + '" rx="' + f1(rx) + '" ry="' + f1(ry) + '"/></g>'
    );
  }
  function matrix(a, b, c, d, o) {
    return '<g transform="matrix(' + [a, b, c, d, o[0], o[1]].map(f3).join(" ") + ')">';
  }
  // Flat drawing planes. Local units are pixels, so U local px is one unit.
  function onFloor(x, y, inner) {
    return matrix(C / U, S / U, -C / U, S / U, P(x, y, 0)) + inner + "</g>";
  }
  function onBackWall(x, yPlane, z, inner) {
    // the plane y = const, seen from +y; local x runs along +x, local y runs down
    return matrix(C / U, S / U, 0, 1, P(x, yPlane, z)) + inner + "</g>";
  }
  function onSideWall(xPlane, y, z, inner) {
    // the plane x = const, seen from +x; local x runs along -y so text reads left to right
    return matrix(C / U, -S / U, 0, 1, P(xPlane, y, z)) + inner + "</g>";
  }

  /* ------------------------------------------------------------------ people and furniture */

  function spriteSize() {
    return Math.round(U * 1.52);
  }
  /** Returns a colleague sprite whose body bottom sits on plan point (x, y, z). */
  function sprite(name, pose, x, y, z, size) {
    var p = P(x, y, z);
    size = size || spriteSize();
    return '<g transform="translate(' + f1(p[0] - size / 2) + " " + f1(p[1] - size * 0.93) + ')">' + Crew.face(name, { pose: pose, size: size }) + "</g>";
  }
  function stool(x, y) {
    return box(x - 0.05, y - 0.05, 0, 0.1, 0.1, 0.4, "var(--court-leg)") + ellipse(x, y, 0.4, 0.3, "stool stool--side") + ellipse(x, y, 0.46, 0.3, "stool");
  }
  function mug(x, y, z) {
    return box(x, y, z, 0.2, 0.2, 0.22, "var(--court-desk)", "mug");
  }

  /**
   * Returns one colleague at their desk. The desk stands on the colleague's -x side with the
   * laptop screen facing them, so the viewer sees both the face and the screen. A working
   * colleague's screen shows lines in their own hue. A colleague who is queued at your desk leaves
   * an empty stool behind and a screen with the waiting mark on it.
   */
  function seat(s) {
    var hue = "--hue:var(--hue-" + Crew.lookFor(s.name).hue + ")";
    var x = s.x;
    var y = s.y;
    var lit = !s.away && s.pose === "working";
    var out = "";
    // a table: two trestles and a marble top
    out += box(x - 1.3, y - 0.48, 0, 0.76, 0.1, DESK, "var(--court-leg)");
    out += box(x - 1.3, y + 0.38, 0, 0.76, 0.1, DESK, "var(--court-leg)");
    out += box(x - 1.38, y - 0.56, DESK, 0.92, 1.12, 0.07, "var(--court-desk)", "desk");
    // the laptop: base on the table, lid standing on its far (-x) edge
    var bx = x - 1.14;
    var z = DESK + 0.07;
    var sw = 0.7 * U;
    var sh = 0.46 * U;
    var screen = '<rect width="' + f1(sw) + '" height="' + f1(sh) + '" rx="2.5" class="screen' + (lit ? " screen--lit" : s.away ? " screen--away" : "") + '" style="' + hue + '"/>';
    if (lit)
      screen += [0.2, 0.42, 0.64]
        .map(function (t, i) {
          return '<rect x="' + f1(sw * 0.14) + '" y="' + f1(sh * t) + '" width="' + f1(sw * [0.62, 0.4, 0.52][i]) + '" height="' + f1(sh * 0.1) + '" rx="1" class="code-line" style="' + hue + '"/>';
        })
        .join("");
    if (s.away) screen += '<circle cx="' + f1(sw / 2) + '" cy="' + f1(sh / 2) + '" r="' + f1(sh * 0.17) + '" class="screen-dot"/>';
    out += box(bx, y - 0.36, z, 0.54, 0.72, 0.035, "var(--court-metal)");
    out += box(bx - 0.03, y - 0.36, z, 0.03, 0.72, 0.5, "var(--court-metal)");
    out += onSideWall(bx, y + 0.35, z + 0.49, screen);
    if (s.mug) out += mug(x - 1.3, y + 0.14, z);
    out += stool(x, y);
    if (!s.away) out += sprite(s.name, s.pose, x, y, 0.46);
    return out;
  }

  /** Returns a potted olive tree: a terracotta pot, a crooked trunk and a silvery crown. */
  function olive(x, y) {
    var base = P(x, y, 0);
    var top = P(x, y, 0.6);
    var rb = 0.26 * C * 1.414;
    var rt = 0.38 * C * 1.414;
    var ryb = 0.26 * S * 1.414;
    var ryt = 0.38 * S * 1.414;
    var out = ellipse(x + 0.35, y + 0.2, 0, 0.9, "shadow");
    out += '<path class="pot" d="M' + f1(top[0] - rt) + " " + f1(top[1]) + "L" + f1(base[0] - rb) + " " + f1(base[1]) + "A" + f1(rb) + " " + f1(ryb) + " 0 0 0 " + f1(base[0] + rb) + " " + f1(base[1]) + "L" + f1(top[0] + rt) + " " + f1(top[1]) + 'Z"/>';
    out += '<ellipse class="pot-rim" cx="' + f1(top[0]) + '" cy="' + f1(top[1]) + '" rx="' + f1(rt) + '" ry="' + f1(ryt) + '"/>';
    out += '<ellipse class="soil" cx="' + f1(top[0]) + '" cy="' + f1(top[1] + 0.5) + '" rx="' + f1(rt * 0.8) + '" ry="' + f1(ryt * 0.72) + '"/>';
    var tx = top[0];
    var ty = top[1];
    out += '<path class="trunk" style="stroke-width:' + f1(U * 0.13) + '" d="M' + f1(tx) + " " + f1(ty) + "C" + f1(tx - U * 0.18) + " " + f1(ty - U * 0.5) + " " + f1(tx + U * 0.2) + " " + f1(ty - U * 0.8) + " " + f1(tx) + " " + f1(ty - U * 1.25) + '"/>';
    out += '<path class="trunk" style="stroke-width:' + f1(U * 0.07) + '" d="M' + f1(tx + U * 0.04) + " " + f1(ty - U * 0.7) + "Q" + f1(tx + U * 0.3) + " " + f1(ty - U * 0.9) + " " + f1(tx + U * 0.42) + " " + f1(ty - U * 1.2) + '"/>';
    var cy = ty - U * 1.75;
    [
      [-0.46, 0.12, 0.44, 0.3, 1],
      [0.44, 0.08, 0.46, 0.32, 1],
      [0, -0.2, 0.6, 0.4, 0],
      [-0.2, 0.26, 0.42, 0.28, 2],
      [0.26, 0.3, 0.4, 0.26, 2],
      [-0.12, -0.44, 0.34, 0.22, 2],
    ].forEach(function (l) {
      out += '<ellipse class="crown crown--' + l[4] + '" cx="' + f1(tx + l[0] * U) + '" cy="' + f1(cy + l[1] * U) + '" rx="' + f1(l[2] * U) + '" ry="' + f1(l[3] * U) + '"/>';
    });
    return out;
  }

  /** Returns a small cluster of amphorae standing on the floor; they hold a project's Tasks. */
  function amphorae(x, y) {
    var out = ellipse(x + 0.2, y + 0.2, 0, 0.55, "shadow");
    [
      [0, 0, 1],
      [0.42, -0.3, 0.86],
      [0.36, 0.34, 0.92],
    ].forEach(function (a) {
      var p = P(x + a[0], y + a[1], 0);
      var s = U * 1.05 * a[2];
      out +=
        '<g transform="translate(' + f1(p[0]) + " " + f1(p[1]) + ") scale(" + f3(s) + ')">' +
        '<path class="amphora" d="M-.1-1H.1V-.95H.065V-.82C.26-.8.31-.72.3-.6.29-.34.14-.14.08-.06V0H-.08V-.06C-.14-.14-.29-.34-.3-.6-.31-.72-.26-.8-.065-.82V-.95H-.1Z"/>' +
        '<path class="amphora-side" d="M.04-.81C.26-.79.31-.72.3-.6.29-.34.14-.14.08-.06V0H.04Z"/>' +
        '<path class="amphora-handle" d="M-.065-.92C-.24-.94-.27-.8-.21-.72M.065-.92C.24-.94.27-.8.21-.72"/>' +
        "</g>";
    });
    return out;
  }

  /**
   * Returns the exedra, a curved stone bench open towards the viewer, with the assistants on it.
   * Angles run in plan from the +x axis; the bench spans 135 to 315 degrees round the back.
   */
  function exedra(cx, cy, sitters) {
    var r1 = 1.2;
    var r2 = 1.72;
    var r3 = 1.94;
    var seatZ = 0.42;
    var backZ = 0.98;
    function at(r, deg, z) {
      var a = (deg * Math.PI) / 180;
      return P(cx + r * Math.cos(a), cy + r * Math.sin(a), z);
    }
    function ring(rIn, rOut, z) {
      var list = [];
      for (var d = 135; d <= 315; d += 10) list.push(at(rOut, d, z));
      for (d = 315; d >= 135; d -= 10) list.push(at(rIn, d, z));
      return list;
    }
    function face(r, z0, z1) {
      var out = "";
      for (var d = 135; d < 315; d += 10) out += quad(at(r, d, z0), at(r, d + 10, z0), at(r, d + 10, z1), at(r, d, z1), "ex-face");
      return out;
    }
    var out = ellipse(cx - 0.4, cy - 0.4, 0, 2.1, "shadow");
    // the backrest, then the seat in front of it, then each end
    out += face(r2, seatZ, backZ);
    out += '<polygon class="ex-top" points="' + points(ring(r2, r3, backZ)) + '"/>';
    out += '<polygon class="ex-top" points="' + points(ring(r1, r2, seatZ)) + '"/>';
    out += face(r1, 0, seatZ);
    [135, 315].forEach(function (d) {
      out += quad(at(r1, d, 0), at(r3, d, 0), at(r3, d, seatZ), at(r1, d, seatZ), "ex-end");
      out += quad(at(r2, d, seatZ), at(r3, d, seatZ), at(r3, d, backZ), at(r2, d, backZ), "ex-end");
    });
    sitters.forEach(function (s) {
      var a = (s.deg * Math.PI) / 180;
      var r = (r1 + r2) / 2;
      s.x = cx + r * Math.cos(a);
      s.y = cy + r * Math.sin(a);
      out += sprite(s.name, s.pose, s.x, s.y, seatZ);
    });
    return out;
  }

  /* ------------------------------------------------------------------ the courtyard */

  function courtFloor() {
    var out = box(0, 0, -0.5, W, D, 0.5, "var(--court-floor)", "slab");
    // Marble slabs two units square, laid in a quiet checker.
    for (var i = 0; i < W; i += 2) for (var j = 0; j < D; j += 2) if ((i + j) % 4 === 2) out += patch(i, j, 2, 2, "slab-alt");
    var joints = "";
    for (i = 2; i < W; i += 2) joints += line(P(i, 0, 0), P(i, D, 0));
    for (j = 2; j < D; j += 2) joints += line(P(0, j, 0), P(W, j, 0));
    return out + '<path class="joints" d="' + joints + '"/>';
  }

  /** Returns the plain back wall, with the knot and the wordmark above the fountain. */
  function backWall() {
    return (
      quad(P(0, 0, 0), P(W, 0, 0), P(W, 0, H), P(0, 0, H), "wall") +
      quad(P(STOA, 0, 0), P(W, 0, 0), P(W, 0, H), P(STOA, 0, H), "stoa-shade") +
      quad(P(-THICK, -0.4, H), P(W, -0.4, H), P(W, 0, H), P(-THICK, 0, H), "wall-top") +
      quad(P(W, -0.4, -0.5), P(W, 0, -0.5), P(W, 0, H), P(W, -0.4, H), "wall-end") +
      patch(0, 0, W, 0.5, "ao") +
      onBackWall(0.9, 0.01, 2.55, '<g style="--logo-ground:var(--court-wall)">' + Crew.logo(Math.round(U * 1.05)) + "</g>") +
      onBackWall(2.15, 0.01, 2.2, '<text class="wall-word" style="font-size:' + f1(U * 0.46) + 'px">Hercule</text>')
    );
  }

  var ARCHES = [5.6, 8.0, 10.4, 12.8, 15.2]; // arch centres along the aqueduct
  var ARCH = 0.78; // half an arch's span
  var SPRING = 1.55; // where each arch starts to curve
  var THICK = 0.5; // the aqueduct wall's thickness

  /**
   * Returns the aqueduct along the left-hand side: a wall pierced by arches, carrying a channel on
   * top. The event flow layer is woven in at the right depths:
   * - a feeder channel from each Connection, drawn before the main channel so the main channel
   *   hides the end of each feeder;
   * - water in the channels, and droplets travelling down them towards the fountain.
   * With the flow off, the channel bed is dry stone.
   */
  function aqueduct(sources, spoutY) {
    // The arches, in the wall's own plane: local x runs from the front end (y = D) backwards.
    var holes = ARCHES.map(function (yc) {
      var lx = (D - yc) * U;
      var a = ARCH * U;
      var spring = (H - SPRING) * U;
      return "M" + f1(lx - a) + " " + f1(H * U) + "V" + f1(spring) + "A" + f1(a) + " " + f1(a) + " 0 0 1 " + f1(lx + a) + " " + f1(spring) + "V" + f1(H * U) + "Z";
    }).join("");
    // Through each arch you see the sunlit outside, framed by the depth of the wall: the reveal
    // is the opening at the near face, the outside is the same opening at the far face.
    var out = onSideWall(0, D, H, '<path class="arch-reveal" d="' + holes + '"/>');
    out += onSideWall(-THICK, D, H, '<path class="arch-sky" d="' + holes + '"/>');
    out += onSideWall(0, D, H, '<path class="aq-face" fill-rule="evenodd" d="M0 0H' + f1(D * U) + "V" + f1(H * U) + "H0Z" + holes + '"/>');
    out += quad(P(-THICK, D, -0.5), P(0, D, -0.5), P(0, D, H), P(-THICK, D, H), "aq-end");
    out += patch(0, 0, 0.5, D, "ao");

    var feeders = "";
    var water = "";
    var drops = "";
    sources.forEach(function (src) {
      feeders += box(-1.3, src.y - 0.12, H + 0.08, 0.68, 0.24, 0.16, "var(--court-stone)", "feeder");
      water += quad(P(-1.26, src.y - 0.055, H + 0.24), P(-0.62, src.y - 0.055, H + 0.24), P(-0.62, src.y + 0.055, H + 0.24), P(-1.26, src.y + 0.055, H + 0.24), "water");
      drops += drop(-1.1, src.y, H + 0.24, 0.4, 0, "drop drop--in");
    });
    out += '<g class="flow">' + feeders + "</g>";
    out += box(-THICK - 0.12, 0, H, THICK + 0.24, D, 0.26, "var(--court-stone)", "specus");
    out += quad(P(-THICK + 0.02, 0.1, H + 0.26), P(0, 0.1, H + 0.26), P(0, D - 0.12, H + 0.26), P(-THICK + 0.02, D - 0.12, H + 0.26), "specus-bed");
    // Droplets run down the channel to the spout. Each drifts exactly one gap before the
    // animation repeats, so the stream moves without any droplet jumping.
    var last = sources[sources.length - 1].y;
    water += quad(P(-THICK + 0.08, spoutY, H + 0.265), P(-0.06, spoutY, H + 0.265), P(-0.06, last + 0.06, H + 0.265), P(-THICK + 0.08, last + 0.06, H + 0.265), "water");
    for (var y = last; y > spoutY + 0.2; y -= 0.56) drops += drop(-THICK / 2 + 0.01, y, H + 0.27, 0, -0.56, "drop");
    out += '<g class="flow">' + water + drops + "</g>";
    // The spout that fills the fountain juts from a stone plate, which ties it to the wall; a spout
    // alone reads as a slab floating in front of the pale wall.
    out += box(0, spoutY - 0.34, 1.7, 0.08, 0.68, 0.62, "var(--court-stone)");
    out += quad(P(0.08, spoutY - 0.12, 1.96), P(0.08, spoutY + 0.12, 1.96), P(0.08, spoutY + 0.2, 1.84), P(0.08, spoutY - 0.04, 1.84), "shadow");
    out += box(0.08, spoutY - 0.12, 1.96, 0.66, 0.24, 0.14, "var(--court-stone)");
    return out;
  }
  function drop(x, y, z, dx, dy, cls) {
    var p = P(x, y, z);
    var q = P(x + dx, y + dy, z);
    return '<ellipse class="' + cls + '" cx="' + f1(p[0]) + '" cy="' + f1(p[1]) + '" rx="' + f1(U * 0.075) + '" ry="' + f1(U * 0.05) + '" style="--dx:' + f1(q[0] - p[0]) + "px;--dy:" + f1(q[1] - p[1]) + 'px"/>';
  }

  /**
   * Returns the Triage fountain: a round marble basin with a small bowl on a pedestal. With the
   * event flow on, water falls from the aqueduct's spout at (spoutX, cy) into the basin.
   */
  function fountain(cx, cy, spoutX) {
    var tip = P(spoutX, cy, 1.96);
    var fall = P(spoutX, cy, 0.43);
    return (
      ellipse(cx + 0.3, cy + 0.2, 0, 1.3, "shadow") +
      cylinder(cx, cy, 0, 1.15, 0.42, "var(--court-stone)") +
      ellipse(cx, cy, 0.42, 0.96, "basin-water") +
      '<g class="flow"><path class="stream" style="stroke-width:' + f1(U * 0.07) + '" d="' + line(tip, fall) + '"/>' +
      ellipse(spoutX, cy, 0.43, 0.16, "ripple") + ellipse(spoutX, cy, 0.43, 0.3, "ripple ripple--2") + "</g>" +
      cylinder(cx, cy, 0.42, 0.14, 0.5, "var(--court-stone)") +
      cylinder(cx, cy, 0.92, 0.4, 0.1, "var(--court-stone)") +
      ellipse(cx, cy, 1.02, 0.31, "basin-water")
    );
  }

  /**
   * Returns the colonnade along the back wall: one wing per runner, one bay per slot. A banner in
   * the colleague's hue hangs in every bay whose slot is taken, so a full wing is a full machine.
   */
  function stoa(wings) {
    var end = W - 0.4;
    var pier = wings.length > 3 ? 0.36 : 0.56;
    var bays = wings.reduce(function (n, w) {
      return n + w.bays;
    }, 0);
    var bay = (end - STOA - pier * (wings.length + 1)) / bays;
    var yc = 1.3; // the column line
    var r = Math.min(0.13, bay * 0.19);
    var zCap = 2.5;
    var zBeam = 2.62;
    var out = box(STOA - 0.1, 0, 0, end - STOA + 0.2, yc + 0.34, 0.12, "var(--court-stone)", "step");
    var x = STOA;
    var banners = "";
    var columns = "";
    wings.forEach(function (wing) {
      columns += box(x, yc - 0.2, 0.12, pier, 0.4, zBeam - 0.12, "var(--court-stone)", "pier");
      x += pier;
      wing.x0 = x;
      for (var i = 0; i < wing.bays; i++) {
        if (wing.hues[i]) banners += banner(x + (i + 0.5) * bay, yc, wing.hues[i], bay, zBeam);
        if (i > 0) columns += column(x + i * bay, yc, r, zCap);
      }
      x += wing.bays * bay;
      wing.x1 = x;
    });
    columns += box(x, yc - 0.2, 0.12, pier, 0.4, zBeam - 0.12, "var(--court-stone)", "pier");
    out += banners + columns;
    out += box(STOA - 0.1, yc - 0.32, zBeam, end - STOA + 0.2, 0.64, H - zBeam, "var(--court-stone)", "beam");
    // a terracotta roof from the wall to the columns, its tiles running front to back
    var zt = H + 0.18;
    out += box(STOA - 0.2, -0.45, H, end - STOA + 0.4, yc + 0.85, 0.18, "var(--court-roof)", "roof");
    var tiles = "";
    for (var t = STOA + 0.1; t < end + 0.1; t += 0.3) tiles += line(P(t, -0.45, zt), P(t, yc + 0.4, zt));
    return out + '<path class="tiles" d="' + tiles + '"/>';
  }
  function banner(xc, yPlane, hue, bay, zTop) {
    var w = Math.min(0.4, bay * 0.52) * U;
    var h = 1.1 * U;
    var notch = 0.16 * U;
    return onBackWall(xc - w / 2 / U, yPlane, zTop, '<path class="banner" style="--hue:var(--hue-' + hue + ')" d="M0 0H' + f1(w) + "V" + f1(h) + "L" + f1(w / 2) + " " + f1(h - notch) + "L0 " + f1(h) + 'Z"/>');
  }
  function column(x, y, r, zCap) {
    return (
      box(x - r * 1.35, y - r * 1.35, 0.12, r * 2.7, r * 2.7, 0.1, "var(--court-stone)", "plinth") +
      cylinder(x, y, 0.22, r, zCap - 0.22, "var(--court-stone)") +
      box(x - r * 1.5, y - r * 1.5, zCap, r * 3, r * 3, 0.12, "var(--court-stone)", "capital")
    );
  }

  /* ------------------------------------------------------------------ what lives in the courtyard */

  // Each project works in its own area of the courtyard, set off by a mosaic border in its colour.
  // A cluster of amphorae in a free corner holds the project's Tasks. The project's name and its
  // Tasks count are inscribed in the floor at `at`, on a strip that no name tag hangs over: the
  // back desk nearest each inscription is the one whose colleague is queued at your desk.
  var AREAS = [
    { x: 5.4, y: 3.2, w: 7.0, d: 9.0, proj: "webshop", label: "webshop", at: [5.6, 2.6], jars: [8.6, 11.2] },
    { x: 13.2, y: 3.2, w: 6.6, d: 9.0, proj: "payments", label: "payments-api", at: [14.5, 2.4], jars: [13.8, 11.4] },
    { x: 11.8, y: 12.5, w: 9.6, d: 3.1, proj: "ops", label: "ops", at: [12.4, 15.2], jars: [12.2, 13.6] },
  ];
  // The second desk of each row sits a little further forward, so no two name tags share a line.
  var SPOTS = [
    [7.8, 4.8], [11.1, 6.0], [7.8, 7.6], [11.1, 8.8], [7.8, 10.4], [11.1, 11.6], // webshop
    [15.6, 4.8], [18.9, 6.0], [15.6, 7.6], [18.9, 8.8], [15.6, 10.4], // payments-api
    [14.6, 14.0], [17.6, 14.0], [20.6, 14.0], // ops
  ];
  function place(list) {
    return list.map(function (s, i) {
      s.x = SPOTS[i][0];
      s.y = SPOTS[i][1];
      return s;
    });
  }
  // The hues of the sessions a runner hosts, one per taken slot.
  function huesFor(names) {
    return names.map(function (n) {
      return Crew.lookFor(n).hue;
    });
  }
  // The Connections that feed Triage, the biggest nearest the fountain.
  var SOURCES = ["sentry", "github", "gmail", "stripe", "intercom", "posthog", "grafana", "cron"];
  function sourcesWith(counts) {
    return SOURCES.map(function (key, i) {
      return { key: key, count: counts[i], y: 3.6 + i * 1.6 };
    });
  }

  var TODAY = {
    waiting: "3 waiting on you",
    wings: [
      { name: "studio-mac", bays: 6, slots: 6, used: 5, hues: huesFor(["Fix 3-D Secure checkout for EU cards", "Read the Stripe v14 changelog", "Migrate ops dashboards", "Ada", "Milo"]) },
      { name: "build-box-1", bays: 8, slots: 8, used: 8, hues: huesFor(["Investigate backup timeouts", "Refactor cart totals", "Webhook retry backoff", "Cart total rounding on discounts", "Payout report for September", "Rotate staging secrets", "Tidy checkout CSS", "Label new issues"]) },
      { name: "build-box-2", bays: 8, slots: 8, used: 3, hues: huesFor(["Ship release v2.15", "Add iDEAL research", "Draft reply to Jonas at Kiteworks"]) },
    ],
    triage: { calm: "next 11:00", flow: "212 events since 18:20" },
    sources: sourcesWith(["130", "38", "17", "12", "9", "3", "2", "1"]),
    tasks: { webshop: "10 Tasks", payments: "8 Tasks", ops: "5 Tasks" },
    seats: place([
      { name: "Fix 3-D Secure checkout for EU cards", away: true },
      { name: "Read the Stripe v14 changelog", pose: "idle", tag: "idle 20m" },
      { name: "Refactor cart totals", pose: "working", tag: "22m" },
      { name: "Cart total rounding on discounts", pose: "working", tag: "14m" },
      { name: "Label new issues", pose: "paused", tag: "paused" },
      { name: "Tidy checkout CSS", pose: "idle", tag: "idle 2h", mug: true },
      { name: "Ship release v2.15", away: true },
      { name: "Payout report for September", pose: "working", tag: "9m" },
      { name: "Webhook retry backoff", pose: "working", tag: "3m" },
      { name: "Draft reply to Jonas at Kiteworks", pose: "working", tag: "1m" },
      { name: "Add iDEAL research", pose: "idle", tag: "idle 1h", mug: true },
      { name: "Investigate backup timeouts", pose: "working", tag: "6m" },
      { name: "Rotate staging secrets", pose: "working", tag: "11m" },
      { name: "Migrate ops dashboards", away: true },
    ]),
    assistants: [
      { name: "Milo", pose: "idle", deg: 172 },
      { name: "Ada", pose: "working", deg: 222 },
      { name: "Juno", pose: "asleep", deg: 276 },
    ],
    assistantsTag: "<b>Milo</b><span>idle</span><b>Ada</b><span>working</span><b>Juno</b><span>asleep</span>",
    queue: [
      { name: "Fix 3-D Secure checkout for EU cards", ask: "Run git push?" },
      { name: "Migrate ops dashboards" },
      { name: "Ship release v2.15" },
    ],
  };

  // At 10x the courtyard keeps its shape. Each desk seats a group - a workflow's runs or a
  // project's threads - with a head count, each machine is a narrow wing whose banners show how
  // full it is, and the queue at your desk folds into a "+7 more" sign.
  // Each of the nine machines is a wing of four bays. A bay's banner goes up only once a whole
  // quarter of the machine is taken, so only a machine at its cap shows a full wing.
  var SWARM_HUES = ["sky", "iris", "teal", "orchid", "peach", "mint", "grape"];
  function buildSwarmWings(machines) {
    return machines.map(function (m, i) {
      var hues = [];
      for (var b = 0; b < Math.floor((m[0] / m[1]) * 4); b++) hues.push(SWARM_HUES[(i * 3 + b) % SWARM_HUES.length]);
      return { bays: 4, hues: hues };
    });
  }
  var SWARM = {
    waiting: "10 waiting on you",
    // [taken, slots] per machine: 131 of 150 slots, two machines at cap
    wings: buildSwarmWings([[5, 6], [18, 18], [14, 18], [12, 18], [18, 18], [16, 18], [15, 18], [17, 18], [16, 18]]),
    wingsTag: "<b>9 machines</b><span>131 of 150 slots · 2 at cap</span>",
    triage: { calm: "60 Proposals since 07:00", flow: "2,120 events since 18:20" },
    sources: sourcesWith(["1.3k", "380", "170", "120", "90", "30", "20", "10"]),
    tasks: { webshop: "84 Tasks", payments: "61 Tasks", ops: "35 Tasks" },
    // 69 working, 2 paused and 56 idle at the desks; the other 10 queue at yours, and the three at
    // its head leave their own desks empty, as they do today. The bar counts the assistants too,
    // as it does today: with the working one and the two idle ones it shows 70 working and 58 idle.
    seats: place([
      { name: "Fix 3-D Secure checkout for EU cards", away: true },
      { name: "Label new issues", pose: "working", tag: "×10" },
      { name: "Refactor cart totals", label: "Threads", pose: "working", tag: "×14" },
      { name: "Investigate", pose: "working", tag: "×8" },
      { name: "Label new issues", pose: "paused", tag: "×2 paused" },
      { name: "Tidy checkout CSS", label: "Threads", pose: "idle", tag: "×20 idle" },
      { name: "Ship release v2.15", away: true },
      { name: "Draft reply", pose: "working", tag: "×9" },
      { name: "Ship release", pose: "working", tag: "×3" },
      { name: "Fix bug", pose: "working", tag: "×15" },
      { name: "Add iDEAL research", label: "Threads", pose: "idle", tag: "×21 idle" },
      { name: "Investigate backup timeouts", label: "Investigate", pose: "working", tag: "×10" },
      { name: "Rotate staging secrets", label: "Threads", pose: "idle", tag: "×15 idle" },
      { name: "Migrate ops dashboards", away: true },
    ]),
    assistants: TODAY.assistants,
    assistantsTag: "<b>4 assistants</b><span>1 working · 2 idle · 1 asleep</span>",
    queue: TODAY.queue,
    queueMore: 7,
  };

  /* ------------------------------------------------------------------ assembly */

  function build(host) {
    var swarm = document.documentElement.dataset.state === "swarm";
    var data = swarm ? SWARM : TODAY;
    var rect = host.getBoundingClientRect();
    var sw = rect.width;
    var sh = rect.height;
    // Fit the courtyard to the stage, leaving air above the roofs for the labels.
    var span = W + D;
    var above = H + 1.5;
    U = Math.min(36, (sw - 120) / (span * 0.8660254), (sh - 64) / (span * 0.5 + above + 0.5));
    C = U * 0.8660254;
    S = U * 0.5;
    OX = sw / 2 + ((D - W) * C) / 2 + U * 0.6;
    OY = (sh - (span * S + (above + 0.5) * U)) / 2 + above * U + 8;

    var items = [];
    function add(key, svg) {
      items.push({ k: key, svg: svg });
    }
    var tags = [];
    function tag(x, y, z, html, cls) {
      var p = P(x, y, z);
      tags.push('<div class="tag' + (cls ? " " + cls : "") + '" style="left:' + f1(p[0]) + "px;top:" + f1(p[1]) + 'px">' + html + "</div>");
    }
    // A seated colleague's name tag hangs beside their face, on the right. Above the head it would
    // cover the face of whoever sits one desk further back; beside the face it only meets the
    // colleague to the right, whose face is higher up the picture.
    function nameTag(x, y, html, cls) {
      tag(x + 0.4, y - 0.4, 1.12, html, "tag--side" + (cls ? " " + cls : ""));
    }
    var fountainAt = [1.45, 2.6];

    var back = courtFloor() + backWall() + stoa(data.wings) + aqueduct(data.sources, fountainAt[1]);
    if (data.wingsTag) tag((STOA + W) / 2, 0.4, H + 0.36, data.wingsTag, "tag--wing");
    else
      data.wings.forEach(function (w) {
        var full = w.used === w.slots;
        tag((w.x0 + w.x1) / 2, 0.4, H + 0.36, "<b>" + w.name + "</b><span" + (full ? ' class="cap"' : "") + ">" + w.used + " of " + w.slots + (full ? " · at cap" : "") + "</span>", "tag--wing");
      });
    data.sources.forEach(function (src) {
      tag(-1.8, src.y, H + 0.42, Crew.brand(src.key, 12) + "<span>" + src.count + "</span>", "tag--src flow");
    });

    // the project areas, laid into the floor, each with its Tasks in amphorae
    var floor = AREAS.map(function (a) {
      add(a.jars[0] + a.jars[1], amphorae(a.jars[0], a.jars[1]));
      return (
        patch(a.x, a.y, a.w, a.d, "area", "--tessera:var(--proj-" + a.proj + ")") +
        patch(a.x + 0.16, a.y + 0.16, a.w - 0.32, a.d - 0.32, "area-edge", "--tessera:var(--proj-" + a.proj + ")") +
        onFloor(a.at[0], a.at[1], '<text class="inscription" style="font-size:' + f1(U * 0.36) + 'px">' + a.label + '<tspan class="inscription-tasks" x="0" dy="1.2em">' + data.tasks[a.proj] + "</tspan></text>")
      );
    }).join("");
    // the spot beside your desk where colleagues queue
    floor += onFloor(5.7, 15.45, '<text class="inscription inscription--you" style="font-size:' + f1(U * 0.4) + 'px">' + data.waiting + "</text>");

    // the Triage fountain in the corner, with Triage at its sorting table
    add(fountainAt[0] + fountainAt[1], fountain(fountainAt[0], fountainAt[1], 0.7));
    // Triage runs on a schedule, so between runs it sits idle; it is not one of the live sessions.
    add(4.3 + 4.4, seat({ name: "Triage", pose: "idle", x: 4.3, y: 4.4 }));
    nameTag(4.3, 4.4, "<b>Triage</b><span class=\"calm\">" + data.triage.calm + '</span><span class="flow">' + data.triage.flow + "</span>", "tag--quiet");

    // desks in the project areas
    data.seats.forEach(function (s) {
      add(s.x + s.y, seat(s));
      if (s.tag) nameTag(s.x, s.y, "<b>" + (s.label || s.name) + "</b><span>" + s.tag + "</span>", s.pose === "working" ? "" : "tag--quiet");
    });

    // the assistants on the exedra, with its back to the aqueduct
    var ex = [2.7, 8.2];
    add(ex[0] + ex[1] - 1, exedra(ex[0], ex[1], data.assistants));
    // The bench curves across the line of sight, so its sitters share one tag instead of three.
    // The tag stands on the floor inside the curve, below their feet, where nothing else is.
    tag(ex[0], ex[1], 0, data.assistantsTag, "tag--bench");

    // olive trees in terracotta pots
    add(1.0 + 15.0 + 0.5, olive(1.0, 15.0));
    add(23.3 + 14.2 + 0.5, olive(23.3, 14.2));

    // your desk, and the queue of colleagues waiting beside it
    add(
      3.2 + 12.2,
      box(3.12, 11.72, 0, 0.16, 0.16, 0.42, "var(--court-leg)") +
        box(2.7, 11.62, 0.42, 1.0, 0.86, 0.12, "var(--court-wood)", "chair") +
        box(2.72, 11.46, 0.5, 0.96, 0.14, 0.9, "var(--court-wood)", "chair"),
    );
    add(
      2.2 + 13.9 + 0.1,
      box(2.1, 12.72, 0, 0.14, 1.1, DESK, "var(--court-leg)") +
        box(4.46, 12.72, 0, 0.14, 1.1, DESK, "var(--court-leg)") +
        box(1.9, 12.66, DESK, 2.8, 1.24, 0.07, "var(--court-desk)", "desk") +
        box(2.8, 13.05, DESK + 0.07, 0.8, 0.54, 0.035, "var(--court-metal)") +
        quad(P(2.8, 13.59, DESK + 0.1), P(3.6, 13.59, DESK + 0.1), P(3.6, 13.66, DESK + 0.62), P(2.8, 13.66, DESK + 0.62), "lid") +
        mug(4.05, 13.2, DESK + 0.07) +
        box(2.1, 12.95, DESK + 0.07, 0.42, 0.56, 0.05, "var(--court-desk)", "paper"),
    );
    tag(3.3, 12.9, 1.75, Crew.you(16) + "<b>Your desk</b>", "tag--desk");
    data.queue.forEach(function (q, i) {
      var x = 6.2 + i * 1.6;
      var y = 13.6;
      add(x + y, ellipse(x, y, 0, 0.36, "shadow") + sprite(q.name, "waiting", x, y, 0));
      // only the head of the queue speaks; the others raise a hand and wait their turn
      tag(x, y, (spriteSize() * 0.95) / U, i === 0 ? q.ask : "?", i === 0 ? "tag--ask is-first" : "tag--ask tag--wait");
    });
    if (data.queueMore) tag(6.2 + data.queue.length * 1.6 - 0.1, 13.9, 0.2, "+" + data.queueMore + " more", "tag--more");

    items.sort(function (a, b) {
      return a.k - b.k;
    });

    host.innerHTML =
      '<svg class="floor" width="' + sw + '" height="' + sh + '" viewBox="0 0 ' + sw + " " + sh + '" role="img" aria-label="The Office: a courtyard where every live session sits as a colleague">' +
      '<defs><linearGradient id="office-cyl" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/><stop offset="1" style="stop-color:var(--court-shade)" stop-opacity=".32"/></linearGradient></defs>' +
      back +
      floor +
      items
        .map(function (it) {
          return it.svg;
        })
        .join("") +
      "</svg>" +
      '<div class="tags">' + tags.join("") + "</div>";
  }

  function boot() {
    // The List view hides the stage, so the scene is drawn whenever the stage has a size:
    // on first show and after every resize.
    document.querySelectorAll("[data-office]").forEach(function (host) {
      new ResizeObserver(function () {
        if (host.clientWidth > 0 && host.clientHeight > 0) build(host);
      }).observe(host);
    });
    // the 10x courtyard also swaps the head counts in the bar and the queue card
    if (document.documentElement.dataset.state === "swarm") {
      document.querySelectorAll("[data-swarm]").forEach(function (el) {
        el.textContent = el.dataset.swarm;
      });
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
