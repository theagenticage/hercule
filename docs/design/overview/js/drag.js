// PROTOTYPE - carrying a card. The star of the board's motion.
//
// A press only dents the card. Past a few pixels it lifts: it grows, its shadow deepens, and it
// follows the pointer on a stiff spring, a hair behind, leaning into the way it moves. A slot opens
// where it would land, and neighbours glide aside. Held still over another card's middle, the two
// are drawn together: let go, and they merge. Esc sends it home.
window.Drag = (function () {
  "use strict";

  var MERGE_DWELL = 340; // how long a card must hover over another before they are drawn together
  var START_DISTANCE = 5;
  var press = null;
  var carry = null;

  function layer() { return document.getElementById("carry"); }
  function work() { return document.getElementById("work"); }
  function scroller() { return document.getElementById("scroll"); }
  function isActive() { return !!carry; }

  /** Lists every place a card can land, top to bottom, with the owner each belongs to. */
  function readDropZones() {
    var zones = [];
    document.querySelectorAll("#lanes .grid").forEach(function (grid) {
      var r = grid.getBoundingClientRect();
      var key = grid.dataset.key.replace("grid:", "");
      zones.push({ key: key, grid: grid, top: r.top, bottom: Math.max(r.bottom, r.top + 96) });
    });
    return zones;
  }

  function readStages() {
    return Array.prototype.map.call(document.querySelectorAll("#rule .stage"), function (el) {
      var r = el.getBoundingClientRect();
      return { id: el.dataset.stage, left: r.left, el: el };
    });
  }

  function pickStage(x) {
    var s = carry.stages;
    var pick = s[0];
    for (var i = 0; i < s.length; i++) if (x >= s[i].left - 7) pick = s[i];
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

  /** Returns the card under the pointer's position when the pointer is over its middle. */
  function findMergeTarget(x, y, cell) {
    var kids = cell.querySelectorAll(".card[data-id]");
    for (var i = 0; i < kids.length; i++) {
      var r = kids[i].getBoundingClientRect();
      var inX = x > r.left + r.width * 0.12 && x < r.right - r.width * 0.12;
      var inY = y > r.top + r.height * 0.2 && y < r.bottom - r.height * 0.2;
      if (inX && inY) return kids[i];
    }
    return null;
  }

  /** Puts the slot at the row the pointer is over, and glides neighbours out of the way. */
  function moveSlot(cell, y) {
    var kids = Array.prototype.filter.call(cell.children, function (c) { return !c.classList.contains("slot"); });
    var before = null;
    for (var i = 0; i < kids.length; i++) {
      var r = kids[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) {
        before = kids[i];
        break;
      }
    }
    if (carry.slot.parentElement === cell && carry.slot.nextElementSibling === before) return;
    var affected = kids.slice();
    if (carry.slot.parentElement && carry.slot.parentElement !== cell) {
      affected = affected.concat(Array.prototype.slice.call(carry.slot.parentElement.children).filter(function (c) { return !c.classList.contains("slot"); }));
    }
    var overflow = cell.querySelector(".pile");
    Motion.flip(affected, function () {
      cell.insertBefore(carry.slot, before);
    }, { spring: "glide" });
  }

  function setTargetStage(stage) {
    if (carry.stage === stage) return;
    if (carry.stage) carry.stage.el.classList.remove("is-target");
    carry.stage = stage;
    stage.el.classList.add("is-target");
    var rule = document.getElementById("rule").getBoundingClientRect();
    var mark = document.getElementById("rule-mark");
    var r = stage.el.getBoundingClientRect();
    Motion.body(mark).to({ x: r.left - rule.left + 3 }, "carry");
    var ownStage = stage.id === carry.task.stage;
    work().dataset.dragStage = stage.id;
    document.querySelectorAll(".cell.is-target").forEach(function (c) { c.classList.remove("is-target"); });
  }

  function setMerge(target) {
    if (carry.merge === target) return;
    if (carry.merge) {
      carry.merge.classList.remove("is-merge-target");
      Motion.body(carry.merge).to({ s: 1 }, "glide");
    }
    carry.merge = target;
    carry.el.classList.toggle("is-docking", !!target);
    carry.slot.classList.toggle("is-shut", !!target);
    if (target) {
      target.classList.add("is-merge-target");
      Motion.body(target).to({ s: 1.02 }, "bump");
    }
  }

  /** Follows the pointer: moves the card, then decides where it would land. */
  function track(x, y) {
    var c = carry;
    var dx = x - c.lastX;
    c.lastX = x;
    c.lastY = y;
    c.pointerSpeed = dx;
    var lean = Math.max(-2.6, Math.min(2.6, dx * 0.2));
    var goalX = x - c.grabX;
    var goalY = y - c.grabY;
    var scale = 1.035;
    if (c.merge) {
      // Drawn in: the carried card docks on the target's corner and shrinks a little.
      var m = c.merge.getBoundingClientRect();
      goalX = m.left + 10 - c.home.left;
      goalY = m.top + 8 - c.home.top;
      lean = 1.6;
      scale = 0.96;
      goalX = goalX - 0;
    }
    if (!c.merge) {
      goalX -= c.home.left;
      goalY -= c.home.top;
      goalX += 0;
    }
    Motion.body(c.el).to({ x: goalX, y: goalY, s: scale, r: lean }, "carry");

    var stage = pickStage(x);
    setTargetStage(stage);
    var zone = pickZone(y);
    var cell = cellIn(zone, stage.id);
    if (!cell) return;
    var target = findMergeTarget(x, y, cell);
    if (target !== c.hoverCard) {
      c.hoverCard = target;
      clearTimeout(c.dwell);
      if (!target) {
        setMerge(null);
      } else {
        c.dwell = setTimeout(function () {
          if (carry && carry.hoverCard === target) {
            setMerge(target);
            track(carry.lastX, carry.lastY);
          }
        }, MERGE_DWELL);
      }
    }
    if (!c.merge) {
      moveSlot(cell, y);
      c.zone = zone;
    }
  }

  function begin(e) {
    var p = press;
    press = null;
    var el = p.el;
    var t = Store.task(p.id);
    if (Fan.isOpen()) {
      var host = el.closest(".fan");
      if (host) {
        var r0 = el.getBoundingClientRect();
        Fan.hide(true);
        p.rect = r0;
      }
    }
    var home = el.getBoundingClientRect();
    var slot = document.createElement("div");
    slot.className = "slot";
    var fromCell = el.closest(".cell");
    if (fromCell) fromCell.insertBefore(slot, el);
    var lay = layer();
    lay.appendChild(el);
    el.classList.add("is-carried");
    el.style.left = home.left + "px";
    el.style.top = home.top + "px";
    el.style.width = home.width + "px";
    Motion.body(el).clear();
    carry = {
      el: el,
      id: p.id,
      task: t,
      home: home,
      from: fromCell,
      grabX: p.x - home.left,
      grabY: p.y - home.top,
      lastX: p.x,
      lastY: p.y,
      slot: slot,
      stage: null,
      merge: null,
      hoverCard: null,
      zone: null,
      zones: readDropZones(),
      stages: readStages(),
    };
    var mark = document.getElementById("rule-mark");
    var rule = document.getElementById("rule").getBoundingClientRect();
    var own = carry.stages.filter(function (s) { return s.id === t.stage; })[0];
    Motion.body(mark).set({ x: own.left - rule.left + 3 });
    work().classList.add("is-carrying");
    track(e.clientX, e.clientY);
  }

  /** Works out where the card lands from the slot, as a rank between its new neighbours. */
  function readLanding() {
    var slot = carry.slot;
    var cell = slot.parentElement;
    if (!cell) return null;
    var prev = slot.previousElementSibling;
    var next = slot.nextElementSibling;
    function rankOf(el) {
      if (!el || !el.dataset.id) return null;
      var t = Store.task(el.dataset.id);
      return t ? t.rank : null;
    }
    var a = rankOf(prev);
    var b = rankOf(next);
    var rank;
    if (a !== null && b !== null) rank = (a + b) / 2;
    else if (a !== null) rank = a + 0.5;
    else if (b !== null) rank = b - 0.5;
    else rank = carry.task.rank;
    var owner = cell.dataset.owner;
    var project = owner.indexOf("lane-") === 0 ? owner.slice(5) : carry.task.project;
    return { stage: cell.dataset.stage, project: project, before: rank };
  }

  function finish() {
    var c = carry;
    carry = null;
    clearTimeout(c.dwell);
    if (c.stage) c.stage.el.classList.remove("is-target");
    work().classList.remove("is-carrying");
    delete work().dataset.dragStage;
    c.slot.remove();
    c.el.classList.remove("is-carried", "is-docking");
    c.el.style.left = "";
    c.el.style.top = "";
    c.el.style.width = "";
    return c;
  }

  /** Puts a card back into the page from wherever it was carried, settling on the named spring. */
  function settle(c, spring, mutate) {
    var el = c.el;
    var r0 = el.getBoundingClientRect();
    var s0 = Motion.body(el).value.s;
    var r = Motion.body(el).value.r;
    var v = Object.assign({}, Motion.body(el).speed);
    Motion.body(el).clear();
    el.remove();
    Board.change(mutate, { spring: "glide" });
    if (!el.isConnected) return;
    var r1 = el.getBoundingClientRect();
    var b = Motion.body(el);
    b.set({ x: r0.left + r0.width / 2 - (r1.left + r1.width / 2), y: r0.top + r0.height / 2 - (r1.top + r1.height / 2), s: s0, r: r });
    b.speed.x = v.x;
    b.speed.y = v.y;
    el.classList.add("is-landing");
    b.to({ x: 0, y: 0, s: 1, r: 0 }, spring, {
      done: function () { el.classList.remove("is-landing"); },
    });
  }

  function drop() {
    var c = carry;
    if (c.merge) return mergeNow();
    var landing = readLanding();
    var done = finish();
    if (!landing) return settle(done, "back");
    var moved = landing.stage !== done.task.stage || landing.project !== done.task.project;
    settle(done, "drop", function () { Store.moveTask(done.id, landing); });
    if (moved) Toast.show(describeMove(done.task, landing), true);
  }

  function describeMove(t, to) {
    var name = NW.STAGES.filter(function (s) { return s.id === to.stage; })[0].name;
    return "Moved to " + name + ".";
  }

  function mergeNow() {
    var target = carry.merge;
    var id = target.dataset.id;
    target.classList.remove("is-merge-target");
    var c = finish();
    var el = c.el;
    // The carried card slides under its new home, then the home takes a small bump.
    var r0 = el.getBoundingClientRect();
    var layerEl = document.getElementById("carry");
    var ghost = Motion.ghost(el, layerEl);
    ghost.style.position = "fixed";
    var hostRect = layerEl.getBoundingClientRect();
    ghost.style.left = r0.left + "px";
    ghost.style.top = r0.top + "px";
    el.remove();
    var into;
    Board.change(function () { into = Store.mergeTasks(c.id, id); }, { spring: "glide" });
    var r1 = target.getBoundingClientRect();
    Motion.body(ghost).to({ x: r1.left - r0.left, y: r1.top - r0.top, s: 0.9, r: 0, o: 0 }, "drop", {
      done: function () { ghost.remove(); },
    });
    target.classList.add("has-merged");
    setTimeout(function () { target.classList.remove("has-merged"); }, 520);
    var b = Motion.body(target);
    b.set({ s: 1.035 }).to({ s: 1 }, "bump");
    Toast.show("Merged into " + into.name + ".", true);
  }

  function cancel() {
    if (!carry) return;
    var home = carry.home;
    var from = carry.from;
    var slot = carry.slot;
    if (carry.merge) setMerge(null);
    var c = finish();
    settle(c, "back");
  }

  function onDown(e) {
    if (e.button !== 0) return;
    var el = e.target.closest(".card[data-id]");
    if (!el || el.classList.contains("is-ghost")) return;
    press = { el: el, id: el.dataset.id, x: e.clientX, y: e.clientY };
  }

  function onMove(e) {
    if (press) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < START_DISTANCE) return;
      begin(e);
      e.preventDefault();
      return;
    }
    if (carry) {
      e.preventDefault();
      track(e.clientX, e.clientY);
      autoScroll(e.clientY);
    }
  }

  var scrollFrame = 0;
  /** Scrolls the board while the card is held near its top or bottom edge. */
  function autoScroll(y) {
    var s = scroller();
    var r = s.getBoundingClientRect();
    var band = 70;
    var speed = 0;
    if (y < r.top + band + 60) speed = -(r.top + band + 60 - y) / 6;
    if (y > r.bottom - band) speed = (y - (r.bottom - band)) / 6;
    if (!speed) return;
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(function () {
      scrollFrame = 0;
      if (!carry) return;
      s.scrollTop += speed;
      carry.zones = readDropZones();
      track(carry.lastX, carry.lastY);
    });
  }

  function onUp(e) {
    if (press) {
      var p = press;
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
    var w = work();
    w.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", cancel);
  }

  return { mount: mount, isActive: isActive, cancel: cancel };
})();
