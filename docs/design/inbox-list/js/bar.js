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
    var shut = function () { menu.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); };
    if (!show) { shut(); return; }
    items = suggest(text);
    if (!items.length) { shut(); return; }
    active = Math.min(active, items.length - 1);
    menu.innerHTML = (text ? "" : '<p class="sx-h">Search by a field</p>') + items.map(function (it, i) {
      return '<div role="option" id="sx-o' + i + '" aria-selected="' + (i === active) + '" class="sx-item' + (i === active ? " is-active" : "") + '" data-i="' + i + '">' +
        '<span class="sx-key">' + (it.kind === "text" ? D.icon("search", 14) : it.kind === "field" ? D.icon("filter", 14) : "") + "</span>" +
        "<span class=\"sx-label\">" + (it.kind === "text" ? "“" + D.esc(it.label) + "”" : "<code>" + D.esc(it.label) + "</code>") + (it.hint ? '<small>' + D.esc(it.hint) + "</small>" : "") + "</span>" +
        (it.n != null ? '<span class="sx-n">' + D.num(it.n) + "</span>" : "") + "</div>";
    }).join("") + '<p class="sx-foot"><kbd>↩</kbd> add <kbd>↓</kbd> to the results <kbd>⌫</kbd> remove the last <kbd>Esc</kbd> leave, keeping the search</p>';
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-activedescendant", "sx-o" + active);
    var r = field.getBoundingClientRect();
    menu.style.left = r.left + "px";
    menu.style.top = r.bottom + 6 + "px";
    menu.style.width = r.width + "px";
    menu.hidden = false;
  }

  /**
   * Turns every finished `field:value` in the field into a token, and returns what is left as free text.
   * A half-typed field name (`even`, `events:`) is never used as free text. Any threshold works: `>500`.
   */
  function absorb(final) {
    var st = App.state;
    var words = input.value.split(/\s+/);
    var lastWord = final ? null : words.pop();
    var rest = [];
    words.forEach(function (w) {
      var m = /^([a-z]+):(.+)$/i.exec(w);
      var key = m && tokenField(m[1].toLowerCase());
      if (key) st.search.clauses.push({ key: key, value: m[2] });
      else if (w) rest.push(w);
    });
    if (lastWord != null) rest.push(lastWord);
    input.value = rest.join(" ");
    var typed = rest.filter(function (w) { return !/:/.test(w) && !Object.keys(K.FIELDS).some(function (k) { return K.FIELDS[k].token.indexOf(w.toLowerCase()) === 0 && w.length >= 2 && rest[rest.length - 1] === w && !final; }); });
    st.search.text = typed.join(" ").trim();
  }

  /** Leaves the search for the list, keeping the query, with the first result current. */
  function toList() {
    menu.hidden = true;
    var first = App.state.rows.find(function (r) { return r.type !== "tmore" && r.type !== "more"; });
    if (first) App.focusRow(first.key, { keyboard: true });
    else { var b = document.querySelector("#empty button"); if (b) b.focus(); else input.blur(); }
  }

  function pick(it) {
    var st = App.state;
    if (!it) return;
    if (it.kind === "field") { input.value = K.FIELDS[it.key].token + ":"; active = 0; drawMenu(); return; }
    if (it.kind === "value") { st.search.clauses.push({ key: it.key, value: String(it.value) }); input.value = ""; st.search.text = ""; active = 0; apply(); menu.hidden = true; return; }
    absorb(true);
    apply();
    toList();
  }

  function apply() {
    var st = App.state;
    st.focus = null;
    App.render({});
    if (st.search.text || st.search.clauses.length) Announce.say(st.built.count + (st.built.count === 1 ? " thing matches" : " things match") + " in " + App.scopeTitle() + ".");
  }

  /** Widens the search to Everything, keeping the query. */
  function widen() {
    var st = App.state;
    var keep = st.search;
    st.scope = { saved: "all" };
    st.search = keep;
    apply();
    drawMenu();
  }

  function drawChips() {
    var st = App.state;
    var searching = st.search.text || st.search.clauses.length || document.activeElement === input;
    var scopeChip = searching && !(st.scope.saved === "all") ? '<span class="sx-chip sx-chip--scope" title="Searching in ' + D.esc(App.scopeTitle()) + '. ⌫ or × searches Everything.">in<b>' + D.esc(App.scopeTitle()) + '</b><button type="button" data-widen aria-label="Search Everything instead">' + D.icon("close", 10) + "</button></span>" : "";
    chips.innerHTML = scopeChip + st.search.clauses.map(function (c, i) {
      var f = K.FIELDS[c.key];
      return '<span class="sx-chip">' + (c.source ? D.mark(c.source, 12) : "") + "<span>" + D.esc(f.token) + ":</span><b>" + D.esc(c.value) + '</b><button type="button" data-unchip="' + i + '" aria-label="Remove ' + D.esc(f.token + ":" + c.value) + '">' + D.icon("close", 10) + "</button></span>";
    }).join("");
    field.classList.toggle("has-chips", st.search.clauses.length > 0);
    // The long hint only where it fits; a narrow field says less rather than cutting a word.
    input.placeholder = st.search.clauses.length ? "" : field.offsetWidth > 420 ? "Search, or type a field: team:, from:, waiting:>2d" : field.offsetWidth > 260 ? "Search, or type team:, from:" : "Search";
  }

  function draw(st) {
    drawChips();
    var off = document.getElementById("offline");
    off.hidden = !st.offline;
    if (st.offline) off.textContent = "Offline since 09:12 · " + (st.outbox ? st.outbox + (st.outbox === 1 ? " move waits" : " moves wait") + " to be sent" : "moves wait until you’re back");
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
  var narrowFrom = null;
  function closeNarrow() {
    var pop = document.getElementById("narrow");
    pop.hidden = true;
    if (narrowFrom) { narrowFrom.setAttribute("aria-expanded", "false"); if (pop.contains(document.activeElement) || document.activeElement === document.body) narrowFrom.focus({ preventScroll: true }); }
  }
  function narrow(button) {
    var pop = document.getElementById("narrow");
    if (!pop.hidden) { closeNarrow(); return; }
    pop.onfocusout = function (e) { if (!pop.contains(e.relatedTarget) && e.relatedTarget) closeNarrow(); };
    var st = App.state;
    var things = Model.find(st.scope.triage ? { saved: "all" } : st.scope, st.search);
    var bySource = {};
    things.forEach(function (t) { var s = Model.sourceOf(t); (bySource[s] = bySource[s] || []).push(t); });
    var drawFacets = function () {
      var html = '<p class="menu-h">Narrow what the list holds</p>';
      Object.keys(K.BROWSE).forEach(function (src) {
        if (!bySource[src]) return;
        html += '<div role="group" aria-label="' + D.esc(K.SOURCES[src].name) + '"><p class="nw-src" aria-hidden="true">' + D.mark(src, 12) + D.esc(K.SOURCES[src].name) + "</p>";
        K.BROWSE[src].forEach(function (f) {
          html += '<button type="button" role="menuitem" tabindex="-1" class="menu-pick nw-f" data-nf="' + src + "|" + f.field + '" aria-label="' + D.esc(K.SOURCES[src].name + " " + K.FIELDS[f.field].label.toLowerCase()) + '"><span>' + D.esc(K.FIELDS[f.field].label) + "</span>" + D.icon("chevron-right", 12) + "</button>";
        });
        html += "</div>";
      });
      pop.innerHTML = html;
    };
    var drawValues = function (src, fieldKey) {
      var counts = new Map();
      bySource[src].forEach(function (t) { var v = t.fields[fieldKey]; if (v != null) counts.set(v, (counts.get(v) || 0) + 1); });
      pop.innerHTML = '<button type="button" role="menuitem" class="menu-pick nw-back" tabindex="-1" data-nback>' + D.icon("chevron-left", 12) + "<span>" + D.esc(K.SOURCES[src].name) + " " + D.esc(K.FIELDS[fieldKey].label.toLowerCase()) + "</span></button><i class=\"menu-line\"></i>" +
        Array.from(counts).sort(function (a, b) { return b[1] - a[1]; }).map(function (e) {
          return '<button type="button" role="menuitem" tabindex="-1" class="menu-pick" data-nv="' + D.esc(JSON.stringify({ source: src, key: fieldKey, value: e[0] })) + '"><span>' + D.esc(e[0]) + "</span><small>" + D.num(e[1]) + "</small></button>";
        }).join("");
    };
    drawFacets();
    button.setAttribute("aria-expanded", "true");
    narrowFrom = button;
    var r = button.getBoundingClientRect();
    pop.style.left = Math.max(8, r.right - 280) + "px";
    pop.style.top = r.bottom + 6 + "px";
    pop.hidden = false;
    var focusFirst = function () { var f = pop.querySelector(".menu-pick"); if (f) { f.classList.add("is-active"); f.focus({ preventScroll: true }); } };
    focusFirst();
    pop.onclick = function (e) {
      var f = e.target.closest("[data-nf]");
      if (f) { var p = f.dataset.nf.split("|"); drawValues(p[0], p[1]); focusFirst(); return; }
      if (e.target.closest("[data-nback]")) { drawFacets(); focusFirst(); return; }
      var v = e.target.closest("[data-nv]");
      if (v) { var c = JSON.parse(v.dataset.nv); App.state.search.clauses.push({ key: c.key, value: String(c.value), source: c.source }); closeNarrow(); apply(); }
    };
    if (!Motion.isReduced()) Motion.animate(pop, [{ opacity: 0, transform: "translateY(-4px) scale(.98)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" });
  }

  function start() {
    input = document.getElementById("sx-input");
    chips = document.getElementById("sx-chips");
    menu = document.getElementById("sx-menu");
    field = document.getElementById("sx");
    input.addEventListener("focus", function () { field.classList.add("is-focus"); drawChips(); drawMenu(); });
    input.addEventListener("blur", function () { field.classList.remove("is-focus"); setTimeout(function () { if (document.activeElement !== input) { menu.hidden = true; drawChips(); } }, 120); });
    input.addEventListener("input", function () {
      active = 0;
      if (/\s$/.test(input.value) && /\b[a-z]+:\S+\s$/i.test(input.value)) absorb(true);
      else absorb(false);
      apply();
      drawMenu();
    });
    input.addEventListener("keydown", function (e) {
      var st = App.state;
      if (e.key === "F6" || e.key === "Tab") { menu.hidden = true; return; }
      if (e.key === "ArrowDown") {
        if (menu.hidden || active >= items.length - 1) toList(); else { active++; drawMenu(); }
        e.preventDefault();
      }
      else if (e.key === "ArrowUp") { active = Math.max(0, active - 1); drawMenu(); e.preventDefault(); }
      else if (e.key === "Enter") {
        // ↩ takes the highlighted suggestion; a typed value is taken as it is only when nothing is offered.
        var m = /^([a-z]+):(.+)$/i.exec(input.value.trim());
        if (!menu.hidden && items[active] && items[active].kind !== "text") pick(items[active]);
        else if (m && tokenField(m[1].toLowerCase())) { absorb(true); apply(); menu.hidden = true; }
        else { absorb(true); apply(); toList(); }
        e.preventDefault();
      }
      else if (e.key === "Backspace" && !input.value) {
        // ⌫ removes the last token; it widens the scope only while there is a query to widen.
        if (st.search.clauses.length) { st.search.clauses.pop(); apply(); drawMenu(); }
        else if (st.search.text && st.scope.saved !== "all") widen();
        e.preventDefault();
      }
      else if (e.key === "Escape") {
        // The first Esc leaves the search and keeps the query; Esc in the list then clears it.
        menu.hidden = true;
        if (st.search.text || st.search.clauses.length) toList(); else input.blur();
        e.preventDefault();
      }
      e.stopPropagation();
    });
    menu.addEventListener("mousedown", function (e) { e.preventDefault(); });
    menu.addEventListener("click", function (e) { var b = e.target.closest("[data-i]"); if (b) pick(items[+b.dataset.i]); });
    chips.addEventListener("click", function (e) {
      if (e.target.closest("[data-widen]")) { widen(); return; }
      var b = e.target.closest("[data-unchip]");
      if (b) { App.state.search.clauses.splice(+b.dataset.unchip, 1); apply(); }
    });
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
      if (!pop.hidden && !e.target.closest("#narrow, [data-narrow]")) closeNarrow();
    });
  }

  return { closeNarrow: closeNarrow, widen: widen, draw: draw, start: start, clear: clear, focus: function () { input.focus(); }, narrow: narrow };
})();
