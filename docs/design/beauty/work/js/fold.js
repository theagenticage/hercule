// PROTOTYPE - folding and opening in place. A folded lane is one line with a count under each stage.
// A closed initiative is its coloured line, with one bead per Task. A card shrinks into its count or
// its bead, and grows out of it again, so nothing ever just vanishes. Reversing halfway picks up from
// what is on screen.
window.Fold = (function () {
  "use strict";

  // Copies fly in the fixed layer, so a scroll caused by the fold itself cannot carry them off.
  function flight() { return document.getElementById("carry"); }

  /** Returns the cards under an element, each with the Task it stands for. */
  function collectItems(root) {
    return Array.prototype.map.call(root.querySelectorAll(".cell .card[data-id]"), function (el) {
      return { el: el, ids: [el.dataset.id] };
    });
  }

  /** Finds what a Task folds into: its bead on an initiative's line, or its stage's count on a lane's line. */
  function findTarget(root, id) {
    var bead = root.querySelector('.bead[data-id="' + id + '"]');
    if (bead) return bead;
    var t = Store.task(id);
    return t ? root.querySelector('.fold-cell[data-stage="' + t.stage + '"]') : null;
  }

  /** Makes a flying copy of everything under each root. Stored on the root, for a reversal. */
  function launch(roots) {
    var all = [];
    roots.forEach(function (root) {
      root._flights = collectItems(root).map(function (it) {
        var layout = Motion.layoutRect(it.el);
        return { ids: it.ids, rect: layout, ghost: Motion.ghost(it.el, flight()) };
      });
      all.push({ root: root, flights: root._flights });
    });
    return all;
  }

  /** Sends each copy to its bead. Each bead appears as its copy arrives, never before. */
  function flyHome(group) {
    var seen = 0;
    group.flights.forEach(function (f, i) {
      var bead = findTarget(group.root, f.ids[0]);
      if (!bead) {
        f.ghost.remove();
        return;
      }
      var r = bead.getBoundingClientRect();
      var dx = r.left + r.width / 2 - (f.rect.left + f.rect.width / 2);
      var dy = r.top + r.height / 2 - (f.rect.top + f.rect.height / 2);
      var delay = Math.min(i * 12, 100);
      if (Motion.isReduced()) {
        f.ghost.remove();
        return;
      }
      Motion.body(f.ghost).to({ x: dx, y: dy, s: 0.1 }, "travel", {
        delay: delay,
        done: function () { f.ghost.remove(); },
      });
      f.ghost.animate([{ opacity: 1 }, { opacity: 0 }], { delay: delay + 210, duration: 90, fill: "forwards" });
      if (bead.classList.contains("bead")) Motion.body(bead).set({ s: 0.2, o: 0 }).to({ s: 1, o: 1 }, "hand", { delay: delay + 230 });
    });
    group.root._flights = group.flights;
  }

  /** Grows each card out of where it was: its bead, or a copy still flying from a moment ago. */
  function growFrom(root, from) {
    collectItems(root).forEach(function (it, i) {
      var t = Store.task(it.ids[0]);
      var start = from[it.ids[0]] || (t && from["stage:" + t.stage]);
      if (!start) return;
      var r = Motion.layoutRect(it.el);
      var b = Motion.body(it.el);
      if (Motion.isReduced()) {
        b.set({ x: 0, y: 0, s: 1, o: 0 }).to({ o: 1 }, "travel");
        return;
      }
      b.set({ x: start.left + start.width / 2 - (r.left + r.width / 2), y: start.top + start.height / 2 - (r.top + r.height / 2), s: start.s, o: start.o });
      b.to({ x: 0, y: 0, s: 1, o: 1 }, "travel", { delay: start.live ? 0 : Math.min(i * 16, 130) });
    });
  }

  /** Records where each Task shows now. A copy in flight wins over the bead it was heading for. */
  function recordOrigins(root) {
    var from = {};
    root.querySelectorAll(".bead").forEach(function (b) {
      var r = b.getBoundingClientRect();
      from[b.dataset.id] = { left: r.left, top: r.top, width: r.width, height: r.height, s: 0.1, o: 0 };
    });
    root.querySelectorAll(".fold-cell").forEach(function (c) {
      var r = c.getBoundingClientRect();
      from["stage:" + c.dataset.stage] = { left: r.left, top: r.top, width: r.width, height: r.height, s: 0.1, o: 0 };
    });
    (root._flights || []).forEach(function (f) {
      if (!f.ghost.isConnected) return;
      var r = f.ghost.getBoundingClientRect();
      var body = Motion.body(f.ghost);
      f.ids.forEach(function (id) {
        from[id] = { left: r.left, top: r.top, width: r.width, height: r.height, s: body.value.s, o: 1, live: true };
      });
      f.ghost.getAnimations().forEach(function (a) { a.cancel(); });
      body.clear();
      f.ghost.remove();
    });
    root._flights = [];
    return from;
  }

  /** Folds these roots with one change of the board. What you clicked stays where it is. */
  function fold(roots, mutate, anchor) {
    var groups = launch(roots);
    Board.change(mutate, { spring: "travel", quietExits: true, anchor: anchor, stagger: function () { return 70; } });
    groups.forEach(flyHome);
  }

  /** Opens these roots with one change of the board. */
  function open(roots, mutate, after, anchor) {
    var origins = roots.map(recordOrigins);
    Board.change(mutate, { spring: "travel", quietExits: true, anchor: anchor });
    roots.forEach(function (root, i) { growFrom(root, origins[i]); });
    if (after) after();
  }

  /** Opens the rest of a cell in place, or closes it again. The lanes below make room. */
  function toggleCell(key) {
    var st = Store.state;
    var owner = key.split("/")[0];
    var cell = document.querySelector('.cell[data-owner="' + owner + '"][data-stage="' + key.split("/").pop() + '"]');
    Board.change(function () { st.openCells[key] = !st.openCells[key]; }, { spring: "travel", anchor: cell && cell.closest(".lane, .plan") });
  }

  /** Opens a stack in place, or closes it again. */
  function toggleStack(id, open) {
    Board.change(function () { Store.state.openStacks[id] = open; }, { spring: "travel" });
  }

  /** Folds or opens something while a filter is on. That choice lasts as long as the filter does. */
  function toggleUnderFilter(key, anchor) {
    var folds = Store.state.filterFolds;
    Board.change(function () { folds[key] = !folds[key]; }, { spring: "travel", quietExits: true, anchor: anchor });
  }

  /** Folds or opens a lane. */
  function toggleLane(id) {
    var st = Store.state;
    var lane = Board.node("lane:" + id);
    if (Store.isFiltering()) return toggleUnderFilter("lane:" + id, lane);
    if (!st.folded[id]) fold([lane], function () { st.folded[id] = true; }, lane);
    else open([lane], function () { st.folded[id] = false; }, null, lane);
  }

  /** Folds or opens a plan: the wire opens into a band of cards, or closes back into a wire. */
  function togglePlan(id) {
    var st = Store.state;
    var plan = Board.node("plan:" + id);
    if (Store.isFiltering()) return toggleUnderFilter("plan:" + id, plan);
    if (st.openPlans[id]) {
      fold([plan], function () { delete st.openPlans[id]; }, plan);
    } else {
      open([plan], function () { st.openPlans[id] = true; }, function () {
        var band = plan.querySelector(".plan-band");
        if (band) Motion.body(band).set({ o: 0 }).to({ o: 1 }, "travel");
      }, plan);
    }
  }

  /** Hides or shows the whole block of initiatives on top. */
  function togglePlans() {
    Board.change(function () { Store.state.plansHidden = !Store.state.plansHidden; }, { spring: "travel", quietExits: true, noAnchor: true });
  }

  /** Folds every lane, or opens them all when all are folded. One change, however many lanes. */
  function toggleAll() {
    var st = Store.state;
    var lanes = Store.readLanes();
    var all = lanes.every(function (l) { return st.folded[l.id]; });
    var list = lanes.filter(function (l) { return !!st.folded[l.id] === all; });
    var roots = list.map(function (l) { return Board.node("lane:" + l.id); });
    if (all) return open(roots, function () { list.forEach(function (l) { st.folded[l.id] = false; }); });
    // Folding everything means everything: what was open among the initiatives closes too.
    var plans = Object.keys(st.openPlans).map(function (id) { return Board.node("plan:" + id); });
    fold(roots.concat(plans), function () {
      list.forEach(function (l) { st.folded[l.id] = true; });
      st.openPlans = {};
    });
  }

  return { toggleLane: toggleLane, toggleCell: toggleCell, toggleStack: toggleStack, togglePlan: togglePlan, togglePlans: togglePlans, toggleAll: toggleAll };
})();
