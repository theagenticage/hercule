// What a person can do with a card: hand it to an agent, take it on, dismiss it, undo. Every move shows where the card went.
window.Moves = (function () {
  var K = Kinds.KINDS;
  var holes = [];       // entities dismissed while the pointer stays near, so their place is kept for one more click
  var undoable = null;  // the last move, for Undo
  var toastTimer = 0;

  /** Finds the sidebar row a Task flies to. */
  function readWorkRow() { return document.querySelector('[data-nav="overview"]'); }

  /** Marks the Overview row as having received something: its icon dips and a wash of the accent fades. */
  function receive(row) {
    var icon = row.querySelector('.ic');
    if (icon) Motion.body(icon).set({ y: 1.5 }).to({ y: 0 }, 'hand');
    var wash = document.createElement('i');
    wash.className = 'nav-wash';
    row.appendChild(wash);
    wash.animate([{ opacity: 1 }, { opacity: 0 }], { duration: Motion.isReduced() ? 400 : 640, easing: 'ease-out' }).finished.then(function () { wash.remove(); });
  }

  /** Lifts the card's own mark off and flies it to Overview, so the eye sees where the Task went. Returns a promise for its arrival. */
  function flyToWork(el) {
    var row = readWorkRow();
    if (!row) return Promise.resolve();
    if (Motion.isReduced()) { receive(row); return Promise.resolve(); }
    var mark = el.querySelector('.c-mark .mark, .pl-mark');
    var target = row.querySelector('.ic').getBoundingClientRect();
    return Motion.fly('<span class="token">' + mark.outerHTML + '</span>', mark.getBoundingClientRect(), target).then(function () { receive(row); });
  }

  /**
   * Hands a card to whoever takes it, as one chain, so the cause always comes before the effect. The colleague rises while the
   * card still stands. Only when its paws reach the edge does the card give up its weight: it sinks, lies flat, the sentence
   * rolls, and its mark lifts off for Overview. Taking it on yourself runs the same chain with a marigold tab.
   */
  function assign(e, by) {
    var el = App.els()[e.id];
    undoable = { type: 'assign', id: e.id };
    e.task = { by: by, startedAt: App.state.now };
    var said = by === 'you' ? 'You took it on' : 'Handed to ' + by;
    if (e.kind === 'hercule/cluster') { assignPlaque(e, by); return; }
    if (!el || !el._plan) {
      // A card from a tray has no place in a stack: it says what happened where it is seen.
      var seen = document.querySelector('#tray .card[data-id="' + e.id + '"]');
      if (seen) Card.redrawBody(seen, e, { now: App.state.now, usual: null });
      App.layOut();
      showToast(said, true);
      return;
    }
    Pointer.setHover(null);
    Pointer.unpeek();
    Nav.setCount('inbox', App.countOverdue());
    el.insertAdjacentHTML('afterbegin', Card.drawHolder(e));
    var who = el.querySelector('.card-holder'), paws = el.querySelector('.card-paws');
    var reduced = Motion.isReduced();
    if (!reduced) {
      Motion.body(who).set({ y: 26 }).to({ y: 0 }, 'hand');
      if (paws) Motion.body(paws).set({ o: 0, y: 3 }).to({ o: 1, y: 0 }, 'hand', { delay: 130 });
    }
    setTimeout(function () {
      var line = el.querySelector('.c-line');
      var old = line && line.cloneNode(true);
      App.redrawCard(e);
      if (old) Landing.rollLine(el, old);
      if (!reduced) Motion.body(el).to({ y: 1.5 }, 'hand', { done: function () { Motion.body(el).to({ y: 0 }, 'hand'); } });
      flyToWork(el);
      App.layOut();
      showToast(said, true);
      Landing.announce(said);
      noteLast();
    }, reduced ? 0 : 170);
  }

  /** Lets the sunrise follow the last card handed on, once the chain has played out and the pointer has left the card. */
  function noteLast() {
    if (App.countLeft()) return;
    setTimeout(function () { if (!App.countLeft() && !Open.isOpen()) App.checkZero(); }, 1500);
  }

  /** Hands on what Hercule noticed. Its segment of the plate steps back, and leaves at the next visit. */
  function assignPlaque(e, by) {
    var el = document.querySelector('.plaque[data-id="' + e.id + '"]');
    el.classList.add('is-handed');
    el.querySelector('.pl-why').textContent = by === 'you' ? 'You took it on' : by + ' has it';
    flyToWork(el);
    showToast(by === 'you' ? 'You took it on' : 'Handed to ' + by, true);
    App.drawBar();
    noteLast();
  }

  function hand(e, workflow, anchor) {
    var flows = Card.readWorkflows(e);
    if (workflow) return assign(e, workflow.name);
    if (!flows.length) { showToast('No workflow takes a ' + K[e.kind].noun.toLowerCase() + ' yet', false); return; }
    if (flows.length === 1) return assign(e, flows[0].name);
    Menu.show(anchor || App.els()[e.id], flows, function (w) { assign(e, w.name); });
  }
  function take(e) { assign(e, 'you'); }

  /** Draws the etched place a dismissed card left. It fades over the time the place is kept, so the wait can be seen. */
  function drawHole(el) {
    var hole = document.createElement('i');
    hole.className = 'hole';
    hole.style.top = el.style.top;
    hole.style.height = el._plan.show + 'px';
    hole.style.zIndex = el.style.zIndex;
    hole.dataset.for = el.dataset.id;
    el.parentNode.appendChild(hole);
  }

  /** Dismisses a card. Its place stays open while the pointer is near, so a second click lands on the next card, not on a moved one. */
  function dismiss(e) {
    var el = App.els()[e.id];
    undoable = { type: 'dismiss', id: e.id };
    e.leaving = true;
    holes.push(e);
    if (el) {
      el.classList.remove('is-hover', 'is-focus');
      el.classList.add('is-leaving');
      if (el._plan) drawHole(el);
      Motion.body(el).to({ x: 14, o: 0 }, 'travel');
    }
    Pointer.unpeek();
    App.drawBar();
    showToast('Dismissed', true);
    clearTimeout(dismiss.t);
    // With nothing left there is nothing to keep a place for, and the sunrise should not wait.
    dismiss.t = setTimeout(closeHoles, App.countLeft() ? 2600 : 320);
  }

  /** Closes the places dismissed cards left. The neighbours nearest the hole move first, so the stack closes in a ripple. */
  function closeHoles() {
    if (!holes.length) return;
    var first = Infinity;
    holes.forEach(function (e) {
      if (!e.leaving) return;
      var el = App.els()[e.id];
      if (el) first = Math.min(first, Number(el.style.zIndex));
      document.querySelectorAll('.hole[data-for="' + e.id + '"]').forEach(function (h) { h.remove(); });
      App.removeEl(e.id);
      var i = App.state.entities.indexOf(e);
      if (i >= 0) App.state.entities.splice(i, 1);
      e.gone = i;
    });
    var left = holes.filter(function (e) { return e.gone >= 0; });
    holes = [];
    if (!left.length) return;
    undoableGone = left;
    App.layOut(false, function (el) { return Math.min(120, Math.max(0, Number(el.style.zIndex) - first) * 14); });
    App.checkZero();
  }
  var undoableGone = [];

  /** Plays a hand-off backwards: the mark flies home from Overview, the card stands up, and the colleague sinks away. */
  function undoAssign(e) {
    e.task = null;
    if (e.kind === 'hercule/cluster') { App.drawNoticed(); App.drawBar(); return; }
    var el = App.els()[e.id];
    var stand = function () {
      var who = el.querySelector('.card-holder'), paws = el.querySelector('.card-paws');
      var line = el.querySelector('.c-line');
      var old = line && line.cloneNode(true);
      if (paws) paws.remove();
      if (who) who.remove();
      App.redrawCard(e);
      if (who) {
        el.insertBefore(who, el.firstChild);
        Motion.body(who).to({ y: 26 }, 'travel', { done: function () { who.remove(); } });
      }
      if (old) Landing.rollLine(el, old);
      Nav.setCount('inbox', App.countOverdue());
      App.layOut();
    };
    var row = readWorkRow(), mark = el && el.querySelector('.c-mark .mark');
    if (!el || !row || !mark || Motion.isReduced()) { if (el) stand(); return; }
    Motion.fly('<span class="token">' + mark.outerHTML + '</span>', row.querySelector('.ic').getBoundingClientRect(), mark.getBoundingClientRect(), { ms: 420 }).then(stand);
  }

  function undo() {
    if (!undoable) return;
    var u = undoable;
    undoable = null;
    hideToast();
    var e = App.findEntity(u.id);
    if (u.type === 'assign' && e) { undoAssign(e); return; }
    if (u.type !== 'dismiss') return;
    if (e && e.leaving) {
      e.leaving = false;
      holes = holes.filter(function (x) { return x !== e; });
      document.querySelectorAll('.hole[data-for="' + e.id + '"]').forEach(function (h) { h.remove(); });
      App.els()[e.id].classList.remove('is-leaving');
      Motion.body(App.els()[e.id]).to({ x: 0, o: 1 }, 'travel');
      App.drawBar();
      return;
    }
    var back = undoableGone.filter(function (x) { return x.id === u.id; })[0];
    if (!back) return;
    back.leaving = false;
    App.state.entities.splice(Math.min(back.gone, App.state.entities.length), 0, back);
    // The sunrise has nothing to lay out: the page comes back first, and the card with it.
    if (App.state.mode !== 'stacks') { App.state.mode = 'stacks'; App.redraw(); return; }
    App.layOut();
    var el = App.els()[back.id];
    if (el) { el.classList.remove('is-new'); Motion.body(el).set({ x: 14, o: 0 }).to({ x: 0, o: 1 }, 'travel'); }
  }

  function showToast(text, withUndo) {
    var t = document.getElementById('toast');
    t.innerHTML = '<span>' + Card.esc(text) + '</span>' + (withUndo ? '<button data-undo>Undo <kbd>⌘Z</kbd></button>' : '');
    var wasHidden = t.hidden;
    t.hidden = false;
    t.classList.remove('is-gone');
    if (wasHidden) Motion.body(t).set({ y: 6, o: 0 }).to({ y: 0, o: 1 }, 'hand');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 5000);
  }
  function hideToast() {
    var t = document.getElementById('toast');
    clearTimeout(toastTimer);
    t.classList.add('is-gone');
    Motion.body(t).to({ y: 6, o: 0 }, 'hand', { done: function () { if (t.classList.contains('is-gone')) { t.hidden = true; Motion.body(t).clear(); } } });
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
      return '<button class="menu-row' + (i === active ? ' is-on' : '') + '" role="menuitem" data-i="' + i + '">' + Crew.face(w.name, { pose: 'idle', size: 28 }) + '<span class="menu-t"><b>' + Card.esc(w.name) + '</b><small>' + Card.esc(w.says) + '</small></span><kbd>' + (i + 1) + '</kbd></button>';
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
