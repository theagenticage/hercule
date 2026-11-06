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
    var next = Store.peekUndo();
    var hint = next && next.hint;
    var origin = hint && hint.from ? Board.locate(hint.from) : null;
    var from = origin ? origin.getBoundingClientRect() : null;
    var done = null;
    Board.change(function () { done = Store.undo(); }, { spring: "travel" });
    Pane.refresh();
    var back = hint && document.querySelector('#lanes .card[data-id="' + hint.id + '"]');
    if (back) {
      // It comes back the way it left: out from under the card it merged into, or down from where it went.
      var r = Motion.layoutRect(back);
      var b = Motion.body(back);
      if (from) b.set({ x: from.left - r.left, y: from.top - r.top, s: 0.94, o: 0 }).to({ x: 0, y: 0, s: 1, o: 1 }, "hand");
      else if (hint.ended === "Done") b.set({ x: 26, y: -14, o: 0 }).to({ x: 0, y: 0, o: 1 }, "travel");
      else if (hint.ended) b.set({ y: 12, r: -1.6, o: 0 }).to({ y: 0, r: 0, o: 1 }, "travel");
    }
    show(done ? "Put back: " + done.label : "Nothing to undo.", false);
  }

  return { show: show, hide: hide, undo: doUndo };
})();
