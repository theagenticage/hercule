// PROTOTYPE - the model browser: a dialog for an account with a big catalog (OpenRouter's 466).
// A small catalog gets the quick popover instead; every popover links here too. Search, filter
// by maker, by what a model can do, by context and by price, sort, and collect what to add in a
// tray at the foot; nothing changes until "Add".
//
// The facts per model (maker, context, price, release, tools, images, reasoning) are made up
// for the fixture, shaped like OpenRouter's `GET /api/v1/models` (research/model-catalogs.md).
(function () {
  var W = World, mark = Pv.mark, icon = Crew.icon;
  var MAKER = { Claude: "Anthropic", GPT: "OpenAI", GLM: "Z.ai", Kimi: "Moonshot", Qwen: "Qwen", DeepSeek: "DeepSeek", MiniMax: "MiniMax", Gemini: "Google", Grok: "xAI", Mistral: "Mistral", Llama: "Meta", Others: "Others" };
  var MAKERS = ["Anthropic", "OpenAI", "Google", "xAI", "Meta", "Mistral", "Qwen", "DeepSeek", "Z.ai", "Moonshot", "MiniMax", "Others"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var b; // the open browser's state
  var host;

  /** Returns a model's facts for the browser, derived once and kept on the model. */
  function facts(m) {
    if (m._f) return m._f;
    var h = Crew.hash(m.id);
    var ctxText = (m.meta || "").match(/(\d+)(K|M) context/);
    var ctx = ctxText ? Number(ctxText[1]) * (ctxText[2] === "M" ? 1000 : 1) : [128, 200, 256, 400][h % 4];
    var priceText = (m.price || "").match(/\$([\d.]+) \/ \$([\d.]+)/);
    var pin = priceText ? Number(priceText[1]) : Math.round(((h % 90) / 18 + 0.1) * 100) / 100;
    var pout = priceText ? Number(priceText[2]) : Math.round(pin * 4 * 100) / 100;
    if (/\(free\)/.test(m.name)) { pin = 0; pout = 0; }
    var age = m.fresh ? 3 : m.newest ? 10 + (h % 70) : m.older ? 120 + (h % 420) : 40 + (h % 200);
    var date = new Date(2026, 9, 30 - age);
    m._f = {
      maker: MAKER[m.family] || "Others", ctx: ctx, pin: pin, pout: pout, age: age,
      released: age < 31 ? age + " days ago" : MONTHS[date.getMonth()] + " " + date.getFullYear(),
      tools: !m.tail || h % 6 !== 0,
      images: (m.caps || []).indexOf("Images") !== -1 || (m.tail && h % 3 === 0),
      reasoning: (m.caps || []).indexOf("Effort") !== -1 || (m.tail && h % 2 === 0),
    };
    return m._f;
  }

  function ctxWords(k) { return k >= 1000 ? k / 1000 + "M" : k + "K"; }
  function money(n) { return n === 0 ? "free" : "$" + (n < 1 ? n.toFixed(2) : n % 1 ? n.toFixed(2) : String(n)); }

  function pool() {
    return Pv.R.offersOf(b.account.id);
  }

  function filtered() {
    var q = b.q.trim().toLowerCase();
    var list = pool().filter(function (m) {
      var f = facts(m);
      if (q && !Pv.D.matches(m, q) && f.maker.toLowerCase().indexOf(q) === -1) return false;
      if (b.makers.length && b.makers.indexOf(f.maker) === -1) return false;
      if (b.can.tools && !f.tools) return false;
      if (b.can.images && !f.images) return false;
      if (b.can.reasoning && !f.reasoning) return false;
      if (f.ctx < b.ctx) return false;
      if (b.price && f.pin > b.price) return false;
      return true;
    });
    var by = {
      newest: function (x, y) { return facts(x).age - facts(y).age; },
      price: function (x, y) { return facts(x).pin - facts(y).pin; },
      context: function (x, y) { return facts(y).ctx - facts(x).ctx; },
      name: function (x, y) { return x.name.localeCompare(y.name); },
    }[b.sort];
    return list.sort(by);
  }

  function isIn(id) { return b.inMenu.indexOf(id) !== -1; }
  function tray() { return b.add.concat(b.out); }

  function facet(title, body) {
    return '<div class="mb-facet"><h4>' + title + "</h4>" + body + "</div>";
  }

  function side() {
    var counts = {};
    pool().forEach(function (m) { var k = facts(m).maker; counts[k] = (counts[k] || 0) + 1; });
    var makers = MAKERS.filter(function (k) { return counts[k]; }).map(function (k) {
      var on = b.makers.indexOf(k) !== -1;
      return '<label class="mb-check"><span class="choice-box"><input type="checkbox" data-maker="' + k + '"' + (on ? " checked" : "") + " />" + icon("check", 10) + "</span><span>" + k + "</span><small>" + counts[k] + "</small></label>";
    }).join("");
    var can = [["tools", "Use tools"], ["images", "Read images"], ["reasoning", "Reason"]].map(function (c) {
      return '<label class="mb-check"><span class="choice-box"><input type="checkbox" data-can="' + c[0] + '"' + (b.can[c[0]] ? " checked" : "") + " />" + icon("check", 10) + "</span><span>" + c[1] + "</span></label>";
    }).join("");
    var ctx = '<div class="seg mb-seg">' + [[0, "Any"], [200, "200K+"], [400, "400K+"], [1000, "1M"]].map(function (c) {
      return '<button data-ctx="' + c[0] + '" aria-pressed="' + (b.ctx === c[0]) + '">' + c[1] + "</button>";
    }).join("") + "</div>";
    var price = '<div class="seg mb-seg">' + [[0, "Any"], [1, "< $1"], [5, "< $5"]].map(function (c) {
      return '<button data-price="' + c[0] + '" aria-pressed="' + (b.price === c[0]) + '">' + c[1] + "</button>";
    }).join("") + '</div><small class="mb-note">per million input tokens</small>';
    return facet("Made by", makers) + facet("Can", can) + facet("Context", ctx) + facet("Price", price) +
      (b.makers.length || b.can.tools || b.can.images || b.can.reasoning || b.ctx || b.price ? '<button class="pv-link mb-clear" data-clear>Clear filters</button>' : "");
  }

  function rows() {
    var list = filtered();
    var shown = list.slice(0, b.limit);
    var head =
      '<div class="mb-th"><span>' + list.length + " model" + (list.length === 1 ? "" : "s") + "</span>" +
      sortHead("context", "Context") + sortHead("price", "In / out per M") + sortHead("newest", "Released") + "<span></span></div>";
    if (!list.length) return head + '<div class="cat-empty"><b>No model matches</b><span>Loosen a filter, or search for a maker such as google or meta.</span></div>';
    return head + shown.map(function (m) {
      var f = facts(m);
      var inMenu = isIn(m.id);
      var adding = b.add.indexOf(m.id) !== -1;
      var removing = b.out.indexOf(m.id) !== -1;
      var state = adding ? "is-adding" : removing ? "is-removing" : inMenu ? "is-in" : "";
      var btn = adding || (inMenu && !removing)
        ? '<button class="mb-act is-on" data-toggle="' + m.id + '" title="' + (adding ? "Will be added; click to undo" : "In the menu; click to take out") + '">' + icon("check", 13) + "</button>"
        : '<button class="mb-act" data-toggle="' + m.id + '" title="Add to the menu">' + icon("plus", 13) + "</button>";
      return (
        '<div class="mb-row ' + state + '">' +
        '<span class="mb-name"><b>' + m.name + (m.fresh ? '<span class="pk-new">New</span>' : "") + "</b><small>" + f.maker + " · " + (m.tail ? m.slug : m.slug) +
        (f.tools ? "" : " · no tools") + (f.images ? " · images" : "") + (f.reasoning ? " · reasons" : "") + "</small></span>" +
        '<span class="mb-num">' + ctxWords(f.ctx) + "</span>" +
        '<span class="mb-num">' + money(f.pin) + ' <i>/</i> ' + money(f.pout) + "</span>" +
        '<span class="mb-num mb-date">' + f.released + "</span>" +
        btn +
        "</div>"
      );
    }).join("") +
    (list.length > shown.length ? '<button class="pk-more mb-more" data-more>' + icon("chev-d", 11) + "Show " + Math.min(100, list.length - shown.length) + " more of " + (list.length - shown.length) + "</button>" : "");
  }

  function sortHead(key, label) {
    return '<button class="mb-sort' + (b.sort === key ? " is-on" : "") + '" data-sort="' + key + '">' + label + (b.sort === key ? icon("chev-d", 10) : "") + "</button>";
  }

  function foot() {
    var t = tray();
    var chips = b.add.map(function (id) { return '<span class="mb-chip">' + icon("plus", 10) + W.catalogModel(id).name + '<button data-untray="' + id + '">' + icon("close", 9) + "</button></span>"; }).join("") +
      b.out.map(function (id) { return '<span class="mb-chip mb-chip--out">' + icon("minus", 10) + W.catalogModel(id).name + '<button data-untray="' + id + '">' + icon("close", 9) + "</button></span>"; }).join("");
    return (
      '<div class="mb-tray">' + (t.length ? chips : '<span class="faint">Pick models with + . They join ' + b.profile.name + "'s menu at the end of " + W.accountName(b.account) + "'s part.</span>") + "</div>" +
      '<button class="btn" data-mb-close>Cancel</button>' +
      '<button class="btn btn--accent" data-mb-save' + (t.length ? "" : " disabled") + ">" + (b.add.length && !b.out.length ? "Add " + b.add.length + " to " + b.profile.name : t.length ? "Save " + t.length + " change" + (t.length > 1 ? "s" : "") : "Add") + "</button>"
    );
  }

  function draw() {
    var a = b.account;
    host.innerHTML =
      '<div class="ov-scrim" data-mb-scrim><div class="ov pop mb" role="dialog" aria-label="Browse ' + W.accountName(a) + ' models">' +
      '<div class="mb-h"><span class="pv-mk">' + mark(W.VENDORS[a.vendor].mark, 16) + '</span><span class="mb-t"><b>' + W.accountName(a) + "</b><small>" + a.models + " models · for " + b.profile.name + "</small></span>" +
      '<label class="field mb-search">' + icon("search", 15) + '<input data-mb-q placeholder="Search by name, maker or id" value="' + b.q + '" /></label>' +
      '<select class="vd-select mb-sortsel" data-mb-sort>' + [["newest", "Newest first"], ["price", "Cheapest first"], ["context", "Longest context"], ["name", "By name"]].map(function (o) { return '<option value="' + o[0] + '"' + (b.sort === o[0] ? " selected" : "") + ">" + o[1] + "</option>"; }).join("") + "</select>" +
      '<button class="icon-btn" data-mb-close title="Close">' + icon("close") + "</button></div>" +
      '<div class="mb-body"><div class="mb-side" data-mb-side>' + side() + '</div><div class="mb-main" data-mb-main>' + rows() + "</div></div>" +
      '<div class="mb-foot" data-mb-foot>' + foot() + "</div>" +
      "</div></div>";
    wire();
    var q = host.querySelector("[data-mb-q]");
    if (window.top === window) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  }

  /** Redraws everything but the search field, so typing keeps its place. */
  function refresh() {
    host.querySelector("[data-mb-side]").innerHTML = side();
    host.querySelector("[data-mb-main]").innerHTML = rows();
    host.querySelector("[data-mb-foot]").innerHTML = foot();
    wireDynamic();
  }

  function toggleIn(list, id) { var i = list.indexOf(id); if (i === -1) list.push(id); else list.splice(i, 1); }

  function wireDynamic() {
    host.querySelectorAll("[data-maker]").forEach(function (el) { el.addEventListener("change", function () { toggleIn(b.makers, el.dataset.maker); b.limit = 100; refresh(); }); });
    host.querySelectorAll("[data-can]").forEach(function (el) { el.addEventListener("change", function () { b.can[el.dataset.can] = el.checked; refresh(); }); });
    host.querySelectorAll("[data-ctx]").forEach(function (el) { el.addEventListener("click", function () { b.ctx = Number(el.dataset.ctx); refresh(); }); });
    host.querySelectorAll("[data-price]").forEach(function (el) { el.addEventListener("click", function () { b.price = Number(el.dataset.price); refresh(); }); });
    host.querySelectorAll("[data-sort]").forEach(function (el) { el.addEventListener("click", function () { b.sort = el.dataset.sort; host.querySelector("[data-mb-sort]").value = b.sort; refresh(); }); });
    host.querySelectorAll("[data-clear]").forEach(function (el) { el.addEventListener("click", function () { b.makers = []; b.can = {}; b.ctx = 0; b.price = 0; refresh(); }); });
    host.querySelectorAll("[data-more]").forEach(function (el) { el.addEventListener("click", function () { b.limit += 100; refresh(); }); });
    host.querySelectorAll("[data-toggle]").forEach(function (el) {
      el.addEventListener("click", function () {
        var id = el.dataset.toggle;
        if (isIn(id)) toggleIn(b.out, id);
        else toggleIn(b.add, id);
        refresh();
      });
    });
    host.querySelectorAll("[data-untray]").forEach(function (el) {
      el.addEventListener("click", function () {
        var id = el.dataset.untray;
        b.add = b.add.filter(function (x) { return x !== id; });
        b.out = b.out.filter(function (x) { return x !== id; });
        refresh();
      });
    });
    host.querySelectorAll("[data-mb-close]").forEach(function (el) { el.addEventListener("click", close); });
    var save = host.querySelector("[data-mb-save]");
    if (save) save.addEventListener("click", function () { b.onSave(b.add.slice(), b.out.slice()); close(); });
  }

  function wire() {
    var q = host.querySelector("[data-mb-q]");
    q.addEventListener("input", function () { b.q = q.value; b.limit = 100; refresh(); });
    host.querySelector("[data-mb-sort]").addEventListener("change", function (e) { b.sort = e.target.value; refresh(); });
    host.querySelector("[data-mb-scrim]").addEventListener("click", function (e) { if (e.target === e.currentTarget) close(); });
    wireDynamic();
  }

  function close() { if (host) host.innerHTML = ""; b = null; }

  /**
   * Opens the browser for one account of one profile. `inMenu` lists the model ids already in
   * the profile's menu from this account; `onSave(added, removed)` runs on Add.
   */
  Pv.openBrowser = function (opts) {
    if (!host) { host = document.createElement("div"); document.body.appendChild(host); }
    b = {
      account: W.account(opts.accountId), profile: opts.profile, inMenu: opts.inMenu.slice(),
      q: opts.q || "", makers: [], can: {}, ctx: 0, price: 0, sort: "newest", limit: 100,
      add: [], out: [], onSave: opts.onSave,
    };
    draw();
  };
  Pv.closeBrowser = close;
})();
