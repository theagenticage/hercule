// PROTOTYPE - not part of the design: the controls a reviewer needs. Themes, states, and buttons
// that make the outside world happen.
window.Tray = (function () {
  "use strict";
  var THEMES = [["whitehaven", "Whitehaven"], ["styles", "Styles"], ["orient-express", "Orient Express"], ["nile", "Nile"], ["end-house", "End House"], ["blue-train", "Blue Train"]];
  var SCENES = [["today", "This morning"], ["many", "300 cards"], ["one", "One card"], ["first", "First run"], ["empty", "Desk clear"], ["loading", "Loading"], ["offline", "Offline"], ["quiet", "Nothing asks"], ["failed", "A run failed"], ["awkward", "Awkward data"]];
  var EVENTS = [["thread", "A thread starts"], ["merge", "A pull request merges"], ["fail", "The next move fails"], ["run-fails", "A run fails"], ["replay", "Replay the morning"]];

  function link(key, value) {
    var q = new URLSearchParams(location.search);
    q.set(key, value);
    return "?" + q.toString();
  }

  function mount() {
    var q = new URLSearchParams(location.search);
    var el = document.getElementById("tray");
    var theme = document.documentElement.dataset.theme;
    var scene = q.get("scene") || "today";
    el.innerHTML = '<button class="tray-toggle" id="tray-toggle">Prototype</button><div class="tray-body"><h4>Theme</h4><div class="tray-swatches">' + THEMES.map(function (t) {
      return '<a href="' + link("theme", t[0]) + '" class="tray-swatch' + (t[0] === theme ? " is-on" : "") + '" data-theme="' + t[0] + '" title="' + t[1] + '"><i></i></a>';
    }).join("") + "</div><h4>State</h4>" + SCENES.map(function (s) {
      return '<a class="tray-row' + (s[0] === scene ? " is-on" : "") + '" href="' + link("scene", s[0]) + '">' + s[1] + "</a>";
    }).join("") + "<h4>Make it happen</h4>" + EVENTS.map(function (e) {
      return '<button class="tray-row" data-event="' + e[0] + '">' + e[1] + "</button>";
    }).join("") + '<h4>Motion</h4><a class="tray-row" href="' + link("slow", "6") + '">Six times slower</a><button class="tray-row" data-event="reduced">Reduced motion</button><a class="tray-row" href="' + link("later", "1") + '">Show later views</a></div>';
    el.addEventListener("click", function (e) {
      var ev = e.target.closest("[data-event]");
      if (e.target.closest("#tray-toggle")) el.classList.toggle("is-open");
      if (!ev) return;
      var name = ev.dataset.event;
      if (name === "thread") Tray.arriveNext();
      if (name === "merge") Tray.mergeNext();
      if (name === "fail") { Store.failNext = true; Toast.show("The next move will fail.", false); }
      if (name === "run-fails") Tray.failNextRun();
      if (name === "replay") location.href = link("scene", "today");
      if (name === "reduced") { document.documentElement.dataset.motion = document.documentElement.dataset.motion ? "" : "reduced"; Toast.show("Reduced motion " + (document.documentElement.dataset.motion ? "on." : "off."), false); }
    });
  }

  var titles = ["Basket totals drift after a coupon", "Delivery notes cut off on phones", "Pick lists print in the wrong order", "Search shows sold-out items first"];
  var n = 0;
  function arriveNext() {
    var name = titles[n % titles.length];
    n++;
    Live.arrive({ id: "new-" + n + "-" + Date.now(), name: name, project: "storefront", initiative: "", stage: "exploring", agent: "Look into " + name, now: "A thread just started.", where: "A thread just started on this.", left: "", ask: "", kind: "thread", source: "", ref: "", age: 0, stalled: false, person: "", options: [], context: [], links: [], threads: [{ title: name, id: "x" + n }] });
  }

  function mergeNext() {
    var pick = Store.state.tasks.filter(function (t) { return t.stage === "reviewing" && document.querySelector('#lanes .card[data-id="' + t.id + '"]'); })[0];
    if (!pick) pick = Store.state.tasks.filter(function (t) { return t.stage === "reviewing"; })[0];
    Live.fact(pick.id, "landed", "PR merged", function (t) { t.agent = ""; t.person = ""; t.now = "Merged just now."; });
  }

  var causes = ["the job ran out of time", "the runner went offline", "a check would not start"];

  function failNextRun() {
    var pick = Store.state.tasks.filter(function (t) { return t.agent && !t.question && !t.failed; })[0];
    if (!pick) return Toast.show("No run to fail right now.", false);
    n++;
    Live.fail(pick.id, { action: "Run the plan", cause: causes[n % causes.length] });
  }

  return { mount: mount, arriveNext: arriveNext, mergeNext: mergeNext, failNextRun: failNextRun };
})();
