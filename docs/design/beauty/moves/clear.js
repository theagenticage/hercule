// PROTOTYPE - A clear desk. Replaces the ring of rays on the empty page with a horizon in the colour
// of the hour. It adds one scene to the box Hercule rises in, on either view, and takes it out again.
(function () {
  "use strict";

  var HOSTS = ".sunrise-head, .zero-n";
  var WORDS = ".welcome--clear > *, .zero-t, .zero-s";
  // How long the rise and the bow take, from the first light to the page being still.
  var RISE_MS = 3900;

  // The hour against the light: [hour, hue, chroma, strength, night]. Hues run on past zero, so that
  // dusk turns from apricot to violet by the short way round.
  var HOURS = [
    [0, -92, 0.05, 0.62, 1],
    [4.5, -92, 0.05, 0.62, 1],
    [5.5, 34, 0.055, 0.8, 0.55],
    [6.75, 58, 0.08, 1, 0],
    [8, 74, 0.075, 0.95, 0],
    [9.5, 92, 0.03, 0.8, 0],
    [11, 225, 0.042, 0.8, 0],
    [15, 225, 0.042, 0.8, 0],
    [16.25, 96, 0.03, 0.8, 0],
    [17.5, 74, 0.08, 0.95, 0],
    [19, 60, 0.088, 1, 0],
    [20.25, 34, 0.065, 0.86, 0.45],
    [21.25, -72, 0.06, 0.7, 0.9],
    [22.5, -92, 0.05, 0.62, 1],
    [24, -92, 0.05, 0.62, 1],
  ];

  // A few stars, fixed for good, on a 720 by 300 sky whose horizon is its bottom edge: [x, y, radius].
  var STARS = [[206, 196, 1.3], [244, 122, 1.1], [288, 170, 0.9], [318, 74, 1.2], [392, 58, 0.9], [462, 148, 1.1], [516, 196, 1.3], [536, 110, 1]];

  var observer = null;
  var clock = 0;
  var pinned = null;
  // True while the page has been showing its empty scene, so a redraw of it does not rise again.
  var hasArrived = false;
  var timers = [];
  var queued = 0;

  /** Returns the hour to draw: the one the panel's slider or ?hour= chose, or the time here. */
  function readHour() {
    if (pinned !== null) return pinned;
    var now = new Date();
    return now.getHours() + now.getMinutes() / 60;
  }

  /** Writes the colour of an hour onto a scene, blending between the two nearest rows of HOURS. */
  function paintHour(sky) {
    var hour = ((readHour() % 24) + 24) % 24;
    var i = 0;
    while (i < HOURS.length - 2 && HOURS[i + 1][0] <= hour) i++;
    var a = HOURS[i];
    var b = HOURS[i + 1];
    var t = (hour - a[0]) / (b[0] - a[0]);
    var blend = function (n) { return a[n] + (b[n] - a[n]) * t; };
    sky.style.setProperty("--sky-hue", ((blend(1) + 360) % 360).toFixed(1));
    sky.style.setProperty("--sky-chroma", blend(2).toFixed(4));
    sky.style.setProperty("--sky-glow", blend(3).toFixed(3));
    sky.style.setProperty("--sky-night", blend(4).toFixed(3));
  }

  /** Returns Hercule's face with his hat in a group of its own, so that he can tip it. */
  function drawFace() {
    var holder = document.createElement("div");
    holder.innerHTML = Crew.face("Hercule", { pose: "idle", size: 96 });
    var svg = holder.firstChild;
    var hat = svg.querySelectorAll('path[fill="var(--hat)"]');
    var crown = hat[0];
    var band = crown.nextElementSibling;
    var brim = hat[1];
    var group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.setAttribute("class", "b-hat");
    crown.parentNode.insertBefore(group, crown);
    group.appendChild(crown);
    group.appendChild(band);
    group.appendChild(brim);
    return svg;
  }

  function drawNight() {
    var stars = STARS.map(function (s) { return '<circle cx="' + s[0] + '" cy="' + s[1] + '" r="' + s[2] + '"/>'; }).join("");
    return '<svg class="b-sky-night" viewBox="0 0 720 300" aria-hidden="true">' + stars +
      '<path transform="translate(436 100) rotate(-24)" d="M0-13A13 13 0 1 0 0 13 17 17 0 0 1 0-13z"/></svg>';
  }

  /** Adds the scene to the box Hercule stands in. Returns it. */
  function drawSky(host) {
    var sky = document.createElement("div");
    sky.className = "b-sky";
    sky.setAttribute("aria-hidden", "true");
    sky.innerHTML = '<div class="b-sky-above"><i class="b-sky-dome"></i>' + drawNight() + '<i class="b-sky-disc"></i><div class="b-sky-head"></div></div>' +
      '<i class="b-sky-line"></i><i class="b-sky-ground"></i>';
    sky.querySelector(".b-sky-head").appendChild(drawFace());
    paintHour(sky);
    host.appendChild(sky);
    return sky;
  }

  /** Plays the rise on a scene, or with movement off lets the finished picture fade in. */
  function rise(sky) {
    var words = document.querySelectorAll(WORDS);
    if (Beauty.isCalm()) {
      sky.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 420, easing: "ease-out" });
      return;
    }
    sky.classList.remove("is-rising");
    void sky.offsetWidth;
    sky.classList.add("is-rising");
    words.forEach(function (el) {
      el.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 640, delay: 400, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "backwards" });
    });
    timers.push(setTimeout(function () { sky.classList.remove("is-rising"); }, RISE_MS));
  }

  /** Dresses any empty page that has appeared since the last look. */
  function dressHosts() {
    queued = 0;
    var hosts = document.querySelectorAll(HOSTS);
    hosts.forEach(function (host) {
      if (host.querySelector(":scope > .b-sky")) return;
      var sky = drawSky(host);
      if (!hasArrived) rise(sky);
    });
    hasArrived = hosts.length > 0;
  }

  function queueDress() {
    if (!queued) queued = requestAnimationFrame(dressHosts);
  }

  function repaintHours() {
    document.querySelectorAll(".b-sky").forEach(paintHour);
  }

  Beauty.move("clear", {
    on: function () {
      var asked = new URLSearchParams(location.search).get("hour");
      if (asked !== null) pinned = Number(asked);
      dressHosts();
      observer = new MutationObserver(queueDress);
      observer.observe(document.body, { childList: true, subtree: true });
      clock = setInterval(repaintHours, 60000);
    },
    off: function () {
      observer.disconnect();
      clearInterval(clock);
      hasArrived = false;
      cancelAnimationFrame(queued);
      queued = 0;
      timers.forEach(clearTimeout);
      timers = [];
      document.querySelectorAll(".b-sky").forEach(function (sky) { sky.remove(); });
    },
    // The panel's slider sends a number, and null goes back to the clock. "again" replays the rise.
    play: function (name, value) {
      if (name === "hour") {
        pinned = value;
        repaintHours();
        return;
      }
      document.querySelectorAll(".b-sky").forEach(rise);
    },
  });
})();
