// PROTOTYPE - the study page. Holds both views in frames, and sends each change of the panel to them
// by postMessage, because frames opened from disk are cross-origin to this page.
(function () {
  "use strict";

  var THEMES = [
    ["whitehaven", "oklch(0.965 0.005 95)"],
    ["styles", "oklch(0.952 0.016 80)"],
    ["orient-express", "oklch(0.195 0.012 50)"],
    ["nile", "oklch(0.22 0.022 180)"],
    ["end-house", "oklch(0.2 0.02 350)"],
    ["blue-train", "oklch(0.23 0.03 250)"],
  ];
  var FRAME_SRC = { work: "work/desktop.html", inbox: "inbox/desktop.html" };

  var params = new URLSearchParams(location.search);
  var state = {
    view: params.get("view") === "inbox" ? "inbox" : "work",
    theme: params.get("theme") || "whitehaven",
    on: (params.get("m") || "").split(",").filter(Boolean),
    motion: "",
    scene: { work: "", inbox: "" },
  };
  var frames = {};
  var root = document.documentElement;

  function readRecommended() {
    return STUDY.moves.filter(function (m) { return !m.notRecommended; }).map(function (m) { return m.id; });
  }

  function buildSrc(view) {
    var q = new URLSearchParams();
    q.set("theme", state.theme);
    if (view === "work") q.set("replay", "off");
    if (state.on.length) q.set("m", state.on.join(","));
    if (state.scene[view]) q.set("scene", state.scene[view]);
    return FRAME_SRC[view] + "?" + q.toString();
  }

  function sendToFrames(message) {
    Object.keys(frames).forEach(function (v) {
      if (frames[v].contentWindow) frames[v].contentWindow.postMessage(message, "*");
    });
  }

  /** Sends a moment only to the view on screen: the other frame has none of it to play. */
  function sendToView(message) {
    frames[state.view].contentWindow.postMessage(message, "*");
  }

  /** Keeps the address in step, so a state of the study can be shared by its link. */
  function writeAddress() {
    var q = new URLSearchParams();
    if (state.view !== "work") q.set("view", state.view);
    if (state.theme !== "whitehaven") q.set("theme", state.theme);
    if (state.on.length) q.set("m", state.on.join(","));
    history.replaceState(null, "", location.pathname + (q.toString() ? "?" + q.toString() : ""));
  }

  function setMoves(ids) {
    state.on = ids;
    sendToFrames({ moves: ids });
    drawSwitches();
    writeAddress();
  }

  function toggleMove(id) {
    setMoves(state.on.indexOf(id) === -1 ? state.on.concat(id) : state.on.filter(function (x) { return x !== id; }));
  }

  function setView(view) {
    state.view = view;
    Object.keys(frames).forEach(function (v) { frames[v].classList.toggle("is-on", v === view); });
    document.querySelectorAll("[data-view]").forEach(function (b) { b.classList.toggle("is-on", b.dataset.view === view); });
    document.querySelectorAll(".mv-act[data-for]").forEach(function (b) { b.hidden = b.dataset.for !== view; });
    writeAddress();
    frames[view].focus();
  }

  function setTheme(theme) {
    state.theme = theme;
    root.dataset.theme = theme;
    sendToFrames({ theme: theme });
    document.querySelectorAll(".p-theme").forEach(function (b) { b.classList.toggle("is-on", b.dataset.theme === theme); });
    writeAddress();
  }

  function drawSwitches() {
    document.querySelectorAll(".mv").forEach(function (row) {
      var on = state.on.indexOf(row.dataset.id) !== -1;
      row.classList.toggle("is-on", on);
      row.querySelector(".tg").setAttribute("aria-checked", on);
    });
    var all = readRecommended();
    var isAll = all.every(function (id) { return state.on.indexOf(id) !== -1; });
    document.getElementById("all").setAttribute("aria-checked", isAll);
  }

  function reloadFrame(view) {
    frames[view].src = buildSrc(view);
  }

  function drawPanel() {
    var list = document.getElementById("list");
    list.innerHTML = STUDY.moves.map(function (m) {
      var acts = (m.go || []).map(function (g, i) { return '<button class="mv-act" data-go="' + i + '">' + g.label + "</button>"; })
        .concat((m.plays || []).map(function (p) { return '<button class="mv-act" data-play="' + p.name + '"' + (p.view ? ' data-for="' + p.view + '"' : "") + ">" + p.label + "</button>"; }))
        .join("");
      var hour = m.hour ? '<div class="mv-hour"><input type="range" min="0" max="24" step="0.25" aria-label="Hour of the day"><span><i id="hour-word" style="font-style:normal"></i><button data-now>Now</button></span></div>' : "";
      return '<div class="mv" data-id="' + m.id + '"><div class="mv-top"><span class="mv-name">' + m.name + (m.keep ? '<small class="mv-keep">Keep</small>' : "") + '</span><button class="tg" role="switch" aria-checked="false" aria-label="' + m.name + '"></button></div><p>' + m.text + "</p>" + (acts ? '<div class="mv-acts">' + acts + "</div>" : "") + hour + "</div>";
    }).join("");

    var themes = document.getElementById("themes");
    themes.innerHTML = THEMES.map(function (t) { return '<button class="p-theme" data-theme="' + t[0] + '" title="' + t[0] + '" aria-label="Theme ' + t[0] + '" style="background:' + t[1] + '"></button>'; }).join("");
  }

  function writeHourWord(value) {
    var h = Math.floor(value) % 24;
    var m = Math.round((value - Math.floor(value)) * 60);
    document.getElementById("hour-word").textContent = String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
  }

  /** Runs a row's button: a scene, a scroll, or a moment. Turns the move on first, or there is nothing to see. */
  function act(row, button) {
    var id = row.dataset.id;
    if (state.on.indexOf(id) === -1) toggleMove(id);
    var move = STUDY.moves.filter(function (m) { return m.id === id; })[0];
    if (button.dataset.go !== undefined) {
      var go = move.go[Number(button.dataset.go)];
      if (go.scene) { state.scene[state.view] = go.scene[state.view]; reloadFrame(state.view); }
      if (go.scroll) sendToView({ scrollTo: go.scroll });
      return;
    }
    if (button.dataset.play) sendToView({ play: { id: id, name: button.dataset.play } });
  }

  function start() {
    root.dataset.theme = state.theme;
    drawPanel();
    var host = document.getElementById("frames");
    ["work", "inbox"].forEach(function (v) {
      var f = document.createElement("iframe");
      f.title = v;
      f.src = buildSrc(v);
      host.appendChild(f);
      frames[v] = f;
    });

    document.getElementById("panel").addEventListener("click", function (e) {
      var view = e.target.closest("[data-view]");
      if (view) return setView(view.dataset.view);
      var theme = e.target.closest(".p-theme");
      if (theme) return setTheme(theme.dataset.theme);
      if (e.target.closest("#all")) {
        var all = readRecommended();
        var isAll = all.every(function (id) { return state.on.indexOf(id) !== -1; });
        return setMoves(isAll ? [] : all);
      }
      if (e.target.closest("[data-hide]")) return togglePanel();
      if (e.target.closest("#calm")) {
        state.motion = state.motion ? "" : "reduced";
        e.target.closest("#calm").setAttribute("aria-checked", !!state.motion);
        return sendToFrames({ motion: state.motion });
      }
      if (e.target.closest("[data-now]")) {
        sendToFrames({ play: { id: "clear", name: "hour", value: null } });
        var d = new Date();
        var range = document.querySelector(".mv-hour input");
        range.value = d.getHours() + d.getMinutes() / 60;
        return writeHourWord(Number(range.value));
      }
      var row = e.target.closest(".mv");
      if (!row) return;
      var button = e.target.closest(".mv-act");
      if (button) return act(row, button);
      if (e.target.closest(".mv-hour")) return;
      toggleMove(row.dataset.id);
    });
    document.getElementById("panel").addEventListener("input", function (e) {
      if (!e.target.matches(".mv-hour input")) return;
      sendToFrames({ play: { id: "clear", name: "hour", value: Number(e.target.value) } });
      writeHourWord(Number(e.target.value));
    });
    document.getElementById("tab").addEventListener("click", togglePanel);
    var hold = document.getElementById("clean");
    hold.addEventListener("pointerdown", function () { showClean(true); });
    ["pointerup", "pointerleave", "pointercancel"].forEach(function (type) {
      hold.addEventListener(type, function () { showClean(false); });
    });

    // The frames forward these keys when the board has focus, so they work wherever the focus is.
    window.addEventListener("message", function (e) {
      if (!e.data || !e.data.studyKey) return;
      handleKey(e.data.studyKey, e.data.down);
    });
    window.addEventListener("keydown", function (e) { handleKey(e.key, true); });
    window.addEventListener("keyup", function (e) { handleKey(e.key, false); });

    var now = new Date();
    var range = document.querySelector(".mv-hour input");
    range.value = now.getHours() + now.getMinutes() / 60;
    writeHourWord(Number(range.value));
    drawSwitches();
    setTheme(state.theme);
    setView(state.view);
  }

  function togglePanel() {
    document.getElementById("panel").classList.toggle("is-away");
  }

  var showingClean = false;

  /** Holding Option, or the button, shows the clean build in place. Letting go brings the moves back. */
  function handleKey(key, down) {
    if (key === "\\" && down) return togglePanel();
    if (key === "Alt") showClean(down);
  }

  function showClean(down) {
    if (down === showingClean) return;
    showingClean = down;
    var hold = document.getElementById("clean");
    hold.classList.toggle("is-held", down);
    hold.firstChild.textContent = down ? "This is the clean build" : "Hold to see the clean build";
    sendToFrames({ moves: down ? [] : state.on });
  }

  start();
})();
