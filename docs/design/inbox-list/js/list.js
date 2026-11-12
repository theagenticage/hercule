// PROTOTYPE - the list: two lines per row, built to scan. A row says what asks you and who, what the
// thing is, how long it has waited, and where it lives. Rows are patched by key, so a row keeps its
// element through every change and motion can measure where it was.
window.List = (function () {
  "use strict";
  var K = Kinds, D = Draw;

  function lead(t, selected) {
    return '<span class="row-lead">' + D.mark(Model.sourceOf(t), 16) + '<span class="row-tick' + (selected ? " is-on" : "") + '" aria-hidden="true" data-tick>' + D.icon("check", 12) + "</span></span>";
  }

  /**
   * Draws the time column: the value the list is ordered by. In a "Longest waiting first" list that is the
   * wait; in a "Newest first" list it is when the thing last changed, and only an overdue wait shows instead.
   */
  function timeSlot(t, order) {
    if (t.held) return '<span class="row-time row-time--held" title="' + D.esc(t.held.by === "you" ? "You took it on" : t.held.by + " has it") + '">' + (t.held.by === "you" ? D.you(18) : D.face(t.held.by, "working", 18)) + "</span>";
    var w = Model.waitOf(t);
    if (w != null && order === "newest" && D.waitTone(t) !== "over") w = null;
    if (w == null && order === "waiting") return '<span class="row-time wait--fresh" aria-hidden="true"></span>';
    if (w != null) { var tone = D.waitTone(t); return '<span class="row-time wait--' + tone + '" title="Waiting ' + D.agoWords(w).replace(" ago", "") + (tone === "over" ? ", overdue" : tone === "due" ? ", due" : "") + '">' + D.ago(w) + "</span>"; }
    return '<span class="row-time wait--fresh" title="Updated ' + D.agoWords(t.updated) + '">' + D.ago(t.updated) + "</span>";
  }

  /** Draws the moves a row offers under the pointer, each with its key in its tooltip. */
  function acts(list) {
    return '<span class="row-acts">' + list.map(function (a) {
      return '<button type="button" class="row-act" tabindex="-1" data-row-act="' + a[0] + '" title="' + D.esc(a[1]) + '" aria-label="' + D.esc(a[1]) + '">' + a[2] + "</button>";
    }).join("") + "</span>";
  }
  function thingActs(t) {
    if (t.held) return acts([["goto", "Go to its Task (G)", D.icon("arrow", 14)], ["dismiss", "Dismiss (E)", D.icon("archive", 14)]]);
    var offers = Model.offersFor(t).filter(function (o) { return !o.off; });
    var list = [["thread", "Start a thread (N)", D.icon("compose", 14)], ["take", "Take on (T)", D.icon("tasks", 14)]];
    if (offers.length === 1) list.push(["hand", "Hand to " + offers[0].w.name + " (H)", D.face(offers[0].w.name, "idle", 18)]);
    else if (offers.length > 1) list.push(["hand", "Hand to… (H)", D.face(offers[0].w.name, "idle", 18)]);
    list.push(["dismiss", "Dismiss (E)", D.icon("archive", 14)]);
    return acts(list);
  }

  function where(t, inGroup) {
    var id = D.identifier(t), p = D.place(t);
    // Beside a long identifier the place would be cut to a stub, so it is left to the pane.
    if (p && id && p.length + id.length > 26) p = "";
    return '<span class="row-where">' + (p ? '<span class="row-place">' + D.esc(p) + "</span>" : "") + (id ? '<span class="row-id">' + D.esc(id) + "</span>" : "") + "</span>";
  }

  /** Says a row in words for a screen reader: everything the row shows, in reading order. */
  function sayRow(t, outside) {
    var bits = [t.title, D.reason(t).replace(/<[^>]+>/g, "").replace(/\s*\+(\d+)$/, ", and $1 more ask")];
    var w = Model.waitOf(t);
    if (t.held) bits.push(t.held.by === "you" ? "on your Task" : t.held.by + " has it");
    else if (w != null) { var tone = D.waitTone(t); bits.push("waiting " + D.agoWords(w).replace(" ago", "") + (tone === "over" ? ", overdue" : tone === "due" ? ", due" : "")); }
    var st = D.statusWord(t);
    if (st) bits.push(st);
    bits.push(K.SOURCES[Model.sourceOf(t)].name + " " + D.noun(t).toLowerCase() + (D.place(t) ? " in " + D.place(t) : ""));
    if (D.identifier(t)) bits.push(D.identifier(t));
    if (outside) bits.push("not in this list’s query");
    return bits.join(". ");
  }

  /** Draws one thing as a row: its mark and title, its wait, its status and the newest ask, and where it lives. */
  function thingRow(t, s, extra) {
    var sel = s.selection.has(t.id);
    var order = s.built ? s.built.order : "waiting";
    return {
      cls: "row" + (extra ? " " + extra : "") + (sel ? " is-picked" : "") + (t.fresh ? " is-fresh" : "") + (Model.asks(t) ? "" : " is-quiet"),
      attrs: { "data-id": t.id },
      html: lead(t, sel) + '<span class="row-l1"><span class="row-title">' + D.esc(t.title) + "</span>" + timeSlot(t, order) + '</span><span class="row-glyph">' + D.glyph(t) + '</span><span class="row-l2"><span class="row-why">' + D.reason(t) + "</span>" + where(t) + "</span>" + thingActs(t),
      label: sayRow(t, extra && extra.indexOf("is-outside") >= 0),
      selected: sel,
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
    // The time is the one of the member that placed the group, so the column reads in the list's order.
    var time = timeSlot(best || g.lead, s.built ? s.built.order : "waiting");
    // Picked when every member the list's query holds is selected (X picks those; ⇧X picks all).
    var picked = (r.hits || g.members).every(function (m) { return s.selection.has(m.id); });
    return {
      cls: "row row--group" + (r.open ? " is-open" : "") + (g.members.length > 7 ? " is-large" : "") + (picked ? " is-picked" : ""),
      attrs: { "data-group": g.lead.id, "aria-expanded": String(!!r.open) },
      html: '<span class="row-lead"><span class="row-fold" data-fold-group>' + D.icon("chevron-right", 14) + '</span><span class="row-tick' + (picked ? " is-on" : "") + '" aria-hidden="true" data-tick>' + D.icon("check", 12) + '</span></span><span class="row-l1"><span class="row-title">' + D.esc(g.label) + "</span>" + time + "</span>" +
        '<span class="row-glyph row-glyph--link">' + D.icon("link", 14) + '</span><span class="row-l2"><span class="row-why">' + why + on + '</span><span class="row-where row-where--group"><span class="row-marks">' + marks.map(function (m) { return D.mark(m, 12); }).join("") + '</span><span class="row-id">' + g.members.length + " things</span></span></span>" + acts([["thread", "Start a thread on all " + g.members.length + " (N)", D.icon("compose", 14)], ["take", "Take on (T)", D.icon("tasks", 14)], ["dismiss", "Dismiss all " + g.members.length + " (E)", D.icon("archive", 14)]]),
      label: "Linked group, " + g.members.length + " things in " + marks.map(function (m) { return K.SOURCES[m].name; }).join(", ") + ": " + g.label + ". " + why.replace(/<[^>]+>/g, "") + (asking.length > 1 ? ", and " + (asking.length - 1) + " more ask" : "") + (best && Model.waitOf(best) != null ? ". Waiting " + D.agoWords(Model.waitOf(best)).replace(" ago", "") : ""),
      selected: picked,
    };
  }

  function triageRow(r) {
    var x = r.item;
    var srcs = [];
    r.things.forEach(function (t) { var src = Model.sourceOf(t); if (srcs.indexOf(src) < 0) srcs.push(src); });
    var marks = srcs.map(function (src) { return D.mark(src, 12); }).join("");
    if (r.type === "proposal") {
      return {
        cls: "row row--triage" + (r.lastTriage ? " is-last-triage" : ""),
        attrs: { "data-triage": x.id },
        html: '<span class="row-lead row-lead--face">' + D.face(x.by, "idle", 16) + '</span><span class="row-l1"><span class="row-title">' + D.esc(x.title) + '</span><span class="row-time wait--fresh">' + D.ago(x.at) + '</span></span><span class="row-glyph"></span><span class="row-l2"><span class="row-why"><b class="tri-word">Proposal</b>' + D.esc(x.by) + " made it from " + r.things.length + ' things</span><span class="row-where row-where--group"><span class="row-marks">' + marks + "</span></span></span>" + acts([["accept", "Accept (T)", D.icon("check", 14)], ["thread", "Accept and start a thread (N)", D.icon("compose", 14)], ["dismiss", "Dismiss (E)", D.icon("close", 14)]]),
        label: "Proposal from " + x.by + ", " + D.agoWords(x.at) + ": " + x.title + ". Made from " + r.things.length + " things. T accepts, N accepts and starts a thread, E dismisses",
      };
    }
    var a = r.things[0], b = r.things[1];
    return {
      cls: "row row--triage" + (r.lastTriage ? " is-last-triage" : ""),
      attrs: { "data-triage": x.id, "data-id": a.id },
      html: '<span class="row-lead row-lead--face">' + D.face("Hercule", "idle", 16) + '</span><span class="row-l1"><span class="row-title">' + D.esc((D.identifier(a) || "“" + a.title + "”") + " and " + (D.identifier(b) || "“" + b.title + "”")) + '</span><span class="row-time wait--fresh">' + D.ago(x.at) + '</span></span><span class="row-glyph"></span><span class="row-l2"><span class="row-why"><b class="tri-word">Link?</b>' + D.esc(x.why) + '</span><span class="row-where row-where--group"><span class="row-marks">' + D.mark(Model.sourceOf(a), 12) + D.mark(Model.sourceOf(b), 12) + "</span></span></span>" + acts([["link", "Link them (L)", D.icon("link", 14)], ["dismiss", "Not related (E)", D.icon("close", 14)]]),
      label: "Hercule suggests a link, " + D.agoWords(x.at) + ": " + a.title + " belongs with " + (D.identifier(b) ? D.identifier(b) + ", " : "") + b.title + ". L links them, E says not related",
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
      if (!node) { node = document.createElement("div"); node.dataset.key = r.key; node.setAttribute("role", "treeitem"); }
      else existing.delete(r.key);
      var cls = b.cls + (r.key === s.focus ? " is-current" : "");
      if (node.className !== cls) node.className = cls;
      if (node._html !== b.html) { node.innerHTML = b.html; node._html = b.html; }
      Object.keys(b.attrs).forEach(function (k) { if (node.getAttribute(k) !== b.attrs[k]) node.setAttribute(k, b.attrs[k]); });
      node.setAttribute("aria-label", b.label);
      node.setAttribute("aria-selected", String(!!b.selected));
      node.setAttribute("aria-level", r.type === "member" || r.type === "more" ? "2" : "1");
      if (r.type === "member") { node.setAttribute("aria-setsize", String(r.group.members.length)); node.setAttribute("aria-posinset", String(r.pos)); }
      node.tabIndex = r.key === s.focus ? 0 : -1;
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
    // Arrivals wait in a pill beside the count, in the head: it covers no row and moves none.
    if (s.pending.length) order = '<button type="button" class="newbar" data-newbar title="Show what is new (.)" aria-keyshortcuts="."><span data-new-n>' + s.pending.length + ' new</span><span class="newbar-show">Show<kbd class="kbd-dot" aria-hidden="true">.</kbd></span></button>';
    var had = !!hostHead.querySelector("[data-newbar]");
    hostHead.innerHTML = '<div class="lh-title"' + (tip ? ' title="' + D.esc(tip) + '"' : "") + ">" + pre + "<h2>" + D.esc(title) + "</h2>" + post + '<span class="lh-n">' + D.num(n) + '</span></div><div class="lh-tools"><span class="lh-order">' + order + '</span><button type="button" class="lh-narrow tool" data-narrow aria-haspopup="menu" aria-expanded="false" aria-keyshortcuts="F">' + D.icon("filter", 14) + "<b>Narrow</b></button></div>";
    if (s.pending.length && !had) Live.showBar(hostHead.querySelector("[data-newbar]"));
  }

  // ---- Motion for a redraw: what leaves, what stays, what arrives, and what moves between places ----
  // Copies of rows that leave lie in a layer under the list, so the rows closing up cover them with their
  // own ground. Copies of things flying to a new place lie in the flight layer over everything.
  function flightLayer() { return document.getElementById("flight"); }
  function leavingLayer() { return document.getElementById("leaving"); }

  /**
   * Plays a leaving row's copy out: it fades within 110ms, before the rows after it start to close up
   * (CLOSE_DELAY), so no words read through other words. Dismiss also slides it 28px aside.
   */
  var CLOSE_DELAY = 70;
  function exit(ghost, how, caught) {
    if (Motion.isReduced()) { ghost.remove(); return; }
    var b = Motion.body(ghost);
    // A row caught halfway into place keeps going there while it fades, and fades faster.
    var goal = caught ? { x: caught.x, y: caught.y } : {};
    if (how === "dismiss") goal.x = (caught ? caught.x : b.value.x) + 28;
    if (how === "taken") goal.s = 0.985;
    if (Object.keys(goal).length) b.to(goal, how === "dismiss" ? "travel" : "hand");
    ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: caught ? 60 : 110, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" }).finished.then(function () { Motion.body(ghost).clear(); ghost.remove(); });
  }

  /**
   * Brings a new row in. Opacity is a short fade of its own, never a spring, so no words read through
   * other words. Unfolding is a drawer: the members lie in place under the list, and the rows below the
   * group, carrying the list's ground, slide down off them.
   */
  function enter(node, how, i) {
    if (Motion.isReduced()) return;
    var b = Motion.body(node);
    var fade = function (delay, ms) { node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms || 120, delay: delay || 0, easing: "ease-out", fill: "backwards" }); };
    if (how === "unfold") { node.classList.add("is-under"); setTimeout(function () { node.classList.remove("is-under"); }, 420); return; }
    node.classList.add("is-entering");
    var done = function () { b.clear(); node.classList.remove("is-entering"); };
    if (how === "return") { b.set({ x: 28 }); b.to({ x: 0 }, "travel", { done: done }); fade(0, 140); }
    else if (how === "arrive") { b.set({ y: -20 }); b.to({ y: 0 }, "travel", { delay: 220 + i * 40, done: done }); fade(220 + i * 40, 160); }
    else { b.set({ s: 0.985 }); b.to({ s: 1 }, "hand", { done: done }); fade(0, 120); }
  }

  /**
   * Flies a thing from where it was to its new row, as one object: the copy's mark and title land on
   * the new row's mark and title, then the new row takes over with no blink.
   */
  function shared(ghost, target, quiet) {
    target.style.opacity = "0";
    ghost.classList.remove("is-picked", "is-over", "is-current");
    var tick = ghost.querySelector(".row-tick");
    if (tick) tick.classList.remove("is-on");
    var land = function () { target.style.opacity = ""; ghost.remove(); };
    if (Motion.isReduced()) { land(); return; }
    var toLead = target.querySelector(".row-lead"), fromLead = ghost.querySelector(".row-lead");
    var indent = toLead && fromLead ? toLead.offsetLeft - fromLead.offsetLeft : 0;
    // The copy loses its new row's indent from its width, so its columns land on the row's columns.
    ghost.style.width = target.offsetWidth - indent + "px";
    if (!quiet) {
      ghost.classList.add("is-flying");
      ghost.animate([{ boxShadow: "none" }, { boxShadow: getComputedStyle(ghost).boxShadow }], { duration: 160, easing: "cubic-bezier(.2,.8,.2,1)" });
    } else ghost.classList.add("is-flying-quiet");
    // Measured without the copy's scale and tilt, so it lands exactly, mark on mark.
    var to = Motion.layoutRect(target), base = Motion.layoutRect(ghost);
    var b = Motion.body(ghost);
    var x = to.left + (toLead ? toLead.offsetLeft : 0) - (base.left + (fromLead ? fromLead.offsetLeft : 0));
    var y = to.top - base.top;
    b.to({ x: x, y: y, r: 0, s: 1 }, "travel", {
      done: function () {
        target.style.opacity = "";
        // The shadow sinks into the row, and the copy fades off the row that is now under it.
        ghost.animate([{ opacity: 1 }, { opacity: 0, boxShadow: "none" }], { duration: 120, easing: "ease-out", fill: "forwards" }).finished.then(function () { ghost.remove(); });
      },
    });
  }

  /** Moves the current row's fill and its edge under the current row, at once: the rows move under it. */
  function placePuck(host, s) {
    var puck = document.getElementById("puck");
    var node = host.querySelector('[data-key="' + s.focus + '"]');
    if (!node || s.loading) { puck.hidden = true; return; }
    puck.hidden = false;
    puck.style.transform = "translateY(" + (host.offsetTop + node.offsetTop) + "px)";
    puck.style.height = node.offsetHeight + "px";
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
      var olds = Array.prototype.slice.call(host.children);
      var oldKeys = new Set(olds.map(function (n) { return n.dataset.key; }));
      var newKeys = new Set(s.rows.map(function (r) { return r.key; }));
      // A thing that leaves one row for another (a row into a group, a member back out) flies.
      var arriving = new Set(s.rows.filter(function (r) { return r.thing && !oldKeys.has(r.key); }).map(function (r) { return r.thing.id; }));
      var ghosts = olds.filter(function (n) { return !newKeys.has(n.dataset.key); }).map(function (n) {
        var flies = n.dataset.id && arriving.has(n.dataset.id);
        if (flies && opts.carried && opts.carried.id === n.dataset.id) return { id: n.dataset.id, g: opts.carried.ghost, flies: true };
        var g = Motion.ghost(n, flies ? flightLayer() : leavingLayer());
        g.classList.remove("is-current", "is-moving", "is-lifted");
        g.removeAttribute("role");
        var from = Motion.body(n);
        var caught = n.classList.contains("is-moving") ? { x: from.goal.x - from.value.x + Motion.body(g).value.x, y: from.goal.y - from.value.y + Motion.body(g).value.y } : null;
        if (!flies) { var gb = Motion.body(g); gb.speed = { x: from.speed.x, y: from.speed.y, s: 0, r: 0, o: 0, l: 0 }; }
        return { id: n.dataset.id, g: g, flies: flies, caught: caught };
      });
      // Rows that change order cross each other, so each carries the list's ground while it moves.
      var keptOld = olds.map(function (n) { return n.dataset.key; }).filter(function (k) { return newKeys.has(k); });
      var keptNew = s.rows.map(function (r) { return r.key; }).filter(function (k) { return oldKeys.has(k); });
      var crossing = !Motion.isReduced() && (!!opts.link || keptOld.join("|") !== keptNew.join("|"));
      host.classList.toggle("is-crossing", crossing);
      clearTimeout(host._crossing);
      if (crossing) host._crossing = setTimeout(function () { host.classList.remove("is-crossing"); }, 520);
      // The rows after a leaving row wait for it to fade, unless rows are still moving from the last move.
      var busy = olds.some(function (n) { return n.classList.contains("is-moving"); });
      var waits = ghosts.some(function (x) { return !x.flies; }) && !opts.link && !busy;
      Motion.flip(olds.filter(function (n) { return newKeys.has(n.dataset.key); }), function () { patch(host, s); }, { spring: "hand", stagger: function () { return waits ? CLOSE_DELAY : 0; } });
      var added = Array.prototype.filter.call(host.children, function (n) { return !oldKeys.has(n.dataset.key); });
      ghosts.forEach(function (x) {
        var to = x.flies && added.find(function (n) { return n.dataset.id === x.id; });
        if (to) { added.splice(added.indexOf(to), 1); shared(x.g, to, opts.carried && opts.carried.id !== x.id); }
        else exit(x.g, opts.leave, x.caught);
      });
      // The card in the hand stays on top of everything else in flight.
      if (opts.carried && opts.carried.ghost.isConnected) flightLayer().appendChild(opts.carried.ghost);
      var how = opts.enter || (opts.link ? "link" : "unfold");
      added.forEach(function (n, i) { enter(n, how, i); });
      host.classList.toggle("is-drawer", how === "unfold" && added.length > 0);
      if (how === "unfold") setTimeout(function () { host.classList.remove("is-drawer"); }, 420);
    }
    placePuck(host, s);
    Selection.draw(s);
  }

  /** Moves the current row's mark without redrawing the list, and keeps the row in view. */
  function markFocus(host, s, opts) {
    placePuck(host, s);
    Array.prototype.forEach.call(host.children, function (c) {
      var on = c.dataset.key === s.focus;
      c.classList.toggle("is-current", on);
      c.tabIndex = on ? 0 : -1;
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
      var act = e.target.closest("[data-row-act]");
      if (act) { e.stopPropagation(); App.focusRow(key); Moves.run(act.dataset.rowAct, act); return; }
      var st = App.state;
      if (e.shiftKey && (row.thing || row.type === "group")) {
        Keys.selectRange(st.anchor || st.focus || key, key);
        st.focus = key;
        App.render({});
        return;
      }
      if (e.target.closest("[data-tick]") || ((e.metaKey || e.ctrlKey) && (row.thing || row.type === "group"))) {
        var ids = Keys.idsOf(row), all = ids.every(function (id) { return st.selection.has(id); });
        ids.forEach(function (id) { if (all) st.selection.delete(id); else st.selection.add(id); });
        st.anchor = key;
        App.render({});
        return;
      }
      st.anchor = key;
      if (row.type === "more") { Keys.showMore(row); return; }
      if (row.type === "tmore") { Moves.setScope({ triage: 1 }); return; }
      if (e.target.closest("[data-fold-group]")) { Moves.toggleGroup(key); return; }
      App.focusRow(key);
      if (App.isStacked()) App.setPaneOpen(true);
    });
    host.addEventListener("dblclick", function (e) {
      var node = e.target.closest(".row--group");
      if (node) Moves.toggleGroup(node.dataset.key);
    });
  }

  return { draw: draw, markFocus: markFocus, start: start, build: build, placePuck: placePuck };
})();
