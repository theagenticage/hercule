// PROTOTYPE - direction 3, round 2: Workbench, refined.
//
// What Rogier kept from round 1: a row of the sidebar is a bench, one piece of work (a lead and
// its partners), and its threads never get rows of their own. What changed:
//   - No change counts anywhere, and no faces in the sidebar but Waiting on you's.
//   - Line 2 says what waits on you, when anything on the bench does; else the PR or the branch.
//   - The dots are a summary, not buttons: at most three, then "+n". The cluster is one button
//     that unfolds the bench, and so are → and ←. Unfolded, each thread is a 32px line you click.
//   - The hover card is read-only and inert, as today's.
//   - The header has three variants (&header=a|b|c) for crews whose titles are long.
//
// States (?state=): everyday, partner, spawn, done, swarm, lens (grouped by status), stress (a
// ten-thread bench), unfold, card, menu, and rows (a specimen of the dots rule).
(function () {
  "use strict";

  var W = window.WORLD;
  var params = new URLSearchParams(location.search);
  var STATE = params.get("state") || "everyday";
  var HEADER = /^[abc]$/.test(params.get("header") || "") ? params.get("header") : "a";
  // These states draw the ten-thread bench as well as the morning.
  var WITH_STRESS = ["stress", "unfold", "card", "menu", "rows"].indexOf(STATE) !== -1;
  var api;

  var unfolded = {}; // lead id -> true while the bench is unfolded; memory only
  var quietShown = {}; // lead id -> true once its "n quiet" line was opened
  var lastOpen = {}; // lead id -> the thread last open on that bench
  var shelfOpen = false;
  var finished = null; // { lead, threads } while a finished bench sits on the shelf
  var DONE_BENCHES = 17; // the shelf's 23 threads are 17 benches

  if (STATE === "unfold") {
    unfolded.t3ds = true;
    unfolded.xLead = true;
  }

  // A bench with a pull request is named by it.
  var PR_TITLES = {
    tResult: "Migrate payout endpoints to Result types",
    tCss: "Remove 212 unused checkout CSS rules",
    t3ds: "Open the 3-D Secure modal for EU cards",
  };

  // The done state finishes the 3-D Secure bench after the push was allowed and the review agreed.
  if (STATE === "done") {
    var fix = findInWorld("t3ds");
    fix.pose = "idle"; fix.status = null; fix.last = "09:40";
    fix.result = "Pushed fix/3ds-eu-cards and opened PR #1290.";
    var review = findInWorld("t3dsReview");
    review.pose = "idle"; review.status = null; review.last = "09:39";
    W.output.t3ds = { plus: 0, minus: 0, files: 3, pr: { number: 1290, state: "open" }, checks: "passing" };
    W.transcripts.t3ds = W.transcripts.t3ds.filter(function (it) { return !it.waiting; }).concat([
      { worked: "Worked for 1m 50s", tools: ["edited payment.ts", "ran pnpm test checkout"] },
      { agent: true, at: "09:40", html: "Handled <code>processing</code> as well: the customer now sees “Confirming your payment”. The review agrees. Pushed the branch and opened PR #1290." },
    ]);
  }
  W.transcripts.tSecrets = [
    { me: "Rotate the staging secrets in ops/secrets/staging.yaml and redeploy each service that reads them.", at: "09:30" },
    { worked: "Worked for 8m 12s", tools: ["read 6 files", "ran 9 commands"] },
    { agent: true, at: "09:39", html: "Rotated 9 of the 14 secrets and redeployed <code>api</code>, <code>worker</code> and <code>billing</code>. I will ask a partner to check that each service picks up its new secret while I rotate the rest." },
    { worked: "Working for 2m", tools: ["rotating STRIPE_WEBHOOK_SECRET"], live: true },
  ];

  function findInWorld(id) {
    return W.threads.filter(function (t) { return t.id === id; })[0];
  }

  /* ------------------------------------------------------------------ helpers */

  function esc(s) {
    return api.escapeHtml(s);
  }

  /** Returns a bench's name: its pull request's title when it has one, else its lead's title. */
  function nameBench(lead) {
    var out = W.output[lead.id];
    return out && out.pr && PR_TITLES[lead.id] ? PR_TITLES[lead.id] : lead.title;
  }

  /** Returns what a thread is called on its bench: "lead", its role, or, with no role, its title. */
  function nameOnBench(t) {
    if (!t.lead) return "lead";
    return t.role || t.title;
  }

  /** Returns how urgent a thread is, lowest first: waiting, working, queued, then quiet. */
  function rankUrgency(t) {
    if (t.pose === "waiting") return 0;
    if (t.pose === "working") return t.status === "queued" ? 2 : 1;
    return 3;
  }

  /** Returns a thread's dot: waiting, working, queued, done, or quiet. */
  function decideDot(t) {
    if (t.doneAt) return "done";
    var r = rankUrgency(t);
    return r === 0 ? "waiting" : r === 1 ? "working" : r === 2 ? "queued" : "quiet";
  }

  /** Returns a crew sorted by urgency, keeping the crew's order (lead first) among equals. */
  function sortByUrgency(crew) {
    return crew.map(function (t, i) { return [t, i]; }).sort(function (a, b) {
      return rankUrgency(a[0]) - rankUrgency(b[0]) || a[1] - b[1];
    }).map(function (p) { return p[0]; });
  }

  /** Returns the crew of a bench: the finished crew while it sits on the shelf, else the live one. */
  function listCrew(leadId) {
    if (finished && finished.lead.id === leadId) return finished.threads.slice();
    return api.listCrew(leadId);
  }

  /** Returns the thread that waits on you on a bench, the one that asked first. */
  function findAsker(crew) {
    return crew.filter(function (t) { return t.pose === "waiting"; }).sort(function (a, b) { return api.compareTimes(a.last, b.last); })[0];
  }

  /** Returns a state mark: the six marks of the book, as the header's tabs draw them. */
  function drawMark(t) {
    if (t.doneAt) return Crew.mark("done");
    if (t.pose === "waiting") return Crew.mark("waiting");
    if (t.pose === "working") return Crew.mark("working");
    return Crew.mark("idle");
  }

  /** Returns the agent of a thread, short: its provider's mark and its model. */
  function drawAgent(t) {
    return '<span class="b2-agent">' + api.drawBrand(t, 11) + esc(t.model) + "</span>";
  }

  /** Returns the summary a dots cluster reads as: "10 threads: 1 waiting on you, 3 working, 6 quiet". */
  function describeCrew(crew) {
    var n = { waiting: 0, working: 0, queued: 0, quiet: 0, done: 0 };
    crew.forEach(function (t) { n[decideDot(t)]++; });
    var parts = [];
    if (n.waiting) parts.push(n.waiting + " waiting on you");
    if (n.working + n.queued) parts.push(n.working + n.queued + " working");
    if (n.quiet) parts.push(n.quiet + " quiet");
    if (n.done) parts.push(n.done + " done");
    return crew.length + " threads: " + parts.join(", ");
  }

  var PR_ICON =
    '<svg class="ic" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="4.4" cy="3.6" r="1.5"/><circle cx="4.4" cy="12.4" r="1.5"/><circle cx="11.6" cy="12.4" r="1.5"/><path d="M4.4 5.1v5.8M11.6 10.9V6.6a1.8 1.8 0 0 0-1.8-1.8H7.4M8.8 3.4L7.4 4.8l1.4 1.4"/></svg>';
  var DUET_ICON =
    '<svg class="ic" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="2.2" y="3" width="11.6" height="10" rx="2"/><path d="M8 3v10"/></svg>';

  /* ------------------------------------------------------------------ the bench row */

  /**
   * Returns a bench's line 2. While a thread of the bench waits on you, its question, in the
   * marigold ink: "review asks · 409 from Stripe: error or retry?", or the lead's own question
   * alone. Otherwise the pull request, else the branch, else the main workspace or the machine.
   * The glyph is the provider's mark, as on today's row: the asker's while one asks.
   */
  function drawLine2(lead, crew, withProject) {
    var asker = findAsker(crew);
    var glyphOf = function (t) {
      if (withProject) {
        var p = api.getProject(lead.project);
        return '<span class="b2-rug proj' + (p ? " proj--" + p.tint : " b2-rug--none") + '"></span>';
      }
      return api.drawBrand(t, 12);
    };
    if (asker) {
      var text = asker.lead ? '<b class="b2-asker">' + esc(nameOnBench(asker)) + "</b> asks · " + esc(asker.askShort) : esc(asker.askShort || asker.ask);
      return '<span class="st-glyph">' + glyphOf(asker) + '</span><span class="st-clip b2-ask">' + text + "</span>";
    }
    var out = W.output[lead.id];
    var ws = W.workspaces[lead.workspace] || {};
    var body;
    if (out && out.pr) {
      body = '<span class="st-clip"><span class="b2-pr">#' + out.pr.number + "</span> " + (out.pr.state === "draft" ? "Draft" : "In review") + (out.checks === "passing" ? ' <span class="b2-ok" title="Checks pass">' + Crew.icon("check", 11) + "</span>" : "") + "</span>";
    } else {
      var place = api.describePlace(lead);
      body = '<span class="st-clip">' + esc(place.clip) + '</span><span class="st-keep">' + esc(place.keep) + "</span>";
    }
    return '<span class="st-glyph">' + glyphOf(lead) + "</span>" + body;
  }

  /**
   * Returns the dots cluster: a summary of the bench's threads, at most three dots (the most
   * urgent), then "+n" for the rest. It is one button, which unfolds and folds the bench.
   */
  function drawDots(lead, crew) {
    if (crew.length < 2) return "";
    var sorted = sortByUrgency(crew);
    var shown = crew.length > 3 ? sorted.slice(0, 3) : sorted;
    var more = crew.length - shown.length;
    var open = !!unfolded[lead.id];
    return (
      '<button class="b2-dots' + (open ? " is-open" : "") + '" data-fold="' + lead.id + '" aria-expanded="' + open + '" aria-label="' + esc(describeCrew(crew)) + (open ? ". Fold" : ". Unfold") + '">' +
      '<span class="b2-chev">' + Crew.icon("chev-r", 12) + "</span>" +
      shown.map(function (t) { return '<span class="b2-dot b2-dot--' + decideDot(t) + '"></span>'; }).join("") +
      (more ? '<span class="b2-more">+' + more + "</span>" : "") +
      "</button>"
    );
  }

  /** Returns the width line 2 leaves at its end for the dots cluster, in px. */
  function measureDots(crew) {
    if (crew.length < 2) return 0;
    var shown = Math.min(3, crew.length);
    return shown * 11 + (crew.length > 3 ? 6 + 7 * String(crew.length - 3).length + 7 : 0) + 10;
  }

  /**
   * Returns a bench's row: 52px with two lines, as today's thread row. A lone thread draws
   * exactly today's row, with its Done button.
   */
  function drawBench(lead, openId, opts) {
    opts = opts || {};
    var crew = listCrew(lead.id);
    var open = crew.some(function (m) { return m.id === openId; });
    var isUnfolded = !!unfolded[lead.id] && crew.length > 1;
    if (crew.length === 1 && !opts.withProject) {
      return (
        '<div class="b2-bench b2-bench--lone" data-bench="' + lead.id + '">' +
        api.drawThreadRow(lead, { selected: open }) +
        '<button class="b2-act" data-finish-row="' + lead.id + '" title="Mark done">' + Crew.icon("check", 13) + "Done</button>" +
        "</div>"
      );
    }
    var spokes = api.pickSpokesperson(crew);
    var slot = api.decideSlot(spokes);
    var receded = spokes.pose === "working" && !open;
    var rowOn = open && !isUnfolded;
    return (
      '<div class="b2-bench' + (crew.length > 1 ? " has-crew" : "") + (isUnfolded ? " is-unfolded" : "") + '" data-bench="' + lead.id + '">' +
      '<div class="st-thread' + (receded ? " is-receded" : "") + '" style="--dots:' + measureDots(crew) + 'px">' +
      '<a class="side-row' + (rowOn ? " is-on" : "") + (open && isUnfolded ? " is-within" : "") + '" href="#" data-open-row="' + lead.id + '"' + (crew.length > 1 ? ' aria-expanded="' + isUnfolded + '"' : "") + ">" +
      '<span class="side-text">' +
      '<span class="st-line"><span class="side-name">' + esc(nameBench(lead)) + '</span><span class="side-end st-end--' + slot.kind + '" data-slot>' + slot.text + "</span></span>" +
      '<span class="st-detail">' + drawLine2(lead, crew, opts.withProject) + "</span>" +
      "</span></a>" +
      '<button class="b2-act" data-finish-row="' + lead.id + '" title="Mark every thread of this bench done">' + Crew.icon("check", 13) + "Finish</button>" +
      drawDots(lead, crew) +
      "</div>" +
      (isUnfolded ? drawMembers(lead, crew, openId) : "") +
      "</div>"
    );
  }

  /**
   * Returns an unfolded bench's threads: one 32px line each, lead first, then the partners in the
   * order they started. With more than two quiet, the quiet ones fold into one "n quiet" line,
   * except the open thread, which always shows.
   */
  function drawMembers(lead, crew, openId) {
    var quiet = crew.filter(function (t) { return decideDot(t) === "quiet" && t.id !== openId; });
    var foldQuiet = quiet.length > 2 && !quietShown[lead.id];
    var lines = crew.filter(function (t) { return !(foldQuiet && quiet.indexOf(t) !== -1); }).map(function (t) {
      var slot = api.decideSlot(t);
      return (
        '<a class="b2-m' + (t.id === openId ? " is-on" : "") + '" href="#" data-open-member="' + t.id + '" title="' + esc(t.title) + '">' +
        '<span class="b2-dot b2-dot--' + decideDot(t) + '"></span>' +
        '<span class="b2-m-name' + (t.lead && !t.role ? " is-title" : "") + '">' + esc(nameOnBench(t)) + "</span>" +
        drawAgent(t) +
        '<span class="b2-m-slot st-end--' + slot.kind + '">' + slot.text + "</span></a>"
      );
    });
    if (foldQuiet) {
      lines.push('<button class="b2-m b2-quiet" data-quiet="' + lead.id + '"><span class="b2-dot b2-dot--quiet"></span><span class="b2-m-name">' + quiet.length + " quiet</span>" + Crew.icon("chev-r", 12) + "</button>");
    }
    return '<div class="b2-members" role="group" aria-label="Threads of ' + esc(nameBench(lead)) + '">' + lines.join("") + "</div>";
  }

  /* ------------------------------------------------------------------ the sidebar */

  /** Returns Waiting on you: today's faces, and each row names its bench and the role that asks. */
  function drawWaiting(openId) {
    var waiting = api.listThreads(function (t) { return t.pose === "waiting"; }).sort(function (a, b) { return api.compareTimes(b.last, a.last); });
    if (!waiting.length) return "";
    var shown = waiting.slice(0, 3);
    var runs = W.waitingRuns;
    return (
      '<section class="side-sec"><h3 class="side-h"><span>Waiting on you</span><b class="count count--you">' + (waiting.length + runs.length) + "</b></h3>" +
      shown.map(function (t) {
        var lead = api.findLead(t);
        var ask = t.lead ? '<b class="b2-asker">' + esc(nameOnBench(t)) + "</b> asks · " + esc(t.askShort) : esc(t.ask);
        return '<a class="side-row side-row--wait' + (t.id === openId ? " is-on" : "") + '" href="#" data-open-wait="' + t.id + '">' + api.drawFace(t, 24, "waiting") + '<span class="side-text"><span class="side-name">' + esc(nameBench(lead)) + '</span><span class="side-ask">' + ask + "</span></span></a>";
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
    var rank = function (lead) { return Math.min(2, rankUrgency(api.pickSpokesperson(listCrew(lead.id)))); };
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
      '<h3 class="side-h side-h--proj">' + (p ? '<span class="proj proj--' + p.tint + '">' + p.name + "</span>" : '<span class="proj b2-noproj">No project</span>') +
      (need ? '<span class="st-need">' + need + (need === 1 ? " needs you" : " need you") + "</span>" : "") +
      '<button class="icon-btn icon-btn--sm" title="New thread in ' + (p ? p.name : "no project") + '">' + Crew.icon("plus", 14) + "</button></h3>" +
      shown.map(function (l) { return drawBench(l, openId); }).join("") +
      (hidden > 0 ? '<a class="side-row st-more" href="#">' + hidden + (hidden === 1 ? " more bench" : " more benches") + "</a>" : "") +
      "</section>"
    );
  }

  /** Returns the projects by when their newest bench started; a partner joining moves nothing. */
  function orderProjects() {
    var newest = function (id) {
      var l = api.listLeads(id)[0];
      return l ? l.started : "Sat 00:00";
    };
    return W.projects.map(function (p) { return p.id; }).sort(function (a, b) {
      return api.compareTimes(newest(b), newest(a)) || W.projects.findIndex(function (p) { return p.id === a; }) - W.projects.findIndex(function (p) { return p.id === b; });
    });
  }

  // The status lens: benches grouped by the status of whoever speaks for them.
  function drawByStatus(openId) {
    var leads = api.listThreads(function (t) { return !t.lead; }).sort(function (a, b) { return api.compareTimes(b.started, a.started); });
    var groups = [["Needs you", 0], ["Working", 1], ["Quiet", 3]];
    return groups.map(function (g) {
      var list = leads.filter(function (l) { var r = rankUrgency(api.pickSpokesperson(listCrew(l.id))); return g[1] === 1 ? r === 1 || r === 2 : r === g[1]; });
      if (!list.length) return "";
      return '<section class="side-sec"><h3 class="side-h"><span>' + g[0] + '</span><b class="count' + (g[1] === 0 ? " count--you" : "") + '">' + list.length + "</b></h3>" + list.map(function (l) { return drawBench(l, openId, { withProject: true }); }).join("") + "</section>";
    }).join("");
  }

  /** Returns the specimen of the dots rule: one row each with 1, 2, 3 and 10 threads. */
  function drawSpecimen(openId) {
    var rows = [["One thread: today's row", "tIdeal"], ["Two threads: two dots", "tPayout"], ["Three threads: three dots", "t3ds"], ["Ten threads: three, then +7", "xLead"]];
    return rows.map(function (r) {
      return '<section class="side-sec"><h3 class="side-h b2-spec-h"><span>' + r[0] + "</span></h3>" + drawBench(api.getThread(r[1]), openId) + "</section>";
    }).join("");
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
      rows = benches.map(function (b, i) {
        var open = b.threads.some(function (t) { return t.id === openId; });
        return (
          '<div class="b2-bench b2-bench--done' + (i === 0 && finished ? " is-arriving" : "") + '">' +
          '<div class="st-thread"><a class="side-row' + (open ? " is-on" : "") + '" href="#"><span class="side-text">' +
          '<span class="st-line"><span class="side-name">' + esc(b.name) + '</span><span class="side-end">' + b.at + "</span></span>" +
          '<span class="st-detail"><span class="st-glyph b2-done-glyph">' + Crew.icon("check", 12) + '</span><span class="st-clip">' + (b.threads.length === 1 ? "1 thread" : b.threads.length + " threads") + " · finished " + (b.at === "now" ? "now" : b.at === "1h" ? "08:55" : b.at) + "</span></span>" +
          "</span></a>" +
          (b.lead.id === "t3ds" ? '<button class="b2-act b2-act--reopen" data-reopen>' + Crew.icon("undo", 13) + "Reopen</button>" : "") +
          "</div></div>"
        );
      }).join("") + '<a class="side-row st-more" href="#">Show 14 more</a>';
    }
    return '<section class="side-sec b2-shelf"><h3 class="side-h"><button class="b2-shelf-btn" aria-expanded="' + shelfOpen + '">' + Crew.icon("chev-r", 12) + '<span>Done</span><b class="count">' + count + "</b></button></h3>" + rows + "</section>";
  }

  function drawList() {
    var el = api.els.list;
    var keep = el.scrollTop;
    var openId = api.openId();
    var openThread = api.getThread(openId);
    var openLead = openThread ? api.findLead(openThread) : {};
    var body;
    if (STATE === "lens") body = drawByStatus(openId);
    else if (STATE === "rows") body = drawSpecimen(openId);
    else body = orderProjects().map(function (id) { return drawProject(id, openId, openLead.id); }).join("") + drawProject(null, openId, openLead.id);
    if (STATE === "lens" && !api.els.side.querySelector(".b2-lens")) el.insertAdjacentHTML("beforebegin", '<div class="b2-lens"><button class="b2-lens-btn" title="Group by: project, status, machine">' + Crew.icon("filter", 14) + "<span>Group by <b>Status</b></span>" + Crew.icon("chev-d", 12) + '</button><button class="b2-lens-btn b2-lens-sort" title="Sort by: started, last activity, name">Newest' + Crew.icon("chev-d", 12) + "</button></div>");
    el.innerHTML = (STATE === "rows" ? "" : drawWaiting(openId)) + body + (STATE === "rows" ? "" : drawShelf(openId));
    el.scrollTop = keep;
    bindList(el);
  }

  /** Toggles a bench between folded and unfolded. Nothing else in the list moves. */
  function toggleFold(leadId, open) {
    unfolded[leadId] = open === undefined ? !unfolded[leadId] : open;
    hideCard();
    drawList();
    var row = api.els.list.querySelector('[data-bench="' + leadId + '"] [data-open-row]');
    if (row && window.top === window) row.focus();
  }

  function bindList(el) {
    el.querySelectorAll("[data-open-row]").forEach(function (a) {
      var leadId = a.dataset.openRow;
      a.addEventListener("click", function (e) {
        e.preventDefault();
        hideCard();
        // A bench opens on the thread you last had open in it, the lead the first time.
        api.open(lastOpen[leadId] && api.getThread(lastOpen[leadId]) ? lastOpen[leadId] : leadId);
      });
      a.addEventListener("keydown", function (e) {
        if (e.key === "ArrowRight" && listCrew(leadId).length > 1 && !unfolded[leadId]) { e.preventDefault(); toggleFold(leadId, true); }
        if (e.key === "ArrowLeft" && unfolded[leadId]) { e.preventDefault(); toggleFold(leadId, false); }
      });
    });
    el.querySelectorAll("[data-open-wait]").forEach(function (a) {
      a.addEventListener("click", function (e) { e.preventDefault(); api.open(a.dataset.openWait); });
    });
    el.querySelectorAll("[data-open-member]").forEach(function (a) {
      a.addEventListener("click", function (e) { e.preventDefault(); api.open(a.dataset.openMember); });
      a.addEventListener("keydown", function (e) {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          var bench = a.closest("[data-bench]");
          toggleFold(bench.dataset.bench, false);
        }
      });
    });
    el.querySelectorAll("[data-fold]").forEach(function (b) {
      b.addEventListener("click", function () { toggleFold(b.dataset.fold); });
    });
    el.querySelectorAll("[data-quiet]").forEach(function (b) {
      b.addEventListener("click", function () { quietShown[b.dataset.quiet] = true; drawList(); });
    });
    el.querySelectorAll("[data-finish-row]").forEach(function (b) {
      b.addEventListener("click", function () { finishBench(api.getThread(b.dataset.finishRow)); });
    });
    el.querySelectorAll("[data-reopen]").forEach(function (b) {
      b.addEventListener("click", undoFinish);
    });
    el.querySelectorAll(".b2-bench[data-bench]").forEach(function (row) {
      row.addEventListener("mouseenter", function () {
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(function () { showCard(row.dataset.bench, row); }, 400);
      });
      row.addEventListener("mouseleave", function () { clearTimeout(hoverTimer); hideCard(); });
    });
    var shelf = el.querySelector(".b2-shelf-btn");
    if (shelf) shelf.addEventListener("click", function () { shelfOpen = !shelfOpen; drawList(); });
  }

  /* ------------------------------------------------------------------ the hover card */

  var card = null;
  var hoverTimer = null;

  /**
   * Shows the bench card beside the sidebar: read-only and inert, as today's hover card. It takes
   * no pointer and no focus, so nothing in it is a target. It lists the crew, eight at most.
   */
  function showCard(leadId, row) {
    var lead = api.getThread(leadId);
    if (!lead || !row) return;
    var crew = listCrew(lead.id);
    var p = api.getProject(lead.project);
    var out = W.output[lead.id];
    if (!card) {
      card = document.createElement("div");
      card.className = "b2-card";
      card.setAttribute("aria-hidden", "true");
      api.els.app.appendChild(card);
    }
    var listed = sortByUrgency(crew);
    var cap = 8;
    var place = out && out.pr ? PR_ICON + "#" + out.pr.number + " " + (out.pr.state === "draft" ? "Draft" : "In review") : api.findBranch(lead) ? Crew.icon("branch", 12) + '<span class="mono">' + esc(api.findBranch(lead)) + "</span>" : Crew.icon("laptop", 12) + esc(api.findMachine(lead));
    card.innerHTML =
      '<div class="b2-card-name">' + esc(nameBench(lead)) + "</div>" +
      '<div class="b2-card-meta">' + (p ? '<span class="proj proj--' + p.tint + '">' + p.name + "</span>" : "No project") + '<span class="b2-card-place">' + place + "</span><span>" + esc(api.findMachine(lead)) + "</span></div>" +
      (crew.length > 1
        ? '<div class="b2-card-crew">' +
          listed.slice(0, cap).map(function (m) {
            var slot = api.decideSlot(m);
            return '<div class="b2-card-m"><span class="b2-dot b2-dot--' + decideDot(m) + '"></span><span class="b2-card-name2' + (m.lead && !m.role ? " is-title" : "") + '">' + esc(nameOnBench(m)) + "</span>" + drawAgent(m) + '<span class="b2-card-slot st-end--' + slot.kind + '">' + slot.text + "</span></div>";
          }).join("") +
          (listed.length > cap ? '<div class="b2-card-more">and ' + (listed.length - cap) + " more</div>" : "") +
          '</div><div class="b2-card-hint">Click the dots or press → to unfold</div>'
        : '<div class="b2-card-crew"><div class="b2-card-m"><span class="b2-dot b2-dot--' + decideDot(lead) + '"></span><span class="b2-card-name2">' + esc(lead.title) + "</span>" + drawAgent(lead) + "</div></div>");
    var r = row.getBoundingClientRect();
    card.style.top = Math.max(8, Math.min(window.innerHeight - card.offsetHeight - 8, r.top - 6)) + "px";
    card.classList.add("is-shown");
  }

  function hideCard() {
    clearTimeout(hoverTimer);
    if (card) card.classList.remove("is-shown");
  }

  /* ------------------------------------------------------------------ the header */

  /** Returns a tab: today's state mark and the thread's name on its bench, with its age when quiet. */
  function drawTab(t, openId, label) {
    var age = t.pose === "idle" && !t.doneAt ? "<small>" + api.formatAge(t.last) + "</small>" : "";
    return (
      '<a class="ptab b2-tab' + (t.id === openId ? " is-on" : "") + (t.lead && !t.role && !label ? " is-title" : "") + '" href="#" data-tab="' + t.id + '" title="' + esc(t.title) + " · " + esc(api.describeAgent(t)) + '">' +
      drawMark(t) + '<span class="b2-tab-label">' + esc(label || nameOnBench(t)) + "</span>" + age + "</a>"
    );
  }

  /** Returns the right-hand cluster, the same in every variant: Duet, the PR, Finish, More. */
  function drawRight(lead, crew) {
    var out = W.output[lead.id];
    var isDone = !!(finished && finished.lead.id === lead.id);
    return (
      '<span class="spacer"></span><span class="b2-right">' +
      (crew.length > 1 ? '<span class="pill"><a class="pill-btn" href="../workbench/desktop.html?state=duet" title="Seat two side by side, as round 1 draws it">' + DUET_ICON + "Duet</a></span>" : "") +
      '<span class="pill">' +
      (out && out.pr ? '<span class="pill-btn b2-prpill">' + PR_ICON + "#" + out.pr.number + " " + (out.pr.state === "draft" ? "Draft" : "Open") + (out.checks === "passing" ? '<span class="b2-ok">' + Crew.icon("check", 12) + "</span>" : "") + '</span><span class="pill-sep"></span>' : "") +
      (isDone
        ? '<button class="pill-btn" data-undo-finish>' + Crew.icon("undo", 14) + "Reopen</button>"
        : '<button class="pill-btn" data-finish title="Mark every thread of this bench done">' + Crew.icon("check", 14) + (crew.length > 1 ? "Finish" : "Done") + "</button>") +
      "</span>" +
      '<span class="pill"><button class="icon-btn" title="More">' + Crew.icon("more") + "</button></span></span>"
    );
  }

  /** Returns the crumb: the project, then the bench's name, cut at about 280px with its full name as the tooltip. */
  function drawCrumb(lead, withBench) {
    var p = api.getProject(lead.project);
    return (
      '<span class="pill-crumb">' + (p ? '<span class="proj proj--' + p.tint + '">' + p.name + "</span>" : '<span class="proj b2-noproj">No project</span>') + "</span>" +
      (withBench ? '<span class="b2-bench-name" title="' + esc(nameBench(lead)) + '">' + esc(nameBench(lead)) + "</span>" : "")
    );
  }

  /**
   * Returns the header for the open thread, in the variant &header= names:
   *   a  the crumb with the bench's name, then tabs by role, and the ones that do not fit in "+n"
   *   b  the crumb with the bench's name, then one switcher for the open thread
   *   c  the crumb, then today's tabs by title, shrinking like a browser's, then "+n"
   * A lone thread shows the crumb with its name, and no tabs.
   */
  function drawHeader(t) {
    var lead = api.findLead(t);
    var crew = listCrew(lead.id);
    var lone = crew.length === 1;
    var left;
    if (lone) {
      left = '<nav class="pill b2-nav" aria-label="This thread">' + drawCrumb(lead, true) + '<button class="icon-btn" title="New thread on this bench">' + Crew.icon("plus") + "</button></nav>";
    } else if (HEADER === "b") {
      var sorted = sortByUrgency(crew);
      var shown = crew.length > 3 ? sorted.slice(0, 3) : sorted;
      left =
        '<nav class="pill b2-nav b2-nav--b" aria-label="Threads of this bench">' + drawCrumb(lead, true) + '<span class="b2-sep"></span>' +
        '<button class="ptab b2-switch is-on" data-menu-btn aria-haspopup="menu" aria-expanded="false">' + drawMark(t) + "<b>" + esc(t.lead ? nameOnBench(t) : "lead") + "</b><span>· " + esc(W.providers[t.provider].name) + "</span>" + Crew.icon("chev-d", 12) + "</button>" +
        '<span class="b2-sum" aria-label="' + esc(describeCrew(crew)) + '">' + shown.map(function (m) { return '<span class="b2-dot b2-dot--' + decideDot(m) + '"></span>'; }).join("") + (crew.length > 3 ? '<span class="b2-more">+' + (crew.length - 3) + "</span>" : "") + "</span>" +
        '<button class="icon-btn" title="New thread on this bench">' + Crew.icon("plus") + "</button></nav>";
    } else if (HEADER === "c") {
      left =
        '<nav class="pill b2-nav b2-nav--c" aria-label="Threads of this bench">' + drawCrumb(lead, false) +
        crew.map(function (m) { return drawTab(m, t.id, m.title); }).join("") +
        '<button class="ptab b2-over" data-menu-btn aria-haspopup="menu" aria-expanded="false" hidden><span>+0</span>' + Crew.icon("chev-d", 12) + "</button>" +
        '<button class="icon-btn" title="New thread on this bench">' + Crew.icon("plus") + "</button></nav>";
    } else {
      left =
        '<nav class="pill b2-nav b2-nav--a" aria-label="Threads of this bench">' + drawCrumb(lead, true) + '<span class="b2-sep"></span>' +
        crew.map(function (m) { return drawTab(m, t.id); }).join("") +
        '<button class="ptab b2-over" data-menu-btn aria-haspopup="menu" aria-expanded="false" hidden><span>+0</span>' + Crew.icon("chev-d", 12) + "</button>" +
        '<button class="icon-btn" title="New thread on this bench">' + Crew.icon("plus") + "</button></nav>";
    }
    return '<header class="top b2-top b2-top--' + (lone ? "lone" : HEADER) + '">' + left + drawRight(lead, crew) + "</header>";
  }

  /**
   * Lays the header's tabs out so the left pill ends at least 24px before the right-hand
   * cluster. Variant a hides the tabs that do not fit in "+n", keeping the open tab and any
   * waiting tab; variant c first shrinks every tab, between 72 and 200px, then does the same.
   * It runs when the header is drawn and when the window is resized.
   */
  function layoutHeader() {
    var header = api.els.main.querySelector(".b2-top");
    if (!header) return;
    var nav = header.querySelector(".b2-nav");
    var right = header.querySelector(".b2-right");
    var tabs = Array.prototype.slice.call(nav.querySelectorAll(".b2-tab"));
    var over = nav.querySelector(".b2-over");
    var name = nav.querySelector(".b2-bench-name");
    if (name) name.style.maxWidth = "";
    tabs.forEach(function (tab) { tab.hidden = false; tab.style.width = ""; });
    if (over) over.hidden = false;
    var GAP = 2; // the pill's gap between its children
    // What the pill needs without its tabs, measured from its parts, because the pill itself
    // shrinks to fit the header and its own width says nothing about what its content needs.
    var nameW = name ? Math.min(name.scrollWidth, 280) : 0;
    var fixed = 8;
    Array.prototype.forEach.call(nav.children, function (el) {
      if (el.classList.contains("b2-tab") || el === over) return;
      fixed += (el === name ? nameW : el.offsetWidth) + GAP;
    });
    var overW = over ? over.offsetWidth + GAP : 0;
    if (over) over.hidden = true;
    var avail = header.clientWidth - right.offsetWidth - 8 - 24;
    var fitName = function (need) {
      if (name && need > avail) name.style.maxWidth = Math.max(120, nameW - (need - avail)) + "px";
    };
    if (!tabs.length || !over) return fitName(fixed);

    var crew = tabs.map(function (tab) { return api.getThread(tab.dataset.tab); });
    var keep = function (i) { return tabs[i].classList.contains("is-on") || crew[i].pose === "waiting"; };
    var widths = tabs.map(function (tab) { return tab.offsetWidth + GAP; });

    if (nav.classList.contains("b2-nav--c")) {
      // Browser tabs: one width for all, between 72 and 200px; below 72, the rest go into "+n".
      var room = avail - fixed;
      var per = Math.min(200, Math.floor(room / tabs.length) - GAP);
      if (per >= 72) {
        tabs.forEach(function (tab) { tab.style.width = per + "px"; });
        return;
      }
      var fit = Math.max(1, Math.floor((room - overW) / (72 + GAP)));
      var visible = pickVisible(tabs.length, fit, keep);
      var w = Math.max(72, Math.min(200, Math.floor((room - overW) / visible.length) - GAP));
      tabs.forEach(function (tab, i) {
        tab.hidden = visible.indexOf(i) === -1;
        tab.style.width = w + "px";
      });
      setOverflow(over, tabs.length - visible.length);
      return;
    }

    // Variant a: tabs keep their natural widths. The ones that do not fit go into "+n", but the
    // open tab and any waiting tab always stay; only when those alone do not fit does the bench's
    // name give way, down to 120px.
    var total = widths.reduce(function (sum, x) { return sum + x; }, 0);
    if (fixed + total <= avail) return;
    var budget = avail - fixed - overW;
    var order = [];
    tabs.forEach(function (tab, i) { if (keep(i)) order.push(i); });
    tabs.forEach(function (tab, i) { if (!keep(i)) order.push(i); });
    var chosen = [];
    var used = 0;
    order.forEach(function (i) {
      if (keep(i) || used + widths[i] <= budget) {
        chosen.push(i);
        used += widths[i];
      }
    });
    tabs.forEach(function (tab, i) { tab.hidden = chosen.indexOf(i) === -1; });
    setOverflow(over, tabs.length - chosen.length);
    fitName(fixed + used + overW);
  }

  /** Returns which tabs stay, in order: the kept ones (open, waiting), then the rest, up to fit. */
  function pickVisible(n, fit, keep) {
    var order = [];
    for (var i = 0; i < n; i++) if (keep(i)) order.push(i);
    for (var j = 0; j < n; j++) if (!keep(j)) order.push(j);
    return order.slice(0, Math.max(fit, order.filter(function (i) { return keep(i); }).length)).sort(function (a, b) { return a - b; });
  }

  function setOverflow(over, n) {
    over.hidden = n === 0;
    over.querySelector("span").textContent = "+" + n;
    over.setAttribute("aria-label", n + " more threads on this bench");
  }

  /* ------------------------------------------------------------------ the menu */

  var menuEl = null;

  /**
   * Opens the header's menu under its button: the hidden tabs (variants a and c) or the whole
   * crew (variant b). A real menu: ↑ and ↓ move, Enter and a click open, Esc closes.
   */
  function openMenu(btn) {
    closeMenu();
    var t = api.getThread(api.openId());
    var lead = api.findLead(t);
    var crew = listCrew(lead.id);
    var items = HEADER === "b" ? crew : crew.filter(function (m) {
      var tab = api.els.main.querySelector('.b2-tab[data-tab="' + m.id + '"]');
      return tab && tab.hidden;
    });
    menuEl = document.createElement("div");
    menuEl.className = "b2-menu";
    menuEl.setAttribute("role", "menu");
    menuEl.innerHTML =
      '<div class="b2-menu-h">' + (HEADER === "b" ? crew.length + " threads on this bench" : items.length + " more on this bench") + "</div>" +
      items.map(function (m, i) {
        var slot = api.decideSlot(m);
        return (
          '<button class="b2-mi' + (m.id === t.id ? " is-current" : "") + (i === 0 ? " is-active" : "") + '" role="menuitem" data-mi="' + m.id + '" tabindex="-1">' +
          drawMark(m) + '<span class="b2-mi-name' + (m.lead && !m.role ? " is-title" : "") + '">' + esc(nameOnBench(m)) + "</span>" + drawAgent(m) +
          '<span class="b2-mi-slot st-end--' + slot.kind + '">' + slot.text + "</span></button>"
        );
      }).join("");
    api.els.main.appendChild(menuEl);
    var r = btn.getBoundingClientRect();
    var m = api.els.main.getBoundingClientRect();
    menuEl.style.top = r.bottom - m.top + 6 + "px";
    menuEl.style.left = Math.max(14, Math.min(m.width - menuEl.offsetWidth - 14, r.left - m.left - 4)) + "px";
    btn.setAttribute("aria-expanded", "true");
    btn.classList.add("is-pressed");
    var buttons = Array.prototype.slice.call(menuEl.querySelectorAll(".b2-mi"));
    var active = 0;
    var setActive = function (i) {
      active = (i + buttons.length) % buttons.length;
      buttons.forEach(function (b, j) { b.classList.toggle("is-active", j === active); });
      if (window.top === window) buttons[active].focus();
    };
    buttons.forEach(function (b, i) {
      b.addEventListener("click", function () { closeMenu(); api.open(b.dataset.mi); });
      b.addEventListener("mouseenter", function () { setActive(i); });
    });
    menuEl.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
      if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
      if (e.key === "Enter") { e.preventDefault(); var id = buttons[active].dataset.mi; closeMenu(); api.open(id); }
      if (e.key === "Escape") { e.preventDefault(); closeMenu(); if (window.top === window) btn.focus(); }
    });
    if (buttons.length) setActive(0);
  }

  function closeMenu() {
    if (!menuEl) return;
    menuEl.remove();
    menuEl = null;
    api.els.main.querySelectorAll("[data-menu-btn]").forEach(function (b) {
      b.setAttribute("aria-expanded", "false");
      b.classList.remove("is-pressed");
    });
  }

  document.addEventListener("mousedown", function (e) {
    if (menuEl && !menuEl.contains(e.target) && !e.target.closest("[data-menu-btn]")) closeMenu();
  });

  /* ------------------------------------------------------------------ the main pane */

  /**
   * Gives the stage's composer the book's folding parts, so the Request's one-line form
   * (dock-mini) answers it while the transcript is scrolled up.
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
  }

  /** Names the other thread of each message card by its role on the bench, instead of its long title. */
  function nameExchangesByRole(mainEl) {
    mainEl.querySelectorAll(".stage-x").forEach(function (x) {
      var name = x.querySelector(".stage-x-name");
      var role = x.querySelector(".stage-x-role");
      if (!name) return;
      var other = api.getThread(name.dataset.open);
      if (role) role.remove();
      if (other) {
        name.textContent = nameOnBench(other);
        name.title = other.title;
      }
      if (!x.classList.contains("stage-x--out")) x.querySelector(".stage-x-head").insertAdjacentHTML("afterbegin", '<span class="stage-x-dir">From</span>');
    });
  }

  function drawMain(mainEl, t) {
    closeMenu();
    mainEl.innerHTML = drawHeader(t) + api.drawTranscript(t) + api.drawComposer(t);
    nameExchangesByRole(mainEl);
    foldComposer(mainEl, t);
    if (finished && finished.lead.id === api.findLead(t).id) {
      var others = finished.threads.filter(function (m) { return m.lead; }).map(function (m) { return nameOnBench(m); });
      mainEl.querySelector(".stage-tx").insertAdjacentHTML("beforeend", '<div class="b2-stamp">' + Crew.mark("done") + "<span>Finished at " + W.now + (others.length ? " with " + others.join(" and ") : "") + ". The bench is on the Done shelf; Reopen picks it up again.</span></div>");
    }
    bindMain(mainEl);
    layoutHeader();
  }

  function bindMain(mainEl) {
    mainEl.querySelectorAll("[data-tab]").forEach(function (a) {
      a.addEventListener("click", function (e) { e.preventDefault(); api.open(a.dataset.tab); });
    });
    mainEl.querySelectorAll("[data-menu-btn]").forEach(function (b) {
      b.addEventListener("click", function () { if (menuEl) closeMenu(); else openMenu(b); });
      b.addEventListener("keydown", function (e) {
        if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") { e.preventDefault(); openMenu(b); }
      });
    });
    var fin = mainEl.querySelector("[data-finish]");
    if (fin) fin.addEventListener("click", function () { finishBench(api.findLead(api.getThread(api.openId()))); });
    var undo = mainEl.querySelector("[data-undo-finish]");
    if (undo) undo.addEventListener("click", undoFinish);
  }

  /* ------------------------------------------------------------------ finishing a bench */

  /** Marks every thread of a bench done at once: the row leaves its project, and the shelf gains one bench. */
  function finishBench(lead) {
    var crew = listCrew(lead.id);
    var row = api.els.list.querySelector('.b2-bench[data-bench="' + lead.id + '"]');
    if (row) row.classList.add("is-leaving");
    api.els.main.querySelectorAll(".b2-tab").forEach(function (tab, i) { tab.style.transitionDelay = i * 40 + "ms"; tab.classList.add("is-finishing"); });
    setTimeout(function () {
      var moved = api.markDone(crew.map(function (m) { return m.id; }));
      moved.forEach(function (m) { m.doneAt = W.now; });
      // The open thread stays open: it is done, not gone. The world's done list is where the
      // stage looks a done thread up, so the main pane can still draw it.
      Array.prototype.unshift.apply(W.done, moved);
      finished = { lead: lead, threads: moved };
      shelfOpen = true;
      drawList();
      api.drawMain();
      var arriving = api.els.list.querySelector(".is-arriving");
      if (arriving) {
        var list = api.els.list;
        var gap = arriving.getBoundingClientRect().bottom - (list.getBoundingClientRect().bottom - 64);
        if (gap > 0) list.scrollTop += gap;
      }
      api.showToast(moved.length > 1 ? "Finished · " + moved.length + " threads done" : "Marked done", "Undo", undoFinish);
    }, 340);
  }

  function undoFinish() {
    if (!finished) return;
    var back = finished.threads;
    finished = null;
    shelfOpen = false;
    W.done.splice(0, back.length);
    back.forEach(function (m) { delete m.doneAt; });
    api.restoreThreads(back);
    drawList();
    api.drawMain();
  }

  /* ------------------------------------------------------------------ registering */

  Stage.direction({
    rootClass: "d-bench2",
    initial: function (state) {
      if (state === "partner") return "t3dsReview";
      if (state === "spawn") return "tSecrets";
      if (state === "stress" || state === "card" || state === "menu" || state === "rows") return "xLead";
      return "t3ds";
    },
    drawList: function (el, a) {
      api = a;
      // The stage adds the ten-thread bench only in its stress state; these states draw it too.
      if (WITH_STRESS && !api.listThreads(function (t) { return t.id === "xLead"; }).length) {
        api.restoreThreads(W.stress.threads);
      }
      api.els.app.classList.add("b2-state-" + STATE);
      drawList();
    },
    drawMain: function (mainEl, t) {
      drawMain(mainEl, t);
    },
    onOpen: function (id) {
      if (!api) return;
      var t = api.getThread(id);
      if (t) lastOpen[api.findLead(t).id] = id;
      // Opening a thread never unfolds a bench or moves the list: it only marks the row.
      drawList();
    },
    boot: function () {
      window.addEventListener("resize", function () { closeMenu(); layoutHeader(); });
      document.addEventListener("keydown", function (e) {
        if (e.altKey && /^Digit[1-9]$/.test(e.code)) {
          var crew = listCrew(api.findLead(api.getThread(api.openId())).id);
          var m = crew[Number(e.code.slice(5)) - 1];
          if (m) { e.preventDefault(); api.open(m.id); }
        }
      });
      // Fonts change the tabs' widths, so the header is laid out again once they are in.
      document.fonts.ready.then(layoutHeader);
      var list = api.els.list;
      var keepTop = params.get("list") === "top";
      // The open bench is in view when the window opens, as it would be after opening it. The
      // list scrolls to the start of a section, never into the middle of a row.
      var on = list.querySelector(".b2-bench .side-row.is-on, .b2-bench .b2-m.is-on, .b2-bench .side-row.is-within");
      if (on && !keepTop && ["everyday", "partner", "done", "spawn", "stress", "menu"].indexOf(STATE) !== -1) {
        var r = on.getBoundingClientRect();
        var lr = list.getBoundingClientRect();
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
      if (STATE === "unfold" && !keepTop) {
        var first = list.querySelector('[data-bench="xLead"]');
        if (first) list.scrollTop = first.closest(".side-sec").getBoundingClientRect().top - list.getBoundingClientRect().top;
      }
      if (STATE === "card") {
        var row = list.querySelector('[data-bench="xLead"]');
        if (row) {
          list.scrollTop += row.closest(".side-sec").getBoundingClientRect().top - list.getBoundingClientRect().top;
          showCard("xLead", row);
        }
      }
      if (STATE === "menu") {
        document.fonts.ready.then(function () {
          setTimeout(function () {
            var btn = api.els.main.querySelector("[data-menu-btn]:not([hidden])");
            if (btn) openMenu(btn);
          }, 60);
        });
      }
      if (STATE === "spawn") setTimeout(playSpawn, 1100);
      if (STATE === "done") setTimeout(function () {
        var fin = api.els.main.querySelector("[data-finish]");
        if (fin) fin.classList.add("is-pressed");
        setTimeout(function () { finishBench(api.getThread("t3ds")); }, 260);
      }, 1200);
    },
  });

  /** The spawn state's moment: the lead starts its first partner. Its row gains dots in place, and its header gains tabs. */
  function playSpawn() {
    var partner = api.spawnPartner();
    W.transcripts.tSecrets = W.transcripts.tSecrets.filter(function (it) { return !it.live; }).concat([
      { sent: partner.id, at: W.spawn.exchange.at, text: W.spawn.exchange.text },
      { worked: "Working", tools: ["rotating STRIPE_WEBHOOK_SECRET"], live: true },
    ]);
    drawList();
    api.drawMain();
    var dots = api.els.list.querySelector('[data-bench="tSecrets"] .b2-dots');
    if (dots) dots.classList.add("is-new");
    api.els.main.querySelectorAll(".b2-tab, .b2-sep").forEach(function (tab) { tab.classList.add("is-new"); });
  }
})();
