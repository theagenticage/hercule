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

  /** Draws a colleague behind a top edge: the head, and the paws on the edge in front of the sheet. */
  function drawHead(name, pose) {
    var hue = Crew.lookFor(name).hue;
    var delay = -((Crew.hash(name) % 340) / 100).toFixed(2);
    return {
      head: '<span class="card-head" data-pose="' + pose + '">' + Crew.peek(name, { pose: pose, size: 30, crop: 34 }) + "</span>",
      paws: '<span class="card-paws" data-pose="' + pose + '" style="--hue:var(--hue-' + hue + ";--paw-delay:" + delay + 's"><i></i><i></i></span>',
    };
  }

  function drawHolder(h) {
    if (h.kind === "you") return '<span class="card-holder"><i class="card-tab" data-need="' + h.need + '"></i></span>';
    if (h.kind === "agent") {
      var drawn = drawHead(h.name, h.pose);
      return '<span class="card-holder">' + drawn.head + "</span>" + drawn.paws;
    }
    if (h.kind === "person") return '<span class="card-holder"><i class="card-tab card-tab--person" title="' + esc(h.name) + '">' + esc(h.name.charAt(0).toUpperCase()) + "</i></span>";
    return "";
  }

  /** Returns how the age reads: it darkens as a thing that wants you waits, and only then. */
  function decideAgeTone(t) {
    if (t.move !== "you" || t.stage === "landed" || Store.isBlocked(t)) return "";
    if (t.age >= 14) return "old";
    if (t.age >= 7) return "stale";
    return "";
  }

  /** Returns how worn a neglected card looks, from 0 to 1, when Wear is on. */
  function decideWear(t) {
    if (t.stage === "landed" || t.agent) return 0;
    return Math.max(0, Math.min(1, (t.age - 6) / 24));
  }

  /** Returns the line that says where a Task stands: what the summary writer wrote, or what holds it. */
  function describeNow(t) {
    if (t.summaryPending) return '<span class="card-pending">Writing a summary</span>';
    if (Store.isBlocked(t)) return esc(Store.describeNeed(t)) + ".";
    return esc(t.now || "");
  }

  function drawCardInner(t, stack) {
    var holder = Store.decideHolder(t);
    var src = t.source ? '<span class="card-src" title="' + t.source + '">' + Crew.brand(t.source, 13) + "</span>" : "";
    var sync = t.pendingSync ? '<span class="card-sync" title="Waits to sync">' + Crew.icon("clock", 11) + "</span>" : "";
    var more = stack && stack.count ? '<button class="card-more" tabindex="-1" title="' + stack.count + " more here" + (stack.wants ? ", " + stack.wants + (stack.wants === 1 ? " wants" : " want") + " you" : "") + ' (E)">+' + stack.count + "</button>" : "";
    var meta = '<span class="card-meta">' + sync + src + '<time data-tone="' + decideAgeTone(t) + '">' + NW.formatAge(t.age) + "</time>" + more + "</span>";
    var ask = t.ask && t.move === "you" && !Store.isBlocked(t) ? '<div class="card-words card-words--ask" aria-hidden="true"><p class="card-title">' + esc(t.name) + '</p><p class="card-now"><span class="card-need">' + (t.need === "think" ? "Real thinking." : "Quick call.") + '</span> <span class="card-ask">' + esc(t.ask) + "</span></p></div>" : "";
    var also = stack && stack.wants ? '<span class="card-holder card-holder--also"><i class="card-tab card-tab--count">' + stack.wants + "</i></span>" : "";
    return drawHolder(holder) + also + '<i class="card-check">' + Crew.icon("check", 12) + "</i>" +
      '<div class="card-words card-words--rest" aria-hidden="true"><p class="card-title">' + esc(t.name) + '</p><p class="card-now">' + describeNow(t) + "</p></div>" + meta + ask;
  }

  /** Returns a card in words, in the order a person needs them, for a screen reader. */
  function describeCard(t) {
    var stage = NW.STAGES.filter(function (s) { return s.id === t.stage; })[0].name;
    var h = Store.decideHolder(t);
    var who = h.kind === "you" ? "Wants you, " + (t.need === "think" ? "real thinking" : "a quick call") : h.kind === "agent" ? (h.pose === "waiting" ? "An agent asks you" : "An agent is working on it") : h.kind === "person" ? "With " + h.name : Store.isBlocked(t) ? Store.describeNeed(t) : "Nobody has the next move";
    return [t.name, who, stage, t.summaryPending ? "Summary being written" : t.now, t.move === "you" ? t.ask : "", (t.stalled ? "Stalled, " : "") + NW.sayAge(t.age)].filter(Boolean).map(function (part) { return part.replace(/[.?]$/, ""); }).join(". ") + ".";
  }

  /** Draws or updates one Task's card and returns its element. */
  function drawCard(t, stack) {
    var el = node("card:" + t.id, "div", "card");
    if (!el.dataset.id) {
      el.dataset.id = t.id;
      el.tabIndex = -1;
      el.setAttribute("role", "button");
    }
    // The sheet stays the same element for the card's whole life, so a change of height can animate.
    if (!el._body) {
      el.innerHTML = '<span class="card-sheets"></span><i class="card-stock"></i><span class="card-body"></span>';
      el._body = el.querySelector(".card-body");
      el._sheets = el.querySelector(".card-sheets");
    }
    setHTML(el._body, drawCardInner(t, stack));
    // What waits behind this card shows as sheets under it: one, two or three, by how much there is.
    var sheets = !stack || !stack.count ? 0 : stack.count >= 8 ? 3 : stack.count >= 3 ? 2 : 1;
    var html = "";
    for (var i = sheets; i >= 1; i--) html += '<i class="pile-sheet" style="--n:' + i + '"></i>';
    setHTML(el._sheets, html);
    el.setAttribute("aria-label", describeCard(t));
    el.dataset.height = Store.decideHeight(t);
    el.dataset.stalled = t.stalled ? "1" : "";
    var wear = Store.state.wear ? decideWear(t) : 0;
    el.style.setProperty("--wear", wear.toFixed(2));
    el.style.setProperty("--tilt", ((wear * (Crew.hash(t.id) % 2 ? 1 : -1)) * 0.5).toFixed(3) + "deg");
    el.classList.toggle("is-off", Store.isFiltering() && !Store.matches(t));
    el.classList.toggle("is-hit", Store.isFiltering() && Store.matches(t));
    el.classList.toggle("is-selected", !!Store.state.selected[t.id]);
    if (Object.keys(Store.state.selected).length) el.setAttribute("aria-pressed", !!Store.state.selected[t.id]);
    else el.removeAttribute("aria-pressed");
    return el;
  }

  /* ---------- Piles ---------- */

  /**
   * Draws what stands behind a pile's top edge, by the same rule as a card: one tab counting what
   * wants you, and one head if agents are on it.
   */
  function drawPileHolder(p) {
    var mine = p.tasks.filter(function (t) { return t.move === "you" && !t.agent && !Store.isBlocked(t) && t.stage !== "landed"; }).length;
    var agent = p.tasks.filter(function (t) { return t.agent && t.move !== "you"; })[0];
    var out = "";
    var paws = "";
    if (mine) out += '<i class="card-tab card-tab--count">' + mine + "</i>";
    if (agent) {
      var drawn = drawHead(agent.agent, "working");
      out += drawn.head;
      paws = drawn.paws;
    }
    return out ? '<span class="card-holder">' + out + "</span>" + paws : "";
  }

  function drawPile(p) {
    var el = node("pile:" + p.key, "button", "card pile");
    var n = p.tasks.length;
    var sheets = n >= 9 ? 3 : n >= 4 ? 2 : 1;
    el.dataset.pile = p.key;
    el.dataset.kind = p.kind;
    el.dataset.height = p.kind === "landed" ? "etch" : p.tasks.some(function (t) { return t.move === "you" && !Store.isBlocked(t); }) ? "stand" : "flat";
    el.style.setProperty("--sheets", sheets);
    var title = p.kind === "more" ? n + " more" : p.kind === "landed" ? n + " this week" : p.title;
    var count = p.kind === "more" || p.kind === "landed" ? "" : '<em>' + n + "</em>";
    var hits = Store.isFiltering() ? p.tasks.filter(Store.matches).length : n;
    el.classList.toggle("is-off", Store.isFiltering() && hits === 0);
    el.setAttribute("aria-expanded", "false");
    var line = Store.isFiltering() && hits ? hits + " of " + n + " match" : p.kind === "landed" ? "" : Store.describePile(p);
    var wants = p.tasks.filter(function (t) { return t.move === "you" && !t.agent && !Store.isBlocked(t) && t.stage !== "landed"; }).length;
    el.setAttribute("aria-label", title + ", a pile of " + n + (wants ? ". " + wants + (wants === 1 ? " wants" : " want") + " you" : "") + ". Opens a fan.");
    el.setAttribute("aria-haspopup", "dialog");
    var html = drawPileHolder(p);
    for (var i = sheets; i >= 1; i--) html += '<i class="pile-sheet" style="--n:' + i + '"></i>';
    html += '<i class="card-stock"></i><span class="pile-text"><b>' + esc(title) + "</b>" + count + '</span><span class="pile-line">' + esc(line) + "</span>";
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

  function drawCell(key, stage, tasks, full) {
    var cell = node("cell:" + key + ":" + stage, "div", "cell");
    cell.dataset.stage = stage;
    cell.dataset.owner = key;
    cell.setAttribute("role", "group");
    cell.setAttribute("aria-label", NW.STAGES.filter(function (s) { return s.id === stage; })[0].name + ", " + tasks.length + (tasks.length === 1 ? " card" : " cards"));
    var arranged = Store.arrangeCell(tasks, stage, key, full);
    var behind = arranged.behind;
    var stack = behind.length ? { count: behind.length, wants: behind.filter(Store.wantsYou).length } : null;
    var kids = arranged.cards.map(function (t) { return drawCard(t, stack); }).concat(arranged.piles.map(drawPile));
    // A card you just put down stays on the row you chose, and nothing is pushed out to make room.
    arranged.held.forEach(function (t, i) { kids.splice(Math.min(t.heldRow || 0, kids.length), 0, drawCard(t, i === 0 && !arranged.cards.length ? stack : null)); });
    cell._piles = arranged.piles;
    cell._behind = behind;
    cell._stage = stage;
    cell._owner = key;
    if (cell._hold) kids.splice(cell._hold.index, 0, cell._hold.dent);
    place(cell, kids);
    return cell;
  }

  function drawGrid(key, tasks, full) {
    var grid = node("grid:" + key, "div", "grid");
    grid.classList.toggle("is-empty", !tasks.length);
    place(grid, Store.STAGE_IDS.map(function (s) {
      return drawCell(key, s, tasks.filter(function (t) { return t.stage === s; }), full);
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
    b.setAttribute("role", "button");
    b.setAttribute("aria-label", describeCard(t));
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
    reach.hidden = lastStage < 0;
    // One tab stop per wire. The arrows walk its beads.
    wire.setAttribute("role", "group");
    wire.setAttribute("aria-label", tasks.length + (tasks.length === 1 ? " Task" : " Tasks") + ", folded");
    place(wire, [reach].concat(cells));
    var beads = wire.querySelectorAll(".bead");
    beads.forEach(function (b, i) { b.tabIndex = i === 0 ? 0 : -1; });
    return wire;
  }

  /* ---------- Plans ---------- */

  /** Draws a compact bullet graph: landed in ink, in motion lighter, the rest empty, with the target tick. */
  function drawBullet(plan, tasks) {
    if (!plan.total) return "";
    var done = plan.done / plan.total;
    var moving = tasks.filter(function (t) { return t.stage === "reviewing" || t.stage === "building"; }).length / plan.total;
    moving = Math.min(moving, 1 - done);
    return '<span class="bullet" aria-hidden="true"><i class="bullet-done" style="width:' + (done * 100).toFixed(1) + '%"></i><i class="bullet-moving" style="left:' + (done * 100).toFixed(1) + "%;width:" + (moving * 100).toFixed(1) + '%"></i></span><small class="bullet-words">' + plan.done + " of " + plan.total + "</small>";
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
      place(band, [drawGrid("plan-" + plan.id, tasks, !!Store.state.full[plan.project])]);
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
    var mine = all.filter(Store.wantsYou).length;
    var full = !!st.full[p.id];
    lane.classList.toggle("is-full", full);
    var hasMore = all.length > 0;
    var head = node("lanehead:" + p.id, "h3", "lane-head");
    setHTML(head, '<button class="lane-btn" data-fold-lane="' + esc(p.id) + '" aria-expanded="' + !folded + '"><span class="lane-name">' + esc(p.name) + "</span>" + (mine ? '<span class="lane-need">' + mine + " want" + (mine === 1 ? "s" : "") + " you</span>" : "") + '<small class="lane-total">' + (folded ? all.length + " in all" : full ? "One row" : "Show all " + all.length) + "</small>" + "</button>");
    var kids = [head];
    if (folded) {
      kids.push(drawWire("lane-" + p.id, all));
    } else {
      kids.push(drawGrid("lane-" + p.id, loose, full));
      if (plans.length) {
        var box = node("plans:" + p.id, "div", "plans");
        place(box, plans.map(drawPlan));
        kids.push(box);
      }
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
      if (!el.firstChild) el.innerHTML = '<span class="stage-count"></span><span class="stage-name">' + s.name + "</span>";
      var slot = el.firstChild;
      el.classList.toggle("is-zero", n === 0);
      if (prev !== undefined && prev !== n) {
        var up = n > prev;
        slot.innerHTML = '<span class="roll roll--out' + (up ? " is-up" : "") + '">' + prev + '</span><span class="roll roll--in' + (up ? " is-up" : "") + '">' + n + "</span>";
      } else if (prev === undefined) {
        slot.textContent = n;
      }
      return el;
    }));
  }

  var leadHeld = false;
  var lastCounts = {};

  /** Holds the sentence still for a moment, so a card flying to its number arrives first. */
  function holdLead(on) {
    leadHeld = on;
    if (!on) drawLead();
  }

  function drawLead() {
    var c = Store.countAttention();
    var st = Store.state;
    function lens(key, html) {
      return '<button class="lens' + (st.lens === key ? " is-on" : "") + '" aria-pressed="' + (st.lens === key) + '" data-lens="' + key + '">' + html + "</button>";
    }
    var line = "";
    var scene = document.getElementById("work").dataset.scene;
    if (scene === "first" && !st.tasks.length) {
      setHTML(leadEl, '<h2>Nothing on the desk yet.</h2><p class="lead-sub">Work you take on lands here, by stage. Start a thread, and its Task appears by itself.</p>');
      return;
    }
    if (scene === "empty" && !st.tasks.length) {
      setHTML(leadEl, '<h2>The desk is clear.</h2><p class="lead-sub"><span>12 things landed this week. The crew is at rest.</span></p>');
      return;
    }
    if (c.quick && c.think) line = lens("quick",  '<span class="lens-n">' + c.quick + "</span> quick call" + (c.quick === 1 ? "" : "s")) + ", " + lens("think", '<span class="lens-n">' + c.think + "</span> that need" + (c.think === 1 ? "s" : "") + " real thinking") + ".";
    else if (c.quick) line = lens("quick", '<span class="lens-n">' + c.quick + "</span> quick call" + (c.quick === 1 ? "" : "s")) + ".";
    else if (c.think) line = lens("think", '<span class="lens-n">' + c.think + "</span> need" + (c.think === 1 ? "s" : "") + " real thinking") + ".";
    else line = "Nothing wants you right now.";
    var sub = [];
    if (c.agents) sub.push(lens("agents", "<b>" + c.agents + "</b> with agents"));
    if (c.stalled) sub.push(lens("stalled", "<b>" + c.stalled + "</b> stalled"));
    if (c.blocked) sub.push("<span><b>" + c.blocked + "</b> blocked</span>");
    if (scene === "offline") sub.unshift('<span class="lead-offline">Offline since 09:12. Moves wait until you are back.</span>');
    if (leadHeld) return;
    var door = c.quick + c.think ? '<button class="lead-door" data-walk title="Walk through what wants you (N)"><span>Start</span><kbd>N</kbd></button>' : "";
    setHTML(leadEl, "<h2>" + line + door + '</h2><p class="lead-sub">' + sub.join('<i class="sep"></i>') + "</p>");
    // A number that went down rolls, because the sentence getting shorter is the reward.
    ["quick", "think"].forEach(function (key) {
      var n = leadEl.querySelector('.lens[data-lens="' + key + '"] .lens-n');
      if (n && lastCounts[key] !== undefined && c[key] < lastCounts[key]) n.classList.add("is-rolling");
      lastCounts[key] = c[key];
    });
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
    // Cards in an open fan are outside the lanes, and just as real.
    Fan.openCards().forEach(function (c) {
      var t = Store.task(c.dataset.id);
      if (t) drawCard(t);
    });
    Fan.refreshHead();
    markLongTitles();
    drawReaches();
    if (window.Shell) Shell.syncWithBoard();
    work.dataset.lens = Store.state.lens || "";
    work.classList.toggle("is-filtering", Store.isFiltering());
    var status = document.getElementById("board-status");
    if (status) status.textContent = Store.isFiltering() ? Store.state.tasks.filter(Store.matches).length + " of " + Store.state.tasks.length + " match" : "";
    work.classList.toggle("has-wear", Store.state.wear);
  }

  /** Draws the darker part of each wire, from its first bead to its last. */
  function drawReaches() {
    var reads = [];
    lanesEl.querySelectorAll(".wire").forEach(function (w) {
      var beads = w.querySelectorAll(".bead");
      if (!beads.length) return;
      var a = beads[0];
      var b = beads[beads.length - 1];
      var left = a.offsetLeft;
      var right = b.offsetLeft + b.offsetWidth;
      reads.push([w.querySelector(".wire-reach"), left, right - left]);
    });
    reads.forEach(function (r) {
      r[0].style.left = r[1] + "px";
      r[0].style.width = r[2] + "px";
    });
  }

  /** Marks each card whose title takes two lines, so its summary gets one line and an ellipsis. */
  function markLongTitles() {
    var reads = [];
    lanesEl.querySelectorAll(".card[data-id]").forEach(function (c) {
      var title = c.querySelector(".card-words--rest .card-title");
      if (title) reads.push([c, title.offsetHeight > 20]);
    });
    reads.forEach(function (r) { r[0].classList.toggle("has-long-title", r[1]); });
  }

  /** Lists the moving parts currently on the page, for FLIP. */
  function movables() {
    return Array.prototype.slice.call(lanesEl.querySelectorAll(".card:not(.is-carried), .lane-head, .plan-head, .wire, .plan-band, .bead:not(.is-held)"));
  }

  /** Sends a copy of a card that just left the desk to the pile or bead that now holds it. */
  function flyInto(card, target, spring) {
    var flight = document.getElementById("flight");
    var host = flight.getBoundingClientRect();
    var copy = card.el.cloneNode(true);
    copy.classList.add("is-ghost");
    copy.classList.remove("is-moving");
    copy.style.cssText = "position:absolute;margin:0;left:" + (card.rect.left - host.left) + "px;top:" + (card.rect.top - host.top) + "px;width:" + card.rect.width + "px;height:" + card.rect.height + "px";
    flight.appendChild(copy);
    var r = target.getBoundingClientRect();
    Motion.body(copy).to({ x: r.left + r.width / 2 - (card.rect.left + card.rect.width / 2), y: r.top + r.height / 2 - (card.rect.top + card.rect.height / 2), s: target.classList.contains("bead") ? 0.1 : 0.94, o: 0 }, spring || "travel", {
      done: function () { copy.remove(); },
    });
  }

  /**
   * Changes something and animates the board from what was on screen to what is now true.
   * A card that left the desk but still exists went into a pile or a bead, and is seen going there.
   * Pass quietExits when the caller draws those flights itself.
   */
  function change(mutate, opts) {
    opts = opts || {};
    var before = {};
    lanesEl.querySelectorAll(".card[data-id]").forEach(function (el) {
      before[el.dataset.id] = { el: el, rect: el.getBoundingClientRect() };
    });
    var active = document.activeElement;
    // The lane at the top of the view stays exactly where it is, however much changes around it.
    var view = scrollEl.getBoundingClientRect();
    var lanes = lanesEl.querySelectorAll(".lane");
    var anchor = null;
    for (var i = 0; i < lanes.length; i++) {
      if (lanes[i].getBoundingClientRect().bottom > view.top + 120) {
        anchor = lanes[i];
        break;
      }
    }
    var anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
    Motion.flip(movables(), function () {
      if (mutate) mutate();
      draw();
      if (anchor && anchor.isConnected && !opts.noAnchor) scrollEl.scrollTop += Motion.layoutRect(anchor).top - anchorTop;
    }, opts);
    // Moving a card in the page drops its focus. Whoever was on it stays on it.
    if (active && active !== document.activeElement && active.isConnected) active.focus({ preventScroll: true });
    if (opts.quietExits) return;
    Object.keys(before).forEach(function (id) {
      var b = before[id];
      if (b.el.isConnected || !Store.task(id)) return;
      var target = locate(id);
      if (target) flyInto(b, target, opts.spring === "self" ? "self" : "travel");
    });
    var known = opts.known || [];
    lanesEl.querySelectorAll(".card[data-id]").forEach(function (el) {
      if (before[el.dataset.id] || known.indexOf(el.dataset.id) >= 0 || !Store.task(el.dataset.id)) return;
      Motion.body(el).set({ o: 0 }).to({ o: 1 }, "travel");
    });
  }

  function mount() {
    function measure() {
      markLongTitles();
      drawReaches();
    }
    window.addEventListener("resize", measure);
    document.fonts.ready.then(measure);
    lanesEl = document.getElementById("lanes");
    ruleEl = document.getElementById("rule");
    leadEl = document.getElementById("lead");
    scrollEl = document.getElementById("scroll");
    flightEl = document.getElementById("flight");
    draw();
  }

  /**
   * Finds what stands for a Task on the page right now: its card, the pile that holds it, or its
   * bead. Returns null when it has no place on screen.
   */
  function locate(id) {
    var card = lanesEl.querySelector('.card[data-id="' + id + '"]');
    if (card) return card;
    var bead = lanesEl.querySelector('.bead[data-id="' + id + '"]');
    if (bead) return bead;
    var found = null;
    lanesEl.querySelectorAll(".cell").forEach(function (cell) {
      (cell._piles || []).forEach(function (p) {
        if (p.tasks.some(function (t) { return t.id === id; })) found = cell.querySelector('[data-pile="' + p.key + '"]');
      });
      if ((cell._behind || []).some(function (t) { return t.id === id; })) found = cell.querySelector(".card");
    });
    return found;
  }

  /** Finds the Task cards behind a card on the desk, as a pile a fan can open. */
  function readStack(card) {
    var cell = card.closest(".cell");
    if (!cell || !cell._behind || !cell._behind.length) return null;
    var project = Store.state.projects.filter(function (p) { return "lane-" + p.id === cell._owner; })[0];
    var plan = Store.state.plans.filter(function (p) { return "plan-" + p.id === cell._owner; })[0];
    var stage = NW.STAGES.filter(function (s) { return s.id === cell._stage; })[0].name;
    return { key: "stack:" + cell._owner + ":" + cell._stage, kind: "stack", title: (project ? project.name : plan.name) + ", " + stage, tasks: cell._behind.slice() };
  }

  return { mount: mount, locate: locate, readStack: readStack, holdLead: holdLead, draw: draw, drawHead: drawHead, change: change, movables: movables, node: node, drawCard: drawCard, esc: esc, holdOpen: holdOpen, releaseHold: releaseHold };
})();
