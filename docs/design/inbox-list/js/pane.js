// PROTOTYPE - the pane: where a thing is from, its title, one section per open signal with its own
// answers, the plugin's blocks, then the core's sections and the core's moves in the footer.
// The same pane shows a linked group, a Proposal and a link Hercule suggests.
window.Pane = (function () {
  "use strict";
  var K = Kinds, D = Draw;
  var shownKey = null;
  var openSig = {}; // thing id -> signal id unfolded by the user

  function kbd(k) { return '<kbd aria-hidden="true">' + k + "</kbd>"; }

  // ---- Blocks: the plugin's words, drawn by type. A type the app does not know draws one quiet line. ----
  function block(b) {
    switch (b.type) {
      case "text":
        return '<section class="bk">' + (b.title ? "<h4>" + D.esc(b.title) + "</h4>" : "") + '<p class="bk-text">' + D.esc(b.text).replace(/`([^`]+)`/g, "<code>$1</code>") + "</p></section>";
      case "messages":
        return '<ol class="bk bk-msgs">' + b.items.map(function (m) {
          return '<li class="' + (m.you ? "is-you" : "") + '"><span class="bk-av" aria-hidden="true">' + D.esc(m.author.split(/[\s,]/)[0][0]) + '</span><div><p class="bk-msg-head"><b>' + D.esc(m.author) + "</b><time>" + D.ago(m.at) + '</time></p><p class="bk-msg-text">' + D.esc(m.text).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/@you/g, '<span class="at-you">@you</span>') + "</p></div></li>";
        }).join("") + "</ol>";
      case "change":
        return '<section class="bk bk-change"><p class="bk-branch">' + D.icon("branch", 14) + "<code>" + D.esc(b.head) + "</code>" + D.icon("arrow", 12) + "<code>" + D.esc(b.base) + '</code></p><p class="bk-diff"><span>' + b.files + ' files</span><span class="ins">+' + D.num(b.add) + '</span><span class="del">−' + D.num(b.del) + '</span><span class="bk-checks">' + D.esc(b.checks) + "</span></p></section>";
      case "checks":
        return '<section class="bk"><h4>Checks</h4>' + b.rows.map(function (r) {
          return '<div class="bk-check"><p class="is-' + r.state + '">' + D.icon(r.state === "failed" ? "close" : "clock", 13) + D.esc(r.name) + "</p>" + (r.log ? "<pre>" + r.log.map(D.esc).join("\n") + "</pre>" : "") + "</div>";
        }).join("") + '<p class="bk-fine">' + b.passed + " passed</p></section>";
      case "fields":
        return '<section class="bk">' + (b.title ? "<h4>" + D.esc(b.title) + "</h4>" : "") + '<dl class="bk-fields">' + b.rows.map(function (r) { return "<div><dt>" + D.esc(r[0]) + "</dt><dd>" + D.esc(r[1]) + "</dd></div>"; }).join("") + "</dl></section>";
      case "trend":
        var max = Math.max.apply(null, b.values), w = 100 / (b.values.length - 1);
        var pts = b.values.map(function (v, i) { return (i * w).toFixed(2) + "," + (30 - (v / max) * 26).toFixed(2); }).join(" ");
        return '<section class="bk"><h4>' + D.esc(b.caption) + '</h4><svg class="bk-trend" viewBox="0 0 100 32" preserveAspectRatio="none" aria-label="' + D.esc(b.caption) + ", rising to " + b.values[b.values.length - 1] + ' a day"><polyline points="' + pts + '" vector-effect="non-scaling-stroke"/></svg><p class="bk-axis"><span>14 days ago</span><span>' + D.num(b.values[b.values.length - 1]) + " today</span></p></section>";
      case "code":
        return '<section class="bk">' + (b.title ? "<h4>" + D.esc(b.title) + "</h4>" : "") + '<pre class="bk-code">' + b.lines.map(D.esc).join("\n") + "</pre></section>";
      default:
        return '<p class="bk-fine">This part can\'t be shown here.</p>';
    }
  }

  function vars(t, s) {
    return { "{ref}": D.identifier(t) || "it", "{source}": K.SOURCES[Model.sourceOf(t)].name, "{by}": s.by, "{author}": t.fields.author || s.by };
  }
  function fill(str, v) { return str.replace(/\{[a-z]+\}/g, function (k) { return v[k] || k; }); }

  /** Draws one open signal as a section: who asks what and when, its own blocks, its answers and Done. */
  function signalSection(t, s, open) {
    var sig = K.SIGNALS[s.kind];
    var v = vars(t, s);
    var answers = sig.answers.map(function (a) {
      return '<button type="button" class="btn btn--sm' + (a.primary ? " btn--answer" : "") + '"' + (a.primary ? ' aria-keyshortcuts="Enter"' : "") + ' data-answer="' + a.id + '" data-sig="' + s.id + '" data-desc="' + D.esc(fill(a.desc, v)) + '">' + D.esc(a.label) + (a.primary ? kbd("↩") : "") + "</button>";
    }).join("");
    answers += '<button type="button" class="btn btn--sm btn--quiet sig-done" data-done="' + s.id + '" data-desc="Ends this ask here. ' + D.esc(v["{source}"]) + ' is not told.">Done</button>';
    var head = D.esc(D.saySignal(s, t));
    if (s.by && head.indexOf(D.esc(s.by)) === 0) head = "<b>" + D.esc(s.by) + "</b>" + head.slice(D.esc(s.by).length);
    var first = sig.answers[0];
    return '<section class="sig' + (open ? " is-open" : "") + '" data-signal="' + s.id + '">' +
      '<button type="button" class="sig-head" aria-expanded="' + open + '" data-sig-fold="' + s.id + '"><span class="sig-dot" aria-hidden="true"></span><span class="sig-say">' + head + '</span><time>' + D.ago(s.at) + '</time><span class="sig-chev">' + D.icon("chevron-down", 12) + "</span></button>" +
      '<div class="sig-body"' + (open ? "" : " inert") + '><div class="sig-in">' + (s.blocks || []).map(block).join("") + '<div class="sig-answers">' + answers + '</div><p class="sig-desc" aria-live="polite">' + D.esc(first ? fill(first.desc, v) : "Ends this ask here. " + v["{source}"] + " is not told.") + "</p></div></div></section>";
  }

  function linkRow(l, t) {
    var o = l.other;
    var claim = l.claim.type === "source" ? l.claim.by + " reports this" : (l.claim.by === "you" ? "You linked this" : l.claim.by + " linked this");
    return '<li class="pl-row" data-goto="' + o.id + '" role="button" tabindex="0">' + D.mark(Model.sourceOf(o), 14) + '<span class="pl-title">' + D.esc(o.title) + '</span><span class="pl-id">' + D.esc(D.identifier(o)) + '</span><span class="pl-claim">' + D.esc(claim) + (l.claim.type === "person" ? '<button type="button" class="pl-unlink" data-unlink="' + t.id + "|" + o.id + '">Unlink</button>' : "") + "</span></li>";
  }

  function footer(moves) {
    return '<footer class="pn-foot">' + moves.replace('<span class="spacer"></span>', '<span class="pn-foot-end">') + (moves.indexOf('<span class="spacer"></span>') >= 0 ? "</span>" : "") + "</footer>";
  }
  function move(id, label, key, extra) {
    return '<button type="button" class="btn btn--sm pn-move' + (extra || "") + '" data-move="' + id + '" aria-keyshortcuts="' + key + '"><span class="pn-move-l">' + label + "</span>" + kbd(key) + "</button>";
  }

  function handLabel(t) {
    var offers = Model.offersFor(t).filter(function (o) { return !o.off; });
    if (!offers.length) return null;
    if (offers.length === 1) return '<span class="pn-faces">' + D.face(offers[0].w.name, "idle", 18) + "</span>" + D.esc(offers[0].w.name);
    return '<span class="pn-faces">' + D.face(offers[0].w.name, "idle", 18) + "</span>Hand to…";
  }

  function thingPane(t) {
    var src = Model.sourceOf(t);
    var accounts = Model.accountsOf(src);
    var sigs = Model.openSignals(t).filter(function (s) { return !s.quiet; }).sort(function (a, b) { return a.at - b.at; });
    var openId = openSig[t.id] || (sigs[0] && sigs[0].id);
    var st = D.statusWord(t);
    var html = '<div class="pn-scroll"><header class="pn-head"><p class="pn-from">' + D.mark(src, 14) + "<span>" + D.esc(K.SOURCES[src].name) + " · " + D.esc(D.noun(t)) + " · " + D.esc(D.place(t)) + (accounts.length > 1 ? " · " + D.esc(t.account) : "") + '</span></p><span class="pn-tools"><a class="icon-btn icon-btn--sm pn-open" href="#" title="' + D.esc(K.SOURCES[src].open) + '" aria-label="' + D.esc(K.SOURCES[src].open) + '">' + D.icon("external", 14) + '</a><button type="button" class="icon-btn icon-btn--sm" data-pane-menu title="More" aria-label="More" aria-haspopup="menu" aria-expanded="false">' + D.icon("more", 16) + "</button></span></header>";
    html += '<h2 class="pn-title">' + D.esc(t.title) + (D.identifier(t) ? ' <span class="pn-id">' + D.esc(D.identifier(t)) + "</span>" : "") + "</h2>";
    var meta = [];
    if (st) meta.push(D.glyph(t, 14) + "<span>" + D.esc(st) + "</span>");
    if (t.fields.author) meta.push("<span>" + D.esc(t.fields.author === "you" ? "You" : t.fields.author) + " opened it " + D.agoWords(t.opened) + "</span>");
    else if (t.fields.assignee) meta.push("<span>" + (t.fields.assignee === "you" ? "Assigned to you" : D.esc(t.fields.assignee) + "’s") + "</span>");
    else if (t.fields.from) meta.push("<span>From " + D.esc(t.fields.from) + "</span>");
    if (t.fields.events != null) meta.push("<span>" + D.num(t.fields.events) + " events · " + D.num(t.fields.users) + " users</span>");
    html += '<p class="pn-meta">' + meta.join('<i class="sep">·</i>') + "</p>";
    if (t.held) html += '<p class="pn-held">' + (t.held.by === "you" ? D.you(20) : D.face(t.held.by, "working", 22)) + "<span><b>" + (t.held.by === "you" ? "Your Task" : D.esc(t.held.by) + " has it") + "</b>" + D.esc(t.held.task) + '</span><button type="button" class="btn btn--sm" data-move="goto">Go to the Task' + kbd("G") + "</button></p>";
    if (sigs.length) html += '<div class="sigs">' + sigs.map(function (s) { return signalSection(t, s, s.id === openId); }).join("") + "</div>";
    html += '<div class="bks">' + t.blocks.slice(0, 8).map(block).join("") + "</div>";
    var links = Model.linksOf(t.id);
    var g = Model.groupOf(t.id);
    if (links.length) {
      html += '<section class="pn-sec"><h3 class="pn-h">Linked' + "" + (g && g.members.length > links.length + 1 ? '<span class="pn-h-n">in a group of ' + g.members.length + "</span>" : "") + '</h3><ul class="pl">' + links.map(function (l) { return linkRow(l, t); }).join("") + "</ul></section>";
    }
    if (t.history.length) {
      html += '<section class="pn-sec"><h3 class="pn-h">' + 'What happened</h3><ol class="ph">' + t.history.slice().reverse().map(function (h) { return "<li><time>" + D.ago(h[0]) + "</time><span>" + D.esc(h[1]) + "</span></li>"; }).join("") + "</ol></section>";
    }
    html += "</div>";
    var hand = handLabel(t);
    html += footer(
      move("thread", "Start a thread", "N") +
      (t.held ? "" : move("take", "Take on", "T")) +
      (hand && !t.held ? move("hand", hand, "H", " pn-move--hand") : "") +
      '<span class="spacer"></span><button type="button" class="icon-btn pn-icon" data-move="link" title="Link to… (L)" aria-label="Link to another thing" aria-keyshortcuts="L">' + D.icon("link", 16) + '</button><button type="button" class="icon-btn pn-icon" data-move="dismiss" title="Dismiss (E)" aria-label="Dismiss" aria-keyshortcuts="E">' + D.icon("archive", 16) + "</button>"
    );
    return html;
  }

  function memberRows(things, withGo) {
    return '<ul class="pm">' + things.map(function (m) {
      var why = D.reason(m);
      return '<li class="pm-row" data-goto="' + m.id + '" role="button" tabindex="0" aria-label="' + D.esc(m.title + ". " + why.replace(/<[^>]+>/g, "")) + '">' + D.mark(Model.sourceOf(m), 14) + '<span class="pm-title">' + D.esc(m.title) + '</span><span class="pm-id">' + D.esc(D.identifier(m)) + '</span><span class="pm-glyph">' + D.glyph(m, 12) + '</span><span class="pm-why">' + why + "</span></li>";
    }).join("") + "</ul>";
  }

  function groupPane(r) {
    var g = r.group;
    var srcs = [];
    g.members.forEach(function (m) { var n = K.SOURCES[Model.sourceOf(m)].name; if (srcs.indexOf(n) < 0) srcs.push(n); });
    var asking = g.members.filter(function (m) { return Model.asks(m) && !m.held; });
    var html = '<div class="pn-scroll"><header class="pn-head"><p class="pn-from">' + D.icon("link", 14) + "<span>Linked · " + g.members.length + " things in " + D.esc(srcs.join(", ")) + '</span></p></header><h2 class="pn-title">' + D.esc(g.label) + "</h2>";
    html += '<p class="pn-meta"><span>' + (asking.length ? asking.length + (asking.length === 1 ? " of them waits" : " of them wait") + " on you" : "Nothing in it waits on you") + "</span></p>";
    var order = g.members.slice().sort(function (a, b) { return (Model.asks(b) - Model.asks(a)) || ((Model.waitOf(b) || 0) - (Model.waitOf(a) || 0)); });
    html += '<section class="pn-sec pn-sec--first">' + memberRows(order) + "</section>";
    var pairs = Model.links().filter(function (l) { return g.members.some(function (m) { return m.id === l[0]; }); });
    html += '<section class="pn-sec"><h3 class="pn-h">' + 'How they are linked</h3><ul class="pc">' + pairs.map(function (l) {
      var a = Model.byId(l[0]), b = Model.byId(l[1]);
      var claim = l[2].type === "source" ? l[2].by + " reports this" : (l[2].by === "you" ? "You linked these" : l[2].by + " linked these");
      return '<li><span class="pc-pair">' + D.mark(Model.sourceOf(a), 12) + D.esc(D.identifier(a) || a.title) + '<span class="pc-dash">—</span>' + D.mark(Model.sourceOf(b), 12) + D.esc(D.identifier(b) || b.title) + '</span><span class="pl-claim">' + D.esc(claim) + (l[2].type === "person" ? '<button type="button" class="pl-unlink" data-unlink="' + a.id + "|" + b.id + '">Unlink</button>' : "") + "</span></li>";
    }).join("") + "</ul></section></div>";
    html += footer(move("thread", "Start a thread on all " + g.members.length, "N") + move("take", "Take on", "T") + '<span class="spacer"></span><button type="button" class="icon-btn pn-icon" data-move="link" title="Link another thing to this group (L)" aria-label="Link another thing">' + D.icon("link", 16) + '</button><button type="button" class="icon-btn pn-icon" data-move="dismiss" title="Dismiss all ' + g.members.length + ' (E)" aria-label="Dismiss the group">' + D.icon("archive", 16) + "</button>");
    return html;
  }

  function proposalPane(r) {
    var x = r.item;
    var html = '<div class="pn-scroll"><header class="pn-head"><p class="pn-from">' + D.face(x.by, "idle", 16) + "<span>Proposal from " + D.esc(x.by) + " · " + D.ago(x.at) + ' ago</span></p></header><h2 class="pn-title">' + D.esc(x.title) + '</h2><blockquote class="pn-why">' + D.esc(x.why) + "</blockquote>";
    html += '<section class="pn-sec pn-sec--first"><h3 class="pn-h">' + "From " + r.things.length + " things</h3>" + memberRows(r.things) + "</section>";
    html += '<section class="pn-sec"><h3 class="pn-h">' + 'The Task it makes</h3><p class="pn-task"><b>' + D.esc(x.title) + "</b><span>In the backlog of Payments · nobody on it until you start it</span></p></section></div>";
    html += footer(move("accept", "Accept", "T", " btn--answer") + move("thread", "Accept and start a thread", "N") + '<span class="spacer"></span>' + move("dismiss", "Dismiss", "E", " btn--quiet"));
    return html;
  }

  function linkPane(r) {
    var x = r.item;
    var html = '<div class="pn-scroll"><header class="pn-head"><p class="pn-from">' + D.face("Hercule", "idle", 16) + "<span>Hercule suggests a link · " + D.ago(x.at) + ' ago</span></p></header><h2 class="pn-title">Do these belong together?</h2><blockquote class="pn-why">' + D.esc(x.why) + "</blockquote>";
    html += '<section class="pn-sec pn-sec--first pn-pair">' + memberRows(r.things) + "</section>";
    html += '<p class="pn-fine">Linking makes them one group in your Inbox. Neither source is told. Not related keeps them apart, and Hercule won\'t suggest this pair again.</p></div>';
    html += footer(move("link", "Link them", "L", " btn--answer") + '<span class="spacer"></span>' + move("dismiss", "Not related", "E", " btn--quiet"));
    return html;
  }

  /** The pane of a selection of two or more: what is selected, and what a selection can do. */
  function selectionPane(s) {
    var things = Array.from(s.selection).map(Model.byId).filter(Boolean);
    var srcs = [];
    things.forEach(function (m) { var n = K.SOURCES[Model.sourceOf(m)].name; if (srcs.indexOf(n) < 0) srcs.push(n); });
    var html = '<div class="pn-scroll"><header class="pn-head"><p class="pn-from">' + D.icon("check", 14) + "<span>Selected · " + D.esc(srcs.join(", ")) + '</span></p></header><h2 class="pn-title">' + things.length + ' things selected</h2><p class="pn-meta"><span>X or ⌘-click adds and removes; ⇧ selects a range; Esc clears</span></p>';
    html += '<section class="pn-sec pn-sec--first">' + memberRows(things) + "</section></div>";
    html += footer(move("link", "Link them", "L") + move("thread", "Start a thread", "N") + move("take", "Take on", "T") + '<span class="spacer"></span><button type="button" class="icon-btn pn-icon" data-move="dismiss" title="Dismiss all ' + things.length + ' (E)" aria-label="Dismiss all ' + things.length + '">' + D.icon("archive", 16) + "</button>");
    return html;
  }

  function draw(host, s, opts) {
    opts = opts || {};
    var r = App.currentRow();
    var key = s.selection.size >= 2 ? "sel:" + Array.from(s.selection).sort().join(",") : r ? r.key : null;
    if (key === shownKey && !opts.force && !opts.walk && host.childElementCount) {
      // Same target: redraw in place without the walk, so an answer or a fold keeps the reader's place.
    }
    var scroll = host.querySelector(".pn-scroll");
    var keep = key === shownKey && scroll ? scroll.scrollTop : 0;
    var html;
    if (s.loading) { host.innerHTML = '<div class="pn-skel" aria-hidden="true"><i style="width:46%"></i><i style="width:88%;height:16px;margin-top:10px"></i><i style="width:60%;height:16px"></i><i style="width:38%"></i><i style="width:100%;height:96px;margin-top:16px;border-radius:12px"></i><i style="width:100%;height:44px;margin-top:8px;border-radius:12px"></i></div>'; shownKey = null; return; }
    if (s.selection.size >= 2) html = selectionPane(s);
    else if (!r) html = "";
    else if (r.type === "group") html = groupPane(r);
    else if (r.type === "proposal") html = proposalPane(r);
    else if (r.type === "link") html = linkPane(r);
    else if (r.type === "tmore") html = '<div class="pn-empty">' + D.icon("sparkle", 20) + "<p>" + r.n + ' more in Triage</p><button type="button" class="btn btn--sm" data-open-triage>Open Triage<kbd>↩</kbd></button></div>';
    else if (r.type === "more") html = groupPane(s.rows.find(function (x) { return x.key === r.groupKey; }));
    else html = thingPane(r.thing);
    var walked = key !== shownKey;
    // A redraw of the same thing keeps the focus on the same control, by what it does.
    var had = !walked && host.contains(document.activeElement) ? ["data-answer", "data-done", "data-move", "data-sig-fold", "data-goto"].map(function (a) { var v = document.activeElement.getAttribute(a); return v ? "[" + a + '="' + v + '"]' : null; }).filter(Boolean)[0] : null;
    host.innerHTML = html;
    var ph = host.querySelector(".pn-head");
    if (ph) ph.insertAdjacentHTML("afterbegin", '<button type="button" class="btn btn--sm btn--quiet pn-back" data-pane-back>' + D.icon("chevron-left", 12) + "List</button>");
    if (had) { var back = host.querySelector(had); if (back) back.focus({ preventScroll: true }); }
    var sc = host.querySelector(".pn-scroll");
    if (sc && !walked) sc.scrollTop = keep;
    // The pane is the answer to the key, so it changes in the same frame, with no fade.
    shownKey = key;
  }

  function start(host) {
    host.addEventListener("click", function (e) {
      var f = e.target.closest("[data-sig-fold]");
      var r = App.currentRow();
      if (f && r && r.thing) {
        var id = f.dataset.sigFold;
        var sec = f.closest(".sig");
        var opening = !sec.classList.contains("is-open");
        openSig[r.thing.id] = opening ? id : "__none";
        Signals.fold(host, sec, opening);
        return;
      }
      var a = e.target.closest("[data-answer]");
      if (a) { Moves.answer(a.dataset.sig, a.dataset.answer, a); return; }
      var d = e.target.closest("[data-done]");
      if (d) { Moves.markDone(d.dataset.done); return; }
      var u = e.target.closest("[data-unlink]");
      if (u) { var p = u.dataset.unlink.split("|"); Moves.unlink(p[0], p[1]); return; }
      var m = e.target.closest("[data-move]");
      if (m) { Moves.run(m.dataset.move, m); return; }
      if (e.target.closest("[data-open-triage]")) { Moves.setScope({ triage: 1 }); return; }
      if (e.target.closest("[data-pane-back]")) { App.setPaneOpen(false); return; }
      var pm = e.target.closest("[data-pane-menu]");
      if (pm) { Menus.paneMenu(pm); return; }
      var g = e.target.closest("[data-goto]");
      if (g) Moves.reveal(g.dataset.goto);
    });
    host.addEventListener("keydown", function (e) {
      var g = e.target.closest("[data-goto]");
      if (g && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); e.stopPropagation(); Moves.reveal(g.dataset.goto); }
    });
    host.addEventListener("pointerover", function (e) {
      var a = e.target.closest("[data-desc]");
      if (!a) return;
      var d = a.closest(".sig").querySelector(".sig-desc");
      if (d) d.textContent = a.dataset.desc;
    });
    host.addEventListener("focusin", function (e) {
      var a = e.target.closest("[data-desc]");
      if (!a) return;
      var d = a.closest(".sig").querySelector(".sig-desc");
      if (d) d.textContent = a.dataset.desc;
    });
  }

  return { draw: draw, start: start, block: block, memberRows: memberRows };
})();

// The fold of a signal section: its body grows on the hand spring, and the others stay as they are.
window.Signals = (function () {
  "use strict";
  function fold(host, sec, opening) {
    var body = sec.querySelector(".sig-body");
    var head = sec.querySelector(".sig-head");
    head.setAttribute("aria-expanded", String(opening));
    body.inert = !opening;
    if (Motion.isReduced()) { sec.classList.toggle("is-open", opening); return; }
    var from = body.getBoundingClientRect().height;
    sec.classList.toggle("is-open", opening);
    var to = opening ? body.scrollHeight : 0;
    body.style.height = from + "px";
    var v = Motion.value(from, function (h) { body.style.height = Math.max(0, h) + "px"; });
    v.to(to, "hand", function () { body.style.height = ""; });
  }
  return { fold: fold };
})();
