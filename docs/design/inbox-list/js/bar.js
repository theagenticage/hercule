// PROTOTYPE - the bar over the list: the search with tokens over declared fields, values offered with
// counts, and Narrow, the menus over what the list holds. Both add the same clauses, so they never disagree.
window.Bar = (function () {
  "use strict";
  var K = Kinds, D = Draw;
  var input, chips, menu, field, scopeBtn, scopePop;
  // The highlighted suggestion, or -1 for none: with nothing typed none is highlighted, so ↩ goes to
  // the results and only ↓ reaches the suggestions.
  var active = -1, items = [];
  function firstActive() { return input.value.trim() ? 0 : -1; }

  function tokenField(token) { return Object.keys(K.FIELDS).find(function (k) { return K.FIELDS[k].token === token; }); }

  /** Lists what the search offers for what is typed: fields, then a field's values with counts. */
  function suggest(text) {
    var st = App.state;
    var pool = Model.find(st.scope.saved || st.scope.clauses ? st.scope : { saved: "all" }, null);
    // What is offered follows the clause being typed, at the end of the field, after any free text.
    var m = /(?:^|\s)([a-z]+):(.*)$/i.exec(text);
    if (m && tokenField(m[1].toLowerCase())) {
      var key = tokenField(m[1].toLowerCase()), f = K.FIELDS[key], typed = m[2].toLowerCase();
      if (f.type === "number" || f.type === "duration") {
        var hints = f.type === "number" ? [">100", ">1000", ">10000"] : [">4h", ">1d", ">2d", ">1w"];
        // A threshold typed in full comes first, as typed, so ↩ never swaps it for a longer one.
        var typedOk = f.type === "number" ? /^[<>]\d+$/.test(typed) : /^[<>]\d+[mhdw]$/.test(typed);
        var list = hints.filter(function (h) { return (h.indexOf(typed) === 0 || !typed) && h !== typed; });
        if (typedOk) list.unshift(typed);
        return list.map(function (h) {
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
    var word = t.split(/\s+/).pop();
    Object.keys(K.FIELDS).forEach(function (k) {
      var f = K.FIELDS[k];
      if (word && f.token.indexOf(word) !== 0) return;
      var n = pool.filter(function (x) { return Model.readField(x, k) != null; }).length;
      if (!n) return;
      out.push({ kind: "field", key: k, label: f.token + ":", hint: f.label + (f.type === "duration" ? ", such as >2d" : f.type === "number" ? ", such as >1000" : ""), n: n });
    });
    out = out.slice(0, t ? 6 : 8);
    if (t) out.unshift({ kind: "text", label: text, hint: "in titles and fields" });
    return out;
  }

  /** Closes the suggestions and tells assistive tech so: the field is collapsed and points at no option. */
  function closeMenu() { menu.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); }

  function drawMenu() {
    var text = input.value.trim();
    var show = document.activeElement === input;
    var shut = closeMenu;
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
    if (active >= 0) input.setAttribute("aria-activedescendant", "sx-o" + active); else input.removeAttribute("aria-activedescendant");
    var r = field.getBoundingClientRect();
    menu.style.left = r.left + "px";
    menu.style.top = r.bottom + 6 + "px";
    menu.style.width = r.width + "px";
    menu.hidden = false;
  }

  /** Returns the search's pool: what the scope holds, or Everything when the scope is not a list. */
  function pool() {
    var st = App.state;
    return Model.find(st.scope.saved || st.scope.clauses ? st.scope : { saved: "all" }, null);
  }

  /**
   * Returns the value a space after `field:value` finishes, or null when the space is part of the value.
   * - A value the field holds goes on past the space ("Checkout" while "Checkout revamp" exists): null,
   *   so a value with spaces can be typed out.
   * - The typed value is one the field holds, or no value starts with it (a threshold, a new word): it
   *   is taken as typed.
   * - It starts values the field holds ("Check"): the most common of them, as the menu offers first.
   */
  function finishValue(key, value) {
    if (!/\s$/.test(value) || !value.trim()) return null;
    var typed = value.trim(), low = typed.toLowerCase();
    var counts = new Map();
    pool().forEach(function (t) { var x = Model.readField(t, key); if (x != null) counts.set(String(x), (counts.get(String(x)) || 0) + 1); });
    var held = Array.from(counts.keys());
    if (held.some(function (x) { return x.toLowerCase().indexOf(low + " ") === 0; })) return null;
    if (held.some(function (x) { return x.toLowerCase() === low; })) return typed;
    var starts = held.filter(function (x) { return x.toLowerCase().indexOf(low) === 0; }).sort(function (a, b) { return counts.get(b) - counts.get(a); });
    return starts[0] || typed;
  }

  /**
   * Turns every finished `field:value` in the field into a token, and keeps the rest in the field: free
   * text, and the clause still being typed. A value runs to the next `field:`, so it can hold spaces.
   * With `final` (↩), the clause being typed is taken as it is. A half-typed field name (`even`) is
   * never searched as free text. Any threshold works: `events:>500`.
   */
  function absorb(final) {
    var st = App.state;
    var text = input.value;
    var re = /(^|\s)([a-z]+):/gi, starts = [], m;
    while ((m = re.exec(text))) {
      var key = tokenField(m[2].toLowerCase());
      if (key) starts.push({ at: m.index + m[1].length, from: re.lastIndex, key: key });
    }
    var free = starts.length ? text.slice(0, starts[0].at) : text;
    var open = "", taken = false;
    starts.forEach(function (c, i) {
      var value = text.slice(c.from, i + 1 < starts.length ? starts[i + 1].at : text.length);
      var last = i === starts.length - 1;
      // Only the last clause can still be being typed; an empty one before another is dropped.
      var done = !last || final ? value.trim() : finishValue(c.key, value);
      if (value.trim() && done) st.search.clauses.push({ key: c.key, value: done });
      else if (last) { open = text.slice(c.at); return; }
      taken = true;
    });
    if (taken) input.value = free + open;
    var words = free.trim() ? free.trim().split(/\s+/) : [];
    // The last word may be a field name being typed; it is not searched until it is clearly not one.
    var tail = words[words.length - 1];
    if (!final && !open && tail && !/\s$/.test(free) && tail.length >= 2 && Object.keys(K.FIELDS).some(function (k) { return K.FIELDS[k].token.indexOf(tail.toLowerCase()) === 0; })) words.pop();
    st.search.text = words.join(" ");
  }

  /**
   * Takes a `field:value` typed out in full as a token when the field is left without ↩ (Esc, ↓ to the
   * results, Tab, F6, a click elsewhere), so the field never shows a filter that does not apply.
   */
  function takeTyped() {
    if (!/(^|\s)[a-z]+:\S/i.test(input.value)) return;
    var before = App.state.search.clauses.length;
    absorb(true);
    // The current row stays when it still matches, so a click that left the field keeps its row.
    if (App.state.search.clauses.length !== before) apply(true);
  }

  /** Leaves the search for the list, keeping the query, with the first result current. */
  function toList() {
    takeTyped();
    closeMenu();
    var first = App.state.rows.find(function (r) { return r.type !== "tmore" && r.type !== "more"; });
    if (first) App.focusRow(first.key, { keyboard: true });
    else { var b = document.querySelector("#empty button"); if (b) b.focus(); else input.blur(); }
  }

  function pick(it) {
    var st = App.state;
    if (!it) return;
    // A picked field or value replaces only what it completes; free text typed before it stays.
    if (it.kind === "field") { input.value = input.value.replace(/\S*$/, K.FIELDS[it.key].token + ":"); active = firstActive(); drawMenu(); return; }
    if (it.kind === "value") {
      st.search.clauses.push({ key: it.key, value: String(it.value) });
      input.value = input.value.replace(/(^|\s)[a-z]+:.*$/i, "$1");
      absorb(false);
      active = firstActive();
      apply();
      closeMenu();
      return;
    }
    absorb(true);
    apply();
    toList();
  }

  /** Runs the search and says how many match. The first result becomes current, unless `keepCurrent`. */
  function apply(keepCurrent) {
    var st = App.state;
    if (!keepCurrent) st.focus = null;
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
    var searching = st.search.text || st.search.clauses.length || field.contains(document.activeElement);
    var scopeChip = searching && !(st.scope.saved === "all") ? '<span class="sx-chip sx-chip--scope" title="Searching in ' + D.esc(App.scopeTitle()) + '. × searches Everything.">in<b>' + D.esc(App.scopeTitle()) + '</b><button type="button" data-widen aria-label="Search Everything instead">' + D.icon("close", 10) + "</button></span>" : "";
    var html = scopeChip + st.search.clauses.map(function (c, i) {
      var f = K.FIELDS[c.key];
      return '<span class="sx-chip">' + (c.source ? D.mark(c.source, 12) : "") + "<span>" + D.esc(f.token) + ":</span><b>" + D.esc(c.value) + '</b><button type="button" data-unchip="' + i + '" aria-label="Remove ' + D.esc(f.token + ":" + c.value) + '">' + D.icon("close", 10) + "</button></span>";
    }).join("");
    // Unchanged tokens are kept, so a token's × that has the focus keeps it; they are only fitted again.
    if (chips._html !== html) { chips.innerHTML = html; chips._html = html; }
    else {
      chips.querySelectorAll(".sx-more").forEach(function (m) { m.remove(); });
      chips.querySelectorAll(".sx-chip").forEach(function (c) { c.hidden = false; });
    }
    field.classList.toggle("has-chips", st.search.clauses.length > 0);
    // Tokens that do not fit fold, oldest first, into a +N token, so none is cut mid-letter.
    var all = Array.prototype.slice.call(chips.querySelectorAll(".sx-chip:not(.sx-chip--scope)"));
    var hidden = 0, more = null;
    var overflows = function () { return chips.scrollWidth > chips.clientWidth + 1; };
    while (hidden < all.length && overflows()) {
      all[hidden].hidden = true;
      hidden++;
      if (!more) { more = document.createElement("span"); more.className = "sx-chip sx-more"; }
      all[hidden - 1].after(more);
      more.textContent = "+" + hidden;
      more.title = all.slice(0, hidden).map(function (c) { return c.textContent; }).join(", ");
    }
    fitPlaceholder();
  }

  var HINTS = ["Search, or type a field: team:, from:, waiting:>2d", "Search, or type team:, from:", "Search"];
  /**
   * Sets the longest hint that fits the field whole: a narrow field says less rather than cutting a word.
   * Each hint is measured in a hidden copy of the field's text, so it is measured in the field's own font.
   */
  function fitPlaceholder() {
    if (App.state.search.clauses.length) { input.placeholder = ""; return; }
    var probe = field.querySelector(".sx-measure");
    if (!probe) { probe = document.createElement("span"); probe.className = "sx-measure"; probe.setAttribute("aria-hidden", "true"); field.appendChild(probe); }
    var room = input.clientWidth - 2;
    input.placeholder = HINTS.find(function (h) { probe.textContent = h; return probe.offsetWidth <= room; }) || "";
  }

  function draw(st) {
    // The offline pill first: it takes room from the field, and the tokens and the hint fit what is left.
    var off = document.getElementById("offline");
    off.hidden = !st.offline;
    if (st.offline) {
      var words = "Offline · 09:12" + (st.outbox ? " · " + st.outbox + " waiting" : "");
      if (off.textContent !== words) off.textContent = words;
      off.title = "Offline since 09:12. " + (st.outbox ? st.outbox + (st.outbox === 1 ? " move waits" : " moves wait") + " to be sent." : "Moves wait until you’re back.");
    }
    drawChips();
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
    if (!pop._watch) { pop._watch = true; pop.addEventListener("focusout", function (e) { if (e.relatedTarget && !pop.contains(e.relatedTarget)) closeNarrow(); }); }
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
    // Never taller than the room under it: a short window scrolls the menu instead of cutting it.
    pop.style.maxHeight = Math.min(420, innerHeight - r.bottom - 18) + "px";
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
    // A hint measured before the theme's font has loaded is measured in the fallback font, so the
    // hint is fitted again once fonts arrive.
    document.fonts.addEventListener("loadingdone", function () { fitPlaceholder(); });
    input.addEventListener("focus", function () { field.classList.add("is-focus"); active = firstActive(); drawChips(); drawMenu(); });
    input.addEventListener("blur", function () { field.classList.remove("is-focus"); setTimeout(function () { if (document.activeElement !== input) { takeTyped(); closeMenu(); } }, 120); });
    // The scope token shows while the focus is anywhere in the field, its tokens' buttons too.
    field.addEventListener("focusout", function () { setTimeout(function () { if (!field.contains(document.activeElement)) drawChips(); }, 120); });
    input.addEventListener("input", function () {
      // What is left in the field after tokens are taken decides whether a suggestion is highlighted.
      absorb(false);
      active = firstActive();
      apply();
      drawMenu();
    });
    input.addEventListener("keydown", function (e) {
      var st = App.state;
      if (e.key === "F6" || e.key === "Tab") { takeTyped(); closeMenu(); return; }
      if (e.key === "ArrowDown") {
        if (menu.hidden || active >= items.length - 1) toList(); else { active++; drawMenu(); }
        e.preventDefault();
      }
      else if (e.key === "ArrowUp") { active = Math.max(active < 0 ? -1 : 0, active - 1); drawMenu(); e.preventDefault(); }
      else if (e.key === "Enter") {
        // ↩ takes the highlighted suggestion; a typed value is taken as it is only when nothing is offered.
        var m = /^([a-z]+):(.+)$/i.exec(input.value.trim());
        if (!menu.hidden && items[active] && items[active].kind !== "text") pick(items[active]);
        else if (m && tokenField(m[1].toLowerCase())) { absorb(true); apply(); closeMenu(); }
        else { absorb(true); apply(); toList(); }
        e.preventDefault();
      }
      else if (e.key === "Backspace" && !input.value) {
        // ⌫ in an empty field removes the last token. It never removes the scope: with no query left,
        // a stray ⌫ would change the saved query you are in. The scope token's × does that.
        if (st.search.clauses.length) { st.search.clauses.pop(); active = firstActive(); apply(); drawMenu(); }
        e.preventDefault();
      }
      else if (e.key === "Escape") {
        // The first Esc leaves the search and keeps the query; Esc in the list then clears it. With
        // nothing typed, Esc goes back to the current row.
        takeTyped();
        closeMenu();
        if (st.search.text || st.search.clauses.length) toList(); else App.focusCurrent();
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
    scopeBtn = document.getElementById("scope-btn");
    scopePop = document.getElementById("scope-pop");
    scopeBtn.insertAdjacentHTML("beforeend", D.icon("chevron-down", 12));
    Rail.start(scopePop);
    scopeBtn.addEventListener("click", function () {
      var open = scopePop.hidden;
      if (open) { Rail.draw(scopePop, App.state); var r = scopeBtn.getBoundingClientRect(); scopePop.style.left = r.left + "px"; scopePop.style.top = r.bottom + 6 + "px"; }
      scopePop.hidden = !open;
      scopeBtn.setAttribute("aria-expanded", String(open));
      // Open, the focus goes to the current entry, so the arrows move inside the menu at once.
      if (open) { var first = scopePop.querySelector(".rl-row.is-on") || scopePop.querySelector(".rl-row"); if (first) { first.tabIndex = 0; first.focus(); } }
    });
    scopePop.addEventListener("click", function (e) { if (e.target.closest("[data-scope]")) { scopePop.hidden = true; scopeBtn.setAttribute("aria-expanded", "false"); } });
    document.addEventListener("pointerdown", function (e) {
      if (!scopePop.hidden && !e.target.closest("#scope-pop, #scope-btn")) { scopePop.hidden = true; scopeBtn.setAttribute("aria-expanded", "false"); }
      var pop = document.getElementById("narrow");
      if (!pop.hidden && !e.target.closest("#narrow, [data-narrow]")) closeNarrow();
    });
  }

  /** Closes the scope menu (the rail's menu under 1330px), if it is open. */
  function closeScope() {
    if (scopePop.hidden) return;
    scopePop.hidden = true;
    scopeBtn.setAttribute("aria-expanded", "false");
  }

  return { closeScope: closeScope, closeNarrow: closeNarrow, widen: widen, draw: draw, start: start, clear: clear, focus: function () { input.focus(); }, narrow: narrow };
})();
