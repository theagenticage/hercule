// What a person can do with a card: hand it to an agent, take it on, dismiss it, undo. Every move shows where the card went.
window.Moves = (function () {
  var K = Kinds.KINDS;
  var history = [];     // every move of this visit, newest last, so Undo goes as far back as the person likes
  var toastTimer = 0;
  var turns = {};       // stacks waiting to turn over, by name

  /** Returns what Undo needs to put everything back exactly: the order of the page, and how each touched thing stood. */
  function takeSnapshot(touched) {
    return {
      order: App.state.entities.slice(),
      clusters: App.state.clusters.slice(),
      touched: touched.map(function (e) { return { e: e, task: e.task, settled: e.settled }; }),
    };
  }

  /** Puts a snapshot back. Anything that arrived since keeps its place at the end. */
  function restoreSnapshot(snap) {
    var since = App.state.entities.filter(function (e) { return snap.order.indexOf(e) < 0; });
    App.state.entities = snap.order.concat(since);
    App.state.clusters = snap.clusters.concat(App.state.clusters.filter(function (c) { return snap.clusters.indexOf(c) < 0; }));
    snap.touched.forEach(function (t) { t.e.task = t.task; t.e.settled = t.settled; });
  }

  /** Finds the sidebar row a Task flies to. */
  function readWorkRow() { return document.querySelector('[data-nav="overview"]'); }

  /** Marks the Overview row as having received something: its icon dips and a wash of the accent fades. */
  function receive(row) {
    var icon = row.querySelector('.ic');
    if (icon) Motion.knock(icon, 110);
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
    history.push({ type: 'assign', e: e, snap: takeSnapshot([e]) });
    e.task = { by: by, startedAt: App.state.now };
    var said = by === 'you' ? 'You took it on' : 'Handed to ' + by;
    var undoWord = by === 'you' ? 'Undo' : 'Undo, stop the run';
    placeToast(el);
    if (e.kind === 'hercule/cluster') { assignPlaque(e, by); return; }
    var seen = document.querySelector('#tray:not([hidden]) .card[data-id="' + e.id + '"]');
    if (!el || !el._plan || seen) {
      // A card from a tray says what happened where it is seen.
      if (seen) Card.redrawBody(seen, e, { now: App.state.now, usual: null });
      // A card held from inside a pile was never on the page, so it goes straight to the foot line.
      e.settled = true;
      App.layOut();
      Tray.refresh();
      showToast(said, undoWord);
      return;
    }
    Pointer.unpeek();
    Nav.setCount('inbox', App.countOverdue());
    // The wait gives way, and whoever takes the card comes up into its place.
    var wait = el.querySelector('.c-pace');
    if (wait) Motion.animate(wait, [{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' });
    el.insertAdjacentHTML('afterbegin', Card.drawHolder(e));
    var isWhole = el.classList.contains('is-whole');
    var who = el.querySelector(isWhole ? '.card-holder' : '.c-holder-in');
    var paws = isWhole && el.querySelector('.card-paws');
    var reduced = Motion.isReduced();
    if (!reduced) {
      Motion.body(who).set({ y: 26 }).to({ y: 0 }, 'hand');
      if (paws) Motion.body(paws).set({ o: 0, y: 4 }).to({ o: 1, y: 0 }, 'hand', { delay: 30 });
    }
    setTimeout(function () {
      if (!e.task) return;
      var line = el.querySelector('.c-line');
      var old = line && line.cloneNode(true);
      App.redrawCard(e);
      if (old) Landing.rollLine(el, old);
      // The colleague takes the weight: on one frame the card sinks under the handing over, and whoever took it dips and recovers.
      Motion.knock(el, 110);
      Motion.knock(who, 150);
      if (paws) Motion.knock(paws, 110);
      flyToWork(el);
      App.layOut();
      showToast(said, undoWord);
      noteLast();
      planTurn(App.readStack(e));
    }, reduced ? 0 : 170);
  }

  /** Waits for the last hand-off of a run, then turns the stack over. One timer per stack, so a run of moves turns it once. */
  function planTurn(stack) {
    clearTimeout(turns[stack]);
    turns[stack] = setTimeout(function () { runTurn(stack); }, 620);
  }

  function runTurn(stack) {
    delete turns[stack];
    if (!App.turnOver(stack)) return false;
    if (Keys.isUsingKeys() && !Keys.current()) Keys.focusFirstIn(stack);
    else setTimeout(Pointer.reread, 420);
    return true;
  }

  /** Runs a turn that is still waiting, because a key was pressed for the next card. Returns whether there was one. */
  function flushTurn() {
    var names = Object.keys(turns);
    names.forEach(function (n) { clearTimeout(turns[n]); runTurn(n); });
    return names.length > 0;
  }

  /** Lets the sunrise follow the last card handed on, once the chain has played out and the pointer has left the card. */
  function noteLast() {
    if (App.countLeft()) return;
    setTimeout(function () { if (!App.countLeft() && !Open.isOpen()) App.checkZero(); }, 1500);
  }

  /** Hands on what Hercule noticed. Its part of the noticed card steps back, and leaves at the next visit. */
  function assignPlaque(e, by) {
    var el = document.querySelector('.plaque[data-id="' + e.id + '"]');
    App.drawNoticed();
    el = document.querySelector('.plaque[data-id="' + e.id + '"]');
    flyToWork(el);
    showToast(by === 'you' ? 'You took it on' : 'Handed to ' + by, by === 'you' ? 'Undo' : 'Undo, stop the run');
    App.drawBar();
    noteLast();
  }

  function hand(e, workflow, anchor, then) {
    var flows = Card.readWorkflows(e);
    if (workflow) return assign(e, workflow.name);
    if (flows.length === 1) return assign(e, flows[0].name);
    Menu.show(anchor || App.els()[e.id], flows, function (w) { assign(e, w.name); if (then) then(); });
  }
  function take(e) { assign(e, 'you'); }

  /**
   * Dismisses a card. It steps aside, and the next card rises into its place at once, the way closing a tab brings the next
   * tab under the pointer: the same click at the same spot dismisses the next one. The next card is chosen by order, never by
   * what happens to be under the pointer while things move.
   */
  function dismiss(e, atTheRail) {
    var el = App.els()[e.id];
    placeToast(el);
    var stack = App.readStackEntities(App.readStack(e)).lying;
    var nextCard = stack[stack.indexOf(e) + 1];
    var wasHover = el && el.classList.contains('is-hover');
    var index = App.state.entities.indexOf(e);
    history.push({ type: 'dismiss', e: e, snap: takeSnapshot([e]) });
    App.state.entities.splice(index, 1);
    Tray.remove(e.id);
    if (el && el._plan) {
      var first = Number(el.style.zIndex);
      // A card dismissed from a peek leaves with its whole face, and the stack closes under it.
      Pointer.forget(el);
      el.classList.remove('is-hover', 'is-focus');
      el.classList.add('is-leaving');
      App.forgetEl(e.id);
      if (atTheRail) el.remove();
      else Motion.body(el).to(Motion.isReduced() ? { o: 0 } : { x: 14, o: 0 }, 'travel', { done: function () { el.remove(); } });
      App.layOut(false, function (c) { return Math.min(120, Math.max(0, Number(c.style.zIndex) - first) * 14); });
      // The card that rises into this place takes over: from under it, or dealt from the pile.
      if (wasHover) Pointer.handOver(nextCard && App.els()[nextCard.id]);
    } else { Pointer.unpeek(); App.layOut(); }
    App.noteStackEmptied(App.readStack(e));
    showToast('Dismissed', 'Undo', 'Dismissed: ' + e.title);
    if (!App.countLeft()) setTimeout(function () { if (!App.countLeft()) App.checkZero(); }, 320);
  }

  /** Sends something Hercule noticed back to Intake. */
  function sendBack(e) {
    history.push({ type: 'noticed', e: e, snap: takeSnapshot([e]) });
    var plaque = document.querySelector('.plaque[data-id="' + e.id + '"]');
    App.state.clusters.splice(App.state.clusters.indexOf(e), 1);
    showToast('Back in Intake', 'Undo');
    if (!plaque) { App.drawNoticed(); return; }
    Motion.animate(plaque, [{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'ease-in' }).then(function () { App.reflowNoticed(); App.checkZero(); });
  }

  /** Plays a hand-off backwards: the mark flies home from Overview, the card stands up, and the colleague sinks away. */
  function playUnassign(e) {
    var el = App.els()[e.id];
    if (!el || !el._plan) { App.layOut(); el = App.els()[e.id]; }
    var stand = function () {
      if (!el) { Nav.hold(false); App.layOut(); return; }
      var stands = [].slice.call(el.querySelectorAll('.c-holder, .card-holder, .card-paws'));
      var line = el.querySelector('.c-line');
      var old = line && line.cloneNode(true);
      stands.forEach(function (x) { x.remove(); });
      App.redrawCard(e);
      stands.forEach(function (x) {
        el.insertBefore(x, el.firstChild);
        var part = x.classList.contains('c-holder') ? x.firstChild : x;
        Motion.body(part).to(x.classList.contains('card-paws') ? { o: 0 } : { y: 26 }, 'travel', { done: function () { x.remove(); } });
      });
      if (old) Landing.rollLine(el, old);
      Motion.knock(el, -90);
      Nav.hold(false);
      App.layOut();
    };
    var row = readWorkRow(), mark = el && el.querySelector('.c-mark .mark');
    if (!el || !row || !mark || Motion.isReduced()) { stand(); return; }
    Motion.fly('<span class="token">' + mark.outerHTML + '</span>', row.querySelector('.ic').getBoundingClientRect(), mark.getBoundingClientRect(), { ms: 420, grow: true }).then(stand);
  }

  /**
   * Undoes the last move, from anywhere. The move is reversed in the data first, then the page is brought to it, so a page that
   * was empty comes back with the card on it.
   */
  function undo() {
    var u = history.pop();
    if (!u) return;
    if (Open.isOpen()) Open.hide(true);
    if (Tray.isOpen()) Tray.hide();
    var wasElsewhere = Pages.current() !== 'inbox' || App.state.mode !== 'stacks';
    restoreSnapshot(u.snap);
    if (wasElsewhere || u.type === 'batch') {
      Pages.setView('inbox', true);
      App.state.mode = 'stacks';
      App.redraw();
    } else if (u.type === 'assign' && u.e.kind !== 'hercule/cluster') {
      Nav.hold(true);
      playUnassign(u.e);
    } else if (u.type === 'noticed' || u.e && u.e.kind === 'hercule/cluster') {
      App.reflowNoticed();
    } else {
      // If the card is still stepping aside, its copy gives way to the card coming back.
      document.querySelectorAll('.card.is-leaving[data-id="' + u.e.id + '"]').forEach(function (c) { c.remove(); });
      App.layOut();
      var back = u.e && App.els()[u.e.id];
      if (back) { back.classList.remove('is-new'); Motion.body(back).set({ x: 14, o: 0 }).to({ x: 0, o: 1 }, 'travel'); }
    }
    Nav.setCount('inbox', App.countOverdue());
    var backEl = u.e && App.els()[u.e.id];
    if (u.e && Keys.isUsingKeys()) { if (backEl && backEl._plan) Keys.focus(u.e.id); else if (u.e.kind !== 'hercule/cluster') Keys.focusFirstIn(App.readStack(u.e)); }
    else if (u.type === 'dismiss' && backEl && backEl._plan) Pointer.takeBack(backEl);
    if (history.length) showToast('Undone', 'Undo'); else hideToast();
  }

  /** Hands a whole pile to one colleague as one move with one Undo. */
  function handAll(members, workflow) {
    var open = members.filter(function (e) { return !e.task; });
    history.push({ type: 'batch', snap: takeSnapshot(open) });
    open.forEach(function (e) { e.task = { by: workflow, startedAt: App.state.now }; e.settled = true; });
    Tray.hide();
    App.layOut();
    showToast('Handed ' + open.length + ' to ' + workflow, 'Undo, stop the runs');
    noteLast();
  }

  /** Dismisses a whole pile as one move with one Undo. */
  function dismissAll(members) {
    history.push({ type: 'batch', snap: takeSnapshot(members) });
    App.state.entities = App.state.entities.filter(function (e) { return members.indexOf(e) < 0; });
    Tray.hide();
    App.layOut();
    showToast('Dismissed ' + members.length, 'Undo');
    if (!App.countLeft()) setTimeout(function () { App.checkZero(); }, 320);
  }

  /** Forgets every move, when the world is replaced by another scene. */
  function reset() { history = []; hideToast(); }

  /** Returns why a move cannot be made on this thing, or nothing when it can. */
  function refuse(act, e) {
    if (act === 'go') return e.task ? '' : 'No Task yet. Hand it on or take it first.';
    if (e.task) return (e.task.by === 'you' ? 'You already have this.' : e.task.by + ' already has this.') + ' G goes to its Task.';
    if (act === 'hand' && !Card.readWorkflows(e).length) return 'No workflow takes a ' + K[e.kind].noun.toLowerCase() + ' yet';
    return '';
  }

  /** Puts the undo line in the foot of the column where the move was made, so it is near the hand and covers no card. */
  function placeToast(el) {
    var t = document.getElementById('toast');
    var col = (el && el.closest && el.closest('.col')) || document.querySelector('.col');
    if (!col) return;
    var main = document.getElementById('main').getBoundingClientRect();
    t.style.left = col.getBoundingClientRect().left - main.left + 'px';
  }

  function showToast(text, undoWord, said) {
    var t = document.getElementById('toast');
    // A refusal never takes Undo away.
    if (!undoWord && history.length) undoWord = 'Undo';
    t.innerHTML = '<span>' + Card.esc(text) + '</span>' + (undoWord ? '<button data-undo>' + Card.esc(undoWord) + ' <kbd>⌘Z</kbd></button>' : '');
    Landing.announce(said || text);
    var wasHidden = t.hidden, wasGoing = t.classList.contains('is-gone');
    t.hidden = false;
    t.classList.remove('is-gone');
    if (wasHidden) Motion.body(t).set({ y: 6, o: 0 }).to({ y: 0, o: 1 }, 'hand');
    else if (wasGoing) Motion.body(t).to({ y: 0, o: 1 }, 'hand');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 5000);
  }
  function hideToast() {
    var t = document.getElementById('toast');
    clearTimeout(toastTimer);
    t.classList.add('is-gone');
    Motion.body(t).to({ y: 6, o: 0 }, 'hand', { done: function () { if (t.classList.contains('is-gone')) { t.hidden = true; Motion.body(t).clear(); } } });
  }

  /** Runs a move on a card. Returns false when the move does not apply, after saying why. */
  function perform(act, id, anchor, then) {
    var e = App.findEntity(id);
    if (!e) return false;
    Menu.hide();
    var why = refuse(act, e);
    if (why) { showToast(why); return false; }
    if (act === 'go') { Pages.goToWork(e); return true; }
    if (e.kind === 'hercule/cluster' && act === 'dismiss') { sendBack(e); return true; }
    if (act === 'hand') { hand(e, null, anchor, then); return true; }
    if (act === 'take') { take(e); return true; }
    if (act === 'dismiss') { dismiss(e); return true; }
    return false;
  }

  function start() {
    document.getElementById('toast').addEventListener('click', function (ev) { if (ev.target.closest('[data-undo]')) undo(); });
    document.getElementById('toast').addEventListener('pointerenter', function () { clearTimeout(toastTimer); });
    document.getElementById('toast').addEventListener('pointerleave', function () { toastTimer = setTimeout(hideToast, 2000); });
    document.getElementById('toast').addEventListener('focusin', function () { clearTimeout(toastTimer); });
    document.getElementById('toast').addEventListener('focusout', function () { toastTimer = setTimeout(hideToast, 2000); });
  }

  return { perform: perform, flushTurn: flushTurn, refuse: refuse, hand: hand, take: take, dismiss: dismiss, undo: undo, assign: assign, handAll: handAll, dismissAll: dismissAll, reset: reset, showToast: showToast, hideToast: hideToast, start: start };
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
    // The menu opens under the card, so its edge never cuts through the card's last line.
    var card = anchor.closest && anchor.closest('.card');
    var under = card && card._plan && !card.classList.contains('is-peek') ? card.getBoundingClientRect().top + card._plan.show : r.bottom;
    var x = Math.min(r.left, innerWidth - m.width - 16), y = under + 6;
    if (y + m.height > innerHeight - 12) y = r.top - m.height - 6;
    host.style.left = x + 'px';
    host.style.top = y + 'px';
    Motion.animate(host, [{ opacity: 0, transform: 'translateY(-4px) scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: 160, easing: 'cubic-bezier(.22,.9,.24,1)' });
    focusActive();
  }
  function focusActive() { var row = host.querySelector('.menu-row.is-on'); if (row) row.focus({ preventScroll: true }); }
  function hide() {
    if (!host || host.hidden) return;
    host.hidden = true;
    if (opener && opener.closest) { var card = opener.closest('.card, .plaque'); if (card) card.focus({ preventScroll: true }); }
  }
  function isOpen() { return host && !host.hidden; }
  /** The open menu owns the keyboard: nothing reaches the page behind it. */
  function key(ev) {
    if (!isOpen()) return false;
    if (ev.repeat) return true;
    if (ev.key === 'Escape') { hide(); return true; }
    if (ev.key === 'ArrowDown' || ev.key === 'j') { active = (active + 1) % flows.length; draw(); focusActive(); return true; }
    if (ev.key === 'ArrowUp' || ev.key === 'k') { active = (active + flows.length - 1) % flows.length; draw(); focusActive(); return true; }
    var n = Number(ev.key);
    if (n >= 1 && n <= flows.length) active = n - 1;
    if (ev.key === 'Enter' || (n >= 1 && n <= flows.length)) { hide(); onPick(flows[active]); return true; }
    return true;
  }
  document.addEventListener('pointerover', function (ev) {
    var row = isOpen() && ev.target.closest('.menu-row');
    if (row && Number(row.dataset.i) !== active) { active = Number(row.dataset.i); draw(); }
  });
  document.addEventListener('click', function (ev) {
    if (!isOpen()) return;
    var row = ev.target.closest('.menu-row');
    if (row) { hide(); onPick(flows[Number(row.dataset.i)]); return; }
    if (!ev.target.closest('#menu') && !ev.target.closest('[data-act="hand"]')) hide();
  });
  return { show: show, hide: hide, isOpen: isOpen, key: key };
})();
