// PROTOTYPE - the story page: live frames at their real size, scaled down to fit, and the grid of states.
(function () {
  "use strict";
  var q = new URLSearchParams(location.search);
  var theme = document.documentElement.dataset.theme;
  document.getElementById("go-window").href = "desktop.html?theme=" + theme;

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

  var STATES = [["today", "Initiatives on top, bands"], ["in-lanes", "Initiatives in lanes, bands"], ["side-labels", "Initiatives on top, side labels"], ["side-labels-in-lanes", "Initiatives in lanes, side labels"], ["folded", "Folded, bands"], ["folded-in-lanes", "Folded, initiatives in lanes"], ["folded-side-labels", "Folded, side labels"], ["folded-side-labels-in-lanes", "Folded, side labels, initiatives in lanes"], ["quiet", "Nothing asks"], ["hover", "Hover"], ["focus", "Keyboard focus"], ["plan", "An initiative opened"], ["stack", "A stack, closed"], ["stack-open", "A stack, open"], ["more", "The rest of a cell, open in place"], ["group-menu", "Group by"], ["group-context", "Grouped by Linear project"], ["group-repo", "Grouped by repository"], ["group-initiative", "Grouped by initiative"], ["filter-menu", "Filter"], ["filter-context", "Filtered to one Linear project"], ["filter-question", "Filtered to open questions"], ["add", "Add to Work, from a lane"], ["add-all", "Add to Work, from the toolbar"], ["add-searching", "Add: searching the source"], ["add-results", "Add: results from the source"], ["add-link", "Add: a pasted link"], ["add-followed", "Add: a new thing, now followed"], ["add-none", "Add: nothing found in a scope"], ["add-locked", "Add: a link you cannot open"], ["add-offline", "Add: offline"], ["drag", "A card carried"], ["merge", "Two cards drawn together"], ["pane", "Details, with Part of and Linked"], ["pane-question", "Details, an open question"], ["failed", "A run failed"], ["failed-filter", "Filtered to what failed"], ["failed-pane", "Details, a failed run"], ["failed-folded", "A failed run, folded"], ["failed-threads", "The dot in the Threads face"], ["one", "One card"], ["first", "First run"], ["empty", "All clear"], ["loading", "Loading: the layout is already right"], ["offline", "Offline"], ["awkward", "Awkward data"], ["many", "300 cards"], ["many-folded", "300 cards, folded"], ["wear", "Wear on"]];
  var grid = document.getElementById("grid");
  grid.innerHTML = STATES.map(function (s) {
    return '<figure><img loading="lazy" src="screens/' + s[0] + "--" + theme + '.jpg" alt="' + s[1] + '"><figcaption>' + s[1] + "</figcaption></figure>";
  }).join("");
})();
