// The story page: fits live frames of the window into the page, keeps them on the chosen theme, sends
// them moves from the buttons under them, and draws real rows, the colours and the gallery.
(function () {
  "use strict";
  var root = document.documentElement;
  var pick = document.getElementById("theme");
  var frames = [].slice.call(document.querySelectorAll(".frame"));

  function frameUrl(f) { return "desktop.html?theme=" + root.dataset.theme + "&" + (f.dataset.q || ""); }

  /** Scales a frame's window so the whole 1440 by 900 window fits the frame's width. */
  function fit(f) {
    var iframe = f.querySelector("iframe");
    var scale = f.clientWidth / 1440;
    f.style.height = Math.round(900 * scale) + "px";
    if (!iframe) return;
    iframe.style.width = "1440px";
    iframe.style.height = "900px";
    iframe.style.transform = "scale(" + scale + ")";
  }
  function mount(f) {
    if (f.querySelector("iframe")) return;
    var iframe = document.createElement("iframe");
    iframe.src = frameUrl(f);
    iframe.title = f.getAttribute("aria-label") || "The Inbox";
    f.appendChild(iframe);
    fit(f);
  }
  var seen = new IntersectionObserver(function (entries) { entries.forEach(function (e) { if (e.isIntersecting) mount(e.target); }); }, { rootMargin: "300px" });
  frames.forEach(function (f) { fit(f); seen.observe(f); });
  window.addEventListener("resize", function () { frames.forEach(fit); });

  pick.value = root.dataset.theme;
  pick.addEventListener("change", function () {
    root.dataset.theme = pick.value;
    history.replaceState(null, "", "?theme=" + pick.value);
    frames.forEach(function (f) { var i = f.querySelector("iframe"); if (i) i.src = frameUrl(f); });
    drawGallery();
  });

  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-send]");
    if (!b) return;
    var f = document.getElementById(b.dataset.to).querySelector("iframe");
    if (f) f.contentWindow.postMessage(JSON.parse(b.dataset.send), "*");
  });

  // ---- Real rows, with what each slot is ----
  function drawAnatomy() {
    Model.load(World.build("normal"));
    var s = { selection: new Set(), focus: null };
    var rows = [
      List.build({ type: "thing", thing: Model.byId("pr-6213") }, s),
      List.build({ type: "thing", thing: Model.byId("sn-21c") }, s),
      List.build({ type: "group", group: Model.groupOf("pay-88"), open: false, best: Model.byId("pr-1204") }, s),
      List.build({ type: "thing", thing: Model.byId("shop-163") }, s),
    ];
    var host = document.getElementById("anat");
    host.innerHTML = '<div class="anat-list"><div class="rows">' + rows.map(function (r) { return '<div class="' + r.cls + '">' + r.html + "</div>"; }).join("") + "</div></div>" +
      '<dl class="anat-keys">' +
      "<div><dt>Mark</dt><dd>The source, in its declared hue. Hovered, it makes way for a tick: X selects.</dd></div>" +
      "<div><dt>Glyph</dt><dd>The status: a shape from the core's set, in the source's hue, quiet, or the app's green and tomato.</dd></div>" +
      "<div><dt>Title</dt><dd>The only medium weight. One line; the pane has all of it.</dd></div>" +
      "<div><dt>The ask</dt><dd>The newest open ask, the person in ink. +1 says there is another.</dd></div>" +
      "<div><dt>Wait</dt><dd>Against the patience of the ask: faint, then muted, then ink and semibold when over.</dd></div>" +
      "<div><dt>Where</dt><dd>The kind's place field and identifier, cut first.</dd></div>" +
      "<div><dt>A group</dt><dd>A chevron, the most lasting thing's title, the most pressing ask, and the marks and count of its things.</dd></div>" +
      "<div><dt>Quiet</dt><dd>A thing that asks nothing: its status, its context, faint.</dd></div></dl>";
  }

  function drawSwatches() {
    var srcs = Object.keys(Kinds.SOURCES);
    document.getElementById("swatches").innerHTML =
      '<div class="sw-cell"><h4>Sources</h4>' + srcs.map(function (k) { return '<p>' + Draw.mark(k, 16) + "<span>" + Kinds.SOURCES[k].name + "</span><small>" + (Kinds.SOURCES[k].hue == null ? "grey" : "hue " + Kinds.SOURCES[k].hue) + "</small></p>"; }).join("") + "</div>" +
      '<div class="sw-cell"><h4>Status glyphs</h4>' + [["linear/issue", "started"], ["linear/issue", "review"], ["linear/issue", "done"], ["github/pull-request", "open"], ["github/pull-request", "failing"], ["github/pull-request", "approved"], ["sentry/issue", "escalating"], ["sentry/issue", "ongoing"]].map(function (x) { var t = { kind: x[0], status: x[1] }; return "<p>" + Draw.glyph(t, 14) + "<span>" + Draw.statusWord(t) + "</span><small>" + Kinds.KINDS[x[0]].statuses[x[1]].tone + "</small></p>"; }).join("") + "</div>" +
      '<div class="sw-cell"><h4>Project health</h4>' + ["on-track", "at-risk", "off-track"].map(function (h) { return "<p>" + Draw.health(h) + "<span>" + Draw.HEALTH[h].word + "</span></p>"; }).join("") + '<h4 class="sw-gap">Triage and you</h4><p><b class="tri-word">Proposal</b><b class="tri-word">Link?</b></p><p><b class="count count--you">2</b><span>Triage in the rail</span></p></div>' +
      '<div class="sw-cell"><h4>The one suggested answer</h4><p><button class="btn btn--sm btn--answer" tabindex="-1">Approve<kbd>↩</kbd></button></p><p><span>Everything else is a neutral tablet.</span></p><p><button class="btn btn--sm" tabindex="-1">Start a thread<kbd>N</kbd></button></p></div>';
  }

  function drawGallery() {
    document.getElementById("gal").innerHTML = (window.STATES || []).map(function (s) {
      var src = "screens/" + root.dataset.theme + "/" + s[0] + ".webp";
      return '<a href="' + src + '" target="_blank"><img loading="lazy" src="' + src + '" alt="' + s[1] + '"><span>' + s[1] + "</span></a>";
    }).join("");
  }

  drawAnatomy();
  drawSwatches();
  drawGallery();
})();
