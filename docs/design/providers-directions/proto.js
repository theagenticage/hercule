// PROTOTYPE - the switcher: renders the chosen variant into the Settings frame, opens a sheet
// when ?sheet= names one, and draws the floating bar (variant, moment, sheet, theme, notes).
// The bar is the prototype's own chrome, never part of the design.
//
// URL: ?variant=a|b|c|d (d, the pick, is the default)  ?state=ready|failed|expiring|empty  ?sheet=<name>  ?theme=<theme>  ?notes=1
// Keys: ← and → cycle the variants (not while typing).
(function () {
  var params = new URLSearchParams(location.search);
  // Round 3 (profiles) is the default; rounds 1 and 2 stay one step away in the bar.
  var ROUNDS = { 1: ["a", "b", "c", "d"], 2: ["e", "f", "g"], 3: ["i", "h"] };
  var asked = params.get("variant");
  var round = ROUNDS[1].indexOf(asked) !== -1 ? 1 : ROUNDS[2].indexOf(asked) !== -1 ? 2 : 3;
  var KEYS = ROUNDS[round];
  var variant = KEYS.indexOf(asked) !== -1 ? asked : KEYS[0];
  Pv.currentVariant = variant;
  var STATES = [
    ["ready", "Ready: Work not yet on build-box-2"],
    ["failed", "Failed: Z.ai refused its key"],
    ["expiring", "Expiring: token ends in 12 days"],
    ["empty", "Empty: no account yet"],
    ["single", "One profile: no tabs"],
  ];
  var SHEETS = [
    ["", "No sheet"],
    ["add-account", "Add an account: who pays"],
    ["add-anthropic", "Add Anthropic: how to sign in"],
    ["add-openai", "Add OpenAI: how to sign in"],
    ["browser", "Signing in: paste the code"],
    ["added", "Added: pick its models"],
    ["relay", "Sign in on build-box-2"],
    ["relay-openai", "Sign in on a machine, device code"],
    ["renew", "Renew a long-lived token"],
    ["replace-key", "Replace a refused key"],
    ["catalog", "Add models: the catalog"],
    ["catalog-openrouter", "Add models: 466 from OpenRouter"],
  ];
  var THEMES = [["whitehaven", "Whitehaven"], ["styles", "Styles"], ["orient-express", "Orient Express"], ["nile", "Nile"], ["end-house", "End House"]];

  /** Replaces one URL parameter and reloads, so every view has a link of its own. */
  function go(key, value) {
    var p = new URLSearchParams(location.search);
    if (value) p.set(key, value);
    else p.delete(key);
    location.search = p.toString();
  }

  function render() {
    var v = Pv.variants[variant];
    var body = document.getElementById("pv-body");
    var top = body.scrollTop;
    body.innerHTML = v.render(body);
    body.scrollTop = top;
    var action = document.getElementById("pv-action");
    action.innerHTML = v.headerAction ? v.headerAction() : "";
    if (v.wire) v.wire(body, render);
    wireSheets(document);
  }

  /** Makes every [data-sheet] control open its sheet in place. */
  function wireSheets(root) {
    root.querySelectorAll("[data-sheet]").forEach(function (el) {
      if (el.dataset.wired) return;
      el.dataset.wired = "1";
      el.addEventListener("click", function (ev) {
        ev.stopPropagation();
        Pv.openSheet(el.dataset.sheet);
      });
    });
  }
  Pv.wireSheets = wireSheets;
  Pv.rerender = render;

  function bar() {
    var el = document.createElement("div");
    el.className = "proto-bar";
    var v = Pv.variants[variant];
    var state = World.state;
    var theme = document.documentElement.dataset.theme;
    el.innerHTML =
      '<span class="proto-tag">PROTOTYPE</span>' +
      '<button data-step="-1" title="Previous variant (←)">‹</button>' +
      '<span class="proto-v"><b>' + v.key.toUpperCase() + "</b> · " + v.name + "</span>" +
      '<button data-step="1" title="Next variant (→)">›</button>' +
      '<span class="proto-sep"></span>' +
      '<select name="round" title="round">' + [["3", "Round 3: profiles"], ["2", "Round 2: wallets"], ["1", "Round 1"]].map(function (o) { return '<option value="' + o[0] + '"' + (String(round) === o[0] ? " selected" : "") + ">" + o[1] + "</option>"; }).join("") + "</select>" +
      select("state", STATES, state) +
      select("sheet", SHEETS, params.get("sheet") || "") +
      select("theme", THEMES, theme) +
      '<span class="proto-sep"></span>' +
      '<a class="proto-link" href="composer.html' + location.search + '"><button>Composer ↗</button></a>' +
      '<button data-notes>Notes</button>';
    document.body.appendChild(el);
    el.querySelectorAll("[data-step]").forEach(function (b) {
      b.addEventListener("click", function () { step(Number(b.dataset.step)); });
    });
    el.querySelectorAll("select").forEach(function (s) {
      s.addEventListener("change", function () {
        if (s.name === "round") go("variant", ROUNDS[s.value][0]);
        else go(s.name, s.value);
      });
    });
    el.querySelector("[data-notes]").addEventListener("click", function () { go("notes", params.get("notes") ? "" : "1"); });
  }

  function select(name, options, current) {
    return '<select name="' + name + '" title="' + name + '">' + options.map(function (o) {
      return '<option value="' + o[0] + '"' + (o[0] === current ? " selected" : "") + ">" + o[1] + "</option>";
    }).join("") + "</select>";
  }

  function step(d) {
    var i = (KEYS.indexOf(variant) + d + KEYS.length) % KEYS.length;
    go("variant", KEYS[i]);
  }

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      Pv.closeSheet();
      Pv.closeCatalog();
      if (Pv.closeAccount) Pv.closeAccount();
      if (Pv.closeBrowser) Pv.closeBrowser();
      return;
    }
    var t = e.target;
    if (t.closest && t.closest("input, textarea, select, [contenteditable]")) return;
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
  });

  function boot() {
    // A failed account puts the one warning dot on the Providers row of the Settings list.
    if (World.ACCOUNTS.some(function (a) { return a.failed; })) {
      var row = Array.prototype.find.call(document.querySelectorAll(".set-nav .nav-row"), function (r) { return r.textContent.trim() === "Providers"; });
      if (row) row.insertAdjacentHTML("beforeend", '<i class="dot dot--fail" title="Z.ai refused its key"></i>');
    }
    render();
    bar();
    if (params.get("sheet")) Pv.openSheet(params.get("sheet"));
    if (params.get("notes") && Pv.notes) Pv.notes();
    document.documentElement.dataset.ready = "1";
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
