// PROTOTYPE - every move on the page, each with one undo on the shared ⌘Z stack. A move changes the
// state, then the list redraws with motion: what leaves slides away, what stays closes up on the hand
// spring, and a thing that moves between a row and a group flies to its new place.
window.Moves = (function () {
  "use strict";
  var D = Draw;
  var stack = [];

  function s() { return App.state; }
  function redraw(opts) { App.render(Object.assign({ flip: true }, opts || {})); }

  /** Remembers the current row's position, so the row that takes its place becomes current after a move. */
  function holdPlace() {
    var i = s().rows.findIndex(function (r) { return r.key === s().focus; });
    s().focusHint = i;
  }

  function say(text, opts) { Undo.show(text, opts || {}); }
  /** Puts a move on the shared undo stack and says it. Offline, the move waits in the outbox, and the line says so. */
  function push(entry) {
    stack.push(entry);
    if (s().offline) { s().outbox = (s().outbox || 0) + 1; Bar.draw(s()); }
    say(entry.say, { undo: true, action: entry.action, note: s().offline ? "Waits until you’re back online." : entry.note });
  }
  function last() { return stack[stack.length - 1] || null; }
  function undo() {
    var e = stack.pop();
    if (!e) { say("Nothing to undo."); return; }
    if (s().offline && s().outbox) { s().outbox--; Bar.draw(s()); }
    e.undo();
    say(e.undone || "Undone.", {});
  }

  function setScope(scope) {
    var st = s();
    st.scope = scope;
    st.search = { text: "", clauses: [] };
    st.focus = null;
    st.selection.clear();
    Bar.clear();
    App.render({});
    var list = document.getElementById("list-scroll");
    if (list) list.scrollTop = 0;
  }

  function toggleSelect(id) {
    var st = s();
    if (st.selection.has(id)) st.selection.delete(id); else st.selection.add(id);
    App.render({});
  }

  function toggleGroup(key, want) {
    var st = s();
    var open = want == null ? !st.open.has(key) : want;
    if (open === st.open.has(key)) return;
    if (open) st.open.add(key); else { st.open.delete(key); if (st.focus && st.focus.indexOf("m:" + key.slice(2) + ":") === 0) st.focus = key; }
    redraw({ enter: "unfold" });
  }

  function titleOf(things) {
    var r = App.currentRow();
    if (!s().selection.size && r && r.type === "group") return r.group.label;
    return things[0] ? things[0].title : "";
  }
  function quote(t) { return "“" + (t.length > 44 ? t.slice(0, 42) + "…" : t) + "”"; }

  // ---- Dismiss: a thing, a whole group, or the selection, with one undo ----
  function dismiss() {
    var r = App.currentRow();
    if (r && r.type === "link" && !s().selection.size) return notRelated(r);
    if (r && r.type === "proposal" && !s().selection.size) return dismissProposal(r);
    var things = App.acted();
    if (!things.length) return;
    var isGroup = !s().selection.size && r && r.type === "group";
    var outside = isGroup ? r.group.members.length - r.hits.length : 0;
    holdPlace();
    things.forEach(function (t) { Model.gone.add(t.id); });
    s().selection.clear();
    redraw({ leave: "dismiss" });
    push({
      say: isGroup ? "Dismissed the group " + quote(r.group.label) + ": " + things.length + " things" + (outside ? ", " + outside + " of them not in this list" : "") : things.length === 1 ? "Dismissed " + quote(things[0].title) : "Dismissed " + things.length + " things",
      undo: function () { things.forEach(function (t) { Model.gone.delete(t.id); }); redraw({ enter: "return" }); },
      undone: "Back in your Inbox.",
    });
  }

  // ---- Take it on: one Task, named after the group or the thing ----
  function takeOn() {
    var r = App.currentRow();
    if (r && r.type === "proposal" && !s().selection.size) return accept(r, false);
    var things = App.acted().filter(function (t) { return !t.held; });
    if (!things.length) { say("You already have this on a Task. G goes to it."); return; }
    var title = titleOf(things);
    holdPlace();
    things.forEach(function (t) { t.held = { by: "you", task: title, since: 0 }; });
    s().selection.clear();
    Flights.toWork(things);
    redraw({ leave: "taken" });
    push({
      say: "Took it on: a Task on Work, " + quote(title),
      action: { label: "Go to the Task", key: "G", task: title },
      undo: function () { things.forEach(function (t) { delete t.held; }); redraw({ enter: "return" }); },
      undone: "The Task is gone, and nothing had started.",
    });
  }

  // ---- Hand-off: single things only, one workflow at once, several by the menu ----
  function handOff(fromButton) {
    var st = s();
    if (st.selection.size > 1) { say("Hand-off takes one thing at a time. Start a thread on all " + st.selection.size + " with N instead."); return; }
    var r = App.currentRow();
    if (r && r.type === "group") { say("Hand-off takes one thing at a time. Open the group and pick one, or start a thread on all of it with N."); return; }
    var t = st.selection.size ? Model.byId(Array.from(st.selection)[0]) : r && r.thing;
    if (!t) return;
    if (t.held) { say((t.held.by === "you" ? "You have" : t.held.by + " has") + " this already. G goes to its Task."); return; }
    var offers = Model.offersFor(t).filter(function (o) { return !o.off; });
    if (!offers.length) { say("No workflow takes " + D.noun(t).toLowerCase() + "s yet."); return; }
    if (offers.length === 1) return handTo(t, offers[0]);
    Menus.hand(t, fromButton);
  }

  function handTo(t, offer) {
    var row = App.el.list.querySelector('[data-id="' + t.id + '"]');
    var ended = Model.openSignals(t).filter(function (sg) { return offer.w.ends.indexOf(sg.kind) >= 0; });
    holdPlace();
    var cancelled = false;
    // The data changes first, so the counts are right at once and a second H refuses. The row leaves
    // when the colleague's mark lands on Work.
    t.held = { by: offer.w.name, task: t.title, since: 0 };
    ended.forEach(function (sg) { sg.done = true; });
    Rail.draw(App.el.rail, s());
    var c = document.querySelector("[data-inbox-count]");
    if (c) c.textContent = Model.countSaved("waits");
    var finish = function () { if (!cancelled) redraw({ leave: "taken" }); };
    if (row) Flights.handChain(row, t, offer.w.name, finish); else finish();
    push({
      say: "Handed " + quote(t.title) + " to " + offer.w.name,
      action: { label: "Go to the Task", key: "G", task: t.title },
      undo: function () {
        cancelled = true;
        delete t.held;
        ended.forEach(function (sg) { sg.done = false; });
        redraw({ enter: "return" });
        var back = App.state.rows.find(function (x) { return x.thing && x.thing.id === t.id; });
        if (back) App.focusRow(back.key);
      },
      undone: "Took back " + offer.w.name + ". Nothing had started.",
    });
  }

  // ---- Link: the selection with L, a row dropped on another, or a suggestion accepted ----
  function link(ids, how, carried) {
    var st = s();
    ids = ids.filter(function (id, i) { return ids.indexOf(id) === i; });
    if (ids.length < 2) return false;
    var added = [];
    for (var i = 1; i < ids.length; i++) {
      var a = ids[0], b = ids[i];
      var exists = Model.links().some(function (l) { return (l[0] === a && l[1] === b) || (l[0] === b && l[1] === a); });
      if (!exists) { var l = [a, b, { type: "person", by: "you" }]; Model.links().push(l); added.push(l); }
    }
    var g = Model.groupOf(ids[0]);
    var gkey = "g:" + g.lead.id;
    var wasOpen = st.open.has(gkey);
    st.open.add(gkey);
    st.selection.clear();
    st.focus = gkey;
    redraw({ link: true, carried: carried });
    var names = ids.map(function (id) { var t = Model.byId(id); return D.identifier(t) || quote(t.title); });
    push({
      say: "Linked " + (names.length === 2 ? names[0] + " and " + names[1] : names.length + " things"),
      undo: function () {
        added.forEach(function (l) { var k = Model.links().indexOf(l); if (k >= 0) Model.links().splice(k, 1); });
        if (!wasOpen) st.open.delete(gkey);
        st.focus = "r:" + ids[0];
        redraw({ link: true });
      },
      undone: "Unlinked. The sources were never told.",
    });
    return true;
  }

  function linkKey() {
    var st = s();
    var r = App.currentRow();
    if (r && r.type === "link" && !st.selection.size) return acceptLink(r);
    if (st.selection.size >= 2) return link(Array.from(st.selection), "key");
    if (st.selection.size === 1 && r && r.thing && !st.selection.has(r.thing.id)) return link([r.thing.id, Array.from(st.selection)[0]], "key");
    if (r && (r.thing || r.type === "group")) return Menus.linkTo(r.thing || r.group.lead);
    say("Select two or more with X, then press L to link them.");
  }

  function unlink(a, b) {
    var ls = Model.links();
    var i = ls.findIndex(function (l) { return (l[0] === a && l[1] === b) || (l[0] === b && l[1] === a); });
    if (i < 0) return;
    var removed = ls.splice(i, 1)[0];
    redraw({ link: true });
    push({
      say: "Unlinked " + (D.identifier(Model.byId(a)) || "it") + " and " + (D.identifier(Model.byId(b)) || "it"),
      undo: function () { ls.push(removed); redraw({ link: true }); },
      undone: "Linked again.",
    });
  }

  // ---- Triage ----
  function acceptLink(r) {
    var x = r.item;
    holdPlace();
    Model.gone.add(x.id);
    var ok = link(x.things.map(function (t) { return t.id; }), "suggestion");
    if (!ok) redraw({});
  }
  function notRelated(r) {
    var x = r.item;
    holdPlace();
    Model.gone.add(x.id);
    redraw({ leave: "dismiss" });
    push({ say: "Not related. Hercule won’t suggest this pair again.", undo: function () { Model.gone.delete(x.id); redraw({ enter: "return" }); } });
  }
  function dismissProposal(r) {
    holdPlace();
    Model.gone.add(r.item.id);
    redraw({ leave: "dismiss" });
    push({ say: "Dismissed the Proposal " + quote(r.item.title), undo: function () { Model.gone.delete(r.item.id); redraw({ enter: "return" }); } });
  }
  function accept(r, thread) {
    var x = r.item;
    if (thread) { Dialog.open(r.things, { type: "proposal", title: x.title, proposal: x }); return; }
    holdPlace();
    Model.gone.add(x.id);
    r.things.forEach(function (t) { t.held = { by: "you", task: x.title, since: 0 }; });
    redraw({ leave: "taken" });
    push({
      say: "Accepted: a Task in the backlog, " + quote(x.title),
      action: { label: "Go to the Task", key: "G" },
      undo: function () { Model.gone.delete(x.id); r.things.forEach(function (t) { delete t.held; }); redraw({ enter: "return" }); },
    });
  }

  // ---- Answers, scoped to one signal ----
  function findSignal(id) {
    var found = null;
    Model.all().some(function (t) { var sg = t.signals.find(function (x) { return x.id === id; }); if (sg) { found = { t: t, s: sg }; return true; } return false; });
    return found;
  }
  function answer(sigId, answerId, button) {
    var f = findSignal(sigId);
    if (!f) return;
    var a = Kinds.SIGNALS[f.s.kind].answers.find(function (x) { return x.id === answerId; });
    if (a.field) return Reply.open(button, f, a);
    settle(f, a.label === "Approve" ? "Approved " + (D.identifier(f.t) || "it") + " on " + Kinds.SOURCES[Model.sourceOf(f.t)].name : a.label + " " + (D.identifier(f.t) || quote(f.t.title)) + " on " + Kinds.SOURCES[Model.sourceOf(f.t)].name, true);
  }
  /** Closes one signal and says so. A thing whose last ask closed leaves a list of asks. */
  /**
   * Closes one signal and says so. An answer that acts on the source (Approve, Reply) is held for the
   * undo line's eight seconds before it is sent, as mail apps hold a sent mail, so ⌘Z takes back every
   * move the same way. A thing whose last ask closed leaves a list of asks.
   */
  function settle(f, words, external) {
    holdPlace();
    f.s.done = true;
    redraw({ leave: "dismiss" });
    push({
      say: words,
      note: external ? "Sends in 8s" : null,
      undo: function () { f.s.done = false; redraw({ enter: "return" }); },
      undone: external ? "Not sent. The ask is open again." : "The ask is open again.",
    });
  }
  function markDone(sigId) {
    var f = findSignal(sigId);
    if (f) settle(f, "Done: " + Kinds.SIGNALS[f.s.kind].ends + " on " + (D.identifier(f.t) || quote(f.t.title)), false);
  }

  function reveal(id) {
    var st = s();
    var row = st.rows.find(function (r) { return r.thing && r.thing.id === id; });
    if (!row) {
      var g = Model.groupOf(id);
      if (g) { st.open.add("g:" + g.lead.id); App.render({}); row = st.rows.find(function (r) { return r.thing && r.thing.id === id; }); }
    }
    if (row) App.focusRow(row.key, { keyboard: false });
    else say("It isn’t in this list. Everything (5) shows it.");
  }

  function goTo(task) {
    if (typeof task !== "string") {
      var t = App.acted()[0];
      var recent = last();
      // Right after a move that made a Task, G goes to that Task, wherever the current row now is.
      if ((!t || !t.held) && recent && recent.action && recent.action.task && document.getElementById("undo").classList.contains("is-on")) task = recent.action.task;
      else if (!t || !t.held) { say("This has no Task yet. T takes it on."); return; }
      else task = t.held.task;
    }
    say("Going to " + quote(task) + " on Work…");
  }

  function run(name, button) {
    var r = App.currentRow();
    if (name === "thread") { if (r && r.type === "proposal") return accept(r, true); var th = App.acted(); if (th.length) Dialog.open(th, s().selection.size ? { type: "selection" } : r.type === "group" ? { type: "group", title: r.group.label } : { type: "thing" }); return; }
    if (name === "take" || name === "accept") return takeOn();
    if (name === "hand" && button && button.closest && button.closest(".row-acts")) return handOff(button);
    if (name === "hand") return handOff(button);
    if (name === "link") return linkKey();
    if (name === "dismiss") return dismiss();
    if (name === "goto") return goTo();
  }

  // ---- New arrivals: held behind the bar until the user asks ----
  function showNew() {
    var st = s();
    if (!st.pending.length) return;
    var fresh = st.pending.splice(0);
    fresh.forEach(function (t) { t.fresh = true; Model.add(t); });
    redraw({ enter: "arrive" });
    // New things take their place in the saved query's order, so the list goes to the first of them.
    var first = App.el.list.querySelector(fresh.map(function (t) { return '[data-id="' + t.id + '"]'; }).join(","));
    if (first) first.scrollIntoView({ block: "center", behavior: Motion.isReduced() ? "auto" : "smooth" });
    var at = App.state.rows.find(function (r) { return r.thing && fresh.indexOf(r.thing) >= 0; });
    if (at) App.focusRow(at.key);
    setTimeout(function () { fresh.forEach(function (t) { t.fresh = false; }); }, 1800);
  }

  return {
    setScope: setScope, toggleSelect: toggleSelect, toggleGroup: toggleGroup, dismiss: dismiss, takeOn: takeOn, handOff: handOff, handTo: handTo,
    link: link, linkKey: linkKey, unlink: unlink, answer: answer, settle: settle, markDone: markDone, reveal: reveal, run: run, undo: undo,
    redraw: redraw, showNew: showNew, last: last, say: say, push: push, accept: accept, goTo: goTo, holdPlace: holdPlace,
  };
})();
