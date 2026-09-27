/* Metro Wayfinding - the office. PROTOTYPE.
   Draws the Fleet as an isometric office into svg#office-scene. Every piece of work arrives through
   the wall on its Connection's line, passes the Triage desk, and follows a floor line to the desk
   of the session doing it. State is the same mark the lists use, floating over the agent's head.

   The floor lines are a quiet layer: thin and grey, so the people, the desks and the sessions
   waiting on you carry the scene. A desk's lines take their Connection colors while the desk is
   selected or hovered, and a source's lines while its mark on the wall is hovered. With
   data-flow="on" on <html> (office.html sets it from ?flow=on) every line is in color and the
   parcels ride them.

   With data-state="swarm" on <html> it draws the same Fleet at 10x instead: a building with one
   floor per runner, and the lines climbing its core with a station on every floor. */
(function () {
  var scene = document.getElementById("office-scene");
  if (!scene) return;
  var swarm = document.documentElement.dataset.state === "swarm";
  var still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ------------------------------------------------------------ projection
  // One floor unit is 17.3px along either floor axis; one unit of height is 17px.
  var O = swarm ? [392, 446] : [470, 124];
  var KX = 15;
  var KY = 8.66;
  var KZ = 17;
  function P(x, y, z) {
    return [O[0] + (x - y) * KX, O[1] + (x + y) * KY - (z || 0) * KZ];
  }
  function r1(v) {
    return Math.round(v * 10) / 10;
  }
  function pt(x, y, z) {
    var p = P(x, y, z);
    return r1(p[0]) + "," + r1(p[1]);
  }
  function darker(color, k) {
    return "color-mix(in oklch, " + color + ", black " + k + "%)";
  }
  function poly(corners, fill, cls) {
    var points = corners
      .map(function (c) {
        return pt(c[0], c[1], c[2]);
      })
      .join(" ");
    return '<polygon points="' + points + '" style="fill:' + fill + '"' + (cls ? ' class="' + cls + '"' : "") + "/>";
  }
  // Returns the three faces a viewer at the front corner sees: the two front sides, then the top.
  function box(x0, y0, z0, x1, y1, z1, color, cls) {
    cls = cls || "of-e";
    return (
      poly([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], darker(color, 6), cls) +
      poly([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], darker(color, 13), cls) +
      poly([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], color, cls)
    );
  }
  // Builds an SVG path along floor points at height z, rounding each corner. The projection is
  // affine, so a quadratic curve through projected points is the projection of the floor curve.
  function route(points, z, radius) {
    z = z || 0;
    radius = radius || 0.6;
    var d = "M" + pt(points[0][0], points[0][1], z);
    for (var i = 1; i < points.length - 1; i++) {
      var a = points[i - 1];
      var v = points[i];
      var b = points[i + 1];
      var la = Math.hypot(v[0] - a[0], v[1] - a[1]);
      var lb = Math.hypot(b[0] - v[0], b[1] - v[1]);
      var r = Math.min(radius, la / 2, lb / 2);
      d +=
        "L" + pt(v[0] - ((v[0] - a[0]) / la) * r, v[1] - ((v[1] - a[1]) / la) * r, z) +
        "Q" + pt(v[0], v[1], z) + " " + pt(v[0] + ((b[0] - v[0]) / lb) * r, v[1] + ((b[1] - v[1]) / lb) * r, z);
    }
    var e = points[points.length - 1];
    return d + "L" + pt(e[0], e[1], z);
  }
  function hue(id) {
    return "var(" + window.MetroHue[id] + ")";
  }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  }
  // Paints text flat onto a wall or the floor. The plane's two unit vectors become the text's
  // x and y axes, so the letters lie in the plane without being scaled.
  var PLANES = {
    wallX: [0.866, -0.5, 0, 1], // the left wall, x = 0, text running toward the back corner
    wallY: [0.866, 0.5, 0, 1], // the right wall, y = 0
    floor: [0.866, 0.5, -0.866, 0.5], // the floor, text running along +x
  };
  function painted(plane, x, y, z, body) {
    var m = PLANES[plane];
    var p = P(x, y, z);
    return '<g transform="matrix(' + m.join(",") + "," + r1(p[0]) + "," + r1(p[1]) + ')">' + body + "</g>";
  }
  // An enamel sign: an ink plate with the name, and the count after it in a lighter weight.
  function sign(plane, x, y, z, name, count, width) {
    var w = width;
    return painted(
      plane,
      x,
      y,
      z,
      '<rect class="of-sign" x="0" y="-13" width="' + w + '" height="17" rx="4"/>' +
        '<text class="of-sign-t" x="8" y="-1.4">' + esc(name) + (count ? '<tspan class="of-sign-n" dx="6">' + esc(count) + "</tspan>" : "") + "</text>"
    );
  }
  function mark(name, cls, cx, cy, size) {
    size = size || 14;
    var h = size / 2;
    return (
      '<circle class="of-roundel" cx="' + r1(cx) + '" cy="' + r1(cy) + '" r="' + (h + 3.2) + '"/>' +
      window.MetroMark(name, "mk-" + name + " " + cls, ' x="' + r1(cx - h) + '" y="' + r1(cy - h) + '" width="' + size + '" height="' + size + '"')
    );
  }
  function label(x, y, anchor, name, note, noteCls) {
    var t = '<text class="of-lab" x="' + r1(x) + '" y="' + r1(y) + '" text-anchor="' + anchor + '">' + esc(name) + "</text>";
    if (note) t += '<text class="of-note ' + noteCls + '" x="' + r1(x) + '" y="' + r1(y + 13.5) + '" text-anchor="' + anchor + '">' + esc(note) + "</text>";
    return t;
  }
  // A name tag: the label on a small plate, so it stays readable where it crosses a floor line.
  // The plate is sized after the text is laid out; see fitTags.
  function tag(x, y, anchor, name, note, noteCls) {
    return '<g class="of-tag">' + label(x, y, anchor, name, note, noteCls) + "</g>";
  }
  function fitTags() {
    scene.querySelectorAll(".of-tag").forEach(function (g) {
      var b = g.getBBox();
      var r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      r.setAttribute("x", r1(b.x - 7));
      r.setAttribute("y", r1(b.y - 4));
      r.setAttribute("width", r1(b.width + 14));
      r.setAttribute("height", r1(b.height + 8));
      r.setAttribute("rx", "6");
      r.setAttribute("class", "of-plate");
      g.insertBefore(r, g.firstChild);
    });
  }

  var STATE_CLS = { work: "live", wait: "attn", paused: "muted", idle: "faint" };

  // An agent: a pill with two eyes. Waiting agents raise a hand. An Assistant with no session is
  // asleep and closes its eyes; asleep is not a session state, so it has no mark of its own.
  function agent(x, y, z, state, asleep) {
    var p = P(x, y, z);
    var cx = p[0];
    var by = p[1];
    var s =
      '<g class="of-agent' + (state === "work" ? " is-work" : "") + '">' +
      '<ellipse class="of-shadow" cx="' + r1(cx + 2) + '" cy="' + r1(by + 1) + '" rx="10" ry="4.5"/>' +
      '<rect class="of-body" x="' + r1(cx - 8) + '" y="' + r1(by - 27) + '" width="16" height="27" rx="8"/>' +
      '<path class="of-body-shade" d="M' + r1(cx + 2) + " " + r1(by - 26.2) + "a8 8 0 0 1 5.2 7.5v11.5a8 8 0 0 1-5.2 7.5z" + '"/>';
    var ey = by - 18.5;
    if (asleep) {
      s +=
        '<path class="of-eye-shut" d="M' + r1(cx - 5.2) + " " + r1(ey) + "q1.4 1.4 2.8 0M" + r1(cx + 0.2) + " " + r1(ey) + 'q1.4 1.4 2.8 0"/>';
    } else {
      s += '<circle class="of-eye" cx="' + r1(cx - 3.4) + '" cy="' + r1(ey) + '" r="1.45"/><circle class="of-eye" cx="' + r1(cx + 1.8) + '" cy="' + r1(ey) + '" r="1.45"/>';
    }
    if (state === "wait") {
      s +=
        '<path class="of-arm" d="M' + r1(cx - 7) + " " + r1(by - 12) + "q-6 -3 -6.5 -14" + '"/>' +
        '<circle class="of-hand" cx="' + r1(cx - 13.4) + '" cy="' + r1(by - 27.5) + '" r="2.6"/>';
    }
    return s + "</g>";
  }

  // A desk with its laptop turned toward the agent, so the viewer sees the lid.
  function desk(x, y, occupied) {
    var s = box(x - 1.2, y - 0.6, 0, x + 1.2, y + 0.6, 0.72, "var(--raised)");
    if (occupied) {
      s += box(x - 0.42, y - 0.36, 0.72, x + 0.42, y + 0.12, 0.76, "var(--sunken)");
      s += poly([[x - 0.42, y - 0.36, 0.76], [x + 0.42, y - 0.36, 0.76], [x + 0.42, y - 0.36, 1.36], [x - 0.42, y - 0.36, 1.36]], "var(--of-lid)", "of-e");
    }
    return s;
  }

  // ------------------------------------------------------------ today
  function drawOffice() {
    var W = 44;
    var D = 28;
    var WALL = 3;
    var out = { floor: [], lines: [], things: [], top: [] };

    // The slab, its soft shadow, and the two back walls.
    out.floor.push(
      '<polygon class="of-drop" points="' + [pt(0, 0, -1.4), pt(W, 0, -1.4), pt(W, D, -1.4), pt(0, D, -1.4)].join(" ") + '"/>' +
        box(0, 0, -0.7, W, D, 0, "var(--of-floor)", "of-slab")
    );
    out.floor.push(box(-0.35, -0.35, 0, 0, D, WALL, "var(--of-wall)", "of-e") + box(0, -0.35, 0, W, 0, WALL, "var(--of-wall)", "of-e"));
    // Skirting: a darker strip where each wall meets the floor.
    out.floor.push(
      poly([[0, 0, 0], [0, D, 0], [0, D, 0.16], [0, 0, 0.16]], "var(--of-skirt)") + poly([[0, 0, 0], [W, 0, 0], [W, 0, 0.16], [0, 0, 0.16]], "var(--of-skirt)")
    );

    // Rooms: the runners, the mailroom and the lounge sit on the corridor floor as lighter platforms.
    var rooms = [
      [0.4, 0.4, 9.4, 9.6],
      [11, 0.4, 25.2, 9.6],
      [27, 0.4, 43.6, 9.6],
      [11, 16, 43.6, 27.6],
      [0.4, 16.4, 9.2, 27.6],
    ];
    rooms.forEach(function (r) {
      out.floor.push(poly([[r[0], r[1], 0], [r[2], r[1], 0], [r[2], r[3], 0], [r[0], r[3], 0]], "var(--of-room)", "of-room"));
    });

    // Fare zones: every occupied desk stands on a rug in its project's zone tint. The 14 desk
    // sessions plus Ada's and Milo's in the lounge are the 16 live sessions the sidebar counts:
    //   studio-mac   Fix 3-D Secure, Migrate ops dashboards, the Stripe changelog, Ada, Milo (5 of 6)
    //   build-box-2  Ship release v2.15, Add iDEAL research, the draft reply to Jonas (3 of 8)
    //   build-box-1  six working sessions, the idle Tidy checkout CSS and the paused Label run (8 of 8)
    var desks = [
      { id: "fix", x: 14, y: 7.3, s: "wait", zone: "webshop", callout: true },
      { id: "migrate", x: 18, y: 7.3, s: "wait", zone: "ops", name: "Migrate ops dashboards", note: "waiting on you", at: "r" },
      { id: "changelog", x: 22, y: 7.3, s: "idle", zone: "webshop" },
      { x: 14, y: 3.3 },
      { x: 18, y: 3.3 },
      { x: 22, y: 3.3 },
      { id: "ship", x: 30, y: 7.3, s: "wait", zone: "payments", name: "Ship release v2.15", note: "waiting on you", at: "r" },
      { id: "ideal", x: 34, y: 7.3, s: "idle", zone: "payments", name: "Add iDEAL research", note: "idle 1h", at: "r" },
      { id: "jonas", x: 38, y: 7.3, s: "work", zone: "payments" },
      { x: 42, y: 7.3 },
      { x: 30, y: 3.3 },
      { x: 34, y: 3.3 },
      { x: 38, y: 3.3 },
      { x: 42, y: 3.3 },
      { id: "cart", x: 14.5, y: 19.4, s: "work", zone: "webshop", name: "Refactor cart totals", note: "working 22m", at: "l" },
      { id: "payout", x: 21.5, y: 19.4, s: "work", zone: "payments" },
      { id: "rounding", x: 28.5, y: 19.4, s: "work", zone: "webshop" },
      { id: "webhook", x: 35.5, y: 19.4, s: "work", zone: "payments", name: "Webhook retry backoff", note: "working 3m", at: "r" },
      { id: "secrets", x: 18, y: 24.9, s: "work", zone: "ops" },
      { id: "tidy", x: 25, y: 24.9, s: "idle", zone: "webshop" },
      { id: "backup", x: 32, y: 24.9, s: "work", zone: "ops", name: "Investigate backup timeouts", note: "working 6m", at: "l" },
      { id: "label", x: 39, y: 24.9, s: "paused", zone: "webshop", name: "Label new issues", note: "paused · 34 events held", at: "r" },
    ];
    desks.forEach(function (d) {
      if (!d.s) return;
      var z = "var(--zone-" + d.zone + ")";
      out.floor.push(poly([[d.x - 1.75, d.y - 2.3, 0], [d.x + 1.75, d.y - 2.3, 0], [d.x + 1.75, d.y + 1.05, 0], [d.x - 1.75, d.y + 1.05, 0]], z, "of-rug"));
    });

    // Painted floor text: the runner in the front room has no wall to hang a sign on.
    out.floor.push(
      painted("floor", 12, 27, 0, '<text class="of-paint">build-box-1<tspan class="of-paint-n" dx="8">8 of 8 · at cap</tspan></text>')
    );

    // ---- lines. Incoming: each Connection enters through the left wall and meets the Triage desk.
    var incoming = ["sentry", "gmail", "posthog", "github", "stripe", "intercom", "grafana", "cron"];
    function inY(i) {
      return 10.55 + i * 0.68;
    }
    var casing = [];
    var color = [];
    // Draws one line from Connection `id`. `serves` lists the desks the line leads to, so hovering
    // one of those desks colors it; a line into Triage serves no desk and is colored by its source.
    function line(id, points, serves, dashed) {
      var d = route(points);
      var keys = ' data-src="' + id + '" data-desk="' + (serves || "") + '"';
      casing.push('<path class="of-case"' + keys + ' d="' + d + '"/>');
      color.push('<path class="of-ln' + (dashed ? " of-ln--down" : "") + '"' + keys + ' d="' + d + '" style="--hue:' + hue(id) + '"/>');
      return d;
    }
    var paths = {};
    incoming.forEach(function (id, i) {
      paths["in-" + id] = line(id, [[0, inY(i)], [5.4, inY(i)]]);
    });

    // Outgoing, back to front. Lines that turn toward the back rooms turn earliest when they run
    // furthest back, and lines that turn toward the front room turn earliest when they run furthest
    // forward, so no two lines ever cross.
    paths.fix = [
      line("sentry", [[6, 10.6], [13.4, 10.6], [13.4, 8.4]], "fix"),
      line("gmail", [[6, 11], [13.8, 11], [13.8, 8.4]], "fix"),
      line("posthog", [[6, 11.4], [14.2, 11.4], [14.2, 8.4]], "fix"),
      line("github", [[6, 11.8], [14.6, 11.8], [14.6, 8.4]], "fix"),
    ];
    paths.ship = line("you", [[6, 12.2], [29.5, 12.2], [29.5, 8.4]], "ship migrate");
    line("you", [[16.6, 12.2], [18, 12.2], [18, 8.4]], "migrate");
    paths.jonas = line("gmail", [[6, 12.6], [38, 12.6], [38, 8.4]], "jonas");
    paths.label = line("github", [[6, 13], [39.4, 13], [39.4, 22.3]], "label");
    paths.webhook = line("stripe", [[6, 13.4], [35.7, 13.4], [35.7, 17.2]], "webhook");
    line("sentry", [[6, 13.8], [35.3, 13.8], [35.3, 17.2]], "webhook");
    paths.backup = line("grafana", [[6, 14.2], [32.2, 14.2], [32.2, 22.3]], "backup");
    line("cron", [[6, 14.6], [31.8, 14.6], [31.8, 22.3]], "backup");
    // The Fix bug run on the Task "Cart total rounding on discounts", which Sentry events feed.
    paths.rounding = line("sentry", [[6, 15], [28.5, 15], [28.5, 17.2]], "rounding");
    // Work you started in the front room shares one ink line that branches to each desk.
    paths.payout = line("you", [[6, 15.4], [21.5, 15.4], [21.5, 17.2]], "payout cart secrets");
    [
      ["cart", 14.5, 17.2],
      ["secrets", 18, 22.3],
    ].forEach(function (s) {
      paths[s[0]] = line("you", [[s[1] - 1.4, 15.4], [s[1], 15.4], [s[1], s[2]]], s[0]);
    });

    // Channels: the Assistants' lines come through the wall into the lounge. Discord is down, so
    // its line is dashed.
    line("discord", [[0, 18.2], [7.6, 18.2], [7.6, 22.4]], "juno", true);
    line("slack", [[0, 18.8], [5.2, 18.8], [5.2, 22.4]], "milo ada");
    line("slack", [[1.6, 18.8], [3, 18.8], [3, 22.4]], "ada");
    line("webchat", [[0, 19.4], [2.6, 19.4], [2.6, 22.4]], "ada");

    out.lines.push(casing.join("") + color.join(""));

    // Termini: a single line ends at a ring; several lines ending side by side share a capsule.
    function capsule(desk, x0, y0, x1, y1) {
      var d = "M" + pt(x0, y0, 0) + "L" + pt(x1, y1, 0);
      var key = ' data-desk="' + desk + '"';
      return '<path class="of-cap-o"' + key + ' d="' + d + '"/><path class="of-cap-i"' + key + ' d="' + d + '"/>';
    }
    out.lines.push(
      capsule("fix", 13.4, 8.4, 14.6, 8.4) +
        capsule("migrate", 18, 8.4, 18, 8.4) +
        capsule("ship", 29.5, 8.4, 29.5, 8.4) +
        capsule("webhook", 35.3, 17.2, 35.7, 17.2) +
        capsule("backup", 31.8, 22.3, 32.2, 22.3) +
        capsule("label", 39.4, 22.3, 39.4, 22.3) +
        capsule("jonas", 38, 8.4, 38, 8.4) +
        capsule("payout", 21.5, 17.2, 21.5, 17.2) +
        capsule("rounding", 28.5, 17.2, 28.5, 17.2) +
        capsule("cart", 14.5, 17.2, 14.5, 17.2) +
        capsule("secrets", 18, 22.3, 18, 22.3) +
        capsule("ada", 2.6, 22.4, 3, 22.4) +
        capsule("milo", 5.2, 22.4, 5.2, 22.4) +
        capsule("juno", 7.6, 22.4, 7.6, 22.4)
    );

    // ---- things, drawn back to front by depth.
    var things = [];
    function add(depth, svg) {
      things.push([depth, svg]);
    }

    // The Triage desk: the capsule every Connection line passes through.
    add(
      5.6 + 12.7,
      box(5.1, 10.2, 0, 6.1, 15.6, 0.95, "var(--casing)", "of-tri") +
        painted("wallX", 6.1, 15.1, 0.2, '<text class="of-tri-t">Triage</text>')
    );

    // Pigeonholes on the mailroom wall: Proposals waiting in Intake, colored by their lead line.
    var shelf = box(0, 1.4, 0.3, 0.9, 8.6, 1.95, "var(--of-wood)", "of-e");
    var holes = ["sentry", "", "grafana", "", "", "intercom", "stripe", "", "", "cron", "", ""];
    for (var col = 0; col < 6; col++) {
      for (var row = 0; row < 2; row++) {
        var y0 = 1.65 + col * 1.15;
        var z0 = 0.5 + row * 0.72;
        shelf += poly([[0.9, y0, z0], [0.9, y0 + 0.95, z0], [0.9, y0 + 0.95, z0 + 0.58], [0.9, y0, z0 + 0.58]], "var(--of-hole)");
        var h = holes[row * 6 + col];
        if (h) shelf += poly([[0.9, y0 + 0.2, z0], [0.9, y0 + 0.75, z0], [0.9, y0 + 0.75, z0 + 0.42], [0.9, y0 + 0.2, z0 + 0.42]], hue(h));
      }
    }
    add(0.45 + 5, shelf);
    // A sorting table in the mailroom, with the morning's post on it.
    add(4.5 + 4.2, box(3.2, 3, 0, 6.2, 5.4, 0.7, "var(--of-wood)") + box(4, 3.5, 0.7, 4.7, 4.1, 0.95, "var(--raised)") + box(4.9, 4.3, 0.7, 5.6, 4.9, 0.85, "var(--raised)"));

    desks.forEach(function (d) {
      add(d.x + d.y, desk(d.x, d.y, !!d.s));
      if (d.s) add(d.x + d.y - 1.4, '<g data-desk="' + d.id + '">' + agent(d.x - 0.1, d.y - 1.3, 0.28, d.s) + "</g>");
    });

    // The lounge: an armchair per Assistant, a rug, a lamp and a plant.
    out.floor.push(poly([[1.2, 21.4, 0], [8.6, 21.4, 0], [8.6, 25.6, 0], [1.2, 25.6, 0]], "var(--of-rug-lounge)", "of-rug"));
    // Juno is asleep: no session, so her mark is the idle one and her eyes are shut.
    var assistants = [
      { id: "ada", x: 2.8, s: "work", name: "Ada", note: "working" },
      { id: "milo", x: 5.2, s: "idle", name: "Milo", note: "idle" },
      { id: "juno", x: 7.6, s: "idle", asleep: true, name: "Juno", note: "asleep" },
    ];
    assistants.forEach(function (a) {
      var y = 23.9;
      add(
        a.x + y,
        box(a.x - 0.7, y - 0.75, 0, a.x + 0.7, y - 0.4, 1.35, "var(--of-chair)") +
          '<g data-desk="' + a.id + '">' + agent(a.x, y - 0.1, 0.35, a.s, a.asleep) + "</g>" +
          box(a.x - 0.7, y - 0.4, 0, a.x - 0.45, y + 0.6, 0.72, "var(--of-chair)") +
          box(a.x - 0.45, y - 0.4, 0, a.x + 0.45, y + 0.6, 0.42, "var(--of-chair)") +
          box(a.x + 0.45, y - 0.4, 0, a.x + 0.7, y + 0.6, 0.72, "var(--of-chair)")
      );
    });
    add(0.9 + 26.9, box(0.5, 26.4, 0, 1.3, 27.2, 0.6, "var(--of-pot)") + plant(0.9, 26.8, 0.6));
    add(0.9 + 16.9, box(0.5, 16.8, 0, 1.3, 17.6, 0.6, "var(--of-pot)") + plant(0.9, 17.2, 0.6));

    things.sort(function (a, b) {
      return a[0] - b[0];
    });

    // ---- wall signs, source marks and labels, on top of everything.
    var top = [];
    top.push(sign("wallX", 0, 8.4, 2.35, "Intake", "5 Proposals", 118));
    top.push(sign("wallX", 0, 27.2, 2.35, "Assistants", "3 · on studio-mac", 170));
    top.push(sign("wallY", 13.6, 0, 2.35, "studio-mac", "5 of 6", 118));
    top.push(sign("wallY", 29.6, 0, 2.35, "build-box-2", "3 of 8", 122));
    // Each incoming line's brand mark sits on the wall above the point where the line comes in,
    // alternating between two heights so neighbours never touch.
    // The mark is grey until its lines are lit, like the lines themselves.
    function source(id, p) {
      return (
        '<g class="of-srcmark" data-src="' + id + '" style="--hue:' + hue(id) + '"><circle class="of-hit" cx="' + r1(p[0]) + '" cy="' + r1(p[1]) + '" r="9"/>' +
        window.MetroBrand(id, "of-src", ' x="' + r1(p[0] - 5.5) + '" y="' + r1(p[1] - 5.5) + '" width="11" height="11"') + "</g>"
      );
    }
    incoming.forEach(function (id, i) {
      top.push(source(id, P(0, inY(i), i % 2 ? 1.95 : 0.95)));
    });
    ["discord", "slack", "webchat"].forEach(function (id, i) {
      top.push(source(id, P(0, 18.2 + i * 0.6, 1.05)));
    });

    // Triage's timetable sits on a plate beside the far end of its desk: open floor, where no line
    // runs under the text and the plate hides none of the source marks on the wall.
    var tp = P(5.6, 10.2, 0.95);
    top.push(tag(tp[0] + 22, tp[1] - 2, "start", "Triage", "09:00 · next 11:00", "faint"));

    desks.forEach(function (d) {
      if (!d.s) return;
      var p = P(d.x - 0.1, d.y - 1.3, 0.28);
      var mx = p[0];
      var my = p[1] - 38;
      // The decision open in the card at the top left is tied to its desk by a leader line.
      if (d.callout) {
        top.push(
          '<path class="of-leader" d="M340 96L' + r1(mx - 11) + " " + r1(my - 5) + '"/><circle class="of-leader-dot" cx="340" cy="96" r="2.5"/>' +
            '<circle class="of-focus" cx="' + r1(mx) + '" cy="' + r1(my) + '" r="14"/>'
        );
      }
      var g = mark(d.s, STATE_CLS[d.s], mx, my, d.name || d.callout ? 14 : 12);
      if (d.name) {
        var left = d.at === "l";
        g += tag(mx + (left ? -19 : 19), my - 2, left ? "end" : "start", d.name, d.note, STATE_CLS[d.s]);
      }
      top.push('<g data-desk="' + d.id + '">' + g + "</g>");
    });
    assistants.forEach(function (a) {
      var p = P(a.x, 23.8, 0.35);
      top.push(
        '<g data-desk="' + a.id + '">' + mark(a.s, STATE_CLS[a.s], p[0], p[1] - 38, 13) +
          '<text class="of-lab of-lab--c" x="' + r1(p[0]) + '" y="' + r1(p[1] + 30) + '" text-anchor="middle">' + a.name + "</text>" +
          '<text class="of-note of-lab--c ' + STATE_CLS[a.s] + '" x="' + r1(p[0]) + '" y="' + r1(p[1] + 43) + '" text-anchor="middle">' + a.note + "</text></g>"
      );
    });

    // Parcels: an event travelling from its Connection to the desk that works on it. They belong to
    // the event flow, so the stylesheet shows them only while the flow is on.
    var parcels = still
      ? ""
      : parcel(paths["in-sentry"], "sentry", 3.2, 0) +
        parcel(paths["in-grafana"], "grafana", 4, 1.6) +
        parcel(paths["in-stripe"], "stripe", 3.6, 2.4) +
        parcel(paths.payout, "you", 9, 2) +
        parcel(paths.webhook, "stripe", 10, 5) +
        parcel(paths.backup, "grafana", 9.5, 1);
    // The Label run is paused: its GitHub events wait in a pile at the end of the line.
    var pile = "";
    [
      [39.4, 21.3, 0],
      [39.4, 20.7, 0],
      [39.4, 21.3, 0.42],
    ].forEach(function (c) {
      pile += cube(c[0], c[1], c[2], "github");
    });

    scene.innerHTML =
      '<defs><filter id="of-blur" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="14"/></filter></defs>' +
      out.floor.join("") +
      out.lines.join("") +
      pile +
      things
        .map(function (t) {
          return t[1];
        })
        .join("") +
      parcels +
      top.join("");
    fitTags();
    lightLines("fix");
    // Lines themselves are not hover targets: they are thin and run close together.
    scene.addEventListener("pointerover", function (e) {
      var hit = e.target.closest("g[data-desk], g[data-src]");
      if (hit) lightLines(hit.dataset.desk, hit.dataset.src);
      else lightLines("fix");
    });
    scene.addEventListener("pointerleave", function () {
      lightLines("fix");
    });
  }

  // Colors the lines of one desk, or of one source, and greys every other line. A desk's lines
  // are the ones that lead to it plus the stretch from the wall to Triage for each of its sources.
  // The Fix 3-D Secure desk is selected (its decision is open in the card), so it is lit whenever
  // nothing else is hovered.
  function lightLines(desk, src) {
    var sources = {};
    if (desk) {
      scene.querySelectorAll(".of-ln").forEach(function (p) {
        if (p.dataset.desk.split(" ").indexOf(desk) >= 0) sources[p.dataset.src] = true;
      });
    }
    scene.querySelectorAll(".of-ln, .of-case, .of-cap-o, .of-cap-i, .of-srcmark").forEach(function (p) {
      var serves = (p.dataset.desk || "").split(" ");
      var lit = desk ? serves.indexOf(desk) >= 0 || (serves[0] === "" && sources[p.dataset.src]) : p.dataset.src === src;
      p.classList.toggle("is-lit", !!lit);
    });
  }

  function plant(x, y, z) {
    var p = P(x, y, z);
    var s = "";
    [
      [-5, -10, 7],
      [5, -12, 7.5],
      [0, -19, 8],
      [-3, -26, 6],
      [4, -24, 5.5],
    ].forEach(function (l) {
      s += '<circle class="of-leaf" cx="' + r1(p[0] + l[0]) + '" cy="' + r1(p[1] + l[1]) + '" r="' + l[2] + '"/>';
    });
    return s;
  }

  // A small parcel, its top in the Connection's color.
  function cube(x, y, z, id) {
    var s = 0.21;
    return box(x - s, y - s, z, x + s, y + s, z + 0.42, hue(id), "of-e");
  }
  // A parcel riding a projected path. It is drawn at the origin and moved by animateMotion.
  function parcel(path, id, dur, delay) {
    var c = 0.21;
    var shape =
      poly([[-c, c, 0], [c, c, 0], [c, c, 0.42], [-c, c, 0.42]], darker(hue(id), 6), "of-e") +
      poly([[c, -c, 0], [c, c, 0], [c, c, 0.42], [c, -c, 0.42]], darker(hue(id), 13), "of-e") +
      poly([[-c, -c, 0.42], [c, -c, 0.42], [c, c, 0.42], [-c, c, 0.42]], hue(id), "of-e");
    return (
      '<g class="of-parcel"><g transform="translate(' + -O[0] + "," + -O[1] + ')">' + shape + "</g>" +
      '<animateMotion dur="' + dur + 's" begin="-' + delay + 's" repeatCount="indefinite" path="' + path + '"/></g>'
    );
  }

  // ------------------------------------------------------------ at 10x
  // A small potted plant, sized for a floor of the building.
  function pot(x, y, z) {
    var p = P(x, y, z + 0.35);
    return (
      box(x - 0.2, y - 0.2, z, x + 0.2, y + 0.2, z + 0.35, "var(--of-pot)") +
      '<circle class="of-leaf" cx="' + r1(p[0] - 2.5) + '" cy="' + r1(p[1] - 5) + '" r="4"/>' +
      '<circle class="of-leaf" cx="' + r1(p[0] + 2.6) + '" cy="' + r1(p[1] - 6) + '" r="3.8"/>' +
      '<circle class="of-leaf" cx="' + r1(p[0]) + '" cy="' + r1(p[1] - 10) + '" r="4.2"/>'
    );
  }
  function drawBuilding() {
    // Nine runners, one per floor, bottom first; studio-mac is the small top floor. The floors add
    // up to the sidebar's numbers at 10x: 140 live, 70 working, 11 waiting, 6 paused, 53 idle.
    // [name, sessions, desks, working, waiting, paused]
    var floors = [
      ["build-box-1", 18, 18, 10, 1, 1],
      ["build-box-2", 17, 18, 8, 0, 1],
      ["build-box-3", 18, 18, 9, 3, 0],
      ["build-box-4", 16, 18, 7, 1, 1],
      ["build-box-5", 18, 18, 10, 0, 1],
      ["build-box-6", 15, 18, 6, 2, 0],
      ["build-box-7", 18, 18, 9, 1, 1],
      ["build-box-8", 14, 18, 7, 1, 1],
      ["studio-mac", 6, 6, 4, 2, 0],
    ];
    var STEP = 1; // one desk
    var W = 18 * STEP + 0.4;
    var D = 2.8;
    var H = 2.6; // one storey
    var T = 0.26; // slab thickness
    var Z0 = 0.3;
    var CORE = W + 1.3; // the riser runs up the building's right end
    var ROOF = Z0 + floors.length * H;
    var lines = ["sentry", "gmail", "posthog", "github", "stripe", "intercom", "grafana", "cron", "you"];
    function laneY(k) {
      return 0.25 + k * 0.28;
    }
    function floorZ(i) {
      return Z0 + i * H;
    }
    // Places each floor's states on its desks in a fixed shuffled order, so waiting desks are
    // scattered the way they would be, and the picture is the same on every load.
    function seatStates(f, i) {
      var seats = [];
      for (var k = 0; k < f[2]; k++) seats.push(k < f[4] ? "wait" : k < f[4] + f[5] ? "paused" : k < f[4] + f[5] + f[3] ? "work" : k < f[1] ? "idle" : "");
      if (f[2] < 18) return seats;
      var seed = 7 + i * 13;
      for (var j = seats.length - 1; j > 0; j--) {
        seed = (seed * 9301 + 49297) % 233280;
        var r = Math.floor((seed / 233280) * (j + 1));
        var t = seats[j];
        seats[j] = seats[r];
        seats[r] = t;
      }
      return seats;
    }
    function mini(x, y, z, st) {
      var p = P(x, y, z);
      var cx = p[0];
      var by = p[1];
      var hand = st === "wait" ? '<path class="of-arm of-arm--s" d="M' + r1(cx - 3.6) + " " + r1(by - 6) + 'q-3 -2 -3.2 -8"/><circle class="of-hand" cx="' + r1(cx - 6.8) + '" cy="' + r1(by - 14.6) + '" r="1.5"/>' : "";
      return (
        hand +
        '<rect class="of-mini' + (st === "idle" ? " is-idle" : "") + '" x="' + r1(cx - 4) + '" y="' + r1(by - 14) + '" width="8" height="14" rx="4"/>' +
        '<circle class="of-eye" cx="' + r1(cx - 1.7) + '" cy="' + r1(by - 9.4) + '" r="0.95"/><circle class="of-eye" cx="' + r1(cx + 1.3) + '" cy="' + r1(by - 9.4) + '" r="0.95"/>'
      );
    }

    var s = [];
    var top = [];
    s.push('<defs><filter id="of-blur" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="16"/></filter></defs>');
    // The plinth: the building's footprint and the forecourt where every line comes in.
    var plinth = [-0.9, -3.6, W + 12.2, D + 0.9];
    s.push('<polygon class="of-drop" points="' + [pt(plinth[0], plinth[1], -1.4), pt(plinth[2], plinth[1], -1.4), pt(plinth[2], plinth[3], -1.4), pt(plinth[0], plinth[3], -1.4)].join(" ") + '"/>');
    s.push(box(plinth[0], plinth[1], -0.55, plinth[2], plinth[3], 0, "var(--of-floor)", "of-slab"));

    // Floors from the ground up. Each is an open tray: a slab, glass on its two far sides, and a
    // row of desks with the sessions sitting behind them.
    // Sessions sit at the front edge, turned toward the viewer, with their desks behind them:
    // anything deeper into the floor would hide under the slab of the floor above.
    floors.forEach(function (f, i) {
      var z = floorZ(i);
      var first = 18 - f[2]; // a smaller runner fills the desks nearest the core
      var g = "";
      g += box(0, 0, z - T, W, D, z, "var(--of-room)", "of-e");
      g += poly([[0, 0, z], [W, 0, z], [W, 0, z + H - T], [0, 0, z + H - T]], "var(--of-glass)", "of-glass");
      g += poly([[0, 0, z], [0, D, z], [0, D, z + H - T], [0, 0, z + H - T]], "var(--of-glass)", "of-glass");
      for (var k = 0; k < first; k += 3) g += pot(0.4 + (k + 1) * STEP, 1.6, z);
      seatStates(f, i).forEach(function (st, k) {
        var x = 0.4 + (first + k + 0.5) * STEP;
        g += box(x - 0.34, 1.1, z, x + 0.34, 1.62, z + 0.4, "var(--raised)");
        if (!st) return;
        g += mini(x, D - 0.45, z, st);
        if (st !== "idle") {
          var p = P(x, D - 0.45, z);
          g += window.MetroMark(st, "mk-" + st + " " + STATE_CLS[st], ' x="' + r1(p[0] - 4.5) + '" y="' + r1(p[1] - 27) + '" width="9" height="9"');
        }
      });
      s.push(g);

      // The floor's name sits at its left end, where the viewer's eye starts reading.
      var lp = P(0, D, z + 0.55);
      top.push(
        '<text class="of-lab" x="' + r1(lp[0] - 12) + '" y="' + r1(lp[1]) + '" text-anchor="end">' + f[0] +
          '<tspan class="of-note-in" dx="7">' + f[1] + " of " + f[2] + (f[1] === f[2] ? " · at cap" : "") + "</tspan></text>"
      );
      // The station on the core: a capsule across the bundle, and the floor's waiting count.
      var zc = z + 0.55;
      var a = P(CORE, laneY(0) - 0.3, zc);
      var b = P(CORE, laneY(8) + 0.3, zc);
      var cap = "M" + r1(a[0]) + " " + r1(a[1]) + "L" + r1(b[0]) + " " + r1(b[1]);
      top.push('<path class="of-cap-o of-cap--s" d="' + cap + '"/><path class="of-cap-i of-cap--s" d="' + cap + '"/>');
      if (f[4]) {
        top.push(mark("wait", "attn", a[0] + 17, a[1] - 3, 11));
        top.push('<text class="of-lab of-lab--attn" x="' + r1(a[0] + 29) + '" y="' + r1(a[1] + 1) + '">' + f[4] + " waiting</text>");
      }
    });
    s.push(box(-0.2, -0.2, ROOF - T, W + 0.2, D + 0.2, ROOF, "var(--of-room)", "of-e"));

    // The core: the glass shaft, then every line climbing it from the forecourt.
    s.push(box(CORE - 0.75, 0, 0, CORE + 0.75, laneY(8) + 0.35, ROOF - 0.6, "var(--of-glass)", "of-glass"));
    var cases = [];
    var colors = [];
    var paths = [];
    lines.forEach(function (id, k) {
      var y = laneY(k);
      var fan = -3 + k * 0.84;
      var start = id === "you" ? [[CORE + 5.4, y]] : [[W + 11.8, fan], [W + 9.8, fan], [W + 7.2, y]];
      var d = route(start.concat([[CORE + 0.8, y]]), 0, 0.9) + "Q" + pt(CORE, y, 0) + " " + pt(CORE, y, 0.8) + "L" + pt(CORE, y, floorZ(8) + 0.55);
      paths.push(d);
      cases.push('<path class="of-case" d="' + d + '"/>');
      colors.push('<path class="of-ln" d="' + d + '" style="--hue:' + hue(id) + '"/>');
      if (id !== "you") {
        var ip = P(W + 11.8, fan, 0);
        top.push('<circle class="of-roundel" cx="' + r1(ip[0] + 9) + '" cy="' + r1(ip[1] + 5) + '" r="9"/>');
        top.push(
          '<g class="of-srcmark" style="--hue:' + hue(id) + '">' +
            window.MetroBrand(id, "of-src", ' x="' + r1(ip[0] + 3.5) + '" y="' + r1(ip[1] - 0.5) + '" width="11" height="11"') + "</g>"
        );
      }
    });
    s.push(cases.join("") + colors.join(""));

    // Triage sits across the forecourt, where the fanned-out lines have closed into one bundle.
    s.push(box(CORE + 4.1, laneY(0) - 0.55, 0, CORE + 5.1, laneY(8) + 0.55, 0.95, "var(--casing)", "of-tri"));
    s.push(painted("wallX", CORE + 5.1, laneY(8) + 0.3, 0.22, '<text class="of-tri-t">Triage</text>'));
    var tp = P(CORE + 4.6, laneY(0) - 0.55, 1.6);
    top.push(label(tp[0] + 12, tp[1] - 4, "start", "Triage", "2,720 events since yesterday 18:20", "faint"));

    // A few parcels riding up the core while the event flow is on.
    var riders = "";
    if (!still) {
      [[0, 11, 0], [3, 13, 4.2], [4, 12, 8.1], [6, 14, 2.4], [8, 10, 6]].forEach(function (r) {
        riders += parcel(paths[r[0]], lines[r[0]], r[1], r[2]);
      });
    }

    scene.innerHTML = s.join("") + riders + top.join("");
  }

  if (swarm) drawBuilding();
  else drawOffice();

  // The Event flow switch in the header turns the flow layer on and off, and keeps ?flow= in the
  // address so a reload or a shared link shows the same view.
  var toggle = document.querySelector("[data-flow-toggle]");
  if (toggle) {
    var root = document.documentElement;
    toggle.setAttribute("aria-checked", String(root.dataset.flow === "on"));
    toggle.addEventListener("click", function () {
      var on = root.dataset.flow !== "on";
      root.dataset.flow = on ? "on" : "off";
      toggle.setAttribute("aria-checked", String(on));
      var url = new URL(location.href);
      url.searchParams.set("flow", on ? "on" : "off");
      history.replaceState(null, "", url);
    });
  }
})();
