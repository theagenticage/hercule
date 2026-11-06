// PROTOTYPE - carrying a card. The star of the board's motion.
//
// A press only dents the card. Past a few pixels it lifts: it rises on a spring, and from then on it
// is exactly under your finger. A slot opens where it would land, and everything below it moves
// aside. Held still over the middle of another card, the two are drawn together: let go, and they
// merge. Esc sends it home. Nothing is ever a jump: every change starts from what is on screen.
window.Drag = (function () {
  "use strict";

  var MERGE_DWELL = 600; // how long a card must rest over another before they are drawn together
  var START_DISTANCE = 5;
  var press = null;
  var carry = null;
  var scrollFrame = 0;

  function layer() { return document.getElementById("carry"); }
  function work() { return document.getElementById("work"); }
  function scroller() { return document.getElementById("scroll"); }
  function isActive() { return !!carry || (!!bead && bead.moved); }

  /** Lists every place a card can land, top to bottom. */
  function readDropZones() {
    var zones = [];
    document.querySelectorAll("#lanes .grid").forEach(function (grid) {
      var r = grid.getBoundingClientRect();
      zones.push({ key: grid.dataset.key.replace("grid:", ""), grid: grid, top: r.top, bottom: Math.max(r.bottom, r.top + 88) });
    });
    // A folded lane or plan is a target too: the card shrinks into a bead on its wire.
    document.querySelectorAll("#lanes .wire").forEach(function (wire) {
      var r = wire.getBoundingClientRect();
      zones.push({ key: wire.dataset.key.replace("wire:", ""), wire: wire, top: r.top - 22, bottom: r.bottom + 6 });
    });
    return zones;
  }

  function readStages() {
    return Array.prototype.map.call(document.querySelectorAll("#rule .stage"), function (el) {
      var r = el.getBoundingClientRect();
      return { id: el.dataset.stage, left: r.left, el: el };
    });
  }

  function pickStageAt(stages, x) {
    var pick = stages[0];
    stages.forEach(function (s) { if (x >= s.left - 7) pick = s; });
    return pick;
  }

  function pickZone(y) {
    var best = null;
    var bestGap = Infinity;
    carry.zones.forEach(function (z) {
      var gap = y < z.top ? z.top - y : y > z.bottom ? y - z.bottom : 0;
      if (gap < bestGap) {
        bestGap = gap;
        best = z;
      }
    });
    return best;
  }

  function cellIn(zone, stageId) {
    return zone.grid.querySelector('.cell[data-stage="' + stageId + '"]');
  }

  /** Returns the card whose middle the pointer is over. The middle means merge, and moves no slot. */
  function findCardMiddle(x, y, cell) {
    var kids = cell.querySelectorAll(".card[data-id]");
    for (var i = 0; i < kids.length; i++) {
      var r = kids[i].getBoundingClientRect();
      if (x > r.left && x < r.right && y > r.top + r.height * 0.3 && y < r.bottom - r.height * 0.3) return kids[i];
    }
    return null;
  }

  /** Puts the slot at the row the pointer is over. Everything below moves aside, and nothing jumps. */
  function moveSlot(cell, y, middle) {
    var kids = Array.prototype.filter.call(cell.children, function (c) { return !c.classList.contains("slot"); });
    var before = null;
    // Arriving on a card's middle, the slot opens after it, so the card stays under the pointer.
    if (middle) {
      before = middle.nextElementSibling === carry.slot ? carry.slot.nextElementSibling : middle.nextElementSibling;
    } else {
      for (var i = 0; i < kids.length; i++) {
        var r = kids[i].getBoundingClientRect();
        if (y < r.top + r.height / 2) {
          before = kids[i];
          break;
        }
      }
    }
    var slot = carry.slot;
    if (slot.parentElement === cell && slot.nextElementSibling === before) return;
    Motion.flip(Board.movables(), function () {
      if (slot.parentElement !== cell) slot.classList.add("is-new");
      cell.insertBefore(slot, before);
    }, { spring: "hand" });
    setTimeout(function () { slot.classList.remove("is-new"); }, 30);
    carry.zones = readDropZones();
  }

  function setTargetStage(stage) {
    if (carry.stage === stage) return;
    if (carry.stage) carry.stage.el.classList.remove("is-target");
    carry.stage = stage;
    stage.el.classList.add("is-target");
    var rule = document.getElementById("rule").getBoundingClientRect();
    var r = stage.el.getBoundingClientRect();
    Motion.body(document.getElementById("rule-mark")).to({ x: r.left - rule.left }, "hand");
    work().dataset.dragStage = stage.id;
  }

  function setMerge(target) {
    if (carry.merge === target) return;
    if (carry.merge) {
      carry.merge.classList.remove("is-merge-target");
      Motion.body(carry.merge).to({ s: 1 }, "hand");
      carry.catchUntil = performance.now() + 200;
    }
    carry.merge = target;
    carry.slot.classList.toggle("is-shut", !!target);
    if (target) {
      var name = Store.task(target.dataset.id).name;
      target.dataset.mergeLabel = "Merge into " + (name.length > 22 ? name.slice(0, 21) + "…" : name);
      target.classList.add("is-merge-target");
      Motion.body(target).to({ s: 1.02 }, "hand");
    }
  }

  function setWireTarget(zone) {
    document.querySelectorAll(".wire.is-target").forEach(function (w) { w.classList.remove("is-target"); });
    if (zone) zone.wire.classList.add("is-target");
  }

  /** Follows the pointer: moves the card, then decides where it would land. */
  function track(x, y) {
    var c = carry;
    var now = performance.now();
    var dt = Math.max(8, now - c.lastT);
    // Lean comes from smoothed speed, so a shaky hand does not make the card shiver.
    c.vx = c.vx * 0.7 + ((x - c.lastX) / dt) * 0.3;
    c.vy = c.vy * 0.7 + ((y - c.lastY) / dt) * 0.3;
    c.lastX = x;
    c.lastY = y;
    c.lastT = now;
    var lean = Math.max(-1.2, Math.min(1.2, c.vx * 0.9));
    clearTimeout(c.upright);
    c.upright = setTimeout(function () {
      if (carry === c && !c.merge) Motion.body(c.el).to({ r: 0 }, "hand");
    }, 60);
    var b = Motion.body(c.el);
    if (c.merge) {
      // Drawn in: the carried card docks on the target's corner and shrinks a little.
      var m = c.merge.getBoundingClientRect();
      b.to({ x: m.left + 10 - c.home.left, y: m.top + 8 - c.home.top, s: 0.96, r: 0, l: 0.6 }, "hand");
    } else if (now < c.catchUntil) {
      b.to({ x: x - c.grabX - c.home.left, y: y - c.grabY - c.home.top, s: 1.03, r: lean, l: 1 }, "hand");
    } else {
      b.follow(x - c.grabX - c.home.left, y - c.grabY - c.home.top);
      b.to({ s: 1.03, r: lean, l: 1 }, "hand");
    }
    if (c.followers.length) moveFollowers(x - c.grabX - c.home.left, y - c.grabY - c.home.top);

    var stage = pickStageAt(c.stages, x);
    setTargetStage(stage);
    var zone = pickZone(y);
    setWireTarget(zone.wire ? zone : null);
    if (zone.wire) {
      setMerge(null);
      c.hoverCard = null;
      c.zone = zone;
      if (c.slot.parentElement) {
        Motion.flip(Board.movables(), function () { c.slot.remove(); }, { spring: "hand" });
        c.zones = readDropZones();
      }
      return;
    }
    var cell = cellIn(zone, stage.id);
    if (!cell) return;
    c.zone = zone;
    var middle = findCardMiddle(x, y, cell);
    if (middle !== c.hoverCard) {
      c.hoverCard = middle;
      clearTimeout(c.dwell);
      if (!middle) {
        setMerge(null);
      } else {
        c.dwell = setTimeout(function () {
          if (carry && carry.hoverCard === middle) {
            setMerge(middle);
            track(carry.lastX, carry.lastY);
          }
        }, MERGE_DWELL);
      }
    }
    if (!middle) moveSlot(cell, y);
    else if (c.slot.parentElement !== cell) moveSlot(cell, y, middle);
  }

  function begin(e) {
    var p = press;
    press = null;
    var el = p.el;
    var t = Store.task(p.id);
    var home = el.getBoundingClientRect();
    var fromCell = el.closest(".cell");
    var slot = document.createElement("div");
    slot.className = "slot";
    if (fromCell) fromCell.insertBefore(slot, el);
    var fromRow = fromCell ? Array.prototype.indexOf.call(fromCell.children, slot) : -1;
    var fromFan = !!el.closest(".fan");
    Motion.body(el).clear();
    layer().appendChild(el);
    el.classList.add("is-carried");
    el.style.left = home.left + "px";
    el.style.top = home.top + "px";
    el.style.width = home.width + "px";
    if (fromFan) Fan.hide();
    carry = {
      el: el, id: p.id, task: t, home: home, slot: slot, fromCell: fromCell, fromRow: fromRow,
      grabX: p.x - home.left, grabY: p.y - home.top,
      lastX: p.x, lastY: p.y, lastT: performance.now(), vx: 0, vy: 0, catchUntil: 0,
      stage: null, merge: null, hoverCard: null, zone: null, followers: [],
      zones: readDropZones(), stages: readStages(),
    };
    var rule = document.getElementById("rule").getBoundingClientRect();
    var own = carry.stages.filter(function (s) { return s.id === t.stage; })[0];
    Motion.body(document.getElementById("rule-mark")).set({ x: own.left - rule.left });
    work().classList.add("is-carrying");
    gatherSelection();
    track(e.clientX, e.clientY);
  }

  /* ---------- Several cards at once ---------- */

  /** Picks up the rest of the selection: each selected card flies in behind the one in hand. */
  function gatherSelection() {
    var c = carry;
    if (!Store.state.selected[c.id]) return;
    Object.keys(Store.state.selected).forEach(function (id) {
      if (id === c.id) return;
      var src = document.querySelector('#lanes .card[data-id="' + id + '"]');
      if (!src) return;
      var r = src.getBoundingClientRect();
      var ghost = Motion.ghost(src, layer());
      ghost.style.position = "fixed";
      ghost.style.left = r.left + "px";
      ghost.style.top = r.top + "px";
      ghost.classList.add("is-follower");
      src.classList.add("is-away");
      c.followers.push({ id: id, ghost: ghost, src: src, r: r, n: c.followers.length + 1 });
    });
    c.el.classList.toggle("has-followers", c.followers.length > 0);
    if (c.followers.length) c.el.dataset.count = c.followers.length + 1;
  }

  function moveFollowers(goalX, goalY) {
    carry.followers.forEach(function (f) {
      Motion.body(f.ghost).to({ x: carry.home.left + goalX + f.n * 5 - f.r.left, y: carry.home.top + goalY + f.n * 5 - f.r.top, s: 1 - f.n * 0.02 }, "travel");
    });
  }

  function releaseFollowers(c, to) {
    c.followers.forEach(function (f) {
      f.src.classList.remove("is-away");
      if (to) Store.moveTask(f.id, to);
    });
  }

  function settleFollowers(c) {
    c.followers.forEach(function (f, i) {
      var r0 = f.ghost.getBoundingClientRect();
      var el = document.querySelector('#lanes .card[data-id="' + f.id + '"]');
      if (el) {
        var r1 = el.getBoundingClientRect();
        Motion.body(el).set({ x: r0.left - r1.left, y: r0.top - r1.top }).to({ x: 0, y: 0 }, "hand", { delay: 40 + i * 40 });
      }
      f.ghost.remove();
    });
  }

  /* ---------- Letting go ---------- */

  /** Works out where the card lands from the slot, as a rank between its new neighbours. */
  function readLanding() {
    var slot = carry.slot;
    var cell = slot.parentElement;
    if (!cell) return null;
    function rankOf(el) {
      if (!el || !el.dataset.id) return null;
      var t = Store.task(el.dataset.id);
      return t ? t.rank : null;
    }
    var a = rankOf(slot.previousElementSibling);
    var b = rankOf(slot.nextElementSibling);
    var rank = carry.task.rank;
    if (a !== null && b !== null) rank = (a + b) / 2;
    else if (a !== null) rank = a + 0.5;
    else if (b !== null) rank = b - 0.5;
    var owner = cell.dataset.owner;
    var row = Array.prototype.indexOf.call(cell.children, slot);
    // Where it lands decides what it belongs to: a lane's cells hold loose work, a band its plan's.
    var inLane = owner.indexOf("lane-") === 0;
    var plan = inLane ? "" : owner.slice(5);
    var project = inLane ? owner.slice(5) : Store.state.plans.filter(function (p) { return p.id === plan; })[0].project;
    return { cell: cell, row: row, stage: cell.dataset.stage, project: project, plan: plan, before: rank };
  }

  /** Ends the carry. Keeps how the card looks right now, because the landing starts from there. */
  function finish() {
    var c = carry;
    var b = Motion.body(c.el);
    // The landing starts with the speed of the hand, in pixels a second, so a thrown card lands thrown.
    c.look = { rect: c.el.getBoundingClientRect(), s: b.value.s, r: b.value.r, l: b.value.l, vx: c.vx * 600, vy: c.vy * 600 };
    carry = null;
    clearTimeout(c.dwell);
    clearTimeout(c.upright);
    if (c.stage) c.stage.el.classList.remove("is-target");
    work().classList.remove("is-carrying");
    delete work().dataset.dragStage;
    setWireTargetOff();
    return c;
  }

  function setWireTargetOff() {
    document.querySelectorAll(".wire.is-target").forEach(function (w) { w.classList.remove("is-target"); });
  }

  function takeOutOfHand(c) {
    var el = c.el;
    Motion.body(el).clear();
    el.classList.remove("is-carried", "has-followers");
    delete el.dataset.count;
    el.style.left = "";
    el.style.top = "";
    el.style.width = "";
    el.remove();
  }

  /** Returns a card to the page and lets it come down from where it is, on the named spring. */
  function settle(c, spring, mutate) {
    var el = c.el;
    var look = c.look;
    takeOutOfHand(c);
    Board.change(function () {
      c.slot.remove();
      if (mutate) mutate();
    }, { spring: "hand", known: [c.id] });
    if (!el.isConnected) {
      // It belongs to a pile or a folded lane: it is seen going there.
      var target = Board.locate(c.id);
      var copy = el.cloneNode(true);
      copy.classList.add("is-ghost");
      copy.style.cssText = "position:fixed;margin:0;left:" + look.rect.left + "px;top:" + look.rect.top + "px;width:" + look.rect.width + "px;height:" + look.rect.height + "px";
      layer().appendChild(copy);
      var goal = target ? target.getBoundingClientRect() : look.rect;
      Motion.body(copy).to({ x: goal.left + goal.width / 2 - (look.rect.left + look.rect.width / 2), y: goal.top + goal.height / 2 - (look.rect.top + look.rect.height / 2), s: 0.9, o: 0 }, "travel", {
        done: function () { copy.remove(); },
      });
      return;
    }
    var r1 = Motion.layoutRect(el);
    var b = Motion.body(el);
    b.set({ x: look.rect.left + look.rect.width / 2 - (r1.left + r1.width / 2), y: look.rect.top + look.rect.height / 2 - (r1.top + r1.height / 2), s: look.s, r: look.r, l: look.l });
    b.speed.x = look.vx;
    b.speed.y = look.vy;
    el.classList.add("is-landing");
    b.to({ x: 0, y: 0, s: 1, r: 0, l: 0 }, spring, {
      done: function () { el.classList.remove("is-landing"); },
    });
  }

  /** Puts the carried card on a wire: it shrinks into its new bead. */
  function dropOnWire() {
    var zone = carry.zone;
    var stage = carry.stage.id;
    var key = zone.key;
    var c = finish();
    var to = { stage: stage };
    if (key.indexOf("lane-") === 0) to.project = key.slice(5);
    if (key.indexOf("plan-") === 0) to.plan = key.slice(5);
    settle(c, "travel", function () {
      Store.group(c.task.name, function () {
        Store.moveTask(c.id, to);
        releaseFollowers(c, to);
      });
      Store.state.selected = {};
      Select.drawBar();
    });
    settleFollowers(c);
    var bead = document.querySelector('.bead[data-id="' + c.id + '"]');
    if (bead) Motion.body(bead).set({ s: 0.2 }).to({ s: 1 }, "hand", { delay: 220 });
    Toast.show("Moved, and folded away.", true);
  }

  function drop() {
    var c0 = carry;
    if (c0.merge) return mergeNow();
    if (c0.zone && c0.zone.wire) return dropOnWire();
    var landing = readLanding();
    var c = finish();
    if (!landing) return settle(c, "travel", function () { releaseFollowers(c); });
    var moved = landing.stage !== c.task.stage || landing.project !== c.task.project || landing.plan !== (c.task.initiative || "");
    // Put back where it was picked up, a drop changes nothing at all.
    if (!moved && landing.cell === c.fromCell && landing.row === c.fromRow && !c.followers.length) return settle(c, "hand");
    settle(c, "hand", function () {
      Store.group(c.task.name, function () {
        Store.moveTask(c.id, landing);
        c.followers.forEach(function (f, i) {
          f.src.classList.remove("is-away");
          Store.moveTask(f.id, { stage: landing.stage, project: landing.project, plan: landing.plan, row: landing.row + i + 1 });
        });
      });
      if (c.followers.length) {
        Store.state.selected = {};
        Select.drawBar();
      }
    });
    settleFollowers(c);
    if (!moved) return;
    Actions.reportMove(landing);
    if (landing.stage === "landed") {
      c.el.classList.add("just-landed");
      setTimeout(function () { c.el.classList.remove("just-landed"); }, 900);
    }
  }

  function mergeNow() {
    var target = carry.merge;
    var id = target.dataset.id;
    target.classList.remove("is-merge-target");
    var c = finish();
    releaseFollowers(c);
    settleFollowers(c);
    var flight = document.getElementById("flight");
    var ghost = Motion.ghost(c.el, flight);
    var at = ghost.getBoundingClientRect();
    takeOutOfHand(c);
    var into;
    target.classList.add("has-merged");
    Board.change(function () {
      c.slot.remove();
      into = Store.mergeTasks(c.id, id);
    }, { spring: "hand" });
    // The carried card slides in under its new home, which then settles with a soft bump.
    var r1 = target.getBoundingClientRect();
    var b = Motion.body(ghost);
    b.to({ x: b.value.x + r1.left - at.left, y: b.value.y + r1.top - at.top, s: 0.97, o: 0 }, "hand", {
      done: function () { ghost.remove(); },
    });
    setTimeout(function () { target.classList.remove("has-merged"); }, 620);
    Motion.body(target).set({ s: 1.03 }).to({ s: 1 }, "hand", { delay: 60 });
    Toast.show("Merged into " + into.name + ".", true);
  }

  function cancel() {
    if (bead) {
      var held = bead;
      bead = null;
      document.querySelectorAll("#rule .stage.is-target").forEach(function (s) { s.classList.remove("is-target"); });
      held.el.classList.remove("is-held");
      Motion.body(held.el).to({ x: 0, s: 1 }, "travel");
      return;
    }
    if (!carry) return;
    if (carry.merge) setMerge(null);
    var c = finish();
    settle(c, "travel", function () { releaseFollowers(c); });
    settleFollowers(c);
  }

  /* ---------- Sliding a bead along its wire ---------- */

  var bead = null;

  function beginBead(e, el) {
    bead = { el: el, id: el.dataset.id, x: e.clientX, home: el.getBoundingClientRect().left, moved: false, stages: readStages() };
  }

  function moveBead(e) {
    var dx = e.clientX - bead.x;
    if (!bead.moved && Math.abs(dx) < 4) return;
    bead.moved = true;
    bead.el.classList.add("is-held");
    var x = bead.home + dx;
    // The bead is drawn to the start of a stage as it nears one, like a bead finding a notch.
    var pull = 0;
    bead.stages.forEach(function (s) {
      var d = s.left - x;
      if (Math.abs(d) < 26) pull = d * 0.45;
    });
    Motion.body(bead.el).to({ x: dx + pull, s: 1.5 }, "hand");
    bead.target = pickStageAt(bead.stages, e.clientX);
    document.querySelectorAll("#rule .stage").forEach(function (s) { s.classList.toggle("is-target", s.dataset.stage === bead.target.id); });
  }

  function endBead() {
    var b = bead;
    bead = null;
    document.querySelectorAll("#rule .stage.is-target").forEach(function (s) { s.classList.remove("is-target"); });
    if (!b.moved) return;
    suppressClick();
    b.el.classList.remove("is-held");
    var t = Store.task(b.id);
    var changed = b.target && b.target.id !== t.stage;
    Board.change(function () {
      if (changed) Store.moveTask(b.id, { stage: b.target.id });
    }, { spring: "hand" });
    Motion.body(b.el).to({ s: 1 }, "hand");
    if (changed) Actions.reportMove({ stage: b.target.id });
  }

  /* ---------- Pointer events ---------- */

  function onDown(e) {
    if (e.button !== 0) return;
    var beadEl = e.target.closest(".bead[data-id]");
    if (beadEl) return beginBead(e, beadEl);
    var el = e.target.closest(".card[data-id]");
    if (!el || el.classList.contains("is-ghost") || el.classList.contains("is-away")) return;
    press = { el: el, id: el.dataset.id, x: e.clientX, y: e.clientY };
  }

  function onMove(e) {
    if (bead) return moveBead(e);
    if (press) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < START_DISTANCE) return;
      begin(e);
      e.preventDefault();
      return;
    }
    if (carry) {
      e.preventDefault();
      track(e.clientX, e.clientY);
      autoScroll();
    }
  }

  /** Keeps the board scrolling for as long as the card is held near its top or bottom edge. */
  function autoScroll() {
    if (scrollFrame) return;
    function step() {
      scrollFrame = 0;
      if (!carry) return;
      var s = scroller();
      var r = s.getBoundingClientRect();
      var y = carry.lastY;
      var speed = 0;
      if (y < r.top + 130) speed = -(r.top + 130 - y) / 6;
      if (y > r.bottom - 70) speed = (y - (r.bottom - 70)) / 6;
      if (!speed) return;
      s.scrollTop += speed;
      scrollFrame = requestAnimationFrame(step);
    }
    scrollFrame = requestAnimationFrame(step);
  }

  function onUp(e) {
    if (bead) return endBead();
    if (press) {
      press = null;
      return;
    }
    if (carry) {
      e.preventDefault();
      suppressClick();
      drop();
    }
  }

  function suppressClick() {
    function stop(ev) {
      ev.stopPropagation();
      ev.preventDefault();
      window.removeEventListener("click", stop, true);
    }
    window.addEventListener("click", stop, true);
    setTimeout(function () { window.removeEventListener("click", stop, true); }, 40);
  }

  function mount() {
    // The page can scroll under a carried card, by wheel or at the edges. The card stays in the hand,
    // and what lies under it is read again.
    scroller().addEventListener("scroll", function () {
      if (!carry) return;
      carry.zones = readDropZones();
      track(carry.lastX, carry.lastY);
    }, { passive: true });
    work().addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", cancel);
  }

  return { mount: mount, isActive: isActive, cancel: cancel };
})();
