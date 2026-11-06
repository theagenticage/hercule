// PROTOTYPE - the story page: live frames at their real size, scaled down to fit, and the grid of states.
(function () {
  "use strict";
  var q = new URLSearchParams(location.search);
  var theme = document.documentElement.dataset.theme;

  document.querySelectorAll(".st-frame").forEach(function (fig) {
    var w = Number(fig.dataset.w);
    var h = Number(fig.dataset.h);
    var box = document.createElement("div");
    box.className = "st-box";
    var frame = document.createElement("iframe");
    frame.loading = "lazy";
    frame.width = w;
    frame.height = h;
    frame.title = "Live prototype";
    var src = fig.dataset.src;
    frame.src = src + (src.indexOf("?") < 0 ? "?" : "&") + "theme=" + theme;
    box.appendChild(frame);
    fig.insertBefore(box, fig.firstChild);
    function fit() {
      var s = fig.clientWidth / w;
      frame.style.transform = "scale(" + s + ")";
      box.style.height = h * s + "px";
    }
    fit();
    window.addEventListener("resize", fit);
  });

  var STATES = [["today", "This morning"], ["hover", "Hover: the card says what it wants"], ["folded", "Everything folded"], ["focus", "Keyboard focus"], ["lens", "A lens on real thinking"], ["plan", "A plan opened into a band"], ["pile", "A pile fanned open"], ["drag", "A card carried"], ["merge", "Two cards drawn together"], ["pane", "Details, your move"], ["pane-agent", "Details, an agent holds it"], ["one", "One card"], ["first", "First run"], ["empty", "The desk is clear"], ["loading", "Loading: the layout is already right"], ["offline", "Offline"], ["awkward", "Awkward data"], ["wear", "Wear on"]];
  var grid = document.getElementById("grid");
  grid.innerHTML = STATES.map(function (s) {
    return '<figure><img loading="lazy" src="screens/' + s[0] + "--" + theme + '.jpg" alt="' + s[1] + '"><figcaption>' + s[1] + "</figcaption></figure>";
  }).join("");
})();
