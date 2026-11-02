// PROTOTYPE - Control Tower's live window: "Every turn is a flight, and you are the tower".
//
// The sidebar is the strip board folded to 272px: bays Holding, Approach, Cruising, On stand,
// Parked and the Hangar. The overview (the sidebar's Office button, ⌘⇧O) has three modes that
// look at the same flights: Office (the Aerodrome, the office builder's module), Threads (the
// strip board at full width, with the arrivals of the next hour along the top) and Radar (a scope
// with Rogier at its centre, rings for minutes until a thread needs him, and an arrivals board).
//
// URL: ?mode=office|threads|radar
//      ?state=everyday|open|swarm|away|slots|conflict|staggered|landing|moving
//      ?theme=whitehaven|orient-express  ?select=<thread id>
// Keys: ⌘⇧O opens and closes the overview; ⌥⌘1, ⌥⌘2, ⌥⌘3 pick Office, Threads, Radar
//       (⌘1-⌘9 belong to Go); esc closes a popover, then the selection, then the overview.
//
// Load order: world.js, world-plus.js, control-tower-data.js, stage.js, this file, brands.js,
// crew.js. Every rule in control-tower.css sits under .ov-control-tower and every class here
// starts with ct-.
(function () {
  "use strict";

  var W = window.WORLD;
  var T = W.tower;
  var H = W.helpers;
  var root = document.documentElement;
  var params = new URLSearchParams(location.search);
  var STATE = root.dataset.state || params.get("state") || "everyday";

  var MODES = [
    { id: "office", label: "Office", hint: "The Aerodrome", key: "1" },
    { id: "threads", label: "Threads", hint: "The strip board", key: "2" },
    { id: "radar", label: "Radar", hint: "When each thread will need you", key: "3" },
  ];
  var BAYS = [
    { id: "holding", label: "Holding", sub: "Needs you now, oldest first" },
    { id: "approach", label: "Approach", sub: "Due within about 15 min" },
    { id: "cruising", label: "Cruising", sub: "Working; needs you later" },
    { id: "stand", label: "On stand", sub: "A result you have not read" },
    { id: "parked", label: "Parked", sub: "Idle, nothing unread" },
  ];
  var BAY_LABEL = { holding: "Holding", held: "Held back", approach: "Approach", cruising: "Cruising", stand: "On stand", parked: "Parked" };
  var BASE = H.minutes(W.now); // WORLD.eta ranges count from 09:41
  var motion = window.matchMedia("(prefers-reduced-motion: reduce)");

  var api = null; // Stage.api, once the stage has built the window
  var startMode = params.get("mode");
  if (!MODES.some(function (m) { return m.id === startMode; })) startMode = "radar";

  var ui = {
    now: BASE,
    overview: STATE !== "open",
    mode: startMode,
    selected: params.get("select") || null,
    answered: {}, // id -> { at, label }: a Request Rogier cleared
    held: {}, // id -> "HH:MM": an inbound flight held back to a time; "you" holds until he lets it land
    priority: {}, // id -> true: lands first, and comes through slots
    landed: {}, // id -> "HH:MM": a turn that ended while the window was open
    slots: copy(STATE === "slots" ? T.slots.slots : T.slots.off),
    staggered: false,
    conflictDismissed: false,
    conflictOpen: STATE === "conflict",
    deckOpen: false,
    hangarOpen: false,
    moreOpen: {},
    handover: STATE === "away",
    popover: null,
    pointerIn: { side: STATE === "moving", board: false },
    shown: { side: {}, board: {} }, // id -> bay as last drawn, so a change can wait for the pointer
    act: false, // true while drawing the result of Rogier's own action: it shows at once
  };
  // The staggered state is the conflict after Rogier pressed Stagger.
  if (STATE === "staggered") {
    ui.staggered = true;
    T.conflict.hold.forEach(function (h) { ui.held[h.id] = h.to; });
  }

  /* ------------------------------------------------------------------ small helpers */

  function copy(o) {
    var c = {};
    for (var k in o) c[k] = o[k];
    return c;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch];
    });
  }
  /** Returns "HH:MM" for minutes since midnight. */
  function clock(m) {
    m = ((Math.round(m) % 1440) + 1440) % 1440;
    var h = Math.floor(m / 60);
    var mm = m % 60;
    return (h < 10 ? "0" : "") + h + ":" + (mm < 10 ? "0" : "") + mm;
  }
  /** Returns how long ago a time was, as rows say it: "now", "12m", "2h", "1d". */
  function ago(time) {
    var m = ui.now - H.minutes(time);
    if (m < 1) return "now";
    if (m < 60) return m + "m";
    if (m < 1440) return Math.floor(m / 60) + "h";
    return Math.floor(m / 1440) + "d";
  }
  function times(s, n) {
    var out = "";
    for (var i = 0; i < n; i++) out += s;
    return out;
  }
  function tintOf(project) {
    var p = W.projects.filter(function (x) { return x.id === project; })[0];
    return p ? "var(--proj-" + p.tint + ")" : "var(--line)";
  }
  function projName(project) {
    return project || "No project";
  }
  function hueOf(title) {
    return "--hue:var(--hue-" + Crew.lookFor(title).hue + ")";
  }
  function icon(name, size) {
    return Crew.icon(name, size || 16);
  }

  // Icons the kit does not have, drawn in its family: 16px, 1.5 stroke, round caps.
  var OWN_ICONS = {
    radar: '<circle cx="8" cy="8" r="6.2"/><circle cx="8" cy="8" r="3.2"/><path d="M8 8 12.4 3.6"/><circle cx="10.6" cy="9.8" r=".6" fill="currentColor"/>',
    strips: '<rect x="2" y="2.6" width="12" height="3.2" rx="1"/><rect x="2" y="7.4" width="12" height="3.2" rx="1"/><path d="M4.4 2.6v3.2M4.4 7.4v3.2M2 13.4h7"/>',
    plane: '<path d="M14 8 7.6 7.2 5.4 3H4.2l1 4.1-2.6.3L1.8 5.8H1L1.4 8 1 10.2h.8l.8-1.6 2.6.3-1 4.1h1.2l2.2-4.2L14 8z"/>',
    mail: '<rect x="2" y="3.6" width="12" height="8.8" rx="1.4"/><path d="m2.4 4.4 5.6 4.4 5.6-4.4"/>',
    stack: '<path d="M2.5 6.5 8 4l5.5 2.5L8 9 2.5 6.5z"/><path d="m2.5 9.2 5.5 2.5 5.5-2.5"/>',
  };
  function ownIcon(name, size) {
    size = size || 16;
    return '<svg class="ic" viewBox="0 0 16 16" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + OWN_ICONS[name] + "</svg>";
  }

  /* ------------------------------------------------------------------ call signs */

  // A call sign is the project's two letters and the title's most telling word. A partner flies in
  // its lead's formation: the lead's call sign and the partner's place in it, by when it joined.
  var callCache = {};
  function callSign(t) {
    if (callCache[t.id]) return callCache[t.id];
    var lead = t.lead ? H.thread(t.lead) : null;
    var key = lead ? lead.id : t.id;
    var word = T.keywords[key] || longestWord(lead ? lead.title : t.title);
    var code = T.projectCodes[t.project];
    var cs = code ? code + "·" + word : word;
    if (lead) {
      var wing = H.allLive({ swarm: true, spawn: true })
        .filter(function (x) { return x.lead === t.lead; })
        .sort(function (a, b) { return H.minutes(a.started) - H.minutes(b.started); })
        .map(function (x) { return x.id; });
      cs += " " + (wing.indexOf(t.id) + 2);
    }
    callCache[t.id] = cs;
    return cs;
  }
  function longestWord(title) {
    return title.split(/\s+/).sort(function (a, b) { return b.length - a.length; })[0].replace(/[^a-z0-9]/gi, "").slice(0, 7).toUpperCase();
  }

  /* ------------------------------------------------------------------ flights */

  function unreadMap() {
    return STATE === "away" ? W.away.resultUnread : W.resultUnread;
  }

  /**
   * Returns a thread as a flight: its call sign, its phase (holding, approach, cruising, stand,
   * parked), when it is predicted to need Rogier (range, in minutes since midnight) and what it
   * will bring. Phases follow the agent; Rogier's holds and priorities sit on top.
   */
  function buildFlight(t) {
    var e = W.eta[t.id] || {};
    var f = { id: t.id, t: t, kind: "thread", title: t.title, project: t.project, pose: t.pose, call: callSign(t), basis: e.basis };
    var cleared = ui.answered[t.id];
    if (cleared) {
      f.phase = "cruising";
      f.busySince = cleared.at;
      f.range = null;
      f.basis = "Just cleared. Its first estimate comes with its next plan update.";
    } else if (ui.landed[t.id]) {
      f.phase = "stand";
      f.landedAt = ui.landed[t.id];
    } else if (t.pose === "waiting") {
      f.phase = "holding";
      f.since = t.last;
      f.ask = T.asks[t.id];
      f.askFull = t.ask;
      f.askKind = t.status;
    } else if (t.pose === "working" || t.status === "queued") {
      f.range = e.range ? [BASE + e.range[0], BASE + e.range[1]] : null;
      f.next = e.next;
      f.busySince = e.busySince;
      f.queued = t.status === "queued";
      f.phase = f.range && f.range[1] - ui.now <= 15 ? "approach" : "cruising";
    } else {
      f.phase = unreadMap()[t.id] ? "stand" : "parked";
    }
    f.held = ui.held[t.id] || null;
    f.priority = !!ui.priority[t.id];
    f.urgent = !!T.urgent[t.id];
    return f;
  }

  /** Returns the run step that waits on Rogier as a flight: a mail plane in the holding stack. */
  function buildRunFlight(r) {
    var rs = W.runSessions[r.id];
    var run = W.runs.filter(function (x) { return x.id === rs.run; })[0];
    return {
      id: r.id, t: null, kind: "run", title: r.title, face: run.title, project: r.project, pose: "waiting",
      call: T.projectCodes[r.project] + "·" + T.keywords[r.id], phase: "holding", since: r.last,
      ask: T.asks[r.id], askFull: rs.ask, askKind: "approval", provider: rs.provider, model: rs.model, run: run,
      held: null, priority: !!ui.priority[r.id], urgent: !!T.urgent[r.id],
      basis: "step 3 of 4 of " + run.title,
    };
  }

  function listFlights() {
    var list = api.listThreads().map(buildFlight);
    W.waitingRuns.forEach(function (r) {
      if (!ui.answered[r.id]) list.push(buildRunFlight(r));
    });
    return list;
  }

  function findFlight(id, flights) {
    return (flights || listFlights()).filter(function (f) { return f.id === id; })[0] || null;
  }

  /** Returns the bay a flight belongs in: its phase, or "held" for an inbound flight held back. */
  function bayOf(f) {
    if (f.held && (f.phase === "approach" || f.phase === "cruising")) return "held";
    return f.phase;
  }

  /* ------------------------------------------------------------------ landing slots */

  function slotsOn() {
    return ui.slots.mode !== "off";
  }
  /** Returns the next slot after now, in minutes. */
  function nextSlot() {
    if (ui.slots.mode === "until") return H.minutes(ui.slots.until);
    return (Math.floor(ui.now / ui.slots.every) + 1) * ui.slots.every;
  }
  /** Returns the slot at or after a minute: when an arrival at that minute lands. */
  function slotAt(m) {
    if (ui.slots.mode === "until") return Math.max(m, H.minutes(ui.slots.until));
    return Math.ceil(m / ui.slots.every) * ui.slots.every;
  }
  function lastSlot() {
    return ui.slots.mode === "every" ? Math.floor(ui.now / ui.slots.every) * ui.slots.every : -Infinity;
  }
  function comesThrough(f) {
    return f.priority || (ui.slots.urgent && f.urgent);
  }
  /** Checks whether a holding Request waits quietly for the next slot. */
  function isStacked(f) {
    return slotsOn() && f.phase === "holding" && !comesThrough(f) && H.minutes(f.since) > lastSlot();
  }
  /** Checks whether an inbound flight's landing is moved to a slot. */
  function isSlotted(f) {
    return slotsOn() && !f.held && !comesThrough(f) && (f.phase === "approach" || f.phase === "cruising") && !!f.range;
  }

  /**
   * Returns when a flight needs Rogier, as [from, to] in minutes since midnight, or null when no
   * one can say yet. Holding needs him now; a held flight at its hold; a slotted one at its slot.
   */
  function needsAt(f) {
    if (f.phase === "holding") return isStacked(f) ? [nextSlot(), nextSlot()] : [ui.now, ui.now];
    if (f.phase !== "approach" && f.phase !== "cruising") return null;
    if (f.held && f.held !== "you") return [H.minutes(f.held), H.minutes(f.held)];
    if (f.held) return null;
    if (!f.range) return null;
    if (isSlotted(f)) {
      var s = slotAt(f.range[0]);
      return [s, s];
    }
    return [Math.max(ui.now, f.range[0]), Math.max(ui.now, f.range[1])];
  }

  /** Returns "~4-9m" for a range of minutes since midnight, counted from now. */
  function rangeText(range) {
    var lo = Math.max(0, range[0] - ui.now);
    var hi = Math.max(0, range[1] - ui.now);
    if (hi <= 0) return "any moment";
    return lo === hi ? "~" + lo + "m" : "~" + lo + "-" + hi + "m";
  }
  /** Returns "10:02-06" for a range of minutes since midnight. */
  function rangeClock(range) {
    var a = clock(range[0]);
    var b = clock(range[1]);
    if (a === b) return a;
    return a.slice(0, 2) === b.slice(0, 2) ? a + "-" + b.slice(3) : a + "-" + b;
  }
  function brings(f) {
    if (f.phase === "holding") return f.askKind === "approval" ? "approval" : "a question";
    return T.brings[f.next] || "a result";
  }

  /* ------------------------------------------------------------------ the conflict */

  /** Returns the conflict's flights when three arrivals still fall in its five minutes, or null. */
  function findConflict(flights) {
    if (ui.staggered || slotsOn()) return null;
    var c = T.conflict;
    var list = c.ids.map(function (id) { return findFlight(id, flights); });
    var live = list.every(function (f) {
      return f && !f.held && (f.phase === "approach" || f.phase === "cruising") && f.range && f.range[0] >= H.minutes(c.from) && f.range[1] <= H.minutes(c.to);
    });
    return live ? list : null;
  }

  /* ------------------------------------------------------------------ counts */

  function countBays(flights) {
    var c = { holding: 0, held: 0, approach: 0, cruising: 0, stand: 0, parked: 0 };
    flights.forEach(function (f) { c[bayOf(f)]++; });
    return c;
  }

  /* ------------------------------------------------------------------ strips */

  /** Returns the crew dots of a flight's lead and partners, or "" for a thread alone. */
  function crewDots(f) {
    if (!f.t) return "";
    var leadId = f.t.lead || f.t.id;
    var crew = api.listThreads(function (x) { return x.id === leadId || x.lead === leadId; });
    if (crew.length < 2) return "";
    crew.sort(function (a, b) { return a.lead ? (b.lead ? H.minutes(a.started) - H.minutes(b.started) : 1) : -1; });
    return '<span class="ct-crew" aria-label="' + crew.length + ' in this formation">' + crew.map(function (x) {
      var pose = ui.answered[x.id] ? "working" : ui.landed[x.id] ? "idle" : x.pose;
      return '<i class="ct-dot ct-dot--' + pose + (x.id === f.id ? " is-self" : "") + '" style="' + hueOf(x.title) + '"></i>';
    }).join("") + "</span>";
  }

  /** Returns what a thread has to show for itself: its result line, else its last turn's headline. */
  function resultLine(t) {
    if (t.result) return t.result;
    var ended = (W.headlines[t.id] || []).filter(function (h) { return !h.running; });
    return ended.length ? ended[ended.length - 1].text : "";
  }

  function glyph(f) {
    if (f.kind === "run") return '<span class="ct-glyph">' + ownIcon("mail", 12) + "</span>";
    return '<span class="ct-glyph">' + api.drawBrand(f.t, 12) + "</span>";
  }

  function stamp(text, quiet) {
    return '<span class="ct-stamp' + (quiet ? " ct-stamp--quiet" : "") + '">' + text + "</span>";
  }

  /** Returns the right end of a strip's first line: how long it held, its ETA, or an age. */
  function timeToken(f, bay) {
    if (bay === "holding") return isStacked(f) ? stamp(clock(nextSlot())) : '<span class="ct-time ct-time--you">' + ago(f.since) + "</span>";
    if (bay === "held") return stamp(f.held === "you" ? "held" : f.held);
    if (bay === "approach" || bay === "cruising") {
      if (!f.range) return '<span class="ct-time ct-time--quiet">' + (f.queued ? "queued" : "no ETA") + "</span>";
      return '<span class="ct-time">' + rangeText(f.range) + "</span>";
    }
    if (bay === "stand") return '<span class="ct-time">' + (f.landedAt ? ago(f.landedAt) : ago(f.t.last)) + "</span>";
    return '<span class="ct-time">' + ago(f.t.last) + "</span>";
  }

  /** Returns the strip's detail: what it asks, how long it flies and what it brings, or its result. */
  function detail(f, bay, wide) {
    if (bay === "held") return "done " + rangeText(f.range) + " · " + brings(f);
    if (bay === "approach" || bay === "cruising") {
      if (f.queued) return "waiting for take-off · " + W.workspaces[f.t.workspace].machine + " at cap";
      var air = f.busySince ? (ui.now - H.minutes(f.busySince) < 1 ? "airborne now" : "airborne " + ago(f.busySince)) : "airborne";
      if (!f.range) return air + " · estimating";
      if (isSlotted(f)) return air + " · lands " + clock(slotAt(f.range[0]));
      return air + " · " + brings(f);
    }
    if (bay === "stand") return f.landedAt ? "Landed " + f.landedAt + ". " + resultLine(f.t) : resultLine(f.t) || "A result you have not read";
    var place = api.describePlace(f.t);
    return place.clip + place.keep;
  }

  function answerButtons(f, size, withMore) {
    var a = f.ask;
    if (!a) return "";
    var list = a.answers.slice();
    // The card has room for every answer: the extra ones sit before the decline.
    if (withMore && a.more) list.splice(list.length - 1, 0, [a.more[0][0], a.more[0][0], ""]);
    return list.map(function (x) {
      var kind = x[2] === "accent" ? " btn--accent" : x[2] === "quiet" ? " btn--quiet" : "";
      var label = size === "card" ? x[1] : x[0];
      return '<button class="btn ' + (size === "xs" ? "ct-xs" : "btn--sm") + kind + '" data-answer="' + f.id + '" data-label="' + esc(x[1]) + '">' + esc(label) + "</button>";
    }).join("");
  }

  /**
   * Returns a strip's markup. Variants: "side" (272px sidebar, 52px; 60px holding), "board" (the
   * Threads mode's rack, three lines). opts.pending names the bay a change will move it to.
   */
  function drawStrip(f, variant, opts) {
    opts = opts || {};
    var bay = opts.bay || bayOf(f);
    var selected = ui.overview ? f.id === ui.selected : api.openId() === f.id;
    var cls = "ct-strip ct-strip--" + variant + " ct-in-" + bay + (f.kind === "run" ? " ct-strip--run" : "") + (selected ? " is-on" : "") + (opts.pending ? " is-pending" : "") + (bay === "parked" ? " is-quiet" : "") + (isStacked(f) ? " is-stacked" : "");
    var draggable = variant === "board" && bay !== "stand" && bay !== "parked";
    var call = '<span class="ct-call">' + esc(f.call) + "</span>";
    var chip = "";
    if (f.priority) chip = '<span class="ct-chip">Priority</span>';
    else if (slotsOn() && f.urgent && bay === "holding" && ui.slots.urgent) chip = '<span class="ct-chip">Urgent</span>';
    var pend = opts.pending ? '<span class="ct-pending">' + icon("arrow", 11) + BAY_LABEL[opts.pending] + "</span>" : "";
    var html =
      '<div class="' + cls + '" data-id="' + f.id + '" data-flip="' + f.id + '"' + (draggable ? ' data-drag="' + bay + '"' : "") + ' style="--tab:' + tintOf(f.project) + '" tabindex="0" role="button" aria-label="' + esc(f.call + ", " + f.title + ", " + BAY_LABEL[bay]) + '">' +
      '<span class="ct-tab"></span><span class="ct-body">';

    if (variant === "side") {
      html += '<span class="ct-l1">' + call + '<span class="ct-title">' + esc(f.title) + "</span>" + chip + timeToken(f, bay) + "</span>";
      if (bay === "holding") {
        html += '<span class="ct-l2 ct-l2--ask"><span class="ct-ask">' + esc(f.ask ? f.ask.lead : f.askFull) + '</span><span class="ct-acts">' + answerButtons(f, "xs") + "</span></span>";
      } else {
        html += '<span class="ct-l2">' + (bay === "stand" ? '<span class="ct-unread"></span>' : glyph(f)) + '<span class="ct-detail">' + esc(detail(f, bay)) + "</span>" + pend + crewDots(f) + "</span>";
      }
    } else {
      html += '<span class="ct-l1">' + call + (f.kind === "run" ? '<span class="ct-run">run</span>' : "") + chip + '<span class="ct-grow"></span>' + timeToken(f, bay) + "</span>";
      html += '<span class="ct-l2 ct-title">' + esc(f.title) + "</span>";
      if (bay === "holding") {
        html += '<span class="ct-l3 ct-ask">' + (f.ask && f.ask.code ? "Run <code>" + esc(f.ask.code) + "</code>?" : esc(f.askFull)) + "</span>";
        html += '<span class="ct-l4 ct-acts">' + answerButtons(f, "card") + "</span>";
      } else {
        html += '<span class="ct-l3">' + (bay === "stand" ? '<span class="ct-unread"></span>' : glyph(f)) + '<span class="ct-detail">' + esc(detail(f, bay, true)) + "</span>" + pend + crewDots(f) + "</span>";
      }
    }
    return html + "</span></div>";
  }

  /* ------------------------------------------------------------------ bays: what shows where */

  // The order inside each bay.
  function sortBay(bay, list) {
    if (bay === "holding") {
      return list.sort(function (a, b) {
        var pa = comesThrough(a) ? 0 : 1;
        var pb = comesThrough(b) ? 0 : 1;
        return pa - pb || H.minutes(a.since) - H.minutes(b.since);
      });
    }
    if (bay === "held") return list.sort(function (a, b) { return (a.held === "you" ? 9999 : H.minutes(a.held)) - (b.held === "you" ? 9999 : H.minutes(b.held)); });
    if (bay === "approach" || bay === "cruising") {
      return list.sort(function (a, b) {
        return (a.range ? a.range[0] : 99999) - (b.range ? b.range[0] : 99999) || (a.queued ? 1 : 0) - (b.queued ? 1 : 0);
      });
    }
    if (bay === "stand") return list.sort(function (a, b) { return H.minutes(b.landedAt || b.t.last) - H.minutes(a.landedAt || a.t.last); });
    return list.sort(function (a, b) { return H.minutes(b.t.last) - H.minutes(a.t.last); });
  }

  /**
   * Splits flights into bays as one list shows them. While the pointer is in that list, a flight
   * whose bay changed by itself stays where it was drawn, marked with where it will go (#626);
   * Rogier's own actions show at once.
   */
  function groupForList(flights, which) {
    var shown = ui.shown[which];
    var waitForPointer = ui.pointerIn[which] && !ui.act;
    var groups = { holding: [], held: [], approach: [], cruising: [], stand: [], parked: [] };
    var moving = { holding: 0, held: 0, approach: 0, cruising: 0, stand: 0, parked: 0 };
    flights.forEach(function (f) {
      var bay = bayOf(f);
      var was = shown[f.id];
      if (waitForPointer && was && was !== bay) {
        groups[was].push({ f: f, pending: bay });
        moving[was === "held" ? "holding" : was]++;
      } else {
        groups[bay].push({ f: f });
      }
    });
    Object.keys(groups).forEach(function (bay) {
      var sorted = sortBay(bay, groups[bay].map(function (x) { return x.f; }));
      groups[bay] = sorted.map(function (f) {
        return groups[bay].filter(function (x) { return x.f === f; })[0];
      });
    });
    return { groups: groups, moving: moving };
  }

  function rememberShown(which, groups) {
    var m = {};
    Object.keys(groups).forEach(function (bay) {
      groups[bay].forEach(function (x) { m[x.f.id] = bay; });
    });
    ui.shown[which] = m;
  }

  /* ------------------------------------------------------------------ the sidebar */

  var els = {};

  // How many strips a bay shows before "n more", per state. Holding always shows four.
  function bayLimit(bay) {
    if (STATE !== "swarm") return 99;
    return { holding: 4, held: 4, approach: 4, cruising: 4, stand: 3, parked: 3 }[bay];
  }

  function drawSlotsControl() {
    var on = slotsOn();
    var flights = listFlights();
    var waiting = flights.filter(isStacked).length;
    var text;
    if (!on) text = "<b>Landing slots</b><span>off</span>";
    else if (ui.slots.mode === "every") text = "<b>Slot " + clock(nextSlot()) + "</b><span>every " + ui.slots.every + "m</span>";
    else text = "<b>Focus until " + ui.slots.until + "</b>";
    els.slots.className = "ct-slots" + (on ? " is-on" : "") + (ui.popover === "side" ? " is-open" : "");
    els.slots.innerHTML =
      '<span class="ct-slots-ic">' + icon("clock", 14) + '</span><span class="ct-slots-text">' + text + "</span>" +
      (on && waiting ? '<span class="ct-slots-wait">' + waiting + " wait</span>" : "") +
      '<span class="ct-slots-chev">' + icon("chev-d", 12) + "</span>";
  }

  function drawHandover() {
    if (!ui.handover) return "";
    var left = H.minutes(W.away.left);
    var back = H.minutes(W.away.back);
    var took = 0;
    var landed = 0;
    var flights = listFlights();
    // Every flight the strips show, the run step that waits on Rogier included, so the count
    // agrees with the Aerodrome's away card.
    flights.forEach(function (f) {
      (W.turns[f.id] || []).forEach(function (s) {
        if (H.minutes(s.from) > left && H.minutes(s.from) <= back) took++;
        if (s.to && s.end === "idle" && H.minutes(s.to) > left && H.minutes(s.to) <= back) landed++;
      });
    });
    var c = countBays(flights);
    var oldest = sortBay("holding", flights.filter(function (f) { return f.phase === "holding"; }))[0];
    var holdLine = oldest ? '<b class="you-ink">' + c.holding + "</b> hold for you, the oldest for " + ago(oldest.since) + "; " : "Nothing holds for you; ";
    return (
      '<section class="ct-handover" aria-label="Handover">' +
      '<div class="ct-handover-h"><b>Handover</b><span>away ' + W.away.left + "-" + W.away.back + '</span><button class="icon-btn icon-btn--sm" data-act="handover-close" title="Dismiss">' + icon("close", 12) + "</button></div>" +
      '<p class="ct-handover-p"><b>' + took + "</b> flights took off and <b>" + landed + "</b> landed while you were out. " + holdLine + "<b>" + c.stand + "</b> results wait on stand.</p>" +
      (oldest ? '<button class="btn btn--sm ct-handover-go" data-select="' + oldest.id + '">Start with ' + esc(oldest.call) + "</button>" : "") +
      "</section>"
    );
  }

  function bayHeader(bay, count, moving, note) {
    var b = BAYS.filter(function (x) { return x.id === bay; })[0];
    return (
      '<h3 class="side-h ct-bay-h ct-bay-h--' + bay + '"><span class="ct-bay-name">' + b.label + ' <b class="count' + (bay === "holding" && count ? " count--you" : "") + '">' + count + "</b></span>" +
      (moving ? '<span class="ct-moving">' + moving + " moving</span>" : "") +
      (note ? '<span class="ct-bay-note">' + note + "</span>" : "") +
      "</h3>"
    );
  }

  function drawDeck(items, variant) {
    if (!items.length) return "";
    if (ui.deckOpen) {
      return (
        '<div class="ct-deck is-open"><div class="ct-deck-h"><span>' + items.length + " wait for " + clock(nextSlot()) + '</span><button class="ct-link" data-act="deck">Stack them</button></div>' +
        items.map(function (x) { return drawStrip(x.f, variant, { bay: "holding", pending: x.pending }); }).join("") +
        "</div>"
      );
    }
    var top = items[0].f;
    return (
      '<button class="ct-deck" data-act="deck" style="--tab:' + tintOf(top.project) + '" aria-label="' + items.length + " requests wait for the " + clock(nextSlot()) + ' slot. Show them.">' +
      '<span class="ct-deck-sheet ct-deck-sheet--3"></span><span class="ct-deck-sheet ct-deck-sheet--2"></span>' +
      '<span class="ct-deck-face"><span class="ct-tab"></span><span class="ct-deck-text"><span class="ct-deck-calls">' +
      items.map(function (x) { return '<span class="ct-call">' + esc(x.f.call) + "</span>"; }).join("") +
      '</span><span class="ct-deck-l2"><span class="ct-deck-sub">' + items.length + " requests, quiet</span>" + stamp("lands " + clock(nextSlot())) + "</span></span></span>" +
      "</button>"
    );
  }

  /** Draws the sidebar: the strips in their bays, or what a pointer in the list holds back. */
  function drawSidebar(flip) {
    var before = flip ? captureRects(els.list) : null;
    var flights = listFlights();
    var g = groupForList(flights, "side");
    var groups = g.groups;
    var c = countBays(flights);
    var conflict = findConflict(flights);
    var html = drawHandover();

    BAYS.forEach(function (b) {
      var items = groups[b.id];
      var count = b.id === "holding" ? c.holding : c[b.id];
      var note = "";
      if (b.id === "holding" && slotsOn() && flights.some(isStacked)) note = flights.filter(isStacked).length + " at " + clock(nextSlot());
      if (b.id === "approach" && items.length && items[0].f.range) note = "next " + rangeText(items[0].f.range);
      if (b.id === "cruising" && conflict) note = '<button class="ct-link ct-link--you" data-act="conflict-open">3 at ' + T.conflict.from + "-" + T.conflict.to.slice(3) + "</button>";
      html += '<section class="ct-bay ct-bay--' + b.id + '">' + bayHeader(b.id, count, g.moving[b.id], note);

      if (b.id === "holding") {
        var through = items.filter(function (x) { return !isStacked(x.f); });
        var stacked = items.filter(function (x) { return isStacked(x.f); });
        var limit = ui.moreOpen.holding ? 99 : bayLimit("holding");
        html += through.slice(0, limit).map(function (x) { return drawStrip(x.f, "side", { pending: x.pending }); }).join("");
        if (through.length > limit) html += '<button class="ct-more" data-more="holding">' + (through.length - limit) + " more holding</button>";
        html += drawDeck(stacked, "side");
        if (!items.length) html += '<p class="ct-empty">Nothing holding. You are clear.</p>';
        if (groups.held.length) {
          html += '<h4 class="ct-sub">Held back <span>' + groups.held.length + "</span></h4>";
          html += groups.held.map(function (x) { return drawStrip(x.f, "side", { bay: "held", pending: x.pending }); }).join("");
        }
      } else if (b.id === "parked") {
        var lim = ui.moreOpen.parked ? 99 : bayLimit("parked");
        html += items.slice(0, lim).map(function (x) { return drawStrip(x.f, "side", { pending: x.pending }); }).join("");
        var hidden = items.length - Math.min(lim, items.length);
        var swarmMore = STATE === "swarm" ? W.swarm.more.webshop + W.swarm.more["payments-api"] + W.swarm.more.ops : 0;
        if (hidden || swarmMore) html += '<button class="ct-more" data-more="parked">' + (hidden + swarmMore) + " more parked</button>";
      } else {
        var l = ui.moreOpen[b.id] ? 99 : bayLimit(b.id);
        html += items.slice(0, l).map(function (x) { return drawStrip(x.f, "side", { pending: x.pending }); }).join("");
        if (items.length > l) html += '<button class="ct-more" data-more="' + b.id + '">' + (items.length - l) + " more</button>";
        if (!items.length) html += '<p class="ct-empty">' + { approach: "Nothing due in the next 15 minutes.", cruising: "Nothing airborne.", stand: "Every result is read." }[b.id] + "</p>";
      }
      html += "</section>";
    });

    html += drawHangar("side");
    els.list.innerHTML = html;
    rememberShown("side", groups);
    if (before) playFlip(els.list, before);
    drawSlotsControl();
    drawFoot(c);
    markFades(els.list);
  }

  function drawHangar(variant) {
    var open = ui.hangarOpen;
    var html =
      '<section class="ct-hangar' + (open ? " is-open" : "") + '">' +
      '<button class="ct-hangar-h" data-act="hangar" aria-expanded="' + open + '"><span class="ct-hangar-ic">' + icon("check", 13) + '</span><span>Hangar</span><b class="count">' + W.doneCount + '</b><span class="ct-grow"></span><span class="ct-hangar-chev">' + icon("chev-r", 12) + "</span></button>";
    if (open) {
      html += W.done.map(function (d) {
        return '<div class="ct-done" style="--tab:' + tintOf(d.project) + '"><span class="ct-tab"></span><span class="ct-done-title">' + esc(d.title) + '</span><span class="ct-time">' + esc(d.doneAt.replace("yesterday ", "yest. ")) + "</span></div>";
      }).join("") + '<p class="ct-empty">' + (W.doneCount - W.done.length) + " more in the hangar</p>";
    }
    return html + "</section>";
  }

  function drawFoot(c) {
    els.sum.innerHTML =
      '<b class="you-ink">' + c.holding + "</b> holding · <b>" + (c.approach + c.cruising + c.held) + "</b> airborne · <b>" + (c.stand + c.parked) + "</b> on the ground";
  }

  /* ------------------------------------------------------------------ FLIP: strips glide to their new bay */

  function captureRects(container) {
    var m = {};
    container.querySelectorAll("[data-flip]").forEach(function (el) {
      m[el.dataset.flip] = el.getBoundingClientRect();
    });
    return m;
  }
  function playFlip(container, before) {
    if (motion.matches) return;
    container.querySelectorAll("[data-flip]").forEach(function (el) {
      var b = before[el.dataset.flip];
      if (!b) {
        el.classList.add("is-arriving");
        return;
      }
      var a = el.getBoundingClientRect();
      var dx = b.left - a.left;
      var dy = b.top - a.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.style.transition = "none";
      el.style.transform = "translate(" + dx + "px," + dy + "px)";
      el.style.zIndex = "2";
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          el.style.transition = "transform 420ms var(--ease-out)";
          el.style.transform = "";
          setTimeout(function () {
            el.style.zIndex = "";
            el.style.transition = "";
          }, 440);
        });
      });
    });
  }

  /* ------------------------------------------------------------------ the overview */

  var ov = {}; // the overview's elements while it is open

  function drawOverview(mainEl) {
    mainEl.innerHTML =
      '<div class="ct-ov" data-mode="' + ui.mode + '">' +
      '<div class="ct-modes">' +
      MODES.map(function (m) {
        return '<section class="ct-mode ct-mode--' + m.id + (m.id === ui.mode ? " is-on" : "") + '" data-view="' + m.id + '" aria-label="' + m.label + '"></section>';
      }).join("") +
      "</div>" +
      '<header class="top ct-top" data-top></header>' +
      '<aside class="ct-card glass" data-card hidden></aside>' +
      "</div>";
    ov.root = mainEl.querySelector(".ct-ov");
    ov.top = mainEl.querySelector("[data-top]");
    ov.card = mainEl.querySelector("[data-card]");
    ov.views = {};
    MODES.forEach(function (m) { ov.views[m.id] = mainEl.querySelector('[data-view="' + m.id + '"]'); });
    ov.dirty = { threads: true, radar: true };
    drawTop();
    drawMode(ui.mode);
    drawCard();
  }

  function drawTop() {
    if (!ov.top) return;
    var flights = listFlights();
    var c = countBays(flights);
    var on = slotsOn();
    var waiting = flights.filter(isStacked).length;
    var slotsText = !on ? "Slots: off" : ui.slots.mode === "every" ? "Slots: every " + ui.slots.every + " min · next " + clock(nextSlot()) + " · " + waiting + " wait" : "Holding until " + ui.slots.until + " · " + waiting + " wait";
    ov.top.innerHTML =
      '<nav class="pill ct-switch" aria-label="Overview mode">' +
      MODES.map(function (m) {
        var ic = m.id === "office" ? icon("office", 15) : m.id === "threads" ? ownIcon("strips", 15) : ownIcon("radar", 15);
        return '<button class="ct-switch-btn" data-mode="' + m.id + '" aria-pressed="' + (m.id === ui.mode) + '" title="' + m.hint + " ⌥⌘" + m.key + '">' + ic + "<span>" + m.label + "</span></button>";
      }).join("") +
      "</nav>" +
      '<span class="pill ct-slots-pill"><button class="pill-btn' + (on ? " is-on" : "") + (ui.popover === "top" ? " is-open" : "") + '" data-slots-open="top">' + icon("clock", 14) + "<span>" + slotsText + "</span>" + icon("chev-d", 12) + "</button></span>" +
      '<span class="spacer"></span>' +
      '<span class="pill ct-sum">' +
      '<span class="ct-sum-you"><b>' + c.holding + "</b> holding</span>" +
      (c.held ? "<span><b>" + c.held + "</b> held back</span>" : "") +
      "<span><b>" + c.approach + "</b> approach</span><span><b>" + c.cruising + "</b> cruising</span><span><b>" + c.stand + "</b> on stand</span>" +
      '<span class="ct-sum-clock">' + clock(ui.now) + "</span>" +
      "</span>" +
      '<span class="pill"><button class="icon-btn" data-act="close" title="Close the overview  esc">' + icon("close", 15) + "</button></span>";
  }

  function setMode(id) {
    if (id === ui.mode) return;
    var old = ui.mode;
    ui.mode = id;
    if (!ov.root) return;
    ov.root.dataset.mode = id;
    drawTop();
    if (ov.dirty[id] || id === "office") drawMode(id);
    ov.views[old].classList.remove("is-on");
    ov.views[id].classList.add("is-on");
    if (old === "office" && office.handle) office.handle.pause();
    drawCard();
  }

  function drawMode(id) {
    if (!ov.views) return;
    if (id === "radar") drawRadar(ov.views.radar);
    if (id === "threads") drawBoard(ov.views.threads);
    if (id === "office") showOffice(ov.views.office);
    ov.dirty[id] = false;
  }

  /** Redraws everything that shows the flights, after the model changed. */
  function refresh(opts) {
    opts = opts || {};
    ui.act = !!opts.act;
    drawSidebar(true);
    if (ui.overview && ov.root) {
      drawTop();
      ov.dirty.threads = ov.dirty.radar = true;
      if (ui.mode !== "office") drawMode(ui.mode);
      drawCard();
    }
    ui.act = false;
  }

  /* ------------------------------------------------------------------ Radar */

  var SWEEP_MS = 9000; // one turn of the sweep; a redraw picks the turn up where it was
  // The scope's geometry, in px: its size, the face inside the bezel, and the radii of the rings.
  // Between now and an hour the radius grows with the square root of the minutes, so the next
  // quarter of an hour gets the most room.
  var R = { size: 560, c: 280, now: 54, hour: 222, later: 244, face: 262 };
  R.k = (R.hour - R.now) / Math.sqrt(60);

  /** Returns the scope radius for minutes until a thread needs Rogier; null is "later". */
  function radiusAt(m) {
    if (m == null) return R.later;
    if (m <= 0) return R.now;
    if (m > 60) return Math.min(R.later, R.hour + 8 + (m - 60) * 0.2);
    return R.now + R.k * Math.sqrt(m);
  }
  function polar(r, deg) {
    var a = ((deg - 90) * Math.PI) / 180;
    return [R.c + r * Math.cos(a), R.c + r * Math.sin(a)];
  }
  function arcPath(r, from, to, sweepBack) {
    var a = polar(r, sweepBack ? to : from);
    var b = polar(r, sweepBack ? from : to);
    var large = Math.abs(to - from) > 180 ? 1 : 0;
    return "M" + a[0].toFixed(1) + " " + a[1].toFixed(1) + " A" + r + " " + r + " 0 " + large + " " + (sweepBack ? 0 : 1) + " " + b[0].toFixed(1) + " " + b[1].toFixed(1);
  }
  function wedgePath(r0, r1, from, to) {
    var a = polar(r1, from);
    var b = polar(r1, to);
    var c = polar(r0, to);
    var d = polar(r0, from);
    var large = to - from > 180 ? 1 : 0;
    return "M" + a.join(" ") + " A" + r1 + " " + r1 + " 0 " + large + " 1 " + b.join(" ") + " L" + c.join(" ") + " A" + r0 + " " + r0 + " 0 " + large + " 0 " + d.join(" ") + "Z";
  }
  function sectorOf(project) {
    return T.sectors.filter(function (s) { return s.project === (project || null); })[0];
  }

  // Bearings are stable: each flight takes a slot in its project's sector by a hash of its id, so
  // a blip keeps its bearing as others come and go.
  function assignBearings(list) {
    var bearings = {};
    T.sectors.forEach(function (s) {
      var inSec = list.filter(function (f) { return (f.project || null) === s.project; }).sort(function (a, b) { return a.id < b.id ? -1 : 1; });
      var slots = Math.max(7, inSec.length + 2);
      var span = s.to - s.from;
      var pad = Math.min(9, span * 0.14);
      var used = {};
      inSec.forEach(function (f) {
        var i = Crew.hash(f.id) % slots;
        while (used[i]) i = (i + 1) % slots;
        used[i] = true;
        bearings[f.id] = s.from + pad + ((span - 2 * pad) * (i + 0.5)) / slots;
      });
    });
    return bearings;
  }

  function drawRadar(view) {
    var flights = listFlights();
    var conflict = findConflict(flights);
    var onScope = flights.filter(function (f) { return f.phase === "holding" || f.phase === "approach" || f.phase === "cruising"; });
    var ground = flights.filter(function (f) { return f.phase === "stand" || f.phase === "parked"; });
    var bearings = assignBearings(onScope);
    var conflictIds = conflict ? T.conflict.ids : [];

    // --- the face: bezel, sectors, rings
    var face = '<svg class="ct-face" viewBox="0 0 ' + R.size + " " + R.size + '" aria-hidden="true"><defs>';
    T.sectors.forEach(function (s, i) {
      var mid = (s.from + s.to) / 2;
      var bottom = mid > 90 && mid < 270;
      face += '<path id="ct-arc-' + i + '" d="' + arcPath(bottom ? R.face + 13.5 : R.face + 6.5, s.from + 2, s.to - 2, bottom) + '"/>';
    });
    face += "</defs>";
    face += '<circle cx="' + R.c + '" cy="' + R.c + '" r="' + (R.c - 1) + '" class="ct-bezel"/>';
    face += '<circle cx="' + R.c + '" cy="' + R.c + '" r="' + R.face + '" class="ct-face-bg"/>';
    T.sectors.forEach(function (s) {
      var tint = s.project ? tintOf(s.project) : "var(--scope-ink)";
      face += '<path d="' + wedgePath(R.now, R.face, s.from, s.to) + '" style="fill:' + tint + '" class="ct-sector' + (s.project ? "" : " ct-sector--none") + '"/>';
      var a = polar(R.now, s.from);
      var b = polar(R.face, s.from);
      face += '<line x1="' + a[0] + '" y1="' + a[1] + '" x2="' + b[0] + '" y2="' + b[1] + '" class="ct-sector-edge"/>';
    });
    // the later band
    face += '<path d="' + wedgePath(R.hour, R.face, 0, 359.99) + '" class="ct-later"/>';
    [5, 15, 60].forEach(function (m) {
      face += '<circle cx="' + R.c + '" cy="' + R.c + '" r="' + radiusAt(m).toFixed(1) + '" class="ct-ring' + (m === 60 ? " ct-ring--hour" : "") + '"/>';
    });
    face += '<circle cx="' + R.c + '" cy="' + R.c + '" r="' + R.now + '" class="ct-ring ct-ring--now"/>';
    // bezel ticks and rims
    for (var d = 0; d < 360; d += 6) {
      var long = d % 30 === 0;
      var p1 = polar(R.face + 1.5, d);
      var p2 = polar(R.face + (long ? 6 : 3.5), d);
      if (!long) continue;
      face += '<line x1="' + p1[0].toFixed(1) + '" y1="' + p1[1].toFixed(1) + '" x2="' + p2[0].toFixed(1) + '" y2="' + p2[1].toFixed(1) + '" class="ct-tick"/>';
    }
    face += '<circle cx="' + R.c + '" cy="' + R.c + '" r="' + (R.face + 0.5) + '" class="ct-rim"/><circle cx="' + R.c + '" cy="' + R.c + '" r="' + (R.c - 1.5) + '" class="ct-rim ct-rim--outer"/>';
    T.sectors.forEach(function (s, i) {
      face += '<text class="ct-sector-name"><textPath href="#ct-arc-' + i + '" startOffset="50%" text-anchor="middle">' + esc(projName(s.project)).toUpperCase() + "</textPath></text>";
    });

    // slot rings, when slots are on
    if (slotsOn()) {
      var s0 = nextSlot();
      var slotTimes = [];
      if (ui.slots.mode === "every") for (var st = s0; st <= ui.now + 60; st += ui.slots.every) slotTimes.push(st);
      else slotTimes.push(s0);
      slotTimes.forEach(function (st) {
        var r = radiusAt(st - ui.now);
        face += '<circle cx="' + R.c + '" cy="' + R.c + '" r="' + r.toFixed(1) + '" class="ct-slot-ring"/>';
        var lp = polar(r, 248);
        face += '<g class="ct-slot-label" transform="translate(' + lp[0].toFixed(1) + " " + lp[1].toFixed(1) + ')"><rect x="-32" y="-9" width="64" height="18" rx="9"/><text y="4" text-anchor="middle">slot ' + clock(st) + "</text></g>";
      });
    }

    // the conflict band
    if (conflict) {
      var r0 = radiusAt(H.minutes(T.conflict.from) - ui.now);
      var r1 = radiusAt(H.minutes(T.conflict.to) - ui.now);
      face += '<path d="' + wedgePath(r0 - 3, r1 + 3, 0, 359.99) + '" class="ct-conflict-band' + (ui.conflictOpen ? " is-open" : "") + '"/>';
      face += '<circle cx="' + R.c + '" cy="' + R.c + '" r="' + (r0 - 3).toFixed(1) + '" class="ct-conflict-edge"/><circle cx="' + R.c + '" cy="' + R.c + '" r="' + (r1 + 3).toFixed(1) + '" class="ct-conflict-edge"/>';
    }

    // ring labels, in the quiet sector between ops and webshop
    face += '<defs><path id="ct-arc-later" d="' + arcPath(R.later - 3.5, 276, 304) + '"/></defs><text class="ct-later-name"><textPath href="#ct-arc-later" startOffset="50%" text-anchor="middle">LATER</textPath></text>';
    [["now", 0], ["5m", 5], ["15m", 15], ["1h", 60]].forEach(function (x) {
      var r = x[1] === 0 ? R.now : radiusAt(x[1]);
      var p = polar(r, 290);
      var w = x[0].length * 6.4 + 12;
      face += '<g class="ct-ring-label" transform="translate(' + p[0].toFixed(1) + " " + p[1].toFixed(1) + ')"><rect x="' + (-w / 2) + '" y="-8" width="' + w + '" height="16" rx="8"/><text y="3.6" text-anchor="middle">' + x[0] + "</text></g>";
    });
    face += "</svg>";

    // --- trails and ranges
    var marks = '<svg class="ct-marks" viewBox="0 0 ' + R.size + " " + R.size + '" aria-hidden="true">';
    var blips = [];
    onScope.forEach(function (f) {
      var need = needsAt(f);
      var mid = need ? (need[0] + need[1]) / 2 - ui.now : null;
      var r = radiusAt(mid);
      var b = bearings[f.id];
      var p = polar(r, b);
      var hue = hueOf(f.face || f.title);
      if (f.phase !== "holding" && f.range && need) {
        // the predicted range, along the bearing: a prediction looks like a prediction
        if (!f.held && !isSlotted(f)) {
          var ra = polar(radiusAt(need[0] - ui.now), b);
          var rb = polar(radiusAt(need[1] - ui.now), b);
          marks += '<line x1="' + ra[0].toFixed(1) + '" y1="' + ra[1].toFixed(1) + '" x2="' + rb[0].toFixed(1) + '" y2="' + rb[1].toFixed(1) + '" class="ct-range" style="' + hue + '"/>';
        }
        // the trail: where it was a few sweeps ago, further out, spiralling in
        var pts = [p];
        for (var k = 1; k <= 4; k++) pts.push(polar(radiusAt(mid + k * 2.2), b - k * 3.2));
        marks += '<polyline points="' + pts.map(function (q) { return q[0].toFixed(1) + "," + q[1].toFixed(1); }).join(" ") + '" class="ct-trail" style="' + hue + '"/>';
        for (var j = 1; j < pts.length; j++) marks += '<circle cx="' + pts[j][0].toFixed(1) + '" cy="' + pts[j][1].toFixed(1) + '" r="' + (2.6 - j * 0.4).toFixed(1) + '" class="ct-trail-dot" style="' + hue + ";opacity:" + (0.62 - j * 0.13).toFixed(2) + '"/>';
        // a held or slotted flight: a ghost where it would have landed
        if ((f.held && f.held !== "you") || isSlotted(f)) {
          var g = polar(radiusAt((f.range[0] + f.range[1]) / 2 - ui.now), b);
          marks += '<line x1="' + g[0].toFixed(1) + '" y1="' + g[1].toFixed(1) + '" x2="' + p[0].toFixed(1) + '" y2="' + p[1].toFixed(1) + '" class="ct-held-line"/><circle cx="' + g[0].toFixed(1) + '" cy="' + g[1].toFixed(1) + '" r="4" class="ct-ghost" style="' + hue + '"/>';
        }
      }
      blips.push({ f: f, x: p[0], y: p[1], need: need, mid: mid });
    });
    marks += "</svg>";

    // --- labels, placed so they never overlap
    var obstacles = [{ x: R.c - 26, y: R.c - 26, w: 52, h: 52 }];
    blips.forEach(function (bl) { obstacles.push({ x: bl.x - 6, y: bl.y - 6, w: 12, h: 12 }); });
    var ranked = blips.slice().sort(function (a, b) {
      var rank = function (bl) {
        return (bl.f.id === ui.selected ? 0 : 10) + (bl.f.phase === "holding" ? 1 : conflictIds.indexOf(bl.f.id) >= 0 ? 2 : bl.f.phase === "approach" ? 3 : 4);
      };
      return rank(a) - rank(b) || (a.mid || 999) - (b.mid || 999);
    });
    ranked.forEach(function (bl) {
      var f = bl.f;
      var sub = labelSub(f, bl.need);
      var w = Math.max(f.call.length * 6.7, sub.length * 5.6) + 10;
      var h = 27;
      // Right, left, above, below, then the four diagonals, then a step further out.
      var cands = [[9, -13], [-9 - w, -13], [-w / 2, -h - 8], [-w / 2, 8], [8, -h - 2], [-8 - w, -h - 2], [8, 3], [-8 - w, 3], [16, -13], [-16 - w, -13], [-w / 2, -h - 16], [-w / 2, 16]];
      for (var i = 0; i < cands.length; i++) {
        var rect = { x: bl.x + cands[i][0], y: bl.y + cands[i][1], w: w, h: h };
        if (!insideFace(rect)) continue;
        if (obstacles.some(function (o) { return overlaps(rect, o, bl); })) continue;
        obstacles.push(rect);
        bl.label = { dx: cands[i][0], dy: cands[i][1], w: w, sub: sub, side: cands[i][0] < -w / 2 - 1 ? "is-left" : cands[i][0] === -w / 2 ? "is-center" : "" };
        break;
      }
    });

    var html =
      '<div class="ct-radar">' +
      '<div class="ct-scope-wrap"><div class="ct-scope">' + face +
      (motion.matches ? "" : '<div class="ct-sweep" style="animation-delay:-' + (Date.now() % SWEEP_MS) + 'ms"></div>') +
      marks +
      '<div class="ct-blips">' +
      blips.map(function (bl) { return drawBlip(bl, conflictIds); }).join("") +
      "</div>" +
      '<div class="ct-me" title="You, the tower">' + Crew.you(38) + "</div>" +
      "</div>" +
      drawGround(ground) +
      drawLegend() +
      "</div>" +
      drawArrivals(flights, conflict) +
      "</div>";
    view.innerHTML = html;
  }

  function labelSub(f, need) {
    if (f.phase === "holding") return isStacked(f) ? "lands " + clock(nextSlot()) : "holding " + ago(f.since);
    if (f.held) return f.held === "you" ? "held" : "held to " + f.held;
    if (isSlotted(f)) return "lands " + clock(need[0]);
    if (!f.range) return f.queued ? "queued" : "estimating";
    return rangeText(f.range);
  }

  function insideFace(rect) {
    var corners = [[rect.x, rect.y], [rect.x + rect.w, rect.y], [rect.x, rect.y + rect.h], [rect.x + rect.w, rect.y + rect.h]];
    return corners.every(function (c) {
      var dx = c[0] - R.c;
      var dy = c[1] - R.c;
      return Math.sqrt(dx * dx + dy * dy) < R.face - 4;
    });
  }
  function overlaps(a, b, own) {
    if (own && b.w === 12 && Math.abs(b.x + 6 - own.x) < 0.5 && Math.abs(b.y + 6 - own.y) < 0.5) return false;
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function drawBlip(bl, conflictIds) {
    var f = bl.f;
    var holding = f.phase === "holding";
    var calling = holding && !isStacked(f);
    var cls = "ct-blip" + (holding ? " is-holding" : "") + (calling ? " is-calling" : "") + (isStacked(f) ? " is-stacked" : "") + (f.id === ui.selected ? " is-on" : "") + (conflictIds.indexOf(f.id) >= 0 ? " is-conflict" : "") + (f.held ? " is-held" : "") + (f.kind === "run" ? " is-run" : "") + (!f.range && !holding ? " is-unknown" : "");
    var label = bl.label
      ? '<span class="ct-blip-label ' + bl.label.side + '" style="left:' + bl.label.dx.toFixed(1) + "px;top:" + bl.label.dy.toFixed(1) + "px;width:" + bl.label.w.toFixed(0) + 'px"><b>' + esc(f.call) + "</b><small>" + esc(bl.label.sub) + "</small></span>"
      : "";
    return (
      '<button class="' + cls + '" data-id="' + f.id + '" style="left:' + bl.x.toFixed(1) + "px;top:" + bl.y.toFixed(1) + "px;" + hueOf(f.face || f.title) + '" title="' + esc(f.call + " · " + f.title) + '">' +
      (calling ? '<i class="ct-halo"></i>' : "") +
      '<i class="ct-blip-dot"></i>' + label +
      "</button>"
    );
  }

  function drawGround(ground) {
    var stand = sortBay("stand", ground.filter(function (f) { return f.phase === "stand"; }));
    var parked = ground.filter(function (f) { return f.phase === "parked"; });
    return (
      '<div class="ct-ground"><span class="ct-ground-h">On the ground</span>' +
      stand.slice(0, 3).map(function (f) {
        return '<button class="ct-ground-chip' + (f.id === ui.selected ? " is-on" : "") + '" data-id="' + f.id + '" style="--tab:' + tintOf(f.project) + '" title="' + esc(f.title) + ': a result you have not read"><i class="ct-unread"></i>' + esc(f.call) + "</button>";
      }).join("") +
      '<span class="ct-ground-more">' + (stand.length > 3 ? "+" + (stand.length - 3) + " · " : "") + parked.length + (STATE === "swarm" ? "+" : "") + " parked · " + W.doneCount + " done</span></div>"
    );
  }

  function drawLegend() {
    return (
      '<div class="ct-legend">' +
      '<span><i class="ct-lg-ring"></i>Rings: minutes until it needs you</span>' +
      '<span><i class="ct-lg-range"></i>Predicted range</span>' +
      '<span><i class="ct-lg-trail"></i>Trail</span>' +
      '<span><i class="ct-lg-hold"></i>Holding for you</span>' +
      "</div>"
    );
  }

  /* ------------------------------------------------------------------ the arrivals board (split-flap) */

  var flapMemory = {}; // id -> { time, status } as last drawn, so changed flaps turn over

  function flaps(text, cells, cls) {
    var s = String(text).toUpperCase();
    var out = "";
    for (var i = 0; i < cells; i++) {
      var ch = s.charAt(i) || " ";
      out += '<i style="--i:' + i + '"' + (ch === " " ? ' class="is-blank"' : "") + ">" + (ch === " " ? "&nbsp;" : esc(ch)) + "</i>";
    }
    return '<span class="ct-flaps' + (cls ? " " + cls : "") + '">' + out + "</span>";
  }

  // How many rows the board has room for: fewer when the conflict's plan or the away list is open.
  function boardRows() {
    if (STATE === "away") return 6;
    if (ui.conflictOpen && !ui.staggered && !ui.conflictDismissed) return 7;
    return 10;
  }

  /** Returns the next things that will need Rogier, soonest first, as board rows. */
  function listArrivals(flights) {
    var rows = [];
    flights.forEach(function (f) {
      var need = needsAt(f);
      if (f.phase === "holding") rows.push({ f: f, at: isStacked(f) ? nextSlot() : ui.now - 100 + H.minutes(f.since) / 1000, need: need });
      else if (need) rows.push({ f: f, at: need[0], need: need });
      else if ((f.phase === "approach" || f.phase === "cruising") && f.held === "you") rows.push({ f: f, at: 99999, need: null });
    });
    Object.keys(ui.landed).forEach(function (id) {
      var f = findFlight(id, flights);
      if (f) rows.push({ f: f, at: ui.now - 50, need: null, landed: true });
    });
    rows.sort(function (a, b) { return a.at - b.at; });
    return rows.slice(0, boardRows());
  }

  function rowFields(row, conflictIds) {
    var f = row.f;
    if (row.landed) return { time: f.landedAt, status: "Landed", tone: "ok" };
    if (f.phase === "holding") {
      if (isStacked(f)) return { time: clock(nextSlot()), status: "Slot", tone: "" };
      return { time: f.since, status: "Holding", tone: "you" };
    }
    if (f.held) return { time: f.held === "you" ? "--:--" : f.held, status: "Held", tone: "" };
    if (isSlotted(f)) return { time: clock(row.need[0]), status: "Slot", tone: "" };
    var status = conflictIds.indexOf(f.id) >= 0 ? "Conflict" : f.queued ? "Queued" : f.range[1] - f.range[0] > 20 ? "Wide" : "Expected";
    return { time: rangeClock(row.need), status: status, tone: status === "Conflict" ? "you" : "" };
  }

  function drawArrivals(flights, conflict) {
    var conflictIds = conflict ? T.conflict.ids : [];
    var rows = listArrivals(flights);
    var html =
      '<section class="ct-arrivals" aria-label="Arrivals">' +
      '<header class="ct-arr-h"><span class="ct-arr-rule"></span><h2 class="ct-arr-name">Arrivals</h2><span class="ct-arr-rule"></span></header>' +
      '<div class="ct-arr-sub"><span>The next ' + ["", "", "", "", "", "five", "six", "seven", "eight", "nine", "ten"][rows.length] + ' things that need you. Times are predictions.</span>' + flaps(clock(ui.now), 5, "ct-arr-clock") + "</div>" +
      drawConflict(conflict) +
      '<div class="ct-arr-heads"><span>Time</span><span>Flight</span><span>Status</span></div>' +
      '<ol class="ct-arr-rows">';
    rows.forEach(function (row) {
      var f = row.f;
      var x = rowFields(row, conflictIds);
      var prev = flapMemory[f.id];
      var turned = prev && (prev.time !== x.time || prev.status !== x.status);
      flapMemory[f.id] = { time: x.time, status: x.status };
      html +=
        '<li class="ct-arr-row' + (f.id === ui.selected ? " is-on" : "") + (turned ? " is-turning" : "") + (x.tone ? " ct-tone-" + x.tone : "") + '" data-id="' + f.id + '">' +
        '<span class="ct-arr-l1">' + flaps(x.time, 8, "ct-col-time") + flaps(f.call, 12, "ct-col-call") + '<span class="ct-grow"></span>' + flaps(x.status, 8, "ct-col-status") + "</span>" +
        '<span class="ct-arr-l2"><span class="ct-arr-tab" style="--tab:' + tintOf(f.project) + '"></span><span class="ct-arr-flight">' + esc(f.title) + '</span><span class="ct-arr-for">' + esc(arrivalFor(f, row)) + "</span></span>" +
        "</li>";
    });
    html += "</ol>";
    if (STATE === "away") html += drawLandedWhileAway(flights);
    return html + "</section>";
  }

  function arrivalFor(f, row) {
    if (row.landed) return "a result to read";
    if (f.phase === "holding") return f.askKind === "approval" ? "approval" : "a question";
    if (f.held) return "held back · " + brings(f);
    if (isSlotted(f)) return "done " + rangeClock([Math.max(ui.now, f.range[0]), f.range[1]]) + " · " + brings(f);
    return brings(f);
  }

  function drawLandedWhileAway(flights) {
    var left = H.minutes(W.away.left);
    var back = H.minutes(W.away.back);
    var rows = [];
    flights.forEach(function (f) {
      if (!f.t) return;
      (W.turns[f.id] || []).forEach(function (s) {
        if (s.to && H.minutes(s.to) > left && H.minutes(s.to) <= back) rows.push({ f: f, at: s.to, end: s.end });
      });
    });
    rows.sort(function (a, b) { return H.minutes(b.at) - H.minutes(a.at); });
    return (
      '<div class="ct-landed"><h3 class="ct-landed-h">Landed while you were away <span>' + W.away.left + "-" + W.away.back + "</span></h3>" +
      rows.slice(0, 9).map(function (r) {
        return '<button class="ct-landed-row" data-id="' + r.f.id + '"><span class="ct-landed-at">' + r.at + '</span><span class="ct-landed-call">' + esc(r.f.call) + '</span><span class="ct-landed-title">' + esc(r.f.title) + '</span><span class="ct-landed-end' + (r.end === "request" ? " you-ink" : "") + '">' + (r.end === "request" ? "asked you" : "result") + "</span></button>";
      }).join("") +
      "</div>"
    );
  }

  function drawConflict(conflict) {
    if (ui.staggered) {
      return (
        '<div class="ct-alert ct-alert--done"><span class="ct-alert-ic">' + icon("check", 14) + '</span><span class="ct-alert-text"><b>Staggered.</b> ' + esc(T.conflict.hold.map(function (h) { return callSign(H.thread(h.id)) + " lands " + h.to; }).join(", ")) + '.</span><button class="btn btn--quiet btn--sm" data-act="unstagger">Undo</button></div>'
      );
    }
    if (!conflict || ui.conflictDismissed) return "";
    var c = T.conflict;
    var head =
      '<span class="ct-alert-ic">' + ownIcon("radar", 15) + '</span><span class="ct-alert-text"><b>3 arrivals ' + c.from + "-" + c.to + ".</b> Stagger them?</span>";
    if (!ui.conflictOpen) {
      return '<div class="ct-alert"><button class="ct-alert-main" data-act="conflict-open">' + head + '</button><button class="btn btn--sm" data-act="stagger">Stagger</button><button class="icon-btn icon-btn--sm" data-act="conflict-dismiss" title="Not now">' + icon("close", 12) + "</button></div>";
    }
    var first = H.thread(c.first);
    var plan =
      '<li><span class="ct-call">' + esc(callSign(first)) + "</span><span>" + esc(first.title) + '</span><span class="ct-plan-when">' + rangeClock([BASE + W.eta[first.id].range[0], BASE + W.eta[first.id].range[1]]) + ' · asks you</span></li>' +
      c.hold.map(function (h) {
        var t = H.thread(h.id);
        return '<li><span class="ct-call">' + esc(callSign(t)) + "</span><span>" + esc(t.title) + '</span><span class="ct-plan-when"><b>held to ' + h.to + "</b> · a result</span></li>";
      }).join("");
    return (
      '<div class="ct-alert is-open"><div class="ct-alert-top">' + head + '<button class="icon-btn icon-btn--sm" data-act="conflict-dismiss" title="Not now">' + icon("close", 12) + "</button></div>" +
      '<ol class="ct-plan">' + plan + "</ol>" +
      '<p class="ct-alert-why">' + esc(c.why) + "</p>" +
      '<div class="ct-alert-acts"><button class="btn btn--accent btn--sm" data-act="stagger">Stagger them</button><button class="btn btn--quiet btn--sm" data-act="conflict-dismiss">Let all three land</button></div>' +
      "</div>"
    );
  }

  /* ------------------------------------------------------------------ Threads: the strip board */

  function drawBoard(view) {
    var before = view.firstChild ? captureRects(view) : null;
    var flights = listFlights();
    var g = groupForList(flights, "board");
    var groups = g.groups;
    var c = countBays(flights);
    var conflict = findConflict(flights);
    var html = '<div class="ct-board">' + drawTimeline(flights, conflict) + '<div class="ct-rack">';
    BAYS.forEach(function (b) {
      var items = groups[b.id];
      var count = c[b.id];
      html +=
        '<section class="ct-col ct-col--' + b.id + '" data-bay="' + b.id + '">' +
        '<header class="ct-col-h"><span class="ct-col-name">' + b.label + ' <b class="count' + (b.id === "holding" && count ? " count--you" : "") + '">' + count + "</b></span>" +
        (g.moving[b.id] ? '<span class="ct-moving">' + g.moving[b.id] + " moving</span>" : "") +
        '<span class="ct-col-sub">' + b.sub + "</span></header>" +
        '<div class="ct-col-list">';
      if (b.id === "holding") {
        html +=
          '<div class="ct-zones">' +
          '<div class="ct-zone ct-zone--priority" data-zone="priority">' + icon("bolt", 18) + "<b>Priority</b><span>Lands first, and comes through slots</span></div>" +
          '<div class="ct-zone ct-zone--hold" data-zone="hold">' + ownIcon("stack", 18) + "<b>Hold back</b><span>It keeps working, and lands when you say</span></div>" +
          "</div>";
        var through = items.filter(function (x) { return !isStacked(x.f); });
        var stacked = items.filter(function (x) { return isStacked(x.f); });
        html += through.map(function (x) { return drawStrip(x.f, "board", { pending: x.pending }); }).join("");
        html += drawDeck(stacked, "board");
        if (!items.length) html += '<p class="ct-empty">Nothing holding. You are clear.</p>';
        if (groups.held.length) {
          html += '<h4 class="ct-sub">Held back <span>' + groups.held.length + "</span></h4>";
          html += groups.held.map(function (x) { return drawStrip(x.f, "board", { bay: "held", pending: x.pending }); }).join("");
        }
      } else {
        html += items.map(function (x) { return drawStrip(x.f, "board", { pending: x.pending }); }).join("");
        if (b.id === "parked") {
          if (STATE === "swarm") html += '<p class="ct-empty">' + (W.swarm.more.webshop + W.swarm.more["payments-api"] + W.swarm.more.ops) + " more parked, older</p>";
          html += drawHangar("board");
        } else if (!items.length) {
          html += '<p class="ct-empty">' + { approach: "Nothing due in the next 15 minutes.", cruising: "Nothing airborne.", stand: "Every result is read." }[b.id] + "</p>";
        }
      }
      html += "</div></section>";
    });
    html += "</div></div>";
    view.innerHTML = html;
    rememberShown("board", groups);
    if (before) playFlip(view, before);
    view.querySelectorAll(".ct-col-list").forEach(markFades);
  }

  var TL_LANES = 4; // lanes of chips on the arrivals timeline
  var TL_LANE = 20; // px per lane
  var measurer = null;

  /** Returns the width in px a call sign takes on a timeline chip: 10px, bold, tracked 0.06em. */
  function measureCall(text) {
    if (!measurer) measurer = document.createElement("canvas").getContext("2d");
    measurer.font = "640 10px " + getComputedStyle(root).getPropertyValue("--font-ui");
    return measurer.measureText(text).width + text.length * 0.6;
  }

  /** Returns the arrivals of the next hour as a timeline: a chip per predicted range, slots, the conflict. */
  function drawTimeline(flights, conflict) {
    var width = 1120;
    var x0 = 92;
    var span = 60;
    var x = function (m) { return x0 + ((m - ui.now) / span) * (width - x0 - 12); };
    var html = '<section class="ct-timeline" aria-label="Arrivals in the next hour"><div class="ct-tl-h"><b>Arrivals</b><span>next hour · the bar is the predicted range</span></div><div class="ct-tl-plot">';
    // ticks
    var first = Math.ceil(ui.now / 5) * 5;
    for (var m = first; m <= ui.now + span; m += 5) {
      var major = m % 30 === 0;
      html += '<span class="ct-tl-tick' + (major ? " is-major" : "") + '" style="left:' + x(m).toFixed(1) + 'px">' + (m % 10 === 0 || major ? "<b>" + clock(m) + "</b>" : "") + "</span>";
    }
    html += '<span class="ct-tl-now" style="left:' + x0 + 'px"><b>now ' + clock(ui.now) + "</b></span>";
    if (conflict) {
      var a = H.minutes(T.conflict.from);
      var b = H.minutes(T.conflict.to);
      html += '<button class="ct-tl-conflict" data-act="conflict-open" style="left:' + x(a).toFixed(1) + "px;width:" + (x(b) - x(a)).toFixed(1) + 'px"><span>3 arrivals · Stagger?</span></button>';
    }
    if (slotsOn()) {
      var s = nextSlot();
      while (s <= ui.now + span) {
        html += '<span class="ct-tl-slot" style="left:' + x(s).toFixed(1) + 'px"><b>slot ' + clock(s) + "</b></span>";
        if (ui.slots.mode !== "every") break;
        s += ui.slots.every;
      }
    }
    (ui.staggered ? T.conflict.hold : []).forEach(function (h) {
      html += '<span class="ct-tl-slot ct-tl-slot--held" style="left:' + x(H.minutes(h.to)).toFixed(1) + 'px"></span>';
    });
    // holding at now
    var holding = flights.filter(function (f) { return f.phase === "holding"; });
    var calling = holding.filter(function (f) { return !isStacked(f); }).length;
    if (holding.length) {
      html += '<span class="ct-tl-holding" style="left:' + (x0 - 82) + 'px">' + times('<i></i>', Math.min(4, holding.length)) + "<b>" + holding.length + " holding</b>" + (calling < holding.length ? "<small>" + (holding.length - calling) + " at " + clock(nextSlot()) + "</small>" : "") + "</span>";
    }
    // One chip per arrival, in lanes. A chip is as wide as its prediction or its call sign,
    // whichever is wider, so the label always fits; the bar along its foot is the predicted range.
    // A chip takes the first lane where it clears the chips before it.
    var arrivals = flights.filter(function (f) { return (f.phase === "approach" || f.phase === "cruising") && f.range; }).sort(function (p, q) { return p.range[0] - q.range[0]; });
    var lanes = [];
    var dropped = 0;
    arrivals.forEach(function (f) {
      var lo = Math.max(ui.now, f.range[0]);
      var hi = Math.min(ui.now + span, Math.max(f.range[1], lo + 1));
      if (lo > ui.now + span) return;
      var rangeLeft = x(lo);
      var rangeW = Math.max(x(hi) - rangeLeft, 4);
      var w = Math.max(rangeW, measureCall(f.call) + 16);
      var left = Math.min(rangeLeft, width - w);
      var lane = 0;
      while (lanes[lane] != null && lanes[lane] > left - 5) lane++;
      if (lane >= TL_LANES) {
        dropped++;
        return;
      }
      lanes[lane] = left + w;
      var top = lane * TL_LANE;
      var held = f.held && f.held !== "you";
      var cls = "ct-tl-chip" + (f.id === ui.selected ? " is-on" : "") + (conflict && T.conflict.ids.indexOf(f.id) >= 0 ? " is-conflict" : "") + (f.held || isSlotted(f) ? " is-ghost" : "");
      html +=
        '<button class="' + cls + '" data-id="' + f.id + '" style="left:' + left.toFixed(1) + "px;width:" + w.toFixed(1) + "px;top:" + top + "px;" + hueOf(f.title) + '" title="' + esc(f.title + " · " + rangeText(f.range)) + '">' +
        '<i class="ct-tl-range" style="left:' + (rangeLeft - left).toFixed(1) + "px;width:" + rangeW.toFixed(1) + 'px"></i><span>' + esc(f.call) + "</span></button>";
      if (held) {
        var hx = x(H.minutes(f.held));
        if (hx < width) html += '<span class="ct-tl-held" style="left:' + (left + w).toFixed(1) + "px;width:" + Math.max(0, hx - left - w).toFixed(1) + "px;top:" + top + 'px"></span><span class="ct-tl-pin" style="left:' + hx.toFixed(1) + "px;top:" + top + "px;" + hueOf(f.title) + '"></span>';
      }
    });
    if (dropped) html += '<span class="ct-tl-more">+' + dropped + " more in the hour</span>";
    html += "</div></section>";
    return html;
  }

  /* ------------------------------------------------------------------ the Office */

  var office = { handle: null, loading: false, failed: false, told: {} };

  /** Returns the state the Office should draw: the page's state, with slots and the stagger applied. */
  function officeState() {
    if (slotsOn()) return "slots";
    if (ui.staggered || STATE === "staggered") return "everyday";
    return STATE === "slots" ? "everyday" : STATE;
  }

  /** Tells the Office a flight was cleared ("clear") or landed ("land"), once. */
  function tellOffice(what, id) {
    if (!office.handle || typeof office.handle[what] !== "function" || office.told[id]) return;
    office.told[id] = true;
    office.handle[what](id);
  }

  /** Redraws the Office for the current state, then replays what happened since the page opened. */
  function syncOffice() {
    if (!office.handle) return;
    var state = officeState();
    office.handle.setState(state);
    office.told = {};
    if (state === "landing") office.told.t3ds = true;
    if (state === "moving") office.told.tCartTests = true;
    Object.keys(ui.answered).forEach(function (id) { tellOffice("clear", id); });
    Object.keys(ui.landed).forEach(function (id) { tellOffice("land", id); });
  }

  function officeModule() {
    return window.OfficeModes && window.OfficeModes["control-tower"];
  }

  // The Office's scripts are loaded the first time the mode is shown: the 3D kit is 943 KiB, and
  // the other two modes never need it.
  function loadOffice(done) {
    if (officeModule()) return done();
    if (office.loading) return;
    office.loading = true;
    var css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "control-tower-office.css";
    document.head.appendChild(css);
    var chain = window.OfficeKit ? ["control-tower-office.js"] : ["../vendor/office-kit.js", "control-tower-office.js"];
    (function next() {
      if (!chain.length) {
        office.loading = false;
        return done();
      }
      var s = document.createElement("script");
      s.src = chain.shift();
      s.onload = next;
      s.onerror = function () {
        office.loading = false;
        office.failed = true;
        done();
      };
      document.body.appendChild(s);
    })();
  }

  function showOffice(view) {
    if (office.handle && view.querySelector(".ct-office-host")) {
      office.handle.resume();
      office.handle.select(ui.selected);
      return;
    }
    view.innerHTML = '<div class="ct-office-host"></div>' + drawOfficePlaceholder(officeModule() ? "" : "Loading the Aerodrome…");
    loadOffice(function () {
      // The overview may have closed while the scripts loaded; it mounts again when it reopens.
      if (!ov.root || !ov.root.contains(view)) return;
      var mod = officeModule();
      var host = view.querySelector(".ct-office-host");
      if (!mod || !host) {
        var ph = view.querySelector(".ct-office-ph-note");
        if (ph) ph.textContent = "The 3D Aerodrome is being built by the office builder. This is where it mounts.";
        return;
      }
      var placeholder = view.querySelector(".ct-office-ph");
      if (placeholder) placeholder.remove();
      // The Office plays the landing and moving states' own moments itself.
      office.told = { t3ds: STATE === "landing", tCartTests: STATE === "moving" };
      office.handle = mod.mount(host, {
        world: W,
        theme: root.dataset.theme === "orient-express" || root.dataset.theme === "dark" ? "orient-express" : "whitehaven",
        state: officeState(),
        selected: ui.selected,
        reducedMotion: motion.matches,
        onSelect: function (id) { select(id, "office"); },
        onOpen: function (id) { openThread(id); },
      });
      if (ui.mode !== "office") office.handle.pause();
      Object.keys(ui.answered).forEach(function (id) { tellOffice("clear", id); });
      Object.keys(ui.landed).forEach(function (id) { tellOffice("land", id); });
    });
  }

  function drawOfficePlaceholder(note) {
    var plane = "M11 0 L-5 -2 L-7 -10 L-10 -10 L-8.5 -2 L-12 -1.6 L-14 -5.5 L-16 -5.5 L-15 0 L-16 5.5 L-14 5.5 L-12 1.6 L-8.5 2 L-10 10 L-7 10 L-5 2 Z";
    var hangar = function (x, tint, name) {
      return '<g transform="translate(' + x + ' 300)"><path d="M0 70 V30 Q60 -14 120 30 V70 Z" fill="var(--proj-' + tint + ')" stroke="var(--ink)" stroke-width="1.4"/><path d="M28 70 V44 H92 V70" fill="none" stroke="var(--ink)" stroke-width="1.2"/><path d="M28 52 H92 M28 60 H92" stroke="var(--ink)" stroke-width=".6" opacity=".5"/><text x="60" y="92" text-anchor="middle" class="ct-ph-label">' + name + "</text></g>";
    };
    return (
      '<div class="ct-office-ph"><svg viewBox="0 0 900 470" class="ct-ph-art" aria-hidden="true">' +
      '<rect x="0" y="370" width="900" height="100" class="ct-ph-ground"/>' +
      '<path d="M40 430 H860" class="ct-ph-runway"/><path d="M60 430 H840" class="ct-ph-dash"/>' +
      hangar(70, "webshop", "webshop") + hangar(215, "payments", "payments-api") + hangar(360, "ops", "ops") +
      '<g transform="translate(560 170)"><rect x="0" y="120" width="230" height="80" fill="var(--raised)" stroke="var(--ink)" stroke-width="1.4"/><path d="M0 140 H230" stroke="var(--line)"/>' +
      '<rect x="92" y="10" width="46" height="110" fill="var(--raised)" stroke="var(--ink)" stroke-width="1.4"/><path d="M102 16 V114 M128 16 V114" stroke="var(--line)"/>' +
      '<path d="M70 -14 H160 L150 10 H80 Z" fill="var(--proj-ops)" stroke="var(--ink)" stroke-width="1.4"/><path d="M78 -14 L90 -30 H140 L152 -14 Z" fill="var(--ink)"/><path d="M115 -30 V-48" stroke="var(--ink)" stroke-width="1.4"/><circle cx="115" cy="-50" r="3.4" fill="var(--you)"/>' +
      '<text x="115" y="176" text-anchor="middle" class="ct-ph-label">Terminal · your desk in the tower cab</text></g>' +
      '<g fill="none" stroke="var(--ink)" stroke-dasharray="2 5" opacity=".5"><ellipse cx="675" cy="96" rx="150" ry="26"/><ellipse cx="675" cy="60" rx="118" ry="20"/><ellipse cx="675" cy="30" rx="86" ry="15"/></g>' +
      '<g fill="var(--ink)"><path transform="translate(540 104) rotate(190) scale(.9)" d="' + plane + '"/><path transform="translate(790 54) rotate(-20) scale(.8)" d="' + plane + '"/><path transform="translate(612 18) rotate(170) scale(.7)" d="' + plane + '"/><path transform="translate(150 200) rotate(-12)" d="' + plane + '"/><path transform="translate(330 150) rotate(8) scale(.9)" d="' + plane + '"/></g>' +
      '<circle cx="540" cy="104" r="9" fill="none" stroke="var(--you)" stroke-width="1.4"/>' +
      '<text x="512" y="40" text-anchor="end" class="ct-ph-label">the holding stack</text>' +
      "</svg>" +
      '<div class="ct-office-ph-text"><h2 class="ct-ph-title">The Aerodrome</h2><p>A hangar per project, a plane per thread with its bean as pilot, and the holding stack circling your tower.</p><p class="ct-office-ph-note">' + esc(note || "") + "</p></div></div>"
    );
  }

  /* ------------------------------------------------------------------ the selection card */

  /**
   * Draws the card in the overview's bottom-left corner: the selected flight, or, with nothing
   * selected, the oldest request that came through ("Up next"), so one move answers it.
   */
  function drawCard() {
    if (!ov.card) return;
    var flights = listFlights();
    var f = ui.selected ? findFlight(ui.selected, flights) : null;
    var upNext = false;
    if (!f && ui.mode !== "threads") {
      f = sortBay("holding", flights.filter(function (x) { return x.phase === "holding" && !isStacked(x); }))[0] || null;
      upNext = !!f;
    }
    if (!f) {
      ov.card.hidden = true;
      ov.root.style.setProperty("--card-space", "0px");
      return;
    }
    var bay = bayOf(f);
    var need = needsAt(f);
    var faceName = f.face || f.title;
    var pose = f.phase === "holding" ? "waiting" : f.phase === "approach" || f.phase === "cruising" ? "working" : f.phase === "stand" ? "idle" : f.pose === "asleep" ? "asleep" : "idle";
    var phase;
    if (bay === "holding") phase = isStacked(f) ? "Holding · lands " + clock(nextSlot()) : "Holding " + ago(f.since) + " · since " + f.since;
    else if (bay === "held") phase = "Held back · " + (f.held === "you" ? "until you let it land" : "lands " + f.held);
    else if (bay === "approach") phase = "Approach · ETA " + rangeText(f.range);
    else if (bay === "cruising") phase = "Cruising" + (f.range ? " · ETA " + rangeText(f.range) : f.queued ? " · queued" : " · estimating");
    else if (bay === "stand") phase = "On stand · landed " + (f.landedAt || f.t.last);
    else phase = "Parked · idle " + ago(f.t.last);
    var who = f.kind === "run" ? "Run · " + W.providers[f.provider].name + " · " + f.model : W.providers[f.t.provider].name + " · " + f.t.model + (f.t.role ? " · " + f.t.role : "");
    var body = "";
    var acts = "";
    if (bay === "holding") {
      body = '<p class="ct-card-ask">' + (f.ask && f.ask.code ? "Run <code>" + esc(f.ask.code) + "</code>?" : esc(f.askFull)) + "</p>";
      if (slotsOn() && f.urgent && ui.slots.urgent) body += '<p class="ct-card-basis">' + esc(T.urgent[f.id]) + " It came through.</p>";
      acts = answerButtons(f, "card", true);
      if (f.priority) acts += '<button class="btn btn--quiet btn--sm" data-act="unpriority" data-id="' + f.id + '">No priority</button>';
    } else if (bay === "approach" || bay === "cruising" || bay === "held") {
      var when = need && f.range ? clock(need[0]) + (need[1] !== need[0] ? "-" + clock(need[1]) : "") : "";
      body =
        '<p class="ct-card-eta">' + (f.range ? "<b>" + (when || rangeClock(f.range)) + "</b> · brings " + esc(brings(f)) : "<b>No estimate yet</b>") + (f.busySince ? " · airborne " + ago(f.busySince) : "") + "</p>" +
        '<p class="ct-card-basis">' + (f.range ? "Based on " + esc(lower(f.basis || "").replace(/\bcamp\b/g, "step")) : esc(f.basis || "")) + "</p>";
      acts = f.held ? '<button class="btn btn--sm" data-act="release" data-id="' + f.id + '">Let it land</button>' : '<button class="btn btn--sm" data-act="hold" data-id="' + f.id + '" title="It keeps working; it lands when you say">Hold back</button>';
    } else {
      body = '<p class="ct-card-result">' + esc(resultLine(f.t)) + "</p>";
    }
    acts += '<span class="spacer"></span><button class="ct-open" data-open-id="' + f.id + '">' + (f.kind === "run" ? "Open run" : "Open thread") + icon("chev-r", 13) + "</button>";
    ov.card.hidden = false;
    ov.card.classList.toggle("is-next", upNext);
    ov.card.innerHTML =
      (upNext ? '<p class="ct-card-eyebrow">Up next · the oldest request holding</p>' : "") +
      '<div class="ct-card-h">' + Crew.face(faceName, { pose: pose, size: 40 }) +
      '<div class="ct-card-id"><span class="ct-card-line"><span class="ct-call">' + esc(f.call) + '</span><span class="ct-card-phase' + (bay === "holding" ? " you-ink" : "") + '">' + esc(phase) + "</span></span>" +
      '<b class="ct-card-title">' + esc(f.title) + "</b>" +
      '<span class="ct-card-meta">' + (f.project ? '<span class="proj proj--' + W.projects.filter(function (p) { return p.id === f.project; })[0].tint + '">' + f.project + "</span>" : '<span class="proj">No project</span>') + "<span>" + esc(who) + "</span></span></div>" +
      (upNext ? "" : '<button class="icon-btn icon-btn--sm ct-card-x" data-act="deselect" title="Clear the selection  esc">' + icon("close", 12) + "</button>") + "</div>" +
      body + '<div class="ct-card-acts">' + acts + "</div>";
    // The Threads mode docks the card over the Holding column's foot; the column's list ends
    // above it, so the card never covers a strip.
    ov.root.style.setProperty("--card-space", ov.card.offsetHeight + 12 + "px");
  }

  function lower(s) {
    return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
  }

  /* ------------------------------------------------------------------ the slots popover */

  function openPopover(where, anchor) {
    closePopover();
    ui.popover = where;
    var pop = document.createElement("div");
    pop.className = "pop ct-pop";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Landing slots");
    els.app.appendChild(pop);
    els.pop = pop;
    drawPopover();
    var r = anchor.getBoundingClientRect();
    var appR = els.app.getBoundingClientRect();
    pop.style.top = r.bottom - appR.top + 6 + "px";
    pop.style.left = Math.min(r.left - appR.left, appR.width - 380) + "px";
    drawSlotsControl();
    drawTop();
  }

  function drawPopover() {
    var pop = els.pop;
    if (!pop) return;
    var s = ui.slots;
    var flights = listFlights();
    var stacked = flights.filter(isStacked).length;
    var through = flights.filter(function (f) { return f.phase === "holding" && !isStacked(f); }).length;
    var nextText = slotsOn() ? clock(nextSlot()) : clock((Math.floor(ui.now / s.every) + 1) * s.every);
    var opt = function (value, title, note, extra) {
      return '<label class="option ct-opt"><span class="choice-box"><input type="radio" name="ct-slots" value="' + value + '"' + (s.mode === value ? " checked" : "") + "></span><b>" + title + (extra || "") + "</b><small>" + note + "</small></label>";
    };
    var every =
      ' <span class="seg ct-every" role="group" aria-label="Interval">' +
      [20, 30, 60].map(function (n) { return '<button type="button" data-every="' + n + '" aria-pressed="' + (s.every === n) + '">' + n + "</button>"; }).join("") +
      "</span> min";
    var dock = slotsOn()
      ? "<b>" + stacked + " holding · next slot " + clock(nextSlot()) + "</b><small>" + (through ? through + " urgent came through. " : "") + "The badge counts only what came through; the rest stays quiet until the slot.</small>"
      : "<b>" + through + " waiting on you</b><small>Every request rings and counts on the badge as it lands.</small>";
    pop.innerHTML =
      '<div class="pop-h"><b>Landing slots</b><span>When may agents interrupt you?</span></div>' +
      '<div class="pop-sec"><div class="options">' +
      opt("off", "Let everything through", "Each request lands as it comes. Today's behaviour.") +
      opt("every", "Land every", "Requests wait quietly and land together. Next slot " + nextText + ".", every) +
      opt("until", "Hold until " + s.until, "Focus. Nothing lands before " + s.until + ", then everything at once.") +
      "</div></div>" +
      '<div class="pop-sec ct-pop-row"><span class="ct-pop-row-text"><b>Urgent comes through</b><small>A request marked urgent lands at once, slot or not.</small></span><button class="toggle" role="switch" aria-checked="' + s.urgent + '" data-act="urgent" aria-label="Urgent comes through"></button></div>' +
      '<div class="pop-sec ct-pop-dock"><span class="app-icon" style="--size:44px">' + Crew.logo(28) + (through ? '<span class="app-icon-badge">' + through + "</span>" : "") + '</span><span class="ct-pop-row-text">' + dock + "</span></div>" +
      '<p class="ct-pop-foot">Agents keep working. Only the interruptions wait.</p>';
  }

  function closePopover() {
    if (els.pop) els.pop.remove();
    els.pop = null;
    if (ui.popover) {
      ui.popover = null;
      drawSlotsControl();
      drawTop();
    }
  }

  /* ------------------------------------------------------------------ actions */

  function select(id, from) {
    ui.selected = id;
    drawSidebar(false);
    if (ov.root) {
      ov.dirty.threads = ov.dirty.radar = true;
      if (ui.mode === "radar") markSelected(ov.views.radar);
      else if (ui.mode === "threads") markSelected(ov.views.threads);
      if (office.handle && from !== "office") office.handle.select(id);
      drawCard();
    }
  }

  // Marks the selection in a mode without redrawing it, so nothing jumps.
  function markSelected(view) {
    view.querySelectorAll("[data-id]").forEach(function (el) {
      el.classList.toggle("is-on", el.dataset.id === ui.selected);
    });
    if (ui.mode === "radar") {
      drawRadar(view);
    }
  }

  function openThread(id) {
    if (W.runSessions[id]) {
      api.showToast("Runs open on the Runs page, which this drawing does not draw.");
      return;
    }
    if (!api.getThread(id)) return;
    closeOverview(id);
  }

  function openOverview() {
    if (ui.overview) return;
    ui.overview = true;
    if (!ui.selected) ui.selected = api.openId();
    api.drawMain();
    drawSidebar(false);
    markOfficeButton();
  }

  function closeOverview(openId) {
    if (office.handle) {
      office.handle.dispose();
      office.handle = null;
    }
    ui.overview = false;
    ov = {};
    var id = [openId, ui.selected, api.openId()].filter(function (x) { return x && api.getThread(x); })[0];
    api.open(id);
    markOfficeButton();
  }

  function markOfficeButton() {
    var b = els.officeBtn;
    if (b) b.classList.toggle("is-pressed", ui.overview);
  }

  function answer(id, label) {
    var f = findFlight(id);
    if (!f) return;
    ui.answered[id] = { at: clock(ui.now), label: label };
    var wasSelected = ui.selected === id;
    refresh({ act: true });
    tellOffice("clear", id);
    var text = f.kind === "run" ? "Cleared " + f.call + ": " + label + ". The run goes on." : "Cleared " + f.call + ": " + label + ". Back in the air.";
    showToast(text, function () {
      delete ui.answered[id];
      if (wasSelected) ui.selected = id;
      refresh({ act: true });
      syncOffice();
    });
  }

  function hold(id, to) {
    ui.held[id] = to || "you";
    refresh({ act: true });
    var f = findFlight(id);
    showToast(f.call + " held back. It keeps working.", function () {
      delete ui.held[id];
      refresh({ act: true });
    });
  }
  function release(id) {
    var was = ui.held[id];
    delete ui.held[id];
    refresh({ act: true });
    showToast(findFlight(id).call + " lands when it is ready.", function () {
      ui.held[id] = was;
      refresh({ act: true });
    });
  }
  function prioritise(id) {
    ui.priority[id] = true;
    delete ui.held[id];
    refresh({ act: true });
    showToast(findFlight(id).call + " has priority: it lands first, slot or not.", function () {
      delete ui.priority[id];
      refresh({ act: true });
    });
  }

  function stagger() {
    ui.staggered = true;
    ui.conflictOpen = false;
    T.conflict.hold.forEach(function (h) { ui.held[h.id] = h.to; });
    refresh({ act: true });
    syncOffice();
    showToast("Staggered: " + T.conflict.hold.map(function (h) { return callSign(H.thread(h.id)) + " at " + h.to; }).join(", ") + ".", unstagger);
  }
  function unstagger() {
    ui.staggered = false;
    T.conflict.hold.forEach(function (h) { delete ui.held[h.id]; });
    refresh({ act: true });
    syncOffice();
  }

  var toastTimer = null;
  function showToast(text, onUndo, stay) {
    var old = els.side.querySelector(".ct-toast");
    if (old) old.remove();
    clearTimeout(toastTimer);
    var toast = document.createElement("div");
    toast.className = "side-toast stage-toast ct-toast is-new";
    toast.innerHTML = '<span class="side-toast-text">' + esc(text) + "</span>" + (onUndo ? "<button>Undo</button>" : "");
    els.side.insertBefore(toast, els.assistants);
    if (onUndo) {
      toast.querySelector("button").addEventListener("click", function () {
        toast.remove();
        onUndo();
      });
    }
    if (!stay) toastTimer = setTimeout(function () { toast.remove(); }, 6000);
  }

  /** A turn ends by itself while the window is open: the flight lands and moves to On stand. */
  function landByItself(id, at) {
    ui.now = H.minutes(at);
    ui.landed[id] = at;
    refresh();
    tellOffice("land", id);
  }

  /* ------------------------------------------------------------------ the drag on the strip board */

  var drag = null;

  function startDrag(e, el) {
    var rect = el.getBoundingClientRect();
    drag = { id: el.dataset.id, from: el.dataset.drag, el: el, x0: e.clientX, y0: e.clientY, dx: e.clientX - rect.left, dy: e.clientY - rect.top, started: false, pointer: e.pointerId };
  }
  function moveDrag(e) {
    if (!drag) return;
    if (!drag.started) {
      if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) < 6) return;
      drag.started = true;
      var ghost = drag.el.cloneNode(true);
      ghost.classList.add("ct-ghost-strip");
      ghost.style.width = drag.el.getBoundingClientRect().width + "px";
      els.app.appendChild(ghost);
      drag.ghost = ghost;
      drag.el.classList.add("is-lifted");
      ov.root.classList.add("is-dragging");
      ov.root.dataset.dragFrom = drag.from;
    }
    var appR = els.app.getBoundingClientRect();
    drag.ghost.style.transform = "translate(" + (e.clientX - appR.left - drag.dx) + "px," + (e.clientY - appR.top - drag.dy) + "px) rotate(1.5deg)";
    var target = dropTarget(e);
    ov.root.querySelectorAll(".is-target").forEach(function (t) { t.classList.remove("is-target"); });
    if (target) target.el.classList.add("is-target");
  }
  function dropTarget(e) {
    var under = document.elementFromPoint(e.clientX, e.clientY);
    if (!under) return null;
    var zone = under.closest("[data-zone]");
    if (zone) return { kind: zone.dataset.zone, el: zone };
    var col = under.closest("[data-bay]");
    if (col) return { kind: "bay:" + col.dataset.bay, el: col };
    return null;
  }
  function endDrag(e) {
    if (!drag) return;
    var d = drag;
    drag = null;
    if (!d.started) return;
    var target = dropTarget(e);
    d.ghost.remove();
    d.el.classList.remove("is-lifted");
    ov.root.classList.remove("is-dragging");
    ov.root.querySelectorAll(".is-target").forEach(function (t) { t.classList.remove("is-target"); });
    if (!target) return;
    var inbound = d.from === "approach" || d.from === "cruising";
    if (target.kind === "priority") return prioritise(d.id);
    if (target.kind === "hold" && inbound) return hold(d.id);
    if (target.kind === "bay:holding" && inbound) return hold(d.id);
    if ((target.kind === "bay:approach" || target.kind === "bay:cruising") && d.from === "held") return release(d.id);
    if (target.kind === "bay:" + d.from || target.kind === "hold" && d.from === "held") return;
    showToast("A strip's bay follows its agent. You can hold a flight back or give it priority.");
  }

  /* ------------------------------------------------------------------ fades on scrolled lists */

  /** Marks which edges of a scrolling list have more beyond them, so CSS fades just those. */
  function markFades(el) {
    if (!el) return;
    var top = el.scrollTop > 2;
    var bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
    el.setAttribute("data-fade", top && bottom ? "both" : top ? "top" : bottom ? "bottom" : "none");
  }
  function markAllFades() {
    markFades(els.list);
    if (ov.root) ov.root.querySelectorAll(".ct-col-list").forEach(markFades);
  }

  /* ------------------------------------------------------------------ wiring */

  function onClick(e) {
    var t = e.target;
    var slotsBtn = t.closest("[data-slots-open]");
    if (slotsBtn) {
      if (ui.popover === slotsBtn.dataset.slotsOpen) closePopover();
      else openPopover(slotsBtn.dataset.slotsOpen, slotsBtn);
      return;
    }
    if (els.pop && els.pop.contains(t)) return onPopoverClick(e);
    if (els.pop && !t.closest(".ct-pop")) closePopover();

    var ans = t.closest("[data-answer]");
    if (ans) {
      e.stopPropagation();
      return answer(ans.dataset.answer, ans.dataset.label);
    }
    var modeBtn = t.closest("[data-mode]");
    if (modeBtn && modeBtn.classList.contains("ct-switch-btn")) return setMode(modeBtn.dataset.mode);
    var act = t.closest("[data-act]");
    if (act) return onAct(act.dataset.act, act);
    var more = t.closest("[data-more]");
    if (more) {
      ui.moreOpen[more.dataset.more] = true;
      return drawSidebar(false);
    }
    var openBtn = t.closest("[data-open-id]");
    if (openBtn) return openThread(openBtn.dataset.openId);
    var sel = t.closest("[data-select]");
    if (sel) {
      ui.handover = false;
      if (!ui.overview) {
        ui.selected = sel.dataset.select;
        openOverview();
      } else select(sel.dataset.select);
      return;
    }
    var item = t.closest("[data-id]");
    if (item && !t.closest(".ct-pop")) {
      var id = item.dataset.id;
      var inSide = els.list.contains(item);
      if (inSide && !ui.overview) return openThread(id);
      if (e.detail >= 2 && id === ui.selected) return openThread(id);
      return select(id === ui.selected && !inSide ? null : id);
    }
  }

  function onAct(name, el) {
    if (name === "close") return closeOverview();
    if (name === "deselect") return select(null);
    if (name === "deck") {
      ui.deckOpen = !ui.deckOpen;
      return refresh({ act: true });
    }
    if (name === "hangar") {
      ui.hangarOpen = !ui.hangarOpen;
      return refresh({ act: true });
    }
    if (name === "handover-close") {
      ui.handover = false;
      return drawSidebar(false);
    }
    if (name === "conflict-open") {
      ui.conflictOpen = true;
      ui.conflictDismissed = false;
      if (!ui.overview) openOverview();
      if (ui.mode !== "radar") setMode("radar");
      return refresh({ act: true });
    }
    if (name === "conflict-dismiss") {
      ui.conflictDismissed = true;
      ui.conflictOpen = false;
      return refresh({ act: true });
    }
    if (name === "stagger") return stagger();
    if (name === "unstagger") return unstagger();
    if (name === "hold") return hold(el.dataset.id);
    if (name === "unpriority") {
      delete ui.priority[el.dataset.id];
      return refresh({ act: true });
    }
    if (name === "release") return release(el.dataset.id);
  }

  function onPopoverClick(e) {
    var t = e.target;
    var ev = t.closest("[data-every]");
    if (ev) {
      e.preventDefault();
      ui.slots.every = Number(ev.dataset.every);
      ui.slots.mode = "every";
      return slotsChanged();
    }
    if (t.closest("[data-act=urgent]")) {
      ui.slots.urgent = !ui.slots.urgent;
      return slotsChanged();
    }
  }
  function onChange(e) {
    if (e.target.name === "ct-slots") {
      ui.slots.mode = e.target.value;
      slotsChanged();
    }
  }
  function slotsChanged() {
    ui.deckOpen = false;
    refresh({ act: true });
    syncOffice();
    drawPopover();
    drawSlotsControl();
  }

  function onKey(e) {
    var mod = e.metaKey || e.ctrlKey;
    if (mod && e.shiftKey && (e.key === "O" || e.key === "o")) {
      e.preventDefault();
      return ui.overview ? closeOverview() : openOverview();
    }
    if (mod && e.altKey && /^Digit[123]$/.test(e.code)) {
      e.preventDefault();
      if (!ui.overview) openOverview();
      return setMode(MODES[Number(e.code.slice(5)) - 1].id);
    }
    if (e.key === "Escape") {
      if (drag) {
        if (drag.ghost) drag.ghost.remove();
        if (ov.root) ov.root.classList.remove("is-dragging");
        drag = null;
        return;
      }
      if (els.pop) return closePopover();
      if (ui.overview && ui.selected) return select(null);
      if (ui.overview) return closeOverview();
    }
    if (e.key === "Enter" && ui.overview && ui.selected && !e.target.closest("button, input")) openThread(ui.selected);
  }

  function wire() {
    document.addEventListener("click", onClick);
    document.addEventListener("change", onChange);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", function (e) {
      var strip = e.target.closest("[data-drag]");
      if (strip && !e.target.closest("button") && ov.root && ov.root.contains(strip)) startDrag(e, strip);
    });
    document.addEventListener("pointermove", moveDrag);
    document.addEventListener("pointerup", endDrag);
    // Nothing moves under the pointer (#626): bays change once it leaves the list.
    els.list.addEventListener("pointerenter", function () { ui.pointerIn.side = true; });
    els.list.addEventListener("pointerleave", function () {
      ui.pointerIn.side = false;
      drawSidebar(true);
    });
    document.addEventListener("pointerover", function (e) {
      if (drag) return;
      var inRack = !!(ov.root && e.target.closest && e.target.closest(".ct-rack"));
      if (inRack === ui.pointerIn.board) return;
      ui.pointerIn.board = inRack;
      if (!inRack && ui.mode === "threads" && ov.views) drawBoard(ov.views.threads);
    });
    els.officeBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (ui.overview) closeOverview();
      else openOverview();
    });
    window.addEventListener("resize", function () {
      if (office.handle) office.handle.resize();
      markAllFades();
    });
    document.addEventListener("scroll", function (e) {
      if (e.target === els.list || (e.target.classList && e.target.classList.contains("ct-col-list"))) markFades(e.target);
    }, true);
    // Call signs are measured in the UI face; draw the board again once the face has loaded.
    if (document.fonts) document.fonts.ready.then(function () {
      if (ov.views && ui.mode === "threads") drawBoard(ov.views.threads);
      else if (ov.dirty) ov.dirty.threads = true;
      markAllFades();
    });
  }

  /* ------------------------------------------------------------------ the stage */

  Stage.direction({
    rootClass: "ov-control-tower",
    initial: "t3ds",
    drawList: function (listEl, stageApi) {
      api = stageApi;
      els.app = stageApi.els.app;
      els.side = stageApi.els.side;
      els.list = listEl;
      els.assistants = stageApi.els.assistants;
      els.sum = stageApi.els.sum;
      els.slots = document.createElement("button");
      els.slots.setAttribute("data-slots-open", "side");
      els.side.insertBefore(els.slots, listEl);
      els.officeBtn = els.side.querySelector('.side-actions .icon-btn[title^="The office"]');
      if (els.officeBtn) els.officeBtn.title = "The overview ⌘⇧O";
      drawSidebar(false);
    },
    drawMain: function (mainEl) {
      if (!ui.overview) return false;
      drawOverview(mainEl);
      return true;
    },
    onOpen: function () {
      if (api) drawSidebar(false);
    },
    boot: function () {
      wire();
      markOfficeButton();
      if (STATE === "moving") {
        // Rogier's pointer rests on the list as the cart's tests partner lands at 09:42.
        landByItself("tCartTests", "09:42");
      }
      if (STATE === "landing") {
        ui.selected = ui.selected || "t3ds";
        if (ov.root) drawCard();
        drawSidebar(false);
        setTimeout(function () {
          var btn = els.list.querySelector('[data-answer="t3ds"]');
          if (btn) btn.classList.add("is-pressed");
          setTimeout(function () {
            ui.answered.t3ds = { at: clock(ui.now), label: "Allow once" };
            refresh({ act: true });
            tellOffice("clear", "t3ds");
            showToast("Cleared WS·3DS: Allow once. Back in the air.", function () {
              delete ui.answered.t3ds;
              refresh({ act: true });
            }, true);
          }, 260);
        }, 700);
      }
      if (STATE === "everyday") {
        // A live morning: the cart's tests partner lands a little while after someone starts
        // looking around. It waits for a real pointer, so a capture of the page stays at 09:41.
        document.addEventListener("pointermove", function () {
          setTimeout(function () { landByItself("tCartTests", "09:42"); }, 12000);
        }, { once: true });
      }
    },
  });
})();
