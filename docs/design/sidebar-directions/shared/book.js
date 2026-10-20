// PROTOTYPE - the harness for this book's pages (index.html and each direction's index.html).
//
// Markup it understands:
//   <figure class="bk-frame" data-src="desktop.html?state=swarm"
//           data-caption="The swarm" data-note="One line under the caption"
//           [data-crop="0,0,300,900"] [data-zoom="1.5"] [data-w="1440"] [data-h="900"]
//           [data-replay]></figure>
//     Draws the page live in a scaled iframe. With data-crop ("x,y,w,h" in the page's pixels) it
//     shows only that part of the page, at data-zoom when the column is wide enough, else as large
//     as fits. data-replay adds a Replay button that reloads the frame, for states that animate.
//   <button data-theme-option="whitehaven">Whitehaven</button>
//     Switches the book and every frame to that theme; the choice is kept per book.
(function () {
  "use strict";

  var root = document.documentElement;
  var storeKey = "sbd-theme";
  var params = new URLSearchParams(location.search);
  var theme = params.get("theme") || localStorage.getItem(storeKey) || "whitehaven";
  root.dataset.theme = theme;

  function frameUrl(fig) {
    var src = fig.dataset.src;
    var joiner = src.indexOf("?") >= 0 ? "&" : "?";
    return src + joiner + "theme=" + encodeURIComponent(fig.dataset.theme || root.dataset.theme);
  }

  function build(fig) {
    var w = Number(fig.dataset.w || 1440);
    var h = Number(fig.dataset.h || 900);
    var crop = fig.dataset.crop ? fig.dataset.crop.split(",").map(Number) : [0, 0, w, h];
    var zoom = Number(fig.dataset.zoom || 1);

    var device = document.createElement("div");
    device.className = "bk-device" + (fig.dataset.crop ? " bk-device--crop" : "");
    var viewport = document.createElement("div");
    viewport.className = "bk-viewport";
    var iframe = document.createElement("iframe");
    iframe.loading = "lazy";
    iframe.title = fig.dataset.caption || "Design";
    iframe.width = String(w);
    iframe.height = String(h);
    iframe.style.width = w + "px";
    iframe.style.height = h + "px";
    iframe.src = frameUrl(fig);
    viewport.appendChild(iframe);
    device.appendChild(viewport);

    var cap = document.createElement("figcaption");
    cap.className = "bk-cap";
    cap.innerHTML =
      '<span class="bk-cap-text"><b>' + (fig.dataset.caption || "") + "</b>" + (fig.dataset.note ? "<span>" + fig.dataset.note + "</span>" : "") + "</span>" +
      '<span class="bk-cap-acts">' +
      (fig.hasAttribute("data-replay") ? '<button type="button" class="bk-replay">Replay</button>' : "") +
      '<a class="bk-open" href="' + frameUrl(fig) + '" target="_blank" rel="noopener">Open ↗</a></span>';

    fig.innerHTML = "";
    fig.appendChild(device);
    fig.appendChild(cap);

    var replay = cap.querySelector(".bk-replay");
    if (replay) replay.addEventListener("click", function () { iframe.src = frameUrl(fig); });

    function fit() {
      var avail = fig.clientWidth;
      var scale = Math.min(fig.dataset.crop ? zoom : 1, avail / crop[2]);
      viewport.style.width = Math.round(crop[2] * scale) + "px";
      viewport.style.height = Math.round(crop[3] * scale) + "px";
      iframe.style.transform = "scale(" + scale + ") translate(" + -crop[0] + "px," + -crop[1] + "px)";
    }
    fit();
    new ResizeObserver(fit).observe(fig);
    fig._reload = function () {
      iframe.src = frameUrl(fig);
      cap.querySelector(".bk-open").href = frameUrl(fig);
    };
  }

  function setTheme(next) {
    theme = next;
    root.dataset.theme = next;
    localStorage.setItem(storeKey, next);
    document.querySelectorAll("[data-theme-option]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.themeOption === next));
    });
    document.querySelectorAll(".bk-frame").forEach(function (f) {
      if (f._reload && !f.dataset.theme) f._reload();
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll(".bk-frame").forEach(build);
    document.querySelectorAll("[data-theme-option]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.themeOption === theme));
      b.addEventListener("click", function () { setTheme(b.dataset.themeOption); });
    });
  });
})();
