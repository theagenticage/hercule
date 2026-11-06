// PROTOTYPE - the desk with nothing on it, and the first moments of loading. An empty desk is a
// welcome, not a hole: it shows where things will go, and offers the one thing to do next.
window.Welcome = (function () {
  "use strict";

  /** Returns the markup under the rule for an empty world, or an empty string. */
  function drawEmpty(scene) {
    if (scene === "first") {
      return '<div class="grid welcome-grid"><div class="cell"><article class="card welcome-card" data-height="stand"><span class="card-holder">' + Board.drawHead("Hercule", "idle").head + "</span>" + Board.drawHead("Hercule", "idle").paws + '<i class="card-stock"></i><div class="card-words"><p class="card-title">Start your first thread</p><p class="card-now">Its Task lands here.</p></div></article></div></div>' +
        '<div class="welcome"><button class="welcome-btn" data-first-thread>' + Crew.icon("compose", 14) + 'Start a thread<kbd>⌘N</kbd></button></div>';
    }
    return "";
  }

  var started = false;

  /** Returns the rays behind the sun, fanning up from the middle of the horizon. */
  function drawRays() {
    var out = "";
    var cx = 360;
    var cy = 240;
    var n = 31;
    for (var i = 0; i < n; i++) {
      var a = Math.PI * (i / (n - 1));
      var r0 = 126;
      var r1 = i % 2 === 0 ? 226 : 182;
      var d = Math.abs(i - (n - 1) / 2);
      out += '<line class="ray" pathLength="1" style="--d:' + d * 26 + 'ms" x1="' + (cx - Math.cos(a) * r0).toFixed(1) + '" y1="' + (cy - Math.sin(a) * r0).toFixed(1) + '" x2="' + (cx - Math.cos(a) * r1).toFixed(1) + '" y2="' + (cy - Math.sin(a) * r1).toFixed(1) + '"/>';
    }
    return out;
  }

  /** Draws the sunrise on the stage rule: Hercule himself, coming up over the edge. */
  function drawSunrise() {
    var wrap = document.querySelector(".rule-wrap");
    var sun = document.createElement("div");
    sun.className = "sunrise";
    sun.innerHTML = '<svg viewBox="0 0 720 240" aria-hidden="true">' + drawRays() + '</svg><div class="sunrise-head">' + Crew.face("Hercule", { pose: "idle", size: 96 }) + "</div>";
    wrap.appendChild(sun);
  }

  function startFirst() {
    if (started) return;
    started = true;
    var ghost = document.querySelector(".welcome-card");
    var name = "Fix the basket total rounding";
    var host = document.getElementById("welcome");
    if (ghost) Motion.body(ghost).to({ s: 0.98, o: 0 }, "travel");
    var btn = document.querySelector(".welcome");
    if (btn) Motion.body(btn).to({ o: 0, y: 6 }, "travel");
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

  return { drawEmpty: drawEmpty, drawSunrise: drawSunrise, startFirst: startFirst, playLoading: playLoading };
})();
