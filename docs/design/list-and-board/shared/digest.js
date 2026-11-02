// PROTOTYPE - window.Digest: the one place that decides what a session's digest means, so the
// List, the Kanban and the peek panel never disagree. Pure functions over the session records in
// heavy-world.js; the rules are the ones ../SIGNALS.md §4 sets for a row's line.
//
// Load it after heavy-world.js.
(function () {
  "use strict";

  var NOW = (window.HEAVY && window.HEAVY.now) || "09:41";

  /* ------------------------------------------------------------------ time */

  // Minutes since midnight on the 29th; "Mon HH:MM" and "Sun HH:MM" are earlier days (negative).
  function minutes(t) {
    if (t == null) return null;
    var m = /^(Mon|Sun|yesterday) (\d\d):(\d\d)$/.exec(t);
    if (m) return (m[1] === "Sun" ? -2 : -1) * 1440 + Number(m[2]) * 60 + Number(m[3]);
    var h = /^(\d\d):(\d\d)$/.exec(t);
    return h ? Number(h[1]) * 60 + Number(h[2]) : null;
  }

  // Returns how long ago `t` was, as the sidebar says it: "now", "12m", "2h", "Mon", "Sun".
  function ago(t, now) {
    var d = minutes(now || NOW) - minutes(t);
    if (d == null || isNaN(d)) return "";
    if (d < 1) return "now";
    if (d < 60) return d + "m";
    if (d < 24 * 60 && /^\d/.test(t)) return Math.floor(d / 60) + "h";
    return t.split(" ")[0];
  }

  // Returns the time between two moments as "12m" or "1h 05m".
  function elapsed(from, now) {
    var d = minutes(now || NOW) - minutes(from);
    if (d == null || isNaN(d) || d < 0) return "";
    if (d < 60) return d + "m";
    var m = d % 60;
    return Math.floor(d / 60) + "h " + (m < 10 ? "0" : "") + m + "m";
  }

  /* ------------------------------------------------------------------ phases */

  // Every phase a digest can hold, in board order. `board` marks the four the By phase board
  // draws as columns; waiting and resting are its side lanes, queued sits with exploring.
  var PHASES = [
    { id: "exploring", label: "Exploring", board: true, hint: "reading and searching, no edit yet" },
    { id: "changing", label: "Changing", board: true, hint: "editing files" },
    { id: "verifying", label: "Verifying", board: true, hint: "running tests, typechecks, lints or builds" },
    { id: "shipping", label: "Shipping", board: true, hint: "committing, pushing, opening a pull request" },
    { id: "waiting", label: "Needs you", board: false, hint: "waiting on your answer" },
    { id: "resting", label: "Resting", board: false, hint: "idle or asleep" },
    { id: "queued", label: "Queued", board: false, hint: "waiting for a free slot on its machine" },
  ];
  var PHASE_LABEL = {};
  PHASES.forEach(function (p) { PHASE_LABEL[p.id] = p.label; });

  // Returns the session's phase id.
  function phaseOf(s) {
    return s.digest.phase;
  }

  /* ------------------------------------------------------------------ place */

  function basename(path) {
    return path ? path.split("/").pop() : "";
  }

  // Returns the folder the session works in ("src/checkout"), or "" when it has no focus.
  function focusLabel(s) {
    return s.digest.focus ? s.digest.focus.path : "";
  }

  // Returns where a session works: its focus folder, its hot file's name, its branch and machine.
  function where(s) {
    var f = s.digest.focus;
    return { focus: f ? f.path : "", file: f ? basename(f.file) : "", branch: s.branch || "", machine: s.machine || "" };
  }

  /* ------------------------------------------------------------------ progress */

  var LADDER = [
    { key: "changed", label: "Changed" },
    { key: "tested", label: "Tested" },
    { key: "passing", label: "Passing" },
    { key: "committed", label: "Committed" },
    { key: "pushed", label: "Pushed" },
    { key: "prOpen", label: "PR open" },
  ];

  /*
   * Returns the milestone ladder in order, each step { key, label, at, state }:
   *   done     it happened at `at`
   *   failed   the latest test run failed (only Passing can fail)
   *   unknown  tests ran but their output had no summary Hercule recognises (only Passing)
   *   todo     not yet
   */
  function milestoneLadder(s) {
    var m = s.digest.milestones;
    return LADDER.map(function (step) {
      var v = m[step.key];
      if (step.key === "passing") {
        if (v === false) return { key: step.key, label: "Failing", at: m.failedAt, state: "failed" };
        if (v === "unknown") return { key: step.key, label: "Outcome unknown", at: null, state: "unknown" };
      }
      if (step.key === "prOpen" && v && m.prNumber) return { key: step.key, label: "PR #" + m.prNumber, at: v, state: "done" };
      return { key: step.key, label: step.label, at: v || null, state: v ? "done" : "todo" };
    });
  }

  /*
   * Returns how far along the session is, from facts only:
   *   { kind: "plan", done, total, label: "4 of 7" }       when it keeps a plan
   *   { kind: "milestones", done, total: 6, label }        else, from what Hercule saw happen;
   *                                                        label names the furthest milestone
   *   { kind: "none", label: "" }                          when nothing happened yet
   */
  function progress(s) {
    var p = s.digest.plan;
    if (p) return { kind: "plan", done: p.done, total: p.total, label: p.done + " of " + p.total };
    var ladder = milestoneLadder(s).filter(function (m) { return m.state === "done"; });
    if (!ladder.length) return { kind: "none", label: "" };
    return { kind: "milestones", done: ladder.length, total: LADDER.length, label: ladder[ladder.length - 1].label };
  }

  /* ------------------------------------------------------------------ the row's line */

  var CHECK_WORDS = {
    test: { passed: "Tests pass", failed: "Tests fail", unknown: "Tests ran" },
    typecheck: { passed: "Typecheck clean", failed: "Typecheck fails", unknown: "Typecheck ran" },
    lint: { passed: "Lint clean", failed: "Lint fails", unknown: "Lint ran" },
    build: { passed: "Build passes", failed: "Build fails", unknown: "Build ran" },
  };

  // Returns the latest check in words ("Tests fail · 1 failed, 3 passed"), or "" when none ran.
  function checkText(s, withCounts) {
    var c = s.digest.lastCheck;
    if (!c) return "";
    var words = CHECK_WORDS[c.class][c.outcome];
    return withCounts && c.counts ? words + " · " + c.counts : words;
  }

  function editedCount(s) {
    var f = s.digest.focus;
    if (!f) return 0;
    return f.files.filter(function (x) { return x.how === "edit"; }).length;
  }

  // Returns the latest reliable outcome of a resting session, or "" when there is none.
  function outcomeText(s) {
    var m = s.digest.milestones;
    if (m.prOpen) return "Pushed · PR" + (m.prNumber ? " #" + m.prNumber : " open");
    var check = checkText(s, false);
    if (m.pushed) return check && s.digest.lastCheck.outcome !== "unknown" ? "Pushed · " + check.toLowerCase() : "Pushed";
    if (m.committed) return check && s.digest.lastCheck.outcome !== "unknown" ? "Committed · " + check.toLowerCase() : "Committed";
    if (check) return check;
    var edited = editedCount(s);
    if (m.changed && edited) return "Changed " + edited + (edited === 1 ? " file" : " files");
    return "";
  }

  /*
   * Returns the row's one muted line, by SIGNALS.md §4; the first rule that applies wins:
   *   1. waiting               the ask                                  tone "you"
   *   2. working with a plan   "4 of 7 · Fixing handlePaymentResult"
   *   3. working, no plan      "Changing · src/checkout", or "Exploring · working 12m"
   *   4. resting               the latest reliable outcome ("Pushed · PR #1281", "Tests ran"),
   *                            else the branch and machine, as today's row
   * A queued session says so. Returns { text, tone: "you" | "muted", kind }.
   */
  function line(s) {
    var d = s.digest;
    if (s.pose === "waiting") return { text: s.askShort || s.ask, tone: "you", kind: "ask" };
    if (d.phase === "queued") return { text: "Queued · waits for a free slot on " + s.machine, tone: "muted", kind: "queued" };
    if (s.pose === "working") {
      if (d.plan) return { text: d.plan.done + " of " + d.plan.total + " · " + (d.plan.current || PHASE_LABEL[d.phase]), tone: "muted", kind: "plan" };
      var focus = focusLabel(s);
      if (focus) return { text: PHASE_LABEL[d.phase] + " · " + focus, tone: "muted", kind: "phase" };
      return { text: PHASE_LABEL[d.phase] + " · working " + elapsed(d.turnStartedAt), tone: "muted", kind: "phase" };
    }
    var outcome = outcomeText(s);
    if (outcome) return { text: outcome, tone: "muted", kind: "outcome" };
    var place = [s.branch && s.branch !== "main" ? s.branch : null, s.machine].filter(Boolean).join(" · ");
    return { text: place, tone: "muted", kind: "where" };
  }

  /* ------------------------------------------------------------------ the By state board */

  /*
   * Returns the By state board's column for a session:
   *   needs-you   it waits on Rogier
   *   working     its agent is busy (or queued)
   *   to-review   idle, and its last turn ended after Rogier last looked (or he never did)
   *   resting     idle or asleep, and Rogier has seen how it ended
   * Done sessions are not live; the board draws HEAVY.doneToday in its Done today column.
   */
  function stateColumn(s, now) {
    if (s.pose === "waiting") return "needs-you";
    if (s.pose === "working") return "working";
    var last = minutes(s.last);
    var seen = minutes(s.lastSeen);
    if (s.pose === "idle" && (seen == null || last > seen)) return "to-review";
    return "resting";
  }

  /* ------------------------------------------------------------------ roll-ups */

  var URGENCY = { waiting: 0, working: 1, idle: 2, asleep: 3 };

  /*
   * Sums up a group of sessions: { total, working, waiting, idle, resting, byPhase, faces }.
   * `faces` holds up to five ids to draw, the most urgent first (waiting, then working).
   */
  function rollup(list) {
    var r = { total: list.length, working: 0, waiting: 0, idle: 0, asleep: 0, resting: 0, byPhase: {}, faces: [] };
    PHASES.forEach(function (p) { r.byPhase[p.id] = 0; });
    list.forEach(function (s) {
      if (s.pose === "working") r.working++;
      else if (s.pose === "waiting") r.waiting++;
      else if (s.pose === "idle") r.idle++;
      else r.asleep++;
      r.byPhase[s.digest.phase]++;
    });
    r.resting = r.idle + r.asleep;
    r.faces = list
      .slice()
      .sort(function (a, b) { return URGENCY[a.pose] - URGENCY[b.pose] || minutes(b.last) - minutes(a.last); })
      .slice(0, 5)
      .map(function (s) { return s.id; });
    return r;
  }

  // Returns a roll-up as one quiet line: "14 working · 1 needs you · 6 resting". Zeros are left out.
  function rollupText(r) {
    var parts = [];
    if (r.working) parts.push(r.working + " working");
    if (r.waiting) parts.push(r.waiting + (r.waiting === 1 ? " needs you" : " need you"));
    if (r.resting) parts.push(r.resting + " resting");
    return parts.join(" · ");
  }

  /* ------------------------------------------------------------------ finding */

  var TOKEN = /^(project|in|model|on|by|is|role):(.+)$/i;

  /*
   * Parses the find field's text. Plain words go to `words`; tokens narrow:
   *   project:webshop  in:src/checkout  model:codex  on:build-box-1  by:me
   *   is:waiting|working|idle  role:review
   * Returns { words: [...], project, in, model, on, byMe, is, role }; absent tokens are null.
   */
  function parseQuery(text) {
    var q = { words: [], project: null, in: null, model: null, on: null, byMe: false, is: null, role: null };
    String(text || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .forEach(function (part) {
        var m = TOKEN.exec(part);
        if (!m) return q.words.push(part.toLowerCase());
        var key = m[1].toLowerCase();
        var value = m[2].toLowerCase();
        if (key === "by") q.byMe = value === "me";
        else q[key] = value;
      });
    return q;
  }

  var PROVIDER_NAMES = { claude: "claude code", codex: "codex", pi: "pi" };

  function haystack(s) {
    return [s.title, s.branch, focusLabel(s), s.model, PROVIDER_NAMES[s.provider], s.role, s.project, s.machine]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  /*
   * Checks a session against a parsed query. Every plain word must appear somewhere (title,
   * branch, folder, model, provider, role, project, machine), and every token must hold.
   * Returns { ok, ranges } where `ranges` are [start, end) spans of the title to highlight.
   */
  function matches(s, q) {
    if (q.project && (s.project || "none").toLowerCase().indexOf(q.project) !== 0) return { ok: false, ranges: [] };
    if (q.in && focusLabel(s).toLowerCase().indexOf(q.in) < 0) return { ok: false, ranges: [] };
    if (q.model && (s.model + " " + PROVIDER_NAMES[s.provider]).toLowerCase().indexOf(q.model) < 0) return { ok: false, ranges: [] };
    if (q.on && (s.machine || "").toLowerCase().indexOf(q.on) < 0) return { ok: false, ranges: [] };
    if (q.byMe && s.startedBy !== "user") return { ok: false, ranges: [] };
    if (q.is && s.pose !== q.is) return { ok: false, ranges: [] };
    if (q.role && (s.role || "").toLowerCase().indexOf(q.role) < 0) return { ok: false, ranges: [] };
    var hay = haystack(s);
    for (var i = 0; i < q.words.length; i++) if (hay.indexOf(q.words[i]) < 0) return { ok: false, ranges: [] };
    var title = s.title.toLowerCase();
    var ranges = [];
    q.words.forEach(function (w) {
      var at = title.indexOf(w);
      if (at >= 0) ranges.push([at, at + w.length]);
    });
    ranges.sort(function (a, b) { return a[0] - b[0]; });
    return { ok: true, ranges: ranges };
  }

  // Checks a session against a lens: "all", "following", "mine" (Rogier started it) or "needs-you".
  function lens(s, name) {
    if (name === "following") return !!s.following;
    if (name === "mine") return s.startedBy === "user";
    if (name === "needs-you") return s.pose === "waiting";
    return true;
  }

  window.Digest = {
    PHASES: PHASES,
    LADDER: LADDER,
    minutes: minutes,
    ago: ago,
    elapsed: elapsed,
    phaseOf: phaseOf,
    phaseLabel: function (id) { return PHASE_LABEL[id] || id; },
    focusLabel: focusLabel,
    where: where,
    progress: progress,
    milestoneLadder: milestoneLadder,
    checkText: checkText,
    line: line,
    stateColumn: stateColumn,
    rollup: rollup,
    rollupText: rollupText,
    parseQuery: parseQuery,
    matches: matches,
    lens: lens,
  };
})();
