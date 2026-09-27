/* Metro Concourse - the office. PROTOTYPE.
   Draws the Fleet for desktop/office.html, from one list of sessions:
   - svg#office-scene: an isometric floor with a room per runner, the Intake mailroom and the
     Triage counter. Every session is a person at a desk, with its state mark over its head.
   - [data-office-tags]: glass name tags laid over the scene, in the scene's own pixels.
   - [data-fleet-list]: the same sessions as tables, one per runner, for the List tab.
   With data-state="swarm" on <html> it draws the Fleet at 10x instead: a building with one floor
   per runner, and the list becomes one row per runner.

   The event flow (events through the wall, Triage, and the branches to the desks it sent work
   to) is drawn in <g class="of-flow"> and shown only while <html data-flow-lines="on">. The
   people come first: the flow is quiet ink, and only the events before Triage carry color, the
   way the departures board draws them. */
(function () {
  var scene = document.getElementById("office-scene");
  if (!scene) return;
  var tagLayer = document.querySelector("[data-office-tags]");
  var list = document.querySelector("[data-fleet-list]");
  var swarm = document.documentElement.dataset.state === "swarm";

  // ------------------------------------------------------------ the Fleet today
  // seat: the desk's floor position. flow: the work reached the desk through Triage.
  // tag: where the name tag sits, as [dx, dy] from the state mark; a negative dx puts it on the left.
  var RUNNERS = [
    { name: "studio-mac", note: "this Mac", slots: 6 },
    { name: "build-box-1", slots: 8 },
    { name: "build-box-2", slots: 8 },
  ];
  var SESSIONS = [
    { title: "Fix 3-D Secure checkout for EU cards", kind: "Thread · webshop · Opus 5.5", runner: "studio-mac", state: "wait", now: "Run git push?", since: "09:40", seat: [7, 7.3], flow: true },
    { title: "Migrate ops dashboards", kind: "Thread · ops · qwen3-coder", runner: "studio-mac", state: "wait", now: "Keep the old Grafana folder?", since: "09:24", seat: [10, 7.3], tag: [20, -4] },
    { title: "Ada", kind: "Assistant · Web chat, Slack DM · Sonnet 5", runner: "studio-mac", state: "work", now: "Checks in again at 10:00", since: "07:00", chair: 14.2 },
    { title: "Milo", kind: "Assistant · Slack #ops · Sonnet 5", runner: "studio-mac", state: "idle", now: "Started Investigate backup timeouts", since: "09:36", chair: 16.6 },
    { title: "Juno", kind: "Assistant · Discord #support · Haiku 4.5", runner: "studio-mac", state: "idle", asleep: true, now: "Asleep until Discord is back", since: "09:12", chair: 19 },
    { title: "Refactor cart totals", kind: "Thread · webshop · Sonnet 5", runner: "build-box-1", state: "work", now: "Editing cart/totals.ts", since: "22m", seat: [14.5, 19.4], tag: [-20, -4] },
    { title: "Payout report for September", kind: "Thread · payments-api · gpt-5.4", runner: "build-box-1", state: "work", now: "Summing 1,412 payouts", since: "8m", seat: [21.5, 19.4] },
    { title: "Review PR #1294", kind: "Run · webshop · Review pull request", runner: "build-box-1", state: "work", now: "Reading the diff", since: "4m", seat: [28.5, 19.4], flow: true },
    { title: "Webhook retry backoff", kind: "Run · payments-api · Fix failing webhook", runner: "build-box-1", state: "work", now: "Running the test suite", since: "3m", seat: [35.5, 19.4], flow: true, tag: [20, -4] },
    { title: "Rotate staging secrets", kind: "Thread · ops · Sonnet 5", runner: "build-box-1", state: "work", now: "Updating 6 of 9 secrets", since: "12m", seat: [18, 24.9] },
    { title: "Test backup restore", kind: "Run · ops · Nightly restore check", runner: "build-box-1", state: "work", now: "Restoring to a scratch database", since: "9m", seat: [25, 24.9], flow: true },
    { title: "Investigate backup timeouts", kind: "Run · ops · started by Milo", runner: "build-box-1", state: "work", now: "Comparing pg_dump timings", since: "6m", seat: [32, 24.9] },
    { title: "Label new issues", kind: "Run · webshop · Label issues", runner: "build-box-1", state: "paused", now: "34 events held", since: "09:02", seat: [39, 24.9], flow: true, tag: [20, 8] },
    { title: "Ship release v2.15", kind: "Run · payments-api · Release", runner: "build-box-2", state: "wait", now: "Publish to npm?", since: "09:31", seat: [30.8, 7.3], flow: true, tag: [20, -10] },
    { title: "Add iDEAL research", kind: "Thread · payments-api · gpt-5.4", runner: "build-box-2", state: "idle", now: "Done, waiting for a reply", since: "1h", seat: [35.2, 7.3], tag: [20, 2] },
    { title: "Read the Stripe v14 changelog", kind: "Thread · webshop · Haiku 4.5", runner: "build-box-2", state: "idle", now: "Done, waiting for a reply", since: "20m", seat: [26.4, 7.3] },
  ];
  var STATE_WORD = { work: "working", wait: "waiting on you", paused: "paused", idle: "idle" };
  var STATE_CLASS = { work: "live", wait: "attn", paused: "muted", idle: "faint" };

  // The Fleet at 10x: one runner per floor, bottom first; studio-mac is the small top floor.
  // [name, sessions, slots, working, waiting, paused]
  var FLOORS = [
    ["build-box-1", 18, 18, 9, 1, 1],
    ["build-box-2", 17, 18, 6, 0, 0],
    ["build-box-3", 18, 18, 8, 3, 1],
    ["build-box-4", 17, 18, 5, 1, 1],
    ["build-box-5", 18, 18, 7, 0, 0],
    ["build-box-6", 15, 18, 4, 2, 1],
    ["build-box-7", 18, 18, 7, 1, 1],
    ["build-box-8", 13, 18, 4, 1, 1],
    ["studio-mac", 6, 6, 2, 2, 0],
  ];

  // Today's events by Connection, the same numbers the departures board shows.
  var EVENTS = [["sentry", 130], ["github", 38], ["gmail", 17], ["stripe", 12], ["intercom", 9], ["posthog", 3], ["grafana", 2], ["cron", 1]];

  // ------------------------------------------------------------ projection
  // One floor unit is 17.3px along either floor axis; one unit of height is 17px.
  var O = swarm ? [412, 490] : [460, 214];
  function P(x, y, z) {
    return [O[0] + (x - y) * 15, O[1] + (x + y) * 8.66 - (z || 0) * 17];
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
  function hue(id) {
    return "var(--ln-" + id + ")";
  }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  }
  function poly(corners, fill, cls) {
    var points = corners.map(function (c) {
      return pt(c[0], c[1], c[2]);
    });
    return '<polygon points="' + points.join(" ") + '" style="fill:' + fill + '"' + (cls ? ' class="' + cls + '"' : "") + "/>";
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
    radius = radius || 0.7;
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
  // Paints text flat onto a wall or the floor. The plane's two unit vectors become the text's
  // x and y axes, so the letters lie in the plane without being scaled.
  var PLANES = {
    wallX: [0.866, -0.5, 0, 1], // the left wall, x = 0, text running toward the back corner
    wallY: [0.866, 0.5, 0, 1], // the back wall, y = 0
    floor: [0.866, 0.5, -0.866, 0.5], // the floor, text running along +x
  };
  function painted(plane, x, y, z, body) {
    var p = P(x, y, z);
    return '<g transform="matrix(' + PLANES[plane].join(",") + "," + r1(p[0]) + "," + r1(p[1]) + ')">' + body + "</g>";
  }
  // An enamel sign: an ink plate with the name, and the count after it in a lighter weight.
  function sign(plane, x, y, z, name, count, width) {
    return painted(
      plane, x, y, z,
      '<rect class="of-sign" x="0" y="-14" width="' + width + '" height="18" rx="4"/>' +
        '<text class="of-sign-t" x="8" y="-1.6">' + esc(name) + (count ? '<tspan class="of-sign-n" dx="6">' + esc(count) + "</tspan>" : "") + "</text>"
    );
  }
  // A state mark in a small round plate, so it reads over any floor or wall behind it.
  function mark(state, cx, cy, size) {
    var h = size / 2;
    return (
      '<circle class="of-roundel" cx="' + r1(cx) + '" cy="' + r1(cy) + '" r="' + (h + 3.5) + '"/>' +
      window.MetroMark(state, "", ' x="' + r1(cx - h) + '" y="' + r1(cy - h) + '" width="' + size + '" height="' + size + '" style="width:' + size + "px;height:" + size + 'px"')
    );
  }

  // A person: a pill with two eyes. Someone waiting on you raises a hand; someone asleep has
  // closed eyes.
  function agent(x, y, z, s) {
    var p = P(x, y, z);
    var cx = p[0];
    var by = p[1];
    var g =
      '<g class="of-agent">' +
      '<ellipse class="of-shadow" cx="' + r1(cx + 2) + '" cy="' + r1(by + 1) + '" rx="10" ry="4.5"/>' +
      '<rect class="of-body" x="' + r1(cx - 8) + '" y="' + r1(by - 27) + '" width="16" height="27" rx="8"/>' +
      '<path class="of-body-shade" d="M' + r1(cx + 2) + " " + r1(by - 26.2) + 'a8 8 0 0 1 5.2 7.5v11.5a8 8 0 0 1-5.2 7.5z"/>';
    var ey = by - 18.5;
    if (s.asleep) {
      g += '<path class="of-eye-shut" d="M' + r1(cx - 5.2) + " " + r1(ey) + "q1.4 1.4 2.8 0M" + r1(cx + 0.2) + " " + r1(ey) + 'q1.4 1.4 2.8 0"/>';
    } else {
      g += '<circle class="of-eye" cx="' + r1(cx - 3.4) + '" cy="' + r1(ey) + '" r="1.45"/><circle class="of-eye" cx="' + r1(cx + 1.8) + '" cy="' + r1(ey) + '" r="1.45"/>';
    }
    if (s.state === "wait") {
      g +=
        '<path class="of-arm" d="M' + r1(cx - 7) + " " + r1(by - 12) + 'q-6 -3 -6.5 -14"/>' +
        '<circle class="of-hand" cx="' + r1(cx - 13.4) + '" cy="' + r1(by - 27.5) + '" r="2.6"/>';
    }
    return g + "</g>";
  }
  // A desk with its laptop turned toward the person behind it, so the viewer sees the lid.
  function desk(x, y, occupied) {
    var s = box(x - 1.2, y - 0.6, 0, x + 1.2, y + 0.6, 0.72, "var(--of-desk)");
    if (occupied) {
      s += box(x - 0.42, y - 0.36, 0.72, x + 0.42, y + 0.12, 0.76, "var(--of-lid)");
      s += poly([[x - 0.42, y - 0.36, 0.76], [x + 0.42, y - 0.36, 0.76], [x + 0.42, y - 0.36, 1.36], [x - 0.42, y - 0.36, 1.36]], "var(--of-lid)", "of-e");
    }
    return s;
  }
  function armchair(x, y) {
    return {
      back: box(x - 0.75, y - 0.8, 0, x + 0.75, y - 0.42, 1.3, "var(--of-chair)"),
      front:
        box(x - 0.75, y - 0.42, 0, x - 0.5, y + 0.6, 0.7, "var(--of-chair)") +
        box(x - 0.5, y - 0.42, 0, x + 0.5, y + 0.6, 0.42, "var(--of-chair)") +
        box(x + 0.5, y - 0.42, 0, x + 0.75, y + 0.6, 0.7, "var(--of-chair)"),
    };
  }
  function plant(x, y) {
    var p = P(x, y, 0.6);
    var leaves = [[-5, -10, 7], [5, -12, 7.5], [0, -19, 8], [-3, -26, 6], [4, -24, 5.5]]
      .map(function (l) {
        return '<circle class="of-leaf" cx="' + r1(p[0] + l[0]) + '" cy="' + r1(p[1] + l[1]) + '" r="' + l[2] + '"/>';
      })
      .join("");
    return box(x - 0.4, y - 0.4, 0, x + 0.4, y + 0.4, 0.6, "var(--of-pot)") + leaves;
  }
  // The events before Triage: one line, a segment per Connection. Each segment's length follows
  // its share on a log scale, like the folded line on the departures board, so one noisy source
  // cannot hide the quiet ones. Returns the segments and the whole line's path for the train.
  function foldedLine(from, to, z, events) {
    var weights = events.map(function (e) {
      return 1 + Math.log2(1 + e[1]);
    });
    var sum = weights.reduce(function (a, b) {
      return a + b;
    }, 0);
    var gap = 0.14;
    var len = Math.hypot(to[0] - from[0], to[1] - from[1]);
    var ux = (to[0] - from[0]) / len;
    var uy = (to[1] - from[1]) / len;
    var usable = len - gap * (events.length - 1);
    var at = 0;
    var s = "";
    events.forEach(function (e, i) {
      var l = (usable * weights[i]) / sum;
      s += '<path class="of-in" d="M' + pt(from[0] + ux * at, from[1] + uy * at, z) + "L" + pt(from[0] + ux * (at + l), from[1] + uy * (at + l), z) + '" style="stroke:' + hue(e[0]) + '"/>';
      at += l + gap;
    });
    return { svg: s, path: "M" + pt(from[0], from[1], z) + "L" + pt(to[0], to[1], z) };
  }
  // The train: a small car running along the events into Triage, as on the departures board.
  function train(path) {
    return (
      '<g class="of-train"><rect x="-8" y="-3.5" width="16" height="7" rx="3.5"/>' +
      '<animateMotion dur="3.2s" repeatCount="indefinite" rotate="auto" path="' + path + '"/>' +
      '<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.88;1" dur="3.2s" repeatCount="indefinite"/></g>'
    );
  }
  function station(x, y, z) {
    var p = P(x, y, z);
    return '<circle class="of-station" cx="' + r1(p[0]) + '" cy="' + r1(p[1]) + '" r="3.6"/>';
  }

  // ------------------------------------------------------------ today
  function drawOffice() {
    var W = 44;
    var D = 28;
    var WALL = 3;
    var floor = [];
    var flow = [];
    var things = [];
    var top = [];
    var tags = [];
    function add(depth, svg) {
      things.push([depth, svg]);
    }

    // The slab, its soft shadow, the two back walls and the skirting where they meet the floor.
    floor.push(
      '<polygon class="of-drop" points="' + [pt(0, 0, -1.4), pt(W, 0, -1.4), pt(W, D, -1.4), pt(0, D, -1.4)].join(" ") + '"/>' +
        box(0, 0, -0.7, W, D, 0, "var(--of-floor)", "of-slab") +
        box(-0.35, -0.35, 0, 0, D, WALL, "var(--of-wall)") +
        box(0, -0.35, 0, W, 0, WALL, "var(--of-wall)") +
        poly([[0, 0, 0], [0, D, 0], [0, D, 0.16], [0, 0, 0.16]], "var(--of-skirt)") +
        poly([[0, 0, 0], [W, 0, 0], [W, 0, 0.16], [0, 0, 0.16]], "var(--of-skirt)")
    );
    // The door the events come in by, in the left wall at the corridor.
    floor.push(poly([[0, 11.9, 0], [0, 13.9, 0], [0, 13.9, 2.1], [0, 11.9, 2.1]], "var(--of-hole)"));

    // Rooms sit on the corridor floor as lighter platforms: the three runners and the mailroom.
    [
      [0.4, 0.4, 21, 9.6],
      [22.6, 0.4, 43.6, 9.6],
      [11, 16, 43.6, 27.6],
      [0.4, 16.4, 9.2, 27.6],
    ].forEach(function (r) {
      floor.push(poly([[r[0], r[1], 0], [r[2], r[1], 0], [r[2], r[3], 0], [r[0], r[3], 0]], "var(--of-room)", "of-room"));
    });
    // build-box-1 has no wall to hang a sign on, so its name is painted on its floor.
    floor.push(painted("floor", 12.2, 27, 0, '<text class="of-paint">build-box-1<tspan class="of-paint-n" dx="8">8 of 8 · full</tspan></text>'));

    // ---- the flow. Branches leave Triage on lanes that never cross: the lane that turns first
    // toward the front room runs furthest forward, and the branches to the back rooms leave from
    // Triage's back face or run behind every other lane.
    var TRI = { x0: 6.3, x1: 7.7, y0: 10.6, y1: 15.2 };
    var cx = (TRI.x0 + TRI.x1) / 2;
    var incoming = foldedLine([0, 12.9], [TRI.x0, 12.9], 0, EVENTS);
    var branches = [
      [[cx, TRI.y0], [cx, 8.6]], // Fix 3-D Secure, from the Proposal it was started from
      [[TRI.x1, 11.2], [30.8, 11.2], [30.8, 8.6]], // Ship release v2.15
      [[TRI.x1, 13.1], [39, 13.1], [39, 22]], // Label new issues
      [[TRI.x1, 13.6], [35.5, 13.6], [35.5, 16.6]], // Webhook retry backoff
      [[TRI.x1, 14.1], [28.5, 14.1], [28.5, 16.6]], // Review PR #1294
      [[TRI.x1, 14.6], [25, 14.6], [25, 22]], // Test backup restore
      [[cx, TRI.y1], [cx, 17.4]], // the Proposals, to Intake
    ];
    flow.push(
      branches
        .map(function (b) {
          return '<path class="of-branch" d="' + route(b, 0) + '"/>';
        })
        .join("") +
        branches
          .map(function (b) {
            var e = b[b.length - 1];
            return station(e[0], e[1], 0);
          })
          .join("") +
        incoming.svg +
        train(incoming.path)
    );

    // ---- things, drawn back to front by depth.
    add(
      cx + 12.9,
      box(TRI.x0, TRI.y0, 0, TRI.x1, TRI.y1, 0.95, "var(--of-desk)", "of-e of-tri") + painted("wallX", TRI.x1, TRI.y1 - 0.5, 0.22, '<text class="of-tri-t">Triage</text>')
    );

    // Pigeonholes on the mailroom wall: a letter in a hole for each Proposal waiting in Intake.
    var shelf = box(0, 17.4, 0.3, 0.9, 24.6, 1.95, "var(--of-wood)");
    var letters = [1, 0, 1, 0, 0, 2, 1, 0, 0, 1, 0, 0]; // 2 is the burning one
    for (var col = 0; col < 6; col++) {
      for (var row = 0; row < 2; row++) {
        var y0 = 17.65 + col * 1.15;
        var z0 = 0.5 + row * 0.72;
        shelf += poly([[0.9, y0, z0], [0.9, y0 + 0.95, z0], [0.9, y0 + 0.95, z0 + 0.58], [0.9, y0, z0 + 0.58]], "var(--of-hole)");
        var l = letters[row * 6 + col];
        if (l) shelf += poly([[0.9, y0 + 0.2, z0], [0.9, y0 + 0.75, z0], [0.9, y0 + 0.75, z0 + 0.42], [0.9, y0 + 0.2, z0 + 0.42]], l === 2 ? "var(--of-letter-burning)" : "var(--of-letter)", "of-letter");
      }
    }
    add(0.45 + 21, shelf);
    // The sorting table, with the post Triage has not sent anywhere yet.
    add(
      5.2 + 21.2,
      box(3.8, 19.8, 0, 6.6, 22.6, 0.7, "var(--of-wood)") + box(4.4, 20.3, 0.7, 5.1, 20.9, 0.9, "var(--of-letter)") + box(5.4, 21.3, 0.7, 6.1, 21.9, 0.82, "var(--of-letter)")
    );
    add(0.9 + 26.9, plant(0.9, 26.8));
    add(42.8 + 1.2, plant(42.8, 1.2));
    add(43.1 + 27.2, plant(43.1, 27.2));

    // The empty desks: one on studio-mac, five on build-box-2.
    [[3, 7.3], [39.6, 7.3], [26.4, 3.3], [30.8, 3.3], [35.2, 3.3], [39.6, 3.3]].forEach(function (d) {
      add(d[0] + d[1], desk(d[0], d[1], false));
    });

    SESSIONS.forEach(function (s) {
      var p;
      if (s.chair) {
        var y = 6.4;
        var c = armchair(s.chair, y);
        add(s.chair + y, c.back + agent(s.chair, y - 0.1, 0.35, s) + c.front);
        p = P(s.chair, y - 0.1, 0.35);
        top.push(mark(s.state, p[0], p[1] - 40, 12));
        var lp = P(s.chair, y + 0.6, 0);
        top.push('<text class="of-lab" x="' + r1(lp[0]) + '" y="' + r1(lp[1] + 18) + '" text-anchor="middle">' + esc(s.title) + (s.asleep ? '<tspan class="of-lab-n"> · asleep</tspan>' : "") + "</text>");
        return;
      }
      var x = s.seat[0];
      var sy = s.seat[1];
      add(x + sy, desk(x, sy, true));
      add(x + sy - 1.4, agent(x - 0.1, sy - 1.3, 0.28, s));
      p = P(x - 0.1, sy - 1.3, 0.28);
      var mx = p[0];
      // A raised hand reaches above the head, so the mark over someone waiting sits a little higher.
      var my = p[1] - (s.state === "wait" ? 44 : 40);
      if (s === SESSIONS[0]) top.push('<circle class="of-focus" cx="' + r1(mx) + '" cy="' + r1(my) + '" r="16"/>');
      top.push(mark(s.state, mx, my, s.tag || s === SESSIONS[0] ? 14 : 12));
      if (s.tag) {
        tags.push(
          '<div class="of-tag glass' + (s.tag[0] < 0 ? " of-tag--l" : "") + '" style="left:' + r1(mx + s.tag[0]) + "px;top:" + r1(my + s.tag[1]) + 'px">' +
            "<b>" + esc(s.title) + '</b><span class="' + STATE_CLASS[s.state] + '">' + esc(s.state === "wait" ? s.now : STATE_WORD[s.state] + (s.state === "paused" ? " · " + s.now : " " + s.since)) + "</span></div>"
        );
      }
    });
    things.sort(function (a, b) {
      return a[0] - b[0];
    });

    // ---- signs and labels, on top of everything.
    top.push(sign("wallY", 1.4, 0, 2.3, "studio-mac", "5 of 6", 120));
    top.push(sign("wallY", 16.8, 0, 2.3, "Assistants", "", 76));
    top.push(sign("wallY", 23.6, 0, 2.3, "build-box-2", "3 of 8", 124));
    top.push(sign("wallX", 0, 24.4, 2.3, "Intake", "5 Proposals", 126));

    scene.innerHTML =
      '<defs><filter id="of-blur" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="14"/></filter></defs>' +
      floor.join("") +
      '<g class="of-flow">' + flow.join("") + "</g>" +
      things.map(function (t) {
        return t[1];
      }).join("") +
      top.join("");
    tagLayer.innerHTML = tags.join("");
  }

  // ------------------------------------------------------------ at 10x
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
    var W = 18.4;
    var D = 2.8;
    var H = 2.6; // one storey
    var T = 0.26; // slab thickness
    var Z0 = 0.3;
    var CORE = W + 1.3; // the riser runs up the building's right end
    var ROOF = Z0 + FLOORS.length * H;
    var LANE = 1.2; // where the riser climbs, across the core
    function floorZ(i) {
      return Z0 + i * H;
    }
    // Places each floor's states on its desks in a fixed shuffled order, so waiting desks are
    // scattered the way they would be, and the picture is the same on every load.
    function seatStates(f, i) {
      var seats = [];
      for (var k = 0; k < f[2]; k++) {
        seats.push(k < f[4] ? "wait" : k < f[4] + f[5] ? "paused" : k < f[4] + f[5] + f[3] ? "work" : k < f[1] ? "idle" : "");
      }
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
        '<rect class="of-mini" x="' + r1(cx - 4) + '" y="' + r1(by - 14) + '" width="8" height="14" rx="4"/>' +
        '<circle class="of-eye" cx="' + r1(cx - 1.7) + '" cy="' + r1(by - 9.4) + '" r="0.95"/><circle class="of-eye" cx="' + r1(cx + 1.3) + '" cy="' + r1(by - 9.4) + '" r="0.95"/>'
      );
    }

    var s = [];
    var flow = [];
    var top = [];
    s.push('<defs><filter id="of-blur" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="16"/></filter></defs>');
    // The plinth: the building's footprint and the forecourt where the events come in.
    var plinth = [-0.9, -3.6, W + 12.2, D + 0.9];
    s.push('<polygon class="of-drop" points="' + [pt(plinth[0], plinth[1], -1.4), pt(plinth[2], plinth[1], -1.4), pt(plinth[2], plinth[3], -1.4), pt(plinth[0], plinth[3], -1.4)].join(" ") + '"/>');
    s.push(box(plinth[0], plinth[1], -0.55, plinth[2], plinth[3], 0, "var(--of-floor)", "of-slab"));

    // Floors from the ground up. Each is an open tray: a slab, glass on its two far sides, and a
    // row of desks. The people sit at the front edge, turned toward the viewer, with their desks
    // behind them: anything deeper into the floor would hide under the slab of the floor above.
    FLOORS.forEach(function (f, i) {
      var z = floorZ(i);
      var first = 18 - f[2]; // a smaller runner fills the desks nearest the core
      var g = box(0, 0, z - T, W, D, z, "var(--of-room)");
      g += poly([[0, 0, z], [W, 0, z], [W, 0, z + H - T], [0, 0, z + H - T]], "var(--of-glass)", "of-glass");
      g += poly([[0, 0, z], [0, D, z], [0, D, z + H - T], [0, 0, z + H - T]], "var(--of-glass)", "of-glass");
      for (var k = 0; k < first; k += 3) g += pot(0.4 + (k + 1), 1.6, z);
      seatStates(f, i).forEach(function (st, k) {
        var x = 0.4 + first + k + 0.5;
        g += box(x - 0.34, 1.1, z, x + 0.34, 1.62, z + 0.4, "var(--of-desk)");
        if (!st) return;
        g += mini(x, D - 0.45, z, st);
        if (st !== "idle") {
          var p = P(x, D - 0.45, z);
          g += window.MetroMark(st, "", ' x="' + r1(p[0] - 4.5) + '" y="' + r1(p[1] - 27) + '" width="9" height="9" style="width:9px;height:9px"');
        }
      });
      s.push(g);

      // The floor's name sits at its left end, where the eye starts reading.
      var lp = P(0, D, z + 0.55);
      top.push(
        '<text class="of-lab" x="' + r1(lp[0] - 12) + '" y="' + r1(lp[1]) + '" text-anchor="end">' + f[0] +
          '<tspan class="of-lab-n" dx="7">' + (f[1] === f[2] ? "full" : f[1] + " of " + f[2]) + "</tspan></text>"
      );
      // At the core, each floor's waiting count: where you are needed, before who.
      var cp = P(CORE, LANE, z + 0.55);
      flow.push(station(CORE, LANE, z + 0.55));
      if (f[4]) {
        top.push(mark("wait", cp[0] + 20, cp[1] - 3, 10));
        top.push('<text class="of-lab of-lab--attn" x="' + r1(cp[0] + 32) + '" y="' + r1(cp[1] + 1) + '">' + f[4] + " waiting</text>");
      }
    });
    s.push(box(-0.2, -0.2, ROOF - T, W + 0.2, D + 0.2, ROOF, "var(--of-room)"));

    // The core: a glass shaft at the building's right end.
    s.push(box(CORE - 0.75, 0, 0, CORE + 0.75, 2.6, ROOF - 0.6, "var(--of-glass)", "of-glass"));
    // Triage sits on the forecourt. The events come in across it as one colored line; one ink
    // line leaves Triage and climbs the core, with a station on every floor.
    var TX = CORE + 5;
    s.push(box(TX - 0.5, LANE - 0.9, 0, TX + 0.5, LANE + 0.9, 0.95, "var(--of-desk)", "of-e of-tri"));
    var incoming = foldedLine([W + 11.8, LANE], [TX + 0.5, LANE], 0, EVENTS);
    var riser = route([[TX - 0.5, LANE], [CORE + 0.8, LANE]], 0) + "Q" + pt(CORE, LANE, 0) + " " + pt(CORE, LANE, 0.8) + "L" + pt(CORE, LANE, floorZ(8) + 0.55);
    flow.unshift('<path class="of-branch" d="' + riser + '"/>');
    flow.push(incoming.svg + train(incoming.path));
    var tp = P(TX, LANE - 0.9, 1.6);
    top.push(
      '<text class="of-lab" x="' + r1(tp[0] + 12) + '" y="' + r1(tp[1] - 8) + '">Triage</text>' +
        '<text class="of-lab of-lab-n" x="' + r1(tp[0] + 12) + '" y="' + r1(tp[1] + 6) + '">31,000 events a day</text>'
    );

    scene.innerHTML = s.join("") + '<g class="of-flow">' + flow.join("") + "</g>" + top.join("");
  }

  // ------------------------------------------------------------ the List tab
  function sessionRow(s) {
    return (
      '<tr><td><span class="who">' + window.MetroMark(s.state) + "<span><b>" + esc(s.title) + '</b><span class="sub">' + esc(s.kind) + "</span></span></span></td>" +
      '<td class="' + STATE_CLASS[s.state] + '">' + (s.asleep ? "asleep" : STATE_WORD[s.state]) + "</td>" +
      '<td class="prose muted">' + esc(s.now) + "</td>" +
      '<td class="end faint">' + esc(s.since) + "</td></tr>"
    );
  }
  function drawList() {
    var html = "";
    if (swarm) {
      html += '<h2 class="set-h">9 runners<span class="aside">140 of 150 slots</span></h2><div class="set-card"><table class="tbl fl-tbl fl-tbl--runners"><thead><tr><th>Runner</th><th class="c-n">Sessions</th><th class="c-n">Working</th><th class="c-n">Waiting</th><th class="c-n">Paused</th><th class="c-n">Idle</th></tr></thead><tbody>';
      FLOORS.slice().reverse().forEach(function (f) {
        var idle = f[1] - f[3] - f[4] - f[5];
        html +=
          '<tr><td><span class="who"><i class="fl-runner"></i><b>' + f[0] + "</b></span></td>" +
          '<td class="num">' + f[1] + ' <span class="faint">of ' + f[2] + "</span></td>" +
          '<td class="num">' + f[3] + '</td><td class="num' + (f[4] ? " attn" : " faint") + '">' + f[4] + '</td><td class="num' + (f[5] ? "" : " faint") + '">' + f[5] + '</td><td class="num faint">' + idle + "</td></tr>";
      });
      list.innerHTML = html + "</tbody></table></div>";
      list.querySelectorAll(".fl-runner").forEach(function (el) {
        el.outerHTML = window.MetroIcon("server");
      });
      return;
    }
    RUNNERS.forEach(function (r) {
      var rows = SESSIONS.filter(function (s) {
        return s.runner === r.name;
      });
      html +=
        '<h2 class="set-h">' + r.name + (r.note ? '<span class="faint">' + r.note + "</span>" : "") +
        '<span class="aside">' + rows.length + " of " + r.slots + " slots" + (rows.length === r.slots ? " · full" : "") + "</span></h2>" +
        '<div class="set-card"><table class="tbl fl-tbl"><colgroup><col /><col class="c-state" /><col class="c-now" /><col class="c-since" /></colgroup><tbody>' +
        rows.map(sessionRow).join("") +
        "</tbody></table></div>";
    });
    list.innerHTML = html;
  }

  if (swarm) drawBuilding();
  else drawOffice();
  drawList();
})();
