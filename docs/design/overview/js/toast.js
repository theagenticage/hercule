// PROTOTYPE - one quiet line at the foot of the desk: what just happened, with Undo.
window.Toast = (function () {
  "use strict";
  var el, timer;

  /** Shows a line. With canUndo it offers Undo, and ⌘Z does the same. Replaces any line shown. */
  function show(text, canUndo) {
    if (!el) {
      el = document.getElementById("toast");
      el.addEventListener("click", function (e) {
        if (e.target.closest("[data-undo]")) doUndo();
      });
    }
    el.innerHTML = '<span class="toast-text">' + Board.esc(text) + "</span>" + (canUndo ? '<button class="toast-undo" data-undo>Undo <kbd>⌘Z</kbd></button>' : "");
    el.classList.add("is-on");
    clearTimeout(timer);
    timer = setTimeout(hide, 5200);
  }

  function hide() {
    if (el) el.classList.remove("is-on");
  }

  /** Puts the last change back: the board plays the same motion in reverse. */
  function doUndo() {
    var label = null;
    Board.change(function () { label = Store.undo(); }, { spring: "hand" });
    hide();
    return label;
  }

  return { show: show, hide: hide, undo: doUndo };
})();
