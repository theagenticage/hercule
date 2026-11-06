// PROTOTYPE - a card opening into its details. The sheet of paper you clicked is the sheet that
// grows: its top edge, and whatever stands behind it, ride along. Its old place stays open on the
// board as a dent, so the eye knows where it goes back to. Open and close are one spring.
window.Pane = (function () {
  "use strict";

  var drive = null;
  var pane, sheet, inner, ghost;
  var openId = null;
  var from = null;
  var to = null;

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v) { return Math.max(0, Math.min(1, v)); }
  function esc(s) { return Board.esc(s); }

  function stageName(id) { return NW.STAGES.filter(function (s) { return s.id === id; })[0].name; }

  /** Draws the stage path: each stage as a step, the current one in ink. */
  function drawPath(t) {
    var reached = true;
    return '<ol class="pn-path">' + NW.STAGES.map(function (s) {
      var here = s.id === t.stage;
      var html = '<li class="' + (here ? "is-here" : reached ? "is-past" : "") + '"><button data-stage-to="' + s.id + '" title="Move to ' + s.name + '">' + s.name + "</button></li>";
      if (here) reached = false;
      return html;
    }).join("") + "</ol>";
  }

  function drawNextMove(t) {
    var holder = Store.decideHolder(t);
    var who = "";
    var blocked = Store.isBlocked(t);
    if (blocked) {
      return '<section class="pn-sec"><h4>Next move</h4><p class="pn-who"><span>Nobody yet. It waits on another Task.</span></p></section>';
    }
    if (t.stage === "landed") return "";
    if (holder.kind === "you") who = '<i class="card-tab" data-need="' + t.need + '"></i><span><b>Your move.</b> ' + (t.need === "think" ? "This needs real thinking." : "A quick call.") + "</span>";
    else if (holder.kind === "agent") who = Crew.face(holder.name, { pose: holder.pose, size: 22 }) + "<span><b>" + esc(holder.name) + "</b> " + (holder.pose === "waiting" ? "asks you." : "is working.") + "</span>";
    else if (holder.kind === "person") who = '<span class="pn-initial">' + esc(holder.name.charAt(0)) + "</span><span><b>" + esc(holder.name) + "</b> has the next move.</span>";
    else who = "<span>Nobody has the next move.</span>";
    var ask = t.ask ? '<p class="pn-ask">' + esc(t.ask) + "</p>" : "";
    var opts = (t.options || []).map(function (o, i) {
      var label = typeof o === "string" ? o : o.label || "";
      return '<button class="pn-answer' + (i === 0 ? " is-suggested" : "") + '" data-answer="' + i + '">' + esc(label) + "</button>";
    }).join("");
    return '<section class="pn-sec pn-next"><h4>Next move</h4><p class="pn-who">' + who + "</p>" + ask + (opts ? '<div class="pn-answers">' + opts + "</div>" : "") + "</section>";
  }

  function drawThreads(t) {
    if (!t.threads.length) return "";
    return '<section class="pn-sec"><h4>Threads <span>' + t.threads.length + "</span></h4>" + t.threads.map(function (th, i) {
      var live = t.agent && i === t.threads.length - 1;
      return '<a class="pn-row" href="#">' + Crew.face(th.title + th.id, { pose: live ? "working" : "idle", size: 20 }) + '<span class="pn-row-text">' + esc(th.title) + "</span><small>" + (live ? "Working" : NW.formatAge(t.age)) + "</small></a>";
    }).join("") + "</section>";
  }

  function drawLinks(t) {
    var rows = (t.links || []).map(function (l) {
      var mark = /pull|#/.test(l.url + l.label) ? Crew.brand("github", 14) : Crew.icon("link", 14);
      return '<a class="pn-row" href="#">' + mark + '<span class="pn-row-text">' + esc(l.label) + "</span><small>" + esc(l.state || "") + "</small></a>";
    }).join("");
    return rows ? '<section class="pn-sec"><h4>Linked</h4>' + rows + "</section>" : "";
  }

  function drawBlockers(t) {
    var rows = t.blockedBy.map(function (id) {
      var b = Store.task(id);
      return b ? '<button class="pn-row" data-open="' + b.id + '">' + Crew.icon("lock", 14) + '<span class="pn-row-text">' + esc(b.name) + "</span><small>" + stageName(b.stage) + "</small></button>" : "";
    }).join("");
    var blocks = Store.state.tasks.filter(function (x) { return x.blockedBy.indexOf(t.id) >= 0; }).map(function (b) {
      return '<button class="pn-row" data-open="' + b.id + '">' + Crew.icon("arrow", 14) + '<span class="pn-row-text">' + esc(b.name) + "</span><small>" + stageName(b.stage) + "</small></button>";
    }).join("");
    return (rows ? '<section class="pn-sec"><h4>Blocked by</h4>' + rows + "</section>" : "") + (blocks ? '<section class="pn-sec"><h4>Blocks</h4>' + blocks + "</section>" : "");
  }

  function drawInner(t) {
    var project = Store.state.projects.filter(function (p) { return p.id === t.project; })[0];
    var plan = Store.state.plans.filter(function (p) { return p.id === t.initiative; })[0];
    return '<div class="pn-scroll"><header class="pn-head"><p class="pn-crumb"><i class="proj proj--' + project.tint + '"></i>' + esc(project.name) + (plan ? '<span class="sep"></span>' + esc(plan.name) : "") + "</p>" +
      '<h2 class="pn-title">' + esc(t.name) + "</h2>" + drawPath(t) + "</header>" +
      '<p class="pn-where">' + esc(t.where || t.now) + "</p>" +
      drawNextMove(t) +
      (t.left && !/^(nothing|everything)$/i.test(t.left) ? '<section class="pn-sec"><h4>What is left</h4><p class="pn-left">' + esc(t.left) + "</p></section>" : "") +
      drawBlockers(t) + drawThreads(t) + drawLinks(t) + "</div>" +
      '<footer class="pn-foot"><button class="pn-btn" data-act="done">' + Crew.icon("check", 14) + 'Done<kbd>D</kbd></button><button class="pn-btn" data-act="drop">Drop<kbd>⌫</kbd></button><button class="pn-btn" data-act="merge">Merge<kbd>M</kbd></button><button class="pn-btn" data-act="thread">' + Crew.icon("compose", 14) + 'Start a thread<kbd>T</kbd></button></footer>';
  }

  function drawHolderOnSheet(t) {
    var h = Store.decideHolder(t);
    var el = sheet.querySelector(".card-holder");
    if (el) el.remove();
    if (h.kind === "none") return;
    var tmp = document.createElement("div");
    tmp.innerHTML = '<span class="card-holder">' + (h.kind === "you" ? '<i class="card-tab" data-need="' + h.need + '"></i>' : h.kind === "agent" ? '<span class="card-head">' + Crew.peek(h.name, { pose: h.pose, size: 30, crop: 33 }) + "</span>" : '<i class="card-tab card-tab--person">' + esc(h.name.charAt(0)) + "</i>") + "</span>";
    sheet.insertBefore(tmp.firstChild, sheet.firstChild);
  }

  function paint(p) {
    if (!from || !to) return;
    var q = Math.max(0, p);
    sheet.style.left = lerp(from.left, to.left, p) + "px";
    sheet.style.top = lerp(from.top, to.top, p) + "px";
    sheet.style.width = lerp(from.width, to.width, q) + "px";
    sheet.style.height = lerp(from.height, to.height, q) + "px";
    sheet.style.setProperty("--pn-r", lerp(12, 16, clamp(p)) + "px");
    var words = clamp((p - 0.38) / 0.5);
    inner.style.opacity = words.toFixed(3);
    inner.style.transform = "translateY(" + ((1 - words) * 10).toFixed(2) + "px)";
    if (ghost) ghost.style.opacity = clamp(1 - p / 0.42).toFixed(3);
    pane.style.setProperty("--pn-dim", clamp(p).toFixed(3));
  }

  function measureTarget() {
    var host = pane.getBoundingClientRect();
    var w = Math.min(468, host.width - 40);
    return { left: host.width - w - 14, top: 54, width: w, height: host.height - 54 - 14 };
  }

  function cardRect(el) {
    var host = pane.getBoundingClientRect();
    var r = el.getBoundingClientRect();
    return { left: r.left - host.left, top: r.top - host.top, width: r.width, height: r.height };
  }

  /** Opens a Task's details, from its card when the card is on the board. */
  function show(id) {
    var t = Store.task(id);
    if (!t) return;
    var el = document.querySelector('.card[data-id="' + id + '"]');
    if (openId && openId !== id) {
      swap(id);
      return;
    }
    openId = id;
    pane.hidden = false;
    pane.classList.add("is-on");
    inner.innerHTML = drawInner(t);
    drawHolderOnSheet(t);
    to = measureTarget();
    from = el ? cardRect(el) : { left: to.left + 40, top: to.top + 40, width: to.width - 80, height: 200 };
    if (ghost) ghost.remove();
    ghost = null;
    if (el) {
      ghost = el.cloneNode(true);
      ghost.classList.add("pn-ghost");
      ghost.style.cssText = "";
      ghost.removeAttribute("tabindex");
      sheet.appendChild(ghost);
      el.classList.add("is-away");
    }
    if (drive.get() < 0.02) drive.set(0);
    paint(drive.get());
    drive.to(1, "open");
    document.getElementById("work").classList.add("has-pane");
  }

  /** Changes what the open sheet shows, when another card is chosen. */
  function swap(id) {
    var t = Store.task(id);
    var old = document.querySelector('.card[data-id="' + openId + '"]');
    if (old) old.classList.remove("is-away");
    var el = document.querySelector('.card[data-id="' + id + '"]');
    if (el) el.classList.add("is-away");
    openId = id;
    if (el) {
      from = cardRect(el);
      if (ghost) {
        var copy = el.cloneNode(true);
        copy.classList.remove("is-away");
        copy.classList.add("pn-ghost");
        copy.style.cssText = "";
        ghost.replaceWith(copy);
        ghost = copy;
        ghost.style.opacity = "0";
      }
    }
    Motion.body(inner).set({ o: 0, y: 8 });
    inner.innerHTML = drawInner(t);
    drawHolderOnSheet(t);
    inner.style.transform = "";
    inner.style.opacity = "";
    var a = inner.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: Motion.isReduced() ? 120 : 200, easing: "cubic-bezier(.2,.8,.2,1)" });
    a.onfinish = function () { inner.style.opacity = "1"; };
  }

  /** Closes the details: the sheet folds back into its dent on the board. */
  function hide(done) {
    if (!openId) return;
    var id = openId;
    openId = null;
    var el = document.querySelector('.card[data-id="' + id + '"]');
    if (el) from = cardRect(el);
    document.getElementById("work").classList.remove("has-pane");
    drive.to(0, "open", function () {
      pane.hidden = true;
      pane.classList.remove("is-on");
      if (ghost) ghost.remove();
      ghost = null;
      if (el) el.classList.remove("is-away");
      if (done) done();
    });
  }

  function currentId() { return openId; }

  function mount() {
    pane = document.getElementById("pane");
    sheet = pane.querySelector(".pn-sheet");
    inner = pane.querySelector(".pn-inner");
    drive = Motion.value(0, paint);
    pane.addEventListener("click", function (e) {
      var act = e.target.closest("[data-act]");
      if (act) return Actions.run(act.dataset.act, openId);
      var open = e.target.closest("[data-open]");
      if (open) return show(open.dataset.open);
      var stage = e.target.closest("[data-stage-to]");
      if (stage) {
        var t = Store.task(openId);
        Actions.moveToStage(openId, stage.dataset.stageTo);
        inner.innerHTML = drawInner(t);
      }
    });
    window.addEventListener("resize", function () {
      if (openId) {
        to = measureTarget();
        paint(drive.get());
      }
    });
  }

  return { mount: mount, show: show, hide: hide, currentId: currentId };
})();
