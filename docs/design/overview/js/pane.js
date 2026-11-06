// PROTOTYPE - a card opening into its details. The sheet of paper you clicked is the sheet that
// grows: its top edge, and whatever stands behind it, ride along. Its old place stays open on the
// board as a dent, so the eye knows where it goes back to. Open and close are one spring.
window.Pane = (function () {
  "use strict";

  var drive = null;
  var pane, sheet, clip, inner, ghost;
  var awayEl = null;
  var closingId = null;
  var trail = [];
  var lastChange = 0;
  var openId = null;
  var from = null;
  var to = null;

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v) { return Math.max(0, Math.min(1, v)); }
  function esc(s) { return Board.esc(s); }

  function stageName(id) { return NW.STAGES.filter(function (s) { return s.id === id; })[0].name; }

  /** Draws the stage path: each stage as a step, the current one in ink. */
  function drawPath(t) {
    var reached = true;
    return '<ol class="pn-path">' + NW.STAGES.map(function (s) {
      var here = s.id === t.stage;
      var html = '<li class="' + (here ? "is-here" : reached ? "is-past" : "") + '"' + (here ? ' aria-current="step"' : "") + '><button tabindex="-1" data-stage-to="' + s.id + '" title="Move it to ' + s.name + '">' + s.name + "</button></li>";
      if (here) reached = false;
      return html;
    }).join("") + "</ol>";
  }

  /** Draws what a failed run needs: the card's words, then the two moves only a failure has. */
  function drawFailure(t) {
    var who = t.agent ? '<p class="pn-who">' + Crew.face(t.agent, { pose: "failed", size: 22 }) + "<span><b>" + esc(NW.sayAgent(t.agent)) + "</b> stopped.</span></p>" : "";
    return '<section class="pn-sec pn-next">' + who + '<p class="pn-ask pn-failed">' + Board.FAILED_MARK + esc(Store.describeFailure(t)) + "</p>" +
      '<div class="pn-answers"><button class="pn-answer is-suggested" data-act="retry">Try again</button><button class="pn-answer" data-act="run">Open the run</button></div></section>';
  }

  /** Draws a Thread's open question, with its answers and a line to say something else. */
  function drawQuestion(t) {
    var opts = t.question.answers.map(function (label, i) {
      return '<button class="pn-answer' + (i === 0 ? " is-suggested" : "") + '" data-answer="' + esc(label) + '">' + esc(label) + "</button>";
    }).join("");
    return '<section class="pn-sec pn-next"><p class="pn-who">' + Crew.face(t.question.from, { pose: "waiting", size: 22 }) + "<span>" + (t.question.from === t.name ? "A Thread asks." : "<b>" + esc(NW.sayAgent(t.question.from)) + "</b> asks.") + '</span></p><p class="pn-ask">' + esc(t.question.text) + '</p><div class="pn-answers">' + opts + '</div><form class="pn-reply" data-reply><input placeholder="Or say something else…" aria-label="Your answer"></form></section>';
  }

  function drawNow(t) {
    return (t.failed ? drawFailure(t) : "") + (t.question ? drawQuestion(t) : "");
  }

  function drawThreads(t) {
    if (!t.threads.length) return "";
    return '<section class="pn-sec"><h4>Threads <span>' + t.threads.length + "</span></h4>" + t.threads.map(function (th, i) {
      var live = t.agent && i === t.threads.length - 1;
      var broke = live && t.failed;
      var asks = live && t.question;
      // The live Thread is the one on the card, so it wears the same face.
      var who = asks ? t.question.from : live ? t.agent : th.title + th.id;
      return '<a class="pn-row" href="#">' + Crew.face(who, { pose: broke ? "failed" : asks ? "waiting" : live ? "working" : "idle", size: 20 }) + '<span class="pn-row-text">' + esc(NW.sayAgent(th.title)) + "</span><small>" + (broke ? "Failed" : asks ? "Asks" : live ? "Working" : NW.formatAge(t.age)) + "</small></a>";
    }).join("") + "</section>";
  }

  /** Draws one outside thing as a row: its source's mark, its name, and what it says about itself. */
  function drawEntityRow(ref, claim) {
    var e = Graph.entity(ref);
    var kind = Graph.kindOf(ref);
    var says = claim ? '<small class="pn-claim">' + esc(claim.evidence === "person" ? claim.claimant + " linked this" : claim.claimant + " reports this") + "</small>" : "";
    // Something you cannot open: its title was never read, so only its source and kind are known.
    if (e.access === "restricted") {
      return '<div class="pn-row is-restricted" tabindex="0">' + Crew.icon("lock", 14) + '<span class="pn-row-text">A ' + esc(Graph.SOURCES[kind.source]) + " " + esc(kind.word.toLowerCase()) + " you cannot open</span>" + says + "</div>";
    }
    return '<a class="pn-row" href="#">' + Crew.brand(kind.source, 14) + '<span class="pn-row-text">' + esc(e.label ? e.label + "  " : "") + esc(e.title) + '</span><small class="pn-state">' + esc([e.state, e.concern === "following" ? "Following" : ""].filter(Boolean).join(" · ")) + "</small>" + says + "</a>";
  }

  /** Draws what a Task is, and what it is directly linked to. A reference found in text is a weaker row. */
  function drawLinks(t) {
    var links = Graph.readLinks(t);
    var strong = links.filter(function (l) { return l.evidence !== "text"; });
    var hints = links.filter(function (l) { return l.evidence === "text"; });
    var own = (t.entities || []).map(function (r) { return drawEntityRow(r); }).join("");
    var plain = own ? "" : (t.links || []).map(function (l) {
      return '<a class="pn-row" href="#">' + Crew.icon("link", 14) + '<span class="pn-row-text">' + esc(l.label) + "</span><small>" + esc(l.state || "") + "</small></a>";
    }).join("");
    var rows = own + plain + strong.map(function (l) { return drawEntityRow(l.ref, l); }).join("");
    var mentions = hints.map(function (l) {
      var e = Graph.entity(l.ref);
      return '<a class="pn-row pn-row--hint" href="#">' + Crew.brand(Graph.sourceOf(l.ref), 14) + '<span class="pn-row-text">' + esc(e.label) + "  " + esc(e.title) + '</span><small class="pn-state">Mentioned</small><small class="pn-claim">Found in text on ' + esc(l.claimant) + "</small></a>";
    }).join("");
    return (rows ? '<section class="pn-sec"><h4>Linked</h4>' + rows + "</section>" : "") + (mentions ? '<section class="pn-sec"><h4>Mentioned</h4>' + mentions + "</section>" : "");
  }

  /** Draws everything a Task is part of, by every path, each once. A click shows all its Tasks. */
  function drawParents(t) {
    var refs = Graph.readAncestors(t.entities || []);
    if (!refs.length) return "";
    return '<section class="pn-sec"><h4>Part of</h4>' + refs.map(function (r) {
      var e = Graph.entity(r);
      var shows = Graph.KINDS[e.kind].group;
      return "<" + (shows ? 'button data-context="' + esc(r) + '" title="Show all its Tasks"' : "div") + ' class="pn-row">' + Crew.brand(Graph.sourceOf(r), 14) + '<span class="pn-row-text">' + esc(e.title) + '</span><small class="pn-state">' + Board.drawContextFacts(e) + "</small></" + (shows ? "button" : "div") + ">";
    }).join("") + "</section>";
  }

  function drawBlockers(t) {
    var rows = t.blockedBy.map(function (id) {
      var b = Store.task(id);
      return b ? '<button class="pn-row" data-open="' + b.id + '">' + Crew.icon("lock", 14) + '<span class="pn-row-text">' + esc(b.name) + "</span><small>" + stageName(b.stage) + "</small></button>" : "";
    }).join("");
    var blocks = Store.state.tasks.filter(function (x) { return x.blockedBy.indexOf(t.id) >= 0; }).map(function (b) {
      return '<button class="pn-row" data-open="' + b.id + '">' + Crew.icon("arrow", 14) + '<span class="pn-row-text">' + esc(b.name) + "</span><small>" + stageName(b.stage) + "</small></button>";
    }).join("");
    return (rows ? '<section class="pn-sec"><h4>Blocked by</h4>' + rows + "</section>" : "") + (blocks ? '<section class="pn-sec"><h4>Blocks</h4>' + blocks + "</section>" : "");
  }

  function drawInner(t) {
    var project = Store.state.projects.filter(function (p) { return p.id === t.project; })[0];
    var plan = Store.state.plans.filter(function (p) { return p.id === t.initiative; })[0];
    return '<div class="pn-scroll"><header class="pn-head"><p class="pn-crumb"><span class="pn-crumb-text">' + esc(project ? project.name : "") + (plan ? " · " + esc(plan.name) : "") + "</span></p>" +
      '<h2 class="pn-title" id="pn-title" tabindex="-1">' + esc(t.name) + "</h2>" + drawPath(t) + "</header>" +
      '<p class="pn-where">' + esc(t.where || t.now) + "</p>" +
      drawNow(t) +
      (t.left && !/^(nothing|everything)$/i.test(t.left) ? '<section class="pn-sec"><h4>What is left</h4><p class="pn-left">' + esc(t.left) + "</p></section>" : "") +
      drawBlockers(t) + drawThreads(t) + drawParents(t) + drawLinks(t) + "</div>" +
      '<footer class="pn-foot"><button class="pn-btn" data-act="done">' + Crew.icon("check", 14) + 'Done<kbd>D</kbd></button><button class="pn-btn" data-act="thread">' + Crew.icon("compose", 14) + 'Start a thread<kbd>T</kbd></button><button class="pn-btn" data-act="merge">' + Crew.icon("overlap", 14) + 'Merge<kbd>M</kbd></button><button class="pn-btn pn-btn--end" data-act="drop">Drop<kbd>⌫</kbd></button></footer>';
  }

  /** Puts the colleague on the open sheet's top edge, if one is on this Task. */
  function drawHolderOnSheet(t) {
    sheet.querySelectorAll(":scope > .card-holder, :scope > .card-paws").forEach(function (old) { old.remove(); });
    if (!t.agent || (t.stage === "landed" && !t.failed)) return;
    var tmp = document.createElement("div");
    var drawn = Board.drawHead(t.question ? t.question.from : t.agent, t.failed ? "failed" : t.question ? "waiting" : "working");
    tmp.innerHTML = '<span class="card-holder">' + drawn.head + "</span>" + drawn.paws;
    while (tmp.lastChild) sheet.insertBefore(tmp.lastChild, sheet.firstChild);
  }

  function paint(p) {
    if (!from || !to) return;
    var q = Math.max(0, p);
    sheet.style.left = lerp(from.left, to.left, p) + "px";
    sheet.style.top = lerp(from.top, to.top, p) + "px";
    sheet.style.width = lerp(from.width, to.width, q) + "px";
    sheet.style.height = lerp(from.height, to.height, q) + "px";
    sheet.style.setProperty("--pn-r", lerp(12, 16, clamp(p)) + "px");
    // A colleague rides the top edge, and slides clear of the toolbar's right end as the sheet opens.
    sheet.style.setProperty("--pn-head", lerp(14, 214, clamp(p)) + "px");
    // The two sets of words overlap, so there is never a blank sheet between them.
    var words = clamp((p - 0.3) / 0.55);
    inner.style.opacity = words.toFixed(3);
    inner.style.transform = "translateY(" + ((1 - words) * 10).toFixed(2) + "px)";
    if (ghost) ghost.style.opacity = clamp(1 - p / 0.55).toFixed(3);
    pane.style.setProperty("--pn-dim", clamp(p).toFixed(3));
  }

  function measureTarget() {
    var host = pane.getBoundingClientRect();
    var w = Math.min(468, host.width - 40);
    return { left: host.width - w - 14, top: 58, width: w, height: host.height - 58 - 14 };
  }

  function cardRect(el) {
    var host = pane.getBoundingClientRect();
    var r = el.getBoundingClientRect();
    return { left: r.left - host.left, top: r.top - host.top, width: r.width, height: r.height };
  }

  /** Opens a Task's details, from its card when the card is on the board. */
  function show(id, opts) {
    opts = opts || {};
    var t = Store.task(id);
    if (!t) return;
    // A Task under two lanes has two cards. The sheet grows from the one you touched.
    var el = opts.el || document.querySelector('#lanes .card[data-id="' + id + '"]');
    if (window.Adder) Adder.hide();
    if (openId && openId !== id) {
      if (opts.followed) trail.push(openId);
      swap(id);
      return;
    }
    if (openId === id) return;
    // Caught mid-close by a different card: the sheet stops closing and shows the new one.
    if (closingId && closingId !== id && drive.get() > 0.02) {
      openId = closingId;
      closingId = null;
      swap(id);
      drive.to(1, "travel");
      document.getElementById("work").classList.add("has-pane");
      return;
    }
    closingId = null;
    // A sheet that had almost closed on another card lets that card go first.
    if (awayEl && awayEl !== el) {
      awayEl.classList.remove("is-away");
      awayEl = null;
      if (ghost) ghost.remove();
      ghost = null;
    }
    openId = id;
    awayEl = el;
    pane.hidden = false;
    pane.classList.add("is-on");
    inner.innerHTML = drawInner(t);
    drawHolderOnSheet(t);
    to = measureTarget();
    // The sheet grows from wherever the Task lives right now: its card, its pile or its bead.
    var spot = el || Board.locate(id);
    from = spot ? cardRect(spot) : { left: to.left + 40, top: to.top + 40, width: to.width - 80, height: 200 };
    pane.style.setProperty("--pn-w", to.width + "px");
    pane.style.setProperty("--pn-h", to.height + "px");
    // A sheet caught closing keeps its ghost and simply turns round.
    if (el && !ghost) {
      el.classList.remove("is-away");
      ghost = el.cloneNode(true);
      ghost.classList.add("pn-ghost");
      ghost.style.cssText = "";
      ghost.removeAttribute("tabindex");
      ghost.setAttribute("aria-hidden", "true");
      ghost.inert = true;
      clip.appendChild(ghost);
      el.classList.add("is-away");
    }
    paint(drive.get());
    drive.to(1, "travel");
    lastChange = performance.now();
    document.getElementById("work").classList.add("has-pane");
    pane.querySelector(".pn-title").focus({ preventScroll: true });
  }

  /** Changes what the open sheet shows, when another card is chosen. */
  function swap(id) {
    var t = Store.task(id);
    if (awayEl) awayEl.classList.remove("is-away");
    var el = document.querySelector('#lanes .card[data-id="' + id + '"]');
    if (el) el.classList.add("is-away");
    awayEl = el;
    openId = id;
    if (ghost) {
      ghost.remove();
      ghost = null;
    }
    if (el) {
      ghost = el.cloneNode(true);
      ghost.classList.remove("is-away");
      ghost.classList.add("pn-ghost");
      ghost.style.cssText = "opacity:0";
      ghost.setAttribute("aria-hidden", "true");
      ghost.inert = true;
      clip.appendChild(ghost);
    }
    var place = el || Board.locate(id);
    if (place) from = cardRect(place);
    lastChange = performance.now();
    Motion.body(inner).set({ o: 0, y: 8 });
    inner.innerHTML = drawInner(t);
    drawHolderOnSheet(t);
    inner.style.transform = "";
    inner.style.opacity = "";
    var a = inner.animate(Motion.isReduced() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: Motion.isReduced() ? 120 : 200, easing: "cubic-bezier(.2,.8,.2,1)" });
    a.onfinish = function () { inner.style.opacity = "1"; };
    pane.querySelector(".pn-title").focus({ preventScroll: true });
  }

  /** Redraws the open details after a change, in place. */
  function refresh() {
    if (!openId) return;
    var t = Store.task(openId);
    if (!t) return hide();
    inner.innerHTML = drawInner(t);
    drawHolderOnSheet(t);
  }

  /** Asks what the new thread should do, on one line at the foot of the details. */
  function askThread(id) {
    if (openId !== id) show(id);
    var foot = pane.querySelector(".pn-foot");
    if (!foot) return;
    foot.innerHTML = '<form class="pn-thread" data-thread><input placeholder="What should this thread do?" aria-label="What should this thread do?"><kbd>↩</kbd></form>';
    foot.querySelector("input").focus();
  }

  /** Goes back to the Task you came from, or closes when there is none. Esc does this. */
  function back(done) {
    var prev = trail.pop();
    if (prev && Store.task(prev)) {
      swapBack(prev);
      return;
    }
    hide(done);
  }

  function swapBack(id) {
    swap(id);
  }

  /** Sends the suggested answer: what Return does while the details are open. */
  function acceptSuggested() {
    // Return in the first moment after a card changes could be meant for the card before.
    if (performance.now() - lastChange < 250) return;
    var chip = pane.querySelector(".pn-answer.is-suggested");
    if (chip) return chip.click();
    var reply = pane.querySelector(".pn-reply input");
    if (reply) reply.focus();
  }

  /** Closes the details: the sheet folds back into its dent on the board. */
  function hide(done) {
    if (!openId) {
      if (done) done();
      return;
    }
    var closing = openId;
    closingId = closing;
    openId = null;
    trail = [];
    document.querySelectorAll(".is-called").forEach(function (c) { c.classList.remove("is-called"); });
    var el = awayEl && awayEl.isConnected ? awayEl : Board.locate(closing);
    if (el) from = cardRect(el);
    document.getElementById("work").classList.remove("has-pane");
    drive.to(0, "travel", function () {
      pane.hidden = true;
      pane.classList.remove("is-on");
      if (ghost) ghost.remove();
      ghost = null;
      if (awayEl) awayEl.classList.remove("is-away");
      awayEl = null;
      closingId = null;
      if (done) done();
    });
  }

  function currentId() { return openId; }

  function mount() {
    pane = document.getElementById("pane");
    sheet = pane.querySelector(".pn-sheet");
    clip = pane.querySelector(".pn-clip");
    inner = pane.querySelector(".pn-inner");
    drive = Motion.value(0, paint);
    pane.addEventListener("submit", function (e) {
      e.preventDefault();
      var input = e.target.querySelector("input");
      var words = input.value.trim();
      if (!words) return;
      if (e.target.hasAttribute("data-reply")) Actions.answer(openId, words);
      if (e.target.hasAttribute("data-thread")) {
        var id = openId;
        hide(function () { Actions.startThread(id, words); });
      }
    });
    pane.addEventListener("click", function (e) {
      // Everything inside the sheet stays inside it: a click here must never close it.
      if (e.target.closest(".pn-sheet")) e.stopPropagation();
      var answer = e.target.closest("[data-answer]");
      if (answer) return Actions.answer(openId, answer.dataset.answer);
      var act = e.target.closest("[data-act]");
      if (act) return Actions.run(act.dataset.act, openId);
      var open = e.target.closest("[data-open]");
      if (open) return show(open.dataset.open, { followed: true });
      var context = e.target.closest("[data-context]");
      if (context) {
        var ref = context.dataset.context;
        return hide(function () { Filters.showContext(Graph.entity(ref).kind, ref); });
      }
      var stage = e.target.closest("[data-stage-to]");
      if (stage) Actions.moveToStage(openId, stage.dataset.stageTo);
    });
    window.addEventListener("resize", function () {
      if (openId) {
        to = measureTarget();
        pane.style.setProperty("--pn-w", to.width + "px");
        pane.style.setProperty("--pn-h", to.height + "px");
        paint(drive.get());
      }
    });
  }

  return { mount: mount, show: show, hide: hide, back: back, acceptSuggested: acceptSuggested, refresh: refresh, askThread: askThread, currentId: currentId };
})();
