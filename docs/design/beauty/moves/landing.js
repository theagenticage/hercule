// PROTOTYPE - A real landing: finishing something is the one moment that earns a little ceremony.
// Everything here plays around the page's own moves, which still do all the work: Done still ends
// the Task, and Dismiss still takes the card away.
(function () {
  "use strict";

  // How long the light takes to run round a card, and how long the card stays for it.
  var RIM_MS = 420;
  var HOLD_MS = 460;
  var HOLD_CALM_MS = 300;
  // How long after a card starts for its count that it reaches it.
  var REACHES_COUNT_MS = 240;
  var LINE_MS = 780;

  var unwraps = [];
  var timers = [];
  var waiting = {};
  var playing = false;
  // What undoes the playing now under way, so that switching the move off leaves the board as it was.
  var putBack = null;

  /**
   * Replaces obj[name] with a function that receives the original as its first argument. Returns
   * what puts it back. If another move has wrapped it since, the wrapper stays but passes through.
   */
  function wrap(obj, name, fn) {
    var original = obj[name];
    var live = true;
    var wrapper = function () {
      var args = Array.prototype.slice.call(arguments);
      return live ? fn.apply(this, [original.bind(this)].concat(args)) : original.apply(this, args);
    };
    obj[name] = wrapper;
    unwraps.push(function () {
      live = false;
      if (obj[name] === wrapper) obj[name] = original;
    });
  }

  function later(fn, ms) {
    var t = setTimeout(fn, ms);
    timers.push(t);
    return t;
  }

  /* ---------- The line of light ---------- */

  /**
   * Returns an SVG path round a box, clockwise from its bottom right corner, in steps. The corner
   * follows the sheet's: a circle's arc, or the longer curve of a squircle when Paper is on.
   */
  function buildRimPath(w, h, corner, power) {
    var points = [];
    var STEPS = 10;
    function round(cx, cy, from) {
      for (var i = 0; i <= STEPS; i++) {
        var a = from + (Math.PI / 2) * (i / STEPS);
        var c = Math.cos(a);
        var s = Math.sin(a);
        points.push([cx + corner * Math.sign(c) * Math.pow(Math.abs(c), 2 / power), cy + corner * Math.sign(s) * Math.pow(Math.abs(s), 2 / power)]);
      }
    }
    points.push([w - corner, h]);
    round(corner, h - corner, Math.PI / 2);
    round(corner, corner, Math.PI);
    round(w - corner, corner, Math.PI * 1.5);
    round(w - corner, h - corner, 0);
    return "M" + points.map(function (p) { return p[0].toFixed(2) + " " + p[1].toFixed(2); }).join("L") + "Z";
  }

  /** Runs one line of light round a card, once. A faint tail follows a bright head. */
  function runRim(card, ms) {
    var w = card.offsetWidth;
    var h = card.offsetHeight;
    if (!w) return;
    var sheet = card.querySelector(".card-stock");
    var style = sheet ? getComputedStyle(sheet) : null;
    var corner = style ? parseFloat(style.borderTopLeftRadius) : 6;
    var power = style && /squircle|superellipse\(2\)/.test(style.cornerShape || "") ? 4 : 2;
    var d = buildRimPath(w, h, corner || 6, power);
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "b-rim");
    svg.setAttribute("width", w);
    svg.setAttribute("height", h);
    // Eight lengths of the same line, ending at the same point, build up into a head with a smooth tail.
    [[34, 0.2], [30, 0.2], [26, 0.2], [22, 0.2], [18, 0.2], [14, 0.2], [10, 0.2], [6, 0.2]].forEach(function (part) {
      var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("pathLength", "100");
      path.style.strokeDasharray = part[0] + " " + (100 - part[0]);
      path.style.opacity = part[1];
      svg.appendChild(path);
      path.animate([{ strokeDashoffset: part[0] }, { strokeDashoffset: part[0] - 100 }], { duration: ms, easing: "cubic-bezier(0.45, 0.05, 0.3, 1)", fill: "both" });
    });
    card.appendChild(svg);
    svg.animate([{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: ms, fill: "both" }).finished.then(function () { svg.remove(); }, function () { svg.remove(); });
  }

  /* ---------- Work: a card lands ---------- */

  /** Draws the check where the age was. With reduced motion it only fades in. */
  function drawCheck(card) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "b-check");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.innerHTML = '<path d="M3.4 8.4l3 3 6.2-6.6"/>';
    card.appendChild(svg);
    if (Beauty.isCalm()) svg.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "ease-out" });
    else svg.firstChild.animate([{ strokeDashoffset: 13.4 }, { strokeDashoffset: 0 }], { duration: 240, easing: "cubic-bezier(0.3, 0, 0.2, 1)", fill: "backwards" });
  }

  /**
   * Makes the colleague on a card glad: it looks up with happy eyes, and gives a small hop. Returns
   * what puts the colleague back, because the page keeps a card's element for when Undo returns it.
   */
  function hopHead(card, t) {
    var head = card.querySelector(".card-head");
    if (!head || t.failed) return function () {};
    var name = t.question ? t.question.from : t.agent;
    var before = head.innerHTML;
    var paws = card.querySelector(".card-paws");
    var pose = paws ? paws.dataset.pose : "";
    head.innerHTML = Crew.peek(name, { pose: "done", size: 30, crop: 34 });
    // The done pose wears a badge at its foot, which would peek over the sheet's edge.
    var badge = head.querySelector('circle[cx="40"]');
    if (badge) { badge.nextElementSibling.remove(); badge.remove(); }
    head.style.filter = "none";
    if (paws) paws.dataset.pose = "done";
    head.animate([
      { transform: "none" },
      { transform: "translateY(-5px)", offset: 0.3 },
      { transform: "none", offset: 0.58 },
      { transform: "translateY(-1.5px)", offset: 0.76 },
      { transform: "none" },
    ], { duration: 430, delay: 90, easing: "ease-in-out" });
    return function () {
      head.innerHTML = before;
      head.style.filter = "";
      if (paws) paws.dataset.pose = pose;
    };
  }

  /** Puts one soft ring round a count, going out, as it catches what flew into it. */
  function catchAt(el, x) {
    if (!el) return;
    var r = el.getBoundingClientRect();
    var ring = document.createElement("i");
    ring.className = "b-catch";
    ring.style.left = (x === undefined ? r.left + r.width / 2 : r.left + x) + "px";
    ring.style.top = r.top + r.height / 2 + "px";
    document.body.appendChild(ring);
    ring.animate([{ opacity: 0.9, transform: "scale(0.45)" }, { opacity: 0, transform: "scale(1.25)" }], { duration: 460, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "both" }).finished.then(function () { ring.remove(); }, function () { ring.remove(); });
  }

  /** Returns the card of a Task, when it stands on the board and can be seen. */
  function readCard(id) {
    var card = document.querySelector('#lanes .card[data-id="' + id + '"]');
    if (!card || card.dataset.state === "landed" || card.classList.contains("is-away") || !card.getClientRects().length) return null;
    return card;
  }

  /** Checks whether every Task of an initiative has landed, with at least one still to show for it. */
  function hasFinished(planId) {
    var all = Store.state.tasks.filter(function (t) { return t.initiative === planId; });
    return all.length > 0 && all.every(function (t) { return t.stage === "landed"; });
  }

  /**
   * Plays the moment on a card, then runs finish. A key can move on at once: the moment plays on
   * by itself, so D, D, D walks down a column at the speed of the hand.
   */
  function landCard(id, finish) {
    var card = readCard(id);
    var t = Store.task(id);
    if (!card) return finish();
    var calm = Beauty.isCalm();
    var putHeadBack = function () {};
    card.classList.add("b-is-landing");
    drawCheck(card);
    if (!calm) {
      runRim(card, RIM_MS);
      putHeadBack = hopHead(card, t);
    }
    if (card.classList.contains("is-focus")) {
      var next = card.nextElementSibling || card.previousElementSibling;
      if (next && next.classList.contains("card")) Keys.focusCard(next);
    }
    waiting[id] = {
      card: card,
      run: function () {
        delete waiting[id];
        clearTimeout(waitTimer);
        var keys = document.querySelector("#lanes .card.is-focus");
        var stage = t.stage;
        finish();
        // The copy flying away has what it needs. The card itself may come back with Undo.
        card.classList.remove("b-is-landing");
        card.querySelectorAll(".b-check").forEach(function (c) { c.remove(); });
        putHeadBack();
        // Done gives the focus to the card's neighbour. Whoever has walked on stays where they are.
        if (keys && keys.isConnected) Keys.focusCard(keys);
        else if (playing) {
          Keys.clearFocus();
          document.activeElement.blur();
        }
        if (!calm) later(function () { catchAt(document.querySelector('.stage[data-stage="' + stage + '"] .stage-count')); }, REACHES_COUNT_MS);
      },
    };
    var waitTimer = later(waiting[id].run, calm ? HOLD_CALM_MS : HOLD_MS);
  }

  /** Ends every moment still playing, at once, so that Undo and switching off find the board as it is. */
  function flushLandings() {
    Object.keys(waiting).forEach(function (id) { waiting[id].run(); });
  }

  /** Runs the light along an initiative's line to the end of the board, and lifts its flag. */
  function playLine(planId) {
    var plan = document.querySelector('.plan[data-plan="' + planId + '"]');
    var wire = plan && plan.querySelector(".wire");
    if (!wire) return;
    var reach = wire.querySelector(".wire-reach");
    var fill = document.createElement("i");
    fill.className = "b-fill";
    wire.insertBefore(fill, reach.nextSibling);
    fill.dataset.plan = planId;
    if (Beauty.isCalm()) {
      fill.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 420, easing: "ease-out" });
      return;
    }
    var light = document.createElement("i");
    light.className = "b-fill-light";
    wire.insertBefore(light, fill.nextSibling);
    var width = wire.offsetWidth;
    var ease = "cubic-bezier(0.32, 0, 0.18, 1)";
    fill.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: LINE_MS, easing: ease, fill: "both" });
    light.animate([{ transform: "none", opacity: 0 }, { opacity: 1, offset: 0.08 }, { opacity: 1, offset: 0.9 }, { transform: "translateX(" + width + "px)", opacity: 0 }], { duration: LINE_MS, easing: ease, fill: "both" }).finished.then(function () { light.remove(); }, function () { light.remove(); });
    var flag = plan.querySelector(".plan-flag");
    if (flag) {
      flag.style.transformOrigin = "20% 90%";
      flag.animate([{ transform: "none" }, { transform: "translateY(-4px) rotate(-9deg)", offset: 0.34 }, { transform: "translateY(0.5px) rotate(1deg)", offset: 0.72 }, { transform: "none" }], { duration: 560, delay: LINE_MS - 120, easing: "ease-in-out" });
    }
    // The light goes, and the line stays full: an initiative with nothing left is finished.
    later(function () { light.remove(); }, LINE_MS);
  }

  /** Empties the line of an initiative that is no longer finished, after an undo or a move back. */
  function dropStaleFills() {
    document.querySelectorAll(".b-fill").forEach(function (fill) {
      if (!hasFinished(fill.dataset.plan)) fill.remove();
    });
  }

  /** Holds a card that is on its way into "N landed" at the spot it was dropped, for the light to run. */
  function holdCopy(copy) {
    var b = Motion.body(copy);
    var goal = { x: b.goal.x, y: b.goal.y, s: b.goal.s, r: b.goal.r, o: b.goal.o };
    var spring = b.spring.x;
    Object.keys(goal).forEach(function (c) { b.goal[c] = b.value[c]; b.speed[c] = 0; });
    b.wait = HOLD_MS;
    b.pending = { goal: goal, spring: spring };
    runRim(copy, RIM_MS);
    // The button reads "4 landed", so the ring goes round its number, past the button's padding.
    later(function () { catchAt(document.querySelector('.cell[data-stage="landed"] .cell-more'), 12); }, HOLD_MS + REACHES_COUNT_MS);
  }

  /** Lands whatever was just dropped in Landed, either the copy flying to its count or the card itself. */
  function landDropped() {
    var copy = document.querySelector("#carry .card.is-ghost:last-of-type");
    var card = document.querySelector("#lanes .card.just-landed");
    var id = copy ? copy.dataset.id : card ? card.dataset.id : null;
    if (Beauty.isCalm() || !id) return;
    if (copy) holdCopy(copy);
    else runRim(card, RIM_MS);
    var t = Store.task(id);
    if (t && t.initiative && hasFinished(t.initiative)) later(function () { playLine(t.initiative); }, RIM_MS);
  }

  function startWork() {
    wrap(Board, "change", function (change, fn, options) {
      var result = change(fn, options);
      dropStaleFills();
      return result;
    });
    wrap(Actions, "run", function (run, act, id) {
      if (act !== "done") return run(act, id);
      if (waiting[id]) return;
      var t = Store.task(id);
      var plan = t && t.stage !== "landed" ? t.initiative : "";
      var end = function () {
        run(act, id);
        if (plan && hasFinished(plan)) later(function () { playLine(plan); }, 320);
      };
      // The sheet folds home first, so the moment plays on the card and not under the sheet.
      if (Pane.currentId() === id) Pane.hide(function () { landCard(id, end); });
      else landCard(id, end);
    });
    wrap(Actions, "moveToStage", function (move, id, stage) {
      var t = Store.task(id);
      var plan = t && t.initiative;
      if (stage !== "landed" || !t || t.stage === "landed" || waiting[id] || Pane.currentId() === id) {
        move(id, stage);
        if (stage === "landed" && plan && hasFinished(plan)) later(function () { playLine(plan); }, 320);
        return;
      }
      landCard(id, function () {
        move(id, stage);
        if (plan && hasFinished(plan)) later(function () { playLine(plan); }, 320);
      });
    });
    wrap(Actions, "reportMove", function (report, to) {
      report(to);
      // The page marks a card dropped in Landed just after this returns.
      if (to.stage === "landed") Promise.resolve().then(landDropped);
    });
    wrap(Toast, "undo", function (undo) {
      flushLandings();
      undo();
    });
  }

  /* ---------- The Inbox ---------- */

  /** Runs after a card has really been handed on: the light runs as the card lies flat, and the colleague hops. */
  function greetHandOff(e) {
    var calm = Beauty.isCalm();
    if (calm) return;
    later(function () {
      var el = App.els()[e.id];
      if (!el || !e.task) return;
      var who = el.querySelector(".c-holder-in .cr");
      if (who) who.animate([{ transform: "none" }, { transform: "translateY(-4px)", offset: 0.34 }, { transform: "none", offset: 0.66 }, { transform: "translateY(-1px)", offset: 0.82 }, { transform: "none" }], { duration: 420, delay: 120, easing: "ease-in-out" });
    }, 190);
  }

  /** Calls fn, and greets the hand-off if fn really gave the thing to someone. */
  function watchHandOff(e, fn) {
    var had = e && e.task;
    var result = fn();
    if (e && !had && e.task && App.els()[e.id]) greetHandOff(e);
    return result;
  }

  function startInbox() {
    wrap(Moves, "perform", function (perform, act, id, anchor, then) {
      var e = App.findEntity(id);
      return watchHandOff(e, function () { return perform(act, id, anchor, then); });
    });
    wrap(Moves, "hand", function (hand, e, workflow, anchor, then) {
      return watchHandOff(e, function () { return hand(e, workflow, anchor, then); });
    });
    wrap(Moves, "take", function (take, e) {
      return watchHandOff(e, function () { return take(e); });
    });
    wrap(Menu, "show", function (show, anchor, flows, pick) {
      return show(anchor, flows, function (w) {
        var id = anchor.closest && anchor.closest("[data-id]");
        var e = id && App.findEntity(id.dataset.id);
        watchHandOff(e, function () { pick(w); });
      });
    });
    wrap(Scenes, "showZero", function (showZero) {
      if (Beauty.isCalm()) return showZero();
      // The sun comes up while the last of the page is still going, so there is never an empty moment.
      var page = document.getElementById("page");
      var last = page.cloneNode(true);
      // For its half second the copy must not answer for the page: the page's scripts look things up by id.
      last.removeAttribute("id");
      last.querySelectorAll("[id]").forEach(function (el) { el.removeAttribute("id"); });
      var r = page.getBoundingClientRect();
      last.style.cssText = "position:fixed;z-index:20;margin:0;left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;height:" + r.height + "px;overflow:hidden;pointer-events:none";
      document.getElementById("main").appendChild(last);
      last.scrollTop = page.scrollTop;
      App.load({ name: "zero", entities: App.state.entities, clusters: [], mode: "zero", draw: function (p) { p.innerHTML = Scenes.drawSunrise("zero"); } });
      Landing.announce("All clear. Nothing from outside needs you.");
      document.getElementById("main").focus({ preventScroll: true });
      last.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 420, easing: "ease-out", fill: "both" }).finished.then(function () { last.remove(); }, function () { last.remove(); });
    });
  }

  /* ---------- Playing it from the panel ---------- */

  /** Returns the cards on screen that match, nearest the top first. */
  function listOnScreen(selector) {
    return Array.prototype.filter.call(document.querySelectorAll(selector), function (el) {
      var r = el.getBoundingClientRect();
      return r.top > 90 && r.bottom < innerHeight - 40 && r.width > 0;
    });
  }

  /** Lets one playing finish before the next begins, and puts everything back after it. */
  function playOnce(run, restore, ms) {
    if (playing) return;
    playing = true;
    run();
    putBack = function () {
      putBack = null;
      restore();
      playing = false;
    };
    later(putBack, ms);
  }

  function playDone() {
    var cards = listOnScreen('#lanes .card[data-id]:not([data-state="blocked"]):not([data-state="landed"])');
    var card = cards.filter(function (c) { return c.querySelector(".card-head"); })[0] || cards[0];
    if (!card) return;
    playOnce(function () { Actions.run("done", card.dataset.id); }, function () {
      Toast.undo();
      Toast.hide();
    }, 2100);
  }

  /** Lands every Task of the initiative closest to done, and brings them back afterwards. */
  function playInitiative() {
    var plans = Store.state.plans.filter(function (p) { return document.querySelector('.plan[data-plan="' + p.id + '"] .wire'); });
    var readOpen = function (p) { return Store.state.tasks.filter(function (t) { return t.initiative === p.id && t.stage !== "landed"; }); };
    plans = plans.filter(function (p) { return readOpen(p).length; }).sort(function (a, b) { return readOpen(a).length - readOpen(b).length; });
    var plan = plans[0];
    if (!plan) return;
    var moved = readOpen(plan).map(function (t) { return { t: t, stage: t.stage }; });
    document.getElementById("scroll").scrollTop = 0;
    playOnce(function () {
      Board.change(function () { moved.forEach(function (m) { m.t.stage = "landed"; }); }, { spring: "travel" });
      later(function () { playLine(plan.id); }, 420);
    }, function () {
      Board.change(function () { moved.forEach(function (m) { m.t.stage = m.stage; }); }, { spring: "travel" });
    }, 3400);
  }

  function playHandOff() {
    var canTake = function (c) {
      var e = App.findEntity(c.dataset.id);
      return !e.task && Card.readWorkflows(e).length;
    };
    var card = listOnScreen("#requests .card--compact[data-id]").filter(canTake)[0] || listOnScreen("#page .card--rich[data-id]").filter(canTake)[0];
    if (!card) return;
    var e = App.findEntity(card.dataset.id);
    playOnce(function () { Moves.hand(e, Card.readWorkflows(e)[0]); }, function () { Moves.undo(); }, 2400);
  }

  Beauty.move("landing", {
    on: function () {
      if (document.getElementById("lanes")) startWork();
      else startInbox();
    },
    off: function () {
      if (document.getElementById("lanes")) flushLandings();
      if (putBack) putBack();
      unwraps.forEach(function (put) { put(); });
      unwraps = [];
      timers.forEach(clearTimeout);
      timers = [];
      document.querySelectorAll(".b-rim, .b-catch, .b-fill, .b-fill-light").forEach(function (el) { el.remove(); });
    },
    play: function (name) {
      if (name === "done") playDone();
      if (name === "initiative") playInitiative();
      if (name === "handoff") playHandOff();
    },
  });
})();
