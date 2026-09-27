// PROTOTYPE - the frame harness for a design book (NN-slug/index.html) and the compare page.
//
// Markup it understands:
//   <figure data-frame="desktop|web|mobile" data-src="desktop/intake.html"
//           data-caption="Intake" [data-url="hercule.home.arpa/intake"] [data-state="scrolled"]
//           [data-note="One line under the caption"]></figure>
//   <button data-theme-option="light">Paper</button>   (anywhere; switches every frame and the book)
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

  function pageUrl(fig) {
    var q = new URLSearchParams();
    var t = fig.dataset.theme || root.dataset.theme;
    if (t) q.set("theme", t);
    if (fig.dataset.state) q.set("state", fig.dataset.state);
    var s = q.toString();
    return fig.dataset.src + (s ? "?" + s : "");
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
      var avail = fig.clientWidth;
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
    });
    markActive();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
  window.HerculeBook = { setTheme: setTheme, build: build };
})();
