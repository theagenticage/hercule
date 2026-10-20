// DRAWING - Tracking, focus variant: trays (?focus=trays).
//
// A bureau's desk has an in-tray and an out-tray. Intake becomes two columns side by side: In,
// To do's signals as the app draws them, and Out, Tracking. The two are told apart by where they
// sit, not by a surface or a fold: both run the full height, and Out never folds, so every
// tracked row is one glance away. The pane keeps the split beside them.
(function () {
  "use strict";

  window.TrackingFocus = window.TrackingFocus || {};

  /**
   * Draws the two column heads as a pair, "In · To do" and "Out · Tracking", after every render.
   */
  function afterRender(shell) {
    var list = document.querySelector(".asks-list");
    var tray = document.querySelector("[data-tray]");
    var inHead = list.querySelector(".tr-in-h");
    if (!inHead) {
      inHead = document.createElement("div");
      inHead.className = "tr-in-h";
      list.insertBefore(inHead, document.querySelector("[data-list]"));
    }
    inHead.hidden = tray.hidden;
    if (tray.hidden) return;
    var signals = document.querySelectorAll("[data-list] .ask-item").length;
    inHead.innerHTML = '<h2 class="rt-tray-h">' + buildPair("In", "To do", signals) + "</h2>";
    var waiting = shell.countWaiting();
    var head = tray.querySelector(".rt-tray-h");
    head.innerHTML =
      buildPair("Out", "Tracking", shell.sortedTasks().length) +
      (waiting ? '<span class="rt-tray-sum you-ink">' + window.Crew.mark("waiting", 12) + waiting + " wait" + (waiting === 1 ? "s" : "") + " on you</span>" : "");
  }

  /** Returns a column's label: the tray's word in small capitals, the view it holds, and its count. */
  function buildPair(word, name, count) {
    return (
      '<span class="rt-tray-toggle tr-pair"><span class="tr-pair-word">' + word + '</span><span class="tr-pair-name">' + name + "</span>" +
      (count ? '<b class="count">' + count + "</b>" : "") +
      "</span>"
    );
  }

  // Out has the full height, so nothing in it folds.
  window.TrackingFocus.trays = { foldsTray: false, afterRender: afterRender };
})();
