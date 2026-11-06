// PROTOTYPE - the board without a pointer. Arrows walk the desk by position, Return opens, every
// verb has a key. Focus moves between cards; nothing else takes it.
window.Keys = (function () {
  "use strict";

  var focused = null;

  function walkable() {
    var host = Fan.isOpen() ? document.querySelector(".fan-cards") : document.getElementById("lanes");
    return Array.prototype.filter.call(host.querySelectorAll(".card, .plan-head, .lane-head"), function (el) {
      return el.offsetParent !== null && !el.classList.contains("is-ghost");
    });
  }

  function clearFocus() {
    if (focused) {
      focused.classList.remove("is-focus");
      if (focused.classList.contains("card")) focused.tabIndex = -1;
    }
    focused = null;
  }

  /** Moves the keyboard's focus to a card, and scrolls it into view. */
  function focusCard(el) {
    clearFocus();
    focused = el;
    el.classList.add("is-focus");
    el.tabIndex = 0;
    el.focus({ preventScroll: true });
    var s = document.getElementById("scroll");
    var r = el.getBoundingClientRect();
    var view = s.getBoundingClientRect();
    if (r.top < view.top + 96) s.scrollTop -= view.top + 96 - r.top;
    if (r.bottom > view.bottom - 24) s.scrollTop += r.bottom - view.bottom + 24;
    if (Pane.currentId() && el.dataset.id) Pane.show(el.dataset.id);
  }

  /** Finds the nearest item in a direction, by distance along that direction first. */
  function findNext(dir) {
    var items = walkable();
    if (!items.length) return null;
    if (!focused || !focused.isConnected) return items[0];
    var a = focused.getBoundingClientRect();
    var ax = a.left + a.width / 2;
    var ay = a.top + a.height / 2;
    var best = null;
    var bestScore = Infinity;
    items.forEach(function (el) {
      if (el === focused) return;
      var r = el.getBoundingClientRect();
      var x = r.left + r.width / 2;
      var y = r.top + r.height / 2;
      var dx = x - ax;
      var dy = y - ay;
      var along = dir === "left" ? -dx : dir === "right" ? dx : dir === "up" ? -dy : dy;
      var across = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
      if (along < 8) return;
      var score = along + across * 2.4;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    });
    return best;
  }

  function currentCardId() {
    return focused && focused.dataset.id ? focused.dataset.id : Pane.currentId();
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
    if (e.target.matches("input, textarea")) return;
    var cmd = e.metaKey || e.ctrlKey;
    var key = e.key;
    if (cmd && key.toLowerCase() === "z") {
      e.preventDefault();
      Toast.undo();
      return;
    }
    if (key === "Escape") {
      if (Drag.isActive()) return Drag.cancel();
      if (MergePick.isActive()) return MergePick.cancel();
      if (Pane.currentId()) {
        var id = Pane.currentId();
        return Pane.hide(function () {
          var el = document.querySelector('.card[data-id="' + id + '"]');
          if (el) focusCard(el);
        });
      }
      if (Fan.isOpen()) return Fan.hide();
      if (Store.isFiltering()) {
        Lens.clear();
        return;
      }
      return clearFocus();
    }
    var dirs = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", h: "left", l: "right", k: "up", j: "down" };
    if (dirs[key] && !cmd) {
      var id2 = currentCardId();
      if (e.shiftKey && id2) {
        e.preventDefault();
        if (key === "ArrowLeft") return shiftStage(id2, -1);
        if (key === "ArrowRight") return shiftStage(id2, 1);
        return;
      }
      e.preventDefault();
      var next = findNext(dirs[key]);
      if (next) focusCard(next);
      return;
    }
    if (key === "Enter" || key === " ") {
      if (!focused) return;
      e.preventDefault();
      if (MergePick.isActive()) return MergePick.finish(focused.dataset.id);
      if (focused.dataset.id) return Pane.show(focused.dataset.id);
      focused.click();
      return;
    }
    var id3 = currentCardId();
    if (key === "f" && focused) {
      var lane = focused.closest(".lane");
      var plan = focused.closest(".plan");
      if (plan) Fold.togglePlan(plan.dataset.plan);
      else if (lane) Fold.toggleLane(lane.dataset.lane);
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
    if (!id3) return;
    if (key === "d") return Actions.run("done", id3);
    if (key === "Backspace") return Actions.run("drop", id3);
    if (key === "m") return Actions.run("merge", id3);
    if (key === "t") return Actions.run("thread", id3);
    if (key >= "1" && key <= "5") Actions.moveToStage(id3, STAGE_IDS[Number(key) - 1]);
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
    preview: function (key) { set(key || pinned); },
  };
})();

// PROTOTYPE - find: type, and everything else steps back. Lanes keep their places.
window.Find = (function () {
  "use strict";
  var box;
  function open() {
    box = box || document.getElementById("find");
    box.classList.add("is-on");
    var input = box.querySelector("input");
    input.focus();
    input.select();
  }
  function close() {
    box = box || document.getElementById("find");
    box.classList.remove("is-on");
    var input = box.querySelector("input");
    input.value = "";
    input.blur();
  }
  function mount() {
    box = document.getElementById("find");
    var input = box.querySelector("input");
    box.addEventListener("click", function () { open(); });
    input.addEventListener("input", function () {
      Store.state.query = input.value.trim();
      Board.draw();
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        e.stopPropagation();
        Lens.clear();
      }
    });
  }
  return { open: open, close: close, mount: mount };
})();

// PROTOTYPE - the keys, shown on request.
window.Help = (function () {
  "use strict";
  var ROWS = [["↑ ↓ ← →", "Walk the desk"], ["Return", "Open a card"], ["⇧← ⇧→", "Move a card a stage"], ["1 to 5", "Move a card to a stage"], ["D", "Done"], ["⌫", "Drop"], ["M", "Merge into another card"], ["T", "Start a thread"], ["F", "Fold this lane or plan"], ["⇧F", "Fold everything"], ["Q R S A", "Lens: quick, real thinking, stalled, agents"], ["/", "Find"], ["⌘Z", "Undo"]];
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
