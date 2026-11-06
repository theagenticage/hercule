// What a person can do with a card: hand it to an agent, take it on, dismiss it, undo. Every move shows where the card went.
window.Moves = (function () {
  var K = Kinds.KINDS;
  var holes = [];       // entities dismissed while the pointer stays near, so their place is kept for one more click
  var undoable = null;  // the last move, for Undo
  var toastTimer = 0;

  /** Finds the sidebar row a Task flies to. */
  function readWorkRow() { return document.querySelector('[data-nav="overview"]'); }

  /** Sends a small token of the card to the Overview row, so the eye sees where the Task went. */
  function flyToWork(el, e) {
    var row = readWorkRow();
    if (!row || !el) return Promise.resolve();
    var kind = K[e.kind];
    var token = '<span class="token">' + Card.drawMark(kind.plugin, 14) + '</span>';
    var c = el.getBoundingClientRect();
    var from = { left: c.left + 12, top: c.top + 9, width: 20, height: 20 };
    return Motion.fly(token, from, row.getBoundingClientRect()).then(function () {
      Motion.animate(row, [{ background: 'color-mix(in oklab, var(--accent) 16%, transparent)' }, { background: 'transparent' }], { duration: 640, easing: 'ease-out' });
    });
  }

  /** Makes the actual change of a hand-off or a take, and rolls the card's line to the new sentence. */
  function assign(e, by) {
    var el = App.els()[e.id];
    undoable = { type: 'assign', id: e.id };
    e.task = { by: by, startedAt: App.state.now };
    if (e.kind === 'hercule/cluster') { assignPlaque(e, by); return; }
    if (!el) { App.layOut(); return; }
    Pointer.setHover(null);
    Pointer.unpeek();
    el.classList.add('is-handing');
    var line = el.querySelector('.c-line');
    var old = line.cloneNode(true);
    App.redrawCard(e);
    el.classList.add('is-handing');
    Landing.rollLine(el, old);
    // The colleague comes up from behind the card, then puts its paws on the edge.
    var who = el.querySelector('.card-holder');
    if (who) Motion.body(who).set({ y: 26 }).to({ y: 0 }, 'drop', { delay: 90 });
    var paws = el.querySelector('.card-paws');
    if (paws) Motion.body(paws).set({ o: 0, y: 3 }).to({ o: 1, y: 0 }, 'bump', { delay: 300 });
    setTimeout(function () { el.classList.remove('is-handing'); }, 700);
    setTimeout(function () { flyToWork(el, e); }, 120);
    App.layOut();
    var said = by === 'you' ? 'You took it on' : 'Handed to ' + by;
    showToast(said, true);
  }

  /** Hands on what Hercule noticed. The plaque goes flat in its place, and leaves at the next visit. */
  function assignPlaque(e, by) {
    var el = document.querySelector('.plaque[data-id="' + e.id + '"]');
    el.classList.add('is-handed');
    el.querySelector('.pl-why').textContent = by === 'you' ? 'You took it on' : by + ' has it';
    var c = el.getBoundingClientRect();
    Motion.fly('<span class="token">' + Crew.logo(14, { mono: true }) + '</span>', { left: c.left + 16, top: c.top + 22, width: 24, height: 24 }, readWorkRow().getBoundingClientRect());
    showToast(by === 'you' ? 'You took it on' : 'Handed to ' + by, true);
    App.drawBar();
  }

  function hand(e, workflow, anchor) {
    var flows = Card.readWorkflows(e);
    if (workflow) return assign(e, workflow.name);
    if (!flows.length) { showToast('No workflow takes a ' + K[e.kind].noun.toLowerCase() + ' yet', false); return; }
    if (flows.length === 1) return assign(e, flows[0].name);
    Menu.show(anchor || App.els()[e.id], flows, function (w) { assign(e, w.name); });
  }
  function take(e) { assign(e, 'you'); }

  /** Dismisses a card. Its place stays open while the pointer is near, so a second click lands on the next card, not on a moved one. */
  function dismiss(e) {
    var el = App.els()[e.id];
    undoable = { type: 'dismiss', id: e.id };
    e.leaving = true;
    holes.push(e);
    if (el) {
      el.classList.remove('is-hover', 'is-focus');
      el.classList.add('is-leaving');
    }
    Pointer.unpeek();
    App.drawBar();
    showToast('Dismissed', true);
    clearTimeout(dismiss.t);
    dismiss.t = setTimeout(closeHoles, 2600);
  }

  /** Closes the places dismissed cards left, so their neighbours glide together. */
  function closeHoles() {
    if (!holes.length) return;
    holes.forEach(function (e) {
      if (!e.leaving) return;
      App.removeEl(e.id);
      var i = App.state.entities.indexOf(e);
      if (i >= 0) App.state.entities.splice(i, 1);
      e.gone = i;
    });
    var left = holes.filter(function (e) { return e.gone >= 0; });
    holes = [];
    if (left.length) { undoableGone = left; App.layOut(); App.checkZero(); }
  }
  var undoableGone = [];

  function undo() {
    if (!undoable) return;
    var u = undoable;
    undoable = null;
    hideToast();
    var e = App.findEntity(u.id);
    if (u.type === 'assign' && e) {
      e.task = null;
      App.redrawCard(e);
      App.layOut();
      return;
    }
    if (u.type === 'dismiss') {
      if (e && e.leaving) {
        e.leaving = false;
        holes = holes.filter(function (x) { return x !== e; });
        App.els()[e.id].classList.remove('is-leaving');
        App.layOut();
        return;
      }
      var back = undoableGone.filter(function (x) { return x.id === u.id; })[0];
      if (back) {
        back.leaving = false;
        App.state.entities.splice(Math.min(back.gone, App.state.entities.length), 0, back);
        App.layOut();
      }
    }
  }

  function showToast(text, withUndo) {
    var t = document.getElementById('toast');
    t.innerHTML = '<span>' + Card.esc(text) + '</span>' + (withUndo ? '<button data-undo>Undo <kbd>⌘Z</kbd></button>' : '');
    t.hidden = false;
    t.classList.remove('is-gone');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 5000);
  }
  function hideToast() {
    var t = document.getElementById('toast');
    clearTimeout(toastTimer);
    t.classList.add('is-gone');
    setTimeout(function () { if (t.classList.contains('is-gone')) t.hidden = true; }, 200);
  }

  function perform(act, id, anchor) {
    var e = App.findEntity(id);
    if (!e) return;
    if (e.kind === 'hercule/cluster' && act === 'dismiss') {
      var i = App.state.clusters.indexOf(e);
      App.state.clusters.splice(i, 1);
      var plaque = document.querySelector('.plaque[data-id="' + id + '"]');
      Motion.animate(plaque, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-6px) scale(.98)' }], { duration: 200, easing: 'ease-in' }).then(function () { App.drawNoticed(); App.layOut(); App.checkZero(); });
      showToast('Back in Intake', false);
      return;
    }
    if (act === 'hand') hand(e, null, anchor);
    else if (act === 'take') take(e);
    else if (act === 'dismiss') dismiss(e);
    else if (act === 'go') Pages.goToWork(e);
  }

  function start() {
    document.getElementById('toast').addEventListener('click', function (ev) { if (ev.target.closest('[data-undo]')) undo(); });
    document.getElementById('toast').addEventListener('pointerenter', function () { clearTimeout(toastTimer); });
    document.getElementById('toast').addEventListener('pointerleave', function () { toastTimer = setTimeout(hideToast, 2000); });
  }

  return { perform: perform, hand: hand, take: take, dismiss: dismiss, undo: undo, closeHoles: closeHoles, assign: assign, showToast: showToast, hideToast: hideToast, start: start };
})();

// The small menu of workflows, when more than one fits.
window.Menu = (function () {
  var host, onPick, flows, active = 0, opener = null;
  function draw() {
    host.innerHTML = '<div class="menu-h">Hand to</div>' + flows.map(function (w, i) {
      return '<button class="menu-row' + (i === active ? ' is-on' : '') + '" data-i="' + i + '">' + Crew.face(w.name, { pose: 'idle', size: 28 }) + '<span class="menu-t"><b>' + Card.esc(w.name) + '</b><small>' + Card.esc(w.says) + '</small></span><kbd>' + (i + 1) + '</kbd></button>';
    }).join('');
  }
  function show(anchor, list, pick) {
    host = document.getElementById('menu');
    flows = list; onPick = pick; active = 0; opener = anchor;
    draw();
    host.hidden = false;
    var r = anchor.getBoundingClientRect(), m = host.getBoundingClientRect();
    var x = Math.min(r.left, innerWidth - m.width - 16), y = r.bottom + 6;
    if (y + m.height > innerHeight - 12) y = r.top - m.height - 6;
    host.style.left = x + 'px';
    host.style.top = y + 'px';
    Motion.animate(host, [{ opacity: 0, transform: 'translateY(-4px) scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: 160, easing: 'cubic-bezier(.22,.9,.24,1)' });
  }
  function hide() { if (host) host.hidden = true; }
  function isOpen() { return host && !host.hidden; }
  function key(ev) {
    if (!isOpen()) return false;
    if (ev.key === 'Escape') { hide(); return true; }
    if (ev.key === 'ArrowDown' || ev.key === 'j') { active = (active + 1) % flows.length; draw(); return true; }
    if (ev.key === 'ArrowUp' || ev.key === 'k') { active = (active + flows.length - 1) % flows.length; draw(); return true; }
    var n = Number(ev.key);
    if (n >= 1 && n <= flows.length) active = n - 1;
    if (ev.key === 'Enter' || (n >= 1 && n <= flows.length)) { hide(); onPick(flows[active]); return true; }
    return false;
  }
  document.addEventListener('click', function (ev) {
    if (!isOpen()) return;
    var row = ev.target.closest('.menu-row');
    if (row) { hide(); onPick(flows[Number(row.dataset.i)]); return; }
    if (!ev.target.closest('#menu') && !ev.target.closest('[data-act="hand"]')) hide();
  });
  return { show: show, hide: hide, isOpen: isOpen, key: key };
})();
