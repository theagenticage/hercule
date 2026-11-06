// PROTOTYPE - draws the board. A keyed redraw: every card, lane and bead keeps its element for as
// long as it exists, so the motion kernel can move the same object from where it was to where it
// is now. Nothing here decides anything: Store decides, Board draws.
window.Board = (function () {
  "use strict";

  // The Inbox's `cross` status shape in its `bad` tone, so a failure reads the same on both pages.
  var FAILED_MARK = '<svg class="failed-mark" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/><path d="M6 6l4 4M10 6l-4 4"/></svg>';
  var FLAG = '<svg class="plan-flag" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M4 2.2a.8.8 0 0 1 .8.8v.3h7.4c.5 0 .8.6.5 1L10.9 7l1.8 2.7c.3.4 0 1-.5 1H4.8V14a.8.8 0 0 1-1.6 0V3a.8.8 0 0 1 .8-.8Z"/></svg>';

  var nodes = new Map();
  var lanesEl, ruleEl, scrollEl;

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

  function planOf(t) { return Store.state.plans.filter(function (p) { return p.id === t.initiative; })[0]; }

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

  /** Draws who is on a card right now. Only a live Thread stands behind the edge; most cards have nobody. */
  function drawHolder(t) {
    if (!t.agent || (t.stage === "landed" && !t.failed)) return "";
    var drawn = drawHead(t.agent, t.failed ? "failed" : t.question ? "waiting" : "working");
    return '<span class="card-holder">' + drawn.head + "</span>" + drawn.paws;
  }

  /** Returns the line that says where a Task stands. What a Thread asks or a run broke comes first. */
  function describeNow(t) {
    if (t.failed) return FAILED_MARK + esc(Store.describeFailure(t));
    if (t.question) return esc(t.question.text);
    if (t.summaryPending) return '<span class="card-pending">Writing a summary</span>';
    if (Store.isBlocked(t)) return Crew.icon("lock", 11) + esc(Store.describeBlocker(t)) + ".";
    return esc(t.now || "");
  }

  /** Returns how worn a neglected card looks, from 0 to 1, when Wear is on. */
  function decideWear(t) {
    if (t.stage === "landed" || t.agent) return 0;
    return Math.max(0, Math.min(1, (t.age - 6) / 24));
  }

  function drawCardInner(t, showPlan) {
    var src = t.source ? '<span class="card-src" title="' + esc(Graph.SOURCES[t.source]) + '">' + Crew.brand(t.source, 13) + "</span>" : "";
    var sync = t.pendingSync ? '<span class="card-sync" title="Waits to sync">' + Crew.icon("clock", 11) + "</span>" : "";
    var plan = showPlan && planOf(t);
    var dot = plan ? '<i class="card-plan" style="--plan-hue:' + plan.hue + '" title="' + esc(plan.name) + '"></i>' : "";
    var person = t.person && !/^the /.test(t.person) ? '<i class="card-person" title="' + esc(t.person) + '">' + esc(t.person.charAt(0)) + "</i>" : "";
    var meta = '<span class="card-meta">' + dot + person + sync + src + "<time>" + NW.formatAge(t.age) + "</time></span>";
    var state = Store.decideState(t);
    return drawHolder(t) + '<i class="card-check">' + Crew.icon("check", 12) + "</i>" +
      '<div class="card-words" aria-hidden="true"><p class="card-title">' + esc(t.name) + '</p><p class="card-now' + (state === "failed" ? " card-failed" : state === "question" ? " card-question" : "") + '">' + describeNow(t) + "</p></div>" + meta;
  }

  /** Returns a card in words, in the order a person needs them, for a screen reader. */
  function describeCard(t) {
    var stage = NW.STAGES.filter(function (s) { return s.id === t.stage; })[0].name;
    var who = t.failed ? Store.describeFailure(t) : t.question ? "A Thread asks: " + t.question.text : t.agent ? "An agent is working on it" : Store.isBlocked(t) ? Store.describeBlocker(t) : "";
    return [t.name, who, stage, t.summaryPending ? "Summary being written" : t.failed || t.question ? "" : t.now, NW.sayAge(t.age)].filter(Boolean).map(function (part) { return part.replace(/[.?]$/, ""); }).join(". ") + ".";
  }

  /**
   * Draws or updates one Task's card and returns its element. A Task that sits under two lanes has a
   * card in each: `lane` keeps them apart, and only a grouping by an outside thing passes it.
   */
  function drawCard(t, lane) {
    var el = node("card:" + (lane ? lane + ":" : "") + t.id, "div", "card");
    if (!el.dataset.id) {
      el.dataset.id = t.id;
      el.tabIndex = -1;
      el.setAttribute("role", "button");
    }
    // The sheet stays the same element for the card's whole life, so a change of height can animate.
    if (!el._body) {
      el.innerHTML = '<i class="card-stock"></i><span class="card-body"></span>';
      el._body = el.querySelector(".card-body");
    }
    setHTML(el._body, drawCardInner(t, Store.state.groupBy !== "project"));
    el.setAttribute("aria-label", describeCard(t));
    el.dataset.state = Store.decideState(t);
    var wear = Store.state.wear ? decideWear(t) : 0;
    el.style.setProperty("--wear", wear.toFixed(2));
    el.style.setProperty("--tilt", ((wear * (Crew.hash(t.id) % 2 ? 1 : -1)) * 0.5).toFixed(3) + "deg");
    el.classList.toggle("is-selected", !!Store.state.selected[t.id]);
    if (Object.keys(Store.state.selected).length) el.setAttribute("aria-pressed", !!Store.state.selected[t.id]);
    else el.removeAttribute("aria-pressed");
    return el;
  }

  /* ---------- Stacks ---------- */

  /** Says what a stack holds, in the words its kinds declare: "2 pull requests". */
  function describeMembers(members) {
    var words = {};
    members.forEach(function (m) {
      var ref = m.entities[0];
      words[ref ? Graph.kindOf(ref).word : "Task"] = true;
    });
    var kinds = Object.keys(words);
    var word = kinds.length === 1 ? kinds[0].toLowerCase() : "linked Task";
    return members.length + " " + word + (members.length === 1 ? "" : "s");
  }

  /**
   * Draws things that truly belong together: the lead is a card like any other, and what it holds
   * peeks from under it as a sheet with its reason written on it. Clicking the card opens the card.
   * Clicking the sheet opens the stack, in place.
   */
  function drawStack(item, key, lane) {
    var lead = item.lead;
    var open = Store.isStackOpen(item);
    var el = node("stack:" + key + ":" + lead.id, "div", "stack");
    el.dataset.id = lead.id;
    el.classList.toggle("is-open", open);
    var bar = node("stackbar:" + key + ":" + lead.id, "button", "stack-bar");
    bar.dataset.stack = lead.id;
    bar.setAttribute("aria-expanded", open);
    var loud = item.members.filter(Store.isLoud).length;
    setHTML(bar, "<span>" + esc(describeMembers(item.members)) + "</span>" + (loud ? '<i class="stack-dot"></i>' : "") + Crew.icon("chev-d", 12));
    var kids = [drawCard(lead, lane), bar];
    if (open) {
      var box = node("stackbox:" + key + ":" + lead.id, "div", "stack-members");
      place(box, item.members.map(function (m) { return drawCard(m, lane); }));
      kids.push(box);
    }
    place(el, kids);
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

  /** Draws the plain button that opens the rest of a cell in place, or closes it again. */
  function drawMore(key, stage, arranged) {
    var open = !arranged.hidden;
    var el = node("more:" + key + ":" + stage, "button", "cell-more");
    el.dataset.more = key + "/" + stage;
    el.setAttribute("aria-expanded", open);
    var words = open ? "Show fewer" : stage === "landed" ? arranged.hidden + " this week" : arranged.hidden + " more";
    setHTML(el, "<span>" + words + "</span>" + Crew.icon(open ? "chev-ud" : "chev-d", 12));
    return el;
  }

  function drawCell(key, stage, tasks) {
    var cell = node("cell:" + key + ":" + stage, "div", "cell");
    cell.dataset.stage = stage;
    cell.dataset.owner = key;
    cell.setAttribute("role", "group");
    cell.setAttribute("aria-label", NW.STAGES.filter(function (s) { return s.id === stage; })[0].name + ", " + tasks.length + (tasks.length === 1 ? " card" : " cards"));
    var arranged = Store.arrangeCell(tasks, stage, key);
    var lane = Store.state.groupBy === "project" || Store.state.groupBy === "initiative" ? "" : key;
    var kids = arranged.items.map(function (item) { return item.members.length ? drawStack(item, key, lane) : drawCard(item.lead, lane); });
    if (arranged.openable) kids.push(drawMore(key, stage, arranged));
    var shown = {};
    arranged.items.forEach(function (i) { [i.lead].concat(i.members).forEach(function (t) { shown[t.id] = true; }); });
    cell._behind = tasks.filter(function (t) { return !shown[t.id]; }).map(function (t) { return t.id; });
    if (cell._hold) kids.splice(cell._hold.index, 0, cell._hold.dent);
    place(cell, kids);
    return cell;
  }

  function drawGrid(key, tasks) {
    var grid = node("grid:" + key, "div", "grid");
    grid.classList.toggle("is-empty", !tasks.length);
    place(grid, Store.STAGE_IDS.map(function (s) {
      return drawCell(key, s, tasks.filter(function (t) { return t.stage === s; }));
    }));
    return grid;
  }

  /* ---------- Beads on an initiative's line ---------- */

  function decideBeadKind(t) {
    return Store.decideState(t) || "open";
  }

  function drawBead(t) {
    var b = node("bead:" + t.id, "i", "bead");
    b.dataset.id = t.id;
    b.dataset.kind = decideBeadKind(t);
    b.setAttribute("role", "button");
    b.setAttribute("aria-label", describeCard(t));
    return b;
  }

  /** Draws an initiative's line across the stages, with one bead per Task at its stage. */
  function drawWire(key, tasks) {
    var wire = node("wire:" + key, "div", "wire");
    var lastStage = -1;
    var reach = node("reach:" + key, "i", "wire-reach");
    var cells = Store.STAGE_IDS.map(function (s, i) {
      var c = node("wcell:" + key + ":" + s, "span", "wire-cell");
      var inCell = tasks.filter(function (t) { return t.stage === s; });
      if (inCell.length) lastStage = Math.max(lastStage, i);
      var order = { failed: 0, question: 1, open: 2, blocked: 3, landed: 4 };
      var sorted = inCell.slice().sort(function (a, b) { return order[decideBeadKind(a)] - order[decideBeadKind(b)]; });
      c.classList.toggle("is-dense", sorted.length > 10);
      place(c, sorted.map(drawBead));
      return c;
    });
    reach.hidden = lastStage < 0;
    // One tab stop per line. The arrows walk its beads.
    wire.setAttribute("role", "group");
    wire.setAttribute("aria-label", tasks.length + (tasks.length === 1 ? " Task" : " Tasks") + ", folded");
    place(wire, [reach].concat(cells));
    wire.querySelectorAll(".bead").forEach(function (b, i) { b.tabIndex = i === 0 ? 0 : -1; });
    return wire;
  }

  /* ---------- Initiatives ---------- */

  /** Draws "1 failed" for a lane or an initiative, or nothing when no run failed there. */
  function drawFailedCount(tasks) {
    var failed = tasks.filter(function (t) { return t.failed; }).length;
    return failed ? '<span class="count-failed">' + failed + " failed</span>" : "";
  }

  /** Draws one initiative: its head, and either its line or a band of its cards. */
  function drawPlan(plan, showProject) {
    var tasks = Store.tasksIn(function (t) { return t.initiative === plan.id && Store.matches(t); });
    // A filter is a question about Tasks, so what matches shows as cards, not behind a closed row.
    var open = !!Store.state.openPlans[plan.id] || Store.isFiltering();
    var rb = node("plan:" + plan.id, "section", "plan");
    rb.dataset.plan = plan.id;
    rb.classList.toggle("is-open", open);
    rb.style.setProperty("--plan-hue", plan.hue);
    var head = node("planhead:" + plan.id, "button", "plan-head");
    head.dataset.foldPlan = plan.id;
    head.setAttribute("aria-expanded", open);
    var project = showProject ? Store.state.projects.filter(function (p) { return p.id === plan.project; })[0] : null;
    var facts = [project ? project.name : "", plan.total ? plan.done + " of " + plan.total : ""].filter(Boolean).join(" · ");
    setHTML(head, '<span class="chev">' + Crew.icon("chev-r", 12) + "</span>" + FLAG + '<span class="plan-words"><b class="plan-name">' + esc(plan.name) + "</b>" + (facts ? '<small class="plan-facts">' + esc(facts) + "</small>" : "") + "</span>" + drawFailedCount(tasks));
    var kids = [head];
    if (open) {
      var band = node("band:" + plan.id, "div", "plan-band");
      place(band, [drawGrid("plan-" + plan.id, tasks)]);
      kids.push(band);
    } else {
      kids.push(drawWire("plan-" + plan.id, tasks));
    }
    place(rb, kids);
    return rb;
  }

  /** Draws every initiative together, above the lanes. */
  function drawTopPlans(plans) {
    var box = node("topplans", "section", "top-plans");
    var title = node("topplans-title", "h3", "block-title");
    setHTML(title, "Initiatives");
    var list = node("topplans-list", "div", "plans");
    place(list, plans.map(function (p) { return drawPlan(p, true); }));
    place(box, [title, list]);
    return box;
  }

  /* ---------- Lanes ---------- */

  function drawLaneIcon(l) {
    if (l.type === "project") return '<i class="proj proj--' + l.tint + '"></i>';
    if (l.type === "initiative") return '<span class="lane-flag" style="--plan-hue:' + l.hue + '">' + FLAG + "</span>";
    if (l.type === "context") return '<span class="lane-brand">' + Crew.brand(l.source, 14) + "</span>";
    return '<i class="proj proj--none"></i>';
  }

  /** Lists what an outside thing says about itself. Progress shows only if its source reports it. */
  function describeContext(e) {
    var kind = Graph.KINDS[e.kind];
    return [kind.word, e.state, e.progress ? e.progress[0] + " of " + e.progress[1] : ""].filter(Boolean).join(" · ");
  }

  /** Draws a folded lane's one line: how much sits in each stage, under that stage. */
  function drawFoldRow(l) {
    var row = node("fold:" + l.id, "div", "lane-fold");
    row.dataset.foldLane = l.id;
    setHTML(row, Store.STAGE_IDS.map(function (s) {
      var inStage = l.tasks.filter(function (t) { return t.stage === s; });
      var failed = inStage.some(function (t) { return t.failed; });
      var question = inStage.some(function (t) { return t.question; });
      return '<span class="fold-cell" data-stage="' + s + '">' + (failed ? '<i class="fold-dot is-failed"></i>' : question ? '<i class="fold-dot"></i>' : "") + (inStage.length ? "<span>" + inStage.length + "</span>" : "") + "</span>";
    }).join(""));
    return row;
  }

  function drawLane(l) {
    var st = Store.state;
    var lane = node("lane:" + l.id, "section", "lane");
    lane.dataset.lane = l.id;
    lane.dataset.type = l.type;
    var folded = !!st.folded[l.id] && !Store.isFiltering();
    lane.classList.toggle("is-folded", folded);
    var head = node("lanehead:" + l.id, "h3", "lane-head");
    var facts = l.entity ? describeContext(l.entity) : "";
    var add = l.type === "none" ? "" : '<button class="lane-add" data-add-lane="' + esc(l.id) + '" title="Add to ' + esc(l.name) + '" aria-label="Add to ' + esc(l.name) + '">' + Crew.icon("plus", 14) + "</button>";
    setHTML(head, '<button class="lane-btn" data-fold-lane="' + esc(l.id) + '" aria-expanded="' + !folded + '"><span class="chev">' + Crew.icon("chev-r", 12) + "</span>" + drawLaneIcon(l) + '<span class="lane-words"><span class="lane-name">' + esc(l.name) + "</span>" + (facts ? '<small class="lane-facts">' + esc(facts) + "</small>" : "") + '</span><span class="lane-total">' + l.tasks.length + "</span>" + drawFailedCount(l.tasks) + "</button>" + add);
    var kids = [head];
    if (folded) {
      kids.push(drawFoldRow(l));
    } else {
      kids.push(drawGrid("lane-" + l.id, l.loose));
      if (l.plans.length) {
        var box = node("plans:" + l.id, "div", "plans");
        place(box, l.plans.map(function (p) { return drawPlan(p, false); }));
        kids.push(box);
      }
    }
    place(lane, kids);
    return lane;
  }

  /* ---------- The stage headers ---------- */

  function drawRule() {
    var st = Store.state;
    var open = st.tasks.filter(function (t) { return Store.matches(t); });
    place(ruleEl, Store.STAGES.map(function (s) {
      var el = node("stage:" + s.id, "div", "stage");
      el.dataset.stage = s.id;
      var n = open.filter(function (t) { return t.stage === s.id; }).length;
      var prev = el._n;
      el._n = n;
      if (!el.firstChild) el.innerHTML = '<span class="stage-name">' + s.name + '</span><span class="stage-count"></span>';
      var slot = el.lastChild;
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

  /** Redraws everything from the Store. Keeps every element that still stands for the same thing. */
  function draw() {
    var st = Store.state;
    drawRule();
    var work = document.getElementById("work");
    var emptyWorld = !st.tasks.length;
    var welcome = document.getElementById("welcome");
    if (emptyWorld) setHTML(welcome, Welcome.drawEmpty(work.dataset.scene));
    else setHTML(welcome, "");
    work.dataset.planPlace = st.planPlace;
    work.dataset.lanes = st.laneStyle;
    work.dataset.group = st.groupBy === "project" ? "project" : "other";
    var blocks = [];
    if (!emptyWorld) {
      var top = Store.readTopPlans();
      var lanes = Store.readLanes();
      if (top.length) blocks.push(drawTopPlans(top));
      if (top.length && lanes.length) {
        var title = node("lanes-title", "h3", "block-title");
        setHTML(title, "Not in an initiative");
        blocks.push(title);
      }
      blocks = blocks.concat(lanes.map(drawLane));
      if (!blocks.length) {
        var none = node("no-match", "p", "no-match");
        setHTML(none, "No Tasks match this filter.");
        blocks.push(none);
      }
    }
    place(lanesEl, blocks);
    markLongTitles();
    drawReaches();
    if (window.Shell) Shell.syncWithBoard();
    if (window.Toolbar) Toolbar.draw();
    work.classList.toggle("is-filtering", Store.isFiltering());
    var status = document.getElementById("board-status");
    if (status) status.textContent = Store.isFiltering() ? st.tasks.filter(function (t) { return Store.matches(t); }).length + " of " + st.tasks.length + " match" : "";
    work.classList.toggle("has-wear", st.wear);
  }

  /** Draws the bright part of each line, from the start of the board to its last bead. */
  function drawReaches() {
    var reads = [];
    lanesEl.querySelectorAll(".wire").forEach(function (w) {
      var beads = w.querySelectorAll(".bead");
      if (!beads.length) return;
      reads.push([w.querySelector(".wire-reach"), beads[beads.length - 1].getBoundingClientRect().right - w.getBoundingClientRect().left]);
    });
    reads.forEach(function (r) { r[0].style.width = r[1] + "px"; });
  }

  /** Marks each card whose title takes two lines, so its summary gets one line and an ellipsis. */
  function markLongTitles() {
    var reads = [];
    lanesEl.querySelectorAll(".card[data-id]").forEach(function (c) {
      var title = c.querySelector(".card-title");
      if (title) reads.push([c, title.offsetHeight > 20]);
    });
    reads.forEach(function (r) { r[0].classList.toggle("has-long-title", r[1]); });
  }

  /** Lists the moving parts currently on the page, for FLIP. */
  function movables() {
    return Array.prototype.slice.call(lanesEl.querySelectorAll(".card:not(.is-carried), .lane-head, .lane-fold, .plan-head, .wire, .plan-band, .block-title, .stack-bar, .cell-more, .bead:not(.is-held)"));
  }

  /** Sends a copy of a card that just left the desk to what now stands for it. */
  function flyInto(card, target, spring) {
    var flight = document.getElementById("flight");
    var host = flight.getBoundingClientRect();
    var copy = card.el.cloneNode(true);
    copy.classList.add("is-ghost");
    copy.classList.remove("is-moving");
    copy.style.cssText = "position:absolute;margin:0;left:" + (card.rect.left - host.left) + "px;top:" + (card.rect.top - host.top) + "px;width:" + card.rect.width + "px;height:" + card.rect.height + "px";
    flight.appendChild(copy);
    var r = target.getBoundingClientRect();
    var small = target.classList.contains("bead") || target.classList.contains("fold-cell");
    Motion.body(copy).to({ x: r.left + r.width / 2 - (card.rect.left + card.rect.width / 2), y: r.top + r.height / 2 - (card.rect.top + card.rect.height / 2), s: small ? 0.1 : 0.94, o: 0 }, spring || "travel", {
      done: function () { copy.remove(); },
    });
  }

  /**
   * Changes something and animates the board from what was on screen to what is now true.
   * A card that left the page but still exists went somewhere, and is seen going there.
   * Pass quietExits when the caller draws those flights itself.
   */
  function change(mutate, opts) {
    opts = opts || {};
    var before = {};
    lanesEl.querySelectorAll(".card[data-id]").forEach(function (el) {
      before[el.dataset.key] = { el: el, id: el.dataset.id, rect: el.getBoundingClientRect() };
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
    Object.keys(before).forEach(function (key) {
      var b = before[key];
      if (b.el.isConnected || !Store.task(b.id)) return;
      var target = locate(b.id);
      if (target) flyInto(b, target, opts.spring === "self" ? "self" : "travel");
    });
    var known = opts.known || [];
    lanesEl.querySelectorAll(".card[data-id]").forEach(function (el) {
      if (before[el.dataset.key] || known.indexOf(el.dataset.id) >= 0 || !Store.task(el.dataset.id)) return;
      Motion.body(el).set({ o: 0, y: -6 }).to({ o: 1, y: 0 }, "travel");
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
    scrollEl = document.getElementById("scroll");
    draw();
  }

  /**
   * Finds what stands for a Task on the page right now: its card, its bead, the count of its folded
   * lane, or the button that opens the rest of its cell. Returns null when it has no place on screen.
   */
  function locate(id) {
    var card = lanesEl.querySelector('.card[data-id="' + id + '"]');
    if (card) return card;
    var bead = lanesEl.querySelector('.bead[data-id="' + id + '"]');
    if (bead) return bead;
    var t = Store.task(id);
    if (!t) return null;
    var found = null;
    lanesEl.querySelectorAll(".cell").forEach(function (cell) {
      if ((cell._behind || []).indexOf(id) >= 0) found = cell.querySelector(".cell-more") || found;
    });
    if (found) return found;
    var lane = Store.state.groupBy === "project" ? lanesEl.querySelector('.lane[data-lane="' + t.project + '"]') : null;
    return lane ? lane.querySelector('.fold-cell[data-stage="' + t.stage + '"]') : null;
  }

  return { FAILED_MARK: FAILED_MARK, FLAG: FLAG, mount: mount, locate: locate, draw: draw, drawHead: drawHead, change: change, movables: movables, node: node, drawCard: drawCard, esc: esc, describeContext: describeContext, holdOpen: holdOpen, releaseHold: releaseHold };
})();
