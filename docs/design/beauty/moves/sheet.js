// PROTOTYPE - A sheet that opens beautifully. Nothing here opens anything: each sheet still opens as
// it does in the clean build. This file watches for the moment one opens or closes, and adds two
// things around that moment. The focus pull needs no script: it is in moves/sheet.css.
(function () {
  "use strict";

  // Blocks start this far apart, up to a limit, so a long sheet opens as fast as a short one.
  var STEP = 24;
  var LAST_START = 120;
  // A sheet's words begin to show about this long after it starts to open.
  var WORDS_SHOW = 50;

  var watchers = [];
  var springs = [];
  var running = [];
  // Which time this move was switched on. A spring still settling from an earlier time writes nothing.
  var session = 0;

  /** Sends each block in, in reading order. Every block is on time for the sheet coming to rest. */
  function bringInBlocks(blocks) {
    running = blocks.map(function (el, i) {
      return el.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], {
        delay: WORDS_SHOW + Math.min(i * STEP, LAST_START),
        duration: 260,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
        fill: "backwards",
      });
    });
  }

  /** Stops the blocks where they are: the sheet is closing, and closing has its own fade. */
  function stopBlocks() {
    running.forEach(function (a) { a.cancel(); });
    running = [];
  }

  /**
   * Watches one sheet. isOpen says whether it stands open, readBlocks lists its blocks in reading
   * order, and readProgress says how far open it was at the moment it was asked to open, because a
   * sheet that was caught closing turns round and must not start its words from nothing.
   */
  function watchSheet(sheet, trigger, attribute, isOpen, readBlocks, readProgress, fadesItself) {
    var wasOpen = isOpen();
    var mine = session;
    var writeBloom = function (v) { if (mine === session) sheet.style.setProperty("--b-bloom", v.toFixed(3)); };
    var bloom = Motion.value(wasOpen ? 1 : 0, writeBloom);
    writeBloom(wasOpen ? 1 : 0);
    springs.push(sheet);
    var watcher = new MutationObserver(function () {
      var open = isOpen();
      if (open === wasOpen) return;
      wasOpen = open;
      if (!open) {
        stopBlocks();
        bloom.to(0, "hand");
        return;
      }
      if (Beauty.isCalm()) {
        if (!fadesItself) sheet.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "ease-out" });
        bloom.set(1);
        return;
      }
      if (readProgress() < 0.15) bringInBlocks(readBlocks());
      // The slowest of the three springs, so the shadow is still opening after the sheet has stopped.
      bloom.to(1, "self");
    });
    watcher.observe(trigger, { attributes: true, attributeFilter: [attribute] });
    watchers.push(watcher);
  }

  function toList(nodes) { return Array.prototype.slice.call(nodes); }

  /** Returns a card on screen that is worth opening: one with a colleague on it, if there is one. */
  function pickCard(selector) {
    var onScreen = toList(document.querySelectorAll(selector)).filter(function (el) {
      var r = el.getBoundingClientRect();
      return r.top > 90 && r.bottom < innerHeight - 20 && r.width > 0 && el.dataset.state !== "blocked";
    });
    return onScreen.filter(function (el) { return el.querySelector(".card-head"); })[0] || onScreen[0];
  }

  /** Opens a card and leaves it open. A second press closes it. */
  function toggleSheet() {
    if (window.Pane) {
      if (Pane.currentId()) return Pane.hide();
      var card = pickCard("#lanes .card[data-id]");
      if (card) Pane.show(card.dataset.id, { el: card });
      return;
    }
    if (Open.isOpen()) return Open.hide();
    var row = pickCard("#page .card--rich[data-id]") || pickCard("#page .card[data-id]");
    if (!row) return;
    Open.show(row.dataset.id, row);
    // Nobody pressed a key here, so the sheet must not wear the ring a keyboard user would see.
    document.activeElement.blur();
  }

  Beauty.move("sheet", {
    on: function () {
      session++;
      // The Inbox has a #work of its own, for its stand-in of Work, so the check is for the pane.
      if (window.Pane) {
        var work = document.getElementById("work");
        var pane = document.getElementById("pane");
        watchSheet(pane.querySelector(".pn-sheet"), work, "class",
          // Add to Work sets has-pane too, so the class alone does not mean the details are open.
          function () { return work.classList.contains("has-pane") && !!Pane.currentId(); },
          function () { return toList(pane.querySelectorAll(".pn-head > *, .pn-scroll > :not(.pn-head), .pn-foot")); },
          function () { return parseFloat(pane.style.getPropertyValue("--pn-dim")) || 0; });
        var adder = document.getElementById("adder");
        watchSheet(adder, adder, "class",
          function () { return adder.classList.contains("is-on"); },
          function () { return toList(adder.children); },
          function () { return 0; },
          true);
        return;
      }
      var open = document.getElementById("open");
      var scrim = document.getElementById("scrim");
      watchSheet(open, scrim, "class",
        function () { return scrim.classList.contains("is-on"); },
        function () { return []; },
        function () { return 1; });
    },
    off: function () {
      session++;
      watchers.forEach(function (w) { w.disconnect(); });
      watchers = [];
      stopBlocks();
      springs.forEach(function (s) { s.style.removeProperty("--b-bloom"); });
      springs = [];
    },
    play: function (name) {
      if (name === "open") toggleSheet();
    },
  });
})();
