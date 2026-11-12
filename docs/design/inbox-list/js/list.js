// PROTOTYPE - the list: two lines per row, built to scan. A row says what asks you and who, what the
// thing is, how long it has waited, and where it lives. Rows are patched by key, so a row keeps its
// element through every change and motion can measure where it was.
window.List = (function () {
  "use strict";
  var K = Kinds, D = Draw;

  function lead(t, selected) {
    return '<span class="row-lead">' + D.mark(Model.sourceOf(t), 16) + '<span class="row-tick' + (selected ? " is-on" : "") + '" role="checkbox" aria-checked="' + !!selected + '" aria-label="Select" data-tick>' + D.icon("check", 12) + "</span></span>";
  }

  function timeSlot(t) {
    if (t.held) return '<span class="row-time row-time--held" title="' + D.esc(t.held.by === "you" ? "You took it on" : t.held.by + " has it") + '">' + (t.held.by === "you" ? D.you(18) : D.face(t.held.by, "working", 18)) + "</span>";
    var w = Model.waitOf(t);
    if (w != null) return '<span class="row-time wait--' + D.waitTone(t) + '" title="Waiting ' + D.agoWords(w).replace(" ago", "") + '">' + D.ago(w) + "</span>";
    return '<span class="row-time wait--fresh" title="Updated ' + D.agoWords(t.updated) + '">' + D.ago(t.updated) + "</span>";
  }

  function where(t, inGroup) {
    var id = D.identifier(t), p = D.place(t);
    return '<span class="row-where">' + (p ? '<span class="row-place">' + D.esc(p) + "</span>" : "") + (id ? '<span class="row-id">' + D.esc(id) + "</span>" : "") + "</span>";
  }

  /** Draws one thing as a row: its mark and title, its wait, its status and the newest ask, and where it lives. */
  function thingRow(t, s, extra) {
    var sel = s.selection.has(t.id);
    return {
      cls: "row" + (extra ? " " + extra : "") + (sel ? " is-picked" : "") + (t.fresh ? " is-fresh" : "") + (Model.asks(t) ? "" : " is-quiet"),
      attrs: { "data-id": t.id },
      html: lead(t, sel) + '<span class="row-l1"><span class="row-title">' + D.esc(t.title) + "</span>" + timeSlot(t) + '</span><span class="row-glyph">' + D.glyph(t) + '</span><span class="row-l2"><span class="row-why">' + D.reason(t) + "</span>" + where(t) + "</span>",
      label: t.title + ". " + D.reason(t).replace(/<[^>]+>/g, ""),
    };
  }

  function groupRow(r, s) {
    var g = r.group;
    var marks = [];
    g.members.forEach(function (m) { var src = Model.sourceOf(m); if (marks.indexOf(src) < 0) marks.push(src); });
    var asking = g.members.filter(function (m) { return Model.asks(m) && !m.held; });
    var best = r.best;
    var why = asking.length ? D.reason(asking.sort(function (a, b) { return Model.waitOf(a) - Model.waitOf(b); })[0]).replace(/ <span class="more".*$/, "") : D.reason(g.lead);
    var on = asking.length > 1 ? ' <span class="more" title="' + (asking.length - 1) + ' more ask in this group">+' + (asking.length - 1) + "</span>" : "";
    var w = Math.max.apply(null, asking.map(Model.waitOf).concat([-1]));
    var time = w >= 0 ? '<span class="row-time wait--' + D.waitTone(asking.find(function (a) { return Model.waitOf(a) === w; })) + '">' + D.ago(w) + "</span>" : '<span class="row-time wait--fresh">' + D.ago(Math.min.apply(null, g.members.map(function (m) { return m.updated; }))) + "</span>";
    return {
      cls: "row row--group" + (r.open ? " is-open" : "") + (g.members.length > 7 ? " is-large" : ""),
      attrs: { "data-group": g.lead.id, "aria-expanded": String(r.open) },
      html: '<span class="row-lead"><span class="row-fold" data-fold-group>' + D.icon("chevron-right", 14) + '</span></span><span class="row-l1"><span class="row-title">' + D.esc(g.label) + "</span>" + time + "</span>" +
        '<span class="row-glyph row-glyph--link">' + D.icon("link", 14) + '</span><span class="row-l2"><span class="row-why">' + why + on + '</span><span class="row-where row-where--group"><span class="row-marks">' + marks.map(function (m) { return D.mark(m, 12); }).join("") + '</span><span class="row-id">' + g.members.length + " things</span></span></span>",
      label: "Linked group: " + g.label + ", " + g.members.length + " things",
    };
  }

  function triageRow(r) {
    var x = r.item;
    var marks = r.things.map(function (t) { return D.mark(Model.sourceOf(t), 12); }).join("");
    if (r.type === "proposal") {
      return {
        cls: "row row--triage" + (r.lastTriage ? " is-last-triage" : ""),
        attrs: { "data-triage": x.id },
        html: '<span class="row-lead row-lead--face">' + D.face(x.by, "idle", 18) + '</span><span class="row-l1"><span class="row-title">' + D.esc(x.title) + '</span><span class="row-time wait--fresh">' + D.ago(x.at) + '</span></span><span class="row-glyph"></span><span class="row-l2"><span class="row-why"><b class="tri-word">Proposal</b>' + D.esc(x.by) + " made it from " + r.things.length + ' things</span><span class="row-where row-where--group"><span class="row-marks">' + marks + "</span></span></span>",
        label: "Proposal: " + x.title,
      };
    }
    var a = r.things[0], b = r.things[1];
    return {
      cls: "row row--triage" + (r.lastTriage ? " is-last-triage" : ""),
      attrs: { "data-triage": x.id },
      html: '<span class="row-lead row-lead--face">' + D.face("Hercule", "idle", 18) + '</span><span class="row-l1"><span class="row-title">' + D.esc(a.title) + '</span><span class="row-time wait--fresh">' + D.ago(x.at) + '</span></span><span class="row-glyph"></span><span class="row-l2"><span class="row-why"><b class="tri-word">Link?</b>Belongs with ' + D.mark(Model.sourceOf(b), 12) + '<span class="row-ref">' + D.esc(D.identifier(b) || b.title) + "</span>, Hercule thinks</span>" + where(a) + "</span>",
      label: "Hercule suggests a link: " + a.title + " belongs with " + (D.identifier(b) || b.title),
    };
  }

  function moreRow(r) {
    return { cls: "row row--more", attrs: { "data-show-all": r.groupKey }, html: '<span class="row-more-in">' + D.icon("plus", 12) + "Show " + r.n + " more in this group</span>", label: "Show " + r.n + " more" };
  }

  function tmoreRow(r) {
    return { cls: "row row--tmore is-last-triage", attrs: { "data-scope-triage": "1" }, html: '<span class="row-more-in">' + r.n + " more in Triage" + D.icon("chevron-right", 12) + "</span>", label: r.n + " more in Triage" };
  }

  function build(r, s) {
    if (r.type === "tmore") return tmoreRow(r);
    if (r.type === "thing") return thingRow(r.thing, s);
    if (r.type === "member") return thingRow(r.thing, s, "row--member" + (r.outside ? " is-outside" : "") + (r.last ? " is-last" : ""));
    if (r.type === "group") return groupRow(r, s);
    if (r.type === "more") return moreRow(r);
    return triageRow(r);
  }

  /** Patches the rows in place by key: a row keeps its element, so motion can measure where it was. */
  function patch(host, s) {
    var existing = new Map();
    Array.prototype.forEach.call(host.children, function (c) { if (c.dataset.key) existing.set(c.dataset.key, c); });
    var prev = null;
    s.rows.forEach(function (r) {
      var b = build(r, s);
      var node = existing.get(r.key);
      if (node && node.classList.contains("is-leaving")) node = null;
      if (!node) { node = document.createElement("div"); node.dataset.key = r.key; node.setAttribute("role", "option"); node.tabIndex = -1; }
      else existing.delete(r.key);
      var cls = b.cls + (r.key === s.focus ? " is-current" : "");
      if (node.className !== cls) node.className = cls;
      if (node._html !== b.html) { node.innerHTML = b.html; node._html = b.html; }
      Object.keys(b.attrs).forEach(function (k) { if (node.getAttribute(k) !== b.attrs[k]) node.setAttribute(k, b.attrs[k]); });
      node.setAttribute("aria-label", b.label);
      node.setAttribute("aria-selected", String(r.key === s.focus));
      var at = prev ? prev.nextSibling : host.firstChild;
      if (at !== node) host.insertBefore(node, at);
      prev = node;
    });
    existing.forEach(function (node) { if (!node.classList.contains("is-leaving")) node.remove(); });
  }

  function head(hostHead, s) {
    var built = s.built;
    var searching = s.search.text || s.search.clauses.length;
    var title = searching ? "Search" : App.scopeTitle();
    var pre = "", post = "", tip = "";
    if (s.scope.browse && !searching) {
      var b = s.scope.browse;
      pre = D.mark(b.source, 14);
      tip = K.SOURCES[b.source].name + " " + K.FIELDS[b.field].label.toLowerCase() + (b.account ? " in " + b.account : "");
      if (b.account) post = '<span class="lh-acct">' + D.esc(b.account) + "</span>";
    }
    var n = s.scope.triage ? built.rows.length : built.count;
    var order = Kinds.ORDER_WORDS[built.order] || "";
    hostHead.innerHTML = '<div class="lh-title"' + (tip ? ' title="' + D.esc(tip) + '"' : "") + ">" + pre + "<h2>" + D.esc(title) + "</h2>" + post + '<span class="lh-n">' + D.num(n) + '</span></div><div class="lh-tools"><span class="lh-order">' + order + '</span><button type="button" class="lh-narrow tool" data-narrow aria-haspopup="menu">' + D.icon("filter", 14) + "<b>Narrow</b></button></div>";
  }

  // ---- Motion for a redraw: what leaves, what stays, what arrives, and what moves between places ----
  function flightLayer() { return document.getElementById("flight"); }

  function exit(ghost, how) {
    var b = Motion.body(ghost);
    var done = function () { ghost.remove(); };
    if (how === "dismiss") b.to({ x: 14, o: 0 }, "travel", { done: done });
    else if (how === "taken") b.to({ o: 0, s: 0.985 }, "travel", { done: done });
    else b.to({ o: 0 }, "hand", { done: done });
    if (Motion.isReduced()) setTimeout(done, 260);
  }

  function enter(node, how, i) {
    if (Motion.isReduced()) return;
    var b = Motion.body(node);
    if (how === "unfold") { b.set({ y: -8, o: 0 }); b.to({ y: 0, o: 1 }, "hand", { delay: i * 18, done: function () { b.clear(); } }); }
    else if (how === "return") { b.set({ x: 14, o: 0 }); b.to({ x: 0, o: 1 }, "travel", { done: function () { b.clear(); } }); }
    else if (how === "arrive") { b.set({ y: -20, o: 0 }); b.to({ y: 0, o: 1 }, "self", { delay: i * 40, done: function () { b.clear(); } }); }
    else { b.set({ s: 0.985, o: 0 }); b.to({ s: 1, o: 1 }, "hand", { done: function () { b.clear(); } }); }
  }

  /** Flies a thing's old row to its new place, as one object, and shows the new row when it lands. */
  function shared(ghost, target) {
    target.style.opacity = "0";
    ghost.classList.add("is-flying");
    var to = Motion.layoutRect(target), from = ghost.getBoundingClientRect();
    var b = Motion.body(ghost);
    var land = function () { target.style.opacity = ""; ghost.remove(); };
    if (Motion.isReduced()) { land(); return; }
    b.to({ x: b.value.x + (to.left - from.left), y: b.value.y + (to.top - from.top) }, "travel", { done: land });
  }

  var SKEL = [72, 58, 80, 64, 50, 76, 61, 69, 55, 73, 66, 59, 70, 52];
  /** Draws the rows' shapes while the first read is on its way: still, so a slow read costs no frames. */
  function skeleton(host, hostHead) {
    hostHead.innerHTML = '<div class="lh-title"><h2>' + D.esc(App.scopeTitle()) + '</h2><span class="skel-n"></span></div>';
    host.innerHTML = SKEL.map(function (w, i) { return '<div class="skel" aria-hidden="true"><i></i><i style="width:' + w + '%"></i><i></i><i></i><i style="width:' + (w - 18) + '%"></i></div>'; }).join("");
    host.setAttribute("aria-busy", "true");
  }

  function draw(host, hostHead, s, opts) {
    if (s.loading) { skeleton(host, hostHead); return; }
    host.removeAttribute("aria-busy");
    if (host.querySelector(".skel")) host.innerHTML = "";
    head(hostHead, s);
    var empty = document.getElementById("empty");
    var isEmpty = !s.rows.length;
    empty.hidden = !isEmpty;
    if (isEmpty) Empty.draw(empty, s);
    if (!opts.flip) patch(host, s);
    else {
      var olds = Array.prototype.filter.call(host.children, function (n) { return !n.classList.contains("is-leaving"); });
      var oldKeys = new Set(olds.map(function (n) { return n.dataset.key; }));
      var newKeys = new Set(s.rows.map(function (r) { return r.key; }));
      var leaving = olds.filter(function (n) { return !newKeys.has(n.dataset.key); });
      var ghosts = leaving.map(function (n) { var g = Motion.ghost(n, flightLayer()); g.classList.remove("is-current"); return { id: n.dataset.id, g: g }; });
      Motion.flip(olds.filter(function (n) { return newKeys.has(n.dataset.key); }), function () { patch(host, s); }, { spring: "hand" });
      var added = Array.prototype.filter.call(host.children, function (n) { return !oldKeys.has(n.dataset.key); });
      ghosts.forEach(function (x) {
        var to = x.id && added.find(function (n) { return n.dataset.id === x.id; });
        if (to) { added.splice(added.indexOf(to), 1); shared(x.g, to); }
        else exit(x.g, opts.leave);
      });
      added.forEach(function (n, i) { enter(n, opts.enter || (opts.link ? "link" : "unfold"), i); });
    }
    var nb = document.getElementById("newbar");
    var showBar = s.pending.length > 0;
    if (showBar) nb.querySelector("[data-new-n]").textContent = s.pending.length + " new";
    if (showBar === nb.hidden) Live.showBar(nb, showBar);
    Selection.draw(s);
  }

  /** Moves the current row's mark without redrawing the list, and keeps the row in view. */
  function markFocus(host, s, opts) {
    Array.prototype.forEach.call(host.children, function (c) {
      var on = c.dataset.key === s.focus;
      c.classList.toggle("is-current", on);
      c.setAttribute("aria-selected", String(on));
      if (on) {
        var r = c.getBoundingClientRect(), hr = host.parentElement.getBoundingClientRect();
        if (r.top < hr.top + 8 || r.bottom > hr.bottom - 8) c.scrollIntoView({ block: "nearest" });
        if (opts && opts.keyboard) c.focus({ preventScroll: true });
      }
    });
  }

  function start(host) {
    host.addEventListener("click", function (e) {
      var node = e.target.closest("[data-key]");
      if (!node || Drag.justDropped()) return;
      var key = node.dataset.key;
      var row = App.state.rows.find(function (r) { return r.key === key; });
      if (!row) return;
      if (e.target.closest("[data-tick]") || (e.shiftKey || e.metaKey) && row.thing) { Moves.toggleSelect(row.thing.id); return; }
      if (row.type === "more") { App.state.showAll.add(row.groupKey); Moves.redraw(); return; }
      if (row.type === "tmore") { Moves.setScope({ triage: 1 }); return; }
      if (e.target.closest("[data-fold-group]")) { Moves.toggleGroup(key); return; }
      App.focusRow(key);
    });
    host.addEventListener("dblclick", function (e) {
      var node = e.target.closest(".row--group");
      if (node) Moves.toggleGroup(node.dataset.key);
    });
  }

  return { draw: draw, markFocus: markFocus, start: start, build: build };
})();
