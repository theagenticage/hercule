// PROTOTYPE - N: starting a thread from things, in the app's glass dialog around the real composer of
// the new-thread screen. It looks like a thread before it is one. Defaults come only from evidence:
// a repository of a thing, or of a thing linked to it, matched against the projects' repositories.
window.Dialog = (function () {
  "use strict";
  var K = Kinds, D = Draw;
  var PROJECTS = [
    { name: "webshop", tile: "webshop", repos: ["storefront-web", "platform-core"], profile: "Opus 5.5", effort: "High", access: "Auto-accept edits" },
    { name: "payments-api", tile: "payments", repos: ["payments-api"], profile: "Opus 5.5", effort: "High", access: "Auto-accept edits" },
    { name: "ops", tile: "ops", repos: ["infra"], profile: "Sonnet 5.5", effort: "Medium", access: "Ask before edits" },
  ];
  var STARTERS = [
    ["investigate", "Investigate"], ["fix", "Fix"], ["reply", "Draft a reply"], ["summarise", "Summarise"], ["own", "Your own words"],
  ];
  var el, st = null;
  // "No project" is a choice of its own: no code, no checkout, the user's own profile.
  var NONE = { name: "No project", none: true, tile: "", repos: [], profile: "Opus 5.5", effort: "High", access: "Ask before edits" };
  var drafts = {}; // what was typed, kept per set of things when the dialog closes unsent

  /** Finds the evidence for a project: the repository of a thing, or of a thing linked to it. Returns null with none. */
  function decideProject(things) {
    for (var i = 0; i < things.length; i++) {
      var t = things[i];
      if (t.fields.repo) {
        var p = PROJECTS.find(function (x) { return x.repos.indexOf(t.fields.repo) >= 0; });
        if (p) return { project: p, why: (D.identifier(t) || "It") + " is in " + t.fields.repo + ", one of " + p.name + "’s repositories" };
      }
    }
    for (var j = 0; j < things.length; j++) {
      var linked = Model.linksOf(things[j].id).map(function (l) { return l.other; }).find(function (o) { return o.fields.repo; });
      if (linked) {
        var q = PROJECTS.find(function (x) { return x.repos.indexOf(linked.fields.repo) >= 0; });
        if (q) return { project: q, why: (D.identifier(things[j]) || "It") + " is linked to " + D.identifier(linked) + ", in " + linked.fields.repo + ", one of " + q.name + "’s repositories" };
      }
    }
    return null;
  }

  function decideStarter(things) {
    if (things.every(function (t) { return !K.KINDS[t.kind].lasting; })) return "reply";
    return "investigate";
  }

  function writeMessage(starter, things) {
    var these = things.length === 1 ? "this" : "these " + things.length;
    var asker = things.map(function (t) { return Model.askingSignals(t)[0]; }).find(Boolean);
    switch (starter) {
      case "investigate": return "Look into " + these + " and tell me what is going on before you change anything. Say what you think the cause is, how sure you are, and what you would do next.";
      case "fix": return "Fix " + these + " and open a pull request. Keep the change small, add a test for the case, and ask me before anything needs a migration.";
      case "reply": return "Draft a reply" + (asker ? " to " + asker.by : "") + ". Don’t send it: show me the draft, and say what you checked to write it.";
      case "summarise": return "Summarise where " + these + " stand" + (things.length === 1 ? "s" : "") + ": who waits on whom, what changed this week, and what is still open.";
      default: return "";
    }
  }

  function buildContext(things, origin) {
    var lines = [];
    lines.push(origin.type === "group" ? "From your linked group “" + origin.title + "” (" + things.length + " things)" : origin.type === "proposal" ? "From the Proposal “" + origin.title + "”, made by Triage" : things.length > 1 ? "From " + things.length + " things you selected" : "From one thing in your Inbox");
    things.forEach(function (t, i) {
      var f = Object.keys(t.fields).filter(function (k) { return k !== "status"; }).map(function (k) { return k + " " + t.fields[k]; }).join(", ");
      lines.push((i + 1) + ". " + Model.sourceOf(t) + " " + (D.identifier(t) || D.noun(t).toLowerCase()) + " · " + t.title + (D.statusWord(t) ? " · " + D.statusWord(t) : "") + " · " + f + " · ent_" + t.id.replace(/-/g, ""));
    });
    var teams = things.map(function (t) { return t.fields.team; }).filter(Boolean);
    if (teams.length > 1 && new Set(teams).size === 1) lines.push("Shared: team " + teams[0]);
    lines.push("Read any of them in full: hercule entity read <id>");
    return lines;
  }

  function chip(t, i, all) {
    var removable = all.length > 1;
    return '<span class="td-chip" data-chip="' + t.id + '" title="' + D.esc(t.title) + '">' + D.mark(Model.sourceOf(t), 12) + (D.identifier(t) ? "<b>" + D.esc(D.identifier(t)) + "</b>" : "") + '<span class="td-chip-t">' + D.esc(t.title) + "</span>" + (removable ? '<button type="button" data-unchip="' + t.id + '" aria-label="Leave ' + D.esc(D.identifier(t) || t.title) + ' out">' + D.icon("close", 10) + "</button>" : "") + "</span>";
  }

  function drawWriting() {
    var p = st.project;
    var lip = p && p.project.none
      ? '<button type="button" class="lip-pick" data-why="project">' + D.icon("chat", 14) + "No project" + D.icon("chevron-down", 10) + '</button><span class="lip-note">No checkout</span>'
      : p
      ? '<button type="button" class="lip-pick" data-why="project" aria-haspopup="menu" aria-expanded="false" aria-controls="td-pop">' + D.icon("folder", 14) + D.esc(p.project.name) + D.icon("chevron-down", 10) + '</button><button type="button" class="lip-pick" data-why="workspace">' + D.icon("branch", 14) + "New workspace from main</button>"
      : '<button type="button" class="lip-pick lip-pick--ask" data-why="project" aria-haspopup="menu" aria-expanded="false" aria-controls="td-pop">' + D.icon("folder", 14) + "Choose a project" + D.icon("chevron-down", 10) + "</button>";
    var why = p && p.project.none ? "<b>No project</b>: the agent works without code or a checkout, with your own profile, and asks before it edits anything." : p ? "<b>" + D.esc(p.project.name) + "</b> because " + D.esc(p.why) + ". Its profile and access come with it." : "Nothing here points at a repository, so no project is picked. Choose one, or start it without code.";
    var ready = !!p && st.text.trim() && st.things.length;
    el.innerHTML =
      '<header class="td-head"><span class="td-face">' + D.face("New thread", "idle", 28) + '</span><div class="td-name"><input class="td-title" value="' + D.esc(st.title) + '" aria-label="The Task’s name" data-title><span class="td-sub">A new Task on Work, with a thread on it' + (st.origin.type === "proposal" ? " · accepts the Proposal" : "") + '</span></div><button type="button" class="icon-btn" data-close title="Close (Esc)" aria-label="Close">' + D.icon("close", 16) + "</button></header>" +
      '<div class="td-body"><div class="td-starters" role="radiogroup" aria-label="Start from">' + STARTERS.map(function (s) { return '<button type="button" role="radio" class="td-starter" aria-checked="' + (st.starter === s[0]) + '" data-starter="' + s[0] + '">' + s[1] + "</button>"; }).join("") + "</div>" +
      '<div class="composer td-composer"><div class="composer-card"><div class="td-chips">' + st.things.map(chip).join("") + '</div><div class="composer-field"><textarea class="composer-input td-text" rows="4" aria-label="Message" placeholder="Say what you want done…" data-text>' + D.esc(st.text) + '</textarea></div><div class="composer-row">' +
      '<button type="button" class="icon-btn" title="Attach images" aria-label="Attach">' + D.icon("plus", 16) + '</button><button type="button" class="pick' + (p ? "" : " is-off") + '" data-why="access">' + D.icon("shield", 14) + (p ? p.project.access : "Access") + '</button><button type="button" class="pick' + (p ? "" : " is-off") + '" data-why="profile">' + D.icon("sliders", 14) + (p ? p.project.effort : "Effort") + '</button><span class="spacer"></span><button type="button" class="pick pick--pill' + (p ? "" : " is-off") + '" data-why="profile"><span class="pick-name">' + (p ? p.project.profile : "Profile") + '</span></button><button type="button" class="icon-btn" title="Dictate" aria-disabled="true">' + D.icon("mic", 16) + '</button><button type="button" class="send' + (ready ? "" : " send--off") + '" data-send title="' + (p ? "Start the thread (⌘↩)" : "Choose a project first") + '"' + (ready ? "" : ' aria-disabled="true"') + ">" + D.icon("send", 16) + "</button></div></div>" +
      '<div class="lip">' + lip + '<span class="spacer"></span><button type="button" class="lip-pick">' + D.icon("laptop", 14) + "studio-mac</button></div></div>" +
      '<p class="td-why">' + D.icon("info", 14) + "<span>" + why + "</span></p></div>";
    var ta = el.querySelector("[data-text]");
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  function liveCard(t) {
    var w = D.statusWord(t);
    return '<div class="td-card">' + '<p class="td-card-top">' + D.mark(Model.sourceOf(t), 14) + "<span>" + D.esc(K.SOURCES[Model.sourceOf(t)].name + " · " + D.noun(t)) + "</span>" + (D.identifier(t) ? "<b>" + D.esc(D.identifier(t)) + "</b>" : "") + '</p><p class="td-card-title">' + D.esc(t.title) + '</p><p class="td-card-st">' + (w ? D.glyph(t, 12) + "<span>" + D.esc(w) + "</span>" : "") + (t.fields.events != null ? '<span class="td-live" data-live-events>' + D.num(t.fields.events) + " events</span>" : "<span>" + D.esc(D.place(t)) + "</span>") + "</p></div>";
  }

  function drawTranscript() {
    var ctx = buildContext(st.things, st.origin);
    el.innerHTML =
      '<header class="td-head"><span class="td-face">' + D.face("New thread", "working", 28) + '</span><div class="td-name"><p class="td-title td-title--fixed">' + D.esc(st.title) + '</p><span class="td-sub">Thread started · ' + D.esc(st.project.project.none ? "no project" : st.project.project.name) + " · " + D.esc(st.project.project.profile) + " · " + D.esc(st.project.project.effort) + '</span></div><button type="button" class="icon-btn" data-close title="Close (Esc)" aria-label="Close">' + D.icon("close", 16) + "</button></header>" +
      '<div class="td-body td-live-body"><div class="td-msg td-msg--you"><p class="td-msg-text">' + D.esc(st.text) + '</p><div class="td-cards">' + st.things.map(liveCard).join("") + '</div><button type="button" class="td-ctx" aria-expanded="false" data-ctx>' + D.icon("chevron-right", 12) + "Context sent with it<span>" + ctx.length + ' lines</span></button><pre class="td-ctx-body" hidden>' + ctx.map(D.esc).join("\n") + '</pre><time>09:41</time></div>' +
      '<div class="td-msg td-msg--agent"><p class="td-agent-who">' + D.face("New thread", "working", 20) + "<span>Anthropic · " + D.esc(st.project.project.profile) + ' · 09:41</span></p><ol class="td-tools">' + st.things.slice(0, 4).map(function () { return '<li class="is-waiting"><code>&nbsp;</code></li>'; }).join("") + '</ol><p class="td-stream"></p></div></div>' +
      '<footer class="td-foot"><span class="td-foot-note">' + (st.things.length === 1 ? "It is" : "All " + st.things.length + " are") + ' on this Task now</span><span class="spacer"></span><button type="button" class="btn btn--quiet" data-close>Back to the Inbox<kbd>Esc</kbd></button><button type="button" class="btn btn--answer" data-open-thread>Open the thread<kbd>↩</kbd></button></footer>';
    playFirstMoments();
    el.querySelector("[data-open-thread]").focus({ preventScroll: true });
  }

  function playFirstMoments() {
    var tools = el.querySelector(".td-tools"), stream = el.querySelector(".td-stream");
    var steps = st.things.slice(0, 4);
    var gen = st.gen;
    var reduced = Motion.isReduced();
    steps.forEach(function (t, i) {
      setTimeout(function () {
        if (gen !== st.gen) return;
        var li = tools.children[i];
        li.classList.remove("is-waiting");
        li.innerHTML = '<code>hercule entity read ent_' + D.esc(t.id.replace(/-/g, "")) + '</code><span class="td-ok">' + D.icon("check", 12) + D.esc(D.identifier(t) || D.noun(t)) + "</span>";
        if (!reduced) Motion.animate(li, [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" });
      }, reduced ? 0 : 500 + i * 260);
    });
    var first = st.things.find(function (t) { return t.fields.users != null; }) || st.things[0];
    var kinds = [];
    st.things.forEach(function (t) { var n = D.noun(t).toLowerCase(); if (kinds.indexOf(n) < 0) kinds.push(n); });
    var other = st.things.find(function (t) { return t !== first && t.fields.repo; });
    var text = st.things.length > 1
      ? "I read all " + st.things.length + ": " + (kinds.length > 1 ? kinds.slice(0, -1).join(", ") + " and " + kinds[kinds.length - 1] : kinds[0] + "s") + ". I’ll start with " + (D.identifier(first) || "“" + first.title + "”") + (first.fields.users ? ", which has reached " + D.num(first.fields.users) + " people" : ", which has waited longest") + (other ? ", and read it against the change in " + D.identifier(other) + " next." : ", and say what I find before changing anything.")
      : "I’ll start by reading " + (D.identifier(first) || "it") + " in full, and say what I find before changing anything.";
    var at = reduced ? 0 : 500 + steps.length * 260 + 240, i = 0;
    setTimeout(function tick() {
      if (gen !== st.gen) return;
      if (reduced) { stream.textContent = text; return; }
      i = Math.min(text.length, i + 3);
      stream.textContent = text.slice(0, i);
      if (i < text.length) setTimeout(tick, 28);
    }, at);
    setTimeout(function () {
      if (gen !== st.gen) return;
      var ev = el.querySelector("[data-live-events]");
      if (ev) { ev.textContent = D.num(first.fields.events + 7) + " events"; ev.classList.add("is-ticked"); }
    }, 2400);
  }

  function why(button) {
    var pop = document.getElementById("td-pop");
    var k = button.dataset.why;
    var p = st.project;
    var words = p && p.project.none && k !== "project" ? "Your own default, because no project is picked." : !p ? (k === "project" ? null : "Comes from the project you choose.") :
      k === "project" ? "Chosen because " + p.why + "." :
      k === "workspace" ? "The work may change code, so it gets its own worktree of " + p.project.name + " on a new branch from main." :
      k === "access" ? p.project.access + " is " + p.project.name + "’s access: it may edit files in its own workspace, and anything else asks you." :
      p.project.profile + " · " + p.project.effort + " is " + p.project.name + "’s profile.";
    var html;
    if (k === "project") {
      html = '<p class="td-pop-h">' + (p ? "Project" : "No project is picked") + "</p>" + (words ? '<p class="td-pop-why">' + D.esc(words) + "</p>" : '<p class="td-pop-why">Nothing here points at a repository.</p>') + PROJECTS.map(function (x) {
        return '<button type="button" class="menu-pick" data-pick-project="' + x.name + '"><span class="proj proj--' + x.tile + '"><span class="proj-name">' + x.name + "</span></span><small>" + x.repos.join(", ") + "</small>" + (p && p.project === x ? D.icon("check", 14) : "") + "</button>";
      }).join("") + '<i class="menu-line"></i><button type="button" class="menu-pick" data-pick-project="">' + D.icon("chat", 14) + "<span>No project: no code, no checkout</span>" + (p && p.project.none ? D.icon("check", 14) : "") + "</button>";
    } else html = '<p class="td-pop-why">' + D.esc(words) + "</p>";
    pop.innerHTML = html;
    var r = button.getBoundingClientRect();
    pop.hidden = false;
    var h = pop.offsetHeight;
    pop.style.left = Math.max(12, r.left) + "px";
    pop.style.top = (r.bottom + 6 + h > innerHeight - 12 ? r.top - h - 6 : r.bottom + 6) + "px";
    var first = pop.querySelector(".menu-pick");
    if (first) { first.classList.add("is-active"); first.focus({ preventScroll: true }); }
    popBack = button;
    button.setAttribute("aria-expanded", "true");
  }
  var popBack = null;
  function closePop() {
    var pop = document.getElementById("td-pop");
    if (pop.hidden) return false;
    pop.hidden = true;
    if (popBack) { popBack.setAttribute("aria-expanded", "false"); if (popBack.isConnected) popBack.focus({ preventScroll: true }); }
    return true;
  }

  function open(things, origin) {
    if (!things.length) return;
    el = document.getElementById("dialog");
    var scrim = document.getElementById("scrim");
    var title = origin.type === "group" || origin.type === "proposal" ? origin.title : things[0].title;
    var starter = decideStarter(things);
    var draftKey = things.map(function (t) { return t.id; }).sort().join(",");
    var kept = drafts[draftKey];
    st = { things: things.slice(), origin: origin, title: kept ? kept.title : title, starter: kept ? kept.starter : starter, text: kept ? kept.text : writeMessage(starter, things), project: kept ? kept.project : decideProject(things), gen: (st ? st.gen : 0) + 1, phase: "writing", back: document.activeElement, draftKey: draftKey, edited: !!kept };
    scrim.hidden = false;
    el.hidden = false;
    // Modal: the page behind is out of reach of the keyboard and of assistive technology.
    document.getElementById("root").inert = true;
    drawWriting();
    if (!Motion.isReduced()) {
      Motion.animate(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
      // Opacity is quick and on its own, so nothing reads through the composer; the move rides travel.
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 100, easing: "ease-out" });
      var b = Motion.body(el); b.set({ y: 14, s: 0.98 }); b.to({ y: 0, s: 1 }, "travel", { done: function () { b.clear(); } });
      el.querySelectorAll(".td-chip").forEach(function (c, i) { Motion.animate(c, [{ opacity: 0, transform: "translateX(-6px)" }, { opacity: 1, transform: "none" }], { duration: 200, delay: 90 + i * 30, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" }); });
    }
  }

  function close() {
    if (!el || el.hidden) return;
    var scrim = document.getElementById("scrim");
    closePop();
    st.gen++;
    // Closing never throws away what was typed: it is kept for these things, and the line says so.
    if (st.phase === "writing" && st.edited) { drafts[st.draftKey] = { text: st.text, title: st.title, starter: st.starter, project: st.project }; setTimeout(function () { Moves.say("Your words are kept. N on the same things opens them again."); }, 0); }
    if (st.phase === "writing" && !st.edited) delete drafts[st.draftKey];
    var started = st.phase === "started";
    document.getElementById("root").inert = false;
    var done = function () {
      el.hidden = true; scrim.hidden = true; Motion.body(el).clear();
      // The focus goes back where it was; when that is gone (the thread took the last row), to the
      // current row, or else to the empty state.
      if (st.back && st.back.isConnected && st.back.focus && !st.back.closest("[inert]")) st.back.focus({ preventScroll: true });
      else App.settleFocus();
      // The thread's undo line played under the dialog; it is said again now that it can be reached.
      if (started) { var l = Moves.last(); if (l) Undo.show(l.say, { undo: true, action: l.action }); }
    };
    if (Motion.isReduced()) { done(); return; }
    var fade = scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: "ease-in", fill: "forwards" });
    var out = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: "ease-in", fill: "forwards" });
    Motion.body(el).to({ y: 8, s: 0.985 }, "hand", { done: function () { done(); fade.cancel(); out.cancel(); } });
  }

  function send() {
    if (!st.project || !st.text.trim() || !st.things.length) {
      if (!st.project) { var b = el.querySelector('[data-why="project"]'); why(b); }
      return;
    }
    st.phase = "started";
    delete drafts[st.draftKey];
    var things = st.things.slice(), title = st.title, proposal = st.origin.proposal, was = App.state.focus;
    Moves.holdPlace();
    things.forEach(function (t) { t.held = { by: "New thread", task: title, since: 0 }; });
    if (st.origin.proposal) Model.gone.add(st.origin.proposal.id);
    var reduced = Motion.isReduced();
    var h0 = el.offsetHeight;
    var card = el.querySelector(".composer-card").getBoundingClientRect();
    // The writing becomes the thread in one step: the message rises from where the composer was, and the
    // dialog's height springs to the transcript's, which has room kept for its first lines.
    drawTranscript();
    if (!reduced) {
      var h1 = el.offsetHeight;
      el.style.height = h0 + "px";
      Motion.value(h0, function (h) { el.style.height = h + "px"; }).to(h1, "travel", function () { el.style.height = ""; });
      var you = el.querySelector(".td-msg--you .td-msg-text");
      var b = Motion.body(you); b.set({ y: card.top - you.getBoundingClientRect().top }); b.to({ y: 0 }, "travel", { done: function () { b.clear(); } });
      el.querySelectorAll(".td-cards, .td-ctx, .td-msg--you time").forEach(function (x) { x.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, delay: 90, easing: "ease-out", fill: "backwards" }); });
    }
    App.render({ flip: true, leave: "taken" });
    Moves.push({ say: "Started a thread on " + quote(title), action: { label: "Open it", key: "G", task: title }, undo: function () {
      things.forEach(function (t) { delete t.held; });
      // A thread started from a Proposal takes it back too, and the row it came from is current again.
      if (proposal) Model.gone.delete(proposal.id);
      App.state.focus = was;
      Moves.redraw({ enter: "return" });
    }, undone: "Stopped the thread before it did anything." });
  }
  function quote(t) { return "“" + (t.length > 40 ? t.slice(0, 38) + "…" : t) + "”"; }

  function pickProject(name) {
    var proj = PROJECTS.find(function (x) { return x.name === name; });
    st.project = proj ? { project: proj, why: "you chose it" } : { project: NONE, why: "you chose to start it without code" };
    st.edited = true;
    closePop();
    drawWriting();
  }

  function start() {
    el = document.getElementById("dialog");
    var pop = document.getElementById("td-pop");
    pop.addEventListener("click", function (e) { var pp = e.target.closest("[data-pick-project]"); if (pp) pickProject(pp.dataset.pickProject); });
    pop.addEventListener("keydown", function (e) {
      var items = Array.prototype.slice.call(pop.querySelectorAll(".menu-pick"));
      var at = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { var n = items[Math.max(0, Math.min(items.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))]; items.forEach(function (b) { b.classList.toggle("is-active", b === n); }); n.focus(); e.preventDefault(); }
      else if (e.key === "Escape") { closePop(); e.preventDefault(); }
      else if (e.key === "Tab") { closePop(); }
      e.stopPropagation();
    });
    el.addEventListener("click", function (e) {
      if (e.target.closest("[data-close]")) { close(); return; }
      var s0 = e.target.closest("[data-starter]");
      if (s0) {
        st.starter = s0.dataset.starter;
        var ta = el.querySelector("[data-text]");
        var next = writeMessage(st.starter, st.things);
        // Replaced through the field, so ⌘Z in the field brings your own words back.
        ta.focus(); ta.select(); if (!document.execCommand("insertText", false, next)) ta.value = next;
        st.text = ta.value;
        el.querySelectorAll("[data-starter]").forEach(function (b) { b.setAttribute("aria-checked", String(b.dataset.starter === st.starter)); });
        return;
      }
      var u = e.target.closest("[data-unchip]");
      if (u) { st.things = st.things.filter(function (t) { return t.id !== u.dataset.unchip; }); st.project = decideProject(st.things); drawWriting(); return; }

      var w = e.target.closest("[data-why]");
      if (w) { why(w); return; }
      if (e.target.closest("[data-send]")) { send(); return; }
      var c = e.target.closest("[data-ctx]");
      if (c) { var open = c.getAttribute("aria-expanded") !== "true"; c.setAttribute("aria-expanded", String(open)); el.querySelector(".td-ctx-body").hidden = !open; return; }
      if (e.target.closest("[data-open-thread]")) { close(); Moves.say("Opening “" + st.title + "”…"); return; }
      closePop();
    });
    el.addEventListener("input", function (e) {
      if (e.target.matches("[data-text]")) {
        st.text = e.target.value;
        st.edited = true;
        var send = el.querySelector("[data-send]");
        var ready = !!st.project && st.text.trim() && st.things.length;
        send.classList.toggle("send--off", !ready);
        if (ready) send.removeAttribute("aria-disabled"); else send.setAttribute("aria-disabled", "true");
        if (st.starter !== "own" && st.text !== writeMessage(st.starter, st.things)) { st.starter = "own"; el.querySelectorAll("[data-starter]").forEach(function (b) { b.setAttribute("aria-checked", String(b.dataset.starter === "own")); }); }
      }
      if (e.target.matches("[data-title]")) { st.title = e.target.value; st.edited = true; }
    });
    el.addEventListener("keydown", function (e) {
      if (e.key === "Tab") {
        // The focus stays inside the dialog: it is modal.
        var f = Array.prototype.slice.call(el.querySelectorAll("button:not([aria-disabled=true]), input, textarea, [tabindex='0']")).filter(function (x) { return x.offsetParent; });
        var i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { f[f.length - 1].focus(); e.preventDefault(); }
        else if (!e.shiftKey && i === f.length - 1) { f[0].focus(); e.preventDefault(); }
      }
      if (e.key === "Escape") { if (!closePop()) close(); e.preventDefault(); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && st.phase === "writing") { send(); e.preventDefault(); }
      else if (e.key === "Enter" && st.phase === "started" && !e.target.closest("button")) { close(); Moves.say("Opening “" + st.title + "”…"); e.preventDefault(); }
      e.stopPropagation();
    });
    document.getElementById("scrim").addEventListener("click", close);
  }

  return { open: open, close: close, start: start, isOpen: function () { return el && !el.hidden; }, PROJECTS: PROJECTS };
})();
