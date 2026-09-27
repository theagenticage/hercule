// PROTOTYPE - the Office: an isometric floor where every live session sits as a colleague.
// Renders into <div data-office>. Plan coordinates: x runs along the right-hand back wall, y along
// the left-hand back wall, z is height; one unit is one floor tile. ?state=swarm draws the 10x floor.
(function () {
  "use strict";
  var Crew = window.Crew;
  var W = 22;
  var D = 16;
  var H = 3.2;
  var DESK = 0.74; // desk top height
  var U = 32;
  var C = 0;
  var S = 0;
  var OX = 0;
  var OY = 0;

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
  function patch(x, y, w, d, cls, style) {
    return quad(P(x, y, 0), P(x + w, y, 0), P(x + w, y + d, 0), P(x, y + d, 0), cls, style);
  }
  function ellipse(x, y, z, r, cls, style) {
    var p = P(x, y, z);
    return '<ellipse class="' + cls + '" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" rx="' + (r * C * 1.414).toFixed(1) + '" ry="' + (r * S * 1.414).toFixed(1) + '"' + (style ? ' style="' + style + '"' : "") + "/>";
  }
  function matrix(a, b, c, d, o) {
    return '<g transform="matrix(' + [a, b, c, d, o[0], o[1]].map(f3).join(" ") + ')">';
  }
  function f3(n) {
    return Number(n.toFixed(3));
  }
  // Flat drawing planes. Local units are pixels, so U local px is one tile.
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

  /* ------------------------------------------------------------------ furniture */

  function spriteSize() {
    return Math.round(U * 1.52);
  }
  /** Returns a colleague sprite whose body bottom sits on plan point (x, y, z). */
  function sprite(name, pose, x, y, z, size) {
    var p = P(x, y, z);
    size = size || spriteSize();
    return '<g transform="translate(' + (p[0] - size / 2).toFixed(1) + " " + (p[1] - size * 0.93).toFixed(1) + ')">' + Crew.face(name, { pose: pose, size: size }) + "</g>";
  }
  function stool(x, y) {
    return box(x - 0.05, y - 0.05, 0, 0.1, 0.1, 0.4, "var(--room-metal)") + ellipse(x, y, 0.4, 0.3, "cushion cushion--side") + ellipse(x, y, 0.46, 0.3, "cushion");
  }
  function mug(x, y, z, color) {
    return box(x, y, z, 0.2, 0.2, 0.22, color || "var(--room-desk)", "mug");
  }
  function plant(x, y, tall) {
    var z = tall ? 0.9 : 0.42;
    var top = P(x + 0.3, y + 0.3, z);
    var r = U * (tall ? 0.56 : 0.36);
    var leaves = [
      [-0.55, -1.2, 1],
      [0.52, -1.0, 0.92],
      [0, -1.85, 0.86],
      [-0.2, -0.5, 0.95],
      [0.55, -0.3, 0.8],
    ]
      .map(function (l, i) {
        return '<circle cx="' + (top[0] + l[0] * r).toFixed(1) + '" cy="' + (top[1] + l[1] * r * (tall ? 1.25 : 1)).toFixed(1) + '" r="' + (r * l[2]).toFixed(1) + '" class="leaf leaf--' + (i % 3) + '"/>';
      })
      .join("");
    return box(x, y, 0, 0.6, 0.6, z, "var(--room-pot)") + leaves;
  }

  /**
   * Returns one colleague at their desk. The desk stands on the colleague's -x side with the
   * laptop screen facing them, so the viewer sees both the face and the screen. A working
   * colleague's screen is lit in their own hue; an away colleague (queued at your desk) leaves
   * an empty stool and a marigold screen behind.
   */
  function seat(s) {
    var look = Crew.lookFor(s.name);
    var x = s.x;
    var y = s.y;
    var lit = !s.away && s.pose === "working";
    var out = "";
    if (lit) out += ellipse(x - 0.9, y, 0, 0.95, "glow", "--hue:var(--hue-" + look.hue + ")");
    // desk: two side panels and a top
    out += box(x - 1.34, y - 0.5, 0, 0.84, 0.08, DESK, "var(--room-metal)");
    out += box(x - 1.34, y + 0.42, 0, 0.84, 0.08, DESK, "var(--room-metal)");
    out += box(x - 1.38, y - 0.56, DESK, 0.92, 1.12, 0.07, "var(--room-desk)", "desk");
    // laptop: base on the desk, lid standing on its far (-x) edge
    var bx = x - 1.14;
    var z = DESK + 0.07;
    var sw = 0.7 * U;
    var sh = 0.46 * U;
    var screen = '<rect width="' + sw.toFixed(1) + '" height="' + sh.toFixed(1) + '" rx="2.5" class="screen' + (lit ? " screen--lit" : s.away ? " screen--away" : "") + '" style="--hue:var(--hue-' + look.hue + ')"/>';
    if (lit)
      screen += [0.2, 0.42, 0.64]
        .map(function (t, i) {
          return '<rect x="' + (sw * 0.14).toFixed(1) + '" y="' + (sh * t).toFixed(1) + '" width="' + (sw * [0.62, 0.4, 0.52][i]).toFixed(1) + '" height="' + (sh * 0.1).toFixed(1) + '" rx="1" class="code-line" style="--hue:var(--hue-' + look.hue + ')"/>';
        })
        .join("");
    if (s.away) screen += '<circle cx="' + (sw / 2).toFixed(1) + '" cy="' + (sh / 2).toFixed(1) + '" r="' + (sh * 0.16).toFixed(1) + '" class="screen-dot"/>';
    out += box(bx, y - 0.36, z, 0.54, 0.72, 0.035, "var(--room-metal)");
    out += box(bx - 0.03, y - 0.36, z, 0.03, 0.72, 0.5, "var(--room-metal)");
    out += onSideWall(bx, y + 0.35, z + 0.49, screen);
    if (s.mug) out += mug(x - 1.3, y + 0.14, z);
    // the colleague on a stool
    out += stool(x, y);
    if (!s.away) out += sprite(s.name, s.pose, x, y, 0.46);
    return out;
  }

  function sofa(x, y, w, sitters) {
    var out = box(x, y, 0, w, 0.42, 1.05, "var(--room-fabric)", "fabric");
    out += box(x, y + 0.42, 0, 0.36, 1.0, 0.7, "var(--room-fabric)", "fabric");
    out += box(x + 0.36, y + 0.42, 0, w - 0.72, 1.0, 0.42, "var(--room-fabric)", "fabric");
    sitters.forEach(function (s) {
      out += sprite(s.name, s.pose, s.x, s.y, 0.42);
      if (s.laptop)
        out +=
          box(s.x - 0.32, s.y + 0.16, 0.6, 0.64, 0.4, 0.035, "var(--room-metal)") +
          quad(P(s.x - 0.32, s.y + 0.56, 0.63), P(s.x + 0.32, s.y + 0.56, 0.63), P(s.x + 0.32, s.y + 0.62, 1.04), P(s.x - 0.32, s.y + 0.62, 1.04), "lid");
      if (s.mug) out += mug(s.x + 0.22, s.y + 0.42, 0.56);
    });
    out += box(x + w - 0.36, y + 0.42, 0, 0.36, 1.0, 0.7, "var(--room-fabric)", "fabric");
    return out;
  }

  function beanbag(x, y, name) {
    var p = P(x, y, 0);
    return (
      ellipse(x, y, 0, 0.75, "shadow") +
      '<ellipse cx="' + p[0].toFixed(1) + '" cy="' + (p[1] - U * 0.22).toFixed(1) + '" rx="' + (0.95 * C).toFixed(1) + '" ry="' + (0.56 * U).toFixed(1) + '" class="bean"/>' +
      '<ellipse cx="' + (p[0] - U * 0.1).toFixed(1) + '" cy="' + (p[1] - U * 0.42).toFixed(1) + '" rx="' + (0.72 * C).toFixed(1) + '" ry="' + (0.38 * U).toFixed(1) + '" class="bean bean--top"/>' +
      sprite(name, "asleep", x - 0.1, y - 0.1, 0.5)
    );
  }

  /* ------------------------------------------------------------------ the room */

  function room(data) {
    var out = [];
    out.push(box(0, 0, -0.5, W, D, 0.5, "var(--room-floor)", "slab"));
    var planks = "";
    for (var i = 1; i < W; i++) planks += '<path d="M' + points([P(i, 0, 0)]) + "L" + points([P(i, D, 0)]) + '"/>';
    out.push('<g class="planks">' + planks + "</g>");
    // the walls meet at the back corner; the floor darkens a little along their feet
    out.push(
      '<g class="wall">' +
        quad(P(-0.4, -0.4, H), P(W, -0.4, H), P(W, 0, H), P(-0.4, 0, H), "wall-top") +
        quad(P(0, 0, 0), P(W, 0, 0), P(W, 0, H), P(0, 0, H), "wall-in wall-in--b") +
        quad(P(W, -0.4, -0.5), P(W, 0, -0.5), P(W, 0, H), P(W, -0.4, H), "wall-end") +
        quad(P(-0.4, 0, H), P(0, 0, H), P(0, D, H), P(-0.4, D, H), "wall-top") +
        quad(P(0, 0, 0), P(0, D, 0), P(0, D, H), P(0, 0, H), "wall-in wall-in--s") +
        quad(P(-0.4, D, -0.5), P(0, D, -0.5), P(0, D, H), P(-0.4, D, H), "wall-end") +
        quad(P(0, 0, 0), P(W, 0, 0), P(W, 0, 0.14), P(0, 0, 0.14), "skirt") +
        quad(P(0, 0, 0), P(0, D, 0), P(0, D, 0.14), P(0, 0, 0.14), "skirt skirt--s") +
        "</g>",
    );
    out.push(patch(0, 0, W, 0.7, "ao ao--b") + patch(0, 0, 0.7, D, "ao ao--s"));
    // windows on the left-hand wall, with the morning sun on the floor below them
    [
      [5.4, 8.9],
      [10.0, 13.5],
    ].forEach(function (win) {
      var w = (win[1] - win[0]) * U;
      var h = 1.5 * U;
      out.push(
        onSideWall(
          0.01,
          win[1],
          2.7,
          '<rect width="' + w + '" height="' + h + '" rx="6" class="window"/>' +
            '<path d="M' + w / 2 + " 0V" + h + "M0 " + h * 0.4 + "H" + w + '" class="mullion"/>' +
            '<rect width="' + w + '" height="' + h + '" rx="6" class="window-frame"/>' +
            '<rect y="' + (h + 3) + '" x="-6" width="' + (w + 12) + '" height="5" rx="2.5" class="sill"/>',
        ),
      );
      out.push(quad(P(0, win[0] + 0.5, 0), P(0, win[1] + 0.5, 0), P(3.2, win[1] + 2.1, 0), P(3.2, win[0] + 2.1, 0), "sun"));
    });
    // the mark on the right-hand wall
    out.push(onBackWall(0.9, 0.01, 2.78, Crew.logo(Math.round(U * 1.2)).replace('class="logo"', 'class="logo" style="--logo-ring:var(--room-wall)"')));
    out.push(onBackWall(2.3, 0.01, 2.26, '<text class="wall-word" style="font-size:' + (U * 0.62).toFixed(1) + 'px">Hercule</text>'));
    out.push(clock(15.9, 2.42));
    if (data.board) out.push(board(12.7));
    return out.join("");
  }

  function clock(x, z) {
    var r = 0.42 * U;
    function hand(deg, len, cls) {
      var a = (deg * Math.PI) / 180;
      return '<path class="' + cls + '" d="M0 0L' + (Math.sin(a) * len).toFixed(1) + " " + (-Math.cos(a) * len).toFixed(1) + '"/>';
    }
    return onBackWall(x, 0.01, z, '<circle r="' + r + '" class="clock"/>' + hand((9 + 41 / 60) * 30, r * 0.5, "hand hand--h") + hand(41 * 6, r * 0.76, "hand") + '<circle r="' + (U * 0.06).toFixed(1) + '" class="hand-dot"/>');
  }

  /** Returns the plan board on the right-hand wall: today's date and a few sticky notes. */
  function board(x) {
    var w = 1.9 * U;
    var h = 1.2 * U;
    var notes = [
      [0.1, 0.36, "you"],
      [0.38, 0.4, "iris"],
      [0.64, 0.33, "teal"],
      [0.24, 0.66, "orchid"],
      [0.52, 0.68, "lime"],
    ]
      .map(function (n, i) {
        return '<rect x="' + (w * n[0]).toFixed(1) + '" y="' + (h * n[1]).toFixed(1) + '" width="' + (U * 0.36).toFixed(1) + '" height="' + (U * 0.3).toFixed(1) + '" rx="1.5" class="note" style="--hue:var(--hue-' + n[2] + ");transform-box:fill-box;transform-origin:center;transform:rotate(" + [-4, 3, -2, 5, -3][i] + 'deg)"/>';
      })
      .join("");
    return onBackWall(x, 0.01, 2.62, '<rect width="' + w + '" height="' + h + '" rx="4" class="board"/><text class="board-date" x="' + (w * 0.08).toFixed(1) + '" y="' + (h * 0.24).toFixed(1) + '" style="font-size:' + (U * 0.24).toFixed(1) + 'px">Tue 29 Sep</text>' + notes);
  }

  /** Returns a server rack against the right-hand wall; each lit slot is one live session. */
  function rack(r) {
    var out = box(r.x, 0, 0, r.w, 1.0, r.h, r.light ? "var(--room-desk)" : "var(--room-screen)", "rack" + (r.light ? " rack--light" : ""));
    var rows = "";
    var inset = 0.14 * U;
    var slotH = ((r.h - 0.3) * U) / r.slots;
    for (var i = 0; i < r.slots; i++) {
      var on = i < r.used;
      var y = inset + i * slotH;
      rows +=
        '<rect x="' + inset.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + ((r.w - 0.28) * U).toFixed(1) + '" height="' + (slotH - 2.5).toFixed(1) + '" rx="2" class="slot' + (on ? " slot--on" : "") + '"/>' +
        '<circle cx="' + (inset + 0.16 * U).toFixed(1) + '" cy="' + (y + (slotH - 2.5) / 2).toFixed(1) + '" r="' + (U * 0.065).toFixed(1) + '" class="led' + (on ? " led--on" : "") + '" style="--hue:var(--hue-' + r.hues[i % r.hues.length] + ')"/>';
    }
    return out + onBackWall(r.x, 1.0, r.h, rows);
  }

  function pigeonholes(full) {
    var cells = "";
    var cw = (3.0 * U) / 4;
    var ch = (2.2 * U) / 4;
    var mail = full ? [2, 3, 2, 3, 3, 2, 3, 2, 2, 3, 3, 3, 3, 2, 3, 2] : [0, 2, 1, 0, 1, 3, 0, 2, 1, 0, 0, 1, 2, 0, 1, 0];
    for (var r = 0; r < 4; r++)
      for (var c = 0; c < 4; c++) {
        var n = mail[r * 4 + c];
        cells += '<rect x="' + (c * cw + 3).toFixed(1) + '" y="' + (r * ch + 5).toFixed(1) + '" width="' + (cw - 6).toFixed(1) + '" height="' + (ch - 5).toFixed(1) + '" rx="2" class="hole"/>';
        for (var k = 0; k < n; k++) {
          var you = (r === 1 && c === 1 && k === 0) || (r === 2 && c === 2 && k === 1) || (full && (r + c + k) % 5 === 0);
          cells += '<rect x="' + (c * cw + 6 + k * 2).toFixed(1) + '" y="' + (r * ch + ch - 11 - k * 3).toFixed(1) + '" width="' + (cw - 14).toFixed(1) + '" height="' + (U * 0.26).toFixed(1) + '" rx="1.5" class="env' + (you ? " env--you" : "") + '"/>';
        }
      }
    return box(0, 0.8, 0, 0.62, 3.0, 2.4, "var(--room-wood)", "wood") + onSideWall(0.62, 3.8, 2.4, cells);
  }

  /* ------------------------------------------------------------------ the floor plans */

  var RUGS = [
    { x: 3.0, y: 4.5, w: 6.7, d: 6.3, proj: "webshop", label: "webshop" },
    { x: 10.7, y: 2.4, w: 6.5, d: 6.0, proj: "payments", label: "payments-api" },
    { x: 10.7, y: 9.0, w: 6.5, d: 6.0, proj: "ops", label: "ops" },
  ];
  var SEATS = [
    [5.0, 5.9],
    [8.3, 5.9],
    [5.0, 8.9],
    [8.3, 8.9],
    [12.7, 3.8],
    [16.0, 3.8],
    [12.7, 6.6],
    [16.0, 6.6],
    [12.7, 10.2],
    [16.0, 10.2],
    [12.7, 13.1],
    [16.0, 13.1],
  ];
  function place(list) {
    return list.map(function (s, i) {
      s.x = SEATS[i][0];
      s.y = SEATS[i][1];
      return s;
    });
  }

  var TODAY = {
    counts: "3 waiting on you",
    board: true,
    racks: [
      { x: 4.3, w: 1.8, h: 1.7, slots: 6, used: 5, label: "studio-mac", light: true, hues: ["peach", "mint", "lime", "teal", "grape"] },
      { x: 7.1, w: 1.8, h: 2.5, slots: 8, used: 8, label: "build-box-1", hues: ["sky", "grape", "sky", "iris", "orchid", "peach", "teal", "lime"] },
      { x: 9.9, w: 1.8, h: 2.5, slots: 8, used: 3, label: "build-box-2", hues: ["mint", "orchid", "sky"] },
    ],
    triage: "next 11:00",
    seats: place([
      { name: "Refactor cart totals", pose: "working", tag: "22m" },
      { name: "Fix 3-D Secure checkout for EU cards", away: true },
      { name: "Label new issues", pose: "paused", tag: "paused" },
      { name: "Write checkout e2e tests", pose: "working", tag: "14m" },
      { name: "Fix bug", label: "Webhook retry backoff", pose: "working", tag: "3m" },
      { name: "Ship release", away: true },
      { name: "Add iDEAL research", pose: "idle", tag: "idle 1h", mug: true },
      { name: "Payout email copy", pose: "working", tag: "4m" },
      { name: "Investigate", label: "Investigate backup timeouts", pose: "working", tag: "6m" },
      { name: "Migrate ops dashboards", away: true },
      { name: "Rotate B2 backup keys", pose: "working", tag: "9m" },
      { name: "Update status page copy", pose: "working", tag: "2m" },
    ]),
    bench: ["Invoice PDF layout", "Grafana alert tuning", "Sign-up funnel notes", "Discount code edge cases", "README for payments-api"],
    coffee: ["B2 bucket audit", "Refund webhook test"],
    sofa: [
      { name: "Ada", pose: "working", laptop: true, tag: "heartbeat" },
      { name: "Cart total rounding on discounts", pose: "idle" },
      { name: "Milo", pose: "idle", mug: true, tag: "idle" },
    ],
    queue: [
      { name: "Fix 3-D Secure checkout for EU cards", ask: "Run git push?" },
      { name: "Migrate ops dashboards", ask: "Keep the old Grafana folder?" },
      { name: "Ship release", ask: "Publish to npm?" },
    ],
  };

  // At 10x the floor keeps its shape: one desk per workflow or project, with a head count, one
  // rack per runner, the bench holding the idle crowd, and the queue folding into a "+7" sign.
  var SWARM = {
    counts: "10 waiting on you",
    rackTag: { x: 9.7, h: 2.5, html: "<b>9 machines</b><span>131 of 150 slots · 2 at cap</span>" },
    racks: [0, 1, 2, 3, 4, 5, 6, 7, 8].map(function (i) {
      var used = [5, 8, 8, 6, 7, 3, 8, 5, 6][i];
      return { x: 5.2 + i * 1.12, w: 0.98, h: i === 0 ? 1.7 : 2.5, slots: i === 0 ? 6 : 8, used: i === 0 ? 5 : used, light: i === 0, hues: ["sky", "grape", "peach", "iris", "orchid", "teal", "lime", "mint"].slice(i % 4).concat(["sky", "grape", "peach", "iris"]) };
    }),
    triage: "60 Proposals since 07:00",
    mailFull: true,
    seats: place([
      { name: "Fix bug", pose: "working", tag: "×9" },
      { name: "Label new issues", pose: "working", tag: "×6" },
      { name: "Flaky test hunt", pose: "working", tag: "×4" },
      { name: "Refactor cart totals", label: "Threads", pose: "working", tag: "×5" },
      { name: "Fix bug", pose: "working", tag: "×5" },
      { name: "Dependency bumps", pose: "working", tag: "×6" },
      { name: "Draft reply", pose: "working", tag: "×4" },
      { name: "Add iDEAL research", label: "Threads", pose: "working", tag: "×3" },
      { name: "Investigate", pose: "working", tag: "×3" },
      { name: "Nightly backup check", pose: "working", tag: "×2" },
      { name: "Rotate B2 backup keys", label: "Threads", pose: "working", tag: "×3" },
      { name: "Ship release", away: true },
    ]),
    bench: ["Invoice PDF layout", "Grafana alert tuning", "Sign-up funnel notes", "Discount code edge cases", "README for payments-api"],
    benchTag: "<b>73 idle</b><span>on the bench</span>",
    coffee: ["B2 bucket audit", "Refund webhook test"],
    sofa: [
      { name: "Ada", pose: "working", laptop: true, tag: "heartbeat" },
      { name: "Nell", pose: "idle" },
      { name: "Milo", pose: "idle", mug: true, tag: "idle" },
    ],
    queue: [
      { name: "Fix 3-D Secure checkout for EU cards", ask: "Run git push?" },
      { name: "Migrate ops dashboards", ask: "Keep the old Grafana folder?" },
      { name: "Ship release", ask: "Publish to npm?" },
    ],
    queueMore: 7,
  };

  /* ------------------------------------------------------------------ assembly */

  function build(host) {
    var swarm = document.documentElement.dataset.state === "swarm";
    var data = swarm ? SWARM : TODAY;
    var rect = host.getBoundingClientRect();
    var sw = rect.width;
    var sh = rect.height;
    // fit the room to the stage, leaving air for the labels above the walls
    var span = W + D;
    U = Math.min(36, (sw - 96) / (span * 0.8660254), (sh - 72) / (span * 0.5 + H + 0.9));
    C = U * 0.8660254;
    S = U * 0.5;
    OX = sw / 2 + ((D - W) * C) / 2;
    OY = (sh - (span * S + (H + 0.9) * U)) / 2 + (H + 0.4) * U + 6;

    var items = [];
    function add(key, svg) {
      items.push({ k: key, svg: svg });
    }
    var tags = [];
    function tag(x, y, z, html, cls) {
      var p = P(x, y, z);
      tags.push('<div class="tag' + (cls ? " " + cls : "") + '" style="left:' + p[0].toFixed(1) + "px;top:" + p[1].toFixed(1) + 'px">' + html + "</div>");
    }
    var headZ = 0.46 + (spriteSize() * 0.86) / U; // just above a seated colleague's head

    var floor = room(data);
    var rugs = RUGS.map(function (r) {
      return (
        patch(r.x, r.y, r.w, r.d, "rug", "fill:var(--proj-" + r.proj + ")") +
        patch(r.x + 0.22, r.y + 0.22, r.w - 0.44, r.d - 0.44, "rug-edge") +
        onFloor(r.x + r.w - 0.5, r.y + r.d - 0.3, '<text class="stencil" text-anchor="end" style="font-size:' + (U * 0.4).toFixed(1) + 'px">' + r.label + "</text>")
      );
    }).join("");
    rugs += patch(17.9, 6.0, 3.8, 9.4, "rug", "fill:var(--room-lounge)");
    rugs += onFloor(18.3, 15.1, '<text class="stencil" style="font-size:' + (U * 0.4).toFixed(1) + 'px">lounge</text>');
    // the spot beside your desk where colleagues queue
    rugs += onFloor(5.3, 14.55, '<text class="stencil stencil--you" style="font-size:' + (U * 0.4).toFixed(1) + 'px">' + data.counts + "</text>");

    // along the back walls
    add(1, pigeonholes(data.mailFull));
    data.racks.forEach(function (r) {
      add(1 + r.x * 0.01, rack(r));
      if (r.label) tag(r.x + r.w / 2, 0.5, r.h + 0.18, "<b>" + r.label + "</b><span" + (r.used === r.slots ? ' class="cap"' : "") + ">" + r.used + " of " + r.slots + (r.used === r.slots ? " · at cap" : "") + "</span>", "tag--rack");
    });
    if (data.rackTag) tag(data.rackTag.x, 0.5, data.rackTag.h + 0.18, data.rackTag.html, "tag--rack");
    add(
      2,
      box(16.9, 0, 0, 3.6, 0.95, 0.95, "var(--room-wood)", "wood") +
        box(17.25, 0.15, 0.95, 0.75, 0.62, 0.82, "var(--room-screen)", "machine") +
        box(17.42, 0.62, 1.12, 0.42, 0.18, 0.1, "var(--room-metal)") +
        mug(18.5, 0.36, 0.95) +
        mug(19.1, 0.5, 0.95, "var(--you)"),
    );
    add(3, plant(20.9, 0.3, true));

    // Triage sorts the post by the pigeonholes
    add(3.9, seat({ name: "Triage", pose: "working", x: 2.4, y: 2.4 }) + box(1.02, 2.7, DESK + 0.07, 0.34, 0.26, 0.1, "var(--room-desk)") + box(1.05, 2.72, DESK + 0.17, 0.28, 0.22, 0.07, "var(--you)"));
    tag(2.4, 2.4, headZ, "<b>Triage</b><span>" + data.triage + "</span>");

    // the window bench, where idle colleagues sit in the sun
    add(5, box(0.3, 5.3, 0, 0.85, 6.9, 0.4, "var(--room-wood)", "wood"));
    data.bench.forEach(function (n, i) {
      add(6 + i * 1.4, sprite(n, "idle", 0.72, 5.95 + i * 1.35, 0.4));
    });
    if (data.benchTag) tag(0.72, 8.9, 0.4 + (spriteSize() * 0.86) / U, data.benchTag, "tag--quiet");

    // desks on the project rugs
    data.seats.forEach(function (s) {
      add(s.x + s.y, seat(s));
      if (s.tag) tag(s.x, s.y, headZ, "<b>" + (s.label || s.name) + "</b><span>" + s.tag + "</span>", s.pose === "paused" || s.pose === "idle" ? "tag--quiet" : "");
    });

    // the coffee corner
    data.coffee.forEach(function (n, i) {
      var x = 17.4 + i * 1.6;
      var y = 2.0 + i * 0.25;
      add(x + y, ellipse(x, y, 0, 0.36, "shadow") + sprite(n, "idle", x, y, 0) + mug(x + 0.3, y + 0.2, 0.5));
    });

    // the lounge
    var sofaX = 18.2;
    var sofaY = 7.4;
    data.sofa.forEach(function (s, i) {
      s.x = sofaX + 0.72 + i * 1.0;
      s.y = sofaY + 0.95;
      if (s.tag) tag(s.x, s.y, 0.42 + (spriteSize() * 0.86) / U, "<b>" + s.name + "</b><span>" + s.tag + "</span>", s.pose === "idle" ? "tag--quiet" : "");
    });
    add(sofaX + sofaY + 1.4, sofa(sofaX, sofaY, 3.4, data.sofa));
    add(18.7 + 10.6 + 0.9, box(18.7, 10.6, 0, 2.2, 0.9, 0.36, "var(--room-wood)", "wood") + mug(19.1, 10.9, 0.36) + plant(20.0, 10.75, false));
    add(20.1 + 13.4, beanbag(20.1, 13.4, "Juno"));
    tag(20.0, 13.3, 0.5 + (spriteSize() * 0.86) / U, "<b>Juno</b><span>asleep</span>", "tag--quiet");
    add(21.1 + 6.3, plant(21.05, 6.2, true));
    add(0.4 + 14.9, plant(0.4, 14.95, true));

    // your desk, and the queue of colleagues waiting beside it
    add(
      2.2 + 12.1,
      box(3.12, 11.72, 0, 0.16, 0.16, 0.42, "var(--room-metal)") +
        box(2.7, 11.62, 0.42, 1.0, 0.86, 0.13, "var(--you)", "you-chair") +
        box(2.72, 11.46, 0.5, 0.96, 0.16, 0.95, "var(--you)", "you-chair"),
    );
    add(
      2.2 + 13.9 + 0.1,
      box(2.0, 12.72, 0, 0.1, 1.1, DESK, "var(--room-metal)") +
        box(4.5, 12.72, 0, 0.1, 1.1, DESK, "var(--room-metal)") +
        box(1.9, 12.66, DESK, 2.8, 1.24, 0.07, "var(--room-desk)", "desk") +
        box(2.8, 13.05, DESK + 0.07, 0.8, 0.54, 0.035, "var(--room-metal)") +
        quad(P(2.8, 13.59, DESK + 0.1), P(3.6, 13.59, DESK + 0.1), P(3.6, 13.66, DESK + 0.62), P(2.8, 13.66, DESK + 0.62), "lid") +
        onBackWall(3.2, 13.66, DESK + 0.38, '<circle r="' + (U * 0.1).toFixed(1) + '" class="sticker"/>') +
        mug(4.05, 13.2, DESK + 0.07, "var(--you)") +
        box(2.1, 12.95, DESK + 0.07, 0.42, 0.56, 0.05, "var(--room-desk)") +
        box(2.12, 12.98, DESK + 0.12, 0.38, 0.5, 0.05, "var(--you-tint)"),
    );
    tag(3.9, 12.5, 1.7, "<b>Your desk</b>", "tag--you");
    data.queue.forEach(function (q, i) {
      var x = 5.8 + i * 1.6;
      var y = 13.25;
      add(x + y, ellipse(x, y, 0, 0.36, "shadow") + sprite(q.name, "waiting", x, y, 0));
      // only the head of the queue speaks; the others raise a hand and wait their turn
      tag(x, y, (spriteSize() * 0.92) / U, i === 0 ? q.ask : "?", i === 0 ? "tag--ask is-first" : "tag--ask tag--wait");
    });
    if (data.queueMore) tag(5.8 + data.queue.length * 1.6 - 0.2, 13.25 + 0.3, 0.2, "+" + data.queueMore + " more", "tag--more");

    items.sort(function (a, b) {
      return a.k - b.k;
    });

    host.innerHTML =
      '<svg class="floor" width="' + sw + '" height="' + sh + '" viewBox="0 0 ' + sw + " " + sh + '" role="img" aria-label="The Office: every live session sits here as a colleague">' +
      floor +
      rugs +
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
    // the 10x floor also swaps the head counts in the bar and the queue card
    if (document.documentElement.dataset.state === "swarm") {
      document.querySelectorAll("[data-swarm]").forEach(function (el) {
        el.textContent = el.dataset.swarm;
      });
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
