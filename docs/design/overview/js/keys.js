// PROTOTYPE - the board without a pointer. Arrows walk the desk by position, Return opens, every
// verb has a key. Focus moves between cards; nothing else takes it.
window.Keys = (function () {
  "use strict";

  var focused = null;

  function walkable() {
    var host = Fan.isOpen() ? document.querySelector(".fan-cards") : document.getElementById("lanes");
    return Array.prototype.filter.call(host.querySelectorAll(".card"), function (el) {
      return el.offsetParent !== null && !el.classList.contains("is-ghost") && !el.classList.contains("is-off");
    });
  }

  function clearFocus() {
    if (focused) {
      focused.classList.remove("is-focus");
      if (focused.classList.contains("card")) focused.tabIndex = -1;
    }
    focused = null;
  }

  /** Moves focus to a card and scrolls it into view. Only the keyboard shows the ring. */
  function focusCard(el, byPointer) {
    clearFocus();
    focused = el;
    if (!byPointer) el.classList.add("is-focus");
    document.querySelectorAll('#lanes .card[tabindex="0"]').forEach(function (c) { if (c !== el) c.tabIndex = -1; });
    el.tabIndex = 0;
    el.focus({ preventScroll: true });
    var s = document.getElementById("scroll");
    var r = el.getBoundingClientRect();
    var view = s.getBoundingClientRect();
    if (r.top < view.top + 96) s.scrollTop -= view.top + 96 - r.top;
    if (r.bottom > view.bottom - 24) s.scrollTop += r.bottom - view.bottom + 24;
    if (Pane.currentId() && el.dataset.id) Pane.show(el.dataset.id);
  }

  /**
   * Finds the next card in a direction. Up and down stay in the column. Left and right go to the
   * nearest column, at the nearest height, so the walk can be retraced.
   */
  function findNext(dir) {
    var items = walkable();
    if (!items.length) return null;
    if (!focused || !focused.isConnected) return items[0];
    var a = focused.getBoundingClientRect();
    var ax = a.left + a.width / 2;
    var ay = a.top + a.height / 2;
    var vertical = dir === "up" || dir === "down";
    var best = null;
    var bestScore = Infinity;
    items.forEach(function (el) {
      if (el === focused) return;
      var r = el.getBoundingClientRect();
      var dx = r.left + r.width / 2 - ax;
      var dy = r.top + r.height / 2 - ay;
      var along = dir === "left" ? -dx : dir === "right" ? dx : dir === "up" ? -dy : dy;
      if (along < 8) return;
      if (vertical && Math.abs(dx) > a.width / 2) return;
      var score = vertical ? along : along * 3 + Math.abs(dy);
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    });
    return best;
  }

  /** Jumps to the first card of the next or previous lane. */
  function jumpLane(by) {
    var lanes = Array.prototype.slice.call(document.querySelectorAll("#lanes .lane"));
    var here = focused ? lanes.indexOf(focused.closest(".lane")) : -1;
    var i = Math.max(0, Math.min(lanes.length - 1, here + by));
    var card = lanes[i].querySelector(".card");
    var head = lanes[i].querySelector(".lane-head");
    focusCard(card || head);
  }

  function currentCardId() {
    return focused && focused.isConnected && focused.dataset.id ? focused.dataset.id : null;
  }

  var STAGE_IDS = NW.STAGES.map(function (s) { return s.id; });

  function shiftStage(id, by) {
    var t = Store.task(id);
    if (!t) return;
    var i = STAGE_IDS.indexOf(t.stage) + by;
    if (i < 0 || i >= STAGE_IDS.length) return;
    Actions.moveToStage(id, STAGE_IDS[i]);
    var el = document.querySelector('.card[data-id="' + id + '"]');
    if (el) focusCard(el);
  }

  function onKey(e) {
    if (e.target.matches("input, textarea")) {
      if (e.key === "Escape") {
        e.target.blur();
        if (e.target.closest(".pn-thread")) Pane.refresh();
      }
      return;
    }
    var key = e.key;
    if ((e.metaKey || e.ctrlKey) && key.toLowerCase() === "z") {
      e.preventDefault();
      Toast.undo();
      return;
    }
    // Single keys mean nothing with a modifier: those belong to the app and the system.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (Overview.current() !== "work") return;
    // Single keys are live only on the board, so they never fire while focus is elsewhere.
    var place = document.activeElement;
    if (place && place !== document.body && !place.closest("#work")) {
      if (key !== "Escape") return;
    }

    if (key === "Escape") return stepBack();
    if (e.target.closest && e.target.closest(".pn-sheet button, .pn-sheet a, .menu, .tray")) {
      if (key === "Enter" || key === " ") return;
    }

    // While picking a card to merge into, only walking, Return and Esc mean anything.
    if (MergePick.isActive()) {
      var pickDir = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" }[key];
      if (pickDir) {
        e.preventDefault();
        var hop = findNext(pickDir);
        if (hop) focusCard(hop);
      }
      if ((key === "Enter" || key === " ") && focused) {
        e.preventDefault();
        MergePick.finish(focused.dataset.id);
      }
      return;
    }

    var dirs = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", h: "left", l: "right", k: "up", j: "down" };
    if (dirs[key]) {
      var id2 = currentCardId();
      e.preventDefault();
      if (e.shiftKey) {
        if (id2 && key === "ArrowLeft") shiftStage(id2, -1);
        if (id2 && key === "ArrowRight") shiftStage(id2, 1);
        return;
      }
      var next = findNext(dirs[key]);
      if (next) focusCard(next);
      return;
    }
    if (key === "Enter" || key === " ") {
      if (Pane.currentId()) {
        e.preventDefault();
        return Pane.acceptSuggested();
      }
      if (!focused) return;
      e.preventDefault();
      if (focused.dataset.id) return Pane.show(focused.dataset.id);
      focused.click();
      return;
    }
    if (key === "n") return Walk.step(1);
    if (key === "N") return Walk.step(-1);
    if (key === "[") return jumpLane(-1);
    if (key === "]") return jumpLane(1);
    if (key === "f" && focused) {
      var lane = focused.closest(".lane");
      var plan = focused.closest(".plan");
      if (plan) Fold.togglePlan(plan.dataset.plan);
      else if (lane) Fold.toggleLane(lane.dataset.lane);
      // The card may have folded away. Focus stays on the lane, so a second F opens it again.
      if (lane && !focused.isConnected) focusCard(lane.querySelector(".lane-btn"));
      return;
    }
    if (key === "F") return Fold.toggleAll();
    if (key === "/") {
      e.preventDefault();
      return Find.open();
    }
    if (key === "?") return Help.toggle();
    if (key === "q") return Lens.toggle("quick");
    if (key === "r") return Lens.toggle("think");
    if (key === "s") return Lens.toggle("stalled");
    if (key === "a") return Lens.toggle("agents");
    if (key === "w") return Display.toggleWear();
    if (key === "o") return Overview.show("office");
    var id3 = Pane.currentId() || currentCardId();
    if (!id3) return;
    if (key === "x") return Select.toggle(id3);
    if (key === "d") return Actions.run("done", id3);
    if (key === "Backspace") return Actions.run("drop", id3);
    if (key === "m") return Actions.run("merge", id3);
    if (key === "t") {
      e.preventDefault();
      return Actions.run("thread", id3);
    }
    if (key >= "1" && key <= "5") Actions.moveToStage(id3, STAGE_IDS[Number(key) - 1]);
  }

  /** Esc steps back one thing at a time, from whatever is on top. */
  function stepBack() {
    if (Drag.isActive()) return Drag.cancel();
    var help = document.getElementById("help");
    if (help.classList.contains("is-on")) return help.classList.remove("is-on");
    var menu = document.getElementById("display");
    if (menu.classList.contains("is-on")) return menu.classList.remove("is-on");
    if (MergePick.isActive()) return MergePick.cancel();
    if (Pane.currentId()) {
      var id = Pane.currentId();
      return Pane.back(function () {
        var el = document.querySelector('.card[data-id="' + id + '"]');
        if (el) focusCard(el);
      });
    }
    if (Fan.isOpen()) {
      var pile = Fan.pileEl();
      Fan.hide();
      if (pile) focusCard(pile);
      return;
    }
    if (Store.isFiltering()) return Lens.clear();
    if (Object.keys(Store.state.selected).length) return Select.clear();
    clearFocus();
  }

  function mount() {
    window.addEventListener("keydown", onKey);
  }

  return { mount: mount, focusCard: focusCard, clearFocus: clearFocus };
})();

// PROTOTYPE - the sentence is the filter. Hovering a phrase lights what it counts; pressing keeps it.
window.Lens = (function () {
  "use strict";
  var pinned = null;
  var previewTimer = 0;

  function set(key) {
    if (Store.state.lens === key) return;
    Store.state.lens = key;
    Board.draw();
  }

  return {
    toggle: function (key) {
      pinned = pinned === key ? null : key;
      set(pinned);
    },
    clear: function () {
      pinned = null;
      Store.state.query = "";
      Find.close();
      set(null);
      Board.draw();
    },
    // Passing over the sentence must not flash the board, so a hover takes a moment to count.
    preview: function (key) {
      clearTimeout(previewTimer);
      if (key) previewTimer = setTimeout(function () { set(key); }, 140);
      else set(pinned);
    },
  };
})();

// PROTOTYPE - find. Type, and everything else steps back in place; a short list offers the top
// matches, wherever they are: in a pile, in a folded lane, or on a card. Return opens one.
window.Find = (function () {
  "use strict";
  var box;
  var at = 0;
  var hits = [];

  function close() {
    box = box || document.getElementById("find");
    box.classList.remove("is-on");
    var input = box.querySelector("input");
    input.value = "";
    input.blur();
    document.getElementById("find-list").classList.remove("is-on");
  }

  function open() {
    box = box || document.getElementById("find");
    box.classList.add("is-on");
    var input = box.querySelector("input");
    input.focus();
    input.select();
  }

  function drawList() {
    var list = document.getElementById("find-list");
    var q = Store.state.query;
    if (!q) return list.classList.remove("is-on");
    list.classList.add("is-on");
    var all = Store.state.tasks.filter(Store.matches);
    hits = all.slice(0, 8);
    at = Math.min(at, Math.max(0, hits.length - 1));
    if (!hits.length) {
      list.innerHTML = '<p class="find-none">Nothing here matches "' + Board.esc(q) + '".</p>';
      return;
    }
    list.innerHTML = hits.map(function (t, i) {
      var stage = NW.STAGES.filter(function (s) { return s.id === t.stage; })[0].name;
      var project = Store.state.projects.filter(function (p) { return p.id === t.project; })[0];
      return '<button class="find-row' + (i === at ? " is-on" : "") + '" data-open-task="' + t.id + '"><b>' + Board.esc(t.name) + "</b><small>" + Board.esc((project ? project.name : "") + ", " + stage) + "</small></button>";
    }).join("") + (all.length > hits.length ? '<p class="find-more">' + all.length + " in all</p>" : "");
  }

  /** Ends a search. A lens that was pinned stays pinned. */
  function clearQuery() {
    close();
    Store.state.query = "";
    Board.draw();
  }

  function openHit(id) {
    clearQuery();
    Pane.show(id);
  }

  function mount() {
    box = document.getElementById("find");
    var input = box.querySelector("input");
    box.addEventListener("click", function (e) {
      e.stopPropagation();
      open();
    });
    input.addEventListener("input", function () {
      Store.state.query = input.value.trim();
      at = 0;
      Board.draw();
      drawList();
    });
    input.addEventListener("keydown", function (e) {
 if (e.key === "Escape") {
        e.stopPropagation();
        clearQuery();
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        at = Math.max(0, Math.min(hits.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)));
        drawList();
      }
      if (e.key === "Enter" && hits[at]) {
        e.preventDefault();
        openHit(hits[at].id);
      }
    });
    document.getElementById("find-list").addEventListener("click", function (e) {
      e.stopPropagation();
      var row = e.target.closest("[data-open-task]");
      if (row) openHit(row.dataset.openTask);
    });
  }
  return { open: open, close: close, clearQuery: clearQuery, mount: mount };
})();

// PROTOTYPE - selecting several cards: X or ⌘-click marks a card, and a quiet line says what you can
// do with them. Dragging any one of them carries them all.
window.Select = (function () {
  "use strict";

  function count() { return Object.keys(Store.state.selected).length; }

  function drawBar() {
    var bar = document.getElementById("select-bar");
    var n = count();
    bar.classList.toggle("is-on", n > 0);
    if (n) {
      bar.innerHTML = "<b>" + n + "</b> selected<span>Drag any of them to move them all</span><button data-sel=\"done\">Done</button><button data-sel=\"drop\">Drop</button><button data-sel=\"clear\">Clear<kbd>Esc</kbd></button>";
    }
  }

  function toggle(id) {
    var s = Store.state.selected;
    if (s[id]) delete s[id];
    else s[id] = true;
    Board.draw();
    drawBar();
  }

  function clear() {
    Store.state.selected = {};
    Board.draw();
    drawBar();
  }

  function mount() {
    document.getElementById("select-bar").addEventListener("click", function (e) {
      var b = e.target.closest("[data-sel]");
      if (!b) return;
      var ids = Object.keys(Store.state.selected);
      Store.state.selected = {};
      if (b.dataset.sel !== "clear") Actions.endMany(ids, b.dataset.sel === "done" ? "Done" : "Dropped");
      Board.draw();
      drawBar();
    });
  }

  return { toggle: toggle, clear: clear, mount: mount, drawBar: drawBar };
})();

// PROTOTYPE - the keys, shown on request.
window.Help = (function () {
  "use strict";
  var ROWS = [["N", "Next thing that wants you"], ["↑ ↓ ← →", "Walk the desk"], ["[ ]", "Previous and next lane"], ["Return", "Open a card"], ["⇧← ⇧→", "Move a card a stage"], ["1 to 5", "Move a card to a stage"], ["X", "Select a card"], ["D", "Done"], ["⌫", "Drop"], ["M", "Merge into another card"], ["T", "Start a thread"], ["F", "Fold this lane or plan"], ["⇧F", "Fold everything"], ["Q R S A", "Lens: quick, real thinking, stalled, agents"], ["/", "Find"], ["⌘Z", "Undo"]];
  function toggle() {
    var el = document.getElementById("help");
    if (!el.firstChild) el.innerHTML = "<h3>Keys</h3>" + ROWS.map(function (r) { return "<div><kbd>" + r[0] + "</kbd><span>" + r[1] + "</span></div>"; }).join("");
    el.classList.toggle("is-on");
  }
  return { toggle: toggle };
})();

// PROTOTYPE - the Display menu: Wear, and folding everything.
window.Display = (function () {
  "use strict";
  function toggleWear() {
    Store.state.wear = !Store.state.wear;
    Board.draw();
    var input = document.getElementById("wear-switch");
    if (input) input.checked = Store.state.wear;
    Toast.show(Store.state.wear ? "Wear is on. Neglected work ages." : "Wear is off.", false);
  }
  return { toggleWear: toggleWear };
})();
