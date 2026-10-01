// PROTOTYPE - the Office: an Art Deco bureau where every live session sits as a colleague.
// Renders into <div data-office>. Plan coordinates: x runs along the right-hand back wall, y along
// the left-hand back wall, z is height; one unit is one floor tile.
//
// How the floor reads:
// - Each runner is a wing with one desk per slot, so a wing without an empty desk is at its cap.
// - A colleague waiting on you leaves a marigold note on their desk and queues at yours.
// - The Triage clerk works in the back corner, under the brass plaques of the Connections, beside
//   the case board where it pins what it found and threads each Proposal to what it was made from.
// - html[data-flow="on"] adds the event flow: pneumatic tubes from each Connection into the Triage
//   desk, with capsules travelling in them. The scene always draws the layer; CSS shows or hides it.
// - ?state=swarm draws the 10x floor: the same rooms, with a head count on every desk.
(function () {
  "use strict";
  var Crew = window.Crew;
  var W = 24;
  var D = 18.6;
  var H = 3.2; // wall height
  var DESK = 0.74; // desk top height
  var TOP = DESK + 0.06; // the writing surface, above the brass edge
  var U = 32; // one floor tile in pixels, fitted to the stage on every draw
  var C = 0;
  var S = 0;
  var OX = 0;
  var OY = 0;
  var drawCount = 0;

  /* ------------------------------------------------------------------ geometry */

  function P(x, y, z) {
    return [OX + (x - y) * C, OY + (x + y) * S - (z || 0) * U];
  }
  function points(list) {
    return list
      .map(function (p) {
        return p[0].toFixed(1) + "," + p[1].toFixed(1);
      })
      .join(" ");
  }
  function quad(a, b, c, d, cls, style) {
    return '<polygon class="' + cls + '" points="' + points([a, b, c, d]) + '"' + (style ? ' style="' + style + '"' : "") + "/>";
  }
  /** Returns an iso box: its two visible sides and its top, all shaded from one --c color. */
  function box(x, y, z, w, d, h, color, cls) {
    return (
      '<g class="bx' + (cls ? " " + cls : "") + '" style="--c:' + color + '">' +
      quad(P(x, y + d, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x, y + d, z + h), "l") +
      quad(P(x + w, y, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x + w, y, z + h), "r") +
      quad(P(x, y, z + h), P(x + w, y, z + h), P(x + w, y + d, z + h), P(x, y + d, z + h), "t") +
      "</g>"
    );
  }
  /** Returns a flat rectangle lying at height z (the floor by default). */
  function patch(x, y, w, d, cls, style, z) {
    return quad(P(x, y, z), P(x + w, y, z), P(x + w, y + d, z), P(x, y + d, z), cls, style);
  }
  function ellipse(x, y, z, r, cls, style) {
    var p = P(x, y, z);
    return '<ellipse class="' + cls + '" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" rx="' + (r * C * 1.414).toFixed(1) + '" ry="' + (r * S * 1.414).toFixed(1) + '"' + (style ? ' style="' + style + '"' : "") + "/>";
  }
  function f3(n) {
    return Number(n.toFixed(3));
  }
  function matrix(a, b, c, d, o) {
    return '<g transform="matrix(' + [a, b, c, d, o[0], o[1]].map(f3).join(" ") + ')">';
  }
  // Flat drawing planes. Local units are pixels, so U local pixels are one tile.
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
  function n1(v) {
    return v.toFixed(1);
  }

  /* ------------------------------------------------------------------ small furniture */

  function spriteSize() {
    return Math.round(U * 1.52);
  }
  /** Returns a colleague sprite whose body bottom sits on plan point (x, y, z). */
  function sprite(name, pose, x, y, z) {
    var p = P(x, y, z);
    var size = spriteSize();
    return '<g transform="translate(' + n1(p[0] - size / 2) + " " + n1(p[1] - size * 0.93) + ')">' + Crew.face(name, { pose: pose, size: size }) + "</g>";
  }
  function stool(x, y) {
    return box(x - 0.04, y - 0.04, 0, 0.08, 0.08, 0.38, "var(--brass)", "brass") + ellipse(x, y, 0.36, 0.3, "cushion cushion--side") + ellipse(x, y, 0.42, 0.3, "cushion");
  }
  /** Returns a banker's lamp: a brass foot and stem under a green glass shade, lit or dark. */
  function lamp(x, y, z, lit) {
    return (
      ellipse(x, y, z, 0.1, "lamp-foot") +
      box(x - 0.02, y - 0.02, z, 0.04, 0.04, 0.32, "var(--brass)", "brass") +
      box(x - 0.12, y - 0.22, z + 0.3, 0.24, 0.44, 0.09, lit ? "var(--lamp-on)" : "var(--room-lamp)", "shade")
    );
  }
  function cup(x, y, z) {
    return ellipse(x, y, z, 0.12, "saucer") + box(x - 0.055, y - 0.055, z, 0.11, 0.11, 0.1, "var(--room-paper)", "cup");
  }
  /** Returns a leaf-shaped path from p, pointing at angle a (degrees, 0 = right, -90 = up). */
  function leaf(p, a, len, width, cls) {
    var r = (a * Math.PI) / 180;
    var ex = p[0] + Math.cos(r) * len;
    var ey = p[1] + Math.sin(r) * len + len * 0.18; // fronds droop at the tip
    var mx = (p[0] + ex) / 2;
    var my = (p[1] + ey) / 2 - len * 0.12;
    var nx = -Math.sin(r) * width;
    var ny = Math.cos(r) * width;
    return '<path class="' + cls + '" d="M' + n1(p[0]) + " " + n1(p[1]) + "Q" + n1(mx + nx) + " " + n1(my + ny) + " " + n1(ex) + " " + n1(ey) + "Q" + n1(mx - nx) + " " + n1(my - ny) + " " + n1(p[0]) + " " + n1(p[1]) + 'Z"/>';
  }
  /** Returns a palm in a lacquered planter with a brass band. */
  function palm(x, y, tall) {
    var z = tall ? 0.72 : 0.42;
    var top = P(x + 0.28, y + 0.28, z);
    var L = U * (tall ? 1.05 : 0.7);
    var fronds = [
      [-168, 0.9, 1],
      [-12, 0.9, 1],
      [-140, 1, 2],
      [-40, 1, 2],
      [-112, 1.05, 0],
      [-68, 1.05, 0],
      [-90, 0.8, 1],
    ]
      .map(function (f) {
        return leaf(top, f[0], L * f[1], L * 0.16, "leaf leaf--" + f[2]);
      })
      .join("");
    return (
      ellipse(x + 0.28, y + 0.28, 0, 0.42, "shadow") +
      box(x, y, 0, 0.56, 0.56, z, "var(--room-inlay-2)", "planter") +
      box(x - 0.02, y - 0.02, z - 0.12, 0.6, 0.6, 0.06, "var(--brass)", "brass") +
      fronds
    );
  }

  /* ------------------------------------------------------------------ desks */

  /**
   * Returns one desk and whoever works at it. The desk stands on the colleague's -x side, so the
   * viewer sees the face with the desk behind it. What lies on the desk follows the session:
   * - working: the green lamp is lit, papers on the blotter
   * - idle or paused: the lamp is dark; an idle colleague has a cup of tisane
   * - away: the colleague is queued at your desk; the lamp stays lit and a marigold note waits
   * The blotter carries the project's tint, so projects read without a label.
   * A vacant slot on the runner is only an inlaid outline in the floor: room for one more.
   * An empty desk is set out with its lamp dark and nobody at it: the first run's wing before
   * anyone has started a thread.
   * extra - markup drawn on the desk in place of the lamp (the Triage desk's tube receiver).
   */
  function desk(s, extra) {
    var x = s.x;
    var y = s.y;
    var x0 = x - 1.42;
    var y0 = y - 0.6;
    if (s.vacant) return patch(x0, y0, 0.96, 1.2, "free") + ellipse(x, y, 0, 0.2, "free");
    var lit = s.pose === "working" || s.away;
    var out = ellipse(x - 0.9, y, 0, 0.8, "shadow");
    out += box(x0 + 0.06, y0 + 0.06, 0, 0.82, 0.3, DESK, "var(--room-wood)", "wood");
    out += box(x0 + 0.06, y0 + 0.84, 0, 0.82, 0.3, DESK, "var(--room-wood)", "wood");
    out += box(x0, y0, DESK, 0.96, 1.2, 0.06, "var(--brass)", "brass");
    out += patch(x0 + 0.02, y0 + 0.02, 0.92, 1.16, "desk-top", "", TOP);
    out += patch(x0 + 0.3, y0 + 0.2, 0.56, 0.8, "blotter", s.proj ? "fill:var(--proj-" + s.proj + ")" : "", TOP);
    out += extra || lamp(x0 + 0.2, y0 + 0.28, TOP, lit);
    if (s.empty) return out + stool(x, y);
    if (s.away) out += box(x0 + 0.44, y0 + 0.5, TOP, 0.3, 0.24, 0.02, "var(--you)", "note");
    else if (s.pose === "idle") out += cup(x0 + 0.6, y0 + 0.9, TOP);
    else out += box(x0 + 0.42, y0 + 0.62, TOP, 0.34, 0.26, 0.05, "var(--room-paper)", "paper");
    out += stool(x, y);
    if (!s.away) out += sprite(s.name, s.pose, x, y, 0.42);
    return out;
  }

  /** Returns your desk: a lacquered partner's desk with a leather chair behind it. */
  function yourDesk(x0, y0, waiting) {
    var w = 3.0;
    var d = 1.3;
    var out = ellipse(x0 + 1.5, y0 + 0.4, 0, 1.4, "shadow");
    // the chair, on the far side of the desk: you are the one looking out over the floor
    out += box(x0 + 1.46, y0 - 0.6, 0, 0.08, 0.08, 0.4, "var(--brass)", "brass");
    out += box(x0 + 1.1, y0 - 0.95, 0.4, 0.8, 0.76, 0.12, "var(--room-fabric)", "fabric");
    out += box(x0 + 1.1, y0 - 1.05, 0.46, 0.8, 0.14, 0.78, "var(--room-fabric)", "fabric");
    out += box(x0 + 0.08, y0 + 0.08, 0, 0.84, d - 0.16, DESK, "var(--room-inlay-2)", "lacquer");
    out += box(x0 + w - 0.92, y0 + 0.08, 0, 0.84, d - 0.16, DESK, "var(--room-inlay-2)", "lacquer");
    out += box(x0 + 0.92, y0 + d - 0.2, 0.28, w - 1.84, 0.1, DESK - 0.28, "var(--room-inlay-2)", "lacquer");
    out += box(x0, y0, DESK, w, d, 0.06, "var(--brass)", "brass");
    out += patch(x0 + 0.02, y0 + 0.02, w - 0.04, d - 0.04, "desk-top desk-top--you", "", TOP);
    out += patch(x0 + 0.9, y0 + 0.24, 1.2, 0.82, "blotter", "", TOP);
    out += lamp(x0 + 0.3, y0 + 0.36, TOP, true);
    // the in-tray holds one marigold card per colleague waiting on you
    out += box(x0 + 2.2, y0 + 0.28, TOP, 0.6, 0.5, 0.04, "var(--room-wood)", "wood");
    for (var i = 0; i < waiting; i++) out += box(x0 + 2.26, y0 + 0.34, TOP + 0.04 + i * 0.035, 0.48, 0.38, 0.025, "var(--you)", "note");
    out += cup(x0 + 1.8, y0 + 0.95, TOP);
    return out;
  }

  /** Returns a hat stand with a homburg on its top hook. */
  function hatStand(x, y) {
    var top = P(x, y, 1.72);
    var hat = '<g transform="translate(' + n1(top[0]) + " " + n1(top[1]) + ')">' +
      '<ellipse cx="0" cy="' + n1(U * 0.1) + '" rx="' + n1(U * 0.34) + '" ry="' + n1(U * 0.1) + '" class="hat"/>' +
      '<path d="M' + n1(-U * 0.2) + " " + n1(U * 0.1) + "V" + n1(-U * 0.12) + "Q0 " + n1(-U * 0.26) + " " + n1(U * 0.2) + " " + n1(-U * 0.12) + "V" + n1(U * 0.1) + 'Z" class="hat hat--crown"/>' +
      '<path d="M' + n1(-U * 0.2) + " " + n1(U * 0.02) + "H" + n1(U * 0.2) + '" class="hat-band"/></g>';
    return ellipse(x, y, 0, 0.3, "shadow") + ellipse(x, y, 0.02, 0.2, "lamp-foot") + box(x - 0.03, y - 0.03, 0, 0.06, 0.06, 1.7, "var(--brass)", "brass") + hat;
  }

  /** Returns a club chair, facing the viewer, with a colleague asleep in it. */
  function clubChair(x, y, name, pose) {
    return (
      ellipse(x, y, 0, 0.8, "shadow") +
      box(x - 0.6, y - 0.62, 0, 1.2, 0.34, 1.04, "var(--room-fabric)", "fabric") +
      box(x - 0.6, y - 0.28, 0, 0.3, 0.9, 0.62, "var(--room-fabric)", "fabric") +
      box(x - 0.3, y - 0.28, 0, 0.6, 0.9, 0.38, "var(--room-fabric)", "fabric") +
      sprite(name, pose, x, y + 0.05, 0.38) +
      box(x + 0.3, y - 0.28, 0, 0.3, 0.9, 0.62, "var(--room-fabric)", "fabric")
    );
  }
  function sideTable(x, y) {
    return box(x - 0.03, y - 0.03, 0, 0.06, 0.06, 0.56, "var(--brass)", "brass") + ellipse(x, y, 0.56, 0.3, "table-side") + ellipse(x, y, 0.6, 0.3, "table-top") + cup(x + 0.05, y + 0.05, 0.6);
  }

  /* ------------------------------------------------------------------ on the walls */

  /** Returns tall windows with a fan-shaped transom, on the left-hand wall between y1 and y2. */
  function windowPair(y1, y2) {
    var w = (y2 - y1) * U;
    var h = 1.85 * U;
    var t = 0.5 * U; // transom height
    var rays = "";
    for (var i = 1; i < 6; i++) {
      var a = Math.PI + (i * Math.PI) / 6;
      rays += "M" + n1(w / 2) + " " + n1(t) + "L" + n1(w / 2 + Math.cos(a) * t * 0.86) + " " + n1(t + Math.sin(a) * t * 0.86);
    }
    var inner =
      '<rect width="' + n1(w) + '" height="' + n1(h) + '" rx="3" class="window"/>' +
      '<path class="mullion" d="M0 ' + n1(t) + "H" + n1(w) + "M" + n1(w / 3) + " " + n1(t) + "V" + n1(h) + "M" + n1((w * 2) / 3) + " " + n1(t) + "V" + n1(h) + "M0 " + n1(t + (h - t) / 2) + "H" + n1(w) + '"/>' +
      '<path class="mullion mullion--fan" d="M' + n1(w / 2 - t * 0.86) + " " + n1(t) + "A" + n1(t * 0.86) + " " + n1(t * 0.86) + " 0 0 1 " + n1(w / 2 + t * 0.86) + " " + n1(t) + rays + '"/>' +
      '<rect width="' + n1(w) + '" height="' + n1(h) + '" rx="3" class="window-frame"/>' +
      '<rect y="' + n1(h + 3) + '" x="-5" width="' + n1(w + 10) + '" height="4" rx="2" class="sill"/>';
    return onSideWall(0.01, y2, 2.9, inner) + quad(P(0, y1 + 0.4, 0), P(0, y2 + 0.4, 0), P(2.8, y2 + 1.9, 0), P(2.8, y1 + 1.9, 0), "sun");
  }

  /** Returns a sunburst clock on the right-hand wall, showing 09:41. */
  function clock(x, z) {
    var r = 0.34 * U;
    var rays = "";
    for (var i = 0; i < 24; i++) {
      var a = (i / 24) * Math.PI * 2;
      var long = i % 2 === 0;
      rays += "M" + n1(Math.cos(a) * r * 1.12) + " " + n1(Math.sin(a) * r * 1.12) + "L" + n1(Math.cos(a) * r * (long ? 1.7 : 1.4)) + " " + n1(Math.sin(a) * r * (long ? 1.7 : 1.4));
    }
    function hand(deg, len, cls) {
      var a = (deg * Math.PI) / 180;
      return '<path class="' + cls + '" d="M0 0L' + n1(Math.sin(a) * len) + " " + n1(-Math.cos(a) * len) + '"/>';
    }
    return onBackWall(x, 0.01, z, '<path class="clock-rays" d="' + rays + '"/><circle r="' + n1(r) + '" class="clock"/>' + hand((9 + 41 / 60) * 30, r * 0.5, "hand hand--h") + hand(41 * 6, r * 0.78, "hand") + '<circle r="' + n1(U * 0.05) + '" class="hand-dot"/>');
  }

  /** Returns the wordmark on the right-hand wall: the egg mark and "Hercule" in the Deco face. */
  function wordmark(x, z) {
    var size = Math.round(U * 0.95);
    var fs = U * 0.78;
    return (
      onBackWall(x, 0.01, z + 0.02, Crew.logo(size)) +
      onBackWall(x + 1.18, 0.01, z - 0.74, '<text class="wall-word" style="font-size:' + n1(fs) + 'px">Hercule</text>') +
      onBackWall(x, 0.01, z - 1.02, '<path class="brass-rule" d="M0 0H' + n1(U * 5.1) + "M0 5H" + n1(U * 5.1) + '"/>')
    );
  }

  /**
   * Returns the case board on the right-hand wall: Triage pins each Proposal as a card and runs a
   * thread to every source it was made from, so "made from" is drawn as the thread itself.
   */
  function caseBoard(x, z, w, h) {
    var bw = w * U;
    var bh = h * U;
    var P1 = [0.4, 0.34];
    var P2 = [0.8, 0.26];
    var P3 = [0.68, 0.74];
    var sources = [
      ["sentry", 0.1, 0.26, [P1, P3]],
      ["gmail", 0.1, 0.72, [P1]],
      ["posthog", 0.28, 0.8, [P1]],
      ["github", 0.46, 0.8, [P1]],
      ["grafana", 0.62, 0.2, [P2]],
      ["cron", 0.93, 0.62, [P2]],
      ["stripe", 0.88, 0.86, [P3]],
    ];
    function pin(f, dy) {
      return [f[0] * bw, f[1] * bh - dy];
    }
    var threads = "";
    var cards = "";
    var pins = "";
    sources.forEach(function (s) {
      var a = pin([s[1], s[2]], bh * 0.1);
      s[3].forEach(function (p) {
        var b = pin(p, bh * 0.13);
        threads += "M" + n1(a[0]) + " " + n1(a[1]) + "L" + n1(b[0]) + " " + n1(b[1]);
      });
      var cw = bw * 0.1;
      var ch = bh * 0.24;
      var cx = s[1] * bw - cw / 2;
      var cy = s[2] * bh - ch / 2;
      cards += '<rect x="' + n1(cx) + '" y="' + n1(cy) + '" width="' + n1(cw) + '" height="' + n1(ch) + '" rx="1" class="bcard"/>';
      var m = Math.min(cw, ch) * 0.62;
      cards += '<g class="bmark" transform="translate(' + n1(cx + (cw - m) / 2) + " " + n1(cy + (ch - m) / 2 + 1) + ')">' + Crew.brand(s[0], m) + "</g>";
      pins += '<circle cx="' + n1(a[0]) + '" cy="' + n1(a[1]) + '" r="1.5" class="bpin"/>';
    });
    [P1, P2, P3].forEach(function (p, i) {
      var cw = bw * (i === 0 ? 0.22 : 0.18);
      var ch = bh * (i === 0 ? 0.34 : 0.3);
      var cx = p[0] * bw - cw / 2;
      var cy = p[1] * bh - ch / 2;
      cards +=
        '<rect x="' + n1(cx) + '" y="' + n1(cy) + '" width="' + n1(cw) + '" height="' + n1(ch) + '" rx="1" class="bcard bcard--case"/>' +
        '<path class="bline bline--title" d="M' + n1(cx + cw * 0.14) + " " + n1(cy + ch * 0.36) + "H" + n1(cx + cw * 0.86) + '"/>' +
        '<path class="bline" d="M' + n1(cx + cw * 0.14) + " " + n1(cy + ch * 0.6) + "H" + n1(cx + cw * 0.72) + "M" + n1(cx + cw * 0.14) + " " + n1(cy + ch * 0.8) + "H" + n1(cx + cw * 0.6) + '"/>';
      var q = pin(p, bh * 0.13);
      pins += '<circle cx="' + n1(q[0]) + '" cy="' + n1(q[1]) + '" r="1.8" class="bpin"/>';
    });
    return onBackWall(
      x,
      0.02,
      z,
      '<rect x="-4" y="-4" width="' + n1(bw + 8) + '" height="' + n1(bh + 8) + '" rx="2" class="board-frame"/>' +
        '<rect width="' + n1(bw) + '" height="' + n1(bh) + '" class="cork"/>' +
        cards +
        '<path class="bthread" d="' + threads + '"/>' +
        pins,
    );
  }

  /** Returns a row of filing cabinets against the right-hand wall, one drawer pulled open. */
  function cabinets(x, n) {
    var out = "";
    var h = 1.56;
    var dh = ((h - 0.12) * U) / 4;
    for (var i = 0; i < n; i++) {
      var cx = x + i * 0.98;
      out += box(cx, 0, 0, 0.92, 0.72, h, "var(--room-wood)", "wood");
      var fronts = "";
      for (var k = 0; k < 4; k++) {
        var ty = 0.06 * U + k * dh;
        fronts +=
          '<rect x="' + n1(0.06 * U) + '" y="' + n1(ty) + '" width="' + n1(0.8 * U) + '" height="' + n1(dh - 3) + '" rx="1.5" class="drawer"/>' +
          '<rect x="' + n1(0.3 * U) + '" y="' + n1(ty + dh * 0.16) + '" width="' + n1(0.32 * U) + '" height="' + n1(dh * 0.26) + '" rx="1" class="drawer-label"/>' +
          '<rect x="' + n1(0.34 * U) + '" y="' + n1(ty + dh * 0.58) + '" width="' + n1(0.24 * U) + '" height="2.4" rx="1.2" class="drawer-pull"/>';
      }
      out += onBackWall(cx, 0.72, h, fronts);
    }
    // the second cabinet's second drawer stands open: the Tasks someone is working on
    var ox = x + 1.04;
    var oz = h - 0.06 - (2 * dh) / U;
    out += box(ox, 0.72, oz + 0.02, 0.8, 0.46, dh / U - 0.06, "var(--room-wood)", "wood");
    for (var f = 0; f < 4; f++) out += box(ox + 0.1 + f * 0.16, 0.8, oz + dh / U - 0.1, 0.1, 0.3, 0.12, f === 1 ? "var(--room-cork)" : "var(--room-paper)", "paper");
    return out;
  }

  /** Returns a low sideboard against the right-hand wall with the tisane service on it. */
  function sideboard(x, w) {
    return (
      box(x, 0, 0, w, 0.78, 0.92, "var(--room-wood)", "wood") +
      box(x - 0.02, -0.02, 0.92, w + 0.04, 0.82, 0.05, "var(--brass)", "brass") +
      ellipse(x + 0.7, 0.4, 0.97, 0.2, "saucer") +
      box(x + 0.56, 0.26, 0.97, 0.28, 0.28, 0.26, "var(--room-paper)", "cup") +
      box(x + 0.66, 0.36, 1.23, 0.08, 0.08, 0.05, "var(--brass)", "brass") +
      cup(x + 1.3, 0.34, 0.97) +
      cup(x + 1.7, 0.44, 0.97)
    );
  }

  /* ------------------------------------------------------------------ the event flow */

  // The Connections that send events, busiest first. Each capsule is one event in flight.
  var SOURCES = [
    ["sentry", 3],
    ["github", 2],
    ["stripe", 2],
    ["gmail", 2],
    ["cron", 1],
    ["posthog", 1],
    ["intercom", 1],
    ["grafana", 1],
  ];
  var PLAQUES_Y = [0.4, 5.0]; // the plaques' span on the left-hand wall
  var PLAQUES_Z = 3.0; // the top of the plaque rail
  var MANIFOLD_Z = 1.5; // the brass pipe along the wall that gathers every tube
  var TUBE_Y = 3.2; // where the gathered tube leaves the wall for the Triage desk

  function capsule(path, dur, begin) {
    return (
      '<g class="capsule"><rect x="-3.2" y="-1.8" width="6.4" height="3.6" rx="1.8"/>' +
      '<animateMotion dur="' + dur.toFixed(2) + 's" begin="' + begin.toFixed(2) + 's" repeatCount="indefinite" rotate="auto" path="' + path + '"/></g>'
    );
  }

  /**
   * Returns the rail of Connection plaques on the left-hand wall: a brand mark over a brass mouth
   * for each one. In the flow layer, a tube drops from every mouth into a manifold along the wall,
   * and capsules run down the tubes and along the manifold to where it turns toward the desk.
   * sources - the Connections to draw, SOURCES by default.
   * slots   - how many plaques the rail has room for, as many as there are sources by default. A
   *           rail with fewer sources than slots hangs them from the left and leaves the rest bare.
   */
  function tubeWall(sources, slots) {
    sources = sources || SOURCES;
    var span = (PLAQUES_Y[1] - PLAQUES_Y[0]) * U;
    var pitch = span / (slots || sources.length || SOURCES.length);
    var mouthY = 0.52 * U;
    var pipeY = (PLAQUES_Z - MANIFOLD_Z) * U;
    var joinX = (PLAQUES_Y[1] - TUBE_Y) * U;
    var plaques = "";
    var tubes = "";
    var capsules = "";
    sources.forEach(function (s, i) {
      var mx = pitch * (i + 0.5);
      var m = 0.26 * U;
      plaques +=
        '<g class="plaque-mark" transform="translate(' + n1(mx - m / 2) + " " + n1(0.06 * U) + ')">' + Crew.brand(s[0], m) + "</g>" +
        '<circle cx="' + n1(mx) + '" cy="' + n1(mouthY) + '" r="' + n1(0.13 * U) + '" class="mouth"/>' +
        '<circle cx="' + n1(mx) + '" cy="' + n1(mouthY) + '" r="' + n1(0.07 * U) + '" class="mouth-in"/>';
      tubes += "M" + n1(mx) + " " + n1(mouthY) + "V" + n1(pipeY);
      var path = "M" + n1(mx) + " " + n1(mouthY) + "V" + n1(pipeY) + "H" + n1(joinX);
      var dur = 1.6 + (Math.abs(mx - joinX) + pipeY - mouthY) / (U * 1.1);
      for (var k = 0; k < s[1]; k++) capsules += capsule(path, dur, -((k / s[1]) * dur + i * 0.37));
    });
    // the manifold runs from the first mouth to where the tube leaves the wall
    if (sources.length) tubes += "M" + n1(Math.min(pitch * 0.5, joinX)) + " " + n1(pipeY) + "H" + n1(Math.max(pitch * (sources.length - 0.5), joinX));
    return onSideWall(
      0.01,
      PLAQUES_Y[1],
      PLAQUES_Z,
      '<rect x="-4" y="-4" width="' + n1(span + 8) + '" height="' + n1(0.8 * U) + '" rx="3" class="plaque-rail"/>' +
        '<g class="flow"><path class="tube" d="' + tubes + '"/>' + capsules + '<rect x="' + n1(joinX - 5) + '" y="' + n1(pipeY - 5) + '" width="10" height="10" rx="3" class="collar"/></g>' +
        plaques,
    );
  }

  /** Returns the tube from the manifold to the receiver on the Triage desk, with its capsules. */
  function tubeToDesk(rx) {
    var a = P(0.02, TUBE_Y, MANIFOLD_Z);
    var b = P(rx, TUBE_Y, MANIFOLD_Z);
    var c = P(rx, TUBE_Y, TOP + 0.3);
    var d = "M" + n1(a[0]) + " " + n1(a[1]) + "L" + n1(b[0]) + " " + n1(b[1]) + "L" + n1(c[0]) + " " + n1(c[1]);
    return (
      '<g class="flow">' +
      box(rx - 0.15, TUBE_Y - 0.15, TOP, 0.3, 0.3, 0.3, "var(--brass)", "brass") +
      '<path class="tube tube--main" d="' + d + '"/>' +
      capsule(d, 1.8, -0.3) +
      capsule(d, 1.8, -1.2) +
      "</g>"
    );
  }

  /* ------------------------------------------------------------------ the floor */

  function parquet(id) {
    var s = U;
    return (
      '<defs><pattern id="' + id + '" width="' + n1(2 * s) + '" height="' + n1(2 * s) + '" patternUnits="userSpaceOnUse">' +
      '<rect width="' + n1(s) + '" height="' + n1(s) + '" class="pq"/><rect x="' + n1(s) + '" y="' + n1(s) + '" width="' + n1(s) + '" height="' + n1(s) + '" class="pq"/>' +
      "</pattern></defs>"
    );
  }

  /**
   * Returns a wing's inlaid field: a double border with stepped corners, and the runner's name and
   * load engraved in the aisle in front of it, where no desk can stand over the words.
   */
  function wingField(g) {
    var out = patch(g.x, g.y, g.w, g.d, "field");
    out += patch(g.x + 0.16, g.y + 0.16, g.w - 0.32, g.d - 0.32, "field-line");
    out += patch(g.x + 0.34, g.y + 0.34, g.w - 0.68, g.d - 0.68, "field-line field-line--thin");
    [
      [g.x + 0.08, g.y + 0.08],
      [g.x + g.w - 0.44, g.y + 0.08],
      [g.x + 0.08, g.y + g.d - 0.44],
      [g.x + g.w - 0.44, g.y + g.d - 0.44],
    ].forEach(function (c) {
      out += patch(c[0], c[1], 0.36, 0.36, "field-corner");
    });
    out += onFloor(g.label[0], g.label[1], '<text class="engrave" style="font-size:' + n1(U * 0.4) + 'px"><tspan class="engrave-name">' + g.runner + "</tspan>   " + g.note + "</text>");
    return out;
  }

  /** Returns the sunburst inlaid in the lobby floor. */
  function medallion(cx, cy, r) {
    var R = r * U;
    var rays = "";
    for (var i = 0; i < 16; i++) {
      var a0 = (i / 16) * Math.PI * 2;
      var a1 = a0 + Math.PI / 16;
      rays +=
        "M" + n1(R + Math.cos(a0) * R * 0.34) + " " + n1(R + Math.sin(a0) * R * 0.34) +
        "L" + n1(R + Math.cos(a0) * R * 0.86) + " " + n1(R + Math.sin(a0) * R * 0.86) +
        "L" + n1(R + Math.cos(a1) * R * 0.86) + " " + n1(R + Math.sin(a1) * R * 0.86) + "Z";
    }
    return onFloor(
      cx - r,
      cy - r,
      '<circle cx="' + n1(R) + '" cy="' + n1(R) + '" r="' + n1(R) + '" class="med"/>' +
        '<circle cx="' + n1(R) + '" cy="' + n1(R) + '" r="' + n1(R * 0.93) + '" class="med-line"/>' +
        '<path class="med-ray" d="' + rays + '"/>' +
        '<circle cx="' + n1(R) + '" cy="' + n1(R) + '" r="' + n1(R * 0.3) + '" class="med-core"/>',
    );
  }

  /**
   * Returns the shell of the room: floor, walls with their wainscot, windows and wall pieces.
   * data.wings    - the runners' inlaid fields
   * data.board    - false leaves the case board off the wall
   * data.sources  - the Connection plaques to hang, all of SOURCES by default; [] hangs the bare rail
   * data.slots    - how many plaques the rail is spaced for
   */
  function room(id, data) {
    var out = [];
    out.push(box(0, 0, -0.5, W, D, 0.5, "var(--room-floor)", "slab"));
    out.push(onFloor(0, 0, parquet(id) + '<rect width="' + n1(W * U) + '" height="' + n1(D * U) + '" fill="url(#' + id + ')"/>'));
    out.push(
      '<g class="wall">' +
        quad(P(-0.4, -0.4, H), P(W, -0.4, H), P(W, 0, H), P(-0.4, 0, H), "wall-top") +
        quad(P(0, 0, 0), P(W, 0, 0), P(W, 0, H), P(0, 0, H), "wall-in wall-in--b") +
        quad(P(W, -0.4, -0.5), P(W, 0, -0.5), P(W, 0, H), P(W, -0.4, H), "wall-end") +
        quad(P(-0.4, 0, H), P(0, 0, H), P(0, D, H), P(-0.4, D, H), "wall-top") +
        quad(P(0, 0, 0), P(0, D, 0), P(0, D, H), P(0, 0, H), "wall-in wall-in--s") +
        quad(P(-0.4, D, -0.5), P(0, D, -0.5), P(0, D, H), P(-0.4, D, H), "wall-end") +
        // the wainscot: wood panels to hip height under a brass rail
        quad(P(0, 0, 0), P(W, 0, 0), P(W, 0, 0.95), P(0, 0, 0.95), "wainscot") +
        quad(P(0, 0, 0), P(0, D, 0), P(0, D, 0.95), P(0, 0, 0.95), "wainscot wainscot--s") +
        quad(P(0, 0, 0.95), P(W, 0, 0.95), P(W, 0, 1.0), P(0, 0, 1.0), "rail") +
        quad(P(0, 0, 0.95), P(0, D, 0.95), P(0, D, 1.0), P(0, 0, 1.0), "rail rail--s") +
        quad(P(0, 0, H - 0.08), P(W, 0, H - 0.08), P(W, 0, H - 0.05), P(0, 0, H - 0.05), "rail") +
        quad(P(0, 0, H - 0.08), P(0, D, H - 0.08), P(0, D, H - 0.05), P(0, 0, H - 0.05), "rail rail--s") +
        "</g>",
    );
    var seams = "";
    for (var i = 1.15; i < W; i += 1.15) seams += "M" + points([P(i, 0, 0.08)]) + "L" + points([P(i, 0, 0.88)]);
    for (i = 1.15; i < D; i += 1.15) seams += "M" + points([P(0, i, 0.08)]) + "L" + points([P(0, i, 0.88)]);
    out.push('<path class="seams" d="' + seams + '"/>');
    out.push(patch(0, 0, W, 0.6, "ao") + patch(0, 0, 0.6, D, "ao"));
    out.push(windowPair(6.8, 10.0) + windowPair(11.4, 14.6));
    out.push(wordmark(10.6, 2.98));
    out.push(clock(18.4, 2.3));
    if (data.board !== false) out.push(caseBoard(0.7, 2.94, 3.9, 1.7));
    out.push(tubeWall(data.sources, data.slots));
    // the floor's inlay: one field per runner and the sunburst in the lobby
    data.wings.forEach(function (g) {
      out.push(wingField(g));
    });
    out.push(medallion(16.6, 16.9, 1.2));
    return out.join("");
  }

  /* ------------------------------------------------------------------ the floor plans */

  // Wings, one per runner, with one desk per slot. Desks fill in order: the back row from left to
  // right, then the front row, which is shifted sideways so no two name tags collide. "label" is
  // where the runner's name is engraved, in a clear aisle.
  var WINGS = [
    { x: 9.4, y: 0.9, w: 14.0, d: 6.3, cols: [11.2, 14.2, 17.2, 20.2], rows: [2.4, 5.8], stagger: 1.8, label: [9.9, 7.75] },
    { x: 1.4, y: 8.3, w: 9.9, d: 5.0, cols: [3.8, 6.7, 9.6], rows: [9.6, 12.6], stagger: 0.9, label: [6.1, 13.95] },
    { x: 12.2, y: 9.2, w: 11.5, d: 5.3, cols: [13.9, 17.0, 20.1, 23.2], rows: [10.9, 13.6], stagger: -0.6, label: [12.8, 15.25] },
  ];

  /** Returns the wings with each desk placed and filled from the sessions, the rest left vacant. */
  function seatWings(runners, sessions) {
    return WINGS.map(function (w, i) {
      var seats = [];
      for (var k = 0; k < runners[i].slots; k++) {
        var row = k < w.cols.length ? 0 : 1;
        var s = sessions[i][k] || { vacant: true };
        s.x = w.cols[k % w.cols.length] + (row ? w.stagger : 0);
        s.y = w.rows[row];
        seats.push(s);
      }
      return { runner: runners[i].name, note: runners[i].note, x: w.x, y: w.y, w: w.w, d: w.d, label: w.label, seats: seats };
    });
  }

  var QUEUE = [
    { name: "Fix 3-D Secure checkout for EU cards", ask: "Run git push?" },
    { name: "Migrate ops dashboards" },
    { name: "Ship release v2.15" },
  ];

  var TODAY = {
    runners: [
      { name: "build-box-1", slots: 8, note: "8 of 8 · at cap" },
      { name: "studio-mac", slots: 6, note: "5 of 6" },
      { name: "build-box-2", slots: 8, note: "3 of 8" },
    ],
    sessions: [
      [
        { name: "Refactor cart totals", pose: "working", proj: "webshop", tag: "22m" },
        { name: "Investigate backup timeouts", label: "Backup timeouts", pose: "working", proj: "ops", tag: "6m" },
        { name: "Label new issues run", label: "Label new issues", pose: "paused", proj: "webshop", tag: "paused" },
        { name: "Tidy checkout CSS", pose: "idle", proj: "webshop", tag: "idle 2h" },
        { name: "Webhook retry backoff", pose: "working", proj: "payments", tag: "3m" },
        { name: "Cart total rounding on discounts", label: "Cart total rounding", pose: "working", proj: "webshop", tag: "14m" },
        { name: "Payout report for September", label: "Payout report", pose: "working", proj: "payments", tag: "9m" },
        { name: "Rotate staging secrets", label: "Staging secrets", pose: "working", proj: "ops", tag: "11m" },
      ],
      [
        { name: "Ada", pose: "working", tag: "heartbeat" },
        { name: "Fix 3-D Secure checkout for EU cards", away: true, proj: "webshop" },
        { name: "Read the Stripe v14 changelog", label: "Stripe v14 changelog", pose: "idle", proj: "webshop", tag: "idle 20m" },
        { name: "Migrate ops dashboards", away: true, proj: "ops" },
        { name: "Milo", pose: "idle", tag: "idle" },
      ],
      // the two tagged desks sit at the far end, clear of the build-box-1 engraving in the aisle
      [
        { name: "Ship release v2.15", away: true, proj: "payments" },
        null,
        { name: "Draft reply to Jonas at Kiteworks", label: "Draft reply to Jonas", pose: "working", proj: "payments", tag: "1m" },
        null,
        null,
        null,
        null,
        { name: "Add iDEAL research", label: "iDEAL research", pose: "idle", proj: "payments", tag: "idle 1h" },
      ],
    ],
    triage: "next 11:00",
    tasks: "14 open",
    board: "5 Proposals",
    flow: "212 since 18:20",
    queueMore: 0,
  };

  // At 10x the rooms keep their shape. A wing stands for a group of runners, a desk for a group of
  // sessions with its head count, and the queue at your desk folds into "+27 more".
  var SWARM = {
    runners: [
      { name: "build-box-1 to 4", slots: 8, note: "70 of 72" },
      { name: "studio-mac", slots: 6, note: "6 of 6 · at cap" },
      { name: "build-box-5 to 8", slots: 8, note: "64 of 72" },
    ],
    sessions: [
      [
        { name: "Fix bug", pose: "working", proj: "webshop", tag: "×14" },
        { name: "Investigate", pose: "working", proj: "ops", tag: "×8" },
        { name: "Label new issues", pose: "paused", proj: "webshop", tag: "×4 paused" },
        { name: "Dependency bumps", pose: "working", proj: "payments", tag: "×10" },
        { name: "Draft reply", pose: "working", proj: "payments", tag: "×9" },
        { name: "Flaky test hunt", pose: "working", proj: "webshop", tag: "×7" },
        { name: "Nightly backup check", label: "Backup checks", pose: "working", proj: "ops", tag: "×6" },
        { name: "Webhook retry backoff", label: "Webhook fixes", pose: "working", proj: "payments", tag: "×12" },
      ],
      [
        { name: "Ada", pose: "working", tag: "heartbeat" },
        { name: "Fix 3-D Secure checkout for EU cards", away: true, proj: "webshop" },
        { name: "Read the Stripe v14 changelog", label: "Stripe v14 changelog", pose: "idle", proj: "webshop", tag: "idle 20m" },
        { name: "Migrate ops dashboards", away: true, proj: "ops" },
        { name: "Milo", pose: "idle", tag: "idle" },
        { name: "Invoice PDF layout", pose: "working", proj: "payments", tag: "4m" },
      ],
      [
        { name: "Ship release v2.15", away: true, proj: "payments" },
        { name: "Payout report for September", label: "Reports", pose: "working", proj: "payments", tag: "×12" },
        { name: "Rotate staging secrets", label: "Idle ops threads", pose: "idle", proj: "ops", tag: "×8" },
        { name: "Tidy checkout CSS", label: "Idle webshop threads", pose: "idle", proj: "webshop", tag: "×8" },
        { name: "Refactor cart totals", label: "Refactors", pose: "working", proj: "webshop", tag: "×16" },
        { name: "Draft reply to Jonas at Kiteworks", label: "Replies", pose: "working", proj: "payments", tag: "×7" },
        { name: "Investigate backup timeouts", label: "Investigations", pose: "working", proj: "ops", tag: "×6" },
        { name: "Cart total rounding on discounts", label: "Rounding fixes", pose: "working", proj: "webshop", tag: "×6" },
      ],
    ],
    triage: "60 Proposals since 07:00",
    tasks: "118 open",
    board: "60 Proposals",
    flow: "31,000 in 24 hours",
    queueMore: 27,
  };

  /* ------------------------------------------------------------------ assembly */

  function build(host) {
    var data = document.documentElement.dataset.state === "swarm" ? SWARM : TODAY;
    var rect = host.getBoundingClientRect();
    var sw = rect.width;
    var sh = rect.height;
    // fit the room to the stage, leaving air for the labels above the walls
    var span = W + D;
    U = Math.min(36, (sw - 64) / (span * 0.8660254), (sh - 96) / (span * 0.5 + H + 0.6));
    C = U * 0.8660254;
    S = U * 0.5;
    OX = sw / 2 + ((D - W) * C) / 2;
    OY = (sh - (span * S + (H + 0.6) * U)) / 2 + (H + 0.6) * U + 14;

    // Copies, so drawing again after a resize never places a desk twice.
    var wings = seatWings(data.runners, JSON.parse(JSON.stringify(data.sessions)));

    var items = [];
    function add(key, svg) {
      items.push({ k: key, svg: svg });
    }
    var tags = [];
    function tag(x, y, z, html, cls) {
      var p = P(x, y, z);
      tags.push('<div class="tag' + (cls ? " " + cls : "") + '" style="left:' + n1(p[0]) + "px;top:" + n1(p[1]) + 'px">' + html + "</div>");
    }
    var headZ = 0.42 + (spriteSize() * 0.9) / U; // just above a seated colleague's head
    var floor = room("parquet-" + ++drawCount, { wings: wings });

    // along the back walls
    add(0.5, cabinets(5.0, 4));
    add(1.2, sideboard(19.6, 2.2));
    add(1.4, palm(22.9, 0.5, true));
    tag(6.9, 0.36, 1.84, "<b>Tasks</b><span>" + data.tasks + "</span>", "tag--quiet");
    tag(2.65, 0.02, 3.5, "<b>Case board</b><span>" + data.board + "</span>", "tag--quiet");
    tag(0.02, 2.7, 4.4, "<b>8 Connections</b><span>" + data.flow + "</span>", "tag--quiet tag--flow");

    // the Triage clerk, in the back corner under the plaques; the flow's tube ends on this desk
    var triage = { name: "Triage", pose: "working", x: 3.5, y: TUBE_Y };
    add(triage.x + triage.y, desk(triage, tubeToDesk(triage.x - 1.2)));
    tag(triage.x, triage.y, headZ, "<b>Triage</b><span>" + data.triage + "</span>");

    // the wings
    wings.forEach(function (g) {
      g.seats.forEach(function (s) {
        add(s.x + s.y, desk(s));
        if (s.tag) tag(s.x, s.y, headZ, "<b>" + (s.label || s.name) + "</b><span>" + s.tag + "</span>", s.pose === "working" ? "" : "tag--quiet");
      });
    });

    // your desk, and the colleagues waiting on you queued beside it
    add(3.0 + 15.8, yourDesk(1.4, 15.8, QUEUE.length));
    add(0.6 + 14.8, hatStand(0.6, 14.8));
    tag(2.9, 16.4, 1.62, "<b>Your desk</b>", "tag--you");
    QUEUE.forEach(function (q, i) {
      var x = 6.2 + i * 1.45;
      var y = 17.3;
      add(x + y, ellipse(x, y, 0, 0.36, "shadow") + sprite(q.name, "waiting", x, y, 0));
      // only the head of the queue speaks; the others raise a hand and wait their turn
      tag(x, y, (spriteSize() * 0.92) / U, q.ask || "?", q.ask ? "tag--ask is-first" : "tag--ask tag--wait");
    });
    if (data.queueMore) tag(6.2 + QUEUE.length * 1.45 - 0.2, 17.6, 0.1, "+" + data.queueMore + " more", "tag--more");

    // the lobby: Juno asleep in a club chair by the sunburst
    add(21.4 + 16.9, clubChair(21.4, 16.9, "Juno", "asleep"));
    add(20.0 + 17.7, sideTable(20.0, 17.7));
    add(23.1 + 15.6, palm(23.1, 15.4, true));
    add(0.3 + 17.9, palm(0.25, 17.7, false));
    tag(21.4, 16.9, 0.38 + (spriteSize() * 0.9) / U, "<b>Juno</b><span>asleep</span>", "tag--quiet");

    items.sort(function (a, b) {
      return a.k - b.k;
    });

    host.innerHTML =
      '<svg class="floor" width="' + sw + '" height="' + sh + '" viewBox="0 0 ' + sw + " " + sh + '" role="img" aria-label="The Office: every live session sits here as a colleague">' +
      floor +
      items
        .map(function (it) {
          return it.svg;
        })
        .join("") +
      "</svg>" +
      '<div class="tags">' + tags.join("") + "</div>";

    // Capsules stand still, spread along their tubes, for anyone who asked for less motion.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) host.querySelector("svg").pauseAnimations();
  }

  /**
   * Fits the drawing to a stage of sw by sh pixels so the plan region [x0, x1] by [y0, y1], from the
   * floor to the top of the walls, fills it with pad pixels to spare. maxU caps the zoom.
   * The Office page fits the whole room in build(); the first run frames a part of it instead.
   */
  function frame(sw, sh, region, pad, maxU) {
    var corners = [];
    [region.x0, region.x1].forEach(function (x) {
      [region.y0, region.y1].forEach(function (y) {
        corners.push([(x - y) * 0.8660254, (x + y) * 0.5], [(x - y) * 0.8660254, (x + y) * 0.5 - H - 0.6]);
      });
    });
    var xs = corners.map(function (c) {
      return c[0];
    });
    var ys = corners.map(function (c) {
      return c[1];
    });
    var bx0 = Math.min.apply(null, xs);
    var bx1 = Math.max.apply(null, xs);
    var by0 = Math.min.apply(null, ys);
    var by1 = Math.max.apply(null, ys);
    U = Math.min(maxU || 60, (sw - pad * 2) / (bx1 - bx0), (sh - pad * 2) / (by1 - by0));
    C = U * 0.8660254;
    S = U * 0.5;
    OX = sw / 2 - (U * (bx0 + bx1)) / 2;
    OY = sh / 2 - (U * (by0 + by1)) / 2;
    return U;
  }

  // The drawing kit, for a page that furnishes the room itself. Every function draws at the scale
  // the last frame() or build() set.
  window.Office = {
    frame: frame,
    room: function (data) {
      return room("parquet-" + ++drawCount, data);
    },
    P: P,
    box: box,
    patch: patch,
    ellipse: ellipse,
    sprite: sprite,
    spriteSize: spriteSize,
    desk: desk,
    yourDesk: yourDesk,
    hatStand: hatStand,
    palm: palm,
    cabinets: cabinets,
    sideboard: sideboard,
    clubChair: clubChair,
    sideTable: sideTable,
    wingField: wingField,
    tubeToDesk: tubeToDesk,
    tileSize: function () {
      return U;
    },
    WINGS: WINGS,
    TUBE_Y: TUBE_Y,
  };

  function boot() {
    // The List view hides the stage, so the scene is drawn whenever the stage has a size:
    // on first show and after every resize.
    document.querySelectorAll("[data-office]").forEach(function (host) {
      new ResizeObserver(function () {
        if (host.clientWidth > 0 && host.clientHeight > 0) build(host);
      }).observe(host);
    });
    // the 10x floor also swaps the head counts in the header and the answer card
    if (document.documentElement.dataset.state === "swarm") {
      document.querySelectorAll("[data-swarm]").forEach(function (el) {
        el.textContent = el.dataset.swarm;
      });
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
