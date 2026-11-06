// What a person can do with a card: hand it to an agent, take it on, dismiss it, undo. Every move shows where the card went.
window.Moves = (function () {
  var K = Kinds.KINDS;
  var history = [];     // every move of this visit, newest last, so Undo goes as far back as the person likes
  var toastTimer = 0;

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
    var mark = el.querySelector('.c-mark .mark, .pl-mark') || el.closest('.block, .bundle').querySelector('.mark');
    var target = row.querySelector('.ic').getBoundingClientRect();
    // With the sidebar hidden, Overview has no place on screen to fly to.
    if (!target.width) return Promise.resolve();
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
    if (e.kind === 'hercule/cluster') { assignPlaque(e, by); return; }
    // Something riding on a card has no edge of its own, so its row says who has it.
    if (!el) { App.layOut(true); showToast(said, undoWord); return; }
    Nav.setCount('inbox', App.countOverdue());
    var wait = el.querySelector('.c-pace');
    if (wait) Motion.animate(wait, [{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' });
    // An undo may still be taking the last holder away.
    [].forEach.call(el.querySelectorAll('.c-holder'), function (x) { x.remove(); });
    el.insertAdjacentHTML('afterbegin', Card.drawHolder(e));
    var who = el.querySelector('.c-holder-in');
    var reduced = Motion.isReduced();
    if (!reduced) Motion.body(who).set({ y: 22 }).to({ y: 0 }, 'hand');
    setTimeout(function () {
      if (!e.task) return;
      var line = el.querySelector('.c-under, .c-context');
      var old = line && line.cloneNode(true);
      App.redrawCard(e);
      if (old) Landing.rollLine(el, old);
      Motion.knock(who, 150);
      flyToWork(el);
      showToast(said, undoWord);
      noteLast();
    }, reduced ? 0 : 170);
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
    var order = Keys.readAfter(e.id);
    var wasHover = el && el.classList.contains('is-hover');
    var index = App.state.entities.indexOf(e);
    history.push({ type: 'dismiss', e: e, snap: takeSnapshot([e]) });
    App.state.entities.splice(index, 1);
    if (el) {
      Pointer.forget(el);
      // A copy steps aside where the card lay, and the page closes up at once, so the next card's close is under the pointer.
      var host = el.parentNode, r = host.getBoundingClientRect();
      if (!atTheRail && !Motion.isReduced()) {
        var copy = host.cloneNode(true);
        copy.classList.add('is-leaving-copy');
        copy.style.cssText = 'position:fixed;margin:0;z-index:30;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px';
        document.body.appendChild(copy);
        Motion.body(copy).to({ x: 14, o: 0 }, 'travel', { done: function () { copy.remove(); } });
      }
      App.forgetEl(e.id);
      host.remove();
    }
    App.layOut(false, function (c) { return 0; });
    if (wasHover) { var next = order.map(function (id) { return App.els()[id]; }).filter(Boolean)[0]; Pointer.handOver(next); }
    showToast('Dismissed', 'Undo', 'Dismissed: ' + e.title);
    if (!App.countLeft()) setTimeout(function () { if (!App.countLeft()) App.checkZero(); }, 320);
  }

  /** Links two things by hand. What rides on what follows from the link, and Undo takes it back. */
  function link(a, b) {
    var relation = Relations.linkByHand(a, b);
    history.push({ type: 'link', relation: relation });
    App.layOut();
    if (Open.isOpen()) Open.refresh();
    showToast('Linked', 'Undo', 'Linked ' + a.title + ' and ' + b.title);
  }

  /** Takes a person's link back. The source is not told, because the person never told it. */
  function unlink(e, otherId) {
    var l = Relations.readLinks(e).filter(function (x) { return x.otherId === otherId; })[0];
    if (!l) return;
    Relations.drop(l.relation);
    history.push({ type: 'link', relation: l.relation });
    App.layOut();
    Open.refresh();
    showToast('Link removed', 'Undo');
  }

  /** Brings a card into view and lights it, for a pointer that says where something really lies. */
  function reveal(id) {
    var el = App.els()[id] || document.querySelector('.part[data-id="' + id + '"]');
    if (!el) return;
    var page = document.getElementById('page'), r = el.getBoundingClientRect();
    page.scrollTo({ top: page.scrollTop + r.top - innerHeight / 2 + r.height / 2, behavior: Motion.isReduced() ? 'auto' : 'smooth' });
    el.dataset.landed = 'plain';
    el.classList.add('is-landed');
    setTimeout(function () { el.classList.remove('is-landed'); }, 1300);
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
    if (!el) { App.layOut(true); el = App.els()[e.id]; }
    var stand = function () {
      if (!el) { Nav.hold(false); App.layOut(); return; }
      // Taken again while the mark flew home: the new hand-off owns the card now.
      if (e.task) { Nav.hold(false); return; }
      var stands = [].slice.call(el.querySelectorAll('.c-holder'));
      var line = el.querySelector('.c-under, .c-context');
      var old = line && line.cloneNode(true);
      stands.forEach(function (x) { x.remove(); });
      App.redrawCard(e);
      stands.forEach(function (x) {
        el.insertBefore(x, el.firstChild);
        Motion.body(x.firstChild).to({ y: 22 }, 'travel', { done: function () { x.remove(); } });
      });
      if (old) Landing.rollLine(el, old);
      Motion.knock(el, -90);
      Nav.hold(false);
      App.layOut();
    };
    var row = readWorkRow(), mark = el && (el.querySelector('.c-mark .mark') || el.closest('.block, .bundle').querySelector('.mark'));
    var from = row && row.querySelector('.ic').getBoundingClientRect();
    if (!el || !row || !mark || !from.width || Motion.isReduced()) { stand(); return; }
    Motion.fly('<span class="token">' + mark.outerHTML + '</span>', from, mark.getBoundingClientRect(), { ms: 240, grow: true }).then(stand);
  }

  /**
   * Undoes the last move, from anywhere. The move is reversed in the data first, then the page is brought to it, so a page that
   * was empty comes back with the card on it.
   */
  function undo() {
    var u = history.pop();
    if (!u) return;
    if (u.type === 'link') { Relations.restore(u.relation); App.layOut(); if (Open.isOpen()) Open.refresh(); if (history.length) showToast('Undone', 'Undo'); else hideToast(); return; }
    if (Open.isOpen()) Open.hide(true);
    var wasElsewhere = Pages.current() !== 'inbox' || App.state.mode !== 'cards';
    restoreSnapshot(u.snap);
    if (wasElsewhere) {
      Pages.setView('inbox', true);
      App.state.mode = 'cards';
      App.redraw();
    } else if (u.type === 'assign' && u.e.kind !== 'hercule/cluster') {
      Nav.hold(true);
      playUnassign(u.e);
    } else if (u.type === 'noticed' || u.e && u.e.kind === 'hercule/cluster') {
      App.reflowNoticed();
    } else {
      // If the card is still stepping aside, its copy gives way to the card coming back.
      document.querySelectorAll('.is-leaving-copy').forEach(function (c) { if (c.querySelector('[data-id="' + u.e.id + '"]')) c.remove(); });
      App.layOut();
      var back = u.e && App.els()[u.e.id];
      if (back) Motion.body(back.parentNode).set({ x: 14, y: 0, o: 0 }).to({ x: 0, o: 1 }, 'travel');
    }
    Nav.setCount('inbox', App.countOverdue());
    var backEl = u.e && App.els()[u.e.id];
    if (u.e && Keys.isUsingKeys() && backEl) Keys.focus(u.e.id);
    else if (u.type === 'dismiss' && backEl) Pointer.takeBack(backEl);
    if (history.length) showToast('Undone', 'Undo'); else hideToast();
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
    var side = (el && el.closest && el.closest('.ib-wide, .ib-narrow')) || document.querySelector('.ib-wide');
    if (!side) return;
    var main = document.getElementById('main').getBoundingClientRect();
    t.style.left = side.getBoundingClientRect().left - main.left + 'px';
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

  return { perform: perform, link: link, unlink: unlink, reveal: reveal, refuse: refuse, hand: hand, take: take, dismiss: dismiss, undo: undo, assign: assign, reset: reset, showToast: showToast, hideToast: hideToast, start: start };
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
    var under = card ? card.getBoundingClientRect().bottom : r.bottom;
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
