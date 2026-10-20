// PROTOTYPE - direction 3, Workbench: the sidebar lists the work; the window seats the crew.
//
// A row of the sidebar is a bench: one piece of work (a lead and its partners), named by what it
// produces. Line 2 is the product: the branch or the pull request, and the changes. The crew is
// only a row of small dots at the end of line 2, one per thread, in its state. The crew itself
// sits in the window:
//   - the crew bar replaces the header's tabs: the lead's seat carries the bench's name, each
//     partner's seat its role. ⌥1…⌥4 switch seats.
//   - the duet seats two threads side by side on one clock, and draws every message between them
//     as a bridge from the sender to the receiver, like a sequence diagram.
//   - a reviewer's findings are pinned in the margin beside the files they are about.
//
// States (?state=): everyday, partner, spawn, swarm, done, lens, and this direction's own duet,
// findings and card (the bench card pinned open).
(function () {
  "use strict";

  var W = window.WORLD;
  var STATE = new URLSearchParams(location.search).get("state") || "everyday";
  var api;
  var duet = STATE === "duet";
  var duetPartner = null; // the thread in the duet's right column
  var shelfOpen = false;
  var finished = null; // { lead, threads } while a finished bench sits on the shelf
  var DONE_BENCHES = 17; // the shelf's 23 threads are 17 benches
  var FADE = "−"; // the minus sign of a change count

  /* ------------------------------------------------------------------ this direction's fixtures */

  // A bench with a pull request is named by it.
  var PR_TITLES = {
    tResult: "Migrate payout endpoints to Result types",
    tCss: "Remove 212 unused checkout CSS rules",
    t3ds: "Open the 3-D Secure modal for EU cards",
  };

  // The files each lead changed, as its changed-files card lists them.
  var FILES = {
    t3ds: [
      ["src/checkout/payment.ts", 21, 9],
      ["src/checkout/payment.test.ts", 19, 0],
      ["src/checkout/3ds-modal.tsx", 8, 3],
    ],
    tResult: [
      ["src/payouts/handlers/get-payout.ts", 38, 41],
      ["src/payouts/handlers/list-payouts.ts", 52, 47],
      ["src/payouts/router.ts", 24, 30],
      ["src/payouts/errors.ts", 61, 0],
    ],
  };

  /*
   * Findings: what a review partner reported about a file its lead changed. The client reads
   * them from the partner's report when it names a file and line of the lead's changes, so they
   * need no new record. `fixing` marks the finding whose file the lead is editing right now.
   */
  var FINDINGS = {
    t3ds: [
      { from: "t3dsReview", at: "09:38", file: "src/checkout/payment.ts", line: 42, fn: "handlePaymentResult", severity: "should fix", text: "A processing status still falls through to “Card declined”, although the payment may still succeed." },
    ],
    tResult: [
      { from: "tResultReview", at: "09:31", file: "src/payouts/handlers/get-payout.ts", line: 27, fn: "getPayout", severity: "blocking", text: "PayoutError escapes through GET /v1/payouts/:id when the payout is archived. The client gets a 500 with a stack trace.", fixing: true },
      { from: "tResultReview", at: "09:31", file: "src/payouts/handlers/list-payouts.ts", line: 64, fn: "listPayouts", severity: "should fix", text: "A failed page fetch returns an empty list instead of an error, so a Stripe outage looks like no payouts." },
      { from: "tResultReview", at: "09:31", file: "src/payouts/router.ts", line: 18, fn: "mapError", severity: "nit", text: "NotFound is mapped to 404 twice. The second mapping never runs." },
    ],
  };

  // Transcripts this direction shows that the shared world does not hold.
  W.transcripts.tResult = [
    { me: "Migrate the payout endpoints to Result types. Every handler returns a Result, and no exception may reach the client.", at: "08:48" },
    { worked: "Worked for 14m 20s", tools: ["read 31 files", "edited 23 files", "ran pnpm test payouts"] },
    { agent: true, at: "09:05", html: "Migrated the 9 handlers in <code>src/payouts/</code>. Each returns <code>Result&lt;Payout, PayoutError&gt;</code>, and the router maps errors to status codes in one place." },
    { files: "tResult" },
    { result: "112 passed", cmd: "pnpm test payouts" },
    { sent: "tResultReview", at: "09:10", text: "Review the Result type migration adversarially. Look for errors that escape a Result." },
    { agent: true, at: "09:12", html: "Opened draft PR #1287. Codex is reviewing it adversarially in this worktree." },
    { from: "tResultReview", at: "09:31", text: "3 findings, 1 blocking: PayoutError escapes through GET /v1/payouts/:id." },
    { worked: "Working for 5m", tools: ["editing get-payout.ts"], live: true },
  ];
  W.transcripts.tSecrets = [
    { me: "Rotate the staging secrets in ops/secrets/staging.yaml and redeploy each service that reads them.", at: "09:30" },
    { worked: "Worked for 8m 12s", tools: ["read 6 files", "ran 9 commands"] },
    { agent: true, at: "09:39", html: "Rotated 9 of the 14 secrets and redeployed <code>api</code>, <code>worker</code> and <code>billing</code>. I will ask a partner to check that each service picks up its new secret while I rotate the rest." },
    { worked: "Working for 2m", tools: ["rotating STRIPE_WEBHOOK_SECRET"], live: true },
  ];
  W.transcripts.t3dsReview = [
    { from: "t3ds", at: "09:30", text: "Try to break the 3-D Secure fix on fix/3ds-eu-cards. Start with handlePaymentResult and every status Stripe v14 can return.", opening: true },
    { worked: "Worked for 3m 40s", tools: ["read 9 files", "ran 2 commands"] },
    { agent: true, at: "09:34", html: "Stripe v14 can return six PaymentIntent statuses here. The fix handles <code>succeeded</code> and <code>requires_action</code>. <code>processing</code> still falls through to the failure branch at <code>payment.ts:42</code>, so a slow SEPA-backed card shows “Card declined” although the payment may still succeed." },
    { sent: "t3ds", at: "09:38", text: "First finding: a processing status still shows “Card declined”. Still looking." },
    { worked: "Working for 3m", tools: ["read 4 files", "running pnpm test checkout --grep status"], live: true },
  ];

  // The done state finishes the 3-D Secure bench after the push was allowed and the review agreed.
  if (STATE === "done") {
    var fix = findInWorld("t3ds");
    fix.pose = "idle"; fix.status = null; fix.last = "09:40";
    fix.result = "Pushed fix/3ds-eu-cards and opened PR #1290.";
    var review = findInWorld("t3dsReview");
    review.pose = "idle"; review.status = null; review.last = "09:39";
    W.output.t3ds = { plus: 61, minus: 14, files: 3, pr: { number: 1290, state: "open" }, checks: "passing" };
    FILES.t3ds = [["src/checkout/payment.ts", 30, 11], ["src/checkout/payment.test.ts", 23, 0], ["src/checkout/3ds-modal.tsx", 8, 3]];
    FINDINGS.t3ds = [];
    W.transcripts.t3ds = W.transcripts.t3ds.filter(function (it) { return !it.waiting; }).concat([
      { worked: "Worked for 1m 50s", tools: ["edited payment.ts", "ran pnpm test checkout"] },
      { agent: true, at: "09:40", html: "Handled <code>processing</code> as well: the customer now sees “Confirming your payment”. The review agrees. Pushed the branch and opened PR #1290." },
    ]);
  }

  function findInWorld(id) {
    return W.threads.filter(function (t) { return t.id === id; })[0];
  }

  /* ------------------------------------------------------------------ helpers */

  function esc(s) {
    return api.escapeHtml(s);
  }

  /** Returns the hue variable of a thread's face, so its ink can follow it (color is who). */
  function hueStyle(t) {
    return "--hue:var(--hue-" + Crew.lookFor(t.title).hue + ")";
  }

  /** Returns a bench's name: its pull request's title when it has one, else its lead's title. */
  function nameBench(lead) {
    var out = W.output[lead.id];
    return out && out.pr && PR_TITLES[lead.id] ? PR_TITLES[lead.id] : lead.title;
  }

  /** Returns the role a thread plays on its bench: "lead" for a lead, else its role. */
  function describeRole(t) {
    return t.lead ? t.role : "lead";
  }

  /** Returns the stage of a bench's product, for the PR lens: notPushed, draft, review, or nothing. */
  function decideProductStage(lead) {
    var out = W.output[lead.id];
    if (out && out.pr) return out.pr.state === "draft" ? "draft" : "review";
    if (out && out.plus + out.minus > 0) return "notPushed";
    return "nothing";
  }

  // A pull request, drawn in the icon family: two branches and the arrow that joins them.
  var PR_ICON =
    '<svg class="ic" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="4.4" cy="3.6" r="1.5"/><circle cx="4.4" cy="12.4" r="1.5"/><circle cx="11.6" cy="12.4" r="1.5"/><path d="M4.4 5.1v5.8M11.6 10.9V6.6a1.8 1.8 0 0 0-1.8-1.8H7.4M8.8 3.4L7.4 4.8l1.4 1.4"/></svg>';
  // Two columns, for the duet.
  var DUET_ICON =
    '<svg class="ic" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="2.2" y="3" width="11.6" height="10" rx="2"/><path d="M8 3v10"/></svg>';

  /** Returns the change counts as "+48 −12", each in its diff color; "" when nothing changed. */
  function drawDelta(out) {
    if (!out || out.plus + out.minus === 0) return "";
    return '<span class="bn-delta">' + (out.plus ? '<span class="plus">+' + out.plus + "</span>" : "") + (out.minus ? '<span class="minus">' + FADE + out.minus + "</span>" : "") + "</span>";
  }

  /**
   * Returns a bench's line 2: what the work has produced. The pull request when there is one,
   * else the branch a person named, else the main workspace or the machine, each followed by the
   * change counts. In the PR lens, the project's tile takes the glyph's place.
   */
  function drawProduct(lead, withProject) {
    var out = W.output[lead.id];
    var ws = W.workspaces[lead.workspace] || {};
    var glyph, text;
    if (out && out.pr) {
      glyph = PR_ICON;
      text = '<span class="st-clip"><span class="bn-pr">#' + out.pr.number + "</span> " + (out.pr.state === "draft" ? "Draft" : "In review") + (out.checks === "passing" ? ' <span class="bn-ok" title="Checks pass">' + Crew.icon("check", 11) + "</span>" : "") + "</span>";
    } else if (ws.kind === "worktree") {
      glyph = Crew.icon("branch", 12);
      text = '<span class="st-clip">' + esc(ws.branch) + "</span>";
    } else if (ws.kind === "main") {
      glyph = Crew.icon("worktree", 12);
      text = '<span class="st-clip">' + esc(ws.repo) + '</span><span class="st-keep"> · ' + esc(ws.machine) + "</span>";
    } else if (ws.kind === "scratch") {
      glyph = Crew.icon("worktree", 12);
      text = '<span class="st-clip">scratch</span><span class="st-keep"> · ' + esc(ws.machine) + "</span>";
    } else {
      glyph = Crew.icon("laptop", 12);
      text = '<span class="st-clip">' + esc(api.findMachine(lead)) + "</span>";
    }
    if (withProject) {
      var p = api.getProject(lead.project);
      glyph = '<span class="bn-rug proj' + (p ? " proj--" + p.tint : " bn-rug--none") + '"></span>';
    }
    return '<span class="st-glyph">' + glyph + "</span>" + text + drawDelta(out);
  }

  /** Returns the crew dots of a bench: one per thread, lead first, each a button that opens it. */
  function drawDots(crew, openId) {
    if (crew.length < 2) return "";
    return (
      '<span class="bn-dots" role="group" aria-label="The crew">' +
      crew.map(function (m, i) {
        var state = m.doneAt ? "done" : m.pose === "waiting" ? "waiting" : m.pose === "working" ? (m.status === "queued" ? "queued" : "working") : m.pose === "asleep" ? "asleep" : "idle";
        return '<button class="bn-dot bn-dot--' + state + (m.id === openId ? " is-open" : "") + '" data-dot="' + m.id + '" data-bench-of="' + crew[0].id + '" aria-label="' + esc(describeRole(m)) + ", " + Crew.poseWord(m.pose) + " (⌥" + (i + 1) + ')"></button>';
      }).join("") +
      "</span>"
    );
  }

  /** Returns a bench's row: 52px, like today's thread row, with the product on line 2 and the crew at its end. */
  function drawBench(lead, openId, opts) {
    opts = opts || {};
    var crew = api.listCrew(lead.id);
    var spokes = api.pickSpokesperson(crew);
    var slot = api.decideSlot(spokes);
    var open = crew.some(function (m) { return m.id === openId; });
    var receded = spokes.pose === "working" && !open;
    return (
      '<div class="st-thread bn-bench' + (receded ? " is-receded" : "") + (crew.length > 1 ? " has-crew" : "") + '" data-bench="' + lead.id + '" style="--crew:' + crew.length + '">' +
      '<a class="side-row' + (open ? " is-on" : "") + '" href="#" data-open-row="' + lead.id + '">' +
      '<span class="side-text">' +
      '<span class="st-line"><span class="side-name">' + esc(nameBench(lead)) + '</span><span class="side-end st-end--' + slot.kind + '" data-slot>' + slot.text + "</span></span>" +
      '<span class="st-detail">' + drawProduct(lead, opts.withProject) + "</span>" +
      "</span></a>" +
      drawDots(crew, open ? openId : null) +
      "</div>"
    );
  }

  /* ------------------------------------------------------------------ the sidebar */

  /** Returns Waiting on you: each row names the bench and the role that asks, so the work is found by what it is. */
  function drawWaiting(openId) {
    var waiting = api.listThreads(function (t) { return t.pose === "waiting"; }).sort(function (a, b) { return api.compareTimes(b.last, a.last); });
    if (!waiting.length) return "";
    var shown = waiting.slice(0, 3);
    var runs = W.waitingRuns;
    return (
      '<section class="side-sec"><h3 class="side-h"><span>Waiting on you</span><b class="count count--you">' + (waiting.length + runs.length) + "</b></h3>" +
      shown.map(function (t) {
        var lead = api.findLead(t);
        var ask = t.lead ? '<b class="bn-asker">' + esc(t.role) + "</b> " + esc(t.askShort) : esc(t.ask);
        return '<a class="side-row side-row--wait' + (t.id === openId ? " is-on" : "") + '" href="#" data-open-row="' + t.id + '">' + api.drawFace(t, 24, "waiting") + '<span class="side-text"><span class="side-name">' + esc(nameBench(lead)) + '</span><span class="side-ask">' + ask + "</span></span></a>";
      }).join("") +
      (waiting.length > 3 ? '<a class="side-row st-more" href="#">' + (waiting.length - 3) + " more waiting on you</a>" : "") +
      '<h4 class="side-sub">From runs</h4>' +
      runs.map(function (r) {
        return '<a class="side-row side-row--wait" href="#"><span class="side-lead">' + Crew.mark("waiting") + '</span><span class="side-text"><span class="side-name">' + r.title + '</span><span class="side-ask">' + r.ask + "</span></span></a>";
      }).join("") +
      "</section>"
    );
  }

  /** Returns the benches a project shows: waiting, then working, then the rest, five at most, in the project's order. */
  function pickShown(leads, openLeadId) {
    var rank = function (lead) {
      var s = api.pickSpokesperson(api.listCrew(lead.id));
      return s.pose === "waiting" ? 0 : s.pose === "working" ? 1 : 2;
    };
    var picked = leads.slice().sort(function (a, b) { return rank(a) - rank(b) || api.compareTimes(b.last, a.last); }).slice(0, 5);
    var open = leads.filter(function (l) { return l.id === openLeadId; })[0];
    if (open && picked.indexOf(open) === -1) picked.push(open);
    return leads.filter(function (l) { return picked.indexOf(l) !== -1; });
  }

  function drawProject(projectId, openId, openLeadId) {
    var leads = api.listLeads(projectId);
    if (!leads.length) return "";
    var p = api.getProject(projectId);
    var need = api.listThreads(function (t) { return t.project === projectId && t.pose === "waiting"; }).length;
    var shown = pickShown(leads, openLeadId);
    var hidden = leads.length - shown.length + (STATE === "swarm" && p ? Math.round(W.swarm.more[p.id] / 1.6) : 0);
    return (
      '<section class="side-sec">' +
      '<h3 class="side-h side-h--proj">' + (p ? '<span class="proj proj--' + p.tint + '">' + p.name + "</span>" : '<span class="proj bn-noproj">No project</span>') +
      (need ? '<span class="st-need">' + need + (need === 1 ? " needs you" : " need you") + "</span>" : "") +
      '<button class="icon-btn icon-btn--sm" title="New bench in ' + (p ? p.name : "no project") + '">' + Crew.icon("plus", 14) + "</button></h3>" +
      shown.map(function (l) { return drawBench(l, openId); }).join("") +
      (hidden > 0 ? '<a class="side-row st-more" href="#">' + hidden + (hidden === 1 ? " more bench" : " more benches") + "</a>" : "") +
      "</section>"
    );
  }

  /**
   * Returns the projects in their order: by when their newest bench started, then the world's
   * order. A bench starts when its lead does. A partner joining does not move it, so the list
   * never moves under the pointer when a lead starts a partner.
   */
  function orderProjects() {
    var newest = function (id) {
      var l = api.listLeads(id)[0];
      return l ? l.started : "Sat 00:00";
    };
    return W.projects.map(function (p) { return p.id; }).sort(function (a, b) {
      return api.compareTimes(newest(b), newest(a)) || W.projects.findIndex(function (p) { return p.id === a; }) - W.projects.findIndex(function (p) { return p.id === b; });
    });
  }

  // The PR lens: benches grouped by how far their product has come.
  var STAGES = [
    ["notPushed", "Not pushed"],
    ["draft", "Draft"],
    ["review", "In review"],
    ["nothing", "Nothing to ship"],
  ];

  function drawByProduct(openId) {
    var leads = api.listThreads(function (t) { return !t.lead; }).sort(function (a, b) { return api.compareTimes(b.started, a.started); });
    return STAGES.map(function (s) {
      var group = leads.filter(function (l) { return decideProductStage(l) === s[0]; });
      if (!group.length) return "";
      return '<section class="side-sec"><h3 class="side-h"><span>' + s[1] + '</span><b class="count">' + group.length + "</b></h3>" + group.map(function (l) { return drawBench(l, openId, { withProject: true }); }).join("") + "</section>";
    }).join("");
  }

  function drawLensBar() {
    if (STATE !== "lens") return "";
    return '<div class="bn-lens"><button class="bn-lens-btn" title="Group by: project, status, pull request, machine">' + Crew.icon("filter", 14) + '<span>Group by <b>Pull request</b></span>' + Crew.icon("chev-d", 12) + '</button><button class="bn-lens-btn bn-lens-sort" title="Sort by: started, last activity, name">Newest' + Crew.icon("chev-d", 12) + "</button></div>";
  }

  /** Returns the Done shelf: a bench finished together is one row. */
  function drawShelf(openId) {
    var count = DONE_BENCHES + (finished ? 1 : 0);
    var rows = "";
    if (shelfOpen) {
      var benches = [];
      if (finished) benches.push({ name: nameBench(finished.lead), threads: finished.threads, at: "now", lead: finished.lead });
      benches.push({ name: "Renew the status page TLS certificate", threads: [W.done[0]], at: "1h", lead: W.done[0] });
      benches.push({ name: "Bump Stripe SDK to v14", threads: [W.done[1], W.done[2]], at: "yesterday", lead: W.done[1] });
      benches.push({ name: "Fix flaky cart e2e test", threads: [W.done[3], W.done[4]], at: "yesterday", lead: W.done[3] });
      rows = benches.map(function (b, i) {
        var open = b.threads.some(function (t) { return t.id === openId; });
        return (
          '<div class="st-thread bn-bench bn-bench--done' + (i === 0 && finished ? " is-arriving" : "") + (b.threads.length > 1 ? " has-crew" : "") + '" style="--crew:' + b.threads.length + '">' +
          '<a class="side-row' + (open ? " is-on" : "") + '" href="#"' + (b.lead.id === "t3ds" ? ' data-open-row="t3ds"' : "") + '><span class="side-text">' +
          '<span class="st-line"><span class="side-name">' + esc(b.name) + '</span><span class="side-end">' + b.at + "</span></span>" +
          '<span class="st-detail"><span class="st-glyph">' + Crew.icon("check", 12) + '</span><span class="st-clip">' + (b.threads.length === 1 ? "1 thread" : b.threads.length + " threads") + " · finished " + (b.at === "now" ? "now" : b.at === "1h" ? "08:55" : b.at) + "</span></span>" +
          "</span></a>" +
          (b.threads.length > 1 ? '<span class="bn-dots">' + b.threads.map(function () { return '<span class="bn-dot bn-dot--done"></span>'; }).join("") + "</span>" : "") +
          '<button class="bn-reopen btn btn--quiet btn--sm" data-reopen="' + b.lead.id + '">Reopen</button>' +
          "</div>"
        );
      }).join("") + '<a class="side-row st-more" href="#">Show 13 more</a>';
    }
    return (
      '<section class="side-sec bn-shelf"><h3 class="side-h"><button class="bn-shelf-btn" aria-expanded="' + shelfOpen + '">' + Crew.icon("chev-r", 12) + '<span>Done</span><b class="count">' + count + "</b></button></h3>" + rows + "</section>"
    );
  }

  function drawList() {
    var el = api.els.list;
    var openId = api.openId();
    var openLead = api.findLead(api.getThread(openId) || {}) || {};
    var body;
    if (STATE === "lens") body = drawByProduct(openId);
    else body = orderProjects().map(function (id) { return drawProject(id, openId, openLead.id); }).join("") + drawProject(null, openId, openLead.id);
    // The lens bar sits above the list, outside its scroll, so it stays while the list moves.
    if (STATE === "lens" && !api.els.side.querySelector(".bn-lens")) el.insertAdjacentHTML("beforebegin", drawLensBar());
    el.innerHTML = drawWaiting(openId) + body + drawShelf(openId);
    bindList(el);
  }

  function bindList(el) {
    el.querySelectorAll("[data-open-row]").forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        hideCard();
        var id = a.dataset.openRow;
        var bench = a.closest(".bn-bench[data-bench]");
        if (bench) {
          // A bench opens where you left it; its status word opens the thread that speaks for it.
          var crew = api.listCrew(bench.dataset.bench);
          id = e.target.closest("[data-slot]") ? api.pickSpokesperson(crew).id : lastOpen[bench.dataset.bench] || bench.dataset.bench;
        }
        api.open(id);
      });
    });
    el.querySelectorAll("[data-dot]").forEach(function (b) {
      b.addEventListener("click", function () { hideCard(); api.open(b.dataset.dot); });
      b.addEventListener("mouseenter", function () { showCard(b.dataset.benchOf, b.dataset.dot, b.closest(".bn-bench")); });
      b.addEventListener("mouseleave", scheduleHide);
    });
    el.querySelectorAll(".bn-bench[data-bench]").forEach(function (row) {
      row.addEventListener("mouseenter", function () {
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(function () { showCard(row.dataset.bench, null, row); }, 400);
      });
      row.addEventListener("mouseleave", function () { clearTimeout(hoverTimer); scheduleHide(); });
    });
    var shelf = el.querySelector(".bn-shelf-btn");
    if (shelf) shelf.addEventListener("click", function () { shelfOpen = !shelfOpen; drawList(); });
    el.querySelectorAll("[data-reopen]").forEach(function (b) {
      b.addEventListener("click", function () { if (b.dataset.reopen === "t3ds" && finished) undoFinish(); });
    });
  }

  /* ------------------------------------------------------------------ the bench card */

  var card = null;
  var hoverTimer = null;
  var lastOpen = {}; // the thread last open on each bench, by lead id
  var hideTimer = null;

  /** Shows the bench card beside the sidebar: the bench's product and its whole crew, the hovered thread marked. */
  function showCard(leadId, markId, row) {
    clearTimeout(hideTimer);
    var lead = api.getThread(leadId);
    if (!lead || !row) return;
    var crew = api.listCrew(lead.id);
    var out = W.output[lead.id];
    var p = api.getProject(lead.project);
    if (!card) {
      card = document.createElement("div");
      card.className = "bn-card";
      api.els.app.appendChild(card);
    }
    card.innerHTML =
      '<div class="bn-card-name">' + esc(nameBench(lead)) + "</div>" +
      '<div class="bn-card-meta">' + (p ? '<span class="proj proj--' + p.tint + '">' + p.name + "</span>" : "No project") + (api.findBranch(lead) ? '<span class="bn-card-br">' + Crew.icon("branch", 12) + '<span class="mono">' + esc(api.findBranch(lead)) + "</span></span>" : "") + drawDelta(out) + "</div>" +
      '<div class="bn-card-crew">' +
      crew.map(function (m, i) {
        var slot = api.decideSlot(m);
        return '<div class="bn-card-m' + (m.id === markId ? " is-marked" : "") + '">' + api.drawFace(m, 20) + '<span class="bn-card-role">' + esc(m.lead ? m.role : "lead") + '</span><span class="bn-card-agent">' + api.drawBrand(m, 11) + esc(m.model) + (api.findMachine(m) !== api.findMachine(lead) ? " · " + esc(api.findMachine(m)) : "") + '</span><span class="bn-card-slot st-end--' + slot.kind + '">' + slot.text + '</span><kbd>⌥' + (i + 1) + "</kbd></div>";
      }).join("") +
      "</div>" +
      '<div class="bn-card-foot">' + esc(api.findMachine(lead)) + (crew.length > 1 && api.listExchanges(lead.id).length ? " · " + api.listExchanges(lead.id).length + " messages, the last at " + api.listExchanges(lead.id).slice(-1)[0].at : "") + "</div>";
    var r = row.getBoundingClientRect();
    card.style.top = Math.max(8, Math.min(window.innerHeight - card.offsetHeight - 8, r.top - 6)) + "px";
    card.classList.add("is-shown");
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideCard, 80);
  }

  function hideCard() {
    clearTimeout(hoverTimer);
    if (card) card.classList.remove("is-shown");
  }

  /* ------------------------------------------------------------------ the crew bar */

  /** Returns the seat of one thread: its face, the bench's name for the lead or its role for a partner, and its state. */
  function drawSeat(m, i, onIds, lead) {
    var on = onIds.indexOf(m.id) !== -1;
    var label = m.lead ? esc(m.role) : esc(nameBench(lead));
    var state = m.doneAt ? Crew.mark("done") : m.pose === "waiting" ? Crew.mark("waiting") : m.pose === "working" ? (m.status === "queued" ? "<small>queued</small>" : Crew.mark("working")) : "<small>" + api.formatAge(m.last) + "</small>";
    return (
      '<a class="bn-seat' + (m.lead ? "" : " bn-seat--lead") + (on ? " is-on" : "") + (m.pose === "waiting" && !on ? " is-calling" : "") + '" href="#" data-seat="' + m.id + '" title="' + esc(m.title) + " · " + esc(api.describeAgent(m)) + " · ⌥" + (i + 1) + '">' +
      api.drawFace(m, 22) + '<span class="bn-seat-label">' + label + "</span>" + state + "</a>"
    );
  }

  /** Returns the header: the crew bar on the left, the bench's product and its actions on the right. */
  function drawCrewBar(t, lead, onIds) {
    var crew = api.listCrew(lead.id);
    var p = api.getProject(lead.project);
    var out = W.output[lead.id];
    var isDone = !!(finished && finished.lead.id === lead.id);
    return (
      '<header class="top bn-top">' +
      '<nav class="pill bn-crew" aria-label="The crew of this bench">' +
      '<span class="pill-crumb">' + (p ? '<span class="proj proj--' + p.tint + '">' + p.name + "</span>" : '<span class="proj bn-noproj">No project</span>') + "</span>" +
      crew.map(function (m, i) { return drawSeat(m, i, onIds, lead); }).join("") +
      '<button class="icon-btn" title="Add a partner to this bench">' + Crew.icon("plus") + "</button>" +
      "</nav>" +
      '<span class="spacer"></span>' +
      (crew.length > 1 ? '<span class="pill"><button class="pill-btn bn-duet-btn" aria-pressed="' + duet + '" title="Seat two side by side ⌘\\">' + DUET_ICON + "Duet</button></span>" : "") +
      '<span class="pill">' +
      (out && out.pr
        ? '<span class="pill-btn bn-prpill">' + PR_ICON + "#" + out.pr.number + " " + (out.pr.state === "draft" ? "Draft" : "Open") + drawDelta(out) + '</span><span class="pill-sep"></span>'
        : out && out.plus + out.minus ? '<span class="pill-btn">Changes ' + drawDelta(out) + '</span><span class="pill-sep"></span>' : "") +
      (isDone
        ? '<button class="pill-btn bn-finish" data-undo-finish>' + Crew.icon("undo", 14) + "Reopen</button>"
        : '<button class="pill-btn bn-finish" data-finish title="Mark every thread of this bench done">' + Crew.icon("check", 14) + "Finish</button>") +
      "</span>" +
      '<span class="pill"><button class="icon-btn" title="More">' + Crew.icon("more") + "</button></span>" +
      "</header>"
    );
  }

  /**
   * Names the other thread of each message card by its role, in its hue, instead of repeating its
   * title: on a bench, "review" says who it is.
   */
  function nameExchangesByRole(mainEl) {
    mainEl.querySelectorAll(".stage-x").forEach(function (x) {
      var name = x.querySelector(".stage-x-name");
      var role = x.querySelector(".stage-x-role");
      var face = x.querySelector(".cr");
      if (!name) return;
      if (role) {
        name.textContent = role.textContent;
        role.remove();
      }
      if (face) x.setAttribute("style", face.getAttribute("style"));
      if (!x.classList.contains("stage-x--out")) x.querySelector(".stage-x-head").insertAdjacentHTML("afterbegin", '<span class="stage-x-dir">From</span>');
      name.classList.add("bn-x-who");
      name.title = api.getThread(name.dataset.open).title;
    });
  }

  /* ------------------------------------------------------------------ findings in the margin */

  /** Replaces the changed-files card's rows with this lead's files, so a finding can point at one. */
  function fillFiles(mainEl, lead) {
    var files = FILES[lead.id];
    var cardEl = mainEl.querySelector(".stage-files .files");
    if (!files || !cardEl) return;
    cardEl.querySelectorAll(".files-row").forEach(function (r) { r.remove(); });
    var out = W.output[lead.id];
    var rows = files.map(function (f) {
      return '<div class="files-row" data-file="' + f[0] + '"><span>' + f[0] + '</span><span class="spacer"></span><span class="plus">+' + f[1] + '</span><span class="minus">-' + f[2] + "</span></div>";
    }).join("");
    if (out.files > files.length) rows += '<div class="files-row bn-files-more"><span>' + (out.files - files.length) + " more files</span></div>";
    cardEl.insertAdjacentHTML("beforeend", rows);
  }

  /**
   * Pins a lead's findings in a margin beside its changed-files card: the file's row takes the
   * reviewer's tint, and a note in the margin says what was found, with a line to the row.
   */
  function pinFindings(mainEl, lead) {
    var notes = FINDINGS[lead.id];
    var body = mainEl.querySelector(".stage-files .msg-body");
    if (!notes || !notes.length || !body) return;
    mainEl.classList.add("bn-margin");
    var html = "";
    var lastHead = null;
    notes.forEach(function (n, i) {
      var from = api.getThread(n.from);
      var row = body.querySelector('[data-file="' + n.file + '"]');
      if (row) {
        row.classList.add("bn-flagged");
        row.setAttribute("style", hueStyle(from));
        row.insertAdjacentHTML("afterbegin", '<span class="bn-flag" aria-hidden="true"></span>');
      }
      var fixingLead = n.fixing && lead.pose === "working";
      var head = n.from + n.at;
      var count = notes.filter(function (x) { return x.from + x.at === head; }).length;
      var last = i === notes.length - 1 || notes[i + 1].from + notes[i + 1].at !== head;
      html +=
        '<aside class="bn-note' + (n.severity === "blocking" ? " bn-note--block" : "") + (head === lastHead ? " bn-note--more" : "") + '" data-note="' + i + '" style="' + hueStyle(from) + '">' +
        (head === lastHead ? "" : '<div class="bn-note-head">' + api.drawFace(from, 18, "idle") + "<b>" + esc(from.role) + "</b><span>" + esc(W.providers[from.provider].name) + (count > 1 ? " · " + count + " findings" : "") + '</span><span class="bn-note-at">' + n.at + "</span></div>") +
        '<div class="bn-note-sub"><span class="bn-sev bn-sev--' + n.severity.replace(" ", "-") + '">' + n.severity + '</span><span class="bn-note-loc mono">' + esc(n.file.split("/").pop()) + ":" + n.line + "</span></div>" +
        "<p>" + esc(n.text) + "</p>" +
        (fixingLead ? '<div class="bn-note-foot">' + Crew.mark("working") + "<span>Lead is fixing this now</span></div>" : last ? '<div class="bn-note-foot">' + Crew.icon("arrow", 12) + "<span>Reported to lead at " + n.at + "</span></div>" : "") +
        '<svg class="bn-leader" aria-hidden="true"><path d=""/></svg>' +
        "</aside>";
      lastHead = head;
    });
    body.style.position = "relative";
    body.insertAdjacentHTML("beforeend", html);
    requestAnimationFrame(function () { placeNotes(body); });
  }

  /** Places each note level with its file's row, stacking notes that would overlap, and draws the line between them. */
  function placeNotes(body) {
    var bottom = -Infinity;
    body.querySelectorAll(".bn-note").forEach(function (note, i) {
      var row = body.querySelectorAll(".bn-flagged")[i];
      if (!row) return;
      var rowTop = row.getBoundingClientRect().top - body.getBoundingClientRect().top;
      var rowMid = rowTop + row.offsetHeight / 2;
      var top = Math.max(rowTop - (note.classList.contains("bn-note--more") ? 8 : 10), bottom + 6);
      note.style.top = top + "px";
      bottom = top + note.offsetHeight;
      var leader = note.querySelector(".bn-leader");
      var gap = 28;
      var y1 = rowMid - top;
      var y2 = note.classList.contains("bn-note--more") ? 17 : 19;
      var minY = Math.min(y1, y2) - 2;
      var h = Math.abs(y1 - y2) + 4;
      leader.style.top = minY + "px";
      leader.style.height = h + "px";
      leader.setAttribute("viewBox", "0 0 " + gap + " " + h);
      var a = y1 - minY;
      var b = y2 - minY;
      // An elbow with rounded corners. Each later note turns nearer the card, so lines that run
      // down beside each other never cross.
      var x = Math.max(6, 22 - i * 6);
      var r = Math.min(4, Math.abs(b - a) / 2);
      var d = Math.abs(b - a) < 12
        ? "M0 " + a + " C" + gap / 2 + " " + a + " " + gap / 2 + " " + b + " " + gap + " " + b
        : "M0 " + a + " H" + (x - r) + " Q" + x + " " + a + " " + x + " " + (a + r) + " V" + (b - r) + " Q" + x + " " + b + " " + (x + r) + " " + b + " H" + gap;
      leader.querySelector("path").setAttribute("d", d);
    });
  }

  /* ------------------------------------------------------------------ the duet */

  /** Returns the partner a duet seats beside a thread: for a lead, the partner it last exchanged with; for a partner, its lead. */
  function pickDuetPair(t) {
    var lead = api.findLead(t);
    if (t.lead) return [lead, t];
    if (duetPartner && duetPartner.lead === lead.id) return [lead, duetPartner];
    var ex = api.listExchanges(lead.id).filter(function (e) { return e.from === lead.id || e.to === lead.id; }).slice(-1)[0];
    var other = ex ? api.getThread(ex.from === lead.id ? ex.to : ex.from) : api.listPartners(lead.id)[0];
    return [lead, other];
  }

  /**
   * Returns a thread's transcript items: its own when the world holds one, else one built from
   * what is known about it: its opening (the brief that started it, or Rogier's message), the
   * messages it sent and received, where it stands, and whether it waits or works.
   */
  function buildItems(t) {
    if (W.transcripts[t.id]) return W.transcripts[t.id].slice();
    var all = W.exchanges.concat(api.listExchanges(api.findLead(t).id)).filter(function (e, i, arr) { return arr.indexOf(e) === i; });
    var mine = all.filter(function (e) { return e.from === t.id || e.to === t.id; });
    var opening = mine.filter(function (e) { return e.to === t.id && e.kind === "brief"; })[0];
    var items = [opening ? { from: opening.from, at: opening.at, text: opening.text, opening: true } : { me: t.title + ".", at: t.started }];
    items.push({ worked: "Worked for " + Math.max(2, Math.min(9, Math.round(api.minutesAgo(t.started) / 5))) + "m", tools: ["read 5 files", "ran 2 commands"] });
    var rest = mine.filter(function (e) { return e !== opening; }).map(function (e) {
      return e.from === t.id ? { sent: e.to, at: e.at, text: e.text } : { from: e.from, at: e.at, text: e.text };
    });
    if (t.result) rest.push({ agent: true, at: t.last, html: esc(t.result) });
    rest.sort(function (a, b) { return api.compareTimes(a.at, b.at); });
    items = items.concat(rest);
    if (t.pose === "waiting") items.push({ waiting: "Waiting on you since " + t.last + " · " + api.formatAge(t.last) });
    if (t.pose === "working") items.push({ worked: "Working", tools: [], live: true });
    return items;
  }

  /** Returns a transcript's items, each with the time it happened, so two transcripts can share one clock. */
  function timeItems(t) {
    var list = buildItems(t);
    var at = t.started;
    return list.map(function (it, i) {
      if (it.at) at = it.at;
      return { item: it, at: at, seq: i };
    });
  }

  function isExchangeWith(entry, otherId) {
    return (entry.item.sent === otherId || entry.item.from === otherId);
  }

  /**
   * Lays two transcripts on one clock: rows in time order, each with a left cell, a right cell,
   * or both. A message between the two seated threads takes one row, with the sender's card on
   * one side, the receiver's on the other, and a bridge between them.
   */
  function mergeOnClock(left, right) {
    var L = timeItems(left);
    var R = timeItems(right);
    var rows = [];
    var i = 0;
    var j = 0;
    while (i < L.length || j < R.length) {
      var l = L[i];
      var r = R[j];
      if (l && r && isExchangeWith(l, right.id) && isExchangeWith(r, left.id) && l.at === r.at) {
        rows.push({ at: l.at, left: l.item, right: r.item, bridge: l.item.sent ? "ltr" : "rtl" });
        i++; j++;
      } else if (l && r && l.at === r.at && !isExchangeWith(l, right.id) && !isExchangeWith(r, left.id) && i === L.length - 1 && j === R.length - 1) {
        rows.push({ at: l.at, left: l.item, right: r.item });
        i++; j++;
      } else if (l && (!r || api.compareTimes(l.at, r.at) < 0 || (l.at === r.at && !isExchangeWith(l, right.id)))) {
        rows.push({ at: l.at, left: l.item });
        i++;
      } else {
        rows.push({ at: r.at, right: r.item });
        j++;
      }
    }
    return rows;
  }

  /**
   * Returns one transcript item's markup in a duet column: the same pieces as the thread page, a
   * size smaller. A bridged message is written out once, on the sender's side; the receiver's side
   * shows only that it arrived, because the bridge already says what it carried.
   */
  function drawDuetItem(it, t, received) {
    if (it.me) return '<div class="msg--me"><div><div class="bubble">' + esc(it.me) + '</div><div class="bubble-meta">' + it.at + "</div></div></div>";
    if (it.from || it.sent) {
      var other = api.getThread(it.from || it.sent);
      var incoming = !!it.from;
      var who = other.lead === t.id ? other.role : other.id === t.lead ? "lead" : other.role || "";
      return (
        '<div class="stage-x stage-x--' + (incoming ? "in" : "out") + ' bn-x' + (received ? " bn-x--received" : "") + '" style="' + hueStyle(incoming ? other : t) + '">' +
        '<div class="stage-x-head">' + (incoming ? "From" : "Sent to") + " " + api.drawFace(other, 16, other.pose === "waiting" ? "idle" : other.pose) + '<b class="bn-x-who">' + esc(who) + "</b>" +
        (received ? '<span class="bn-x-note">' + (it.opening ? "the brief that started it" : "received") + "</span>" : "") +
        '<span class="stage-x-at">' + it.at + "</span></div>" +
        (received ? "" : '<p class="stage-x-text">' + esc(it.text) + "</p>") + "</div>"
      );
    }
    if (it.worked) return '<div class="worked' + (it.live ? " stage-live" : "") + '"><b>' + it.worked + (it.live ? "" : " ›") + '</b><span class="tools">' + it.tools.map(function (x) { return "<span>" + x + "</span>"; }).join("") + "</span></div>";
    if (it.agent) return '<div class="msg">' + Crew.face(t.title, { pose: "idle", size: 28 }) + '<div class="msg-body"><div class="msg-meta">' + esc(api.describeAgent(t)) + " · " + it.at + "</div><p>" + it.html + "</p></div></div>";
    if (it.files) {
      var o = W.output[it.files];
      return '<div class="msg stage-files">' + Crew.face(t.title, { pose: "idle", size: 28 }) + '<div class="msg-body"><div class="card files"><div class="files-head">' + Crew.icon("diff") + "<span>" + o.files + ' changed files</span><span class="plus mono">+' + o.plus + '</span><span class="minus mono">-' + o.minus + "</span></div>" +
        (FILES[it.files] || []).map(function (f) { return '<div class="files-row"><span>' + f[0] + '</span><span class="spacer"></span><span class="plus">+' + f[1] + '</span><span class="minus">-' + f[2] + "</span></div>"; }).join("") + "</div></div></div>";
    }
    if (it.result) return '<div class="result stage-result"><b>✓ ' + it.result + "</b><code>" + it.cmd + "</code></div>";
    if (it.waiting) return '<div class="stage-waiting-note">' + Crew.mark("waiting") + it.waiting + "</div>";
    return "";
  }

  /** Returns a bridge: the message's direction and time, drawn in the sender's hue from its card to the receiver's. */
  function drawBridge(row, left, right) {
    var sender = row.bridge === "ltr" ? left : right;
    var kind = (row.bridge === "ltr" ? row.left : row.right).sent ? (sender.lead ? "report" : "brief") : "";
    var x1 = row.bridge === "ltr" ? 2 : 94;
    var x2 = row.bridge === "ltr" ? 94 : 2;
    var head = row.bridge === "ltr" ? "M88 14.5 L94 19 L88 23.5" : "M8 14.5 L2 19 L8 23.5";
    return (
      '<div class="bn-bridge bn-bridge--' + row.bridge + '" style="' + hueStyle(sender) + '">' +
      '<span class="bn-bridge-at">' + row.at + "</span>" +
      '<svg viewBox="0 0 96 38" width="96" height="38" aria-hidden="true"><circle cx="' + x1 + '" cy="19" r="2.6"/><path d="M' + x1 + " 19 L" + x2 + ' 19"/><path class="bn-bridge-head" d="' + head + '"/></svg>' +
      '<span class="bn-bridge-kind">' + kind + "</span></div>"
    );
  }

  function drawDuetHead(t, lead) {
    var slot = api.decideSlot(t);
    var role = t.lead ? t.role : "lead";
    return (
      '<div class="bn-dhead" style="' + hueStyle(t) + '">' + api.drawFace(t, 28) +
      '<div class="bn-dhead-text"><div class="bn-dhead-name"><b>' + esc(role) + "</b>" + (t.lead ? "<span>" + esc(t.title) + "</span>" : "<span>" + esc(nameBench(lead)) + "</span>") + "</div>" +
      '<div class="bn-dhead-meta">' + api.drawBrand(t, 11) + esc(api.describeAgent(t)) + " · " + esc(api.findMachine(t)) + "</div></div>" +
      '<span class="side-end st-end--' + slot.kind + '">' + slot.text + "</span></div>"
    );
  }

  /** Draws the duet: the crew bar, the two column heads, the two transcripts on one clock, and one composer. */
  function drawDuet(mainEl, t) {
    var pair = pickDuetPair(t);
    var left = pair[0];
    var right = pair[1];
    duetPartner = right;
    var rows = mergeOnClock(left, right);
    var lastAt = null;
    var grid = rows.map(function (row, k) {
      var tick = row.bridge ? drawBridge(row, left, right) : row.at !== lastAt ? '<span class="bn-tick">' + row.at + "</span>" : "";
      lastAt = row.at;
      var at = "grid-row:" + (k + 1) + ";";
      var bridged = row.bridge ? " is-bridged" : "";
      return (
        '<div class="bn-cell bn-cell--l' + bridged + '" style="' + at + 'grid-column:1">' + (row.left ? drawDuetItem(row.left, left, row.bridge === "rtl") : "") + "</div>" +
        '<div class="bn-gutter' + bridged + '" style="' + at + 'grid-column:2">' + tick + "</div>" +
        '<div class="bn-cell bn-cell--r' + bridged + '" style="' + at + 'grid-column:3">' + (row.right ? drawDuetItem(row.right, right, row.bridge === "ltr") : "") + "</div>"
      );
    }).join("");
    var firstRight = rows.findIndex(function (r) { return !!r.right; });
    var waitingOne = [left, right].filter(function (m) { return m.pose === "waiting"; })[0];
    var target = waitingOne || t;
    mainEl.innerHTML =
      drawCrewBar(t, left, [left.id, right.id]) +
      '<div class="bn-dheads"><div class="bn-dgrid bn-dgrid--heads">' + drawDuetHead(left, left) + "<div></div>" + drawDuetHead(right, left) + "</div></div>" +
      '<div class="transcript bn-duet" data-transcript><div class="bn-dgrid" style="--first-right:' + (firstRight + 1) + '">' +
      (firstRight > 0 ? '<div class="bn-joined" style="grid-row:1 / span ' + firstRight + ';grid-column:3"><span>' + esc(right.role) + " starts at " + right.started + ", " + (right.joined === "added" ? "added by you with the +" : "started by lead") + "</span></div>" : "") +
      '<div class="bn-spine" style="grid-row:1 / span ' + rows.length + ';grid-column:2"></div>' +
      grid + "</div></div>" +
      drawDuetComposer(target, left, right);
  }

  function drawDuetComposer(target, left, right) {
    var dock = "";
    if (target.pose === "waiting") {
      var q = target.status === "approval" ? "Run <code>" + esc(target.ask.replace(/^Run /, "").replace(/\?$/, "").split(" ").slice(0, 2).join(" ")) + "</code>?" : esc(target.askShort);
      dock =
        '<div class="dock bn-minidock"><div class="dock-mini">' + api.drawFace(target, 24, "waiting") + '<span class="dock-mini-q"><b class="bn-asker">' + esc(describeRole(target)) + "</b> " + q + '</span><span class="spacer"></span>' +
        (target.status === "approval" ? '<span class="btn btn--accent btn--sm">Allow once</span><span class="btn btn--quiet btn--sm">Deny</span>' : '<span class="btn btn--sm">Answer</span>') + "</div></div>";
    }
    return (
      '<div class="composer-wrap"><div class="composer" data-composer>' + dock +
      '<div class="composer-card"><textarea class="composer-input" rows="1" placeholder="Reply to ' + esc(describeRole(target)) + ', or steer…"></textarea>' +
      '<div class="composer-row"><button class="pick bn-to" title="Who this message goes to">To ' + api.drawFace(target, 16) + "<b>" + esc(describeRole(target)) + "</b>" + Crew.icon("chev-d", 12) + '</button><button class="pick">' + Crew.icon("shield", 14) + 'Auto-accept edits</button><span class="spacer"></span>' +
      '<button class="pick pick--pill">' + api.drawBrand(target, 13) + esc(target.model) + '</button><button class="icon-btn" title="Dictate">' + Crew.icon("mic") + '</button><button class="send send--off" title="Send">' + Crew.icon("send") + "</button></div></div>" +
      drawDuetLip(left, right) +
      "</div></div>"
    );
  }

  /** Returns the duet's lip: one workspace when the two share it, else both, each with its machine. */
  function drawDuetLip(left, right) {
    var shared = left.workspace === right.workspace;
    var machines = shared ? esc(api.findMachine(left)) : esc(api.findMachine(left)) + " · " + esc(api.findMachine(right));
    var where = shared
      ? "One worktree, two threads"
      : "Two workspaces: " + esc(right.role) + " works in " + (W.workspaces[right.workspace] && W.workspaces[right.workspace].kind === "scratch" ? "a scratch one" : "its own");
    return (
      '<div class="lip"><span>' + Crew.icon("worktree", 13) + where + "</span>" +
      (api.findBranch(left) ? "<span>" + Crew.icon("branch", 13) + '<span class="mono">' + esc(api.findBranch(left)) + "</span></span>" : "") +
      '<span class="spacer"></span><span>' + Crew.icon("laptop", 13) + machines + "</span></div>"
    );
  }

  /* ------------------------------------------------------------------ the main pane */

  function drawMain(mainEl, t) {
    var lead = api.findLead(t);
    mainEl.classList.remove("bn-margin", "bn-is-duet");
    if (duet && api.listCrew(lead.id).length > 1) {
      mainEl.classList.add("bn-is-duet");
      drawDuet(mainEl, t);
      bindMain(mainEl);
      requestAnimationFrame(function () {
        var tx = mainEl.querySelector("[data-transcript]");
        if (tx) tx.scrollTop = tx.scrollHeight;
      });
      return;
    }
    mainEl.innerHTML = drawCrewBar(t, lead, [t.id]) + api.drawTranscript(t) + api.drawComposer(t);
    nameExchangesByRole(mainEl);
    foldComposer(mainEl, t);
    if (finished && finished.lead.id === lead.id) {
      var others = finished.threads.filter(function (m) { return m.lead; }).map(function (m) { return m.role; });
      mainEl.querySelector(".stage-tx").insertAdjacentHTML("beforeend", '<div class="bn-stamp">' + Crew.mark("done") + "<span>Finished at " + W.now + (others.length ? " with " + others.join(" and ") : "") + ". The bench is on the Done shelf; Reopen picks it up again.</span></div>");
    }
    if (t.id === lead.id) {
      fillFiles(mainEl, lead);
      pinFindings(mainEl, lead);
    }
    bindMain(mainEl);
    // With findings pinned, the transcript opens at the files they are about, and the composer
    // folds down to its one-line form, as it does whenever the transcript is scrolled up.
    requestAnimationFrame(function () {
      var tx = mainEl.querySelector("[data-transcript]");
      var files = mainEl.querySelector(".bn-margin .stage-files");
      if (tx && files && api.openId() === "t3ds" || tx && files && STATE === "findings") {
        tx.scrollTop = Math.max(0, files.offsetTop - 108);
        updateFold(mainEl);
      }
    });
  }

  /**
   * Gives the stage's composer the book's folding parts: the Request's full ledger and the
   * composer's row fold away while the transcript is scrolled up, and the dock's one-line form
   * (dock-mini) still answers the Request.
   */
  function foldComposer(mainEl, t) {
    var dock = mainEl.querySelector(".composer .dock");
    if (dock) {
      var full = document.createElement("div");
      full.className = "fold fold--hide";
      full.innerHTML = "<div></div>";
      while (dock.firstChild) full.firstChild.appendChild(dock.firstChild);
      dock.appendChild(full);
      var q = t.status === "approval" ? "Run <code>" + esc(t.ask.replace(/^Run /, "").split(" ").slice(0, 2).join(" ")) + "</code>?" : esc(t.askShort || t.ask);
      dock.insertAdjacentHTML("beforeend", '<div class="dock-mini">' + api.drawFace(t, 24, "waiting") + '<span class="dock-mini-q">' + q + '</span><span class="spacer"></span>' + (t.status === "approval" ? '<span class="btn btn--accent btn--sm">Allow once</span><span class="btn btn--quiet btn--sm">Deny</span>' : '<span class="btn btn--sm">Answer</span>') + "</div>");
    }
    ["composer-row", "lip"].forEach(function (cls) {
      var el = mainEl.querySelector(".composer ." + cls);
      if (!el) return;
      var fold = document.createElement("div");
      fold.className = "fold fold--hide";
      fold.innerHTML = "<div></div>";
      el.parentNode.insertBefore(fold, el);
      fold.firstChild.appendChild(el);
    });
  }

  /** Folds the composer while the transcript is scrolled away from its end, as the book's glass composer does. */
  function updateFold(mainEl) {
    var tx = mainEl.querySelector("[data-transcript]");
    var composer = mainEl.querySelector("[data-composer]");
    if (!tx || !composer) return;
    if (composer.contains(document.activeElement)) return;
    composer.classList.toggle("is-scrolled", tx.scrollHeight - tx.clientHeight - tx.scrollTop > 24);
  }

  function bindMain(mainEl) {
    var tx = mainEl.querySelector("[data-transcript]");
    if (tx) tx.addEventListener("scroll", function () { updateFold(mainEl); }, { passive: true });
    var composer = mainEl.querySelector("[data-composer]");
    if (composer) composer.addEventListener("click", function () {
      if (!composer.classList.contains("is-scrolled")) return;
      composer.classList.remove("is-scrolled");
      tx.scrollTo({ top: tx.scrollHeight, behavior: "smooth" });
    });
    mainEl.querySelectorAll("[data-seat]").forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        openSeat(a.dataset.seat);
      });
    });
    var duetBtn = mainEl.querySelector(".bn-duet-btn");
    if (duetBtn) duetBtn.addEventListener("click", toggleDuet);
    var fin = mainEl.querySelector("[data-finish]");
    if (fin) fin.addEventListener("click", function () { finishBench(api.findLead(api.getThread(api.openId()))); });
    var undo = mainEl.querySelector("[data-undo-finish]");
    if (undo) undo.addEventListener("click", undoFinish);
  }

  /** Opens a seat. In the duet, a partner's seat takes the right column and the lead keeps the left. */
  function openSeat(id) {
    var t = api.getThread(id);
    if (!t) return;
    if (duet && t.lead) duetPartner = t;
    api.open(id);
  }

  function toggleDuet() {
    duet = !duet;
    api.drawMain();
  }

  /* ------------------------------------------------------------------ finishing a bench */

  /** Marks every thread of a bench done at once: the row leaves its project, and the shelf gains one bench. */
  function finishBench(lead) {
    var crew = api.listCrew(lead.id);
    var ids = crew.map(function (m) { return m.id; });
    var row = api.els.list.querySelector('.bn-bench[data-bench="' + lead.id + '"]');
    var seats = api.els.main.querySelectorAll(".bn-seat");
    seats.forEach(function (s, i) { s.style.transitionDelay = i * 40 + "ms"; s.classList.add("is-finishing"); });
    if (row) row.classList.add("is-leaving");
    setTimeout(function () {
      var moved = api.markDone(ids);
      // The open thread stays open: it is done, not gone. The world's done list is where the
      // stage looks a done thread up, so the main pane can still draw it, with done seats.
      Array.prototype.unshift.apply(W.done, moved);
      finished = { lead: lead, threads: moved };
      shelfOpen = true;
      drawList();
      api.drawMain();
      var arriving = api.els.list.querySelector(".is-arriving");
      // The finished bench shows on the shelf, above the toast.
      if (arriving) {
        var list = api.els.list;
        var gap = arriving.getBoundingClientRect().bottom - (list.getBoundingClientRect().bottom - 64);
        if (gap > 0) list.scrollTop += gap;
      }
      api.showToast("Finished · " + moved.length + " threads done", "Undo", undoFinish);
    }, 360);
  }

  function undoFinish() {
    if (!finished) return;
    var back = finished.threads;
    finished = null;
    shelfOpen = false;
    W.done.splice(0, back.length);
    api.restoreThreads(back);
    drawList();
    api.drawMain();
  }

  /* ------------------------------------------------------------------ registering */

  var baseListCrew;

  Stage.direction({
    rootClass: "d-bench",
    initial: function (state) {
      if (state === "partner") return "t3dsReview";
      if (state === "spawn") return "tSecrets";
      if (state === "findings") return "tResult";
      return "t3ds";
    },
    drawList: function (el, a) {
      api = a;
      // A finished bench's threads left the live list, yet its seats still show in the open
      // window; listCrew reads them back from the finished bench.
      baseListCrew = api.listCrew;
      api.listCrew = function (leadId) {
        if (finished && finished.lead.id === leadId) return finished.threads.slice();
        return baseListCrew(leadId);
      };
      api.els.app.classList.add("bn-state-" + STATE);
      drawList();
    },
    drawMain: function (mainEl, t) {
      drawMain(mainEl, t);
    },
    onOpen: function (id) {
      if (!api) return;
      var t = api.getThread(id);
      if (t) lastOpen[api.findLead(t).id] = id;
      drawList();
    },
    boot: function () {
      document.addEventListener("keydown", function (e) {
        if (e.altKey && /^Digit[1-4]$/.test(e.code)) {
          var crew = api.listCrew(api.findLead(api.getThread(api.openId())).id);
          var m = crew[Number(e.code.slice(5)) - 1];
          if (m) { e.preventDefault(); openSeat(m.id); }
        }
        if (e.metaKey && e.key === "\\") { e.preventDefault(); toggleDuet(); }
      });
      // The open bench is in view when the window opens, as it would be after opening it.
      var on = api.els.list.querySelector(".bn-bench .side-row.is-on");
      if (on && STATE !== "lens" && STATE !== "swarm" && new URLSearchParams(location.search).get("list") !== "top") {
        var list = api.els.list;
        var r = on.getBoundingClientRect();
        var lr = list.getBoundingClientRect();
        // Scroll to the start of a section, never into the middle of a row, so the list's top
        // edge cuts nothing.
        var needed = r.bottom - lr.bottom + 30;
        if (needed > 0) {
          var snap = null;
          list.querySelectorAll(".side-sec").forEach(function (sec) {
            var off = sec.getBoundingClientRect().top - lr.top;
            if (off >= needed && (snap === null || off < snap)) snap = off;
          });
          list.scrollTop += snap !== null ? snap : needed;
        }
      }
      // The lens opens at its first group, so every group shows.
      if (STATE === "lens") {
        var firstGroup = api.els.list.querySelectorAll(".side-sec")[1];
        if (firstGroup) api.els.list.scrollTop = firstGroup.getBoundingClientRect().top - api.els.list.getBoundingClientRect().top - 2;
      }
      if (STATE === "card") {
        var row = api.els.list.querySelector('.bn-bench[data-bench="t3ds"]');
        showCard("t3ds", "t3dsReview", row);
      }
      if (STATE === "spawn") setTimeout(playSpawn, 1100);
      if (STATE === "done") setTimeout(function () {
        var fin = api.els.main.querySelector("[data-finish]");
        if (fin) fin.classList.add("is-pressed");
        setTimeout(function () { finishBench(api.getThread("t3ds")); }, 260);
      }, 1200);
    },
  });

  /** The spawn state's moment: the lead starts its first partner. A seat slides into the crew bar, and the bench row gains its crew dots in place. */
  function playSpawn() {
    var partner = api.spawnPartner();
    W.transcripts.tSecrets = W.transcripts.tSecrets.filter(function (it) { return !it.live; }).concat([
      { sent: partner.id, at: W.spawn.exchange.at, text: W.spawn.exchange.text },
      { worked: "Working", tools: ["rotating STRIPE_WEBHOOK_SECRET"], live: true },
    ]);
    drawList();
    api.drawMain();
    var seat = api.els.main.querySelector('[data-seat="' + partner.id + '"]');
    if (seat) seat.classList.add("is-new");
    var dot = api.els.list.querySelector('[data-dot="' + partner.id + '"]');
    if (dot) dot.classList.add("is-new");
    var dots = api.els.list.querySelector('.bn-bench[data-bench="tSecrets"] .bn-dots');
    if (dots) dots.classList.add("is-new");
  }
})();
