// PROTOTYPE - The Firm: "You run a firm of agents". The live window of the direction that
// organizes all the work by who started whom (BRIEF.md §7.5).
//
// Rogier starts leads, leads start partners, assistants start threads, workflows run shifts.
// A team is a lead and everyone it started. Every view here draws that one tree:
//   - the sidebar: Chain of command, the tree folded to 272px
//   - Threads: the same tree as a wide table, with team actions
//   - Org Chart: the same tree as a live organogram on a pannable, zoomable canvas
//   - Office: the Dollhouse, drawn by the office builder's module (the-firm-office.js); this file
//     mounts it, or draws an elevation of the building until the module exists.
//
// It draws on the sidebar book's stage (../../sidebar-directions/shared/stage.js): the stage builds
// the window, and this file draws the sidebar's list and the main pane. The world is
// ../../sidebar-directions/shared/world.js with ../shared/world-plus.js and the-firm-data.js.
//
// URL: ?mode=office|threads|org  ?state=everyday|open|swarm|away|standup|exchange|spawn
//      ?theme=whitehaven|orient-express  ?select=<session id, assistant name or run id>
// Keys while the overview is open: 1 2 3 switch modes, S asks the selected team for a stand-up,
// F folds the tree to leads only and back, up and down walk the tree, return opens, esc clears.
// Cmd+Shift+O opens and closes the overview. In the Org Chart, + and - zoom and 0 fits.
(function () {
  "use strict";

  var W = window.WORLD;
  var WH = W.helpers;
  var FIRM = window.FIRM;
  var ROOT = document.documentElement;
  var PARAMS = new URLSearchParams(location.search);
  var STATE = ROOT.dataset.state || "everyday";
  var REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var MODES = ["office", "threads", "org"];
  var MODE_NAMES = { office: "Office", threads: "Threads", org: "Org Chart" };
  var HUES = ["lime", "mint", "teal", "sky", "iris", "grape", "orchid", "peach"];
  var POSE_RANK = { waiting: 0, failed: 1, working: 2, idle: 3, paused: 4, asleep: 5, away: 6, done: 7 };
  var OFFICE_KEY = "the-firm";

  var api = null; // the stage's api, set at boot
  // Whether the first view of a mode brings the selection into view: when the link names one, or
  // when the state is about one team. Otherwise a mode opens at its top.
  var FOCUS_ON_LOAD = !!PARAMS.get("select") || STATE === "standup" || STATE === "spawn";
  var els = {}; // the elements this file draws into

  // What the window shows. The selection is shared by the three modes and the sidebar.
  var ui = {
    overview: STATE !== "open",
    mode: pickMode(),
    selected: PARAMS.get("select") || pickFirstSelection(),
    fold: "everyone",
    openId: "t3ds",
    hoverId: null,
    heldInBand: [], // answered rows the Threads band keeps until the pointer leaves it
    bandOrder: [], // the band's rows as last drawn, so a held row keeps its place
  };

  // What Rogier did in this window. Views read the world through it.
  var live = {
    answered: {}, // session id -> the answer's label
    done: {}, // session id -> true
    spawned: false, // the spawn state's partner has joined
    bornAt: {}, // session id -> when it joined in this visit, for the entrance
    standup: {}, // session id -> { said, text }
    standupAt: {}, // lead id -> the stand-up's time
  };

  var firm = null; // the tree, rebuilt by rebuildFirm() after every change
  var looks = {}; // session id -> its face's look, so partners of one team never share a hue

  /** Returns the mode the overview opens in: ?mode=, else the mode that shows the state best. */
  function pickMode() {
    var m = PARAMS.get("mode");
    if (MODES.indexOf(m) !== -1) return m;
    return { standup: "threads", exchange: "org", spawn: "org" }[STATE] || "office";
  }

  /** Returns what is selected at load: the head of the queue, or the state's subject. */
  function pickFirstSelection() {
    return { swarm: "xLead", exchange: "tCart", spawn: "tSecrets" }[STATE] || "t3ds";
  }

  /* ================================================================== the world, read */

  function findRun(id) {
    for (var i = 0; i < W.runs.length; i++) if (W.runs[i].id === id) return W.runs[i];
    return null;
  }

  /** Returns the record every view draws for a thread of the world. */
  function buildThreadRecord(t) {
    var ws = W.workspaces[t.workspace] || {};
    var lineage = W.startedBy[t.id] || (t.lead && t.joined !== "added" ? "session:" + t.lead : "user");
    return {
      id: t.id,
      kind: "thread",
      title: t.title,
      faceName: t.title,
      role: t.role || null,
      project: t.project,
      provider: t.provider,
      model: t.model,
      pose: t.pose,
      status: t.status,
      ask: t.ask || null,
      askShort: t.askShort || null,
      started: t.started,
      last: t.last,
      lead: t.lead || null,
      joined: t.joined || null,
      workspace: t.workspace,
      machine: ws.machine || t.machine || "studio-mac",
      branch: ws.kind === "worktree" ? ws.branch : null,
      wsKind: ws.kind || "none",
      repo: ws.repo || null,
      startedBy: lineage,
      result: t.result || null,
    };
  }

  /** Returns the record of a run step's session. Its face is its run's, as the book draws it. */
  function buildStepRecord(id) {
    var s = W.runSessions[id];
    var run = findRun(s.run);
    var queued = W.waitingRuns.filter(function (w) { return w.id === id; })[0];
    return {
      id: id,
      kind: "step",
      title: s.title,
      faceName: run.title,
      role: s.step,
      project: s.project,
      provider: s.provider,
      model: s.model,
      pose: s.pose,
      status: s.pose === "waiting" ? "approval" : s.pose === "working" ? "working" : null,
      ask: s.ask || null,
      askShort: queued ? queued.ask : s.ask || null,
      started: s.started,
      last: s.last,
      lead: null,
      run: s.run,
      workspace: null,
      machine: s.machine,
      branch: null,
      wsKind: "none",
      startedBy: "run:" + s.run,
      result: null,
    };
  }

  /** Returns every session in view in this state, with Rogier's answers and Done marks applied. */
  function listRecords() {
    var threads = W.threads.concat(W.assistantThreads);
    if (STATE === "spawn" && live.spawned) threads = threads.concat([W.spawn.thread]);
    if (STATE === "swarm") threads = threads.concat(W.swarm.threads, W.stress.threads);
    return threads
      .map(buildThreadRecord)
      .concat(Object.keys(W.runSessions).map(buildStepRecord))
      .filter(function (r) { return !live.done[r.id]; })
      .map(function (r) {
        if (live.answered[r.id]) {
          r.answer = live.answered[r.id];
          r.pose = "working";
          r.status = "working";
          r.answeredAt = W.now;
        }
        return r;
      });
  }

  /** Returns a session's token usage, or null when its provider reports none (Codex). */
  function readTokens(id) {
    if (Object.prototype.hasOwnProperty.call(FIRM.stressUsage, id)) return FIRM.stressUsage[id];
    var u = W.usage[id];
    return u ? u.tokens : null;
  }

  /** Adds up the usage of several sessions: { sum, unreported } where unreported lists the silent ones. */
  function sumTokens(recs) {
    var out = { sum: 0, unreported: [] };
    recs.forEach(function (r) {
      var n = readTokens(r.id);
      if (n == null) out.unreported.push(r);
      else out.sum += n;
    });
    return out;
  }

  /** Formats a token count the short way: "1.73M", "312k". */
  function formatTokens(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
    if (n >= 1e3) return Math.round(n / 1e3) + "k";
    return String(n);
  }

  function compareStarted(a, b) {
    return WH.minutes(a.started) - WH.minutes(b.started);
  }

  /** Gives every member of a team a face whose hue no other member of the team wears. */
  function castLooks(members) {
    var used = [];
    members.forEach(function (m) {
      var look = Crew.lookFor(m.faceName);
      if (used.indexOf(look.hue) !== -1) {
        var at = HUES.indexOf(look.hue);
        for (var k = 1; k < HUES.length; k++) {
          var hue = HUES[(at + k) % HUES.length];
          if (used.indexOf(hue) === -1) {
            look = { hue: hue, shape: look.shape, acc: look.acc };
            break;
          }
        }
      }
      used.push(look.hue);
      looks[m.id] = look;
    });
  }

  /**
   * Rebuilds the tree every view draws:
   *   depts       Rogier's own leads by project, newest first, then No project; each { id, project, teams, more }
   *   assistants  each assistant with the teams and runs it started
   *   runs        the workflows' runs Rogier or a trigger started, each { id, run, steps }
   *   teams       lead id -> { id, lead, partners, members }
   *   waiting     every session that waits on Rogier, oldest first; threads before run steps
   */
  function rebuildFirm() {
    var recs = listRecords();
    var byId = {};
    var teams = {};
    recs.forEach(function (r) {
      byId[r.id] = r;
      if (r.kind === "thread" && !r.lead) teams[r.id] = { id: r.id, lead: r, partners: [] };
    });
    recs.forEach(function (r) {
      if (r.kind === "thread" && r.lead && teams[r.lead]) teams[r.lead].partners.push(r);
    });
    Object.keys(teams).forEach(function (id) {
      var team = teams[id];
      team.partners.sort(compareStarted);
      team.members = [team.lead].concat(team.partners);
      castLooks(team.members);
    });
    recs.forEach(function (r) {
      if (!looks[r.id]) castLooks([r]);
    });

    function listTeamsStartedBy(who, projectId) {
      return Object.keys(teams)
        .map(function (id) { return teams[id]; })
        .filter(function (t) { return t.lead.startedBy === who && (projectId === undefined || t.lead.project === projectId); })
        .sort(function (a, b) { return compareStarted(b.lead, a.lead); });
    }

    var depts = W.projects
      .map(function (p) {
        return { id: p.id, project: p, teams: listTeamsStartedBy("user", p.id), more: STATE === "swarm" ? W.swarm.more[p.id] || 0 : 0 };
      })
      .filter(function (d) { return d.teams.length; })
      .sort(function (a, b) { return compareStarted(b.teams[0].lead, a.teams[0].lead); });
    var loners = listTeamsStartedBy("user", null);
    if (loners.length) depts.push({ id: "none", project: null, teams: loners, more: 0 });

    var runs = W.runs.map(function (run) {
      return {
        id: run.id,
        run: run,
        steps: run.steps
          .filter(function (s) { return s.sessionId && byId[s.sessionId]; })
          .map(function (s) { return byId[s.sessionId]; }),
      };
    });

    var assistants = W.assistants.map(function (a) {
      return {
        id: a.name,
        name: a.name,
        pose: a.pose,
        info: FIRM.assistants[a.name],
        teams: listTeamsStartedBy("assistant:" + a.name),
        runs: runs.filter(function (r) { return r.run.origin === "assistant:" + a.name; }),
      };
    });

    var shiftRuns = runs
      .filter(function (r) { return r.run.origin.indexOf("assistant:") !== 0; })
      .sort(function (a, b) {
        var doneA = a.run.status === "completed" ? 1 : 0;
        var doneB = b.run.status === "completed" ? 1 : 0;
        return doneA - doneB || WH.minutes(b.run.started) - WH.minutes(a.run.started);
      });

    var waiting = recs
      .filter(function (r) { return r.pose === "waiting"; })
      .sort(function (a, b) {
        return (a.kind === "step") - (b.kind === "step") || WH.minutes(a.last) - WH.minutes(b.last);
      });

    firm = { recs: recs, byId: byId, teams: teams, depts: depts, assistants: assistants, runs: shiftRuns, allRuns: runs, waiting: waiting };
    firm.order = listTreeOrder();
  }

  /** Returns the ids of the tree in the order every view draws it, folded or not: for up and down. */
  function listTreeOrder() {
    var out = [];
    var all = ui.fold === "everyone";
    firm.depts.forEach(function (d) {
      d.teams.forEach(function (t) {
        out.push(t.id);
        if (all) t.partners.forEach(function (p) { out.push(p.id); });
      });
    });
    firm.assistants.forEach(function (a) {
      out.push(a.id);
      if (all) {
        a.teams.forEach(function (t) { out.push(t.id); });
        a.runs.forEach(function (r) { r.steps.forEach(function (s) { out.push(s.id); }); });
      }
    });
    firm.runs.forEach(function (r) {
      out.push(r.id);
      if (all) r.steps.forEach(function (s) { out.push(s.id); });
    });
    return out;
  }

  /* ================================================================== words */

  function esc(s) {
    return api.escapeHtml(s == null ? "" : s);
  }

  function providerName(r) {
    return { claude: "Claude", codex: "Codex", pi: "pi" }[r.provider] || r.provider;
  }

  /** Returns a member's name in the tree: its role first, or its title when it has none. */
  function nameMember(r) {
    return r.role || r.title;
  }

  /** Returns the team a session belongs to, or null for a run's step. */
  function findTeam(r) {
    if (!r || r.kind !== "thread") return null;
    return firm.teams[r.lead || r.id] || null;
  }

  /** Returns the member that speaks for a group: the most urgent pose, then the newest activity. */
  function pickVoice(members) {
    return members.slice().sort(function (a, b) {
      var d = POSE_RANK[a.pose] - POSE_RANK[b.pose];
      if (d) return d;
      if (a.status === "queued" && b.status !== "queued") return 1;
      if (b.status === "queued" && a.status !== "queued") return -1;
      return WH.minutes(b.last) - WH.minutes(a.last);
    })[0];
  }

  /** Returns a row's status word, as today's sidebar writes it: { kind, text }. */
  function decideSlot(r) {
    if (r.status === "approval") return { kind: "approval", text: "Approval" };
    if (r.status === "question") return { kind: "question", text: "Question" };
    if (r.status === "queued") return { kind: "queued", text: "Queued" };
    if (r.pose === "working") return { kind: "working", text: "Working" };
    if (r.pose === "asleep") return { kind: "age", text: "asleep" };
    return { kind: "age", text: WH.ago(r.last) };
  }

  /** Returns a session's status in full, with how long it has been so: { kind, text }. */
  function describeStatus(r) {
    if (r.pose === "waiting") return { kind: "waiting", text: "Waiting " + WH.ago(r.last) };
    if (r.status === "queued") return { kind: "queued", text: "Queued" };
    if (r.pose === "working") {
      var since = r.answeredAt || (W.eta[r.id] && W.eta[r.id].busySince) || r.started;
      var age = WH.ago(since);
      return { kind: "working", text: age === "now" ? "Working now" : "Working " + age };
    }
    if (r.pose === "asleep") return { kind: "idle", text: "Asleep" };
    return { kind: "idle", text: "Idle " + WH.ago(r.last) };
  }

  /** Returns who started a session: { who, at, added }. */
  function describeStarter(r) {
    var by = r.startedBy;
    if (by.indexOf("session:") === 0) return { who: "the lead", at: r.started };
    if (by.indexOf("assistant:") === 0) return { who: by.slice(10), at: r.started };
    if (by.indexOf("run:") === 0) return { who: "its run", at: r.started };
    return { who: "you", at: r.started, added: r.joined === "added" };
  }

  /** Returns how a run's origin reads after "by": "you", "Gmail", "Milo". */
  function describeOrigin(run) {
    if (run.origin.indexOf("assistant:") === 0) return run.origin.slice(10);
    return FIRM.origins[run.origin] || run.origin.replace(/^trigger: /, "");
  }

  /** Returns true when a session joined while Rogier was away (09:01-09:41), started by someone else. */
  function joinedWhileAway(r) {
    return STATE === "away" && r.startedBy !== "user" && WH.minutes(r.started) > WH.minutes(W.away.left);
  }

  /** Returns a run's status as a session would show it: { kind, text, voice } where voice is its waiting step. */
  function describeRun(item) {
    var run = item.run;
    var voice = item.steps.length ? pickVoice(item.steps) : null;
    if (voice && voice.pose === "waiting") return { kind: "approval", text: "Approval", voice: voice, long: "Waiting " + WH.ago(voice.last) };
    if (run.status === "paused") return { kind: "age", text: "Paused", long: "Paused " + WH.ago(run.started) };
    if (run.status === "completed") return { kind: "age", text: run.ended, long: "Finished " + run.ended };
    return { kind: "working", text: "Working", voice: voice, long: voice ? describeStatus(voice).text : "Working" };
  }

  /** Returns where in its run a step is: "step 3 of 4". */
  function describeStepPlace(run, stepRecord) {
    for (var i = 0; i < run.steps.length; i++) if (run.steps[i].sessionId === stepRecord.id) return "step " + (i + 1) + " of " + run.steps.length;
    return "";
  }

  /** Formats an ask for display: a command in code, the rest as text. */
  function formatAsk(ask) {
    var m = /^Run (.+)\?$/.exec(ask || "");
    return m ? "Run <code>" + esc(m[1]) + "</code>?" : esc(ask);
  }

  /** Returns the answers a waiting session offers: [label, style]. The style is accent, danger, quiet or "". */
  function listAnswers(r) {
    var special = {
      tPayoutCheck: [["Settlement date", ""], ["Payout date", ""]],
      tDash: [["Keep", "accent"], ["Delete", "danger"]],
      xReview: [["Result error", ""], ["Retry", ""]],
      sPgRollback: [["Keep a replica", ""], ["No", "quiet"]],
    };
    if (special[r.id]) return special[r.id];
    if (r.status === "approval") return [["Allow once", "accent"], ["Deny", "quiet"]];
    return [["Yes", ""], ["No", "quiet"]];
  }

  function drawAnswerButtons(r) {
    return listAnswers(r)
      .map(function (a) {
        return '<button class="btn btn--sm' + (a[1] ? " btn--" + a[1] : "") + '" data-tfw-answer="' + r.id + '" data-label="' + esc(a[0]) + '">' + esc(a[0]) + "</button>";
      })
      .join("");
  }

  /* ================================================================== drawing parts */

  function drawFace(r, size, pose) {
    return Crew.face(r.faceName, { pose: pose || r.pose, size: size, look: looks[r.id] });
  }

  function drawBrand(provider, size) {
    return Crew.brand(W.providers[provider].brand, size || 12);
  }

  /** Returns the hue style of a session, for anything painted in its color. */
  function hueStyle(r) {
    var look = looks[r.id] || Crew.lookFor(r.faceName);
    return 'style="--hue:var(--hue-' + look.hue + ')"';
  }

  /** Returns overlapping faces of a team, at most four and then "+n". */
  function drawPile(members, size) {
    var shown = members.slice(0, 4);
    return (
      '<span class="tfw-pile">' +
      shown.map(function (m) { return drawFace(m, size); }).join("") +
      (members.length > 4 ? '<span class="tfw-pile-more">+' + (members.length - 4) + "</span>" : "") +
      "</span>"
    );
  }

  /** Returns the roles line of a team: "lead · research · review". */
  function listRoles(team) {
    return ["lead"].concat(team.partners.map(nameMember)).join(" · ");
  }

  /**
   * Returns the line a team shows under its title: who asks and what, in marigold, when someone in
   * it waits; else its roles. The lead itself asking needs no name.
   */
  function drawTeamVoice(team) {
    var voice = pickVoice(team.members);
    if (voice.pose === "waiting") {
      var who = voice === team.lead ? "" : "<b>" + esc(nameMember(voice)) + "</b> asks · ";
      return '<span class="tfw-voice tfw-voice--ask">' + who + esc(voice.askShort) + "</span>";
    }
    return '<span class="tfw-voice">' + esc(listRoles(team)) + "</span>";
  }

  /** Returns the stand-up line under a member, if its team was asked: the dots while it thinks, then its words. */
  function drawSaid(r, cls) {
    var s = live.standup[r.id];
    if (!s) return "";
    return (
      '<span class="tfw-said' + (cls ? " " + cls : "") + (s.said ? "" : " is-thinking") + '" ' + hueStyle(r) + ">" +
      (s.said ? esc(s.text) : '<i class="tfw-dots"><i></i><i></i><i></i></i>') +
      "</span>"
    );
  }

  /** Returns the line a member answers a stand-up with: its own words, or its latest headline. */
  function writeStandupLine(r) {
    if (FIRM.standup[r.id]) return FIRM.standup[r.id];
    var h = W.headlines[r.id];
    if (h && h.length) return h[h.length - 1].text.replace(/^So far: /, "");
    return r.result || "Nothing new since " + r.last + ".";
  }

  /* ================================================================== the sidebar: Chain of command */

  function drawSidebar() {
    var list = els.list;
    var top = list.scrollTop;
    list.innerHTML =
      drawRootRow() +
      (STATE === "away" ? drawMemoRow() : "") +
      drawWaitingSection() +
      firm.depts.map(drawDeptSection).join("") +
      drawAssistantsSection() +
      drawWorkflowsSection();
    list.scrollTop = top;
    markSelection();
  }

  /** Returns the root of the tree: Rogier, what he runs, and the fold control. */
  function drawRootRow() {
    var teamCount = countTeams();
    return (
      '<div class="tfw-root">' +
      Crew.you(24) +
      '<span class="tfw-root-name">Rogier</span>' +
      '<button class="tfw-fold" data-tfw-fold title="' + (ui.fold === "everyone" ? "Show leads only" : "Show everyone") + ' (F)">' +
      (ui.fold === "everyone" ? "Everyone" : "Leads only") + Crew.icon("chev-ud", 13) +
      "</button>" +
      '<span class="tfw-root-sub">' + teamCount + (teamCount === 1 ? " team" : " teams") + " · " + firm.recs.length + " sessions</span>" +
      "</div>"
    );
  }

  function countTeams() {
    return Object.keys(firm.teams).filter(function (id) { return firm.teams[id].partners.length; }).length;
  }

  /** Returns the away state's memo: what the firm did while Rogier was out. */
  function drawMemoRow() {
    var m = buildMemo();
    return (
      '<a class="tfw-memo" href="#" data-tfw-memo>' +
      '<span class="tfw-memo-h">While you were out<span>' + W.away.left + "-" + W.away.back + "</span></span>" +
      '<span class="tfw-memo-line"><b>' + m.joined.length + "</b> joined · <b>" + m.started.length + "</b> started by others · <b>" + m.reports.length + "</b> reports</span>" +
      "</a>"
    );
  }

  function drawWaitingSection() {
    var threads = firm.waiting.filter(function (r) { return r.kind === "thread"; });
    var steps = firm.waiting.filter(function (r) { return r.kind === "step"; });
    if (!firm.waiting.length) return "";
    var shown = threads.slice(0, 3);
    return (
      '<section class="side-sec tfw-wait"><h3 class="side-h"><span>Waiting on you</span><b class="count count--you">' + firm.waiting.length + "</b></h3>" +
      shown.map(function (r) {
        var team = findTeam(r);
        var asker = team && team.lead !== r ? "<b>" + esc(nameMember(r)) + "</b> asks · " : "";
        return (
          '<a class="side-row side-row--wait" href="#" data-tfw-id="' + r.id + '">' + drawFace(r, 24, "waiting") +
          '<span class="side-text"><span class="side-name">' + esc(team ? team.lead.title : r.title) + '</span><span class="side-ask">' + asker + esc(r.askShort) + "</span></span></a>"
        );
      }).join("") +
      (threads.length > 3 ? '<a class="side-row st-more" href="#">' + (threads.length - 3) + " more waiting on you</a>" : "") +
      (steps.length ? '<h4 class="side-sub">From runs</h4>' : "") +
      steps.map(function (r) {
        var run = findRun(r.run);
        return (
          '<a class="side-row side-row--wait" href="#" data-tfw-id="' + r.id + '"><span class="side-lead">' + Crew.mark("waiting") + "</span>" +
          '<span class="side-text"><span class="side-name">' + esc(run.title) + '</span><span class="side-ask"><b>' + esc(r.role) + "</b> asks · " + esc(r.askShort) + "</span></span></a>"
        );
      }).join("") +
      "</section>"
    );
  }

  /** Returns the teams a department shows in the sidebar: five at most, the urgent and the selected kept. */
  function pickShownTeams(dept) {
    if (dept.teams.length <= 5) return dept.teams;
    var rank = function (t) { return Math.min(2, POSE_RANK[pickVoice(t.members).pose]); };
    var picked = dept.teams.slice().sort(function (a, b) { return rank(a) - rank(b); }).slice(0, 5);
    var sel = firm.byId[ui.selected];
    var selTeam = sel ? findTeam(sel) : null;
    if (selTeam && dept.teams.indexOf(selTeam) !== -1 && picked.indexOf(selTeam) === -1) picked.push(selTeam);
    return dept.teams.filter(function (t) { return picked.indexOf(t) !== -1; });
  }

  function drawDeptSection(dept) {
    var p = dept.project;
    var shown = pickShownTeams(dept);
    var need = 0;
    dept.teams.forEach(function (t) { t.members.forEach(function (m) { if (m.pose === "waiting") need++; }); });
    var hiddenTeams = dept.teams.length - shown.length;
    var more = [];
    if (hiddenTeams) more.push(hiddenTeams + (hiddenTeams === 1 ? " more team" : " more teams"));
    if (dept.more) more.push(dept.more + " more threads");
    return (
      '<section class="side-sec tfw-dept">' +
      '<h3 class="side-h side-h--proj">' + (p ? '<span class="proj proj--' + p.tint + '">' + p.name + "</span>" : '<span class="proj tfw-noproj">No project</span>') +
      (need ? '<span class="st-need">' + need + (need === 1 ? " needs you" : " need you") + "</span>" : "") +
      '<button class="icon-btn icon-btn--sm" title="New thread in ' + (p ? p.name : "no project") + '">' + Crew.icon("plus", 14) + "</button></h3>" +
      shown.map(drawTeamBlock).join("") +
      (more.length ? '<a class="side-row st-more" href="#">' + more.join(" · ") + "</a>" : "") +
      "</section>"
    );
  }

  /** Returns a team in the sidebar: a lone thread is today's row; a team is its lead's row and its partners. */
  function drawTeamBlock(team) {
    var lead = team.lead;
    var born = live.bornAt[lead.id] ? " is-born" : "";
    if (!team.partners.length) {
      return (
        '<div class="tfw-lone' + born + '">' + api.drawThreadRow(lead, { selected: false }).replace('data-open-row="', 'data-tfw-id="') +
        drawSaid(lead, "tfw-said--lone") + "</div>"
      );
    }
    var slot = decideSlot(pickVoice(team.members));
    var receded = slot.kind === "working" ? " is-receded" : "";
    return (
      '<div class="tfw-team-block' + (live.standupAt[team.id] ? " has-standup" : "") + '" data-tfw-team="' + team.id + '">' +
      '<div class="st-thread tfw-team' + receded + '">' +
      '<a class="side-row" href="#" data-tfw-id="' + lead.id + '">' +
      '<span class="side-text">' +
      '<span class="st-line"><span class="side-name">' + esc(lead.title) + '</span><span class="side-end st-end--' + slot.kind + '">' + slot.text + "</span></span>" +
      '<span class="st-detail tfw-detail">' + drawPile(team.members, 16) + drawTeamVoice(team) + "</span>" +
      drawSaid(lead) +
      "</span></a>" +
      '<button class="tfw-row-btn" data-tfw-standup="' + team.id + '" title="Stand-up: ask the team for a one-line status (S)">' + Crew.icon("discussions", 14) + "</button>" +
      "</div>" +
      (ui.fold === "everyone" ? '<div class="tfw-members">' + team.partners.map(function (p, i) { return drawMemberRow(p, i === team.partners.length - 1); }).join("") + "</div>" : "") +
      (live.standupAt[team.id] ? '<div class="tfw-stamp">' + drawStandupStamp(team) + "</div>" : "") +
      "</div>"
    );
  }

  function drawStandupStamp(team) {
    var said = team.members.filter(function (m) { return live.standup[m.id] && live.standup[m.id].said; }).length;
    return Crew.icon("discussions", 12) + "stand-up " + live.standupAt[team.id] + " · " + (said === team.members.length ? "everyone answered" : said + " of " + team.members.length + " answered");
  }

  /** Returns a partner's row: an elbow from its lead, its face, its role and provider, its status. */
  function drawMemberRow(r, last, opts) {
    opts = opts || {};
    var slot = decideSlot(r);
    var name = opts.name != null ? opts.name : "<b>" + esc(nameMember(r)) + '</b><span class="tfw-of"> · ' + esc(opts.of || providerName(r)) + "</span>";
    return (
      '<a class="side-row tfw-member' + (last ? " is-last" : "") + (r.pose === "working" ? " is-receded" : "") + (live.bornAt[r.id] ? " is-born" : "") + (joinedWhileAway(r) ? " is-new" : "") + '" href="#" data-tfw-id="' + r.id + '">' +
      '<span class="tfw-elbow" aria-hidden="true"></span>' +
      '<span class="tfw-member-line">' + drawFace(r, 16) +
      '<span class="tfw-member-name">' + name + "</span>" +
      '<span class="side-end st-end--' + slot.kind + '">' + slot.text + "</span></span>" +
      drawSaid(r) +
      "</a>"
    );
  }

  /** Returns the assistants as managers, with the threads and runs each started under them. */
  function drawAssistantsSection() {
    return (
      '<section class="side-sec tfw-asst"><h3 class="side-h"><span>Assistants</span></h3>' +
      firm.assistants.map(function (a) {
        var reports = a.teams.map(function (t) { return { rec: t.lead }; }).concat(
          a.runs.reduce(function (acc, item) {
            return acc.concat(item.steps.map(function (s) { return { rec: s, run: item.run }; }));
          }, [])
        );
        var count = reports.length ? '<span class="tfw-mgr-count">' + reports.length + "</span>" : "";
        return (
          '<a class="side-row side-row--who tfw-mgr" href="#" data-tfw-id="' + a.id + '">' + Crew.face(a.name, { pose: a.pose, size: 22 }) +
          '<span class="side-name">' + a.name + (ui.fold === "leads" ? count : "") + '</span><span class="side-end side-presence">' + Crew.poseWord(a.pose) + "</span></a>" +
          (ui.fold === "everyone" && reports.length
            ? '<div class="tfw-members tfw-members--mgr">' +
              reports.map(function (x, i) {
                var last = i === reports.length - 1;
                if (x.run) return drawMemberRow(x.rec, last, { name: "<b>" + esc(x.run.title) + '</b><span class="tfw-of"> · run</span>' });
                return drawMemberRow(x.rec, last, { name: "<b>" + esc(x.rec.title) + "</b>" });
              }).join("") +
              "</div>"
            : "")
        );
      }).join("") +
      "</section>"
    );
  }

  /** Returns the workflows' runs as departments, each with the session of its current step. */
  function drawWorkflowsSection() {
    var live_ = firm.runs.filter(function (x) { return x.run.status !== "completed"; });
    var finished = firm.runs.length - live_.length;
    return (
      '<section class="side-sec tfw-flows"><h3 class="side-h"><span>Workflows</span><span class="tfw-h-note">' + firm.runs.length + " runs</span></h3>" +
      live_.map(drawRunBlock).join("") +
      (finished ? '<a class="side-row st-more" href="#" data-tfw-id="' + firm.runs[firm.runs.length - 1].id + '">' + finished + " finished overnight</a>" : "") +
      "</section>"
    );
  }

  function drawRunBlock(item) {
    var run = item.run;
    var st = describeRun(item);
    var line = st.voice && st.voice.pose === "waiting"
      ? '<span class="tfw-voice tfw-voice--ask"><b>' + esc(st.voice.role) + "</b> asks · " + esc(st.voice.askShort) + "</span>"
      : '<span class="tfw-voice">' + esc(run.workflow) + " · by " + esc(describeOrigin(run)) + "</span>";
    return (
      '<div class="tfw-team-block tfw-run-block">' +
      '<div class="st-thread tfw-team tfw-run' + (st.kind === "working" ? " is-receded" : "") + '">' +
      '<a class="side-row" href="#" data-tfw-id="' + item.id + '">' +
      '<span class="side-text">' +
      '<span class="st-line"><span class="side-name">' + esc(run.title) + '</span><span class="side-end st-end--' + st.kind + '">' + st.text + "</span></span>" +
      '<span class="st-detail tfw-detail"><span class="st-glyph">' + Crew.icon(run.status === "paused" ? "pause" : "workflows", 12) + "</span>" + line + "</span>" +
      "</span></a></div>" +
      (ui.fold === "everyone" && item.steps.length
        ? '<div class="tfw-members">' + item.steps.map(function (s, i) { return drawMemberRow(s, i === item.steps.length - 1); }).join("") + "</div>"
        : "") +
      "</div>"
    );
  }

  /** Marks the selected row in the sidebar, or the open thread's while the overview is closed. */
  function markSelection() {
    var on = ui.overview ? ui.selected : ui.openId;
    els.list.querySelectorAll("[data-tfw-id]").forEach(function (a) {
      a.classList.toggle("is-on", a.dataset.tfwId === on);
    });
  }

  /** Draws the foot's counts over every session in view, so they agree with the overview's. */
  // The Firm counts everyone in the firm, partners, assistants' threads and run steps included, so
  // its numbers are higher than a count of threads. The foot and the top bar say so.
  var COUNT_NOTE = "Counts everyone in the firm: threads, the partners they started, the assistants' threads and the runs' step sessions.";

  function drawFoot() {
    var c = countPoses();
    els.sum.title = COUNT_NOTE;
    els.sum.innerHTML = "<b>" + c.working + "</b> working · <b" + (c.waiting ? ' class="you-ink"' : "") + ">" + c.waiting + "</b> waiting · <b>" + c.idle + '</b> idle <span class="tfw-sum-all">· everyone</span>';
  }

  function countPoses() {
    var c = { working: 0, waiting: 0, idle: 0 };
    firm.recs.forEach(function (r) { if (c[r.pose] !== undefined) c[r.pose]++; });
    return c;
  }

  /* ---------------------------------------------------------- the sidebar's hover card */

  var hoverTimer = 0;

  function showHoverCard(row) {
    var id = row.dataset.tfwId;
    var html = drawHoverCard(id);
    if (!html) return;
    var card = els.hover;
    card.innerHTML = html;
    var box = row.getBoundingClientRect();
    card.style.top = Math.max(8, Math.min(window.innerHeight - 220, box.top - 6)) + "px";
    card.hidden = false;
  }

  function hideHoverCard() {
    clearTimeout(hoverTimer);
    if (els.hover) els.hover.hidden = true;
  }

  /** Returns the hover card of a row: the full title, who started it, where it works, its usage. */
  function drawHoverCard(id) {
    var r = firm.byId[id];
    if (!r) return "";
    var team = findTeam(r);
    var lines = [];
    var by = describeStarter(r);
    var starter = by.who === "the lead" ? "the lead, " + esc(firm.byId[r.lead] ? firm.byId[r.lead].title : "") : esc(by.who);
    if (by.added) starter = "you, into the lead's team";
    lines.push(["Started by", starter + " at " + by.at]);
    if (team && team.partners.length && team.lead === r) {
      lines.push(["Team", team.members.map(function (m) { return m === r ? "lead" : esc(nameMember(m)) + (m.joined === "added" ? " (you added it)" : ""); }).join(", ")]);
    }
    var where = r.branch ? '<span class="mono">' + esc(r.branch) + "</span> · " + r.machine : r.wsKind === "main" ? esc(r.repo) + " · " + r.machine : r.wsKind === "scratch" ? "scratch · " + r.machine : r.machine;
    if (team && team.lead !== r && team.lead.machine !== r.machine) where += " (the lead is on " + team.lead.machine + ")";
    lines.push(["Works in", where]);
    if (W.activity[r.id] && r.pose === "working") lines.push(["Now", esc(W.activity[r.id])]);
    var own = readTokens(r.id);
    lines.push(["Tokens", own == null ? "not reported (" + esc(W.providers[r.provider].name) + ")" : formatTokens(own)]);
    if (team && team.partners.length && team.lead === r) {
      var t = sumTokens(team.members);
      lines.push(["Team tokens", formatTokens(t.sum) + (t.unreported.length ? ", " + t.unreported.map(function (m) { return esc(nameMember(m)); }).join(", ") + " not reported" : "")]);
    }
    return (
      '<div class="tfw-hover-h">' + drawFace(r, 28) + '<span><b>' + esc(r.title) + "</b><small>" + (r.role ? esc(r.role) + " · " : r.lead ? "" : team && team.partners.length ? "lead · " : "") + esc(W.providers[r.provider].name) + " · " + esc(r.model) + "</small></span></div>" +
      '<dl class="tfw-hover-dl">' + lines.map(function (l) { return "<dt>" + l[0] + "</dt><dd>" + l[1] + "</dd>"; }).join("") + "</dl>"
    );
  }

  /* ================================================================== the overview */

  /** Builds the overview and the thread pane inside the main pane, once. */
  function buildMain(mainEl) {
    if (els.ov) return;
    mainEl.innerHTML =
      '<div class="tfw-ov">' +
      '<header class="top tfw-top">' +
      '<nav class="pill tfw-switch" aria-label="Overview modes">' +
      MODES.map(function (m, i) {
        var icon = m === "office" ? Crew.icon("office", 15) : m === "threads" ? Crew.icon("list", 15) : drawOrgIcon();
        return '<button class="ptab" data-tfw-mode="' + m + '" aria-pressed="false" title="' + MODE_NAMES[m] + " (" + (i + 1) + ')">' + icon + MODE_NAMES[m] + "</button>";
      }).join("") +
      "</nav>" +
      '<span class="pill tfw-ctrl">' +
      '<button class="ptab" data-tfw-fold-to="leads" aria-pressed="false" title="Fold to leads only (F)">Leads only</button>' +
      '<button class="ptab" data-tfw-fold-to="everyone" aria-pressed="false" title="Show everyone (F)">Everyone</button>' +
      '<span class="pill-sep"></span>' +
      '<button class="pill-btn" data-tfw-standup-sel title="Ask the selected team for a one-line status each">' + Crew.icon("discussions", 15) + "Stand-up<kbd>S</kbd></button>" +
      (STATE === "spawn" ? '<span class="pill-sep"></span><button class="pill-btn" data-tfw-replay title="Play the moment again">' + Crew.icon("play", 14) + "Replay</button>" : "") +
      "</span>" +
      '<span class="spacer"></span>' +
      '<span class="pill tfw-sum" data-tfw-sum></span>' +
      "</header>" +
      '<div class="tfw-modes">' +
      '<section class="tfw-mode tfw-mode--office" data-tfw-pane="office"></section>' +
      '<section class="tfw-mode tfw-mode--threads" data-tfw-pane="threads"></section>' +
      '<section class="tfw-mode tfw-mode--org" data-tfw-pane="org"></section>' +
      "</div>" +
      '<div class="tfw-sel glass" role="dialog" aria-label="Selected" hidden></div>' +
      '<div class="tfw-brief pop" hidden></div>' +
      "</div>" +
      '<div class="tfw-thread" hidden></div>';
    els.ov = mainEl.querySelector(".tfw-ov");
    els.thread = mainEl.querySelector(".tfw-thread");
    els.sum2 = mainEl.querySelector("[data-tfw-sum]");
    els.sel = mainEl.querySelector(".tfw-sel");
    els.brief = mainEl.querySelector(".tfw-brief");
    els.panes = {};
    MODES.forEach(function (m) { els.panes[m] = mainEl.querySelector('[data-tfw-pane="' + m + '"]'); });
    wireMain();
  }

  /** Returns the Org Chart's icon: one card above two, in the icon family's stroke. */
  function drawOrgIcon() {
    return '<svg class="ic" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.4" y="1.9" width="5.2" height="3.6" rx="1.1"/><rect x="1.9" y="10.5" width="5" height="3.6" rx="1.1"/><rect x="9.1" y="10.5" width="5" height="3.6" rx="1.1"/><path d="M8 5.5v2.5M4.4 10.5V8h7.2v2.5"/></svg>';
  }

  /** The stage's hook: draws the overview, or the open thread when the overview is closed. */
  function drawMainPane(mainEl) {
    buildMain(mainEl);
    els.ov.hidden = !ui.overview;
    els.thread.hidden = ui.overview;
    var officeBtn = els.side.querySelector('.side-actions .icon-btn[title^="The office"]');
    if (officeBtn) officeBtn.classList.toggle("is-on", ui.overview);
    if (ui.overview) {
      showMode(ui.mode, true);
    } else {
      pauseOffice();
      shownMode = null;
      drawThreadPane();
    }
    markSelection();
    return true;
  }

  /** Draws the open thread with the stage's header, transcript and composer. */
  function drawThreadPane() {
    var r = firm.byId[ui.openId] || firm.byId.t3ds;
    var t = {};
    for (var k in r) t[k] = r[k];
    if (r.kind === "step") t.status = r.pose === "waiting" ? "question" : t.status;
    els.thread.innerHTML = drawTeamHeader(r) + api.drawTranscript(t) + api.drawComposer(t);
    els.thread.querySelectorAll("[data-open]").forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        openThread(a.dataset.open);
      });
    });
    var tx = els.thread.querySelector("[data-transcript]");
    if (tx) tx.scrollTop = tx.scrollHeight;
  }

  /**
   * Returns the open thread's header: its team as tabs named by role (the lead first), the team's
   * faces with a Stand-up button, then today's editor and more buttons. A lone thread keeps
   * today's header: its project and its title.
   */
  function drawTeamHeader(r) {
    var team = findTeam(r);
    var isTeam = !!(team && team.partners.length);
    var p = r.project ? W.projects.filter(function (x) { return x.id === r.project; })[0] : null;
    var tabs = isTeam
      ? team.members.map(function (m) {
          var mark = m.pose === "waiting" ? "waiting" : m.pose === "working" ? "working" : "idle";
          var age = m.pose === "idle" ? "<small>" + WH.ago(m.last) + "</small>" : "";
          return '<a class="ptab' + (m.id === r.id ? " is-on" : "") + '" href="#" data-open="' + m.id + '" title="' + esc(m.title) + '">' + Crew.mark(mark) + (m === team.lead ? "lead" : esc(nameMember(m))) + age + "</a>";
        }).join("")
      : "";
    return (
      '<header class="top tfw-thread-top">' +
      '<nav class="pill" aria-label="' + (isTeam ? "The team" : "The thread") + '">' +
      '<span class="pill-crumb">' + (p ? '<span class="proj proj--' + p.tint + '">' + p.name + "</span>" : '<span class="proj tfw-noproj">No project</span>') + "</span>" +
      '<span class="pill-title tfw-thread-title">' + esc(isTeam ? team.lead.title : r.title) + "</span>" +
      (isTeam ? '<span class="pill-sep"></span>' + tabs : "") +
      '<button class="icon-btn" title="Start a partner for this thread">' + Crew.icon("plus") + "</button>" +
      "</nav>" +
      '<span class="spacer"></span>' +
      (isTeam ? '<span class="pill"><button class="pill-btn" data-tfw-standup="' + team.id + '" title="Ask each member for a one-line status (S)">' + drawPile(team.members, 18) + "Stand-up</button></span>" : "") +
      '<span class="pill"><button class="icon-btn" title="Open in editor">' + Crew.icon("editor") + "</button></span>" +
      '<span class="pill"><button class="icon-btn" title="More">' + Crew.icon("more") + "</button></span>" +
      "</header>"
    );
  }

  /** Scrolls the sidebar so a session's row in the tree is in view, without moving the page. */
  function revealInSidebar(id, above) {
    var list = els.list;
    var rows = list.querySelectorAll('[data-tfw-id="' + id + '"]');
    var row = rows[rows.length - 1];
    if (!row) return;
    var top = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    if (top < list.scrollTop + 40 || top > list.scrollTop + list.clientHeight - 140) list.scrollTop = Math.max(0, top - (above == null ? 150 : above));
  }

  /** Shows a mode with a short cross-fade; the selection stays, and the new mode brings it into view. */
  var shownMode = null; // the mode on screen, null until the overview first shows

  function showMode(mode, instant) {
    var before = shownMode;
    shownMode = mode;
    ui.mode = mode;
    els.ov.dataset.mode = mode;
    els.ov.querySelectorAll("[data-tfw-mode]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.tfwMode === mode));
    });
    MODES.forEach(function (m) {
      els.panes[m].classList.toggle("is-shown", m === mode);
      els.panes[m].classList.toggle("is-instant", !!instant);
    });
    drawSelectionCard();
    if (mode === "office") mountOffice();
    else pauseOffice();
    if (mode === "threads") {
      drawThreads();
      if (before !== "threads" && ui.selected && (before || FOCUS_ON_LOAD)) scrollTableTo(ui.selected);
    }
    if (mode === "org") {
      drawOrg();
      if (before && before !== "org" && ui.selected) bringOrgIntoView(ui.selected, !!instant);
    }
  }

  /** Redraws whatever the change touched: the tree, the counts, the visible mode, the card. */
  function render() {
    rebuildFirm();
    drawSidebar();
    drawFoot();
    if (!els.ov) return;
    drawTopCounts();
    drawFoldControl();
    if (!ui.overview) return;
    if (ui.mode === "threads") drawThreads();
    if (ui.mode === "org") drawOrg();
    if (ui.mode === "office" && office.handle === null && !office.module) drawOfficePlaceholder();
    drawSelectionCard();
  }

  function drawTopCounts() {
    var c = countPoses();
    els.sum2.title = COUNT_NOTE;
    els.sum2.innerHTML =
      '<span class="tfw-sum-all"><b>' + firm.recs.length + "</b> sessions</span>" +
      "<span>" + Crew.mark("working") + "<b>" + c.working + "</b> working</span>" +
      '<span class="tfw-sum-you">' + Crew.mark("waiting") + "<b>" + c.waiting + "</b> waiting on you</span>" +
      "<span>" + Crew.mark("idle") + "<b>" + c.idle + "</b> idle</span>";
  }

  function drawFoldControl() {
    els.ov.querySelectorAll("[data-tfw-fold-to]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.tfwFoldTo === ui.fold));
    });
    var sel = firm.byId[ui.selected];
    var team = sel ? findTeam(sel) : null;
    var btn = els.ov.querySelector("[data-tfw-standup-sel]");
    btn.disabled = !(team && team.partners.length);
    btn.title = team && team.partners.length ? "Ask " + team.lead.title + " and its " + team.partners.length + (team.partners.length === 1 ? " partner" : " partners") + " for a one-line status (S)" : "Select a team to ask it for a stand-up";
  }

  /* ================================================================== Threads: the chain of command, wide */

  function drawThreads() {
    var pane = els.panes.threads;
    var top = pane.firstChild ? pane.firstChild.scrollTop : 0;
    var parts = [];
    parts.push(
      '<div class="tfw-tr tfw-tr--head" role="row"><div>Who works for whom</div><div>Model</div><div>Status</div><div>Started by</div><div class="tfw-num">Tokens</div><div></div></div>'
    );
    parts.push(drawRootRowWide());
    if (STATE === "away") parts.push('<div class="tfw-wide-memo">' + drawMemoStrip() + "</div>");
    parts.push(drawWaitingBand());
    firm.depts.forEach(function (d) { parts.push(drawDeptWide(d)); });
    parts.push(drawAssistantsWide());
    parts.push(drawWorkflowsWide());
    pane.innerHTML = '<div class="tfw-scroll"><div class="tfw-tbl" role="table">' + parts.join("") + "</div></div>";
    pane.firstChild.scrollTop = top;
    markTableSelection();
  }

  function markTableSelection() {
    els.panes.threads.querySelectorAll(".tfw-tr[data-tfw-id]").forEach(function (row) {
      row.classList.toggle("is-sel", row.dataset.tfwId === ui.selected);
    });
  }

  /** Returns the cells of a session's row after its name: model, status, started by, tokens. */
  function drawCells(r, tokensHtml) {
    var st = describeStatus(r);
    var by = describeStarter(r);
    var team = findTeam(r);
    var elsewhere = team && team.lead !== r && team.lead.machine !== r.machine;
    return (
      '<div class="tfw-td tfw-td--model">' + drawBrand(r.provider, 12) + "<span>" + esc(r.model) + (elsewhere ? '<small>on ' + esc(r.machine) + "</small>" : "") + "</span></div>" +
      '<div class="tfw-td tfw-td--st tfw-st--' + st.kind + '">' + Crew.mark(st.kind === "waiting" ? "waiting" : st.kind === "working" || st.kind === "queued" ? "working" : "idle") + "<span>" + st.text + "</span></div>" +
      '<div class="tfw-td tfw-td--by' + (joinedWhileAway(r) ? " is-new" : "") + '"><span>' + (by.added ? "you, added" : esc(by.who)) + "</span><small>" + esc(by.at) + "</small></div>" +
      '<div class="tfw-td tfw-num">' + (tokensHtml != null ? tokensHtml : drawTokenCell(readTokens(r.id), r)) + "</div>"
    );
  }

  function drawTokenCell(n, r) {
    if (n == null) return '<span class="tfw-nr" title="' + esc(W.providers[r.provider].name) + ' reports no usage">not reported</span>';
    return "<span>" + formatTokens(n) + "</span>";
  }

  function drawTeamTokenCell(team) {
    var t = sumTokens(team.members);
    if (!team.partners.length) return drawTokenCell(readTokens(team.lead.id), team.lead);
    return (
      '<span><small class="tfw-team-tag">team</small>' + (t.sum ? formatTokens(t.sum) : "-") + "</span>" +
      (t.unreported.length ? '<small class="tfw-nr">' + t.unreported.map(function (m) { return m === team.lead ? "lead" : esc(nameMember(m)); }).join(", ") + " not reported</small>" : "")
    );
  }

  function drawRootRowWide() {
    var t = sumTokens(firm.recs);
    var lone = Object.keys(firm.teams).filter(function (id) { return !firm.teams[id].partners.length && firm.teams[id].lead.startedBy === "user"; }).length;
    var teams = countTeams();
    return (
      '<div class="tfw-tr tfw-tr--root" role="row">' +
      '<div class="tfw-td tfw-td--name tfw-span2">' + Crew.you(30) + '<span class="tfw-name-text"><span class="tfw-name">Rogier</span><span class="tfw-sub">principal · ' +
      teams + " teams · " + lone + " on their own · " + firm.assistants.length + " assistants · " + firm.runs.length + " runs</span></span></div>" +
      '<div class="tfw-td tfw-td--st tfw-st--waiting">' + Crew.mark("waiting") + "<span>" + firm.waiting.length + " wait on you</span></div>" +
      '<div class="tfw-td tfw-td--by"><span>' + firm.recs.length + " sessions</span></div>" +
      '<div class="tfw-td tfw-num"><span>' + formatTokens(t.sum) + '</span><small class="tfw-nr">' + t.unreported.length + " not reported</small></div>" +
      '<div class="tfw-td"></div>' +
      "</div>"
    );
  }

  function drawWaitingBand() {
    var rows = firm.waiting.slice();
    if (ui.heldInBand.length) {
      // While a held row stays, the band keeps the order it had, so nothing shifts under the pointer.
      var keep = ui.bandOrder.filter(function (id) {
        return firm.byId[id] && (firm.byId[id].pose === "waiting" || ui.heldInBand.indexOf(id) !== -1);
      });
      rows = keep.map(function (id) { return firm.byId[id]; }).concat(rows.filter(function (r) { return keep.indexOf(r.id) === -1; }));
    }
    ui.bandOrder = rows.map(function (r) { return r.id; });
    if (!rows.length) return "";
    var oldest = firm.waiting.length ? WH.ago(firm.waiting.slice().sort(function (a, b) { return WH.minutes(a.last) - WH.minutes(b.last); })[0].last) : "";
    return (
      '<div class="tfw-band">' +
      '<div class="tfw-dh tfw-dh--you"><span class="tfw-dh-name">Waiting on you</span><b class="count count--you">' + firm.waiting.length + "</b>" + (oldest ? '<span class="tfw-dh-sub">oldest ' + oldest + "</span>" : "") + "</div>" +
      rows.map(function (r) {
        var team = findTeam(r);
        var run = r.kind === "step" ? findRun(r.run) : null;
        var name = team ? team.lead.title : run ? run.title : r.title;
        var asker = (team && team.lead !== r) || run ? "<b>" + esc(nameMember(r)) + "</b> asks · " : "";
        var answered = r.answer;
        return (
          '<div class="tfw-tr tfw-tr--lead tfw-tr--wait' + (answered ? " is-answered" : "") + '" role="row" data-tfw-id="' + r.id + '">' +
          '<div class="tfw-td tfw-td--name">' + drawFace(r, 30, answered ? "working" : "waiting") + '<span class="tfw-name-text"><span class="tfw-name">' + esc(name) + "</span>" +
          '<span class="tfw-sub tfw-sub--ask">' + (answered ? "Answered: " + esc(answered) : asker + formatAsk(r.ask)) + "</span></span></div>" +
          drawCells(r) +
          '<div class="tfw-td tfw-td--act">' + (answered ? '<button class="btn btn--quiet btn--sm" data-tfw-undo="' + r.id + '">' + Crew.icon("undo", 13) + "Undo</button>" : drawAnswerButtons(r)) + "</div>" +
          "</div>"
        );
      }).join("") +
      "</div>"
    );
  }

  function drawDeptWide(dept) {
    var p = dept.project;
    var recs = [];
    dept.teams.forEach(function (t) { recs = recs.concat(t.members); });
    var t = sumTokens(recs);
    var need = recs.filter(function (r) { return r.pose === "waiting"; }).length;
    var teams = dept.teams.filter(function (x) { return x.partners.length; }).length;
    var lone = dept.teams.length - teams;
    var bits = [];
    if (teams) bits.push(teams + (teams === 1 ? " team" : " teams"));
    if (lone) bits.push(lone + " on " + (lone === 1 ? "its" : "their") + " own");
    bits.push(recs.length + (recs.length === 1 ? " session" : " sessions"));
    return (
      '<div class="tfw-dept-wide">' +
      '<div class="tfw-dh tfw-dh--grid"><div class="tfw-dh-main">' + (p ? '<span class="proj proj--' + p.tint + '">' + p.name + "</span>" : '<span class="proj tfw-noproj">No project</span>') +
      '<span class="tfw-dh-sub">' + bits.join(" · ") + "</span>" +
      (need ? '<span class="st-need">' + need + (need === 1 ? " needs you" : " need you") + "</span>" : "") +
      '</div><div class="tfw-td tfw-num"><span>' + formatTokens(t.sum) + "</span>" + (t.unreported.length ? '<small class="tfw-nr">' + t.unreported.length + " not reported</small>" : "") + "</div><div></div></div>" +
      dept.teams.map(drawTeamWide).join("") +
      (dept.more ? '<div class="tfw-tr tfw-tr--more" role="row"><div class="tfw-td">' + dept.more + " more threads in " + p.name + "</div></div>" : "") +
      "</div>"
    );
  }

  function drawTeamWide(team) {
    var lead = team.lead;
    var isTeam = team.partners.length > 0;
    var sub = isTeam ? drawTeamVoice(team) : '<span class="tfw-voice">' + describePlaceText(lead) + "</span>";
    if (!isTeam && lead.pose === "waiting") sub = '<span class="tfw-voice tfw-voice--ask">' + esc(lead.askShort) + "</span>";
    return (
      '<div class="tfw-team-wide' + (isTeam ? " is-team" : "") + (live.bornAt[lead.id] ? " is-born" : "") + '">' +
      '<div class="tfw-tr tfw-tr--lead" role="row" data-tfw-id="' + lead.id + '">' +
      '<div class="tfw-td tfw-td--name">' + drawFace(lead, 30) + '<span class="tfw-name-text"><span class="tfw-name">' + esc(lead.title) + "</span>" +
      '<span class="tfw-sub">' + (isTeam ? drawPile(team.members, 14) : "") + sub + "</span>" + drawSaid(lead) + "</span></div>" +
      drawCells(lead, drawTeamTokenCell(team)) +
      '<div class="tfw-td tfw-td--act">' +
      (isTeam ? '<button class="btn btn--quiet btn--sm" data-tfw-standup="' + team.id + '" title="Ask each member for a one-line status (S)">' + Crew.icon("discussions", 13) + "Stand-up</button>" : "") +
      '<button class="btn btn--quiet btn--sm" data-tfw-brief="' + team.id + '" title="' + (isTeam ? "Message the lead or the whole team" : "Message the thread") + '">' + Crew.icon("compose", 13) + "Brief</button>" +
      '<button class="btn btn--quiet btn--sm" data-tfw-done="' + team.id + '" title="Mark ' + (isTeam ? "the team" : "it") + ' done">' + Crew.icon("check", 13) + "Done</button>" +
      "</div></div>" +
      team.partners.map(function (p, i) { return drawMemberWide(p, i === team.partners.length - 1); }).join("") +
      (live.standupAt[team.id] ? '<div class="tfw-tr tfw-tr--stamp" role="row"><div class="tfw-td">' + drawStandupStamp(team) + "</div></div>" : "") +
      "</div>"
    );
  }

  /** Returns where a lone thread works, as today's row says it. */
  function describePlaceText(r) {
    if (r.branch) return '<span class="mono">' + esc(r.branch) + "</span>";
    if (r.wsKind === "main") return esc(r.repo) + " · " + r.machine;
    if (r.wsKind === "scratch") return "scratch · " + r.machine;
    return "no workspace · " + r.machine;
  }

  function drawMemberWide(r, last, nameHtml) {
    if (ui.fold !== "everyone") return "";
    return (
      '<div class="tfw-tr tfw-tr--member' + (last ? " is-last" : "") + (live.bornAt[r.id] ? " is-born" : "") + '" role="row" data-tfw-id="' + r.id + '">' +
      '<div class="tfw-td tfw-td--name"><span class="tfw-elbow" aria-hidden="true"></span>' + drawFace(r, 22) +
      '<span class="tfw-name-text"><span class="tfw-name">' + (nameHtml || "<b>" + esc(nameMember(r)) + "</b>" + (r.role ? '<span class="tfw-of"> · ' + esc(r.title) + "</span>" : "")) + "</span>" +
      (r.pose === "waiting" ? '<span class="tfw-sub tfw-sub--ask">' + formatAsk(r.ask) + "</span>" : "") +
      drawSaid(r) + "</span></div>" +
      drawCells(r) +
      '<div class="tfw-td tfw-td--act"></div>' +
      "</div>"
    );
  }

  function drawAssistantsWide() {
    return (
      '<div class="tfw-dept-wide">' +
      '<div class="tfw-dh"><span class="tfw-dh-name">Assistants</span><span class="tfw-dh-sub">each with the threads and runs it started</span></div>' +
      firm.assistants.map(function (a) {
        var reports = a.teams.map(function (t) { return { rec: t.lead }; }).concat(
          a.runs.reduce(function (acc, item) { return acc.concat(item.steps.map(function (s) { return { rec: s, run: item.run }; })); }, [])
        );
        var t = sumTokens(reports.map(function (x) { return x.rec; }));
        return (
          '<div class="tfw-team-wide is-team">' +
          '<div class="tfw-tr tfw-tr--lead" role="row" data-tfw-id="' + a.id + '">' +
          '<div class="tfw-td tfw-td--name">' + Crew.face(a.name, { pose: a.pose, size: 30 }) + '<span class="tfw-name-text"><span class="tfw-name">' + a.name + '</span><span class="tfw-sub"><span class="tfw-voice">' + esc(a.info.title) + " · " + esc(a.info.doing) + "</span></span></span></div>" +
          '<div class="tfw-td tfw-td--model">' + drawBrand(a.info.provider, 12) + "<span>" + esc(a.info.model) + "</span></div>" +
          '<div class="tfw-td tfw-td--st tfw-st--' + (a.pose === "working" ? "working" : "idle") + '">' + Crew.mark(a.pose === "working" ? "working" : "idle") + "<span>" + (a.pose === "asleep" ? "Asleep" : a.pose === "working" ? "Working" : "Idle") + "</span></div>" +
          '<div class="tfw-td tfw-td--by"><span>you</span><small>set up</small></div>' +
          '<div class="tfw-td tfw-num">' + (reports.length ? "<span>" + (t.sum ? formatTokens(t.sum) : "-") + "</span>" + (t.unreported.length ? '<small class="tfw-nr">' + t.unreported.length + " not reported</small>" : "") : '<span class="tfw-nr">no reports</span>') + "</div>" +
          '<div class="tfw-td tfw-td--act"></div></div>' +
          reports.map(function (x, i) {
            var name = x.run ? "<b>" + esc(x.run.title) + '</b><span class="tfw-of"> · run, ' + esc(x.rec.role) + " step</span>" : "<b>" + esc(x.rec.title) + "</b>";
            return drawMemberWide(x.rec, i === reports.length - 1, name);
          }).join("") +
          "</div>"
        );
      }).join("") +
      "</div>"
    );
  }

  function drawWorkflowsWide() {
    return (
      '<div class="tfw-dept-wide">' +
      '<div class="tfw-dh"><span class="tfw-dh-name">Workflows</span><span class="tfw-dh-sub">' + firm.runs.length + " runs · each a department with the sessions of its steps</span></div>" +
      firm.runs.map(function (item) {
        var run = item.run;
        var st = describeRun(item);
        var t = sumTokens(item.steps);
        var place = item.steps.length ? describeStepPlace(run, item.steps[0]) + " · " + item.steps[0].role : run.status === "paused" ? "held: " + esc(run.pausedReason.split(";")[0]) : run.result ? esc(run.result.split(". ")[0]) + "." : "";
        return (
          '<div class="tfw-team-wide' + (item.steps.length ? " is-team" : "") + '">' +
          '<div class="tfw-tr tfw-tr--lead" role="row" data-tfw-id="' + item.id + '">' +
          '<div class="tfw-td tfw-td--name"><span class="tfw-run-tile">' + Crew.icon(run.status === "paused" ? "pause" : run.status === "completed" ? "check" : "workflows", 15) + '</span><span class="tfw-name-text"><span class="tfw-name">' + esc(run.title) + '</span><span class="tfw-sub"><span class="tfw-voice">' + esc(run.workflow) + " · " + place + "</span></span></span></div>" +
          '<div class="tfw-td tfw-td--model">' + (item.steps.length ? drawBrand(item.steps[0].provider, 12) + "<span>" + esc(item.steps[0].model) + "</span>" : '<span class="tfw-nr">' + esc(run.machine) + "</span>") + "</div>" +
          '<div class="tfw-td tfw-td--st tfw-st--' + (st.kind === "approval" ? "waiting" : st.kind === "working" ? "working" : "idle") + '">' + Crew.mark(st.kind === "approval" ? "waiting" : run.status === "paused" ? "paused" : run.status === "completed" ? "done" : "working") + "<span>" + st.long + "</span></div>" +
          '<div class="tfw-td tfw-td--by' + (STATE === "away" && run.origin !== "user" && WH.minutes(run.started) > WH.minutes(W.away.left) ? " is-new" : "") + '"><span>' + esc(describeOrigin(run)) + "</span><small>" + esc(run.started) + "</small></div>" +
          '<div class="tfw-td tfw-num">' + (item.steps.length ? drawTokenCell(t.unreported.length ? null : t.sum, item.steps[0]) : "") + "</div>" +
          '<div class="tfw-td tfw-td--act">' + (st.voice && st.voice.pose === "waiting" ? "" : "") + "</div></div>" +
          item.steps.map(function (s, i) { return drawMemberWide(s, i === item.steps.length - 1, "<b>" + esc(s.role) + '</b><span class="tfw-of"> · ' + esc(providerName(s)) + "</span>"); }).join("") +
          "</div>"
        );
      }).join("") +
      "</div>"
    );
  }

  /* ================================================================== the away memo */

  /**
   * Returns what the firm did while Rogier was away (09:01-09:41), from the world's lineage and
   * messages: who joined a team, what others started, which reports came in, and what waits.
   */
  function buildMemo() {
    var after = WH.minutes(W.away.left);
    var joined = firm.recs.filter(function (r) { return r.kind === "thread" && r.startedBy.indexOf("session:") === 0 && WH.minutes(r.started) > after; }).sort(compareStarted);
    var started = firm.recs
      .filter(function (r) { return r.kind === "thread" && r.startedBy.indexOf("assistant:") === 0 && WH.minutes(r.started) > after; })
      .map(function (r) { return { rec: r, who: r.startedBy.slice(10), what: r.title, at: r.started }; })
      .concat(
        firm.allRuns
          .filter(function (x) { return x.run.origin !== "user" && WH.minutes(x.run.started) > after && x.steps.length; })
          .map(function (x) { return { rec: x.steps[0], who: describeOrigin(x.run), what: x.run.title, at: x.run.started, run: true }; })
      )
      .sort(function (a, b) { return WH.minutes(a.at) - WH.minutes(b.at); });
    var reports = W.exchanges.filter(function (e) { return e.kind === "report" && WH.minutes(e.at) > after && firm.byId[e.from]; });
    return { joined: joined, started: started, reports: reports };
  }

  /** Returns the memo as a strip of four groups, each a few faces you can click. */
  function drawMemoStrip() {
    var m = buildMemo();
    function face(r, label) {
      return '<button class="tfw-memo-face" data-tfw-pick="' + r.id + '" title="' + esc(label) + '">' + drawFace(r, 22) + "</button>";
    }
    function group(n, word, faces, note) {
      return '<div class="tfw-memo-g"><div class="tfw-memo-n"><b>' + n + "</b>" + word + '</div><div class="tfw-memo-faces">' + faces + '</div><div class="tfw-memo-note">' + note + "</div></div>";
    }
    var leadsOfJoined = m.joined.map(function (r) { return nameMember(r); });
    return (
      '<div class="tfw-memo-strip">' +
      '<div class="tfw-memo-title"><span class="tfw-memo-kicker">While you were out</span><span>' + W.away.left + " to " + W.away.back + " · 40 minutes</span></div>" +
      group(m.joined.length, " joined a team", m.joined.map(function (r) { return face(r, nameMember(r) + " joined " + firm.byId[r.lead].title + " at " + r.started); }).join(""), esc(leadsOfJoined.join(", "))) +
      group(m.started.length, " started by others", m.started.map(function (x) { return face(x.rec, x.who + " started " + x.what + " at " + x.at); }).join(""), esc(m.started.map(function (x) { return x.who; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(", "))) +
      group(m.reports.length, " reports to leads", m.reports.map(function (e) { return face(firm.byId[e.from], nameMember(firm.byId[e.from]) + " at " + e.at + ": " + e.text); }).join(""), "newest " + (m.reports.length ? m.reports[m.reports.length - 1].at : "")) +
      group(firm.waiting.length, " wait on you", firm.waiting.map(function (r) { return face(r, (r.askShort || r.ask)); }).join(""), "oldest " + (firm.waiting.length ? WH.ago(firm.waiting.slice().sort(function (a, b) { return WH.minutes(a.last) - WH.minutes(b.last); })[0].last) : "")) +
      "</div>"
    );
  }

  /* ================================================================== the Org Chart */

  // The chart's grid. Each column's trunk runs down the gutter on its left, so leads get the whole
  // column; partners hang 22px in from their lead, off a spine 12px in.
  var ORG = { colW: 210, gap: 18, margin: 16, trunk: 9, indent: 22, spine: 12, gapSib: 8, gapTeam: 12, radius: 6 };
  var org = { s: 1, x: 0, y: 0, nodes: [], byKey: {}, w: 0, h: 0, built: false, pointer: null };

  /** Builds the Org Chart's trees: one per column, a department plate with its cards below. */
  function buildOrgColumns() {
    var all = ui.fold === "everyone";
    var cols = [];

    function node(key, kind, html, children, extra) {
      var n = { key: key, kind: kind, html: html, children: children || [], dashed: false };
      if (extra) for (var k in extra) n[k] = extra[k];
      return n;
    }

    function teamNode(team, asReport) {
      var lead = team.lead;
      var kids = [];
      if (team.partners.length >= 8) kids.push(node("span:" + team.id, "note", drawSpanNote(team)));
      if (all) {
        team.partners.forEach(function (p) {
          kids.push(node(p.id, "member", drawMemberCard(p), [], { dashed: p.joined === "added", rec: p, waiting: p.pose === "waiting" }));
        });
      }
      var voice = all ? lead : pickVoice(team.members);
      return node(lead.id, asReport ? "member" : "lead", asReport ? drawMemberCard(lead, lead.title) : drawLeadCard(team), kids, { rec: lead, waiting: voice.pose === "waiting" });
    }

    var deptCols = [];
    firm.depts.forEach(function (d) {
      var plate = node("dept:" + d.id, "plate", drawPlate(d), d.teams.map(function (t) { return teamNode(t); }));
      if (d.more) plate.children.push(node("more:" + d.id, "more", '<span class="tfw-more-n">' + d.more + "</span> more threads in " + esc(d.project.name)));
      if (d.project) deptCols.push({ roots: [plate], size: d.teams.reduce(function (n, t) { return n + t.members.length; }, 0) });
      else {
        var lightest = deptCols.slice().sort(function (a, b) { return a.size - b.size; })[0];
        if (lightest) lightest.roots.push(plate);
        else deptCols.push({ roots: [plate], size: 1 });
      }
    });
    cols = cols.concat(deptCols);

    var asst = node(
      "dept:assistants",
      "plate",
      drawNeutralPlate("Assistants", Crew.icon("sparkle", 14), firm.assistants.length, "Assistants start threads and runs of their own; those report to them"),
      firm.assistants.map(function (a) {
        var kids = [];
        if (all) {
          a.teams.forEach(function (t) { kids.push(teamNode(t, true)); });
          a.runs.forEach(function (item) {
            item.steps.forEach(function (s) { kids.push(node(s.id, "member", drawMemberCard(s, item.run.title, "run · " + s.role + " step"), [], { rec: s })); });
          });
        }
        return node(a.id, "lead", drawManagerCard(a), kids);
      })
    );
    cols.push({ roots: [asst] });

    // Runs at work get a card each; a paused run and a finished one share one quiet card.
    var working = firm.runs.filter(function (x) { return x.run.status === "running"; });
    var resting = firm.runs.filter(function (x) { return x.run.status !== "running"; });
    var flowKids = working.map(function (item) {
      return node(item.id, "run", drawRunCard(item), [], { rec: item.steps[0] && item.steps[0].pose === "waiting" ? item.steps[0] : null });
    });
    if (resting.length) flowKids.push(node("resting", "resting", drawRestingRuns(resting)));
    var flows = node(
      "dept:workflows",
      "plate",
      drawNeutralPlate("Workflows", Crew.icon("workflows", 14), firm.runs.length, firm.runs.length + " runs, each with the sessions of its steps"),
      flowKids
    );
    cols.push({ roots: [flows] });
    return cols;
  }

  /** Draws the Org Chart: measures every card, lays the trees out, draws the lines. Fits the firm the first time. */
  function drawOrg() {
    var pane = els.panes.org;
    var first = !org.built;
    if (first) {
      pane.innerHTML =
        '<div class="tfw-org" data-tfw-org>' +
        '<div class="tfw-org-canvas"><svg class="tfw-org-lines" aria-hidden="true"></svg><div class="tfw-org-nodes"></div></div>' +
        '<div class="pill tfw-zoom">' +
        '<span class="tfw-legend"><span><i class="tfw-lg-line"></i>started by</span><span><i class="tfw-lg-line tfw-lg-line--dash"></i>added by you</span><span><i class="tfw-lg-dot"></i>a message</span></span>' +
        '<span class="pill-sep"></span>' +
        '<button class="icon-btn" data-tfw-zoom="-1" title="Zoom out (-)">' + Crew.icon("minus", 15) + "</button>" +
        '<button class="pill-btn tfw-zoom-pct" data-tfw-zoom="fit" title="Fit the firm (0)">100%</button>' +
        '<button class="icon-btn" data-tfw-zoom="1" title="Zoom in (+)">' + Crew.icon("plus", 15) + "</button>" +
        "</div>" +
        "</div>";
      org.el = pane.querySelector("[data-tfw-org]");
      org.canvas = pane.querySelector(".tfw-org-canvas");
      org.svg = pane.querySelector(".tfw-org-lines");
      org.layer = pane.querySelector(".tfw-org-nodes");
      org.pct = pane.querySelector(".tfw-zoom-pct");
      wireOrg();
      org.built = true;
    }
    layoutOrg();
    if (first) fitOrg(true);
    else applyOrgTransform(false);
    markOrgSelection();
    if (first && FOCUS_ON_LOAD) bringOrgIntoView(ui.selected, true);
  }

  function layoutOrg() {
    var cols = buildOrgColumns();
    var natW = ORG.margin * 2 + cols.length * ORG.colW + (cols.length - 1) * ORG.gap;
    var all = [];
    var head = { key: "letterhead", kind: "letterhead", html: drawLetterhead(), children: [] };
    var you = { key: "you", kind: "principal", html: STATE === "away" ? drawMemoStrip() : drawPrincipal(), children: [] };

    function collect(n, depth, parent) {
      n.depth = depth;
      n.parent = parent;
      if (n.kind === "letterhead") n.w = natW - ORG.margin * 2;
      else if (n.kind === "principal") n.w = null;
      else n.w = ORG.colW - Math.max(0, depth - 1) * ORG.indent;
      all.push(n);
      n.children.forEach(function (c) { collect(c, depth + 1, n); });
    }
    collect(head, -1, null);
    collect(you, -1, null);
    cols.forEach(function (c) { c.roots.forEach(function (r) { collect(r, 0, null); }); });

    // Measure: every card at its width, at the origin, then read its height.
    var prevByKey = org.byKey;
    org.layer.innerHTML = all
      .map(function (n) {
        var r = n.rec;
        var pickable = ["lead", "member", "run", "run run--done"].indexOf(n.kind) !== -1;
        var cls = "tfw-node tfw-node--" + n.kind.replace(" ", " tfw-node--") +
          (n.waiting || (n.waiting === undefined && r && r.pose === "waiting") ? " is-waiting" : "") +
          (r && live.bornAt[r.id] && Date.now() - live.bornAt[r.id] < 2500 ? " is-born" : "") +
          (r && joinedWhileAway(r) ? " is-new" : "");
        return '<div class="' + cls + '" data-key="' + esc(n.key) + '"' + (pickable ? ' data-tfw-pick="' + esc(n.key) + '"' : "") + (n.w ? ' style="width:' + n.w + 'px"' : "") + ">" + n.html + "</div>";
      })
      .join("");
    var elByKey = {};
    org.layer.querySelectorAll(".tfw-node").forEach(function (el) { elByKey[el.dataset.key] = el; });
    all.forEach(function (n) {
      n.el = elByKey[n.key];
      n.h = n.el.offsetHeight;
      if (!n.w) n.w = n.el.offsetWidth;
    });

    // The head: the letterhead, then Rogier, centred; the bus runs under him.
    head.x = ORG.margin;
    head.y = 12;
    you.x = Math.round((natW - you.w) / 2);
    you.y = head.y + head.h + 12;
    var busY = you.y + you.h + 24;
    var top = busY + 20;

    // A column's roots and their leads stack under each other at the column's x; deeper cards indent.
    function place(n, x, y) {
      n.x = x;
      n.y = y;
      var cy = y + n.h;
      n.children.forEach(function (c, i) {
        cy += i === 0 ? (n.kind === "plate" ? 10 : ORG.gapSib) : n.kind === "plate" ? ORG.gapTeam : ORG.gapSib;
        cy = place(c, n.kind === "plate" ? x : x + ORG.indent, cy);
      });
      return cy;
    }
    var bottom = 0;
    cols.forEach(function (c, i) {
      c.x = ORG.margin + i * (ORG.colW + ORG.gap);
      var y = top;
      c.roots.forEach(function (r, j) {
        if (j > 0) y += 22;
        y = place(r, c.x, y);
      });
      bottom = Math.max(bottom, y);
    });

    all.forEach(function (n) {
      n.el.style.left = n.x + "px";
      n.el.style.top = n.y + "px";
      var prev = prevByKey[n.key];
      if (prev && !REDUCED && (prev.x !== n.x || prev.y !== n.y)) {
        n.el.style.transform = "translate(" + (prev.x - n.x) + "px," + (prev.y - n.y) + "px)";
        n.el.offsetWidth; // the start position takes effect before the move
        n.el.classList.add("is-moving");
        n.el.style.transform = "";
      }
    });

    org.nodes = all;
    org.byKey = {};
    all.forEach(function (n) { org.byKey[n.key] = { x: n.x, y: n.y, w: n.w, h: n.h, node: n }; });
    org.w = natW;
    org.h = bottom + 40;
    org.canvas.style.width = org.w + "px";
    org.canvas.style.height = org.h + "px";
    drawOrgLines(cols, you, busY);
  }

  /**
   * Draws the "started by" lines. Rogier's line runs down to the bus, along it to each column's
   * trunk in the gutter, and down the trunk into every department and every card he started.
   * A card's own line runs down its spine into each card it started. A partner Rogier added to a
   * team hangs from the lead on a dashed line.
   */
  function drawOrgLines(cols, you, busY) {
    var R = ORG.radius;
    var paths = [];
    var cx = Math.round(you.x + you.w / 2) + 0.5;
    var fresh = {};

    function edge(key, d, dashed) {
      paths.push('<path id="tfw-e-' + esc(key).replace(/[^\w-]/g, "_") + '" class="tfw-edge' + (dashed ? " is-dashed" : "") + (fresh[key] ? " is-drawn" : "") + '" data-edge="' + esc(key) + '" d="' + d + '"/>');
    }

    function fromRogier(tx, my, nodeX) {
      var dir = tx < cx ? -1 : 1;
      return (
        "M" + cx + " " + (you.y + you.h) + " V" + (busY - R) + " Q" + cx + " " + busY + " " + (cx + dir * R) + " " + busY +
        " H" + (tx - dir * R) + " Q" + tx + " " + busY + " " + tx + " " + (busY + R) +
        " V" + (my - R) + " Q" + tx + " " + my + " " + (tx + R) + " " + my + " H" + nodeX
      );
    }

    cols.forEach(function (c) {
      var tx = c.x - ORG.trunk + 0.5;
      c.roots.forEach(function (root) {
        edge(root.key, fromRogier(tx, root.y + root.h / 2, root.x), false);
        root.children.forEach(function (n) {
          if (n.rec && live.bornAt[n.rec.id] && Date.now() - live.bornAt[n.rec.id] < 2500) fresh[n.key] = true;
          edge(n.key, fromRogier(tx, n.y + Math.min(n.h / 2, 22), n.x), n.kind === "more");
        });
      });
    });

    org.nodes.forEach(function (n) {
      if (n.depth < 1) return;
      n.children.forEach(function (c) {
        var sx = n.x + ORG.spine + 0.5;
        var my = c.y + Math.min(c.h / 2, 20);
        if (c.rec && live.bornAt[c.rec.id] && Date.now() - live.bornAt[c.rec.id] < 2500) fresh[c.key] = true;
        edge(c.key, "M" + sx + " " + (n.y + n.h) + " V" + (my - R) + " Q" + sx + " " + my + " " + (sx + R) + " " + my + " H" + c.x, c.dashed || c.kind === "note" || c.kind === "more");
      });
    });

    org.svg.setAttribute("width", org.w);
    org.svg.setAttribute("height", org.h);
    org.svg.setAttribute("viewBox", "0 0 " + org.w + " " + org.h);
    org.svg.innerHTML = paths.join("");
    org.svg.querySelectorAll(".tfw-edge.is-drawn").forEach(function (p) {
      var len = p.getTotalLength();
      p.style.strokeDasharray = len;
      p.style.strokeDashoffset = len;
    });
    drawPulses();
  }

  /**
   * Draws the pulses of the exchange state: a dot that travels a "started by" line from the
   * partner that sent a message up to its lead. Each pulse is a CSS motion path along the line,
   * so it costs one compositor animation while the chart is visible and none under Reduce Motion.
   */
  function drawPulses() {
    if (STATE !== "exchange" || REDUCED) return;
    listShownExchanges().forEach(function (e, i) {
      var path = org.svg.querySelector('[data-edge="' + (e.kind === "report" ? e.from : e.to) + '"]');
      if (!path) return;
      var dot = document.createElement("i");
      dot.className = "tfw-pulse" + (e.kind === "report" ? " is-up" : "");
      dot.style.offsetPath = "path('" + path.getAttribute("d") + "')";
      dot.style.animationDelay = (0.2 + i * 1.9) + "s";
      org.layer.appendChild(dot);
    });
  }

  /** Returns the messages the exchange state shows travelling: the two newest reports, newest first. */
  function listShownExchanges() {
    return W.exchanges
      .filter(function (e) { return e.kind === "report" && firm.byId[e.from] && firm.byId[e.to]; })
      .slice(-2)
      .reverse();
  }

  /**
   * Returns the message a card shows inside it: in the exchange state, what a partner just sent its
   * lead; in the spawn state, the brief the lead gave its new partner. Cards grow; nothing floats.
   */
  function drawMessage(r) {
    if (STATE === "exchange") {
      var sent = listShownExchanges().filter(function (e) { return e.from === r.id; })[0];
      if (sent) return '<div class="tfw-msg"><span class="tfw-msg-h">' + Crew.icon("send", 11) + "to the lead · " + sent.at + "</span>" + esc(sent.text) + "</div>";
    }
    if (STATE === "spawn" && r.id === W.spawn.thread.id) {
      return '<div class="tfw-msg tfw-msg--in"><span class="tfw-msg-h">brief from the lead · ' + W.spawn.exchange.at + "</span>" + esc(W.spawn.exchange.text) + "</div>";
    }
    return "";
  }

  function drawLetterhead() {
    return (
      '<div class="tfw-lh"><span class="tfw-lh-rule" aria-hidden="true"></span><h2 class="tfw-lh-name">Rogier &amp; Co.</h2><span class="tfw-lh-rule" aria-hidden="true"></span></div>' +
      '<div class="tfw-lh-sub">' + esc(W.today) + " · " + W.now + "</div>"
    );
  }

  /** Returns Rogier's card: the principal, what he runs, the firm's usage, and what waits on him. */
  function drawPrincipal() {
    var t = sumTokens(firm.recs);
    var teams = countTeams();
    return (
      '<div class="tfw-you">' + Crew.you(30) +
      '<span class="tfw-you-name"><b>Rogier</b><small>principal</small></span>' +
      '<span class="tfw-you-sep"></span>' +
      '<span class="tfw-you-fact"><span><b>' + teams + "</b> teams · <b>" + firm.recs.length + "</b> sessions</span><small>" + firm.assistants.length + " assistants · " + firm.runs.length + " runs</small></span>" +
      '<span class="tfw-you-sep"></span>' +
      '<span class="tfw-you-fact"><span><b>' + formatTokens(t.sum) + "</b> tokens</span><small>" + t.unreported.length + " sessions not reported</small></span>" +
      drawSpanChip() +
      (firm.waiting.length
        ? '<span class="tfw-you-sep"></span><span class="tfw-you-wait"><span class="tfw-you-faces">' +
          firm.waiting.map(function (r) { return '<button data-tfw-pick="' + r.id + '" title="' + esc(r.askShort) + '">' + drawFace(r, 22, "waiting") + "</button>"; }).join("") +
          "</span><b>" + firm.waiting.length + "</b> wait on you</span>"
        : "") +
      "</div>"
    );
  }

  /** Returns a card's token roll-up: "1.73M + 1 unreported", or "not reported" when nobody reports. */
  function drawRollup(t) {
    if (!t.sum && !t.unreported.length) return "";
    if (!t.sum) return "<small>not reported</small>";
    return formatTokens(t.sum) + (t.unreported.length ? "<small> + " + t.unreported.length + " unreported</small>" : "");
  }

  /** Returns the principal's span-of-control chip when a lead manages eight or more; it selects that lead. */
  function drawSpanChip() {
    var wide = Object.keys(firm.teams).map(function (id) { return firm.teams[id]; }).filter(function (t) { return t.partners.length >= 8; })[0];
    if (!wide) return "";
    return (
      '<span class="tfw-you-sep"></span><button class="tfw-you-span" data-tfw-pick="' + wide.id + '" title="' + esc(wide.lead.title) + '">' +
      "<b>" + esc(wide.lead.model) + " is managing " + wide.partners.length + "</b><small>in " + esc(wide.lead.project) + " · show</small></button>"
    );
  }

  function drawPlate(dept) {
    var p = dept.project;
    var recs = [];
    dept.teams.forEach(function (t) { recs = recs.concat(t.members); });
    var t = sumTokens(recs);
    var teams = dept.teams.filter(function (x) { return x.partners.length; }).length;
    return (
      '<div class="tfw-plate' + (p ? " proj--" + p.tint : " tfw-plate--none") + '">' +
      '<span class="tfw-plate-name">' + (p ? '<span class="proj proj--' + p.tint + '">' + p.name + "</span>" : '<span class="proj tfw-noproj">No project</span>') + "</span>" +
      '<b class="count" title="' + recs.length + (recs.length === 1 ? " session" : " sessions") + '">' + recs.length + "</b><span class=\"spacer\"></span>" +
      '<span class="tfw-plate-tok">' + (t.sum ? formatTokens(t.sum) : "") + "</span>" +
      "</div>"
    );
  }

  function drawNeutralPlate(name, icon, count, title) {
    return '<div class="tfw-plate tfw-plate--none"><span class="tfw-plate-name"><span class="tfw-plate-icon">' + icon + "</span>" + name + '</span><b class="count" title="' + esc(title) + '">' + count + '</b><span class="spacer"></span></div>';
  }

  /** Returns a lead's card: face, title, model and status, its ask, and its team's roll-up. */
  function drawLeadCard(team) {
    var lead = team.lead;
    var st = describeStatus(lead);
    var isTeam = team.partners.length > 0;
    var voice = ui.fold === "leads" && isTeam ? pickVoice(team.members) : lead;
    var ask = voice.pose === "waiting" ? '<div class="tfw-card-ask">' + (voice === lead ? "" : "<b>" + esc(nameMember(voice)) + "</b> asks · ") + esc(voice.askShort) + "</div>" : "";
    var t = sumTokens(team.members);
    var foot = isTeam
      ? '<div class="tfw-card-foot">' + (ui.fold === "leads" ? drawPile(team.members, 14) : "<span>team of " + team.members.length + "</span>") + '<span class="tfw-card-tok">' + drawRollup(t) + "</span></div>"
      : "";
    return (
      '<div class="tfw-card" ' + hueStyle(lead) + ">" +
      '<div class="tfw-card-top">' + drawFace(lead, 28) + '<div class="tfw-card-title">' + esc(lead.title) + "</div></div>" +
      '<div class="tfw-card-meta">' + drawBrand(lead.provider, 11) + '<span class="tfw-model">' + esc(lead.model) + '</span><i>·</i><span class="tfw-st--' + st.kind + '">' + st.text + "</span></div>" +
      ask + drawSaid(lead, "tfw-said--card") + foot +
      (joinedWhileAway(lead) ? '<span class="tfw-new">new ' + lead.started + "</span>" : "") +
      "</div>"
    );
  }

  /** Returns a partner's card: its role first, then provider, model and status. */
  function drawMemberCard(r, title, note) {
    var st = describeStatus(r);
    var team = findTeam(r);
    var elsewhere = team && team.lead !== r && team.lead.machine !== r.machine;
    var name = title ? esc(title) : "<b>" + esc(nameMember(r)) + '</b><span class="tfw-of"> · ' + esc(providerName(r)) + "</span>";
    return (
      '<div class="tfw-card tfw-card--member">' +
      '<div class="tfw-card-top">' + drawFace(r, 22) + '<div class="tfw-card-name">' + name + "</div></div>" +
      '<div class="tfw-card-meta">' + (title ? drawBrand(r.provider, 11) : "") + '<span class="tfw-model">' + esc(r.model) + '</span><i>·</i><span class="tfw-st--' + st.kind + '">' + st.text + "</span></div>" +
      (note || elsewhere ? '<div class="tfw-card-note">' + (note ? esc(note) : "on " + esc(r.machine) + ", the lead on " + esc(team.lead.machine)) + "</div>" : "") +
      (r.pose === "waiting" ? '<div class="tfw-card-ask">' + esc(r.askShort) + "</div>" : "") +
      drawMessage(r) +
      drawSaid(r, "tfw-said--card") +
      (live.bornAt[r.id] ? '<span class="tfw-new">new hire · ' + r.started + "</span>" : joinedWhileAway(r) ? '<span class="tfw-new">joined ' + r.started + "</span>" : "") +
      "</div>"
    );
  }

  function drawManagerCard(a) {
    var reports = a.teams.length + a.runs.reduce(function (n, x) { return n + x.steps.length; }, 0);
    var t = sumTokens(a.teams.map(function (x) { return x.lead; }).concat(a.runs.reduce(function (acc, x) { return acc.concat(x.steps); }, [])));
    return (
      '<div class="tfw-card">' +
      '<div class="tfw-card-top">' + Crew.face(a.name, { pose: a.pose, size: 28 }) + '<div class="tfw-card-title">' + a.name + '<small>' + esc(a.info.title) + "</small></div></div>" +
      '<div class="tfw-card-meta">' + drawBrand(a.info.provider, 11) + '<span class="tfw-model">' + esc(a.info.model) + '</span><i>·</i><span class="tfw-st--' + (a.pose === "working" ? "working" : "idle") + '">' + (a.pose === "working" ? "Working" : a.pose === "asleep" ? "Asleep" : "Idle") + "</span></div>" +
      '<div class="tfw-card-foot"><span>' + (reports ? reports + (reports === 1 ? " report" : " reports") : "no reports") + '</span><span class="tfw-card-tok">' + drawRollup(t) + "</span></div>" +
      "</div>"
    );
  }

  /**
   * Returns a run's card: a small department. Its steps are dots; the session of its current step
   * sits inside it as one row, which selects that session.
   */
  function drawRunCard(item) {
    var run = item.run;
    var dots = run.steps.map(function (s) {
      return '<i class="tfw-step tfw-step--' + s.state + '" title="' + esc(s.label) + ": " + s.state + '"></i>';
    }).join("");
    return (
      '<div class="tfw-card tfw-card--run">' +
      '<div class="tfw-card-top"><span class="tfw-run-tile">' + Crew.icon("workflows", 14) + '</span><div class="tfw-card-title">' + esc(run.title) + "</div></div>" +
      '<div class="tfw-card-meta"><span class="tfw-steps">' + dots + '</span><span class="tfw-model">' + (run.title.indexOf(run.workflow) === 0 ? "" : esc(run.workflow) + ", ") + "by " + esc(describeOrigin(run)) + "</span></div>" +
      item.steps.map(function (s) {
        var st = describeStatus(s);
        return (
          '<button class="tfw-staff' + (s.pose === "waiting" ? " is-waiting" : "") + '" data-tfw-pick="' + s.id + '">' + drawFace(s, 18) +
          '<span class="tfw-staff-name"><b>' + esc(s.role) + '</b><span class="tfw-of"> · ' + esc(providerName(s)) + "</span></span>" +
          '<span class="tfw-st--' + st.kind + '">' + st.text + "</span>" +
          (s.pose === "waiting" ? '<span class="tfw-staff-ask">' + esc(s.askShort) + "</span>" : "") +
          "</button>"
        );
      }).join("") +
      "</div>"
    );
  }

  /** Returns one quiet card for the runs that are not at work: paused by a Bound, or finished. */
  function drawRestingRuns(items) {
    return (
      '<div class="tfw-resting">' +
      items.map(function (x) {
        var run = x.run;
        var paused = run.status === "paused";
        return (
          '<button class="tfw-resting-row" data-tfw-pick="' + x.id + '">' + Crew.icon(paused ? "pause" : "check", 13) +
          '<span class="tfw-resting-name">' + esc(run.title) + "</span><span>" + (paused ? "paused" : "done " + esc(run.ended)) + "</span></button>"
        );
      }).join("") +
      "</div>"
    );
  }

  /** Returns the span-of-control note a lead gets when it manages eight or more. */
  function drawSpanNote(team) {
    var started = team.partners.filter(function (p) { return p.joined !== "added"; }).length;
    var added = team.partners.length - started;
    return (
      '<div class="tfw-span"><b>' + esc(team.lead.model) + " is managing " + team.partners.length + "</b>" +
      "<span>" + started + " it started" + (added ? ", " + added + " you added" : "") + ". Most leads manage 1 or 2.</span></div>"
    );
  }

  /* ---------------------------------------------------------- Org Chart: pan, zoom, light */

  /** Returns the room the floating selection card takes at the bottom left: { right, top } in view pixels, or null. */
  function measureCardRoom() {
    if (!els.sel || els.sel.hidden || els.sel.classList.contains("is-docked")) return null;
    return { right: els.sel.offsetLeft + els.sel.offsetWidth + 12, top: els.sel.offsetTop - 14 };
  }

  /**
   * Fits the firm to the view: as wide as it fits, never above 100%. When the selection card shows,
   * the scale also keeps every card in the columns under it clear of it, as long as that leaves
   * the chart at 80% or more; past that (the swarm) the chart keeps its width and pans clear.
   */
  function fitOrg(instant) {
    var w = org.el.clientWidth;
    var h = org.el.clientHeight;
    var s = Math.max(0.8, Math.min(1, (w - 8) / org.w, (h - 60) / org.h));
    var room = measureCardRoom();
    if (room) {
      for (var i = 0; i < 3; i++) {
        var x0 = (w - org.w * s) / 2;
        var bottom = 0;
        org.nodes.forEach(function (n) {
          if (n.depth >= 0 && x0 + n.x * s < room.right) bottom = Math.max(bottom, n.y + n.h);
        });
        var clear = bottom ? (room.top - 52) / bottom : s;
        if (clear >= 0.8) s = Math.min(s, clear);
      }
    }
    org.s = s;
    org.x = Math.round((w - org.w * org.s) / 2);
    org.y = 52;
    applyOrgTransform(!instant);
  }

  function applyOrgTransform(glide) {
    org.canvas.classList.toggle("is-gliding", !!glide && !REDUCED);
    org.canvas.style.transform = "translate(" + org.x + "px," + org.y + "px) scale(" + org.s + ")";
    org.pct.textContent = Math.round(org.s * 100) + "%";
  }

  function zoomOrg(factor, cx, cy) {
    var s = Math.max(0.4, Math.min(1.6, org.s * factor));
    if (cx == null) {
      cx = org.el.clientWidth / 2;
      cy = org.el.clientHeight / 2;
    }
    org.x = cx - ((cx - org.x) * s) / org.s;
    org.y = cy - ((cy - org.y) * s) / org.s;
    org.s = s;
  }

  /**
   * Pans the chart so a card is in view. A card outside the comfortable area (clear of the top bar
   * and of the selection card) is brought to a third of the way down, so the team under it shows.
   */
  function bringOrgIntoView(key, instant) {
    var inner = org.byKey[key] ? null : org.layer.querySelector('[data-tfw-pick="' + key + '"]');
    var box = org.byKey[key] || (inner && inner.closest(".tfw-node") ? org.byKey[inner.closest(".tfw-node").dataset.key] : null);
    if (!box) return;
    var vw = org.el.clientWidth;
    var vh = org.el.clientHeight;
    var x = org.x + box.x * org.s;
    var y = org.y + box.y * org.s;
    var w = box.w * org.s;
    var h = box.h * org.s;
    var nx = org.x;
    var ny = org.y;
    if (x < 16) nx += 16 - x;
    if (x + w > vw - 16) nx -= x + w - (vw - 16);
    // The selection card covers the bottom left; the zoom pill only the bottom right corner.
    var floor = x < 420 ? vh - 200 : vh - 72;
    if (y < 64 || y + h > floor) ny += Math.round(vh * 0.3) - y;
    // Never pan past the end of the chart: its bottom stays at or below the bottom of the view.
    var room = measureCardRoom();
    ny = Math.max(ny, Math.min(52, (room ? room.top : vh - 24) - org.h * org.s));
    ny = Math.min(52, ny);
    if (nx === org.x && ny === org.y) return;
    org.x = nx;
    org.y = ny;
    applyOrgTransform(!instant);
  }

  function markOrgSelection() {
    if (!org.built) return;
    org.layer.querySelectorAll(".tfw-node, .tfw-resting-row, .tfw-staff").forEach(function (el) {
      el.classList.toggle("is-sel", (el.dataset.key || el.dataset.tfwPick) === ui.selected);
    });
  }

  /** Lights a card's chain of command: everyone above it up to Rogier, and everyone it started. */
  function lightChain(key) {
    var lit = {};
    var box = org.byKey[key];
    if (!box) return;
    var n = box.node;
    for (var up = n; up; up = up.parent) lit[up.key] = true;
    (function down(x) {
      x.children.forEach(function (c) {
        lit[c.key] = true;
        down(c);
      });
    })(n);
    lit.you = true;
    org.el.classList.add("has-lit");
    org.layer.querySelectorAll(".tfw-node").forEach(function (el) {
      el.classList.toggle("is-lit", !!lit[el.dataset.key]);
    });
    org.svg.querySelectorAll(".tfw-edge").forEach(function (p) {
      p.classList.toggle("is-lit", !!lit[p.dataset.edge]);
    });
  }

  function unlightChain() {
    if (!org.built) return;
    org.el.classList.remove("has-lit");
  }

  function wireOrg() {
    var el = org.el;
    el.addEventListener("wheel", function (e) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        var r = el.getBoundingClientRect();
        zoomOrg(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      } else {
        org.x -= e.deltaX;
        org.y -= e.deltaY;
      }
      applyOrgTransform(false);
    }, { passive: false });
    el.addEventListener("pointerdown", function (e) {
      if (e.target.closest(".tfw-zoom, [data-tfw-pick], button, .tfw-bubble")) return;
      org.pointer = { x: e.clientX, y: e.clientY, ox: org.x, oy: org.y };
      el.setPointerCapture(e.pointerId);
      el.classList.add("is-panning");
    });
    el.addEventListener("pointermove", function (e) {
      if (org.pointer) {
        org.x = org.pointer.ox + e.clientX - org.pointer.x;
        org.y = org.pointer.oy + e.clientY - org.pointer.y;
        applyOrgTransform(false);
        return;
      }
      var card = e.target.closest(".tfw-node[data-tfw-pick]");
      var key = card ? card.dataset.key : null;
      if (key !== ui.hoverId) {
        ui.hoverId = key;
        if (key) lightChain(key);
        else unlightChain();
      }
    });
    el.addEventListener("pointerup", function () {
      org.pointer = null;
      el.classList.remove("is-panning");
    });
    el.addEventListener("pointerleave", function () {
      ui.hoverId = null;
      unlightChain();
    });
    el.addEventListener("dblclick", function (e) {
      var card = e.target.closest(".tfw-node[data-tfw-pick]");
      if (card && firm.byId[card.dataset.key]) openThread(card.dataset.key);
    });
    el.querySelector(".tfw-zoom").addEventListener("click", function (e) {
      var b = e.target.closest("[data-tfw-zoom]");
      if (!b) return;
      if (b.dataset.tfwZoom === "fit") fitOrg(false);
      else {
        zoomOrg(b.dataset.tfwZoom === "1" ? 1.2 : 1 / 1.2);
        applyOrgTransform(true);
      }
    });
  }

  /* ================================================================== the Office */

  var office = { handle: null, module: null, paused: false };

  /** Mounts the Dollhouse the first time the Office is shown, or resumes it; draws the elevation until the module exists. */
  function mountOffice() {
    var mod = window.OfficeModes && window.OfficeModes[OFFICE_KEY];
    if (!mod) {
      drawOfficePlaceholder();
      return;
    }
    if (office.handle) {
      if (office.paused) office.handle.resume();
      office.paused = false;
      office.handle.select(ui.selected || null);
      return;
    }
    office.module = mod;
    var host = document.createElement("div");
    host.className = "tfw-office-host";
    els.panes.office.innerHTML = "";
    els.panes.office.appendChild(host);
    try {
      office.handle = mod.mount(host, {
        world: W,
        theme: ROOT.dataset.theme || "whitehaven",
        state: STATE,
        selected: ui.selected || null,
        reducedMotion: REDUCED,
        onSelect: function (id) { select(id, "office"); },
        onOpen: function (id) { openThread(id); },
      });
    } catch (err) {
      office.handle = null;
      office.module = null;
      console.error("The Office module failed to mount:", err);
      drawOfficePlaceholder();
    }
  }

  function pauseOffice() {
    if (office.handle && !office.paused) {
      office.handle.pause();
      office.paused = true;
    }
  }

  /**
   * Draws the Dollhouse's elevation while the 3D module is missing: the building cut open from the
   * front, a floor per project, a room per team sized by its headcount, the assistants on the
   * mezzanine, the runs on the ground floor and the café in the basement.
   */
  function drawOfficePlaceholder() {
    var pane = els.panes.office;
    function room(label, recs, tint, id, extra) {
      return (
        '<div class="tfw-room' + (tint ? " proj--" + tint : "") + (recs.some(function (r) { return r.pose === "waiting"; }) ? " is-waiting" : "") + '" style="flex-grow:' + Math.max(1, recs.length) + '"' + (id ? ' data-tfw-pick="' + esc(id) + '"' : "") + ">" +
        '<span class="tfw-room-faces">' + (extra || "") + recs.map(function (r) { return drawFace(r, 22); }).join("") + "</span>" +
        '<span class="tfw-room-label">' + esc(label) + "</span></div>"
      );
    }
    function floor(name, rooms) {
      return '<div class="tfw-floor"><span class="tfw-floor-name">' + name + '</span><div class="tfw-floor-rooms">' + rooms + "</div></div>";
    }
    var floors = [];
    floors.push(floor("Penthouse", room("Your office", firm.waiting, null, null, Crew.you(22))));
    firm.depts.forEach(function (d) {
      if (!d.project) return;
      floors.push(floor(esc(d.project.name), d.teams.map(function (t) { return room(t.lead.title, t.members, d.project.tint, t.id); }).join("")));
    });
    floors.push(floor("Mezzanine", firm.assistants.map(function (a) {
      return '<div class="tfw-room" style="flex-grow:1" data-tfw-pick="' + a.id + '"><span class="tfw-room-faces">' + Crew.face(a.name, { pose: a.pose, size: 22 }) + '</span><span class="tfw-room-label">' + a.name + "</span></div>";
    }).join("")));
    floors.push(floor("Ground floor", firm.allRuns.filter(function (x) { return x.steps.length; }).map(function (x) { return room(x.run.title, x.steps, null, x.id); }).join("")));
    var cafe = firm.depts.filter(function (d) { return !d.project; })[0];
    floors.push(floor("Basement", room("Café des Égarés", cafe ? cafe.teams.map(function (t) { return t.lead; }) : [], null, null)));
    pane.innerHTML =
      '<div class="tfw-house-wrap">' +
      '<div class="tfw-house">' +
      '<div class="tfw-roof"><span class="tfw-roof-name">Rogier &amp; Co.</span></div>' +
      '<div class="tfw-house-body">' + floors.join("") + '<div class="tfw-lift" aria-hidden="true"><i></i></div></div>' +
      '<div class="tfw-ground"></div>' +
      "</div>" +
      '<p class="tfw-house-note">' + Crew.icon("office", 14) + "The Dollhouse in 3D is the Office module's; until it loads, this is its elevation. Click a room to select it.</p>" +
      "</div>";
  }

  /* ================================================================== the selection card */

  /** Returns what an id names: a session, an assistant or a run, or null. */
  function findItem(id) {
    if (!id) return null;
    if (firm.byId[id]) return { type: "session", rec: firm.byId[id] };
    var a = firm.assistants.filter(function (x) { return x.id === id; })[0];
    if (a) return { type: "assistant", assistant: a };
    var run = firm.allRuns.filter(function (x) { return x.id === id; })[0];
    if (run) return { type: "run", item: run };
    return null;
  }

  /**
   * Draws the selection card. Over the Office and the Org Chart it floats at the bottom left; in
   * Threads it docks along the bottom of the pane, and the table ends above it, so it never
   * covers a row.
   */
  function drawSelectionCard() {
    var el = els.sel;
    var it = findItem(ui.selected);
    var docked = ui.mode === "threads";
    el.classList.toggle("is-docked", docked);
    if (!it || !ui.overview) {
      el.hidden = true;
      els.ov.style.setProperty("--tfw-dock", "0px");
      return;
    }
    el.hidden = false;
    if (it.type === "assistant") el.innerHTML = drawAssistantSelection(it.assistant);
    else if (it.type === "run") el.innerHTML = drawRunSelection(it.item);
    else el.innerHTML = drawSessionSelection(it.rec);
    el.querySelector(".tfw-sel-a").insertAdjacentHTML("beforeend", '<button class="icon-btn icon-btn--sm tfw-sel-x tfw-sel-x--dock" data-tfw-clear title="Clear the selection (esc)">' + Crew.icon("close", 13) + "</button>");
    els.ov.style.setProperty("--tfw-dock", docked ? el.offsetHeight + "px" : "0px");
  }

  function drawSessionSelection(r) {
    var team = findTeam(r);
    var st = describeStatus(r);
    var by = describeStarter(r);
    var run = r.kind === "step" ? findRun(r.run) : null;
    var place;
    if (run) place = "<b>" + esc(r.role) + '</b> in the run <span class="tfw-sel-of">' + esc(run.title) + "</span>";
    else if (team && team.lead !== r) place = '<span class="chip chip--who" ' + hueStyle(r) + ">" + esc(nameMember(r)) + '</span> in <span class="tfw-sel-of">' + esc(team.lead.title) + "</span>";
    else if (team && team.partners.length) place = "<b>lead</b> of " + team.members.length;
    else place = r.lead ? "" : by.who === "you" ? "on its own" : "started by " + esc(by.who);
    var proj = r.project ? W.projects.filter(function (p) { return p.id === r.project; })[0] : null;
    var starter =
      by.added ? "Started by you at " + by.at + ", added to the lead's team"
      : by.who === "the lead" ? "Started by the lead at " + by.at
      : by.who === "its run" ? "Started by its run at " + by.at
      : "Started by " + esc(by.who) + " at " + by.at;
    var own = readTokens(r.id);
    var tokens = own == null ? "usage not reported" : formatTokens(own) + " tokens";
    if (team && team.lead === r && team.partners.length) {
      var t = sumTokens(team.members);
      tokens = "team " + formatTokens(t.sum) + (t.unreported.length ? " + " + t.unreported.length + " unreported" : "");
    }
    var body;
    if (r.answer) {
      body = '<div class="tfw-sel-q tfw-sel-q--done">Answered: ' + esc(r.answer) + ". It is working again.</div>";
    } else if (r.pose === "waiting") {
      body = '<div class="tfw-sel-q">' + formatAsk(r.ask) + "</div>";
    } else {
      var said = live.standup[r.id] && live.standup[r.id].said ? live.standup[r.id].text : null;
      var h = W.headlines[r.id];
      var line = said || (h && h.length ? h[h.length - 1].text : r.result) || "";
      body = line ? '<div class="tfw-sel-line2">' + (said ? '<span class="tfw-sel-tag">stand-up</span>' : "") + esc(line) + "</div>" : "";
    }
    var actions = r.pose === "waiting" && !r.answer ? drawAnswerButtons(r) : team && team.partners.length ? '<button class="btn btn--quiet btn--sm" data-tfw-standup="' + team.id + '">' + Crew.icon("discussions", 13) + "Stand-up</button>" : "";
    return (
      '<div class="tfw-sel-h">' + drawFace(r, 34) +
      '<span class="who-text"><span class="who-name">' + esc(r.title) + "</span>" +
      '<span class="tfw-sel-sub">' + (place ? "<span>" + place + "</span>" : "") + (proj ? '<span class="proj proj--' + proj.tint + '">' + proj.name + "</span>" : "") + '<span class="tfw-st--' + st.kind + '">' + st.text.toLowerCase() + "</span></span></span>" +
      '<button class="icon-btn icon-btn--sm tfw-sel-x" data-tfw-clear title="Clear the selection (esc)">' + Crew.icon("close", 13) + "</button></div>" +
      '<div class="tfw-sel-by">' + Crew.icon("user", 13) + "<span>" + starter + '</span><span class="tfw-sel-dot">·</span><span>' + esc(providerName(r)) + " " + esc(r.model) + '</span><span class="tfw-sel-dot">·</span><span>' + tokens + "</span></div>" +
      body +
      '<div class="tfw-sel-a">' + actions + '<span class="spacer"></span><button class="btn btn--sm" data-tfw-open="' + r.id + '">Open thread' + Crew.icon("chev-r", 13) + "</button></div>"
    );
  }

  function drawAssistantSelection(a) {
    var started = a.teams.map(function (t) { return esc(t.lead.title) + " (" + t.lead.started + ")"; }).concat(a.runs.map(function (x) { return "the run " + esc(x.run.title) + " (" + x.run.started + ")"; }));
    return (
      '<div class="tfw-sel-h">' + Crew.face(a.name, { pose: a.pose, size: 34 }) +
      '<span class="who-text"><span class="who-name">' + a.name + '</span><span class="tfw-sel-sub"><span>' + esc(a.info.title) + "</span><span>" + Crew.poseWord(a.pose) + "</span></span></span>" +
      '<button class="icon-btn icon-btn--sm tfw-sel-x" data-tfw-clear title="Clear the selection (esc)">' + Crew.icon("close", 13) + "</button></div>" +
      '<div class="tfw-sel-by">' + drawBrand(a.info.provider, 12) + "<span>" + esc(W.providers[a.info.provider].name) + " · " + esc(a.info.model) + '</span><span class="tfw-sel-dot">·</span><span>' + esc(a.info.doing) + "</span></div>" +
      '<div class="tfw-sel-line2">' + (started.length ? "Started " + started.join(" and ") + "." : "Has started nothing today.") + "</div>" +
      '<div class="tfw-sel-a"><span class="spacer"></span><button class="btn btn--sm">Open ' + a.name + Crew.icon("chev-r", 13) + "</button></div>"
    );
  }

  function drawRunSelection(item) {
    var run = item.run;
    var st = describeRun(item);
    var step = item.steps[0] || null;
    var body = step && step.pose === "waiting" && !step.answer ? '<div class="tfw-sel-q">' + formatAsk(step.ask) + "</div>" : '<div class="tfw-sel-line2">' + esc(run.result || run.pausedReason || (step ? (W.activity[step.id] ? "The " + step.role + " step is " + W.activity[step.id] + "." : "") : "")) + "</div>";
    return (
      '<div class="tfw-sel-h"><span class="tfw-run-tile tfw-run-tile--lg">' + Crew.icon("workflows", 18) + "</span>" +
      '<span class="who-text"><span class="who-name">' + esc(run.title) + '</span><span class="tfw-sel-sub"><span>' + esc(run.workflow) + "</span>" + (step ? "<span>" + describeStepPlace(run, step) + "</span>" : "") + "<span>" + esc(st.long.toLowerCase()) + "</span></span></span>" +
      '<button class="icon-btn icon-btn--sm tfw-sel-x" data-tfw-clear title="Clear the selection (esc)">' + Crew.icon("close", 13) + "</button></div>" +
      '<div class="tfw-sel-by">' + Crew.icon("user", 13) + "<span>Started by " + esc(describeOrigin(run)) + " at " + run.started + '</span><span class="tfw-sel-dot">·</span><span>' + esc(run.machine) + "</span></div>" +
      body +
      '<div class="tfw-sel-a">' + (step && step.pose === "waiting" && !step.answer ? drawAnswerButtons(step) : "") + '<span class="spacer"></span>' + (step ? '<button class="btn btn--sm" data-tfw-open="' + step.id + '">Open thread' + Crew.icon("chev-r", 13) + "</button>" : '<button class="btn btn--sm">Open run' + Crew.icon("chev-r", 13) + "</button>") + "</div>"
    );
  }

  /* ================================================================== acting */

  /** Selects a session, an assistant or a run in every view. `from` names the view that asked. */
  function select(id, from) {
    ui.selected = id || null;
    markSelection();
    if (els.ov) {
      drawFoldControl();
      if (ui.mode === "threads") {
        markTableSelection();
        if (from !== "threads") scrollTableTo(id);
      }
      if (ui.mode === "org" && org.built) {
        markOrgSelection();
        if (from !== "org") bringOrgIntoView(id, false);
      }
      if (office.handle && from !== "office") office.handle.select(id || null);
      drawSelectionCard();
    }
  }

  function scrollTableTo(id) {
    var scroller = els.panes.threads.querySelector(".tfw-scroll");
    var row = scroller && scroller.querySelector('.tfw-tr[data-tfw-id="' + id + '"]:not(.tfw-tr--wait)');
    if (!row) return;
    var top = row.offsetTop;
    if (top < scroller.scrollTop + 100 || top > scroller.scrollTop + scroller.clientHeight - 220) scroller.scrollTop = Math.max(0, top - 160);
  }

  /** Opens a thread in the main pane; the overview closes and the row stays marked. */
  function openThread(id) {
    var r = firm.byId[id];
    if (!r) {
      var it = findItem(id);
      if (it && it.type === "run" && it.item.steps.length) r = it.item.steps[0];
    }
    if (!r) return;
    ui.openId = r.id;
    ui.overview = false;
    api.drawMain();
    hideBrief();
  }

  function toggleOverview() {
    ui.overview = !ui.overview;
    if (ui.overview && !ui.selected) ui.selected = ui.openId;
    api.drawMain();
    drawTopCounts();
    drawFoldControl();
  }

  /** Answers a waiting session: it leaves Waiting on you and goes back to work; a toast offers Undo. */
  function answer(id, label) {
    var r = firm.byId[id];
    if (!r) return;
    live.answered[id] = label;
    if (ui.mode === "threads" && els.panes.threads.matches(":hover")) ui.heldInBand.push(id);
    var team = findTeam(r);
    var who = team && team.lead !== r ? nameMember(r) + " in " + team.lead.title : r.kind === "step" ? findRun(r.run).title : r.title;
    render();
    api.showToast("<b>" + esc(label) + "</b> · " + esc(who), "Undo", function () {
      delete live.answered[id];
      ui.heldInBand = ui.heldInBand.filter(function (x) { return x !== id; });
      render();
    });
  }

  /** Asks every member of a team for a one-line status; each answers on its own row within a second or two. */
  function runStandup(leadId, instant) {
    var team = firm.teams[leadId];
    if (!team) return;
    live.standupAt[leadId] = W.now;
    team.members.forEach(function (m, i) {
      live.standup[m.id] = { said: !!instant, text: writeStandupLine(m) };
      if (!instant) {
        setTimeout(function () {
          if (!live.standup[m.id]) return;
          live.standup[m.id].said = true;
          render();
        }, REDUCED ? 0 : 700 + i * 520 + (m.pose === "working" ? 380 : 0));
      }
    });
    render();
  }

  /** Marks a team done: the lead and its partners leave the tree; a toast offers Undo. */
  function markTeamDone(leadId) {
    var team = firm.teams[leadId];
    if (!team) return;
    team.members.forEach(function (m) { live.done[m.id] = true; });
    if (ui.selected && team.members.some(function (m) { return m.id === ui.selected; })) ui.selected = null;
    render();
    api.showToast("Marked done: " + esc(team.lead.title) + (team.partners.length ? " and " + team.partners.length + (team.partners.length === 1 ? " partner" : " partners") : ""), "Undo", function () {
      team.members.forEach(function (m) { delete live.done[m.id]; });
      render();
    });
  }

  /** Opens the brief popover under a team's Brief button: a message to the lead, or to everyone. */
  function showBrief(leadId, anchor) {
    var team = firm.teams[leadId];
    if (!team) return;
    var b = els.brief;
    var n = team.members.length;
    b.innerHTML =
      '<div class="tfw-brief-h">' + drawPile(team.members, 18) + "<b>Brief " + (n > 1 ? "the team" : "the thread") + "</b><span>" + esc(team.lead.title) + "</span></div>" +
      '<textarea class="field tfw-brief-in" rows="3" placeholder="' + (n > 1 ? "Tell the team what changed, or what to do next…" : "Tell it what to do next…") + '"></textarea>' +
      '<div class="tfw-brief-a"><button class="btn btn--quiet btn--sm" data-tfw-brief-close>Cancel</button><span class="spacer"></span>' +
      (n > 1 ? '<button class="btn btn--sm" data-tfw-brief-send="lead">Send to the lead</button><button class="btn btn--accent btn--sm" data-tfw-brief-send="all">Send to all ' + n + "</button>" : '<button class="btn btn--accent btn--sm" data-tfw-brief-send="lead">Send</button>') +
      "</div>";
    b.dataset.team = leadId;
    var ov = els.ov.getBoundingClientRect();
    var a = anchor.getBoundingClientRect();
    b.hidden = false;
    b.style.left = Math.min(ov.width - b.offsetWidth - 16, a.right - ov.left - b.offsetWidth) + "px";
    b.style.top = Math.min(ov.height - b.offsetHeight - 16, a.bottom - ov.top + 6) + "px";
    b.querySelector("textarea").focus();
  }

  function hideBrief() {
    if (els.brief) els.brief.hidden = true;
  }

  /** Plays the spawn state's moment: Rotate staging secrets starts its first partner, verify. */
  function playSpawn() {
    live.spawned = false;
    delete live.bornAt[W.spawn.thread.id];
    ui.selected = W.spawn.lead;
    render();
    setTimeout(function () {
      live.spawned = true;
      live.bornAt[W.spawn.thread.id] = Date.now();
      ui.selected = W.spawn.thread.id;
      render();
      if (ui.mode === "org") bringOrgIntoView(W.spawn.thread.id, false);
      api.showToast("<b>verify</b> joined Rotate staging secrets", null, null);
    }, REDUCED ? 50 : 1100);
  }

  /* ================================================================== wiring */

  function wireSidebar() {
    var list = els.list;
    list.addEventListener("click", function (e) {
      var t = e.target;
      if (t.closest("[data-tfw-fold]")) {
        e.preventDefault();
        toggleFold();
        return;
      }
      var su = t.closest("[data-tfw-standup]");
      if (su) {
        e.preventDefault();
        runStandup(su.dataset.tfwStandup);
        return;
      }
      if (t.closest("[data-tfw-memo]")) {
        e.preventDefault();
        if (!ui.overview) toggleOverview();
        showMode("org");
        return;
      }
      var row = t.closest("[data-tfw-id]");
      if (!row) return;
      e.preventDefault();
      var id = row.dataset.tfwId;
      if (!ui.overview) {
        if (firm.byId[id] || findItem(id)) {
          if (findItem(id) && findItem(id).type === "assistant") return;
          openThread(id);
        }
        return;
      }
      select(id, "sidebar");
    });
    list.addEventListener("dblclick", function (e) {
      var row = e.target.closest("[data-tfw-id]");
      if (row) openThread(row.dataset.tfwId);
    });
    list.addEventListener("mouseover", function (e) {
      var row = e.target.closest("[data-tfw-id]");
      if (!row || row.dataset.tfwId === (els.hover.dataset.for || "")) return;
      clearTimeout(hoverTimer);
      els.hover.dataset.for = row.dataset.tfwId;
      els.hover.hidden = true;
      hoverTimer = setTimeout(function () { showHoverCard(row); }, 450);
    });
    list.addEventListener("mouseleave", function () {
      els.hover.dataset.for = "";
      hideHoverCard();
    });
    list.addEventListener("scroll", hideHoverCard);
  }

  function toggleFold(to) {
    ui.fold = to || (ui.fold === "everyone" ? "leads" : "everyone");
    render();
  }

  function wireMain() {
    els.ov.addEventListener("click", function (e) {
      var t = e.target;
      var m = t.closest("[data-tfw-mode]");
      if (m) return showMode(m.dataset.tfwMode);
      var f = t.closest("[data-tfw-fold-to]");
      if (f) return toggleFold(f.dataset.tfwFoldTo);
      if (t.closest("[data-tfw-standup-sel]")) return standupSelected();
      if (t.closest("[data-tfw-replay]")) return playSpawn();
      var a = t.closest("[data-tfw-answer]");
      if (a) return answer(a.dataset.tfwAnswer, a.dataset.label);
      var u = t.closest("[data-tfw-undo]");
      if (u) {
        delete live.answered[u.dataset.tfwUndo];
        ui.heldInBand = ui.heldInBand.filter(function (x) { return x !== u.dataset.tfwUndo; });
        return render();
      }
      var su = t.closest("[data-tfw-standup]");
      if (su) return runStandup(su.dataset.tfwStandup);
      var br = t.closest("[data-tfw-brief]");
      if (br) return showBrief(br.dataset.tfwBrief, br);
      var dn = t.closest("[data-tfw-done]");
      if (dn) return markTeamDone(dn.dataset.tfwDone);
      if (t.closest("[data-tfw-brief-close]")) return hideBrief();
      var send = t.closest("[data-tfw-brief-send]");
      if (send) {
        var team = firm.teams[els.brief.dataset.team];
        hideBrief();
        api.showToast(send.dataset.tfwBriefSend === "all" ? "Briefed all " + team.members.length + " in " + esc(team.lead.title) : "Briefed the lead of " + esc(team.lead.title), null, null);
        return;
      }
      var open = t.closest("[data-tfw-open]");
      if (open) return openThread(open.dataset.tfwOpen);
      if (t.closest("[data-tfw-clear]")) return select(null, "card");
      var pick = t.closest("[data-tfw-pick]");
      if (pick) return select(pick.dataset.tfwPick, pick.classList.contains("tfw-node") ? "org" : "pick");
      var row = t.closest(".tfw-tr[data-tfw-id]");
      if (row) return select(row.dataset.tfwId, "threads");
    });
    els.ov.addEventListener("dblclick", function (e) {
      var row = e.target.closest(".tfw-tr[data-tfw-id]");
      if (row && !e.target.closest("button")) openThread(row.dataset.tfwId);
    });
    els.panes.threads.addEventListener("mouseleave", function () {
      if (!ui.heldInBand.length) return;
      ui.heldInBand = [];
      drawThreads();
    });
    window.addEventListener("resize", function () {
      if (ui.overview && ui.mode === "org" && org.built) fitOrg(true);
      if (office.handle) office.handle.resize();
    });
  }

  function standupSelected() {
    var sel = firm.byId[ui.selected];
    var team = sel ? findTeam(sel) : null;
    if (team && team.partners.length) runStandup(team.id);
  }

  function moveSelection(step) {
    var order = firm.order;
    var at = order.indexOf(ui.selected);
    var next = order[Math.max(0, Math.min(order.length - 1, at === -1 ? 0 : at + step))];
    select(next, "keys");
  }

  function wireKeys() {
    document.addEventListener("keydown", function (e) {
      var typing = e.target.closest && e.target.closest("textarea, input, [contenteditable]");
      if (e.metaKey && e.shiftKey && (e.key === "o" || e.key === "O")) {
        e.preventDefault();
        toggleOverview();
        return;
      }
      if (typing || !ui.overview || e.metaKey || e.ctrlKey || e.altKey) {
        if (e.key === "Escape" && typing) hideBrief();
        return;
      }
      var k = e.key;
      if (k === "1" || k === "2" || k === "3") return showMode(MODES[Number(k) - 1]);
      if (k === "s" || k === "S") return standupSelected();
      if (k === "f" || k === "F") return toggleFold();
      // With the focus in the Dollhouse, up, down, page keys and 0 ride the lift: the module owns them.
      if (els.panes.office.contains(e.target) && /^(ArrowUp|ArrowDown|PageUp|PageDown|Home|0)$/.test(k)) return;
      if (k === "ArrowDown" || k === "ArrowUp") {
        e.preventDefault();
        return moveSelection(k === "ArrowDown" ? 1 : -1);
      }
      if (k === "Enter" && ui.selected) return openThread(ui.selected);
      if (k === "Escape") {
        if (!els.brief.hidden) return hideBrief();
        return select(null, "keys");
      }
      if (ui.mode === "org" && org.built) {
        if (k === "+" || k === "=") { zoomOrg(1.2); applyOrgTransform(true); }
        if (k === "-") { zoomOrg(1 / 1.2); applyOrgTransform(true); }
        if (k === "0") fitOrg(false);
      }
    });
  }

  /* ================================================================== boot */

  function boot(stageApi) {
    api = stageApi;
    els.side = api.els.side;
    els.sum = api.els.sum;
    els.hover = document.createElement("div");
    els.hover.className = "tfw-hover pop";
    els.hover.hidden = true;
    api.els.app.appendChild(els.hover);
    var officeBtn = els.side.querySelector('.side-actions .icon-btn[title^="The office"]');
    if (officeBtn) {
      officeBtn.title = "The overview ⌘⇧O";
      officeBtn.addEventListener("click", toggleOverview);
    }
    wireSidebar();
    wireKeys();
    if (STATE === "standup") runStandup("t3ds", true);
    render();
    if (STATE === "spawn") playSpawn();
    if (STATE === "standup" || STATE === "open") revealInSidebar("t3ds", 44);
    if (STATE === "spawn") revealInSidebar(W.spawn.lead);
    els.thread.addEventListener("click", function (e) {
      var su = e.target.closest("[data-tfw-standup]");
      if (su) runStandup(su.dataset.tfwStandup);
    });
  }

  Stage.direction({
    rootClass: "ov-the-firm",
    initial: "t3ds",
    drawList: function (listEl, stageApi) {
      api = stageApi;
      els.list = listEl;
      els.side = stageApi.els.side;
      els.sum = stageApi.els.sum;
      rebuildFirm();
    },
    drawMain: function (mainEl, t, stageApi) {
      api = stageApi;
      if (!firm) rebuildFirm();
      return drawMainPane(mainEl);
    },
    boot: boot,
  });
})();
