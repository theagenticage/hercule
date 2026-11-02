/*
 * PROTOTYPE - Gazette's Office mode: the Bureau, rewindable.
 *
 * Today's Bureau, built from the app's own Office kit (../vendor/office-kit.js), made legible
 * and given a memory:
 *
 *   1. Thought bubbles. Over each working bean, what it does now in a few words (from its
 *      latest tool call). A message between two threads flies from desk to desk as a paper
 *      plane, and the receiver's bubble shows the message's first words for a moment.
 *   2. Desks remember the day. A paper stack that grows with the diff, sticky notes in the
 *      finder's colour for findings, a brass cup for an open pull request (pewter for a draft),
 *      a red folder for a failure.
 *   3. The time dial. Scrub from 07:00 to now and the Bureau replays the morning from the turn
 *      history: who was here, who worked, who queued at your desk, who rested in the Lounge.
 *      "While you were away" plays 09:01 to 09:41 at 30x with captions, then rests on now.
 *
 * Exposes window.OfficeModes.gazette = { mount(container, api) } (see ../BUILDERS.md).
 * Everything is drawn from WORLD (world.js + world-plus.js). What the world does not hold and
 * this mode needs (an activity line per past tool call, which desk a finding lands on) is in
 * the HISTORY block below, and says so.
 */
(function () {
  "use strict";

  /* ================================================================== data this mode adds */

  // Short names, for captions and bubbles: [as a name, as a reference in a sentence].
  var NAMES = {
    t3ds: ["3-D Secure fix", "the 3-D Secure fix"],
    tStripe: ["Stripe research", "the Stripe research"],
    t3dsReview: ["3-D Secure review", "the 3-D Secure review"],
    tCart: ["Cart refactor", "the cart refactor"],
    tCartTests: ["Cart property tests", "the cart property tests"],
    tCss: ["Checkout CSS tidy", "the checkout CSS tidy"],
    tA11y: ["Screen-reader audit", "the screen-reader audit"],
    tPayout: ["Payout report", "the payout report"],
    tPayoutCheck: ["Payout check", "the payout check"],
    tResult: ["Result migration", "the Result migration"],
    tResultReview: ["Result review", "the Result review"],
    tIdeal: ["iDEAL research", "the iDEAL research"],
    tDash: ["Dashboards move", "the dashboards move"],
    tDashAlerts: ["Alerts check", "the alerts check"],
    tSecrets: ["Staging secrets", "the staging secrets"],
    tBun: ["Bun 1.4 question", "the Bun 1.4 question"],
    rShip: ["Ship release v2.15", "the release run"],
    rWebhookFix: ["Webhook backoff run", "the webhook backoff run"],
    rRoundingFix: ["Rounding fix run", "the rounding fix run"],
    rBackupInvestigate: ["Backup timeouts run", "the backup timeouts run"],
    rJonasDraft: ["Reply to Jonas run", "the reply to Jonas run"],
  };

  /*
   * HISTORY - what each session was doing at past moments of the morning, 2-4 words from its
   * tool call then, as WORLD.activity holds it for now. world-plus keeps only the current line;
   * the replay needs the morning's, so Hercule would keep the activity line per tool call in the
   * turn history (spec: the replay reads the history once per scrub). The last line of every
   * session still working at 09:41 is WORLD.activity's own.
   */
  var ACTIVITY = {
    t3ds: [["09:02", "reading payment.ts"], ["09:03", "reading stripe.ts"], ["09:21", "writing a failing test"], ["09:24", "editing payment.ts"], ["09:28", "running pnpm test checkout"], ["09:30", "briefing a review"]],
    tStripe: [["09:05", "reading Stripe's changelog"], ["09:11", "comparing v13 and v14"], ["09:17", "writing to the 3-D Secure fix"]],
    t3dsReview: [["09:30", "reading payment.ts"], ["09:33", "listing PaymentIntent statuses"]],
    tCart: [["09:19", "reading totals.ts"], ["09:23", "briefing a tests partner"], ["09:26", "editing discounts.ts"]],
    tCartTests: [["09:24", "reading computeTotals"], ["09:28", "writing property tests"], ["09:35", "running the properties"]],
    tCss: [["07:12", "finding unused rules"], ["07:22", "editing checkout.css"], ["07:34", "opening PR #1281"]],
    tA11y: [["08:40", "reading card-form.tsx"], ["08:45", "tabbing through checkout"], ["08:52", "trying a focus-ring fix"]],
    tPayout: [["09:32", "reading payouts.service.ts"], ["09:34", "briefing a check partner"], ["09:36", "grouping 1,284 payouts"]],
    tPayoutCheck: [["09:35", "fetching balance transactions"], ["09:37", "matching refunds"]],
    tResult: [["08:48", "reading payouts.controller.ts"], ["08:55", "editing payout-error.ts"], ["09:04", "running contract tests"], ["09:09", "briefing a review"], ["09:12", "opening draft PR #1287"], ["09:31", "reading the review"]],
    tResultReview: [["09:10", "reading payout-error.ts"], ["09:17", "tracing PayoutError"], ["09:27", "writing up 3 findings"]],
    tIdeal: [["08:30", "reading the iDEAL docs"], ["08:36", "comparing 3 options"]],
    tDash: [["08:58", "exporting old dashboards"], ["09:04", "editing checkout.json"], ["09:12", "briefing an alerts check"], ["09:29", "reading the alerts report"], ["09:33", "listing the old folder"]],
    tDashAlerts: [["09:14", "listing alert rules"], ["09:20", "firing test alerts"]],
    tSecrets: [["09:30", "reading rotate.sh"], ["09:33", "rotating secret 3 of 14"], ["09:37", "rotating secret 7 of 14"]],
    tBun: [["06:50", "reading Bun's release notes"]],
    rShip: [["09:12", "running npm pack"], ["09:24", "checking the tarball"]],
    rRoundingFix: [["09:27", "reproducing the bug"]],
  };

  // When a working session's last line became WORLD.activity's (09:41's) line.
  var ACTIVITY_NOW_SINCE = {
    t3dsReview: "09:38", tCart: "09:35", tCartTests: "09:40", tPayout: "09:39", tResult: "09:34",
    tSecrets: "09:40", rWebhookFix: "09:38", rRoundingFix: "09:33", rBackupInvestigate: "09:35", rJonasDraft: "09:40",
  };

  // Findings, as sticky notes in the finder's colour on the desk they were reported to. Their
  // times are the reports' (WORLD.exchanges) or, for a lone thread, its turn's end.
  var FINDINGS = [
    { at: "08:56", on: "tA11y", by: "tA11y", count: 6 }, // 6 issues, 2 on the card form
    { at: "09:29", on: "tDash", by: "tDashAlerts", count: 2 }, // 2 alerts point at removed panels
    { at: "09:31", on: "tResult", by: "tResultReview", count: 3, blocking: 1 }, // 3 findings, 1 blocking
    { at: "09:38", on: "t3ds", by: "t3dsReview", count: 1 }, // a processing status still shows "Card declined"
  ];
  // Failures, as a red folder on the desk where it failed.
  var FAILURES = [{ at: "09:40", on: "tCartTests" }]; // 1 failing property: rounding at 3 decimals
  // Pull requests, as a cup on the lead's desk: brass when open, pewter for a draft.
  var PULLS = [
    { at: "07:40", on: "tCss", number: 1281, state: "open" },
    { at: "09:14", on: "tResult", number: 1287, state: "draft" },
  ];

  /* ================================================================== constants */

  var DIAL_FROM = 7 * 60; // 07:00
  var FLIGHT = 0.9; // minutes of the morning a paper plane is in the air
  var MESSAGE_SHOWN = 2.2; // minutes of the morning the receiver's bubble shows the message
  var PLAY_WALK = 3.4; // metres a second a bean walks during a replay (the app walks 1.35)
  var SPEEDS = [30, 60, 120];
  var ZOOM_FAR = 30; // camera distances, in metres, between the semantic zoom levels
  var ZOOM_NEAR = 13;

  // The plan, in metres (the app's numbers, maps/bureau-rooms.ts).
  var DESK_W = 1.2;
  var DESK_FRONT = 0.36; // a clerk's desk's front edge, from its centre
  var DESK_BACK = 1.06; // its chair's back, from its centre
  var CREW_GAP = 0.08;
  var DESK_GAP = 0.5;
  var AISLE = 0.9;
  var MARGIN_X = 1.0;
  var DRESSING = 0.95;
  var MARGIN_Z = 1.2;
  var GALLERY = 2.2;
  var QUEUE_PITCH = 0.72;
  var DESK_TOP = 0.7;
  var REAMS = 8; // a paper stack is up to 8 reams of paper, each REAM_HEIGHT tall
  var REAM_HEIGHT = 0.024;
  var REAM_TURNS = [0, 0.07, -0.04, 0.05, -0.07, 0.03, -0.02, 0.06];

  /* ================================================================== small helpers */

  /** Returns a new element with a class and, optionally, inner HTML. */
  function makeElement(tag, cls, html) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html != null) node.innerHTML = html;
    return node;
  }
  /** Returns text with the characters HTML gives a meaning escaped. */
  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function clamp(x, a, b) {
    return Math.max(a, Math.min(b, x));
  }
  /** Returns minutes since midnight as "HH:MM". */
  function formatTime(min) {
    var m = Math.floor(min + 1e-6);
    var h = Math.floor(m / 60);
    return (h < 10 ? "0" : "") + h + ":" + (m % 60 < 10 ? "0" : "") + (m % 60);
  }
  /** Returns the inline style that gives an element a colleague's hue, so `--who` follows it. */
  function buildHueStyle(hue) {
    return "--hue:var(--hue-" + hue + ")";
  }
  /** Returns the first words of a message, cut at a word near `max` characters. */
  function cutToFirstWords(text, max) {
    if (text.length <= max) return text;
    var cut = text.slice(0, max);
    var space = cut.lastIndexOf(" ");
    return cut.slice(0, space > max * 0.6 ? space : max).replace(/[,.;:]$/, "") + "…";
  }
  /** Returns a small paper plane as SVG, in the `--who` of the element it sits in. */
  function drawPlaneIcon(size) {
    return (
      '<svg class="gzo-plane-icon" width="' + size + '" height="' + size + '" viewBox="0 0 16 16" aria-hidden="true">' +
      '<path d="M1.5 7.6 14.5 2 10.8 14 7.9 9.4z" fill="var(--who)" />' +
      '<path d="M7.9 9.4 14.5 2" stroke="var(--raised)" stroke-width="1" fill="none" /></svg>'
    );
  }

  /* ================================================================== the roster */

  /**
   * Builds the sessions the Bureau seats: the morning's 16 threads and the 5 sessions of the
   * runs' agent steps, plus the swarm's 19 threads when `swarm` is true. Each gets its spans in
   * minutes, its short names, and its project. Returns { list, byId }.
   */
  function buildRoster(W, swarm) {
    var minutes = W.helpers.minutes;
    var list = [];
    function add(raw, kind) {
      var spans = (W.turns[raw.id] || []).map(function (s) {
        return { from: minutes(s.from), to: s.to == null ? Infinity : minutes(s.to), end: s.end };
      });
      var names = NAMES[raw.id] || [shortenTitle(raw.title), "“" + shortenTitle(raw.title) + "”"];
      list.push({
        id: raw.id,
        kind: kind,
        title: raw.title,
        name: names[0],
        ref: names[1],
        project: raw.project || null,
        lead: raw.lead || null,
        ask: raw.askShort || raw.ask || null,
        started: raw.started != null ? minutes(raw.started) : null,
        spans: spans,
        restPose: raw.pose === "asleep" ? "asleep" : "idle",
      });
    }
    W.threads.forEach(function (t) {
      add(t, "thread");
    });
    Object.keys(W.runSessions).forEach(function (id) {
      var r = W.runSessions[id];
      var ask = id === "rShip" && W.waitingRuns.length ? W.waitingRuns[0].ask : r.ask;
      add({ id: id, title: r.title, project: r.project, started: r.started, askShort: ask }, "run");
    });
    if (swarm) {
      W.swarm.threads.forEach(function (t) {
        add(t, "thread");
      });
    }
    var byId = {};
    list.forEach(function (s) {
      byId[s.id] = s;
    });
    return { list: list, byId: byId };
  }

  /** Returns a finding's count in words: "1 finding", "3 findings, 1 blocking", "6 issues". */
  function describeFinding(f) {
    var noun = f.on === f.by ? "issue" : "finding";
    var words = f.count + " " + noun + (f.count === 1 ? "" : "s");
    return f.blocking ? words + ", " + f.blocking + " blocking" : words;
  }

  /** Returns the first few words of a title, for a swarm thread with no hand-written name. */
  function shortenTitle(title) {
    var words = title.split(" ");
    return words.slice(0, words.length > 4 ? 3 : 4).join(" ");
  }

  /**
   * Returns what a session is doing at minute `T`: absent (not started yet), working, waiting
   * (its turn stopped on a Request), idle, or queued (started, no turn yet), with since when.
   */
  function readState(s, T) {
    var spans = s.spans;
    if (!spans.length) return s.started != null && T >= s.started ? { state: "queued", since: s.started } : { state: "absent" };
    if (T < spans[0].from) return { state: "absent" };
    var out = { state: "idle", since: spans[0].from };
    for (var i = 0; i < spans.length; i++) {
      var sp = spans[i];
      if (T >= sp.from && T < sp.to) return { state: "working", since: sp.from };
      if (T >= sp.to) out = { state: sp.end === "request" ? "waiting" : "idle", since: sp.to };
    }
    return out;
  }

  /** Returns how many minutes a session has worked up to `T`. */
  function workedUntil(s, T) {
    var sum = 0;
    s.spans.forEach(function (sp) {
      if (T > sp.from) sum += Math.min(T, sp.to) - sp.from;
    });
    return sum;
  }

  /** Returns the lines a session added and removed by now: the sum of its edits (WORLD.files). */
  function countEditedLines(W, id) {
    var f = W.files[id];
    var out = { plus: 0, minus: 0 };
    if (f)
      f.touched.forEach(function (t) {
        if (t.how === "edit") {
          out.plus += t.plus;
          out.minus += t.minus;
        }
      });
    return out;
  }

  /** Returns the activity line of a working session at minute `T`: the tool call it was on then. */
  function readActivity(W, s, T) {
    var since = ACTIVITY_NOW_SINCE[s.id];
    var current = W.activity[s.id];
    if (current && (since == null || T >= W.helpers.minutes(since))) return current;
    var line = null;
    (ACTIVITY[s.id] || []).forEach(function (entry) {
      if (W.helpers.minutes(entry[0]) <= T) line = entry[1];
    });
    return line || current || "working";
  }

  /* ================================================================== the morning's events */

  /**
   * Builds the dial's events, oldest first: arrivals, messages between threads, turn ends with
   * their headlines, and Requests. Each event has a minute, a kind, the session it is about, and
   * a caption in plain words.
   */
  function buildEvents(W, roster, nowMin) {
    var minutes = W.helpers.minutes;
    var events = [];
    var briefed = {};
    W.exchanges.forEach(function (x) {
      if (x.kind === "brief") briefed[x.to + "@" + x.at] = true;
    });
    roster.list.forEach(function (s) {
      if (!s.spans.length) return;
      var first = s.spans[0].from;
      if (first >= DIAL_FROM && first <= nowMin) {
        var quiet = briefed[s.id + "@" + formatTime(first)];
        events.push({ t: first, kind: "arrive", who: s.id, quiet: quiet, html: "<b>" + escapeHtml(s.name) + "</b> started" });
      }
      var lines = W.headlines[s.id] || [];
      s.spans.forEach(function (sp) {
        if (sp.to === Infinity || sp.to < DIAL_FROM) return;
        var head = null;
        lines.forEach(function (h) {
          if (!h.running && minutes(h.at) === sp.to) head = h.text;
        });
        if (sp.end === "request") {
          var ask = head || "asks: " + (s.id === "rShip" ? (W.runs[0].waitingAsk || s.ask) : s.ask);
          events.push({ t: sp.to, kind: "request", who: s.id, html: "<b>" + escapeHtml(s.name) + ":</b> " + escapeHtml(ask) });
        } else {
          events.push({ t: sp.to, kind: "end", who: s.id, html: "<b>" + escapeHtml(s.name) + ":</b> " + escapeHtml(head || "finished its turn") });
        }
      });
    });
    W.exchanges.forEach(function (x) {
      var from = roster.byId[x.from];
      var to = roster.byId[x.to];
      if (!from || !to) return;
      var verb = x.kind === "brief" ? " briefed " : " reported to ";
      events.push({ t: minutes(x.at), kind: "message", who: x.from, html: "<b>" + escapeHtml(from.name) + "</b>" + verb + escapeHtml(to.ref) });
    });
    var order = { arrive: 0, message: 1, end: 2, request: 3 };
    events.sort(function (a, b) {
      return a.t - b.t || order[a.kind] - order[b.kind];
    });
    return events;
  }

  /* ================================================================== the plan */

  /**
   * Lays out the Bureau as the app's Bureau map does, compactly: one room per project in a row
   * north of the Gallery, each piece of work's desks pushed together; across the Gallery the
   * Lounge, the Secretariat, Your Office and the Lobby with the front door. Returns the rooms
   * (each with its rectangle wall middle to wall middle, and `inner`, its floor inside the
   * walls), the desks, the queue and the doors, in world metres (north is -z).
   */
  function planBureau(roster, opts) {
    var maxRow = opts.swarm ? 9.6 : 7.0;
    // A project room is named exactly as the project is ("payments-api", dash and all).
    var projects = opts.projects.map(function (p) {
      return { id: p.id, name: p.name, tint: p.tint };
    });
    // Crews: a lead and its partners, lead first; each run step on its own.
    var crewsByProject = {};
    projects.forEach(function (p) {
      crewsByProject[p.id] = [];
    });
    var crewOf = {};
    roster.list.forEach(function (s) {
      if (!s.project || !crewsByProject[s.project]) return;
      var leadId = s.lead && roster.byId[s.lead] ? s.lead : s.id;
      if (!crewOf[leadId]) {
        crewOf[leadId] = [];
        crewsByProject[s.project].push(crewOf[leadId]);
      }
      if (leadId === s.id) crewOf[leadId].unshift(s);
      else crewOf[leadId].push(s);
    });
    // Bigger crews first, so the pieces of work with partners sit in the front row.
    projects.forEach(function (p) {
      var crews = crewsByProject[p.id];
      crews.forEach(function (c, i) {
        c.order = i;
      });
      crews.sort(function (a, b) {
        var ar = a[0].kind === "run" ? 1 : 0;
        var br = b[0].kind === "run" ? 1 : 0;
        return ar - br || (b.length > 1 ? 1 : 0) - (a.length > 1 ? 1 : 0) || a.order - b.order;
      });
    });

    function crewWidth(crew) {
      return crew.length * DESK_W + (crew.length - 1) * CREW_GAP;
    }
    projects.forEach(function (p) {
      var rows = [];
      var row = null;
      var width = 0;
      crewsByProject[p.id].forEach(function (crew) {
        var w = crewWidth(crew);
        if (row && width + DESK_GAP + w <= maxRow) {
          row.push(crew);
          width += DESK_GAP + w;
        } else {
          row = [crew];
          width = w;
          rows.push(row);
        }
      });
      p.rows = rows;
      p.rowWidths = rows.map(function (r) {
        return r.reduce(function (sum, c, i) {
          return sum + crewWidth(c) + (i ? DESK_GAP : 0);
        }, 0);
      });
      p.blocksWidth = Math.max.apply(null, p.rowWidths.concat([4]));
      p.width = Math.ceil((p.blocksWidth + 2 * MARGIN_X + DRESSING) * 10) / 10;
    });
    var rowCount = Math.max(2, Math.max.apply(null, projects.map(function (p) { return p.rows.length; })));
    var blocksDepth = rowCount * (DESK_FRONT + DESK_BACK) + (rowCount - 1) * AISLE;
    var northDepth = Math.ceil((blocksDepth + 2 * MARGIN_Z) * 10) / 10;

    // The front row.
    var loungeGroups = Math.max(2, Math.ceil(opts.loungeSeats / 4));
    // As in the app, Your Office stands next to the Lobby, so a newcomer reaches it first.
    var front = [
      { id: "lounge", name: "Lounge", kind: "lounge", width: loungeGroups * 4.3 + 1.2, doorAt: 0.3 },
      { id: "secretariat", name: "Secretariat", kind: "secretariat", width: 8.6, doorAt: 0.5 },
      { id: "your-office", name: "Your Office", kind: "your-office", width: 6.8, doorAt: 0.84 },
      { id: "lobby", name: "Lobby", kind: "lobby", width: 3.8, doorAt: 0.5, opening: 2.4 },
    ];
    var frontDepth = 6.2;
    var northWidth = projects.reduce(function (s, p) { return s + p.width; }, 0);
    var frontWidth = front.reduce(function (s, r) { return s + r.width; }, 0);
    var total = Math.max(northWidth, frontWidth);
    if (northWidth < total) {
      var grow = total / northWidth;
      projects.forEach(function (p) {
        p.width *= grow;
      });
    }
    if (frontWidth < total) front[0].width += total - frontWidth;

    var x0 = -total / 2;
    var zN = -(northDepth + GALLERY / 2);
    var zG1 = -GALLERY / 2;
    var zG2 = GALLERY / 2;
    var zS = GALLERY / 2 + frontDepth;
    var shiftZ = -(zN + zS) / 2;
    zN += shiftZ;
    zG1 += shiftZ;
    zG2 += shiftZ;
    zS += shiftZ;
    var galleryZ = (zG1 + zG2) / 2;

    var rooms = [];
    var x = x0;
    projects.forEach(function (p) {
      var room = {
        id: p.id, name: p.name, kind: "project", tint: p.tint, project: p,
        rect: { minX: x, maxX: x + p.width, minZ: zN, maxZ: zG1 },
      };
      room.doorX = room.rect.maxX - 1.35;
      room.doorIn = [room.doorX, zG1 - 0.75];
      room.doorOut = [room.doorX, galleryZ];
      rooms.push(room);
      x += p.width;
    });
    x = x0;
    front.forEach(function (r) {
      var room = { id: r.id, name: r.name, kind: r.kind, tint: null, rect: { minX: x, maxX: x + r.width, minZ: zG2, maxZ: zS } };
      room.doorX = x + r.width * r.doorAt;
      room.doorWidth = r.opening || 1.0;
      room.doorIn = [room.doorX, zG2 + 0.8];
      room.doorOut = [room.doorX, galleryZ];
      rooms.push(room);
      x += r.width;
    });
    var gallery = { id: "gallery", name: "Gallery", kind: "gallery", rect: { minX: x0, maxX: x0 + total, minZ: zG1, maxZ: zG2 } };
    var byId = {};
    rooms.forEach(function (r) {
      byId[r.id] = r;
      // The floor inside the walls: a room's rectangle runs to the walls' middles.
      var half = 0.06;
      r.inner = { minX: r.rect.minX + half, maxX: r.rect.maxX - half, minZ: r.rect.minZ + half, maxZ: r.rect.maxZ - half };
    });

    // The desks of each project room, its rows from the front (south) row back.
    var desks = [];
    rooms.forEach(function (room) {
      if (room.kind !== "project") return;
      var p = room.project;
      var inner = room.inner;
      var centreX = (inner.minX + inner.maxX - DRESSING) / 2;
      var top = (inner.minZ + inner.maxZ) / 2 - blocksDepth / 2;
      room.laneX = inner.maxX - DRESSING - 0.45;
      room.frontZ = inner.maxZ - 0.75;
      p.rows.forEach(function (row, r) {
        // Row 0 is the front row: the last one from the north wall.
        var rowIndex = rowCount - 1 - r;
        var deskZ = top + DESK_BACK + rowIndex * (DESK_FRONT + DESK_BACK + AISLE);
        var left = centreX - p.rowWidths[r] / 2;
        row.forEach(function (crew) {
          crew.forEach(function (s, i) {
            desks.push({
              sess: s, room: room, crew: crew,
              x: left + DESK_W / 2 + i * (DESK_W + CREW_GAP),
              z: deskZ,
              behindZ: deskZ - DESK_BACK - 0.32,
            });
          });
          left += crewWidth(crew) + DESK_GAP;
        });
      });
    });

    // Your Office: the partner desk near the street windows, the queue north of it, then east to the door.
    var yo = byId["your-office"];
    var yoIn = yo.inner;
    yo.deskX = yoIn.minX + 2.3;
    yo.deskZ = yoIn.maxZ - 1.75;
    var head = [yo.deskX, yo.deskZ - 0.95];
    var turn = [yo.deskX, yoIn.minZ + 1.3];
    var end = [yoIn.maxX - 0.95, yoIn.minZ + 1.3];
    yo.queuePath = [head, turn, end];
    yo.queue = layQueue([head, turn, end], opts.queueSpots);

    // The Lounge: seating groups of four armchairs in a row, open to the south.
    var lounge = byId.lounge;
    var lIn = lounge.inner;
    lounge.groups = [];
    var cell = (lIn.maxX - lIn.minX - 0.6) / loungeGroups;
    for (var g = 0; g < loungeGroups; g++) {
      lounge.groups.push({ x: lIn.minX + 0.3 + cell * (g + 0.5), z: (lIn.minZ + 1.5 + lIn.maxZ) / 2 + 0.1 });
    }

    var lobby = byId.lobby;
    var frontDoorX = (lobby.rect.minX + lobby.rect.maxX) / 2;

    return {
      width: total, x0: x0, zN: zN, zG1: zG1, zG2: zG2, zS: zS, galleryZ: galleryZ,
      rooms: rooms, byId: byId, gallery: gallery, desks: desks, rowCount: rowCount,
      frontDoor: { x: frontDoorX, inside: [frontDoorX, zS - 0.9], outside: [frontDoorX, zS + 1.4] },
    };
  }

  /** Returns `count` spots along a polyline, QUEUE_PITCH apart, from its first point. */
  function layQueue(points, count) {
    var spots = [];
    for (var i = 0; i < count; i++) {
      var d = i * QUEUE_PITCH;
      var walked = 0;
      var placed = false;
      for (var seg = 0; seg < points.length - 1; seg++) {
        var a = points[seg];
        var b = points[seg + 1];
        var len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (d <= walked + len || seg === points.length - 2) {
          var along = Math.min(1, (d - walked) / len);
          var px = a[0] + (b[0] - a[0]) * along;
          var pz = a[1] + (b[1] - a[1]) * along;
          // A colleague faces the one ahead of it, so the first faces your desk (south).
          var fx = a[0] - b[0];
          var fz = a[1] - b[1];
          spots.push({ x: px, z: pz, facing: Math.atan2(fx, fz), seg: seg });
          placed = true;
          break;
        }
        walked += len;
      }
      if (!placed) spots.push(spots[spots.length - 1]);
    }
    return spots;
  }

  /* ================================================================== mount */

  function mount(container, api) {
    var K = window.OfficeKit;
    var THREE = window.THREE;
    if (!K || !THREE) throw new Error("gazette-office.js: load ../vendor/office-kit.js first");
    var W = api.world || window.WORLD;
    if (!W || !W.turns) throw new Error("gazette-office.js: WORLD with world-plus.js is required");
    var minutes = W.helpers.minutes;
    var NOW = minutes(W.now);
    var AWAY_FROM = minutes(W.away.left);

    var root = makeElement("div", "ov-gazette-office");
    root.tabIndex = -1;
    container.appendChild(root);
    var stageHost = makeElement("div", "gzo-stage");
    root.appendChild(stageHost);

    var self = {
      state: normalizeState(api.state),
      selected: null,
      T: NOW,
      playing: false,
      speed: 30,
      stopAt: NOW,
      disposed: false,
    };
    var scene = null; // everything built for one roster; rebuilt when the swarm comes or goes
    var hud = buildHud();
    var crumbBox = root.querySelector(".gzo-crumb");
    var dialBox = root.querySelector(".gzo-dial");
    var insetTop = 14;
    clearTopChrome();

    /**
     * Keeps the crumb clear of a bar the window floats over the top of the Office (its mode
     * switch and counts): finds what lies over the container's top-left corner and starts below
     * it. Standalone, nothing does, and the crumb sits 14px from the top.
     */
    function clearTopChrome() {
      var r = container.getBoundingClientRect();
      var bottom = 0;
      [r.left + 24, r.left + 160].forEach(function (x) {
        document.elementsFromPoint(x, r.top + 24).forEach(function (node) {
          if (root.contains(node) || node.contains(container)) return;
          // Only a bar counts, not a whole pane faded out over the Office.
          var box = node.getBoundingClientRect();
          if (box.height < 120) bottom = Math.max(bottom, box.bottom - r.top);
        });
      });
      insetTop = bottom > 0 ? Math.round(bottom + 10) : 14;
      root.style.setProperty("--gzo-inset-top", insetTop + "px");
    }

    /** Returns one of the states this mode draws; any other state of the window draws as everyday. */
    function normalizeState(state) {
      if (state === "swarm" || state === "away" || state === "open" || state === "replay" || state === "edition") return state;
      return "everyday";
    }

    /* -------------------------------------------------------------- build the scene */

    /** Builds the stage and everything on it for the morning (with the swarm when `swarm` is true). Returns the scene. */
    function buildScene(swarm) {
      K.setAmbientMotion(!api.reducedMotion);
      var roster = buildRoster(W, swarm);
      var maxIdle = 0;
      var maxWaiting = 0;
      for (var T = DIAL_FROM; T <= NOW; T += 1) {
        var idle = 0;
        var waiting = 0;
        roster.list.forEach(function (s) {
          var st = readState(s, T).state;
          if (st === "idle") idle++;
          if (st === "waiting") waiting++;
        });
        maxIdle = Math.max(maxIdle, idle);
        maxWaiting = Math.max(maxWaiting, waiting);
      }
      var plan = planBureau(roster, { projects: W.projects, swarm: swarm, loungeSeats: maxIdle, queueSpots: Math.max(5, maxWaiting + 1) });
      var stage = K.stage.create(stageHost);
      // The leaders from moved labels to their heads: one path on a layer under all the labels.
      var leaders = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      leaders.setAttribute("class", "gzo-leaders");
      leaders.innerHTML = "<path />";
      stageHost.insertBefore(leaders, stageHost.querySelector(".office-kit-labels"));
      var sc = {
        swarm: swarm, roster: roster, plan: plan, stage: stage, beans: [], beanById: {}, deskProps: {},
        seats: [], seatOf: {}, events: buildEvents(W, roster, NOW), planes: [], roomLabels: [], unsubscribe: [],
        lastQuarter: null, zoom: null, focusRoom: null, leaders: leaders.firstChild, leaderPath: "",
      };
      buildArchitecture(sc);
      buildFurniture(sc);
      buildPeople(sc);
      buildCrews(sc);
      buildDeskProps(sc);
      buildPlanes(sc);
      buildRoomLabels(sc);
      sc.establishing = computeEstablishing(sc);
      stage.view(sc.establishing);
      wirePicking(sc);
      sc.stopFrame = stage.onFrame(function (frame) {
        return onFrame(sc, frame);
      });
      return sc;
    }

    /** Returns the view of the whole Bureau, framed in the canvas above the dial. */
    function computeEstablishing(sc) {
      var p = sc.plan;
      return computeRectView(sc, { minX: p.x0 - 0.2, maxX: p.x0 + p.width + 0.2, minZ: p.zN - 0.2, maxZ: p.zS + 0.6 }, 22, 50, 0.97);
    }

    /* -------------------------------------------------------------- architecture */

    /**
     * Adds a panelled wall from `from` to `to` along `axis` ("x": east-west at z = `line`; "z":
     * north-south at x = `line`), its outside toward `o.outward`. Doors are given at world
     * coordinates along the wall. An exterior wall drops to the dado rail only when its outside
     * faces the camera; an interior one drops whenever the camera is far (the app's rule).
     */
    function addWall(sc, axis, line, from, to, o) {
      var len = to - from;
      var c = (from + to) / 2;
      var opts = { windows: !!o.windows, cutaway: { roomId: "bureau", exterior: !!o.exterior } };
      if (o.height) opts.height = o.height;
      var rotation;
      var toLocal;
      if (axis === "x") {
        rotation = o.outward === "north" ? Math.PI : 0;
        toLocal = o.outward === "north" ? function (wx) { return -(wx - c); } : function (wx) { return wx - c; };
      } else {
        rotation = o.outward === "east" ? Math.PI / 2 : -Math.PI / 2;
        toLocal = o.outward === "east" ? function (wz) { return -(wz - c); } : function (wz) { return wz - c; };
      }
      opts.doors = (o.doors || []).map(function (d) {
        return { at: toLocal(d.at), width: d.width };
      });
      var wall = K.buildWall(len, opts);
      wall.rotation.y = rotation;
      if (axis === "x") wall.position.set(c, 0, line);
      else wall.position.set(line, 0, c);
      sc.stage.add(wall);
      return wall;
    }

    /** Builds the floors, the walls with their doors and windows, and the pavement outside. */
    function buildArchitecture(sc) {
      var p = sc.plan;
      var T2 = K.WALL_THICKNESS / 2;
      var H = K.WALL_HEIGHT;
      // Floors.
      p.rooms.forEach(function (room) {
        var r = room.rect;
        var floor = K.buildFloor(r.maxX - r.minX, r.maxZ - r.minZ, room.tint ? { inlay: "proj-" + room.tint } : {});
        floor.position.set((r.minX + r.maxX) / 2, 0, (r.minZ + r.maxZ) / 2);
        sc.stage.add(floor);
      });
      var g = p.gallery.rect;
      var gFloor = K.buildFloor(g.maxX - g.minX, g.maxZ - g.minZ);
      gFloor.position.set((g.minX + g.maxX) / 2, 0, (g.minZ + g.maxZ) / 2);
      sc.stage.add(gFloor);

      var xa = p.x0;
      var xb = p.x0 + p.width;
      // The outer walls: windows on the north (the project rooms) and on the street front.
      addWall(sc, "x", p.zN, xa - T2, xb + T2, { outward: "north", exterior: true, windows: true });
      addWall(sc, "x", p.zS, xa - T2, xb + T2, { outward: "south", exterior: true, windows: true, doors: [{ at: p.frontDoor.x, width: 1.4 }] });
      addWall(sc, "z", xa, p.zN + T2, p.zS - T2, { outward: "west", exterior: true, height: H - 0.004 });
      addWall(sc, "z", xb, p.zN + T2, p.zS - T2, { outward: "east", exterior: true, height: H - 0.004 });
      // The Gallery's two walls, with a door into every room.
      var northDoors = [];
      var southDoors = [];
      p.rooms.forEach(function (room) {
        if (room.kind === "project") northDoors.push({ at: room.doorX, width: 1.0 });
        else southDoors.push({ at: room.doorX, width: room.doorWidth });
      });
      addWall(sc, "x", p.zG1, xa + T2, xb - T2, { outward: "south", doors: northDoors });
      addWall(sc, "x", p.zG2, xa + T2, xb - T2, { outward: "north", doors: southDoors });
      // The walls between rooms.
      p.rooms.forEach(function (room, i) {
        var next = p.rooms[i + 1];
        if (!next || next.kind === "project" !== (room.kind === "project")) return;
        var zFrom = room.kind === "project" ? p.zN : p.zG2;
        var zTo = room.kind === "project" ? p.zG1 : p.zS;
        addWall(sc, "z", room.rect.maxX, zFrom + T2, zTo - T2, { outward: "east", height: H - 0.004 });
      });
      // The pavement along the street front, with two street lamps.
      var path = K.buildPath(1.7, p.width + 0.6);
      path.rotation.y = Math.PI / 2;
      path.position.set(0, 0, p.zS + 0.98);
      sc.stage.add(path);
      [p.frontDoor.x - 1.6, p.x0 + p.width * 0.36].forEach(function (lx) {
        var post = K.buildLamppost();
        post.position.set(lx, 0, p.zS + 1.6);
        sc.stage.add(post);
      });
    }

    /* -------------------------------------------------------------- furniture */

    /** Stands a prop on the floor at (x, z), turned by `rotation`, in the still building. */
    function place(sc, object, x, z, rotation) {
      object.position.set(x, 0, z);
      if (rotation) object.rotation.y = rotation;
      sc.stage.add(object);
      return object;
    }

    /** Furnishes every room: desks and dressing in the project rooms, then the front row. */
    function buildFurniture(sc) {
      var p = sc.plan;
      // Project rooms: desks, a palm in the far corner, a lamp by the door, a cabinet or two.
      p.desks.forEach(function (d) {
        var desk = K.buildDesk();
        desk.object.rotation.y = Math.PI;
        desk.object.position.set(d.x, 0, d.z);
        sc.stage.add(desk.object);
        desk.setLamp(false);
        d.handle = desk;
      });
      p.rooms.forEach(function (room) {
        var inr = room.inner;
        if (room.kind === "project") {
          place(sc, K.buildPlant("tall"), inr.maxX - 0.5, inr.minZ + 0.5);
          var lamp = K.buildFloorLamp();
          place(sc, lamp.object, inr.maxX - 0.38, inr.maxZ - 1.0);
          var cab = K.buildCabinet();
          place(sc, cab, inr.maxX - 0.4, (inr.minZ + inr.maxZ) / 2 - 0.2, -Math.PI / 2);
          var cab2 = K.buildCabinet();
          place(sc, cab2, inr.maxX - 0.4, (inr.minZ + inr.maxZ) / 2 + 0.36, -Math.PI / 2);
        }
      });
      buildLounge(sc);
      buildYourOffice(sc);
      buildSecretariat(sc);
      buildLobbyAndGallery(sc);
    }

    /** Furnishes the Lounge: seating groups of four armchairs on rugs, lamps, the tea trolley. */
    function buildLounge(sc) {
      var lounge = sc.plan.byId.lounge;
      var inr = lounge.inner;
      // Four armchairs in an arc open to the south, so their sitters face the camera.
      var arc = [
        [-1.45, 0.2, 0.55],
        [-0.5, -0.3, 0.18],
        [0.5, -0.3, -0.18],
        [1.45, 0.2, -0.55],
      ];
      lounge.groups.forEach(function (g, gi) {
        var rug = K.buildRug(3.7, 2.4, { medallion: true });
        rug.position.set(g.x, 0, g.z + 0.1);
        sc.stage.add(rug);
        arc.forEach(function (a) {
          var chair = K.buildArmchair();
          place(sc, chair.object, g.x + a[0], g.z + a[1], a[2]);
          sc.seats.push({ chair: chair, x: g.x + a[0], z: g.z + a[1], facing: a[2], room: lounge });
        });
        var lamp = K.buildFloorLamp();
        place(sc, lamp.object, g.x + (gi % 2 ? 2.0 : -2.0), g.z - 0.75);
      });
      place(sc, K.buildTeaTrolley(), inr.maxX - 1.0, inr.minZ + 0.34);
      place(sc, K.buildPlant("tall"), inr.minX + 0.5, inr.maxZ - 0.5);
      place(sc, K.buildPlant("small"), inr.maxX - 0.4, inr.maxZ - 0.4);
      place(sc, K.buildPlant("small"), inr.minX + 0.4, inr.minZ + 0.4);
    }

    /** Furnishes Your Office: your desk, the "Now serving" sign, a bench, and the Gazette (hidden until delivered). */
    function buildYourOffice(sc) {
      var yo = sc.plan.byId["your-office"];
      var inr = yo.inner;
      var rug = K.buildRug(3.6, 2.9);
      rug.position.set(yo.deskX, 0, yo.deskZ + 0.1);
      sc.stage.add(rug);
      var desk = K.buildYourDesk();
      place(sc, desk.object, yo.deskX, yo.deskZ, Math.PI);
      desk.setLamp(true);
      sc.yourDesk = desk;
      // "Now serving" on a brass stand west of the desk, facing the queue.
      var sign = K.buildNowServing();
      var stand = new THREE.Group();
      sign.object.position.set(0, 1.55, 0);
      stand.add(sign.object);
      var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1.55, 10), K.paint("brass", "brass"));
      pole.position.set(0, 0.775, -0.04);
      pole.castShadow = true;
      stand.add(pole);
      var foot = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.19, 0.04, 20), K.paint("room-inlay-2", "lacquer"));
      foot.position.set(0, 0.02, -0.04);
      foot.castShadow = true;
      stand.add(foot);
      place(sc, stand, yo.deskX - 1.5, yo.deskZ - 0.7, Math.PI / 2 - 0.45);
      sc.nowServing = sign;
      var bench = K.buildBench(3);
      place(sc, bench.object, inr.minX + 0.32, (inr.minZ + yo.deskZ) / 2 - 0.5, Math.PI / 2);
      place(sc, K.buildPlant("tall"), inr.minX + 0.5, inr.maxZ - 0.5);
      place(sc, K.buildPlant("tall"), inr.maxX - 0.5, inr.maxZ - 0.5);
      var lamp = K.buildFloorLamp();
      place(sc, lamp.object, inr.minX + 0.36, inr.minZ + 0.42);
      var lamp2 = K.buildFloorLamp();
      place(sc, lamp2.object, inr.maxX - 0.4, yo.deskZ - 0.2);
      // The Gazette on your desk: shown once the newsboy has brought it.
      sc.gazette = buildNewspaper(0.36, 0.25);
      sc.gazette.position.set(-0.08, DESK_TOP + 0.008, -0.06);
      sc.gazette.rotation.y = 0.12;
      sc.gazette.visible = false;
      desk.object.add(sc.gazette);
    }

    /** Furnishes the Secretariat: a corner per assistant, each a writing desk, a bookcase and an armchair. */
    function buildSecretariat(sc) {
      var sec = sc.plan.byId.secretariat;
      var inr = sec.inner;
      var names = W.assistants || [];
      var corner = 2.35;
      var gap = (inr.maxX - inr.minX - names.length * corner) / (names.length + 1);
      sc.assistants = [];
      names.forEach(function (a, i) {
        var left = inr.minX + gap + i * (corner + gap);
        var deskX = left + 0.55;
        var deskZ = inr.minZ + 1.75;
        var rug = K.buildRug(corner + 0.4, 1.9, { medallion: false });
        rug.position.set(left + corner / 2, 0, deskZ + 0.05);
        sc.stage.add(rug);
        var shelf = K.buildBookcase();
        place(sc, shelf, deskX, inr.minZ + 0.2);
        var wd = K.buildWritingDesk();
        place(sc, wd.object, deskX, deskZ, Math.PI);
        wd.setLamp(false);
        var chair = K.buildArmchair();
        place(sc, chair.object, left + corner - 0.42, deskZ + 0.15, -Math.PI / 5);
        sc.assistants.push({ name: a.name, pose: a.pose, desk: wd, chair: chair });
      });
      place(sc, K.buildPlant("tall"), inr.maxX - 0.5, inr.maxZ - 0.5);
      place(sc, K.buildPlant("small"), inr.minX + 0.4, inr.maxZ - 0.4);
      var lamp = K.buildFloorLamp();
      place(sc, lamp.object, (inr.minX + inr.maxX) / 2, inr.maxZ - 0.6);
    }

    /** Furnishes the Lobby (with the longcase clock that keeps the dial's time) and dresses the Gallery. */
    function buildLobbyAndGallery(sc) {
      var p = sc.plan;
      var lobby = p.byId.lobby;
      var inr = lobby.inner;
      var rug = K.buildRug(1.8, 1.3, { medallion: false });
      rug.position.set(p.frontDoor.x, 0, inr.maxZ - 1.0);
      sc.stage.add(rug);
      place(sc, K.buildCoatStand(), inr.minX + 0.4, inr.maxZ - 0.45);
      place(sc, K.buildPlant("tall"), inr.maxX - 0.55, inr.maxZ - 0.55);
      // The longcase clock keeps the dial's time.
      var clock = K.buildLongcaseClock();
      place(sc, clock.object, inr.maxX - 0.3, (inr.minZ + inr.maxZ) / 2 - 0.4, -Math.PI / 2);
      clock.object.updateMatrixWorld(true);
      clock.hands.applyMatrix4(clock.object.matrixWorld);
      sc.stage.scene.add(clock.hands);
      sc.clock = clock;
      var bench = K.buildBench(2);
      place(sc, bench.object, inr.minX + 0.32, (inr.minZ + inr.maxZ) / 2 - 0.2, Math.PI / 2);
      // The Gallery: palms and lamps between the doors.
      var gz = p.galleryZ;
      var stops = [];
      for (var x = p.x0 + 2.2; x < p.x0 + p.width - 1.5; x += 4.6) stops.push(x);
      stops.forEach(function (x, i) {
        var clear = p.rooms.every(function (room) {
          return Math.abs(room.doorX - x) > 1.0;
        });
        if (!clear) return;
        if (i % 2) {
          var lamp = K.buildFloorLamp();
          place(sc, lamp.object, x, p.zG1 + 0.35);
        } else {
          place(sc, K.buildPlant("small"), x, p.zG1 + 0.4);
        }
      });
    }

    /* -------------------------------------------------------------- the newspaper */

    var gazetteTexture = null;
    /** Returns the texture of the Gazette's front page, drawn once (again when its fonts load). */
    function readGazetteTexture() {
      if (gazetteTexture) return gazetteTexture;
      var c = document.createElement("canvas");
      c.width = 768;
      c.height = 536;
      gazetteTexture = new THREE.CanvasTexture(c);
      gazetteTexture.colorSpace = THREE.SRGBColorSpace;
      gazetteTexture.anisotropy = 4;
      drawGazette(c);
      if (document.fonts && document.fonts.load) {
        Promise.all([document.fonts.load('60px "Limelight"'), document.fonts.load('700 30px "Bricolage Grotesque"')]).then(function () {
          drawGazette(c);
          gazetteTexture.needsUpdate = true;
          if (scene) scene.stage.requestRender();
        });
      }
      return gazetteTexture;
    }
    /** Draws a front page of the Gazette on a canvas: masthead, date line, lead story, columns. */
    function drawGazette(c) {
      var g = c.getContext("2d");
      var w = c.width;
      var h = c.height;
      g.fillStyle = "#f3eee1";
      g.fillRect(0, 0, w, h);
      g.fillStyle = "#1f1b16";
      g.textAlign = "center";
      g.font = '64px "Limelight", serif';
      g.fillText("The Bureau Gazette", w / 2, 86);
      g.fillRect(36, 104, w - 72, 3);
      g.fillRect(36, 142, w - 72, 1.5);
      g.font = '600 19px "Bricolage Grotesque", sans-serif';
      g.fillText("TUESDAY 29 SEPTEMBER 2026  ·  MORNING EDITION  ·  09:41", w / 2, 131);
      // The edition's lead story, as the Front Page prints it (gazette-data.js), on two lines.
      var lead = (window.GAZETTE && window.GAZETTE.story.t3ds.head) || "3-D Secure fix is ready, and waits on your push";
      var cut = lead.indexOf(", ");
      g.textAlign = "left";
      g.font = '700 38px "Bricolage Grotesque", sans-serif';
      g.fillText(cut > 0 ? lead.slice(0, cut + 1) : lead, 36, 196);
      if (cut > 0) g.fillText(lead.slice(cut + 2), 36, 240);
      // Columns of text, drawn as grey lines.
      g.fillStyle = "#8f877a";
      for (var col = 0; col < 3; col++) {
        var x = 36 + col * 236;
        for (var y = 272; y < h - 30; y += 15) {
          var len = 200 - ((y * 7 + col * 13) % 5) * 9;
          g.fillRect(x, y, len, 5);
        }
      }
      g.fillStyle = "#1f1b16";
      g.fillRect(36, 258, w - 72, 1.5);
    }
    /** Builds a folded copy of the Gazette, its front page up. */
    function buildNewspaper(width, depth) {
      var group = new THREE.Group();
      var paper = K.paint("room-paper", "paper");
      var body = new THREE.Mesh(new THREE.BoxGeometry(width, 0.012, depth), paper);
      body.castShadow = true;
      body.receiveShadow = true;
      group.add(body);
      var top = new THREE.Mesh(new THREE.PlaneGeometry(width - 0.006, depth - 0.006), new THREE.MeshStandardMaterial({ map: readGazetteTexture(), roughness: 0.92 }));
      top.rotation.x = -Math.PI / 2;
      top.position.y = 0.0062;
      group.add(top);
      return group;
    }

    /* -------------------------------------------------------------- people */

    /**
     * Builds a bean for every session (hidden until the dial says it is here), the assistants
     * in the Secretariat, and the newsboy who brings the Gazette.
     */
    function buildPeople(sc) {
      var p = sc.plan;
      var deskOf = {};
      p.desks.forEach(function (d) {
        deskOf[d.sess.id] = d;
      });
      sc.roster.list.forEach(function (s) {
        var bean = K.colleague({ id: s.id, kind: s.kind === "run" ? "run" : "thread", pose: "working" });
        bean.visible = false;
        sc.stage.add(bean);
        var proxy = addHitProxy(bean);
        var b = { sess: s, bean: bean, proxy: proxy, desk: deskOf[s.id] || null, place: null, moveId: 0, hue: bean.look.hue };
        b.label = buildBeanLabel(sc, b);
        sc.beans.push(b);
        sc.beanById[s.id] = b;
      });
      // The assistants keep to the Secretariat.
      sc.assistantBeans = [];
      sc.assistants.forEach(function (a) {
        var bean = K.colleague({ id: "assistant:" + a.name, kind: "assistant", pose: a.pose });
        sc.stage.add(bean);
        if (a.pose === "asleep") bean.sitAt(a.chair);
        else bean.sitAt(a.desk);
        var tag = makeElement("div", "gzo-label gzo-label--assistant");
        tag.innerHTML = '<div class="gzo-tag" style="' + buildHueStyle(bean.look.hue) + '"><i class="gzo-dot"></i><b>' + escapeHtml(a.name) + "</b><span>" + escapeHtml(a.pose === "asleep" ? "asleep" : a.pose) + "</span></div>";
        sc.stage.label(bean, tag);
        sc.assistantBeans.push({ bean: bean, name: a.name });
      });
      // The newsboy, who brings the Gazette when you come back.
      var boy = K.colleague({ id: "gazette-newsboy", kind: "agent", pose: "idle", look: { hue: "peach" } });
      boy.visible = false;
      sc.stage.add(boy);
      var bundle = buildNewspaper(0.3, 0.2);
      bundle.scale.set(1, 3.2, 1);
      bundle.position.set(0.3, 0.46, 0.06);
      bundle.rotation.set(0.1, 0.3, Math.PI / 2.4);
      bundle.traverse(function (o) {
        o.castShadow = false;
      });
      boy.add(bundle);
      var boyTag = makeElement("div", "gzo-label gzo-label--newsboy");
      boyTag.innerHTML = '<div class="gzo-tag gzo-tag--news"><b>The Gazette</b><span>09:41 edition</span></div>';
      sc.newsboy = { bean: boy, label: sc.stage.label(boy, boyTag), tag: { node: boyTag, dirty: true }, run: 0 };
      boyTag.hidden = true;
    }

    /**
     * Builds one bubble per piece of work, for the far zoom: a line per member at work, each
     * with its hue dot, over the members at work. Close up, each bean has its own bubble.
     */
    function buildCrews(sc) {
      sc.crews = [];
      var seen = [];
      sc.plan.desks.forEach(function (d) {
        if (seen.indexOf(d.crew) >= 0) return;
        seen.push(d.crew);
        var anchor = new THREE.Object3D();
        sc.stage.scene.add(anchor);
        var node = makeElement("div", "gzo-label gzo-label--crew");
        node.dataset.kind = "none";
        var crew = {
          members: d.crew.map(function (s) {
            return sc.beanById[s.id];
          }),
          room: d.room,
          anchor: anchor,
          label: { node: node, kind: "none", html: null },
        };
        crew.label.handle = sc.stage.label(anchor, node);
        sc.crews.push(crew);
      });
    }

    /** Gives a bean a generous, invisible target for clicks: a cylinder from its feet to its head. */
    var proxyGeometry = null;
    var proxyMaterial = null;
    function addHitProxy(bean) {
      if (!proxyGeometry) {
        proxyGeometry = new THREE.CylinderGeometry(0.36, 0.36, 1.25, 10);
        proxyMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
      }
      var proxy = new THREE.Mesh(proxyGeometry, proxyMaterial);
      proxy.position.y = 0.6;
      proxy.castShadow = false;
      proxy.receiveShadow = false;
      bean.add(proxy);
      return proxy;
    }

    /** Builds the one label over a bean: its bubble, its message, or its name tag. */
    function buildBeanLabel(sc, b) {
      var node = makeElement("div", b.desk ? "gzo-label" : "gzo-label gzo-label--loose");
      node.style.cssText = buildHueStyle(b.hue);
      node.dataset.id = b.sess.id;
      var label = sc.stage.label(b.bean, node);
      return { node: node, handle: label, html: null, kind: null };
    }

    /* -------------------------------------------------------------- desk props */

    /** Builds what each desk can remember: a paper stack, sticky notes, a cup, a red folder. */
    function buildDeskProps(sc) {
      var paperMat = K.paint("room-paper", "paper");
      var edgeMat = K.paint("room-paper", "paper", { dl: -0.06 });
      var sheetGeo = new THREE.BoxGeometry(0.19, 0.003, 0.25);
      var bodyGeo = new THREE.BoxGeometry(0.185, 1, 0.245);
      var noteGeo = new THREE.BoxGeometry(0.082, 0.003, 0.082);
      var pinGeo = new THREE.BoxGeometry(0.082, 0.0034, 0.018);
      sc.plan.desks.forEach(function (d) {
        var s = d.sess;
        var diff = countEditedLines(W, s.id);
        var props = { diff: diff, lines: diff.plus + diff.minus, sheets: -1 };
        var desk = d.handle.object;
        // The paper stack, on the desk's papers: reams of paper, each turned a little, that grow
        // with the lines changed, and a loose sheet on top.
        var stack = new THREE.Group();
        stack.position.set(0.43, DESK_TOP + 0.009, -0.03);
        stack.rotation.y = 0.04;
        var reams = [];
        for (var r = 0; r < REAMS; r++) {
          var ream = new THREE.Mesh(bodyGeo, r % 2 ? paperMat : edgeMat);
          ream.rotation.y = REAM_TURNS[r % REAM_TURNS.length];
          ream.position.set(((r * 5) % 3 - 1) * 0.004, 0, ((r * 7) % 3 - 1) * 0.004);
          ream.castShadow = true;
          ream.receiveShadow = true;
          ream.visible = false;
          stack.add(ream);
          reams.push(ream);
        }
        var loose = [];
        [[0.16, 0.012, -0.006]].forEach(function (o) {
          var sheet = new THREE.Mesh(sheetGeo, paperMat);
          sheet.rotation.y = o[0];
          sheet.position.set(o[1], 0, o[2]);
          sheet.castShadow = true;
          sheet.receiveShadow = true;
          stack.add(sheet);
          loose.push(sheet);
        });
        stack.visible = false;
        desk.add(stack);
        props.stack = { group: stack, reams: reams, loose: loose };
        props.full = Math.max(0, Math.round(Math.sqrt(props.lines) * 1.15));
        // What the desk shows, in words, for a close look: the diff, findings, the pull request.
        var caption = makeElement("div", "gzo-desk");
        props.caption = { node: caption, label: sc.stage.label([d.x, DESK_TOP + 0.02, d.z + 0.42], caption, { className: "gzo-desk-wrap" }), html: null };
        props.workedTotal = workedUntil(s, NOW);
        sc.deskProps[s.id] = props;
      });
      // Findings: sticky notes in the finder's colour, in two rows along the desk's front edge.
      FINDINGS.forEach(function (f) {
        var props = sc.deskProps[f.on];
        var by = sc.beanById[f.by];
        if (!props || !by) return;
        var desk = sc.beanById[f.on].desk.handle.object;
        var group = new THREE.Group();
        var mat = K.paintHue(by.hue, "body", "paper", { dl: 0.1, dc: -0.03 });
        for (var i = 0; i < f.count; i++) {
          var note = new THREE.Mesh(noteGeo, mat);
          var row = i < 3 ? 0 : 1;
          var col = i % 3;
          note.position.set(-0.2 + col * 0.096, 0.0015 + (i % 2) * 0.0004, -0.26 + row * 0.1);
          note.rotation.y = ((i * 37) % 7 - 3) * 0.045;
          note.castShadow = true;
          note.receiveShadow = true;
          group.add(note);
          if (f.blocking && i < f.blocking) {
            var pin = new THREE.Mesh(pinGeo, K.paint("fail", "paper"));
            pin.position.set(0, 0.0004, -0.032);
            note.add(pin);
          }
        }
        group.position.set(0, DESK_TOP, 0);
        group.visible = false;
        desk.add(group);
        props.findings = (props.findings || []).concat([{ at: minutes(f.at), group: group, f: f }]);
      });
      // Pull requests: a cup.
      PULLS.forEach(function (pr) {
        var props = sc.deskProps[pr.on];
        if (!props) return;
        var desk = sc.beanById[pr.on].desk.handle.object;
        var cup = buildCup(pr.state === "open" ? K.paint("brass", "brass") : K.paint("room-metal", "metal", { dl: 0.06 }));
        cup.position.set(0.24, DESK_TOP, -0.27);
        cup.visible = false;
        desk.add(cup);
        props.pr = { at: minutes(pr.at), object: cup, pr: pr };
      });
      // Failures: a red folder with a sheet sticking out.
      FAILURES.forEach(function (fl) {
        var props = sc.deskProps[fl.on];
        if (!props) return;
        var desk = sc.beanById[fl.on].desk.handle.object;
        var folder = new THREE.Group();
        var cover = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.014, 0.18), K.paint("fail", "satin"));
        cover.castShadow = true;
        folder.add(cover);
        var sheet = new THREE.Mesh(sheetGeo, paperMat);
        sheet.position.set(0.03, 0.002, 0.035);
        sheet.rotation.y = 0.18;
        folder.add(sheet);
        cover.position.y = 0.0075;
        folder.position.set(-0.02, DESK_TOP + 0.001, -0.24);
        folder.rotation.y = -0.1;
        folder.visible = false;
        desk.add(folder);
        props.failure = { at: minutes(fl.at), object: folder, f: fl };
      });
    }

    /** Builds a small two-handled cup, the trophy for a pull request. */
    function buildCup(mat) {
      var g = new THREE.Group();
      var pts = [
        [0, 0], [0.042, 0], [0.042, 0.012], [0.03, 0.016], [0.012, 0.03], [0.009, 0.06], [0.014, 0.068],
        [0.04, 0.085], [0.05, 0.118], [0.052, 0.13], [0.046, 0.13], [0.043, 0.12], [0.034, 0.09], [0, 0.084],
      ].map(function (q) {
        return new THREE.Vector2(q[0], q[1]);
      });
      var body = new THREE.Mesh(new THREE.LatheGeometry(pts, 24), mat);
      body.castShadow = true;
      g.add(body);
      [-1, 1].forEach(function (side) {
        var handle = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.0045, 6, 16, Math.PI), mat);
        handle.position.set(side * 0.046, 0.1, 0);
        handle.rotation.z = side > 0 ? -Math.PI / 2 : Math.PI / 2;
        handle.castShadow = true;
        g.add(handle);
      });
      return g;
    }

    /* -------------------------------------------------------------- paper planes */

    /** Builds a paper plane and its dotted trail for every message between two threads. */
    function buildPlanes(sc) {
      var geo = new THREE.BufferGeometry();
      // A dart, nose toward +z: two wings and a keel, both sides drawn.
      var v = [
        0, 0.0, 0.2, -0.13, 0.025, -0.12, 0, 0.0, -0.1,
        0, 0.0, 0.2, 0, 0.0, -0.1, 0.13, 0.025, -0.12,
        0, 0.0, 0.2, 0, -0.045, -0.1, 0, 0.0, -0.1,
      ];
      geo.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
      geo.computeVertexNormals();
      sc.planeMaterial = new THREE.MeshStandardMaterial({ roughness: 0.85, side: THREE.DoubleSide });
      var dotCanvas = document.createElement("canvas");
      dotCanvas.width = dotCanvas.height = 32;
      var g = dotCanvas.getContext("2d");
      g.fillStyle = "#fff";
      g.beginPath();
      g.arc(16, 16, 13, 0, Math.PI * 2);
      g.fill();
      var dotTexture = new THREE.CanvasTexture(dotCanvas);
      W.exchanges.forEach(function (x) {
        var from = sc.beanById[x.from];
        var to = sc.beanById[x.to];
        if (!from || !to) return;
        var mesh = new THREE.Mesh(geo, sc.planeMaterial);
        mesh.castShadow = false;
        mesh.visible = false;
        mesh.scale.setScalar(2.8);
        sc.stage.scene.add(mesh);
        var count = 80;
        var trailGeo = new THREE.BufferGeometry();
        trailGeo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));
        var trailMat = new THREE.PointsMaterial({ size: 6, sizeAttenuation: false, map: dotTexture, transparent: true, alphaTest: 0.4, depthWrite: false });
        var trail = new THREE.Points(trailGeo, trailMat);
        trail.visible = false;
        trail.frustumCulled = false;
        sc.stage.scene.add(trail);
        sc.planes.push({ x: x, at: minutes(x.at), from: from, to: to, mesh: mesh, trail: trail, trailMat: trailMat, count: count });
      });
      paintPlanes(sc);
      // A trail dot is 6 CSS pixels whatever the screen's pixel ratio.
      sc.planes.forEach(function (pl) {
        pl.trailMat.size = 6 * sc.stage.renderer.getPixelRatio();
      });
      sc.unsubscribe.push(K.subscribePalette(function () {
        paintPlanes(sc);
      }));
    }

    /** Paints the planes paper and each trail in its sender's hue, for the current theme. */
    function paintPlanes(sc) {
      sc.planeMaterial.color.copy(K.readColor("room-paper"));
      sc.planes.forEach(function (pl) {
        K.writeOklch(pl.trailMat.color, K.readHue(pl.from.hue, "body"));
      });
    }

    /**
     * Places `out` on a plane's flight from `a` to `b` at `u` (0 to 1): a gentle arc that swings
     * out toward the camera (south-east) and a little up. Above the heads is where the bubbles
     * are, so a flight between neighbours swoops in front of the desks instead. Returns `out`.
     */
    function placeOnArc(a, b, u, out) {
      var dist = Math.hypot(b.x - a.x, b.z - a.z);
      var swing = Math.sin(Math.PI * u);
      var reach = 0.55 + dist * 0.06;
      var lift = Math.min(0.2 + dist * 0.12, 2.0);
      out.set(
        a.x + (b.x - a.x) * u + swing * reach * 0.36,
        a.y + (b.y - a.y) * u + swing * lift,
        a.z + (b.z - a.z) * u + swing * reach * 0.93
      );
      return out;
    }

    var scratchA = null;
    var scratchB = null;
    var scratchC = null;
    /** Places every plane in the air at minute `T` along its arc. Returns true when one flies. */
    function updatePlanes(sc, T) {
      if (!scratchA) {
        scratchA = new THREE.Vector3();
        scratchB = new THREE.Vector3();
        scratchC = new THREE.Vector3();
      }
      var any = false;
      // A plane is drawn larger from afar, so it still reads in the establishing shot.
      var size = clamp(sc.stage.camera.position.distanceTo(sc.stage.controls.target) / 12, 1.1, 4);
      sc.planes.forEach(function (pl) {
        var u = (T - pl.at) / FLIGHT;
        var flying = u >= 0 && u < 1 && pl.to.bean.visible && !api.reducedMotion;
        pl.mesh.visible = flying;
        pl.trail.visible = flying;
        if (!flying) return;
        any = true;
        // A message leaves from the sender's desk, where it was written, and lands where the
        // receiver belongs at that minute: its desk when it works (even if it is still walking
        // there), else the bean itself, in the queue at your desk or in the Lounge.
        if (pl.from.desk) scratchA.set(pl.from.desk.x, 0, pl.from.desk.z - 0.75);
        else pl.from.bean.getWorldPosition(scratchA);
        if (pl.to.desk && pl.to.place && pl.to.place.kind === "desk") scratchB.set(pl.to.desk.x, 0, pl.to.desk.z - 0.75);
        else pl.to.bean.getWorldPosition(scratchB);
        scratchA.y += 1.1;
        scratchB.y += 1.05;
        var e = u * u * (3 - 2 * u);
        placeOnArc(scratchA, scratchB, e, pl.mesh.position);
        pl.mesh.scale.setScalar(size);
        placeOnArc(scratchA, scratchB, Math.min(1, e + 0.02), scratchC);
        pl.mesh.lookAt(scratchC);
        pl.mesh.rotateZ(Math.sin(e * Math.PI * 2) * 0.25);
        // The trail: a dot every ~18 cm of the arc flown so far, so a short hop is dotted too.
        var pos = pl.trail.geometry.attributes.position;
        var arc = scratchA.distanceTo(scratchB) * 1.25 + 1.2;
        var dots = clamp(Math.round((arc * Math.max(0, e - 0.03)) / 0.18), 0, pl.count);
        for (var i = 0; i < dots; i++) {
          var k = dots > 1 ? (i / (dots - 1)) * Math.max(0, e - 0.03) : 0;
          placeOnArc(scratchA, scratchB, k, scratchC);
          pos.setXYZ(i, scratchC.x, scratchC.y, scratchC.z);
        }
        pos.needsUpdate = true;
        pl.trail.geometry.setDrawRange(0, dots);
      });
      return any;
    }

    /* -------------------------------------------------------------- room labels */

    /** Builds each room's label: its name, how many are here, and how many wait on you. */
    function buildRoomLabels(sc) {
      var p = sc.plan;
      p.rooms.forEach(function (room) {
        var node = makeElement("div", "gzo-room");
        node.innerHTML =
          (room.tint ? '<i class="gzo-room-tint gzo-room-tint--' + room.tint + '"></i>' : "") +
          '<b class="gzo-room-name">' + escapeHtml(room.name) + '</b><span class="gzo-room-count" hidden></span><span class="gzo-room-count gzo-room-count--you" hidden></span>';
        var r = room.rect;
        var at = room.kind === "project" ? [(r.minX + r.maxX) / 2 - 0.6, 0.1, r.maxZ - 0.45] : [(r.minX + r.maxX) / 2, 0.1, r.maxZ - 0.35];
        var label = sc.stage.label(at, node, { className: "gzo-room-wrap" });
        node.addEventListener("click", function () {
          flyToRoom(room);
        });
        sc.roomLabels.push({ room: room, at: at, node: node, label: label, count: node.children[room.tint ? 2 : 1], you: node.children[room.tint ? 3 : 2], present: -1, asking: -1 });
      });
    }

    /* -------------------------------------------------------------- the time engine */

    /**
     * Puts the Bureau at minute `T`: who is where and in what pose, what lies on each desk, the
     * labels, the room counts and the clock. With `walk`, beans that change place walk there
     * (a replay); without, they appear there at once (a scrub).
     */
    function applyTime(sc, T, walk) {
      var states = {};
      sc.beans.forEach(function (b) {
        states[b.sess.id] = readState(b.sess, T);
      });
      // The queue: oldest wait first.
      var queue = sc.beans.filter(function (b) {
        return states[b.sess.id].state === "waiting";
      });
      queue.sort(function (a, b) {
        return states[a.sess.id].since - states[b.sess.id].since || (a.sess.id < b.sess.id ? -1 : 1);
      });
      var queueIndex = {};
      queue.forEach(function (b, i) {
        queueIndex[b.sess.id] = i;
      });
      // The Lounge: a resting bean keeps its armchair; a newcomer takes the first free one. A
      // session with no project has no desk, so it stays in the Lounge whenever it is here.
      var resting = {};
      sc.beans.forEach(function (b) {
        var st = states[b.sess.id].state;
        if (st === "absent" || st === "waiting") return;
        if (!b.desk || st === "idle") resting[b.sess.id] = true;
      });
      Object.keys(sc.seatOf).forEach(function (id) {
        if (!resting[id]) delete sc.seatOf[id];
      });
      var taken = {};
      Object.keys(sc.seatOf).forEach(function (id) {
        taken[sc.seatOf[id]] = true;
      });
      sc.beans.forEach(function (b) {
        var id = b.sess.id;
        if (!resting[id] || sc.seatOf[id] != null) return;
        for (var i = 0; i < sc.seats.length; i++) {
          if (!taken[i]) {
            sc.seatOf[id] = i;
            taken[i] = true;
            break;
          }
        }
      });

      sc.beans.forEach(function (b) {
        var st = states[b.sess.id];
        var seat = sc.seatOf[b.sess.id];
        var target;
        if (st.state === "absent") target = { kind: "absent" };
        else if (st.state === "waiting") target = { kind: "queue", index: queueIndex[b.sess.id] };
        else if (seat != null) target = { kind: "lounge", seat: seat, pose: st.state === "working" ? "working" : b.sess.restPose };
        else if (b.desk) target = { kind: "desk", pose: st.state === "working" ? "working" : "idle" };
        else target = { kind: "absent" };
        moveBean(sc, b, target, walk);
        b.state = st;
      });

      // Desks: the stack grows with the work done, and the findings, cups and folders land.
      sc.plan.desks.forEach(function (d) {
        var props = sc.deskProps[d.sess.id];
        var b = sc.beanById[d.sess.id];
        var present = b.state.state !== "absent";
        var share = props.workedTotal > 0 ? workedUntil(d.sess, T) / props.workedTotal : 0;
        var sheets = present ? Math.round(props.full * clamp(share, 0, 1)) : 0;
        if (sheets !== props.sheets) {
          props.sheets = sheets;
          var stack = props.stack;
          stack.group.visible = sheets > 0;
          var h = Math.max(0.006, sheets * 0.0052);
          // Whole reams up to the height, the last one cut to fit.
          var y = 0;
          stack.reams.forEach(function (ream) {
            var part = Math.min(REAM_HEIGHT, h - y);
            ream.visible = part > 0.0005;
            if (!ream.visible) return;
            ream.scale.y = part;
            ream.position.y = y + part / 2;
            y += part;
          });
          stack.loose[0].position.y = h + 0.0016;
        }
        (props.findings || []).forEach(function (f) {
          f.group.visible = T >= f.at;
        });
        if (props.pr) props.pr.object.visible = T >= props.pr.at;
        if (props.failure) props.failure.object.visible = T >= props.failure.at;
        var bits = [];
        if (present && sheets > 0) {
          var k = clamp(share, 0, 1);
          var plus = Math.round(props.diff.plus * k);
          var minus = Math.round(props.diff.minus * k);
          bits.push(
            '<span class="gzo-desk-diff">' + (plus ? '<span class="gzo-plus">+' + plus + "</span>" : "") + (plus && minus ? " " : "") +
            (minus ? '<span class="gzo-minus">−' + minus + "</span>" : "") + "</span>"
          );
        }
        (props.findings || []).forEach(function (f) {
          if (T >= f.at) bits.push('<span class="gzo-desk-note" style="' + buildHueStyle(sc.beanById[f.f.by].hue) + '"><i></i>' + escapeHtml(describeFinding(f.f)) + "</span>");
        });
        if (props.pr && T >= props.pr.at) bits.push('<span class="gzo-desk-pr gzo-desk-pr--' + props.pr.pr.state + '"><i></i>' + (props.pr.pr.state === "draft" ? "draft PR #" : "PR #") + props.pr.pr.number + "</span>");
        if (props.failure && T >= props.failure.at) bits.push('<span class="gzo-desk-fail"><i></i>1 failing</span>');
        var cap = bits.join("");
        if (cap !== props.caption.html) {
          props.caption.html = cap;
          props.caption.node.innerHTML = cap;
          props.caption.node.hidden = !cap;
        }
        // A desk whose sitter queues at your desk keeps a marigold note on it.
        if (b.place && b.place.kind !== "desk") d.handle.setNote(b.state.state === "waiting");
      });
      if (sc.yourDesk) sc.yourDesk.setNote(queue.length > 0);
      if (sc.nowServing) sc.nowServing.setNumber(Math.max(1, queue.length));

      updateLabels(sc, T, states, queueIndex);
      updateRoomCounts(sc, states);
      if (sc.clock) {
        var m = Math.floor(T);
        sc.clock.setTime(new Date(2026, 8, 29, Math.floor(m / 60), m % 60, Math.floor((T - m) * 60)));
      }
      sc.stage.requestRender();
    }

    /** Returns the world spot of a place, and the room it is in. */
    function readSpot(sc, b, place) {
      var p = sc.plan;
      if (place.kind === "desk") return { x: b.desk.x, z: b.desk.z - 0.75, room: b.desk.room };
      if (place.kind === "queue") {
        var spot = p.byId["your-office"].queue[Math.min(place.index, p.byId["your-office"].queue.length - 1)];
        return { x: spot.x, z: spot.z, facing: spot.facing, seg: spot.seg, room: p.byId["your-office"] };
      }
      if (place.kind === "lounge") {
        var seat = sc.seats[place.seat];
        return { x: seat.x + Math.sin(seat.facing) * 0.62, z: seat.z + Math.cos(seat.facing) * 0.62, room: seat.room };
      }
      return { x: p.frontDoor.outside[0], z: p.frontDoor.outside[1], room: p.byId.lobby };
    }

    /** Returns true when two places are the same desk, queue spot or armchair. */
    function samePlace(a, b) {
      if (!a || !b || a.kind !== b.kind) return false;
      if (a.kind === "queue") return a.index === b.index;
      if (a.kind === "lounge") return a.seat === b.seat;
      return true;
    }

    /** Sets a bean down at its place at once, in its pose. */
    function settleBean(sc, b, place) {
      var bean = b.bean;
      if (place.kind === "absent") {
        bean.visible = false;
        return;
      }
      bean.visible = true;
      if (place.kind === "desk") {
        bean.setPose(place.pose);
        bean.sitAt(b.desk.handle);
      } else if (place.kind === "queue") {
        var s = readSpot(sc, b, place);
        bean.standAt(s.x, s.z, s.facing);
        bean.setPose("waiting");
      } else if (place.kind === "lounge") {
        bean.setPose(place.pose || "idle");
        bean.sitAt(sc.seats[place.seat].chair);
      }
    }

    /**
     * Moves a bean to its place for the minute shown. Teleports unless `walk`, when it walks the
     * corridors: out of its room by the door, along the Gallery, in by the other door.
     */
    function moveBean(sc, b, place, walk) {
      var was = b.place;
      if (samePlace(was, place)) {
        if (place.kind === "desk" && b.bean.pose !== place.pose && !b.walking) b.bean.setPose(place.pose);
        return;
      }
      b.place = place;
      b.moveId++;
      if (!walk || api.reducedMotion || place.kind === "absent") {
        b.walking = false;
        settleBean(sc, b, place);
        return;
      }
      var route = planRoute(sc, b, was, place);
      if (!route) {
        b.walking = false;
        settleBean(sc, b, place);
        return;
      }
      var bean = b.bean;
      if (!was || was.kind === "absent") {
        bean.visible = true;
        bean.standAt(route[0][0], route[0][1], Math.PI);
        bean.setPose("working");
      }
      bean.setPose(place.kind === "queue" ? "waiting" : place.kind === "lounge" ? "idle" : "working");
      var id = b.moveId;
      b.walking = true;
      var i = 0;
      function step() {
        if (b.moveId !== id || self.disposed) return;
        i++;
        if (i >= route.length) {
          b.walking = false;
          settleBean(sc, b, place);
          return;
        }
        bean.walkTo(route[i][0], route[i][1], undefined, PLAY_WALK).then(step);
      }
      step();
    }

    /** Returns the waypoints from a bean's current spot to its new place, or null to jump. */
    function planRoute(sc, b, was, place) {
      var p = sc.plan;
      var pts = [];
      var pos = b.bean.position;
      var fromRoom;
      if (!was || was.kind === "absent") {
        pts.push(p.frontDoor.outside, p.frontDoor.inside, [p.frontDoor.x, p.galleryZ]);
        fromRoom = null;
      } else if (b.walking) {
        pts.push([pos.x, pos.z]);
        fromRoom = findRoomAt(p, pos.x, pos.z);
        if (fromRoom && fromRoom.kind !== "gallery") pts.push(fromRoom.doorIn, fromRoom.doorOut);
        fromRoom = null;
      } else {
        var s = readSpot(sc, b, was);
        pts.push([pos.x, pos.z]);
        if (was.kind === "desk") {
          pts.push([b.desk.x, b.desk.behindZ], [b.desk.room.laneX, b.desk.behindZ], [b.desk.room.laneX, b.desk.room.frontZ]);
        } else if (was.kind === "lounge") {
          pts.push([s.x, s.z]);
        } else if (was.kind === "queue") {
          pts.push([s.x, s.z]);
        }
        fromRoom = s.room;
      }
      var to = readSpot(sc, b, place);
      if (fromRoom !== to.room) {
        if (fromRoom) pts.push(fromRoom.doorIn, fromRoom.doorOut);
        pts.push(to.room.doorOut, to.room.doorIn);
      }
      if (place.kind === "desk") {
        pts.push([b.desk.room.laneX, b.desk.room.frontZ], [b.desk.room.laneX, b.desk.behindZ], [b.desk.x, b.desk.behindZ]);
      } else if (place.kind === "lounge") {
        pts.push([to.x, to.z]);
      } else if (place.kind === "queue") {
        var yo = p.byId["your-office"];
        if (to.seg === 0) pts.push(yo.queuePath[2], yo.queuePath[1]);
        else pts.push(yo.queuePath[2]);
        pts.push([to.x, to.z]);
      }
      return pts;
    }

    /** Returns the room or corridor that holds the floor point (x, z), or null. */
    function findRoomAt(p, x, z) {
      var all = p.rooms.concat([p.gallery]);
      for (var i = 0; i < all.length; i++) {
        var r = all[i].rect;
        if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return all[i];
      }
      return null;
    }

    /* -------------------------------------------------------------- labels */

    /** Writes every label for minute `T`: bubbles, messages, name tags, and the crew bubbles. Writes the DOM only where the text changed. */
    function updateLabels(sc, T, states, queueIndex) {
      // The latest message each session received, while it is fresh.
      var message = {};
      sc.planes.forEach(function (pl) {
        if (T >= pl.at + FLIGHT && T < pl.at + FLIGHT + MESSAGE_SHOWN) message[pl.to.sess.id] = pl;
      });
      sc.beans.forEach(function (b) {
        var st = states[b.sess.id].state;
        var s = b.sess;
        var kind;
        var html;
        var pl = message[s.id];
        var said = pl
          ? '<div class="gzo-bubble gzo-bubble--message" style="' + buildHueStyle(pl.from.hue) + '"><span class="gzo-who">' +
            escapeHtml(pl.from.sess.name) + (pl.x.kind === "brief" ? " briefed it" : " reported") + '</span><span class="gzo-bubble-line">' + drawPlaneIcon(12) +
            '<span class="gzo-bubble-text">“' + escapeHtml(cutToFirstWords(pl.x.text, 34)) + "”</span></span></div>"
          : "";
        if (st === "absent") {
          kind = "none";
          html = "";
        } else if (st === "waiting") {
          // What waits on you stays on top: a fresh message stacks over the ask, never replaces it.
          kind = queueIndex[s.id] === 0 ? "waiting-head" : "waiting";
          html = said + '<div class="gzo-tag gzo-tag--waiting"><i class="gzo-dot"></i><b>' + escapeHtml(s.name) + "</b><span>" + escapeHtml(s.ask || "waiting on you") + "</span></div>";
          if (pl) kind = "waiting-message";
        } else if (pl) {
          kind = "message";
          html = said;
        } else if (st === "working") {
          kind = "bubble";
          html =
            '<div class="gzo-bubble"><span class="gzo-who">' + escapeHtml(s.name) + '</span><span class="gzo-bubble-line"><i class="gzo-dot"></i><span class="gzo-bubble-text">' +
            escapeHtml(readActivity(W, s, T)) + "</span></span></div>";
        } else {
          kind = "tag";
          var since = states[s.id].since;
          var word = st === "queued" ? "queued" : "idle " + formatAgo(T - since);
          html = '<div class="gzo-tag"><i class="gzo-dot"></i><b>' + escapeHtml(s.name) + "</b><span>" + escapeHtml(word) + "</span></div>";
        }
        var lab = b.label;
        if (lab.kind !== kind) {
          lab.kind = kind;
          lab.node.dataset.kind = kind;
          lab.dirty = true;
        }
        if (lab.html !== html) {
          lab.html = html;
          lab.node.innerHTML = html;
          lab.dirty = true;
        }
      });
      // One bubble per piece of work for the far zoom, over its members at work.
      sc.crews.forEach(function (crew) {
        var lines = [];
        var xs = 0;
        var zs = 0;
        var n = 0;
        crew.members.forEach(function (b) {
          var st = states[b.sess.id].state;
          var pl = message[b.sess.id];
          if (st !== "working" && !(pl && st !== "waiting" && st !== "absent" && b.place && b.place.kind === "desk")) return;
          if (pl) {
            lines.push('<span class="gzo-bubble-line" style="' + buildHueStyle(pl.from.hue) + '">' + drawPlaneIcon(12) + '<span class="gzo-bubble-text">“' + escapeHtml(cutToFirstWords(pl.x.text, 34)) + "”</span></span>");
          } else {
            lines.push('<span class="gzo-bubble-line" style="' + buildHueStyle(b.hue) + '"><i class="gzo-dot"></i><span class="gzo-bubble-text">' + escapeHtml(readActivity(W, b.sess, T)) + "</span></span>");
          }
          xs += b.desk.x;
          zs += b.desk.z - 0.75;
          n++;
        });
        var lab = crew.label;
        var kind = n ? "crew" : "none";
        var html = n ? '<div class="gzo-bubble gzo-bubble--crew">' + lines.join("") + "</div>" : "";
        if (n) crew.anchor.position.set(xs / n, 1.2, zs / n);
        crew.working = crew.members.filter(function (b) {
          return states[b.sess.id].state === "working";
        });
        if (lab.kind !== kind) {
          lab.kind = kind;
          lab.node.dataset.kind = kind;
          lab.dirty = true;
        }
        if (lab.html !== html) {
          lab.html = html;
          lab.node.innerHTML = html;
          lab.dirty = true;
        }
      });
    }

    /* -------------------------------------------------------------- label layout */

    var LABEL_RANK = { "waiting-message": 95, "waiting-head": 90, message: 80, waiting: 70, bubble: 60, tag: 40 };

    /** Returns true when a bean's label shows at the current zoom, as the stylesheet decides. */
    function isLabelShown(sc, b) {
      var kind = b.label.kind;
      if (!kind || kind === "none" || !b.bean.visible) return false;
      if (b.label.node.classList.contains("is-selected") || b.label.node.classList.contains("is-hovered")) return true;
      if (kind === "tag") return sc.zoom !== "far";
      // Far away, a piece of work speaks through its crew bubble.
      if ((kind === "bubble" || kind === "message") && sc.zoom === "far" && b.desk) return false;
      // Far away, the rest of the queue is a row of pips over their heads: they stay put.
      if (kind === "waiting" && sc.zoom === "far") return false;
      if (sc.swarm && b.label.node.classList.contains("is-muted") && kind === "message") return false;
      return true;
    }

    var projectedPoint = null;
    /**
     * Moves labels apart: in order of rank (what waits on you first), each label that would
     * overlap one already placed is lifted just clear of it, with a dotted leader down to its
     * head. Writes one custom property per label, only when it changed; reads sizes only after
     * a label's content or zoom changed.
     */
    function layoutLabels(sc) {
      if (!projectedPoint) projectedPoint = new THREE.Vector3();
      var cam = sc.stage.camera;
      cam.updateMatrixWorld();
      var w = stageHost.clientWidth;
      var h = stageHost.clientHeight;
      // The crumb and the dial are taken: labels keep clear of them.
      var hostBox = stageHost.getBoundingClientRect();
      var placed = [crumbBox, dialBox].map(function (node) {
        var b = node.getBoundingClientRect();
        return { l: b.left - hostBox.left, r: b.right - hostBox.left, t: b.top - hostBox.top, b: b.bottom - hostBox.top + 6 };
      });
      function project(x, y, z) {
        projectedPoint.set(x, y, z).project(cam);
        if (projectedPoint.z < -1 || projectedPoint.z > 1) return null;
        return [((projectedPoint.x + 1) / 2) * w, ((1 - projectedPoint.y) / 2) * h];
      }
      var chrome = placed.slice();
      sc.roomLabels.forEach(function (rl) {
        if (sc.zoom === "near") return;
        if (rl.w == null) {
          rl.w = rl.node.offsetWidth;
          rl.h = rl.node.offsetHeight;
        }
        var at = rl.at;
        var q = project(at[0], at[1], at[2]);
        if (!q) return;
        var box = { l: q[0] - rl.w / 2 - 2, r: q[0] + rl.w / 2 + 2, t: q[1] - rl.h / 2 - 2, b: q[1] + rl.h / 2 + 2 };
        // A room label that would slide under the crumb or the dial steps aside: it hides.
        var covered = chrome.some(function (o) {
          return box.l < o.r && box.r > o.l && box.t < o.b && box.b > o.t;
        });
        if (covered !== rl.covered) {
          rl.covered = covered;
          rl.node.classList.toggle("is-covered", covered);
        }
        if (!covered) placed.push(box);
      });
      // Close up, the desk captions hold their places under the desks.
      if (sc.zoom === "near") {
        sc.plan.desks.forEach(function (d) {
          var cap = sc.deskProps[d.sess.id].caption;
          if (!cap.html) return;
          if (cap.w == null || cap.measured !== cap.html) {
            cap.measured = cap.html;
            cap.w = cap.node.offsetWidth;
            cap.h = cap.node.offsetHeight;
          }
          var q = project(d.x, DESK_TOP + 0.02, d.z + 0.42);
          if (q) placed.push({ l: q[0] - cap.w / 2, r: q[0] + cap.w / 2, t: q[1] + 4, b: q[1] + 4 + cap.h });
        });
      }
      var items = [];
      var head = new THREE.Vector3();
      sc.beans.forEach(function (b) {
        var lab = b.label;
        if (!isLabelShown(sc, b)) {
          setLift(lab, 0);
          // A pip over a head in the queue stays put, and other labels keep clear of it.
          if (lab.kind === "waiting" && sc.zoom === "far" && b.bean.visible) {
            b.bean.getWorldPosition(head);
            var pq = project(head.x, head.y + b.bean.headHeight + 0.14, head.z);
            if (pq) placed.push({ l: pq[0] - 7, r: pq[0] + 7, t: pq[1] - 14, b: pq[1] });
          }
          return;
        }
        measureLabel(lab);
        b.bean.getWorldPosition(head);
        var q = project(head.x, head.y + b.bean.headHeight + 0.14, head.z);
        if (!q || q[0] < -200 || q[0] > w + 200) return;
        var rank = lab.node.classList.contains("is-selected") ? 100 : LABEL_RANK[lab.kind] || 0;
        items.push({ lab: lab, x: q[0], y: q[1], rank: rank });
      });
      var nb = sc.newsboy;
      if (nb.bean.visible && !nb.label.element.hidden) {
        measureLabel(nb.tag);
        nb.bean.getWorldPosition(head);
        var nq = project(head.x, head.y + nb.bean.headHeight + 0.14, head.z);
        if (nq) items.push({ lab: nb.tag, x: nq[0], y: nq[1], rank: 85 });
      }
      sc.crews.forEach(function (crew) {
        var lab = crew.label;
        var shown = sc.zoom === "far" && lab.kind === "crew" && !(sc.swarm && crew.room !== sc.focusRoom);
        if (!shown) {
          setLift(lab, 0);
          return;
        }
        measureLabel(lab);
        var a = crew.anchor.position;
        var q = project(a.x, a.y + 0.14, a.z);
        if (!q) return;
        items.push({ lab: lab, x: q[0], y: q[1], rank: LABEL_RANK.bubble });
      });
      items.sort(function (a, c) {
        return c.rank - a.rank || c.y - a.y;
      });
      // Each label tries spots above its head, then beside, then higher, and takes the cheapest
      // one that is clear of every label placed before it.
      var SHIFTS = [0, -0.55, 0.55, -1.05, 1.05];
      var segments = [];
      items.forEach(function (it) {
        var lab = it.lab;
        var best = null;
        for (var li = 0; li < 7; li++) {
          for (var si = 0; si < SHIFTS.length; si++) {
            var lift = li * (lab.bodyH + 5);
            var dx = SHIFTS[si] * lab.w;
            var cost = lift + Math.abs(dx) * 0.4;
            if (best && cost >= best.cost) continue;
            var left = it.x + dx - lab.anchor * lab.w;
            var right = left + lab.w;
            var bottom = it.y - lab.pad - lift;
            var top = bottom - lab.bodyH;
            if (top < 46 || left < 4 || right > w - 4) continue;
            var clear = true;
            for (var i = 0; i < placed.length; i++) {
              var o = placed[i];
              if (left < o.r + 3 && right > o.l - 3 && top < o.b + 3 && bottom > o.t - 3) {
                clear = false;
                break;
              }
            }
            if (clear) best = { cost: cost, lift: lift, dx: dx, l: left, r: right, t: top, b: bottom };
          }
        }
        if (!best) {
          var l0 = it.x - lab.anchor * lab.w;
          best = { lift: 0, dx: 0, l: l0, r: l0 + lab.w, t: it.y - lab.pad - lab.bodyH, b: it.y - lab.pad };
        }
        var moved = Math.hypot(best.dx, best.lift) > 3;
        // A label left in place keeps the floor down to the head for its tail; a moved one
        // trades its tail for a leader from the bottom of its body.
        placed.push(moved ? best : { l: best.l, r: best.r, t: best.t, b: best.b + lab.pad });
        setLift(lab, best.lift, best.dx);
        lab.node.classList.toggle("is-moved", moved);
        if (moved) {
          segments.push("M" + Math.round(it.x + best.dx) + " " + Math.round(best.b) + "L" + Math.round(it.x) + " " + Math.round(it.y - 2));
        }
      });
      var d = segments.join("");
      if (d !== sc.leaderPath) {
        sc.leaderPath = d;
        sc.leaders.setAttribute("d", d);
      }
    }

    /** Reads a label's size after its content, its kind or the zoom changed. */
    function measureLabel(lab) {
      if (!lab.dirty && lab.w != null) return;
      lab.dirty = false;
      lab.w = lab.node.offsetWidth;
      lab.h = lab.node.offsetHeight;
      var style = getComputedStyle(lab.node);
      lab.pad = parseFloat(style.paddingBottom) || 0;
      lab.bodyH = lab.h - lab.pad;
      lab.anchor = style.translate.indexOf("-38%") === 0 ? 0.38 : 0.5;
    }

    /** Moves a label up by `lift` and sideways by `dx` pixels; layoutLabels draws its leader. */
    function setLift(lab, lift, dx) {
      lift = Math.round(lift);
      dx = Math.round(dx || 0);
      if (lab.lift === lift && lab.dx === dx) return;
      lab.lift = lift;
      lab.dx = dx;
      var style = lab.node.style;
      style.setProperty("--gzo-lift", lift + "px");
      style.setProperty("--gzo-dx", dx + "px");
    }

    /** Returns a duration as the rows say it: "now", "12m", "2h", "1d". */
    function formatAgo(mins) {
      if (mins < 1) return "now";
      if (mins < 60) return Math.round(mins) + "m";
      if (mins < 24 * 60) return Math.floor(mins / 60) + "h";
      return Math.floor(mins / (24 * 60)) + "d";
    }

    /** Writes each room label's counts: who is here, and who waits on you. */
    function updateRoomCounts(sc, states) {
      var p = sc.plan;
      var present = {};
      var asking = {};
      sc.beans.forEach(function (b) {
        if (!b.place || b.place.kind === "absent") return;
        var room = b.place.kind === "desk" ? b.desk.room : b.place.kind === "queue" ? p.byId["your-office"] : p.byId.lounge;
        present[room.id] = (present[room.id] || 0) + 1;
        if (b.place.kind === "queue") asking[room.id] = (asking[room.id] || 0) + 1;
      });
      present.secretariat = sc.assistantBeans.length;
      sc.roomLabels.forEach(function (rl) {
        var n = present[rl.room.id] || 0;
        var a = asking[rl.room.id] || 0;
        if (n !== rl.present) {
          rl.present = n;
          rl.count.textContent = String(n - a);
          rl.count.hidden = n - a === 0;
          rl.count.title = n - a + " here";
        }
        if (a !== rl.asking) {
          rl.asking = a;
          rl.you.textContent = a + " waiting";
          rl.you.hidden = a === 0;
        }
      });
    }

    /* -------------------------------------------------------------- the frame */

    /** Runs before every drawn frame: moves the replay on, places the planes, the zoom and the labels. Returns true while the replay plays. */
    function onFrame(sc, frame) {
      var moving = false;
      if (self.playing) {
        var next = self.T + (frame.dt * self.speed) / 60;
        if (next >= self.stopAt) {
          next = self.stopAt;
          self.playing = false;
          setTime(next, { walk: true });
          onPlaybackEnd();
        } else {
          setTime(next, { walk: true });
        }
        moving = true;
      }
      // Planes follow the beans they fly between, so they are placed every drawn frame, but they
      // ask for no frames of their own: a dial parked mid-flight costs nothing.
      updatePlanes(sc, self.T);
      updateZoom(sc);
      layoutLabels(sc);
      return moving;
    }

    /** Sets the shown minute, redrawing what changed. */
    function setTime(T, opts) {
      opts = opts || {};
      T = clamp(T, DIAL_FROM, NOW);
      self.T = T;
      if (!scene) return;
      var quarter = Math.floor(T * 4);
      if (quarter !== scene.lastQuarter || opts.force) {
        scene.lastQuarter = quarter;
        applyTime(scene, T, !!opts.walk);
      }
      updatePlanes(scene, T);
      hud.showTime(T);
      scene.stage.requestRender();
    }

    /* -------------------------------------------------------------- semantic zoom */

    /** Reads the camera distance into the semantic zoom (far, room, near), and in the swarm picks the room whose bubbles show. */
    function updateZoom(sc) {
      var cam = sc.stage.camera.position;
      var target = sc.stage.controls.target;
      var d = cam.distanceTo(target);
      var zoom = d > ZOOM_FAR ? "far" : d > ZOOM_NEAR ? "room" : "near";
      if (zoom !== sc.zoom) {
        sc.zoom = zoom;
        root.dataset.zoom = zoom;
        markLabelsDirty(sc);
      }
      // In the swarm, bubbles show only in the room the camera looks at (or the selected one's).
      if (sc.swarm) {
        var focus = null;
        var sel = self.selected && sc.beanById[self.selected];
        if (sel && sel.desk) focus = sel.desk.room;
        else if (zoom !== "far") focus = findRoomAt(sc.plan, target.x, target.z);
        if (!focus || focus.kind !== "project") {
          var best = Infinity;
          sc.plan.rooms.forEach(function (room) {
            if (room.kind !== "project") return;
            var r = room.rect;
            var dd = Math.hypot((r.minX + r.maxX) / 2 - target.x, (r.minZ + r.maxZ) / 2 - target.z);
            if (dd < best) {
              best = dd;
              focus = room;
            }
          });
        }
        if (focus !== sc.focusRoom) {
          sc.focusRoom = focus;
          sc.beans.forEach(function (b) {
            b.label.node.classList.toggle("is-muted", !!b.desk && b.desk.room !== focus);
          });
          sc.crews.forEach(function (c) {
            c.label.node.classList.toggle("is-muted", c.room !== focus);
          });
          sc.roomLabels.forEach(function (rl) {
            rl.node.classList.toggle("is-focus", rl.room === focus);
          });
          markLabelsDirty(sc);
        }
      }
    }

    /** Marks every label to be measured again before the next layout. */
    function markLabelsDirty(sc) {
      sc.beans.forEach(function (b) {
        b.label.dirty = true;
      });
      sc.crews.forEach(function (c) {
        c.label.dirty = true;
      });
    }

    /* -------------------------------------------------------------- camera */

    /**
     * Returns the view that fits a floor rectangle in the canvas between the crumb (top) and the
     * dial (bottom), from `az` and `elev` degrees, as the kit's frame() does for the whole canvas.
     */
    function computeRectView(sc, rect, az, elev, margin) {
      var cam = sc.stage.camera;
      var rad = Math.PI / 180;
      var a = az * rad;
      var e = elev * rad;
      var H = stageHost.clientHeight || 900;
      var W2 = stageHost.clientWidth || 1440;
      var topPx = insetTop + 38;
      var bottomPx = 118;
      var usable = (H - topPx - bottomPx) / H;
      var back = new THREE.Vector3(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a));
      var right = new THREE.Vector3(0, 1, 0).cross(back).normalize();
      var up = back.clone().cross(right).normalize();
      var tanY = Math.tan((cam.fov / 2) * rad);
      var tanX = tanY * (W2 / H);
      var target = new THREE.Vector3((rect.minX + rect.maxX) / 2, 0.4, (rect.minZ + rect.maxZ) / 2);
      var dist = 0;
      [rect.minX, rect.maxX].forEach(function (x) {
        [rect.minZ, rect.maxZ].forEach(function (z) {
          [0, 1.2].forEach(function (y) {
            var o = new THREE.Vector3(x, y, z).sub(target);
            var toward = o.dot(back);
            dist = Math.max(dist, toward + Math.abs(o.dot(right)) / (tanX * 0.97), toward + Math.abs(o.dot(up)) / (tanY * usable));
          });
        });
      });
      dist *= margin || 1.06;
      // Move the target toward the camera along the floor, so the rectangle sits in the middle of
      // the band between the crumb and the dial rather than in the middle of the canvas.
      var px = (bottomPx - topPx) / 2;
      var worldPerPx = (2 * dist * tanY) / H;
      var ground = (px * worldPerPx) / Math.sin(e);
      target.x += Math.sin(a) * ground;
      target.z += Math.cos(a) * ground;
      return { target: [target.x, target.y, target.z], distance: dist, azimuth: az, elevation: elev };
    }

    /** Glides to a room and names it in the crumb. */
    function flyToRoom(room) {
      if (!scene) return;
      var v = computeRectView(scene, room.rect, 30, 46, 1.04);
      scene.focusView = v;
      scene.stage.flyTo(v.target, v.distance, { azimuth: v.azimuth, elevation: v.elevation, seconds: 0.9 });
      hud.showRoom(room);
    }

    /** Glides back to the establishing shot of the whole Bureau. */
    function flyHome() {
      if (!scene) return;
      var v = scene.establishing;
      scene.stage.flyTo(v.target, v.distance, { azimuth: v.azimuth, elevation: v.elevation, seconds: 0.9 });
      hud.showRoom(null);
    }

    /**
     * Glides to a bean, close enough to read its desk, with the bean right of and above the
     * middle of the canvas: the window's selection card takes the bottom-left corner.
     */
    function flyToBean(b, instant) {
      var pos = new THREE.Vector3();
      b.bean.getWorldPosition(pos);
      var az = 28;
      var el = 42;
      var dist = 11.5;
      var rad = Math.PI / 180;
      var H = stageHost.clientHeight || 900;
      var W2 = stageHost.clientWidth || 1440;
      var wpp = (2 * dist * Math.tan((scene.stage.camera.fov / 2) * rad)) / H;
      var right = new THREE.Vector3(Math.cos(az * rad), 0, -Math.sin(az * rad));
      var toward = new THREE.Vector3(Math.sin(az * rad), 0, Math.cos(az * rad));
      var target = pos.clone();
      target.y = 0.6;
      target.addScaledVector(right, -0.1 * W2 * wpp);
      target.addScaledVector(toward, (0.06 * H * wpp) / Math.sin(el * rad));
      if (instant) scene.stage.view({ target: target, distance: dist, azimuth: az, elevation: el });
      else scene.stage.flyTo(target, dist, { azimuth: az, elevation: el, seconds: 0.9 });
      var room = b.place && b.place.kind === "desk" ? b.desk.room : findRoomAt(scene.plan, pos.x, pos.z);
      hud.showRoom(room && room.kind !== "gallery" ? room : null);
    }

    /* -------------------------------------------------------------- picking */

    /** Wires the pointer: a click on a bean selects it (a second click opens it), a click on a floor flies to its room, and hover perks a bean up. */
    function wirePicking(sc) {
      var last = { id: null, at: 0 };
      var pickables = sc.beans.map(function (b) {
        return b.bean;
      });
      sc.stage.onPick(pickables.concat([sc.stage.building]), function (object, hit) {
        if (object === sc.stage.building) {
          var room = findRoomAt(sc.plan, hit.point.x, hit.point.z);
          if (room && room.kind !== "gallery") flyToRoom(room);
          return;
        }
        var b = null;
        sc.beans.forEach(function (each) {
          if (each.bean === object) b = each;
        });
        if (!b) return;
        var now = performance.now();
        if (last.id === b.sess.id && now - last.at < 420) {
          last.id = null;
          api.onOpen && api.onOpen(b.sess.id);
          return;
        }
        last.id = b.sess.id;
        last.at = now;
        select(b.sess.id);
        api.onSelect && api.onSelect(b.sess.id);
      });
      // Hover: the bean perks up and its label lifts.
      var ray = new THREE.Raycaster();
      var ndc = new THREE.Vector2();
      var hovered = null;
      var pending = 0;
      var canvas = sc.stage.renderer.domElement;
      function onMove(ev) {
        if (ev.buttons !== 0 || pending) return;
        pending = requestAnimationFrame(function () {
          pending = 0;
          var rect = canvas.getBoundingClientRect();
          ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
          ray.setFromCamera(ndc, sc.stage.camera);
          var proxies = [];
          sc.beans.forEach(function (b) {
            if (b.bean.visible) proxies.push(b.proxy);
          });
          var hit = ray.intersectObjects(proxies, false)[0];
          var b = null;
          if (hit) sc.beans.forEach(function (each) {
            if (each.bean === hit.object.parent) b = each;
          });
          if (b === hovered) return;
          if (hovered) {
            hovered.bean.rig.setHovered(false);
            hovered.label.node.classList.remove("is-hovered");
            hovered.label.dirty = true;
          }
          hovered = b;
          if (b) {
            b.bean.rig.setHovered(true);
            b.label.node.classList.add("is-hovered");
            b.label.dirty = true;
          }
          sc.stage.requestRender();
        });
      }
      function onLeave() {
        if (hovered) {
          hovered.bean.rig.setHovered(false);
          hovered.label.node.classList.remove("is-hovered");
          hovered = null;
          sc.stage.requestRender();
        }
      }
      canvas.addEventListener("pointermove", onMove);
      canvas.addEventListener("pointerleave", onLeave);
      sc.unsubscribe.push(function () {
        canvas.removeEventListener("pointermove", onMove);
        canvas.removeEventListener("pointerleave", onLeave);
        cancelAnimationFrame(pending);
      });
    }

    /* -------------------------------------------------------------- selection */

    /** Selects a bean (its ring and label) and glides to it; null clears the selection and flies home. */
    function select(id, opts) {
      opts = opts || {};
      if (!scene) {
        self.selected = id;
        return;
      }
      var b = id ? scene.beanById[id] : null;
      var same = self.selected === id;
      self.selected = b ? id : null;
      scene.beans.forEach(function (each) {
        each.bean.rig.setSelected(each === b);
        each.label.node.classList.toggle("is-selected", each === b);
        each.label.dirty = true;
      });
      if (scene.swarm) scene.focusRoom = undefined;
      scene.stage.requestRender();
      if (same && !opts.force) return;
      // A thread the Bureau does not seat (an assistant's thread, say) keeps the camera where it is.
      if (b && b.bean.visible) flyToBean(b);
      else if (!id && !opts.stay) flyHome();
    }

    /* -------------------------------------------------------------- playback and states */

    /** Plays the morning from `from` (or the minute shown) to `to` at `speed` times real time. */
    function play(from, to, speed) {
      if (from != null) setTime(from, { force: true });
      self.stopAt = to != null ? to : NOW;
      if (speed) {
        self.speed = speed;
        hud.showSpeed(speed);
      }
      if (self.T >= self.stopAt) setTime(DIAL_FROM, { force: true });
      self.playing = true;
      hud.showPlaying(true);
      if (scene) scene.stage.requestRender();
    }
    /** Pauses the replay; beans still walking take their places at once. */
    function pausePlayback() {
      self.playing = false;
      hud.showPlaying(false);
      // Walks in flight finish where they were going.
      if (scene) applyTime(scene, self.T, false);
    }
    /** Rests the dial where the replay stopped. */
    function onPlaybackEnd() {
      hud.showPlaying(false);
      hud.showTime(self.T);
    }

    /**
     * "While you were away": the newsboy brings the Gazette to your desk, the camera watching
     * Your Office; then the camera pulls back and the Bureau replays 09:01 to 09:41 at 30x with
     * captions, and rests on now. With the paper already on the desk, it replays at once.
     */
    function startAway() {
      var sc = scene;
      self.playing = false;
      hud.showPlaying(false);
      hud.markAway(true);
      setTime(AWAY_FROM, { force: true });
      hud.showWire(true, AWAY_FROM);
      function replay() {
        if (self.disposed || scene !== sc) return;
        flyHome();
        play(AWAY_FROM, NOW, 30);
      }
      if (sc.gazette.visible || api.reducedMotion) {
        replay();
        return;
      }
      var yo = sc.plan.byId["your-office"];
      var r = yo.rect;
      var lobby = sc.plan.byId.lobby.rect;
      sc.stage.view(computeRectView(sc, { minX: r.minX - 0.4, maxX: lobby.maxX + 0.3, minZ: sc.plan.zG1 - 0.6, maxZ: r.maxZ + 0.9 }, 24, 50, 1.0));
      hud.showRoom(yo);
      deliverPaper(replay);
    }

    /** The newsboy walks in through the front door to your desk, puts the Gazette down and leaves. */
    function deliverPaper(done) {
      var sc = scene;
      var nb = sc.newsboy;
      var run = ++nb.run;
      var p = sc.plan;
      var yo = p.byId["your-office"];
      var desk = [yo.deskX + 1.35, yo.deskZ - 0.2];
      var route = [p.frontDoor.inside, [p.frontDoor.x, p.galleryZ], yo.doorOut, yo.doorIn, [yo.deskX + 1.35, yo.queuePath[1][1] + 0.4], desk];
      var boy = nb.bean;
      if (api.reducedMotion) {
        sc.gazette.visible = true;
        if (done) done();
        return;
      }
      boy.visible = true;
      nb.label.element.hidden = false;
      boy.standAt(p.frontDoor.outside[0], p.frontDoor.outside[1], Math.PI);
      var i = -1;
      function step() {
        if (run !== nb.run || self.disposed) return;
        i++;
        if (i < route.length) {
          boy.walkTo(route[i][0], route[i][1], i === route.length - 1 ? -Math.PI / 2 : undefined, 3.0).then(step);
          return;
        }
        sc.gazette.visible = true;
        boy.play("hop");
        sc.stage.requestRender();
        setTimeout(function () {
          if (run !== nb.run || self.disposed) return;
          boy.play(null);
          if (done) done();
          var back = route.slice(0, route.length - 1).reverse().concat([p.frontDoor.outside]);
          var j = -1;
          function out() {
            if (run !== nb.run || self.disposed) return;
            j++;
            if (j < back.length) {
              boy.walkTo(back[j][0], back[j][1], undefined, 3.0).then(out);
              return;
            }
            boy.visible = false;
            nb.label.element.hidden = true;
            sc.stage.requestRender();
          }
          out();
        }, 1400);
      }
      step();
    }

    /** Sends the newsboy away at once, and shows or hides the Gazette on your desk. */
    function stopNewsboy(showPaper) {
      if (!scene) return;
      var nb = scene.newsboy;
      nb.run++;
      nb.bean.visible = false;
      nb.label.element.hidden = true;
      if (scene.gazette) scene.gazette.visible = !!showPaper;
    }

    /** Draws one of this mode's states: the minute shown, the newsboy and the paper, the wire. */
    function applyState(state, initial) {
      self.state = state;
      root.dataset.gzoState = state;
      self.playing = false;
      hud.showPlaying(false);
      hud.markAway(state === "away" || state === "edition");
      if (state === "replay") {
        stopNewsboy(false);
        // Parked at 09:21, as the Stripe research's report is in the air to the 3-D Secure fix.
        setTime(minutes("09:21") + 0.42, { force: true });
        hud.showWire(true);
      } else if (state === "away") {
        stopNewsboy(false);
        if (api.reducedMotion) {
          scene.gazette.visible = true;
          setTime(NOW, { force: true });
          hud.showWire(true, AWAY_FROM);
        } else {
          setTimeout(function () {
            if (!self.disposed && self.state === "away") startAway();
          }, initial ? 400 : 0);
          setTime(AWAY_FROM, { force: true });
        }
      } else if (state === "edition") {
        // Back from being away, with the paper on the desk: the wire keeps what happened since 09:01.
        stopNewsboy(true);
        setTime(NOW, { force: true });
        hud.showWire(true, AWAY_FROM);
      } else {
        stopNewsboy(false);
        setTime(NOW, { force: true });
        hud.showWire(false);
      }
      if (state === "open" && !self.selected && !initial) select("t3ds", { force: true });
    }

    /* -------------------------------------------------------------- the HUD: crumb, dial, wire */

    /** Builds the crumb (top left), the time dial and the wire of captions (bottom). Returns their controls. */
    function buildHud() {
      var crumb = makeElement("nav", "gzo-crumb");
      crumb.innerHTML =
        '<button type="button" class="gzo-crumb-home">' +
        '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 7.2 8 2.8l5.5 4.4V13a.5.5 0 0 1-.5.5H9.6V10H6.4v3.5H3a.5.5 0 0 1-.5-.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>' +
        "The Bureau</button>" +
        '<span class="gzo-crumb-sep" hidden>›</span><b class="gzo-crumb-room" hidden></b>';
      root.appendChild(crumb);
      var home = crumb.querySelector(".gzo-crumb-home");
      var sep = crumb.querySelector(".gzo-crumb-sep");
      var roomName = crumb.querySelector(".gzo-crumb-room");
      home.addEventListener("click", function () {
        flyHome();
      });

      var wire = makeElement("div", "gzo-wire");
      wire.setAttribute("aria-live", "polite");
      root.appendChild(wire);

      var dial = makeElement("div", "gzo-dial");
      var range = NOW - DIAL_FROM;
      function pct(t) {
        return ((t - DIAL_FROM) / range) * 100;
      }
      dial.innerHTML =
        '<div class="gzo-dial-row">' +
        '<button type="button" class="gzo-play" aria-label="Play the morning"><svg class="gzo-i-play" width="14" height="14" viewBox="0 0 16 16"><path d="M4.5 2.8v10.4L13 8z" fill="currentColor"/></svg><svg class="gzo-i-pause" width="14" height="14" viewBox="0 0 16 16"><path d="M4 3h2.8v10H4zm5.2 0H12v10H9.2z" fill="currentColor"/></svg></button>' +
        '<div class="gzo-clock"><span class="gzo-clock-time">09:41</span><span class="gzo-clock-note">Now</span></div>' +
        '<span class="gzo-spacer"></span>' +
        '<div class="gzo-speed" role="group" aria-label="Replay speed">' +
        SPEEDS.map(function (s) {
          return '<button type="button" data-speed="' + s + '" aria-pressed="' + (s === 30) + '">' + s + "×</button>";
        }).join("") +
        "</div>" +
        '<button type="button" class="gzo-away-btn"><i class="gzo-you-dot"></i>While you were away</button>' +
        '<button type="button" class="gzo-now-btn">Now</button>' +
        "</div>" +
        '<div class="gzo-track" tabindex="0" role="slider" aria-label="Time of the morning" aria-valuemin="' + DIAL_FROM + '" aria-valuemax="' + NOW + '">' +
        '<div class="gzo-track-away" style="left:' + pct(AWAY_FROM) + "%;width:" + (100 - pct(AWAY_FROM)) + '%"><span>You were away</span></div>' +
        '<div class="gzo-track-line"></div><div class="gzo-track-done"></div>' +
        '<div class="gzo-ticks"></div>' +
        '<div class="gzo-hours">' +
        ["07:00", "07:30", "08:00", "08:30", "09:00", "09:30"].map(function (t) {
          var m = minutes(t);
          return '<span class="' + (m % 60 === 0 ? "is-hour" : "") + '" style="left:' + pct(m) + '%">' + t + "</span>";
        }).join("") +
        '<span class="is-now" style="left:100%">' + W.now + "</span></div>" +
        '<div class="gzo-head"><i></i></div>' +
        "</div>";
      root.appendChild(dial);
      var playBtn = dial.querySelector(".gzo-play");
      var clockTime = dial.querySelector(".gzo-clock-time");
      var clockNote = dial.querySelector(".gzo-clock-note");
      var track = dial.querySelector(".gzo-track");
      var head = dial.querySelector(".gzo-head");
      var done = dial.querySelector(".gzo-track-done");
      var ticks = dial.querySelector(".gzo-ticks");
      var nowBtn = dial.querySelector(".gzo-now-btn");
      var awayBtn = dial.querySelector(".gzo-away-btn");
      var wireShown = false;
      var wireFrom = null;
      var lastWire = null;

      playBtn.addEventListener("click", function () {
        if (self.playing) pausePlayback();
        else play(self.T >= NOW ? DIAL_FROM : null, NOW);
      });
      nowBtn.addEventListener("click", function () {
        self.playing = false;
        showPlaying(false);
        setTime(NOW, { force: true });
      });
      awayBtn.addEventListener("click", function () {
        startAway();
      });
      dial.querySelectorAll("[data-speed]").forEach(function (b) {
        b.addEventListener("click", function () {
          self.speed = Number(b.dataset.speed);
          dial.querySelectorAll("[data-speed]").forEach(function (o) {
            o.setAttribute("aria-pressed", String(o === b));
          });
        });
      });
      // Dragging the dial scrubs: beans appear where they were, without walking.
      var dragging = false;
      function scrubTo(ev) {
        var r = track.getBoundingClientRect();
        var u = clamp((ev.clientX - r.left) / r.width, 0, 1);
        var t = DIAL_FROM + u * range;
        // Snap to an event within 4px, so the captions line up.
        var px = 4 / r.width * range;
        if (scene) scene.events.forEach(function (e) {
          if (Math.abs(e.t - t) < px) t = e.t + 0.02;
        });
        setTime(t);
      }
      track.addEventListener("pointerdown", function (ev) {
        dragging = true;
        track.setPointerCapture(ev.pointerId);
        if (self.playing) {
          self.playing = false;
          showPlaying(false);
        }
        root.classList.add("is-scrubbing");
        scrubTo(ev);
      });
      track.addEventListener("pointermove", function (ev) {
        if (dragging) scrubTo(ev);
      });
      function endDrag() {
        dragging = false;
        root.classList.remove("is-scrubbing");
      }
      track.addEventListener("pointerup", endDrag);
      track.addEventListener("pointercancel", endDrag);
      track.addEventListener("keydown", function (ev) {
        var step = ev.shiftKey ? 10 : 1;
        if (ev.key === "ArrowLeft") setTime(Math.floor(self.T) - step + 0.02, { force: true });
        else if (ev.key === "ArrowRight") setTime(Math.floor(self.T) + step + 0.02, { force: true });
        else if (ev.key === "Home") setTime(DIAL_FROM, { force: true });
        else if (ev.key === "End") setTime(NOW, { force: true });
        else if (ev.key === " ") {
          if (self.playing) pausePlayback();
          else play(null, NOW);
        } else return;
        ev.preventDefault();
      });

      function drawTicks(events) {
        ticks.innerHTML = events
          .map(function (e) {
            var b = scene && scene.beanById[e.who];
            var hue = b ? b.hue : "iris";
            return (
              '<i class="gzo-tick gzo-tick--' + e.kind + '" style="left:' + pct(e.t) + "%;" + buildHueStyle(hue) + '" title="' +
              escapeHtml(formatTime(e.t) + " · " + e.html.replace(/<[^>]+>/g, "")) + '"></i>'
            );
          })
          .join("");
      }

      function showPlaying(on) {
        playBtn.classList.toggle("is-playing", on);
        playBtn.setAttribute("aria-label", on ? "Pause" : "Play the morning");
        root.classList.toggle("is-playing", on);
        if (on && !wireShown) showWire(true);
      }

      function showTime(T) {
        var u = pct(T);
        head.style.left = u + "%";
        done.style.width = u + "%";
        clockTime.textContent = formatTime(T);
        var live = T >= NOW - 0.001;
        clockNote.textContent = self.playing ? "Replaying at " + self.speed + "×" : live ? "Now" : "The past · " + Math.round(NOW - T) + " min ago";
        root.classList.toggle("is-past", !live);
        nowBtn.disabled = live && !self.playing;
        track.setAttribute("aria-valuenow", String(Math.round(T)));
        track.setAttribute("aria-valuetext", formatTime(T));
        drawWire(T);
      }

      function showWire(on, from) {
        wireShown = on;
        wireFrom = from != null ? from : null;
        lastWire = null;
        drawWire(self.T);
      }

      /** Draws the last three events up to `T`: the newest at the bottom, the older fading. */
      function drawWire(T) {
        if (!scene) return;
        var show = wireShown || T < NOW - 0.001;
        var lines = [];
        if (show) {
          var since = wireFrom != null ? wireFrom : T - 12;
          scene.events.forEach(function (e) {
            if (e.t <= T + 0.001 && e.t >= since && !e.quiet) lines.push(e);
          });
          lines = lines.slice(-3);
        }
        var key = lines.map(function (e) { return e.t + e.kind + e.who; }).join("|") + show;
        if (key === lastWire) return;
        lastWire = key;
        wire.innerHTML = lines
          .map(function (e, i) {
            var b = scene.beanById[e.who];
            var hue = b ? b.hue : "iris";
            var age = lines.length - 1 - i;
            return (
              '<div class="gzo-wire-line gzo-wire-line--' + e.kind + '" data-age="' + age + '">' +
              '<span class="gzo-wire-time">' + formatTime(e.t) + "</span>" +
              (e.kind === "message" ? '<span class="gzo-wire-mark" style="' + buildHueStyle(hue) + '">' + drawPlaneIcon(13) + "</span>" : '<i class="gzo-dot" style="' + buildHueStyle(hue) + '"></i>') +
              '<span class="gzo-wire-text">' + e.html + "</span></div>"
            );
          })
          .join("");
        wire.classList.toggle("is-shown", lines.length > 0);
      }

      function showRoom(room) {
        sep.hidden = !room;
        roomName.hidden = !room;
        roomName.textContent = room ? room.name : "";
        crumb.classList.toggle("is-in", !!room);
      }

      function showSpeed(speed) {
        dial.querySelectorAll("[data-speed]").forEach(function (o) {
          o.setAttribute("aria-pressed", String(Number(o.dataset.speed) === speed));
        });
      }

      function markAway(on) {
        dial.classList.toggle("is-away", on);
      }

      return {
        drawTicks: drawTicks, showPlaying: showPlaying, showSpeed: showSpeed, showTime: showTime, showWire: showWire, showRoom: showRoom, markAway: markAway,
        dispose: function () {
          crumb.remove();
          dial.remove();
          wire.remove();
        },
      };
    }

    /* -------------------------------------------------------------- lifecycle */

    /** Builds the scene, replacing the one shown. */
    function build(swarm) {
      if (scene) teardown();
      scene = buildScene(swarm);
      hud.drawTicks(scene.events);
      root.classList.toggle("is-swarm", swarm);
      scene.lastQuarter = null;
    }

    /** Stops and frees the scene: its stage, its WebGL context and its listeners. */
    function teardown() {
      if (!scene) return;
      self.playing = false;
      scene.beans.forEach(function (b) {
        b.moveId++;
      });
      scene.newsboy.run++;
      scene.unsubscribe.forEach(function (fn) {
        fn();
      });
      if (scene.stopFrame) scene.stopFrame();
      scene.stage.dispose();
      stageHost.innerHTML = "";
      scene = null;
    }

    /** Escape flies back to the whole Bureau. */
    function onKey(ev) {
      if (ev.key === "Escape" && scene) {
        flyHome();
      }
    }
    root.addEventListener("keydown", onKey);
    root.addEventListener("pointerdown", function () {
      if (document.activeElement === document.body) root.focus({ preventScroll: true });
    });

    build(self.state === "swarm");
    applyState(self.state, true);
    // Open on the establishing shot, then glide to the selected bean, so the Bureau is seen first.
    var initial = api.selected || (self.state === "open" ? "t3ds" : null);
    if (initial && self.state !== "away") {
      self.selected = null;
      setTimeout(function () {
        if (!self.disposed && scene && !self.selected) select(initial, { force: true });
      }, 650);
    }

    var handle = {
      select: function (id) {
        select(id || null);
      },
      setState: function (state) {
        state = normalizeState(state);
        var swarm = state === "swarm";
        if (!!(scene && scene.swarm) !== swarm) {
          var keep = self.selected;
          build(swarm);
          self.selected = null;
          if (keep) select(keep, { force: true });
        }
        applyState(state);
      },
      resize: function () {
        clearTopChrome();
        if (scene) scene.stage.requestRender();
      },
      pause: function () {
        if (scene) scene.stage.pause();
      },
      resume: function () {
        if (scene) scene.stage.resume();
      },
      dispose: function () {
        self.disposed = true;
        teardown();
        hud.dispose();
        root.removeEventListener("keydown", onKey);
        root.remove();
      },
      // For scripted checks and screenshots.
      debug: {
        setTime: function (t) {
          self.playing = false;
          setTime(typeof t === "string" ? minutes(t) : t, { force: true });
        },
        flyToRoom: function (id) {
          if (scene) flyToRoom(scene.plan.byId[id]);
        },
        // Places the camera on a room at once (a headless browser draws about one frame a second).
        frameRoom: function (id) {
          if (!scene) return;
          var room = scene.plan.byId[id];
          scene.stage.view(computeRectView(scene, room.rect, 30, 46, 1.04));
          hud.showRoom(room);
        },
        establish: function (az, el, margin) {
          if (!scene) return;
          var p = scene.plan;
          scene.establishing = computeRectView(scene, { minX: p.x0 - 0.2, maxX: p.x0 + p.width + 0.2, minZ: p.zN - 0.2, maxZ: p.zS + 0.6 }, az, el, margin);
          scene.stage.view(scene.establishing);
        },
        selectNow: function (id) {
          if (!scene) return;
          select(id, { stay: true });
          var b = scene.beanById[id];
          if (b) flyToBean(b, true);
        },
        desks: function () {
          return scene ? scene.plan.desks.map(function (d) { return [d.sess.id, +d.x.toFixed(2), +d.z.toFixed(2)]; }) : [];
        },
        view: function (v) {
          if (scene) scene.stage.view(v);
        },
        newsboyAt: function (i) {
          if (!scene) return;
          var p = scene.plan;
          var yo = p.byId["your-office"];
          var boy = scene.newsboy.bean;
          scene.newsboy.run++;
          boy.visible = true;
          scene.newsboy.label.element.hidden = false;
          var spots = [[p.frontDoor.x, p.galleryZ], yo.doorOut, yo.doorIn, [yo.deskX + 1.35, yo.deskZ - 0.2]];
          var s = spots[Math.min(i, spots.length - 1)];
          boy.standAt(s[0], s[1], i >= spots.length - 1 ? -Math.PI / 2 : -Math.PI / 2);
          boy.play("walk");
          scene.stage.requestRender();
        },
        get scene() {
          return scene;
        },
        get self() {
          return self;
        },
      },
    };
    return handle;
  }

  window.OfficeModes = window.OfficeModes || {};
  window.OfficeModes.gazette = { mount: mount };
})();
