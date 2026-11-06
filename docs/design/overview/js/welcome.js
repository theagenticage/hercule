// PROTOTYPE - the desk with nothing on it, and the first moments of loading. An empty desk is a
// welcome, not a hole: it shows where things will go, and offers the one thing to do next.
window.Welcome = (function () {
  "use strict";

  /** Returns the markup under the rule for an empty world, or an empty string. */
  function drawEmpty(scene) {
    if (scene === "first") {
      return '<div class="grid welcome-grid"><div class="cell"><article class="card card--ghost" data-height="etch"><span class="card-holder"><span class="card-head">' + Crew.peek("Hercule", { pose: "idle", size: 26, crop: 33 }) + '</span></span><i class="card-stock"></i><div class="card-text"><span class="card-title">Your first Task lands here</span><br>Every thread you start joins one by itself.</div></article></div></div>' +
        '<div class="welcome"><button class="welcome-btn" data-first-thread>' + Crew.icon("compose", 14) + 'Start a thread<kbd>⌘N</kbd></button></div>';
    }
    return '<div class="welcome welcome--clear">' + Crew.face("Hercule", { pose: "idle", size: 84 }) + '<p class="welcome-line">Nothing wants you. The crew is at rest.</p></div>';
  }

  function startFirst() {
    var ghost = document.querySelector(".card--ghost");
    var name = "Fix the basket total rounding";
    var host = document.getElementById("welcome");
    if (ghost) Motion.body(ghost).to({ s: 0.98, o: 0 }, "back");
    var btn = document.querySelector(".welcome");
    if (btn) Motion.body(btn).to({ o: 0, y: 6 }, "back");
    setTimeout(function () {
      host.innerHTML = "";
      Tray.arriveNext();
    }, 260);
  }

  function playLoading() {
    var work = document.getElementById("work");
    work.classList.add("is-loading");
    document.querySelectorAll("#lanes .card").forEach(function (c) { c.classList.add("is-skeleton"); });
    setTimeout(function () {
      var cards = Array.prototype.slice.call(document.querySelectorAll("#lanes .card.is-skeleton"));
      cards.sort(function (a, b) {
        var ra = a.getBoundingClientRect();
        var rb = b.getBoundingClientRect();
        return ra.top - rb.top || ra.left - rb.left;
      });
      cards.forEach(function (c, i) {
        setTimeout(function () { c.classList.remove("is-skeleton"); }, i * 26);
      });
      setTimeout(function () { work.classList.remove("is-loading"); }, cards.length * 26 + 200);
    }, Number(new URLSearchParams(location.search).get("hold")) || 1600);
  }

  return { drawEmpty: drawEmpty, startFirst: startFirst, playLoading: playLoading };
})();
