// PROTOTYPE - the bar over the list: the search with tokens over declared fields, values offered with
// counts, and Narrow, the menus over what the list holds. Both add the same clauses, so they never disagree.
window.Bar = (function () {
  "use strict";
  var K = Kinds, D = Draw;
  var input, chips, menu, field;
  var active = 0, items = [];

  function tokenField(token) { return Object.keys(K.FIELDS).find(function (k) { return K.FIELDS[k].token === token; }); }

  /** Lists what the search offers for what is typed: fields, then a field's values with counts. */
  function suggest(text) {
    var st = App.state;
    var pool = Model.find(st.scope.saved || st.scope.clauses ? st.scope : { saved: "all" }, null);
    var m = /^([a-z]+):(.*)$/i.exec(text);
    if (m && tokenField(m[1].toLowerCase())) {
      var key = tokenField(m[1].toLowerCase()), f = K.FIELDS[key], typed = m[2].toLowerCase();
      if (f.type === "number" || f.type === "duration") {
        var hints = f.type === "number" ? [">100", ">1000", ">10000"] : [">4h", ">1d", ">2d", ">1w"];
        return hints.filter(function (h) { return h.indexOf(typed) === 0 || !typed; }).map(function (h) {
          var n = pool.filter(function (t) { return Model.matchClause(t, { key: key, value: h }); }).length;
          return { kind: "value", key: key, value: h, n: n, label: f.token + ":" + h, hint: f.type === "duration" ? "waiting longer than " + h.slice(1) : "more than " + D.num(h.slice(1)) };
        });
      }
      var counts = new Map();
      pool.forEach(function (t) { var v = Model.readField(t, key); if (v != null && String(v).toLowerCase().indexOf(typed) >= 0) counts.set(v, (counts.get(v) || 0) + 1); });
      return Array.from(counts).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 8).map(function (e) {
        return { kind: "value", key: key, value: e[0], n: e[1], label: f.token + ":" + e[0] };
      });
    }
    var out = [];
    var t = text.toLowerCase();
    Object.keys(K.FIELDS).forEach(function (k) {
      var f = K.FIELDS[k];
      if (t && f.token.indexOf(t) !== 0) return;
      var n = pool.filter(function (x) { return Model.readField(x, k) != null; }).length;
      if (!n) return;
      out.push({ kind: "field", key: k, label: f.token + ":", hint: f.label + (f.type === "duration" ? ", such as >2d" : f.type === "number" ? ", such as >1000" : ""), n: n });
    });
    out = out.slice(0, t ? 6 : 8);
    if (t) out.unshift({ kind: "text", label: text, hint: "in titles and fields" });
    return out;
  }

  function drawMenu() {
    var text = input.value.trim();
    var show = document.activeElement === input;
    if (!show) { menu.hidden = true; return; }
    items = suggest(text);
    if (!items.length) { menu.hidden = true; return; }
    active = Math.min(active, items.length - 1);
    menu.innerHTML = (text ? "" : '<p class="sx-h">Search by a field</p>') + items.map(function (it, i) {
      return '<button type="button" role="option" class="sx-item' + (i === active ? " is-active" : "") + '" data-i="' + i + '">' +
        '<span class="sx-key">' + (it.kind === "text" ? D.icon("search", 14) : it.kind === "field" ? D.icon("filter", 14) : "") + "</span>" +
        "<span class=\"sx-label\">" + (it.kind === "text" ? "“" + D.esc(it.label) + "”" : "<code>" + D.esc(it.label) + "</code>") + (it.hint ? '<small>' + D.esc(it.hint) + "</small>" : "") + "</span>" +
        (it.n != null ? '<span class="sx-n">' + D.num(it.n) + "</span>" : "") + "</button>";
    }).join("") + '<p class="sx-foot"><kbd>↑</kbd><kbd>↓</kbd> choose <kbd>↩</kbd> add <kbd>⌫</kbd> remove the last <kbd>Esc</kbd> close</p>';
    var r = field.getBoundingClientRect();
    menu.style.left = r.left + "px";
    menu.style.top = r.bottom + 6 + "px";
    menu.style.width = r.width + "px";
    menu.hidden = false;
  }

  function pick(it) {
    var st = App.state;
    if (!it) return;
    if (it.kind === "field") { input.value = K.FIELDS[it.key].token + ":"; active = 0; drawMenu(); return; }
    if (it.kind === "value") { st.search.clauses.push({ key: it.key, value: String(it.value) }); input.value = ""; st.search.text = ""; }
    else { st.search.text = it.label; }
    active = 0;
    apply();
    drawMenu();
  }

  function apply() {
    var st = App.state;
    st.focus = null;
    App.render({});
  }

  function drawChips() {
    var st = App.state;
    chips.innerHTML = st.search.clauses.map(function (c, i) {
      var f = K.FIELDS[c.key];
      return '<span class="sx-chip">' + (c.source ? D.mark(c.source, 12) : "") + "<span>" + D.esc(f.token) + ":</span><b>" + D.esc(c.value) + '</b><button type="button" data-unchip="' + i + '" aria-label="Remove ' + D.esc(f.token + ":" + c.value) + '">' + D.icon("close", 10) + "</button></span>";
    }).join("");
    field.classList.toggle("has-chips", st.search.clauses.length > 0);
  }

  function draw(st) {
    drawChips();
    var off = document.getElementById("offline");
    off.hidden = !st.offline;
    if (st.offline) off.textContent = "Offline since 09:12 · moves wait until you’re back";
    document.documentElement.toggleAttribute("data-offline", !!st.offline);
    var scope = document.getElementById("scope-btn");
    if (scope) scope.querySelector("span").textContent = st.search.text || st.search.clauses.length ? "Search" : App.scopeTitle();
    var fail = document.getElementById("failing");
    if (st.failing) {
      fail.hidden = false;
      fail.innerHTML = D.icon("alert", 14) + "<span><b>" + K.SOURCES[st.failing].name + " can’t be read since 08:40.</b> Its things show what it said then, and moves on them wait.</span><a href=\"#\">Connections</a>";
    } else fail.hidden = true;
  }

  function clear(focus) {
    var st = App.state;
    st.search = { text: "", clauses: [] };
    if (input) input.value = "";
    if (focus) apply();
  }

  // ---- Narrow: the facets of what the list holds, as menus ----
  var narrowOpen = null;
  function narrow(button) {
    var pop = document.getElementById("narrow");
    if (!pop.hidden) { pop.hidden = true; return; }
    var st = App.state;
    var things = Model.find(st.scope.triage ? { saved: "all" } : st.scope, st.search);
    var bySource = {};
    things.forEach(function (t) { var s = Model.sourceOf(t); (bySource[s] = bySource[s] || []).push(t); });
    var drawFacets = function () {
      var html = '<p class="menu-h">Narrow what the list holds</p>';
      Object.keys(K.BROWSE).forEach(function (src) {
        if (!bySource[src]) return;
        K.BROWSE[src].forEach(function (f) {
          html += '<button type="button" class="menu-pick nw-f" data-nf="' + src + "|" + f.field + '">' + D.mark(src, 14) + "<span>" + D.esc(K.SOURCES[src].name) + " " + D.esc(K.FIELDS[f.field].label.toLowerCase()) + '</span><small>' + new Set(bySource[src].map(function (t) { return t.fields[f.field]; }).filter(Boolean)).size + "</small>" + D.icon("chevron-right", 12) + "</button>";
        });
      });
      pop.innerHTML = html;
    };
    var drawValues = function (src, fieldKey) {
      var counts = new Map();
      bySource[src].forEach(function (t) { var v = t.fields[fieldKey]; if (v != null) counts.set(v, (counts.get(v) || 0) + 1); });
      pop.innerHTML = '<button type="button" class="menu-pick nw-back" data-nback>' + D.icon("chevron-left", 12) + "<span>" + D.esc(K.SOURCES[src].name) + " " + D.esc(K.FIELDS[fieldKey].label.toLowerCase()) + "</span></button><i class=\"menu-line\"></i>" +
        Array.from(counts).sort(function (a, b) { return b[1] - a[1]; }).map(function (e) {
          return '<button type="button" class="menu-pick" data-nv="' + D.esc(JSON.stringify({ source: src, key: fieldKey, value: e[0] })) + '"><span>' + D.esc(e[0]) + "</span><small>" + D.num(e[1]) + "</small></button>";
        }).join("");
    };
    drawFacets();
    var r = button.getBoundingClientRect();
    pop.style.left = Math.max(8, r.right - 280) + "px";
    pop.style.top = r.bottom + 6 + "px";
    pop.hidden = false;
    pop.onclick = function (e) {
      var f = e.target.closest("[data-nf]");
      if (f) { var p = f.dataset.nf.split("|"); drawValues(p[0], p[1]); return; }
      if (e.target.closest("[data-nback]")) { drawFacets(); return; }
      var v = e.target.closest("[data-nv]");
      if (v) { var c = JSON.parse(v.dataset.nv); App.state.search.clauses.push({ key: c.key, value: String(c.value), source: c.source }); pop.hidden = true; apply(); }
    };
    if (!Motion.isReduced()) Motion.animate(pop, [{ opacity: 0, transform: "translateY(-4px) scale(.98)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" });
  }

  function start() {
    input = document.getElementById("sx-input");
    chips = document.getElementById("sx-chips");
    menu = document.getElementById("sx-menu");
    field = document.getElementById("sx");
    input.addEventListener("focus", function () { field.classList.add("is-focus"); drawMenu(); });
    input.addEventListener("blur", function () { field.classList.remove("is-focus"); setTimeout(function () { if (document.activeElement !== input) menu.hidden = true; }, 120); });
    input.addEventListener("input", function () {
      active = 0;
      var v = input.value;
      if (!/^[a-z]+:/i.test(v)) { App.state.search.text = v.trim(); apply(); }
      drawMenu();
    });
    input.addEventListener("keydown", function (e) {
      var st = App.state;
      if (e.key === "ArrowDown") { active = Math.min(items.length - 1, active + 1); drawMenu(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { active = Math.max(0, active - 1); drawMenu(); e.preventDefault(); }
      else if (e.key === "Enter") { pick(items[active]); e.preventDefault(); }
      else if (e.key === "Backspace" && !input.value && st.search.clauses.length) { st.search.clauses.pop(); apply(); drawMenu(); }
      else if (e.key === "Escape") {
        if (input.value || st.search.clauses.length) { input.value = ""; clear(true); }
        input.blur();
        e.preventDefault();
      }
      e.stopPropagation();
    });
    menu.addEventListener("mousedown", function (e) { e.preventDefault(); });
    menu.addEventListener("click", function (e) { var b = e.target.closest("[data-i]"); if (b) pick(items[+b.dataset.i]); });
    chips.addEventListener("click", function (e) { var b = e.target.closest("[data-unchip]"); if (b) { App.state.search.clauses.splice(+b.dataset.unchip, 1); apply(); } });
    document.getElementById("list-head").addEventListener("click", function (e) { var b = e.target.closest("[data-narrow]"); if (b) narrow(b); });
    var scopeBtn = document.getElementById("scope-btn"), scopePop = document.getElementById("scope-pop");
    scopeBtn.insertAdjacentHTML("beforeend", D.icon("chevron-down", 12));
    Rail.start(scopePop);
    scopeBtn.addEventListener("click", function () {
      var open = scopePop.hidden;
      if (open) { Rail.draw(scopePop, App.state); var r = scopeBtn.getBoundingClientRect(); scopePop.style.left = r.left + "px"; scopePop.style.top = r.bottom + 6 + "px"; }
      scopePop.hidden = !open;
      scopeBtn.setAttribute("aria-expanded", String(open));
    });
    scopePop.addEventListener("click", function (e) { if (e.target.closest("[data-scope]")) { scopePop.hidden = true; scopeBtn.setAttribute("aria-expanded", "false"); } });
    document.addEventListener("pointerdown", function (e) {
      if (!scopePop.hidden && !e.target.closest("#scope-pop, #scope-btn")) { scopePop.hidden = true; scopeBtn.setAttribute("aria-expanded", "false"); }
      var pop = document.getElementById("narrow");
      if (!pop.hidden && !e.target.closest("#narrow, [data-narrow]")) pop.hidden = true;
    });
  }

  return { draw: draw, start: start, clear: clear, focus: function () { input.focus(); }, narrow: narrow };
})();
