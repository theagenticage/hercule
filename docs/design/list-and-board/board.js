// PROTOTYPE - the Kanban of the List and Kanban round: window.LBViews.board.
//
// The window (desktop.html) mounts it into its main pane; board.html mounts it alone. The board only
// draws cards and reports clicks: the window owns the find bar, the lenses, the selection and the
// peek panel. Every column, phase, line, progress and roll-up comes from shared/digest.js, so the
// board and the List can never disagree.
//
// Load it after heavy-world.js and digest.js. It calls window.Crew (crew.js) when it mounts, so
// crew.js only has to be loaded by then.
//
//   var handle = LBViews.board.mount(container, {
//     sessions, now, variant: "state" | "phase", swimlanes: false | "project", selected,
//     onSelect(id), onOpen(id),
//     // optional, beyond BUILDERS.md:
//     partners: "fold" | "cards",   // default "fold"
//     runs, doneToday,              // the run steps and Done today the filter kept; see readExtras
//   });
//   handle.update(sessions[, { runs, doneToday }]); handle.select(id); handle.setVariant(v);
//   handle.setSwimlanes(v); handle.setPartners(v); handle.dispose();
//
// How it behaves:
//   - A partner folds into its lead's card ("+2") while both sit in the same column. A partner in
//     another column keeps its own card there, so every column's count is the number of threads in
//     it and agrees with the List and the top bar. setPartners("cards") draws every partner as its
//     own card.
//   - Resting and Done today fold to one line each ("Show all", with a face stack), stacked in one
//     narrow column at the right: the shelf. A folded column opens into its own column on a click.
//   - A column the filter emptied shrinks to its header; a filtered column ends with "25 hidden".
//   - Nothing moves under the pointer: an update that arrives while the pointer is over the board
//     waits until it leaves. Then cards slide to their new places, and a card that changed column
//     shows why for a few seconds (its phaseBasis, in faint ink).
//   - Keys: arrows walk cards and columns (while the board has focus, or while nothing on the page
//     has), space peeks (onSelect), return opens (onOpen). Once a card is peeked, the peek follows
//     the arrows. The board stops the keys it handles, so the window's own handler does not see them.
(function () {
  "use strict";

  var D = window.Digest;
  var H = window.HEAVY;

  var NOTE_MS = 12000;
  var SLIDE_MS = 760;
  var SHIFT_MS = 320;
  var EASE = "cubic-bezier(0.22, 0.7, 0.18, 1)";
  var HAIRLINE = "inset 0 0 0 1px var(--line-soft)";
  var FOLD_FROM = 4;

  /* ------------------------------------------------------------------ the two boards */

  // Returns a By phase column, labelled from Digest.PHASES.
  function buildPhaseColumn(id, size) {
    var p = D.PHASES.filter(function (x) { return x.id === id; })[0];
    return { id: id, label: p.label, hint: p.hint, grow: size.grow, min: size.min, max: size.max, fold: size.fold };
  }

  // The columns of each board, left to right. `grow`, `min` and `max` size a column in pixels;
  // `fold` marks a column that folds to one line until it is clicked open (Resting, and Done today,
  // which is finished work); `oneLine` draws its cards without a second line.
  var BOARDS = {
    state: [
      { id: "needs-you", label: "Needs you", grow: 0.9, min: 232, max: 340 },
      { id: "working", label: "Working", grow: 1.3, min: 256, max: 500 },
      { id: "to-review", label: "To review", hint: "turns that ended after you last looked", grow: 1, min: 232, max: 420 },
      { id: "resting", label: "Resting", grow: 1, min: 232, max: 420, fold: true },
      { id: "done", label: "Done today", grow: 0.8, min: 216, max: 340, fold: true, oneLine: true },
    ],
    phase: [
      buildPhaseColumn("waiting", { grow: 0.75, min: 190, max: 230 }),
      buildPhaseColumn("exploring", { grow: 1, min: 192, max: 420 }),
      buildPhaseColumn("changing", { grow: 1, min: 192, max: 420 }),
      buildPhaseColumn("verifying", { grow: 1, min: 192, max: 420 }),
      buildPhaseColumn("shipping", { grow: 1, min: 192, max: 420 }),
      buildPhaseColumn("resting", { grow: 1, min: 192, max: 420, fold: true }),
    ],
  };

  // Where each board keeps its folded columns. By state stacks them on a 184px shelf, with a line
  // each. By phase needs the room for its four phases, so Resting folds into a 52px rail: its count
  // and a vertical stack of faces. Both open into a full column on a click.
  var FOLDS_INTO = { state: "shelf", phase: "rail" };

  // Live columns are queues, oldest first, so a newcomer joins at the bottom and nothing above it
  // shifts. Resting and Done today are archives, newest first.
  var NEWEST_FIRST = { resting: true, done: true };

  /* ------------------------------------------------------------------ small helpers */

  // Returns text made safe to place inside HTML markup and attribute values.
  function escapeHtml(text) {
    return String(text == null ? "" : text).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function capitalize(text) {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
  }

  // Formats a number of minutes as the board's headers say it: "8m", "1h 05m", "2d".
  function formatMinutes(m) {
    m = Math.round(m);
    if (m < 1) return "under 1m";
    if (m < 60) return m + "m";
    if (m < 1440) return Math.floor(m / 60) + "h " + (m % 60 < 10 ? "0" : "") + (m % 60) + "m";
    return Math.floor(m / 1440) + "d";
  }

  // Returns the median of a list of numbers, or null for an empty list.
  function computeMedian(values) {
    if (!values.length) return null;
    var v = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  }

  // Returns the CSS class and label of a project's tinted diamond.
  function readProjectMark(projectId) {
    if (!projectId) return { cls: "proj proj--none", name: "No project" };
    var p = H.projects.filter(function (x) { return x.id === projectId; })[0];
    return { cls: "proj proj--" + (p ? p.tint : "none"), name: p ? p.name : projectId };
  }

  var PROJECT_ORDER = H.projects.map(function (p) { return p.id; }).concat([null]);

  // Returns the pose a session's face takes. A queued session is not working yet, so it looks idle.
  function decideFacePose(s) {
    return s.digest.phase === "queued" ? "idle" : s.pose;
  }

  /* ------------------------------------------------------------------ cards */

  /*
   * Returns the column a session sits in on a board:
   *   state  Digest.stateColumn (needs-you, working, to-review, resting)
   *   phase  Digest.phaseOf, with queued sessions in Exploring, as digest.js says
   */
  function decideColumn(s, variant, now) {
    if (variant === "state") return D.stateColumn(s, now);
    var phase = D.phaseOf(s);
    return phase === "queued" ? "exploring" : phase;
  }

  /*
   * Returns how long a session has sat in its column, in minutes, and the card's time label:
   *   waiting           since it asked (its last activity)
   *   working, phases   since its turn started ("time in column" is the turn's time: the digest has
   *                     no phase start); a queued session counts from when it was queued
   *   to review, resting since its turn ended
   */
  function measureTimeInColumn(s, col, now) {
    var nowM = D.minutes(now);
    if (col === "needs-you" || col === "waiting" || col === "to-review" || col === "resting") {
      return { mins: nowM - D.minutes(s.last), label: D.ago(s.last, now) };
    }
    var from = s.digest.turnStartedAt || s.last;
    return { mins: nowM - D.minutes(from), label: D.elapsed(from, now) || D.ago(from, now) };
  }

  function buildSessionCard(s, variant, now) {
    var col = decideColumn(s, variant, now);
    var t = measureTimeInColumn(s, col, now);
    return {
      id: s.id,
      kind: "session",
      col: col,
      title: s.title,
      project: s.project,
      pose: decideFacePose(s),
      line: D.line(s),
      why: s.digest.phaseBasis,
      mins: t.mins,
      time: t.label,
      following: s.following,
      lead: s.lead,
      role: s.role,
      partners: [],
      session: s,
    };
  }

  // A run step that waits on Rogier sits in Needs you beside the threads, so the column's count is
  // every waiting count's (threads and the run step). Clicking it reports the run's id.
  function buildRunCard(run, variant, now) {
    var since = run.waiting.since;
    return {
      id: run.id,
      kind: "run",
      col: variant === "state" ? "needs-you" : "waiting",
      title: run.title,
      project: run.project,
      pose: "waiting",
      line: { text: run.waiting.askShort || run.waiting.ask, tone: "you", kind: "ask" },
      why: "run step " + run.waiting.step + " asked at " + since,
      mins: D.minutes(now) - D.minutes(since),
      time: D.ago(since, now),
      following: false,
      lead: null,
      partners: [],
    };
  }

  function buildDoneCard(d, now) {
    return {
      id: d.id,
      kind: "done",
      col: "done",
      title: d.title,
      project: d.project,
      pose: "done",
      line: null,
      why: "",
      mins: D.minutes(now) - D.minutes(d.doneAt),
      time: d.doneAt,
      following: false,
      lead: d.lead,
      role: d.role,
      partners: [],
    };
  }

  /*
   * Returns the run steps and Done today entries to draw. The window may pass the ones its filter
   * kept (api.runs, api.doneToday). When it does not, the board draws the heavy world's while the
   * board is unfiltered, and counts them as hidden once a filter is on, because it cannot match a
   * run or a Done entry against the window's query itself.
   */
  function readExtras(given, filtered) {
    var runs = given && given.runs ? given.runs : filtered ? [] : H.runs;
    var done = given && given.doneToday ? given.doneToday : filtered ? [] : H.doneToday;
    return {
      runs: runs.filter(function (r) { return r.waiting; }),
      doneToday: done,
    };
  }

  function buildCards(sessions, extras, variant, now) {
    var cards = sessions.map(function (s) { return buildSessionCard(s, variant, now); });
    extras.runs.forEach(function (r) { cards.push(buildRunCard(r, variant, now)); });
    if (variant === "state") extras.doneToday.forEach(function (d) { cards.push(buildDoneCard(d, now)); });
    return cards;
  }

  // Folds each partner into its lead's card when both sit in the same column. Returns the cards
  // left to draw; a folded partner is in its lead's `partners`.
  function foldPartners(cards) {
    var byId = {};
    cards.forEach(function (c) { byId[c.id] = c; });
    return cards.filter(function (c) {
      var lead = c.lead && byId[c.lead];
      if (lead && !lead.lead && lead.col === c.col) {
        lead.partners.push(c);
        return false;
      }
      return true;
    });
  }

  function sortCards(cards, col) {
    var newest = NEWEST_FIRST[col];
    return cards.slice().sort(function (a, b) {
      return (newest ? a.mins - b.mins : b.mins - a.mins) || (a.title < b.title ? -1 : 1);
    });
  }

  // Returns the cards of one column grouped by project, in the world's project order.
  function groupByProject(cards) {
    return PROJECT_ORDER.map(function (p) {
      return { project: p, cards: cards.filter(function (c) { return (c.project || null) === p; }) };
    }).filter(function (g) { return g.cards.length; });
  }

  /*
   * Returns everything one draw needs, from the sessions alone:
   *   columns  the board's columns, each with its drawn cards, its thread count (folded partners
   *            included), the median time in column, and how many threads the filter hides there
   */
  function layOut(state) {
    var all = H.sessions;
    var filtered = state.sessions.length < all.length;
    var extras = readExtras(state.extras, filtered);
    var cards = buildCards(state.sessions, extras, state.variant, state.now);

    // What the unfiltered world puts in each column, to count what the filter hides.
    var hidden = {};
    if (filtered) {
      var shown = {};
      cards.forEach(function (c) { shown[c.id] = true; });
      var everything = buildCards(all, readExtras({ runs: H.runs, doneToday: H.doneToday }, false), state.variant, state.now);
      everything.forEach(function (c) {
        if (!shown[c.id]) hidden[c.col] = (hidden[c.col] || 0) + 1;
      });
    }

    var drawn = state.partners === "cards" ? cards : foldPartners(cards);
    var columns = BOARDS[state.variant].map(function (def) {
      var inCol = cards.filter(function (c) { return c.col === def.id; });
      var mid = def.id === "done" ? null : computeMedian(inCol.map(function (c) { return c.mins; }));
      return {
        def: def,
        count: inCol.length,
        median: mid,
        hidden: hidden[def.id] || 0,
        cards: sortCards(drawn.filter(function (c) { return c.col === def.id; }), def.id),
        members: inCol,
      };
    });
    return { columns: columns, filtered: filtered, cards: cards };
  }

  /* ------------------------------------------------------------------ drawing */

  function drawFace(name, pose, size) {
    return window.Crew.face(name, { pose: pose, size: size });
  }

  function drawIcon(name, size) {
    return window.Crew.icon(name, size);
  }

  function describePartners(card) {
    var roles = card.partners.map(function (p) { return p.role || p.title; });
    return card.partners.length + (card.partners.length === 1 ? " partner: " : " partners: ") + roles.join(", ");
  }

  /*
   * Returns one card's markup: face, title, time at the right, then one muted line (marigold only for
   * an ask) and the folded partners' "+2". In the By phase board the line can swap, on hover, for
   * the reason the card sits there.
   */
  function drawCard(card, ci, ctx) {
    var def = ctx.def;
    var oneLine = def.oneLine || !card.line;
    var cls = "lbb-card" + (oneLine ? " is-one" : "") + (card.id === ctx.selected ? " is-on" : "") + (ctx.notes[card.id] ? " is-noted" : "");
    var showWhy = ctx.variant === "phase" && !def.fold && def.id !== "waiting";
    var why = ctx.notes[card.id] || (showWhy ? card.why : "");
    var follow = card.following ? '<span class="lbb-follow" title="You follow this thread">' + drawIcon("eye", 12) + "</span>" : "";
    var more = card.partners.length
      ? '<span class="lbb-more" title="' + escapeHtml(describePartners(card)) + '">+' + card.partners.length + "</span>"
      : "";
    var sub = "";
    if (!oneLine) {
      sub =
        '<span class="lbb-sub">' +
        '<span class="lbb-line' + (card.line.tone === "you" ? " is-you" : "") + '">' + escapeHtml(card.line.text) + "</span>" +
        (why ? '<span class="lbb-why">' + escapeHtml(capitalize(why)) + "</span>" : "") +
        "</span>";
    }
    return (
      '<div class="' + cls + (why && !ctx.notes[card.id] ? " has-why" : "") + '" data-card="' + escapeHtml(card.id) + '" data-col="' + def.id + '" data-ci="' + ci + '" data-nav tabindex="-1" title="' + escapeHtml(card.title) + '">' +
      '<span class="lbb-face">' + drawFace(card.title, card.pose, 20) + "</span>" +
      '<span class="lbb-title">' + escapeHtml(card.title) + "</span>" +
      '<span class="lbb-time">' + follow + escapeHtml(card.time) + "</span>" +
      sub +
      more +
      "</div>"
    );
  }

  function drawGroupHead(project) {
    var p = readProjectMark(project);
    return '<div class="lbb-group"><span class="' + p.cls + '">' + escapeHtml(p.name) + "</span></div>";
  }

  /*
   * Returns the folded line of a column or a lane's cell: a stack of up to five faces, then the
   * label ("Show all", "6 resting"). Sessions are picked by Digest.rollup (the most urgent first);
   * Done today shows its newest.
   */
  function drawFold(members, key, ci, label) {
    var stack = drawFoldFaces(members);
    return (
      '<button class="lbb-fold" type="button" data-fold="' + escapeHtml(key) + '" data-nav data-ci="' + ci + '" tabindex="-1">' +
      '<span class="stack">' + stack + "</span>" +
      '<span class="lbb-fold-label">' + escapeHtml(label) + "</span>" +
      drawIcon("chev-d", 13) +
      "</button>"
    );
  }

  // Returns up to five faces for a folded column. Sessions are picked by Digest.rollup (the most
  // urgent first); Done today shows its newest.
  function drawFoldFaces(members) {
    var sessions = members.filter(function (c) { return c.kind === "session"; }).map(function (c) { return c.session; });
    var byId = {};
    sessions.forEach(function (s) { byId[s.id] = s; });
    var picked = sessions.length
      ? D.rollup(sessions).faces.map(function (id) { return { title: byId[id].title, pose: decideFacePose(byId[id]) }; })
      : sortCards(members, "done").slice(0, 5);
    return picked.map(function (c) { return drawFace(c.title, c.pose, 20); }).join("");
  }

  /*
   * Returns a folded column as a 52px rail, the button that opens it: a vertical stack of faces and,
   * on the board (`label`), the column's name in faint vertical type. A lane's rail (`count`) shows
   * its own count above the faces instead, since the rail's heading carries the board's.
   */
  function drawRail(members, key, ci, opts) {
    var name = opts.def.label + ", " + members.length + ". Show all";
    return (
      '<button class="lbb-rail" type="button" data-fold="' + escapeHtml(key) + '" data-nav data-ci="' + ci + '" tabindex="-1" title="' + escapeHtml(name) + '" aria-label="' + escapeHtml(name) + '">' +
      (opts.count ? '<span class="lbb-rail-count">' + members.length + "</span>" : "") +
      '<span class="lbb-rail-stack">' + drawFoldFaces(members) + "</span>" +
      (opts.label ? '<span class="lbb-rail-name">' + escapeHtml(opts.def.label) + "</span>" : "") +
      "</button>"
    );
  }

  // Returns the rail's heading: the folded column's count, centred, named by its title.
  function drawRailHead(col) {
    return '<header class="lbb-head lbb-head--rail"><span class="lbb-count" title="' + escapeHtml(col.def.label) + '">' + col.count + "</span></header>";
  }

  function drawHidden(n) {
    return n ? '<p class="lbb-hidden">' + n + " hidden</p>" : "";
  }

  // Checks whether a folding column is open: on the board, or with lanes, in any lane.
  function isUnfolded(def, ctx) {
    if (!ctx.lanes) return !!ctx.unfolded[def.id];
    return Object.keys(ctx.unfolded).some(function (k) { return ctx.unfolded[k] && k.indexOf(def.id + "|") === 0; });
  }

  // Checks whether a column folds: Resting and Done today do once they hold FOLD_FROM threads or
  // more, since folding two cards into a line saves nothing. With lanes they always fold, so every
  // lane's cell reads the same.
  function isFoldable(col, ctx) {
    return col.def.fold && col.count > 0 && (ctx.lanes || col.count >= FOLD_FROM);
  }

  function isOnShelf(col, ctx) {
    return isFoldable(col, ctx) && !isUnfolded(col.def, ctx);
  }

  /*
   * Returns the board's slots, left to right. A slot is one column, or the shelf: every folded
   * column (Resting, Done today) stacked in one narrow column where the first of them stands, so
   * two folded lines cost one column's width. On By phase the shelf is a rail (FOLDS_INTO). A
   * folded column leaves the shelf when it is opened.
   */
  function buildSlots(columns, ctx) {
    var slots = [];
    var shelf = null;
    columns.forEach(function (col) {
      if (!isOnShelf(col, ctx)) return slots.push({ shelf: false, cols: [col] });
      if (!shelf) {
        shelf = { shelf: true, rail: FOLDS_INTO[ctx.variant] === "rail", cols: [] };
        slots.push(shelf);
      }
      shelf.cols.push(col);
    });
    return slots;
  }

  // Returns the flex sizing of a slot, the same in the header row and in every lane.
  function sizeSlot(slot) {
    var def = slot.cols[0].def;
    if (slot.shelf) return { cls: slot.rail ? " is-rail" : " is-folded", style: "" };
    if (!slot.cols[0].count) return { cls: " is-empty", style: "" };
    return { cls: "", style: ' style="--grow:' + def.grow + ";--min:" + def.min + "px;--max:" + def.max + 'px"' };
  }

  // Returns a column's name and count; a folding column's name is the button that opens or folds it.
  function drawNameAndCount(col, ctx) {
    var def = col.def;
    var open = isUnfolded(def, ctx);
    if (!isFoldable(col, ctx)) {
      return '<h3 class="lbb-name"' + (def.hint ? ' title="' + escapeHtml(capitalize(def.hint)) + '"' : "") + ">" + escapeHtml(def.label) + "</h3>" + '<span class="lbb-count">' + col.count + "</span>";
    }
    return (
      '<button class="lbb-name lbb-name--fold" type="button" data-fold="' + def.id + '" aria-expanded="' + open + '" title="' + (open ? "Fold" : "Show all") + '">' +
      escapeHtml(def.label) + '<span class="lbb-count">' + col.count + "</span>" + (open ? drawIcon("chev-d", 12) : "") +
      "</button>"
    );
  }

  // Returns a column's heading: name, count and, in faint ink, the median time in the column.
  function drawHead(col, ctx) {
    var median = col.count && col.median != null ? '<span class="lbb-median" title="Median time in this column">median ' + formatMinutes(col.median) + "</span>" : "";
    return '<header class="lbb-head">' + drawNameAndCount(col, ctx) + median + "</header>";
  }

  function drawColumnCards(col, cards, ci, ctx, grouped) {
    var opts = { def: col.def, variant: ctx.variant, selected: ctx.selected, notes: ctx.notes };
    function draw(c) { return drawCard(c, ci, opts); }
    if (!grouped) return cards.map(draw).join("");
    return groupByProject(cards)
      .map(function (g) { return drawGroupHead(g.project) + g.cards.map(draw).join(""); })
      .join("");
  }

  function drawColumns(layout, ctx) {
    return (
      '<div class="lbb-cols">' +
      buildSlots(layout.columns, ctx)
        .map(function (slot, ci) {
          var size = sizeSlot(slot);
          var body;
          if (slot.rail) {
            var railCol = slot.cols[0];
            body = drawRail(railCol.members, railCol.def.id, ci, { def: railCol.def, label: true });
            var hiddenNote = railCol.hidden ? '<p class="lbb-hidden lbb-hidden--rail">' + railCol.hidden + "<br>hidden</p>" : "";
            return '<section class="lbb-col lbb-shelf' + size.cls + '">' + drawRailHead(railCol) + '<div class="lbb-body" data-scroll="shelf">' + body + hiddenNote + "</div></section>";
          }
          if (slot.shelf) {
            body = slot.cols
              .map(function (col) {
                return '<div class="lbb-shelf-item">' + drawHead(col, ctx) + drawFold(col.members, col.def.id, ci, "Show all") + drawHidden(col.hidden) + "</div>";
              })
              .join("");
            return '<section class="lbb-col lbb-shelf' + size.cls + '">' + '<div class="lbb-body" data-scroll="shelf">' + body + "</div></section>";
          }
          var col = slot.cols[0];
          return (
            '<section class="lbb-col' + size.cls + '" data-colid="' + col.def.id + '"' + size.style + ">" +
            drawHead(col, ctx) +
            '<div class="lbb-body" data-scroll="' + col.def.id + '">' + drawColumnCards(col, col.cards, ci, ctx, true) + drawHidden(col.hidden) + "</div>" +
            "</section>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  // Returns the shelf's heading with lanes: each folded column's name and count, on one line.
  function drawShelfHead(slot, ctx) {
    return (
      '<header class="lbb-head lbb-head--shelf">' +
      slot.cols.map(function (col) { return '<span class="lbb-shelf-name">' + drawNameAndCount(col, ctx) + "</span>"; }).join("") +
      "</header>"
    );
  }

  /*
   * Draws the board with swimlanes: one sticky header row with every column's count, then one lane
   * per project, each opening with its roll-up line ("14 working · 1 needs you · 6 resting").
   */
  function drawLanes(layout, ctx) {
    var slots = buildSlots(layout.columns, ctx);
    var head =
      '<div class="lbb-lanes-head">' +
      slots
        .map(function (slot) {
          var size = sizeSlot(slot);
          var head = slot.rail ? drawRailHead(slot.cols[0]) : slot.shelf ? drawShelfHead(slot, ctx) : drawHead(slot.cols[0], ctx);
          return '<div class="lbb-col' + size.cls + '"' + size.style + ">" + head + "</div>";
        })
        .join("") +
      "</div>";

    var lanes = PROJECT_ORDER.map(function (project) {
      var inLane = function (c) { return (c.project || null) === project; };
      var members = layout.cards.filter(inLane);
      if (!members.length) return "";
      var sessions = members.filter(function (c) { return c.kind === "session"; }).map(function (c) { return c.session; });
      var roll = D.rollup(sessions);
      roll.waiting += members.filter(function (c) { return c.kind === "run"; }).length;
      var p = readProjectMark(project);
      var cells = slots
        .map(function (slot, ci) {
          var size = sizeSlot(slot);
          var body = slot.cols
            .map(function (col) {
              var key = col.def.id + "|" + (project || "none");
              if (col.def.fold && !ctx.unfolded[key]) {
                var cellMembers = col.members.filter(inLane);
                if (!cellMembers.length) return "";
                if (slot.rail) return drawRail(cellMembers, key, ci, { def: col.def, count: true });
                return drawFold(cellMembers, key, ci, cellMembers.length + " " + (col.def.id === "done" ? "done" : "resting"));
              }
              return drawColumnCards(col, col.cards.filter(inLane), ci, ctx, false);
            })
            .join("");
          return '<div class="lbb-cell' + size.cls + '"' + size.style + ">" + body + "</div>";
        })
        .join("");
      return (
        '<section class="lbb-lane">' +
        '<header class="lbb-lane-h"><span class="' + p.cls + '">' + escapeHtml(p.name) + '</span><span class="lbb-roll">' + escapeHtml(D.rollupText(roll)) + "</span></header>" +
        '<div class="lbb-lane-row">' + cells + "</div>" +
        "</section>"
      );
    }).join("");

    var hiddenTotal = layout.columns.reduce(function (n, c) { return n + c.hidden; }, 0);
    var foot = hiddenTotal ? '<p class="lbb-hidden lbb-hidden--lanes">' + hiddenTotal + " hidden by the filter</p>" : "";
    return '<div class="lbb-lanes" data-scroll="lanes"><div class="lbb-lanes-in">' + head + lanes + foot + "</div></div>";
  }

  /* ------------------------------------------------------------------ motion */

  // Records where every card is, so the next draw can slide cards from there.
  function measureCards(root) {
    var at = {};
    root.querySelectorAll("[data-card]").forEach(function (el) {
      at[el.dataset.card] = { rect: el.getBoundingClientRect(), col: el.dataset.col, ghost: el.cloneNode(true) };
    });
    return at;
  }

  function placeGhost(root, before) {
    var base = root.getBoundingClientRect();
    var g = before.ghost;
    g.classList.add("lbb-ghost");
    g.classList.remove("is-on");
    g.removeAttribute("data-card");
    g.removeAttribute("data-nav");
    g.style.left = before.rect.left - base.left + "px";
    g.style.top = before.rect.top - base.top + "px";
    g.style.width = before.rect.width + "px";
    g.style.height = before.rect.height + "px";
    root.appendChild(g);
    return g;
  }

  /*
   * Moves cards from where they were to where they are now:
   *   - a card that changed column slides across as a lifted copy, and the card itself appears
   *     when the copy lands;
   *   - a card that shifted within its column glides into place;
   *   - a new card fades in, a card that left fades out where it was.
   */
  function animateChanges(root, before) {
    if (!root.animate) return;
    var seen = {};
    root.querySelectorAll("[data-card]").forEach(function (el) {
      var id = el.dataset.card;
      seen[id] = true;
      var was = before[id];
      var now = el.getBoundingClientRect();
      if (!was) {
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: "ease-out" });
        return;
      }
      var dx = was.rect.left - now.left;
      var dy = was.rect.top - now.top;
      if (was.col !== el.dataset.col) {
        var ghost = placeGhost(root, was);
        el.style.visibility = "hidden";
        var slide = ghost.animate(
          [
            { transform: "translate(0, 0)", width: was.rect.width + "px", boxShadow: HAIRLINE },
            { transform: "translate(" + -dx * 0.5 + "px, " + (-dy * 0.5 - 6) + "px)", boxShadow: HAIRLINE + ", var(--shadow-2)", offset: 0.5 },
            { transform: "translate(" + -dx + "px, " + -dy + "px)", width: now.width + "px", boxShadow: HAIRLINE },
          ],
          { duration: SLIDE_MS, easing: EASE, fill: "forwards" },
        );
        slide.onfinish = function () {
          ghost.remove();
          el.style.visibility = "";
        };
        return;
      }
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        el.animate([{ transform: "translate(" + dx + "px, " + dy + "px)" }, { transform: "none" }], { duration: SHIFT_MS, easing: EASE });
      }
    });
    Object.keys(before).forEach(function (id) {
      if (seen[id]) return;
      var ghost = placeGhost(root, before[id]);
      var fade = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: "ease-out", fill: "forwards" });
      fade.onfinish = function () { ghost.remove(); };
    });
  }

  /* ------------------------------------------------------------------ keys */

  function listNavItems(root) {
    return Array.prototype.slice.call(root.querySelectorAll("[data-nav]"));
  }

  function centerY(el) {
    var r = el.getBoundingClientRect();
    return r.top + r.height / 2;
  }

  /*
   * Returns the item an arrow key moves to from `from`: up and down walk the column, left and right
   * jump to the nearest item, by height, in the next column that has one.
   */
  function findNeighbour(items, from, key) {
    var ci = Number(from.dataset.ci);
    if (key === "ArrowUp" || key === "ArrowDown") {
      var col = items.filter(function (el) { return Number(el.dataset.ci) === ci; });
      var i = col.indexOf(from) + (key === "ArrowDown" ? 1 : -1);
      return col[i] || null;
    }
    var step = key === "ArrowRight" ? 1 : -1;
    var cis = items.map(function (el) { return Number(el.dataset.ci); });
    var maxCi = Math.max.apply(null, cis);
    for (var c = ci + step; c >= 0 && c <= maxCi; c += step) {
      var next = items.filter(function (el) { return Number(el.dataset.ci) === c; });
      if (!next.length) continue;
      var y = centerY(from);
      return next.reduce(function (best, el) { return Math.abs(centerY(el) - y) < Math.abs(centerY(best) - y) ? el : best; });
    }
    return null;
  }

  /*
   * Scrolls the board so `el` is in view: its column (or the lanes) up and down, the board left and
   * right. It never calls scrollIntoView, which would also scroll a design book that frames the page.
   */
  function revealCard(el) {
    var box = el.closest("[data-scroll]");
    var r = el.getBoundingClientRect();
    if (box) {
      var b = box.getBoundingClientRect();
      var head = box.querySelector(".lbb-lanes-head");
      var top = b.top + (head ? head.getBoundingClientRect().height : 0) + 8;
      if (r.top < top) box.scrollTop -= top - r.top;
      else if (r.bottom > b.bottom - 8) box.scrollTop += r.bottom - b.bottom + 8;
    }
    // Left and right, the whole column comes into view, clear of the faded edges.
    var across = el.closest(".lbb-cols, .lbb-lanes");
    var col = el.closest(".lbb-col, .lbb-cell") || el;
    if (across) {
      var a = across.getBoundingClientRect();
      var c = col.getBoundingClientRect();
      if (c.right > a.right - 72) across.scrollLeft += c.right - a.right + 72;
      else if (c.left < a.left + 48) across.scrollLeft -= a.left + 48 - c.left;
    }
  }

  // Marks the board when its columns run past its left or right edge, so CSS can fade that edge.
  function markClippedEdges(root) {
    var across = root.querySelector(".lbb-cols, .lbb-lanes");
    var left = !!across && across.scrollLeft > 1;
    var right = !!across && across.scrollLeft + across.clientWidth < across.scrollWidth - 1;
    root.classList.toggle("is-clipped-left", left);
    root.classList.toggle("is-clipped-right", right);
  }

  /* ------------------------------------------------------------------ the module */

  function mount(container, api) {
    var state = {
      sessions: api.sessions || H.sessions,
      extras: api.runs || api.doneToday ? { runs: api.runs, doneToday: api.doneToday } : null,
      now: api.now || H.now,
      variant: api.variant === "phase" ? "phase" : "state",
      lanes: api.swimlanes === "project",
      partners: api.partners === "cards" ? "cards" : "fold",
      selected: api.selected || null,
      unfolded: {},
      notes: {},
      columnOf: {},
    };
    var pointerInside = false;
    var pending = null;
    var noteTimers = [];

    var root = document.createElement("div");
    root.className = "lb-board";
    root.tabIndex = 0;
    root.setAttribute("aria-label", "Kanban");
    container.appendChild(root);

    function rememberScroll() {
      var at = {};
      root.querySelectorAll("[data-scroll]").forEach(function (el) { at[el.dataset.scroll] = [el.scrollTop, el.scrollLeft]; });
      var cols = root.querySelector(".lbb-cols");
      if (cols) at._cols = [cols.scrollTop, cols.scrollLeft];
      return at;
    }

    function restoreScroll(at) {
      root.querySelectorAll("[data-scroll]").forEach(function (el) {
        var v = at[el.dataset.scroll];
        if (v) { el.scrollTop = v[0]; el.scrollLeft = v[1]; }
      });
      var cols = root.querySelector(".lbb-cols");
      if (cols && at._cols) cols.scrollLeft = at._cols[1];
    }

    // Returns what has the keyboard focus inside the board, so a redraw can give it back.
    function readFocus() {
      var el = document.activeElement;
      if (!el || el === root || !root.contains(el)) return null;
      return { card: el.dataset.card, fold: el.dataset.fold, ci: el.dataset.ci };
    }

    function restoreFocus(was) {
      if (!was) return;
      var el =
        (was.card && root.querySelector('[data-card="' + was.card + '"]')) ||
        (was.fold && root.querySelector('[data-fold="' + was.fold + '"][data-nav]')) ||
        root.querySelector('[data-nav][data-ci="' + was.ci + '"]');
      (el || root).focus({ preventScroll: true });
    }

    function draw(animate) {
      var focused = readFocus();
      var before = animate ? measureCards(root) : null;
      var scroll = rememberScroll();
      var layout = layOut(state);
      var ctx = {
        variant: state.variant,
        lanes: state.lanes,
        selected: state.selected,
        notes: state.notes,
        unfolded: state.unfolded,
      };
      root.dataset.variant = state.variant;
      root.dataset.lanes = state.lanes ? "project" : "off";
      root.innerHTML = state.lanes ? drawLanes(layout, ctx) : drawColumns(layout, ctx);
      restoreScroll(scroll);
      markSelected();
      markClippedEdges(root);
      restoreFocus(focused);
      if (before) animateChanges(root, before);
      state.columnOf = {};
      layout.cards.forEach(function (c) { state.columnOf[c.id] = c.col; });
    }

    // Returns the card element that stands for `id`: its own card, or its lead's when it is folded.
    function findCardFor(id) {
      if (!id) return null;
      var own = root.querySelector('[data-card="' + id + '"]');
      if (own) return own;
      var s = H.session(id);
      return s && s.lead ? root.querySelector('[data-card="' + s.lead + '"]') : null;
    }

    function markSelected() {
      root.querySelectorAll(".lbb-card.is-on").forEach(function (el) { el.classList.remove("is-on"); });
      var el = findCardFor(state.selected);
      if (el) el.classList.add("is-on");
    }

    // Gives every card that changed column a note saying why, for a few seconds.
    function noteMoves(nextSessions) {
      nextSessions.forEach(function (s) {
        var was = state.columnOf[s.id];
        var col = decideColumn(s, state.variant, state.now);
        if (was && was !== col && s.digest.phaseBasis) {
          state.notes[s.id] = s.digest.phaseBasis;
          noteTimers.push(
            setTimeout(function () {
              delete state.notes[s.id];
              var el = root.querySelector('[data-card="' + s.id + '"]');
              if (el) el.classList.remove("is-noted");
            }, NOTE_MS),
          );
        }
      });
    }

    function applyUpdate(sessions, extras) {
      noteMoves(sessions);
      state.sessions = sessions;
      if (extras) state.extras = extras;
      draw(true);
    }

    function select(id) {
      if (state.selected === id) return;
      state.selected = id || null;
      markSelected();
    }

    function peek(el) {
      var id = el.dataset.card;
      state.selected = id;
      markSelected();
      if (api.onSelect) api.onSelect(id);
    }

    // Opens or folds a column ("resting") or, with lanes, one lane's cell ("resting|webshop"). A
    // column's heading with lanes opens or folds it in every lane at once.
    function toggleFold(key) {
      if (state.lanes && key.indexOf("|") < 0) {
        var open = !Object.keys(state.unfolded).some(function (k) { return state.unfolded[k] && k.indexOf(key + "|") === 0; });
        PROJECT_ORDER.forEach(function (p) { state.unfolded[key + "|" + (p || "none")] = open; });
      } else {
        state.unfolded[key] = !state.unfolded[key];
      }
      draw(false);
    }

    function onClick(e) {
      var fold = e.target.closest("[data-fold]");
      if (fold && root.contains(fold)) return toggleFold(fold.dataset.fold);
      var card = e.target.closest("[data-card]");
      if (card && root.contains(card)) peek(card);
    }

    function onDblClick(e) {
      var card = e.target.closest("[data-card]");
      if (card && root.contains(card) && api.onOpen) api.onOpen(card.dataset.card);
    }

    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var items = listNavItems(root);
      if (!items.length) return;
      var current = items.indexOf(document.activeElement) >= 0 ? document.activeElement : findCardFor(state.selected) || items[0];
      var key = e.key;
      if (key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        var next = document.activeElement === current ? findNeighbour(items, current, key) : current;
        if (!next) return;
        next.focus({ preventScroll: true });
        revealCard(next);
        if (state.selected && next.dataset.card) peek(next);
      } else if (key === " " || key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (current.dataset.fold) return toggleFold(current.dataset.fold);
        if (key === " ") peek(current);
        else if (api.onOpen) api.onOpen(current.dataset.card);
      }
    }

    // While nothing on the page has focus, an arrow key starts walking the board, so the keys work
    // as soon as the Kanban is on screen. Other keys stay the window's.
    function onPageKey(e) {
      var idle = !document.activeElement || document.activeElement === document.body;
      if (idle && /^Arrow/.test(e.key) && root.offsetParent !== null) onKey(e);
    }

    function onEnter() { pointerInside = true; }
    function onLeave() {
      pointerInside = false;
      if (pending) {
        var p = pending;
        pending = null;
        applyUpdate(p.sessions, p.extras);
      }
    }

    // Scroll events do not bubble, so one capturing listener hears every column and the lanes.
    function onScroll() { markClippedEdges(root); }

    // When the board narrows (the window opens its peek panel), the selected card stays in view.
    var resizes = new ResizeObserver(function () {
      markClippedEdges(root);
      var el = findCardFor(state.selected);
      if (el) revealCard(el);
    });

    root.addEventListener("click", onClick);
    root.addEventListener("dblclick", onDblClick);
    root.addEventListener("keydown", onKey);
    root.addEventListener("pointerenter", onEnter);
    root.addEventListener("pointerleave", onLeave);
    root.addEventListener("scroll", onScroll, true);
    document.addEventListener("keydown", onPageKey);
    resizes.observe(root);

    draw(false);
    if (state.selected && findCardFor(state.selected)) revealCard(findCardFor(state.selected));

    return {
      update: function (sessions, extras) {
        if (pointerInside) {
          pending = { sessions: sessions, extras: extras };
          return;
        }
        applyUpdate(sessions, extras);
      },
      select: select,
      setVariant: function (v) {
        state.variant = v === "phase" ? "phase" : "state";
        state.unfolded = {};
        draw(false);
      },
      setSwimlanes: function (v) {
        state.lanes = v === "project";
        state.unfolded = {};
        draw(false);
      },
      setPartners: function (v) {
        state.partners = v === "cards" ? "cards" : "fold";
        draw(false);
      },
      dispose: function () {
        noteTimers.forEach(clearTimeout);
        root.removeEventListener("click", onClick);
        root.removeEventListener("dblclick", onDblClick);
        root.removeEventListener("keydown", onKey);
        root.removeEventListener("pointerenter", onEnter);
        root.removeEventListener("pointerleave", onLeave);
        root.removeEventListener("scroll", onScroll, true);
        document.removeEventListener("keydown", onPageKey);
        resizes.disconnect();
        root.remove();
      },
    };
  }

  window.LBViews = window.LBViews || {};
  window.LBViews.board = { mount: mount };
})();
