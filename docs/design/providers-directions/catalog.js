// PROTOTYPE - the interactive "Add models" sheet. Type to search every model your accounts offer
// (531, OpenRouter's 466 included); filter by vendor on the left; each row has one switch per
// vendor that offers the model, so GLM 5.3 can come from Z.ai, OpenCode Go and OpenRouter at
// once. Save writes the picks into variant D's state; in A to C it only closes.
(function () {
  var W = World, mark = Pv.mark, icon = Crew.icon;
  var FAMILY_ORDER = ["Claude", "GPT", "GLM", "Kimi", "Qwen", "DeepSeek", "MiniMax", "Gemini", "Grok", "Mistral", "Llama", "Others"];
  var SHORT = { anthropic: "Anthropic", openai: "OpenAI", zai: "Z.ai", opencode: "OpenCode Go", openrouter: "OpenRouter" };
  var c; // the open catalog's state

  /**
   * Returns the sources that offer a model, in the order of the side list. A source is a vendor
   * in round 1 (variant D) and an account of one wallet in round 2.
   */
  function vendorsOf(m) {
    return c.sources.filter(function (s) { return s.offers(m); }).map(function (s) { return s.id; });
  }
  function source(id) { return c.sources.filter(function (s) { return s.id === id; })[0]; }

  /** Returns the vendors as sources, for variant D. */
  function vendorSources() {
    return W.vendorsInUse().map(function (v) {
      return {
        id: v, short: SHORT[v], mark: W.VENDORS[v].mark,
        offers: function (m) { return m.from.some(function (f) { var a = W.account(f[0]); return a && a.vendor === v; }); },
      };
    });
  }

  function isOn(v, id) { return c.sel[v].indexOf(id) !== -1; }

  /** Returns how many switches differ from what was saved, and a few of them in words. */
  function changes() {
    var list = [];
    c.sources.forEach(function (s) {
      var v = s.id;
      var before = c.before[v], after = c.sel[v];
      after.forEach(function (id) { if (before.indexOf(id) === -1) list.push("+ " + W.catalogModel(id).name + " from " + s.short); });
      before.forEach(function (id) { if (after.indexOf(id) === -1) list.push("− " + W.catalogModel(id).name + " from " + s.short); });
    });
    return list;
  }

  function highlight(name) {
    if (!c.q) return name;
    var out = name;
    c.q.split(/\s+/).filter(Boolean).forEach(function (t) {
      var i = out.toLowerCase().indexOf(t);
      if (i !== -1 && out.indexOf("<") === -1) out = out.slice(0, i) + "<mark>" + out.slice(i, i + t.length) + "</mark>" + out.slice(i + t.length);
    });
    return out;
  }

  function row(m) {
    var vs = vendorsOf(m).filter(function (v) { return !c.vendor || v === c.vendor; });
    var anyOn = vs.some(function (v) { return isOn(v, m.id); });
    var meta = [m.meta].concat(m.caps || []).filter(Boolean).join(" · ");
    if (m.tail && m.price) meta += (meta ? " · " : "") + m.price + " per M tokens";
    var chips = vs.map(function (v) {
      var on = isOn(v, m.id);
      var s = source(v);
      return '<button class="cat-src' + (on ? " is-on" : "") + '" data-src="' + v + "|" + m.id + '" title="' + (on ? "Shown from " : "Show from ") + s.short + '"><span class="vb-box">' + (on ? icon("check", 9) : "") + "</span>" + mark(s.mark, 12) + s.short + "</button>";
    }).join("");
    return (
      '<div class="cat-row' + (anyOn ? " is-on" : "") + '">' +
      '<span class="cat-t"><b>' + highlight(m.name) + (m.tier ? ' <span class="cat-tier">' + m.tier + "</span>" : "") + "</b>" +
      "<small>" + (meta || m.slug) + "</small></span>" +
      '<span class="cat-srcs">' + chips + "</span>" +
      "</div>"
    );
  }

  function list() {
    var pool = W.CATALOG.filter(function (m) { var vs = vendorsOf(m); return vs.length && (!c.vendor || vs.indexOf(c.vendor) !== -1); });
    if (c.mode === "chosen") pool = pool.filter(function (m) { return vendorsOf(m).some(function (v) { return isOn(v, m.id); }); });
    if (c.q) pool = pool.filter(function (m) { return Pv.D.matches(m, c.q); });
    if (!pool.length) {
      return '<div class="cat-empty"><b>No model matches "' + c.q + '"</b><span>Try a family name such as glm, kimi or gemini, or look in All models.</span></div>';
    }
    var cap = c.q ? 120 : 9999;
    var shownCount = 0;
    var html = FAMILY_ORDER.map(function (f) {
      var fam = pool.filter(function (m) { return m.family === f; });
      if (!fam.length) return "";
      var collapse = c.mode === "newest" && !c.q && !c.expanded[f];
      var visible = collapse ? fam.filter(function (m) { return !m.older; }).slice(0, 4) : fam;
      // A picked model always shows, even when it is older.
      if (collapse) fam.forEach(function (m) { if (visible.indexOf(m) === -1 && vendorsOf(m).some(function (v) { return isOn(v, m.id); })) visible.push(m); });
      visible = visible.slice(0, Math.max(0, cap - shownCount));
      shownCount += visible.length;
      var hidden = fam.length - visible.length;
      return (
        '<div class="ov-fam">' + f + " <small>" + fam.length + "</small></div>" +
        visible.map(row).join("") +
        (hidden > 0 && collapse ? '<button class="ov-older cat-more" data-expand="' + f + '">' + icon("chev-r", 12) + hidden + " more " + f + " model" + (hidden > 1 ? "s" : "") + "</button>" : "")
      );
    }).join("");
    if (c.q && pool.length > cap) html += '<p class="ov-count">' + (pool.length - cap) + " more match. Type a little more to narrow it.</p>";
    return html;
  }

  function side() {
    return (
      '<button class="line' + (c.vendor ? "" : " is-on") + '" data-vendor="">' + icon("list", 14) + '<span class="grow">All models</span><span class="line-note">' + total() + "</span></button>" +
      '<div class="ov-group" style="margin:12px 6px 4px">FROM</div>' +
      c.sources.map(function (s) {
        var n = W.CATALOG.filter(s.offers).length;
        return '<button class="line' + (c.vendor === s.id ? " is-on" : "") + '" data-vendor="' + s.id + '">' + mark(s.mark, 14) + '<span class="grow">' + s.short + '</span><span class="line-note">' + n + "</span></button>";
      }).join("")
    );
  }

  function foot() {
    var ch = changes();
    var note = ch.length ? ch.slice(0, 2).join(", ") + (ch.length > 2 ? ", and " + (ch.length - 2) + " more" : "") : "Tick " + (c.noun === "account" ? "an account" : "a vendor") + " on a row to show that model from it.";
    return (
      '<span class="note cat-note">' + note + "</span><span class=\"spacer\"></span>" +
      '<button class="btn" data-cat-close>Cancel</button>' +
      '<button class="btn btn--accent" data-cat-save' + (ch.length ? "" : " disabled") + ">" + (ch.length ? "Save " + ch.length + " change" + (ch.length > 1 ? "s" : "") : "Save") + "</button>"
    );
  }

  function total() {
    return W.CATALOG.filter(function (m) { return vendorsOf(m).length; }).length;
  }

  function placeholder() {
    var n = c.vendor ? W.CATALOG.filter(source(c.vendor).offers).length : total();
    return "Search " + n + " models" + (c.vendor ? " from " + source(c.vendor).short : "");
  }

  function draw(host) {
    host.innerHTML =
      '<div class="ov-scrim" data-cat-scrim>' +
      '<div class="ov pop ov--wide" role="dialog" aria-label="Add models">' +
      '<div class="ov-h">' + (c.monogram || "") + "<h2>" + c.title + '</h2><span class="ov-step">' + c.sub + "</span>" +
      '<button class="icon-btn" data-cat-close title="Close">' + icon("close") + "</button></div>" +
      '<div class="ov-cat"><div class="ov-cat-side" data-side>' + side() + "</div>" +
      '<div class="ov-cat-main" data-main>' +
      '<div class="ov-search"><label class="field">' + icon("search", 14) + '<input class="ov-input" style="background:none" data-cat-q placeholder="' + placeholder() + '" value="' + c.q + '" /></label>' +
      '<div class="seg" data-seg-cat>' +
      [["newest", "Newest"], ["all", "All"], ["chosen", "Picked"]].map(function (s) { return '<button data-mode="' + s[0] + '" aria-pressed="' + (c.mode === s[0]) + '">' + s[1] + "</button>"; }).join("") +
      "</div></div>" +
      '<div data-list>' + list() + "</div>" +
      "</div></div>" +
      '<div class="ov-f" data-foot>' + foot() + "</div>" +
      "</div></div>";
    wire(host);
  }

  /** Redraws the parts that change without touching the search field, so typing never loses focus. */
  function refresh(host) {
    host.querySelector("[data-list]").innerHTML = list();
    host.querySelector("[data-foot]").innerHTML = foot();
    host.querySelector("[data-side]").innerHTML = side();
    host.querySelectorAll("[data-seg-cat] button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.mode === c.mode)); });
    host.querySelector("[data-cat-q]").placeholder = placeholder();
    wireDynamic(host);
  }

  function wireDynamic(host) {
    host.querySelectorAll("[data-src]").forEach(function (b) {
      b.addEventListener("click", function () {
        var p = b.dataset.src.split("|");
        var l = c.sel[p[0]];
        var i = l.indexOf(p[1]);
        if (i === -1) l.push(p[1]);
        else l.splice(i, 1);
        refresh(host);
      });
    });
    host.querySelectorAll("[data-expand]").forEach(function (b) {
      b.addEventListener("click", function () { c.expanded[b.dataset.expand] = true; refresh(host); });
    });
    host.querySelectorAll("[data-vendor]").forEach(function (b) {
      b.addEventListener("click", function () { c.vendor = b.dataset.vendor || null; c.expanded = {}; refresh(host); host.querySelector("[data-main]").scrollTop = 0; });
    });
    host.querySelectorAll("[data-cat-close]").forEach(function (b) { b.addEventListener("click", close); });
    var save = host.querySelector("[data-cat-save]");
    if (save) save.addEventListener("click", function () {
      if (c.write) c.write(c.sel);
      else if (c.onSave) W.vendorsInUse().forEach(function (v) { Pv.D.state.shown[v] = c.sel[v].slice(); });
      if (c.onSave) c.onSave();
      close();
    });
  }

  function wire(host) {
    var q = host.querySelector("[data-cat-q]");
    q.addEventListener("input", function () { c.q = q.value.trim().toLowerCase(); refresh(host); });
    host.querySelectorAll("[data-mode]").forEach(function (b) {
      b.addEventListener("click", function () { c.mode = b.dataset.mode; refresh(host); });
    });
    host.querySelector("[data-cat-scrim]").addEventListener("click", function (e) { if (e.target === e.currentTarget) close(); });
    wireDynamic(host);
    if (window.top === window) q.focus();
  }

  var host;
  function close() {
    if (host) host.innerHTML = "";
    c = null;
  }

  /**
   * Opens the catalog. `opts.vendor` filters to one vendor; `opts.q` starts a search;
   * `opts.onSave` runs after a save has written the picks into variant D's state.
   */
  Pv.openCatalog = function (opts) {
    opts = opts || {};
    if (!host) {
      host = document.createElement("div");
      document.body.appendChild(host);
    }
    var sel = {}, before = {};
    var sources = opts.sources || vendorSources();
    sources.forEach(function (s) {
      var v = s.id;
      var from = opts.selected ? (opts.selected[v] || []) : opts.onSave ? (Pv.D.state.shown[v] || []) : W.MENU.filter(function (e) { return W.account(e.account).vendor === v; }).map(function (e) { return e.model; });
      sel[v] = from.slice();
      before[v] = from.slice();
    });
    c = {
      vendor: opts.vendor || null, q: opts.q || "", mode: "newest", expanded: {}, sel: sel, before: before,
      onSave: opts.onSave, write: opts.write, sources: sources,
      noun: opts.noun || "vendor",
      title: opts.title || "Add models", sub: opts.sub || "Every model your accounts offer", monogram: opts.monogram,
    };
    draw(host);
  };
  Pv.closeCatalog = close;
})();
