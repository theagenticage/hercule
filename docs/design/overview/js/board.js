// PROTOTYPE - draws the board. A keyed redraw: every card, pile, bead and lane keeps its element
// for as long as it exists, so the motion kernel can move the same object from where it was to
// where it is now. Nothing here decides anything: Store decides, Board draws.
window.Board = (function () {
  "use strict";

  var nodes = new Map();
  var lanesEl, ruleEl, leadEl, scrollEl, flightEl;

  function esc(s) { return String(s === undefined ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"); }

  /** Returns the element kept under this key, making it on first use. */
  function node(key, tag, className) {
    var n = nodes.get(key);
    if (!n) {
      n = document.createElement(tag);
      n.className = className;
      n.dataset.key = key;
      nodes.set(key, n);
    }
    return n;
  }

  /** Makes parent's children exactly this list, in this order, touching only what differs. */
  function place(parent, children) {
    var cur = parent.firstElementChild;
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (c === cur) cur = cur.nextElementSibling;
      else parent.insertBefore(c, cur);
    }
    while (cur) {
      var next = cur.nextElementSibling;
      if (!cur.classList.contains("slot") || cur.classList.contains("dent")) cur.remove();
      cur = next;
    }
  }

  function setHTML(el, html) {
    if (el._html !== html) {
      el.innerHTML = html;
      el._html = html;
    }
  }

  /* ---------- Cards ---------- */

  function drawHolder(h) {
    if (h.kind === "you") return '<span class="card-holder"><i class="card-tab" data-need="' + h.need + '"></i></span>';
    if (h.kind === "agent") {
      var hue = Crew.lookFor(h.name).hue;
      return '<span class="card-holder"><span class="card-head" data-pose="' + h.pose + '">' + Crew.peek(h.name, { pose: h.pose, size: 30, crop: 34 }) + '</span></span><span class="card-paws" data-pose="' + h.pose + '" style="--hue:var(--hue-' + hue + ')"><i></i><i></i></span>';
    }
    if (h.kind === "person") return '<span class="card-holder"><i class="card-tab card-tab--person" title="' + esc(h.name) + '">' + esc(h.name.charAt(0).toUpperCase()) + "</i></span>";
    return "";
  }

  /** Returns how the age reads: it darkens as a thing that wants you waits, and only then. */
  function decideAgeTone(t) {
    if (t.move !== "you" || t.stage === "landed") return "";
    if (t.age >= 14) return "old";
    if (t.age >= 7) return "stale";
    return "";
  }

  /** Returns how worn a neglected card looks, from 0 to 1, when Wear is on. */
  function decideWear(t) {
    if (t.stage === "landed" || t.agent) return 0;
    return Math.max(0, Math.min(1, (t.age - 6) / 24));
  }

  function drawCardInner(t) {
    var holder = Store.decideHolder(t);
    var need = Store.describeNeed(t);
    var src = t.source ? '<span class="card-src" title="' + t.source + '">' + Crew.brand(t.source, 12) + "</span>" : "";
    var ask = t.ask && t.move === "you" ? '<div class="card-text card-text--ask"><span class="card-title">' + esc(t.name) + '</span><br><span class="card-ask">' + esc(t.ask) + "</span></div>" : "";
    return drawHolder(holder) + '<i class="card-stock"></i>' +
      '<div class="card-text card-text--rest"><span class="card-title">' + esc(t.name) + "</span><br>" + (t.summaryPending ? '<span class="card-pending">Writing a summary</span>' : esc(t.now || "")) + "</div>" + ask +
      '<footer class="card-foot"><span class="card-need">' + esc(need) + "</span>" + src + '<time data-tone="' + decideAgeTone(t) + '">' + NW.formatAge(t.age) + "</time></footer>";
  }

  /** Draws or updates one Task's card and returns its element. */
  function drawCard(t) {
    var el = node("card:" + t.id, "article", "card");
    if (!el.dataset.id) {
      el.dataset.id = t.id;
      el.tabIndex = -1;
      el.setAttribute("role", "button");
    }
    setHTML(el, drawCardInner(t));
    el.dataset.height = Store.decideHeight(t);
    el.dataset.stalled = t.stalled ? "1" : "";
    var wear = Store.state.wear ? decideWear(t) : 0;
    el.style.setProperty("--wear", wear.toFixed(2));
    el.style.setProperty("--tilt", ((wear * (Crew.hash(t.id) % 2 ? 1 : -1)) * 0.5).toFixed(3) + "deg");
    el.classList.toggle("is-off", Store.isFiltering() && !Store.matches(t));
    el.classList.toggle("is-hit", Store.isFiltering() && Store.matches(t));
    return el;
  }

  /* ---------- Piles ---------- */

  /** Draws the flags that stick out of a pile: one per Task in it that wants you, up to six. */
  function drawFlags(p) {
    var mine = p.tasks.filter(function (t) { return t.move === "you" && !Store.isBlocked(t) && t.stage !== "landed"; });
    var out = "";
    mine.slice(0, 6).forEach(function (t) {
      out += '<i class="card-tab" data-need="' + t.need + '"></i>';
    });
    return out ? '<span class="card-holder pile-flags">' + out + "</span>" : "";
  }

  /** Draws the foot of a pile: the colleagues inside it, and how old its newest Task is. */
  function drawPileFoot(p) {
    var faces = p.tasks.filter(function (t) { return t.agent; }).slice(0, 4).map(function (t) {
      return '<span class="pile-face">' + Crew.face(t.agent, { pose: "working", size: 16 }) + "</span>";
    }).join("");
    var sources = {};
    p.tasks.forEach(function (t) { if (t.source) sources[t.source] = true; });
    var mark = Object.keys(sources).slice(0, 2).map(function (s) { return '<span class="card-src">' + Crew.brand(s, 12) + "</span>"; }).join("");
    return '<span class="pile-faces">' + faces + "</span>" + (faces ? "" : mark);
  }

  function drawPile(p) {
    var el = node("pile:" + p.key, "button", "card pile");
    var n = p.tasks.length;
    var sheets = n >= 9 ? 3 : n >= 4 ? 2 : 1;
    el.dataset.pile = p.key;
    el.dataset.kind = p.kind;
    el.dataset.height = p.kind === "landed" ? "etch" : p.tasks.some(function (t) { return t.move === "you" && !Store.isBlocked(t); }) ? "stand" : "flat";
    el.style.setProperty("--sheets", sheets);
    var title = p.kind === "more" ? n + " more" : p.title;
    var count = p.kind === "more" ? "" : '<em>' + n + "</em>";
    var hidden = Store.isFiltering() ? p.tasks.filter(Store.matches).length : n;
    el.classList.toggle("is-off", Store.isFiltering() && hidden === 0);
    var line = Store.isFiltering() && hidden ? hidden + " of " + n + " match" : Store.describePile(p);
    var html = drawFlags(p);
    for (var i = sheets; i >= 1; i--) html += '<i class="pile-sheet" style="--n:' + i + '"></i>';
    html += '<i class="card-stock"></i><span class="pile-text"><b>' + esc(title) + "</b>" + count + '</span><span class="pile-row"><span class="pile-line">' + esc(line) + "</span>" + drawPileFoot(p) + "</span>";
    setHTML(el, html);
    return el;
  }

  /* ---------- Cells ---------- */

  // A cell keeps a dent open for a moment after a card leaves it by itself, so that what you are
  // looking at does not jump. The dent is drawn at the row the card left.
  function holdOpen(cell, index, dent) {
    cell._hold = { index: index, dent: dent };
  }
  function releaseHold(cell) {
    cell._hold = null;
  }

  function drawCell(key, stage, tasks) {
    var cell = node("cell:" + key + ":" + stage, "div", "cell");
    cell.dataset.stage = stage;
    cell.dataset.owner = key;
    var arranged = Store.arrangeCell(tasks, stage, key);
    var kids = arranged.cards.map(drawCard).concat(arranged.piles.map(drawPile));
    cell._piles = arranged.piles;
    if (cell._hold) kids.splice(cell._hold.index, 0, cell._hold.dent);
    place(cell, kids);
    return cell;
  }

  function drawGrid(key, tasks) {
    var grid = node("grid:" + key, "div", "grid");
    place(grid, Store.STAGE_IDS.map(function (s) {
      return drawCell(key, s, tasks.filter(function (t) { return t.stage === s; }));
    }));
    return grid;
  }

  /* ---------- Beads on a wire ---------- */

  function decideBeadKind(t) {
    if (t.stage === "landed") return "done";
    if (Store.isBlocked(t)) return "held";
    if (t.agent && t.move !== "you") return "agent";
    if (t.move === "you") return t.need === "think" ? "think" : "quick";
    return "other";
  }

  function drawBead(t) {
    var b = node("bead:" + t.id, "i", "bead");
    b.dataset.id = t.id;
    b.dataset.kind = decideBeadKind(t);
    b.classList.toggle("is-off", Store.isFiltering() && !Store.matches(t));
    return b;
  }

  /** Draws a wire across the stages with one bead per Task, at its stage. */
  function drawWire(key, tasks) {
    var wire = node("wire:" + key, "div", "wire");
    var first = 9;
    var lastStage = -1;
    var reach = node("reach:" + key, "i", "wire-reach");
    var cells = Store.STAGE_IDS.map(function (s, i) {
      var c = node("wcell:" + key + ":" + s, "span", "wire-cell");
      var inCell = tasks.filter(function (t) { return t.stage === s; });
      if (inCell.length) {
        first = Math.min(first, i);
        lastStage = Math.max(lastStage, i);
      }
      // People's marks come first and each group stays in its own order, so a bead only moves
      // along the wire when its need changes, and a busy cell still reads as a short count.
      var order = { quick: 0, think: 1, agent: 2, other: 3, held: 4, done: 5 };
      var sorted = inCell.slice().sort(function (a, b) { return order[decideBeadKind(a)] - order[decideBeadKind(b)]; });
      c.classList.toggle("is-dense", sorted.length > 10);
      place(c, sorted.map(drawBead));
      return c;
    });
    if (lastStage >= 0) {
      reach.style.gridColumn = first + 1 + " / " + (lastStage + 2);
    }
    reach.hidden = lastStage < 0;
    place(wire, [reach].concat(cells));
    return wire;
  }

  /* ---------- Plans ---------- */

  /** Draws a compact bullet graph: landed in ink, in motion lighter, the rest empty, with the target tick. */
  function drawBullet(plan, tasks) {
    if (!plan.total) return "";
    var done = plan.done / plan.total;
    var moving = tasks.filter(function (t) { return t.stage === "reviewing" || t.stage === "building"; }).length / plan.total;
    moving = Math.min(moving, 1 - done);
    return '<span class="bullet" role="img" aria-label="' + plan.done + " of " + plan.total + '"><i class="bullet-done" style="width:' + (done * 100).toFixed(1) + '%"></i><i class="bullet-moving" style="left:' + (done * 100).toFixed(1) + "%;width:" + (moving * 100).toFixed(1) + '%"></i></span><small class="bullet-words">' + plan.done + " of " + plan.total + "</small>";
  }

  function drawPlan(plan) {
    var tasks = Store.tasksIn(function (t) { return t.initiative === plan.id; });
    var open = !!Store.state.openPlans[plan.id];
    var rb = node("plan:" + plan.id, "section", "plan");
    rb.dataset.plan = plan.id;
    rb.classList.toggle("is-open", open);
    var mine = tasks.filter(function (t) { return t.move === "you" && !Store.isBlocked(t) && t.stage !== "landed"; }).length;
    var head = node("planhead:" + plan.id, "button", "plan-head");
    head.dataset.foldPlan = plan.id;
    head.setAttribute("aria-expanded", open);
    setHTML(head, '<span class="chev">' + Crew.icon("chev-r", 12) + '</span><b class="plan-name">' + esc(plan.name) + "</b>" + drawBullet(plan, tasks) + (open && plan.intent ? '<span class="plan-intent">' + esc(plan.intent) + "</span>" : ""));
    var kids = [head];
    if (open) {
      var band = node("band:" + plan.id, "div", "plan-band");
      place(band, [drawGrid("plan-" + plan.id, tasks)]);
      kids.push(band);
    } else {
      kids.push(drawWire("plan-" + plan.id, tasks));
    }
    place(rb, kids);
    rb.classList.toggle("is-off", Store.isFiltering() && !tasks.some(Store.matches));
    return rb;
  }

  /* ---------- Lanes ---------- */

  function drawLane(p) {
    var st = Store.state;
    var lane = node("lane:" + p.id, "section", "lane");
    lane.dataset.lane = p.id;
    var folded = !!st.folded[p.id];
    lane.classList.toggle("is-folded", folded);
    var all = Store.tasksIn(function (t) { return t.project === p.id; });
    var loose = all.filter(function (t) { return !t.initiative; });
    var plans = st.plans.filter(function (i) { return i.project === p.id; });
    var mine = all.filter(function (t) { return t.move === "you" && !Store.isBlocked(t) && t.stage !== "landed"; }).length;
    var head = node("lanehead:" + p.id, "button", "lane-head");
    head.dataset.foldLane = p.id;
    head.setAttribute("aria-expanded", !folded);
    setHTML(head, '<i class="proj proj--' + p.tint + '"></i><h3>' + esc(p.name) + "</h3><small>" + all.length + "</small>" + (mine ? '<span class="lane-need">' + mine + " want" + (mine === 1 ? "s" : "") + " you</span>" : "") + '<span class="chev">' + Crew.icon("chev-d", 12) + "</span>");
    var kids = [head];
    if (folded) {
      kids.push(drawWire("lane-" + p.id, all));
    } else {
      plans.forEach(function (i) { kids.push(drawPlan(i)); });
      kids.push(drawGrid("lane-" + p.id, loose));
    }
    place(lane, kids);
    return lane;
  }

  /* ---------- The rule and the sentence ---------- */

  function drawRule() {
    var st = Store.state;
    var open = st.tasks;
    place(ruleEl, Store.STAGES.map(function (s) {
      var el = node("stage:" + s.id, "div", "stage");
      el.dataset.stage = s.id;
      var n = open.filter(function (t) { return t.stage === s.id; }).length;
      var prev = el._n;
      el._n = n;
      if (!el.firstChild) el.innerHTML = '<span class="stage-name">' + s.name + '</span><span class="stage-count"></span>';
      var slot = el.lastChild;
      if (prev !== undefined && prev !== n) {
        var up = n > prev;
        slot.innerHTML = '<span class="roll roll--out' + (up ? " is-up" : "") + '">' + prev + '</span><span class="roll roll--in' + (up ? " is-up" : "") + '">' + n + "</span>";
      } else if (prev === undefined) {
        slot.textContent = n;
      }
      return el;
    }));
  }

  var WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve"];
  function say(n, lower) {
    var w = n < WORDS.length ? WORDS[n] : String(n);
    return lower ? w.toLowerCase() : w;
  }

  function drawLead() {
    var c = Store.countAttention();
    var st = Store.state;
    function lens(key, html) {
      return '<button class="lens' + (st.lens === key ? " is-on" : "") + '" data-lens="' + key + '">' + html + "</button>";
    }
    var line = "";
    var scene = document.getElementById("work").dataset.scene;
    if (scene === "first") {
      setHTML(leadEl, '<h2>Nothing on the desk yet.</h2><p class="lead-sub">Work you take on lands here, by stage. Start a thread, and its Task appears by itself.</p>');
      return;
    }
    if (scene === "empty") {
      setHTML(leadEl, '<h2>The desk is clear.</h2><p class="lead-sub"><span><b>12</b> things landed this week.</span></p>');
      return;
    }
    if (c.quick && c.think) line = lens("quick", '<span class="lens-n">' + say(c.quick) + "</span> quick call" + (c.quick === 1 ? "" : "s")) + ", " + lens("think", '<span class="lens-n">' + say(c.think, true) + "</span> that need" + (c.think === 1 ? "s" : "") + " real thinking") + ".";
    else if (c.quick) line = lens("quick", '<span class="lens-n">' + say(c.quick) + "</span> quick call" + (c.quick === 1 ? "" : "s")) + ".";
    else if (c.think) line = lens("think", '<span class="lens-n">' + say(c.think) + "</span> need" + (c.think === 1 ? "s" : "") + " real thinking") + ".";
    else line = "Nothing wants you right now.";
    var sub = [];
    if (c.agents) sub.push(lens("agents", "<b>" + c.agents + "</b> with agents"));
    if (c.stalled) sub.push(lens("stalled", "<b>" + c.stalled + "</b> stalled"));
    if (c.blocked) sub.push("<span><b>" + c.blocked + "</b> blocked</span>");
    if (scene === "offline") sub.unshift('<span class="lead-offline">Offline since 09:12. Moves wait until you are back.</span>');
    setHTML(leadEl, "<h2>" + line + '</h2><p class="lead-sub">' + sub.join('<i class="sep"></i>') + "</p>");
  }

  /** Redraws everything from the Store. Keeps every element that still stands for the same thing. */
  function draw() {
    drawLead();
    drawRule();
    var work = document.getElementById("work");
    var emptyWorld = !Store.state.tasks.length;
    var welcome = document.getElementById("welcome");
    if (emptyWorld) setHTML(welcome, Welcome.drawEmpty(work.dataset.scene));
    else setHTML(welcome, "");
    place(lanesEl, emptyWorld ? [] : Store.state.projects.filter(function (p) {
      return p.id !== "" || Store.state.tasks.some(function (t) { return t.project === ""; });
    }).map(drawLane));
    work.dataset.lens = Store.state.lens || "";
    work.classList.toggle("is-filtering", Store.isFiltering());
    work.classList.toggle("has-wear", Store.state.wear);
  }

  /** Lists the moving parts currently on the page, for FLIP. */
  function movables() {
    return Array.prototype.slice.call(lanesEl.querySelectorAll(".card:not(.is-carried), .lane-head, .plan-head, .wire, .plan-band"));
  }

  /** Changes something and animates the board from what was on screen to what is now true. */
  function change(mutate, opts) {
    Motion.flip(movables(), function () {
      if (mutate) mutate();
      draw();
    }, opts);
  }

  function mount() {
    lanesEl = document.getElementById("lanes");
    ruleEl = document.getElementById("rule");
    leadEl = document.getElementById("lead");
    scrollEl = document.getElementById("scroll");
    flightEl = document.getElementById("flight");
    draw();
  }

  return { mount: mount, draw: draw, change: change, movables: movables, node: node, drawCard: drawCard, esc: esc, holdOpen: holdOpen, releaseHold: releaseHold };
})();
