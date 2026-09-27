// PROTOTYPE - the frame harness for a design book (NN-slug/index.html) and the compare page.
//
// Markup it understands:
//   <figure data-frame="desktop|web|mobile" data-src="desktop/intake.html"
//           data-caption="Intake" [data-url="hercule.home.arpa/intake"] [data-state="scrolled"]
//           [data-note="One line under the caption"]></figure>
//   <button data-theme-option="light">Paper</button>   (anywhere; switches every frame and the book)
//   <input type="range" min="0" max="100" value="40" data-glass-control>
//       (anywhere; moves --glass-level in every frame and the book, live, without a reload;
//        its value attribute is the design's default glass level in percent)
//       (its style gets --fill: <value>%, for a design that paints the filled part of the track)
//   <output data-glass-value></output>   shows the level; data-default-label is shown until the
//       slider moves (e.g. "as designed" on the compare page)
//   <button data-glass-reset>Default</button>   drops the override and reloads every frame
//   A frame whose data-src carries its own glass level (e.g. "desktop/intake.html?glass=0") keeps
//   that level: the slider leaves it alone, so a book can show one surface at fixed levels.
//
// Frames render the page live in a scaled iframe inside neutral device chrome:
//   desktop  1440 x 900  the page draws its own window chrome (titlebar, traffic lights)
//   web      1280 x 800  the harness draws a neutral browser around it
//   mobile    390 x 844  the harness draws a phone bezel; the page draws its own status bar
(function () {
  var SIZES = { desktop: [1440, 900], web: [1280, 800], mobile: [390, 844] };
  var root = document.documentElement;
  var params = new URLSearchParams(location.search);
  var storeKey = "ds-theme:" + location.pathname;
  var theme = params.get("theme") || localStorage.getItem(storeKey) || root.dataset.theme || "";
  if (theme) root.dataset.theme = theme;

  // The glass level is null until the reader moves a slider: every frame then shows its design's
  // own default. Once set, it travels in the frame URLs and is posted to frames already loaded.
  var glassKey = "ds-glass:" + location.pathname;
  var glass = params.has("glass") ? Number(params.get("glass")) : readStoredGlass();
  function readStoredGlass() {
    var stored = localStorage.getItem(glassKey);
    return stored === null ? null : Number(stored);
  }
  if (glass !== null) root.style.setProperty("--glass-level", String(glass));

  function hasPinnedGlass(fig) {
    return /[?&]glass=/.test(fig.dataset.src);
  }

  function pageUrl(fig) {
    var q = new URLSearchParams();
    var t = fig.dataset.theme || root.dataset.theme;
    if (t) q.set("theme", t);
    if (fig.dataset.state) q.set("state", fig.dataset.state);
    if (glass !== null && !hasPinnedGlass(fig)) q.set("glass", String(glass));
    var s = q.toString();
    // data-src may carry its own query (e.g. "mobile/intake.html?annotate").
    var joiner = fig.dataset.src.indexOf("?") >= 0 ? "&" : "?";
    return fig.dataset.src + (s ? joiner + s : "");
  }

  function build(fig) {
    var kind = fig.dataset.frame;
    var size = SIZES[kind];
    var w = Number(fig.dataset.w || size[0]);
    var h = Number(fig.dataset.h || size[1]);
    fig.classList.add("f", "f--" + kind);

    var device = document.createElement("div");
    device.className = "f-device";
    if (kind === "web") {
      var bar = document.createElement("div");
      bar.className = "f-browser";
      bar.innerHTML =
        '<span class="f-dots"><i></i><i></i><i></i></span>' +
        '<span class="f-nav">&#8249;&nbsp;&#8250;</span>' +
        '<span class="f-url"><svg viewBox="0 0 12 12" width="10" height="10"><path d="M3.5 5.5V4a2.5 2.5 0 0 1 5 0v1.5M2.8 5.5h6.4v4.2H2.8z" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>' +
        (fig.dataset.url || "hercule.home.arpa") +
        "</span>";
      device.appendChild(bar);
    }
    var viewport = document.createElement("div");
    viewport.className = "f-viewport";
    var iframe = document.createElement("iframe");
    iframe.loading = "lazy";
    iframe.width = w;
    iframe.height = h;
    iframe.src = pageUrl(fig);
    iframe.title = fig.dataset.caption || fig.dataset.src;
    // A lazy frame may load after the slider moved, from a URL without the new level.
    iframe.addEventListener("load", function () {
      if (glass !== null && !hasPinnedGlass(fig)) iframe.contentWindow.postMessage({ glass: glass }, "*");
    });
    viewport.appendChild(iframe);
    device.appendChild(viewport);

    var cap = document.createElement("figcaption");
    cap.className = "f-caption";
    cap.innerHTML =
      "<span>" +
      (fig.dataset.caption || "") +
      (fig.dataset.note ? '<small>' + fig.dataset.note + "</small>" : "") +
      '</span><a target="_blank" rel="noopener">Open &#8599;</a>';
    var open = cap.querySelector("a");
    open.href = pageUrl(fig);

    fig.innerHTML = "";
    fig.appendChild(device);
    fig.appendChild(cap);

    function fit() {
      // clientWidth includes padding; the device must fit inside the content box.
      var style = getComputedStyle(fig);
      var avail = fig.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      var max = Number(fig.dataset.maxScale || (kind === "mobile" ? 0.8 : 1));
      var scale = Math.min(max, avail / (w + (kind === "mobile" ? 24 : 0)));
      iframe.style.transform = "scale(" + scale + ")";
      viewport.style.width = w * scale + "px";
      viewport.style.height = h * scale + "px";
      device.style.width = w * scale + (kind === "mobile" ? 24 * scale : 0) + "px";
      fig.style.setProperty("--f-scale", scale);
    }
    new ResizeObserver(fit).observe(fig);
    fit();
    fig._refresh = function () {
      iframe.src = pageUrl(fig);
      open.href = pageUrl(fig);
    };
    fig._postGlass = function () {
      if (hasPinnedGlass(fig)) return;
      if (glass !== null) iframe.contentWindow.postMessage({ glass: glass }, "*");
      open.href = pageUrl(fig);
    };
  }

  function showGlass() {
    document.querySelectorAll("[data-glass-control]").forEach(function (input) {
      input.value = glass === null ? input.defaultValue : String(Math.round(glass * 100));
      // A design may paint the filled part of its slider track from --fill.
      input.style.setProperty("--fill", input.value + "%");
    });
    document.querySelectorAll("[data-glass-value]").forEach(function (out) {
      out.textContent =
        glass === null && out.dataset.defaultLabel
          ? out.dataset.defaultLabel
          : Math.round((glass === null ? readSliderDefault() : glass) * 100) + "%";
    });
  }

  function readSliderDefault() {
    var input = document.querySelector("[data-glass-control]");
    return input ? Number(input.defaultValue) / 100 : 0;
  }

  function setGlass(level) {
    glass = level;
    var q = new URLSearchParams(location.search);
    if (glass === null) {
      localStorage.removeItem(glassKey);
      q.delete("glass");
      root.style.removeProperty("--glass-level");
    } else {
      localStorage.setItem(glassKey, String(glass));
      q.set("glass", String(glass));
      root.style.setProperty("--glass-level", String(glass));
    }
    var query = q.toString();
    history.replaceState(null, "", (query ? "?" + query : location.pathname) + location.hash);
    document.querySelectorAll("[data-frame]").forEach(function (f) {
      if (glass === null) f._refresh && f._refresh();
      else f._postGlass && f._postGlass();
    });
    showGlass();
  }

  function markActive() {
    document.querySelectorAll("[data-theme-option]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.themeOption === root.dataset.theme));
    });
  }

  function setTheme(t) {
    root.dataset.theme = t;
    localStorage.setItem(storeKey, t);
    var q = new URLSearchParams(location.search);
    q.set("theme", t);
    history.replaceState(null, "", "?" + q.toString() + location.hash);
    document.querySelectorAll("[data-frame]").forEach(function (f) {
      if (f._refresh && !f.dataset.theme) f._refresh();
    });
    markActive();
  }

  function init() {
    document.querySelectorAll("[data-frame]").forEach(build);
    document.addEventListener("click", function (e) {
      var b = e.target.closest("[data-theme-option]");
      if (b) setTheme(b.dataset.themeOption);
      if (e.target.closest("[data-glass-reset]")) setGlass(null);
    });
    document.addEventListener("input", function (e) {
      if (e.target.matches("[data-glass-control]")) setGlass(Number(e.target.value) / 100);
    });
    markActive();
    showGlass();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
  window.HerculeBook = { setTheme: setTheme, setGlass: setGlass, build: build };
})();
