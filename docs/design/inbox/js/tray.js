// A pile fanned open. The cards that folded or settled spread out from where they lay, in a tray over the page. It is the one
// place in the Inbox that scrolls, because it is the one place you ask to see everything.
window.Tray = (function () {
  var host, scrim, source = null, current = [], closing = false;
  function drawTitle(el) {
    if (el.dataset.foot) return 'Moved on from ' + App.STACKS[el.dataset.foot].title;
    var t = el.querySelector('.c-title').textContent;
    return t === 'more' ? 'Newer cards' : t;
  }
  function show(el) {
    var members = el._members || [];
    source = el;
    closing = false;
    var r = el.getBoundingClientRect();
    var main = document.getElementById('main').getBoundingClientRect();
    // The tray lies over the page's last two columns, so its cards land on the grid.
    var cols = document.querySelectorAll('.col:not(.col--shelf)');
    var isGrid = cols.length === 3;
    var w = isGrid ? cols[2].getBoundingClientRect().right - cols[1].getBoundingClientRect().left + 28 : Math.min(760, main.width - 64);
    host.hidden = false;
    host.style.width = w + 'px';
    current = members;
    var open = members.filter(function (e) { return !e.task; });
    // One workflow for a whole pile is honest only if it fits every card in it.
    var flows = open.length && open.every(function (e) { return Card.readWorkflows(e)[0] && Card.readWorkflows(e)[0].name === Card.readWorkflows(open[0])[0].name; }) ? Card.readWorkflows(open[0]) : [];
    // Cards that settled are with someone already, so there is nothing to hand on from that pile.
    var bulk = open.length > 1 && !el.dataset.foot ? (flows[0] ? '<button class="btn btn--sm" data-all="hand">' + Crew.face(flows[0].name, { pose: 'idle', size: 18 }) + 'Hand all ' + open.length + ' to ' + Card.esc(flows[0].name) + '</button>' : '') + '<button class="btn btn--sm btn--quiet" data-all="dismiss">Dismiss all</button>' : '';
    var find = members.length > 12 ? '<input class="tray-find" data-find placeholder="Find…" aria-label="Find in these cards">' : '';
    host.innerHTML = '<div class="tray-h"><h2>' + Card.esc(drawTitle(el)) + (/^\d/.test(drawTitle(el)) ? '' : ' <small>' + members.length + '</small>') + '</h2>' + find + '<span class="tray-all">' + bulk + '</span><button class="icon-btn icon-btn--sm" data-close aria-label="Close" title="Close (Esc)">' + Crew.icon('close', 13) + '</button></div>' +
      '<p class="tray-none" hidden>No card here matches.</p><div class="tray-grid" role="list">' + members.map(function (e) {
        return '<div class="tray-cell" role="listitem" data-open="' + e.id + '"></div>';
      }).join('') + '</div>';
    [].forEach.call(host.querySelectorAll('.tray-cell'), function (cell, i) {
      var e = members[i];
      var card = Card.createCard(e, { now: App.state.now, usual: el.dataset.foot ? e.signals[e.signals.length - 1].key : App.STACKS[App.readStack(e)].usual });
      card.classList.add('is-whole');
      card.dataset.level = 'full';
      card.removeAttribute('role');
      card.tabIndex = i === 0 ? 0 : -1;
      cell.appendChild(card);
    });
    var h = Math.min(host.offsetHeight, innerHeight - 80);
    var left = isGrid ? cols[1].getBoundingClientRect().left - 14 : Math.max(main.left + 24, Math.min(r.left, main.right - w - 24));
    var top = Math.max(document.querySelector('.ib-page').getBoundingClientRect().top + 80, Math.min(r.top - h + 40, innerHeight - h - 24));
    // The tray's top edge never cuts through a stack's heading: it rises to cover the whole numeral.
    [].forEach.call(document.querySelectorAll('.stack-h'), function (heading) {
      var b = heading.getBoundingClientRect();
      if (b.right > left && top > b.top - 8 && top < b.bottom + 12) top = b.top - 8;
    });
    h = Math.min(h, innerHeight - top - 24);
    host.style.left = left + 'px';
    host.style.top = top + 'px';
    host.style.maxHeight = h + 'px';
    host.setAttribute('aria-label', drawTitle(el));
    scrim.hidden = false;
    void scrim.offsetWidth;
    scrim.classList.add('is-on');
    Motion.knock(el, 145);
    // While the cards travel out of the pile the tray does not clip them. Those below its edge wait, because they stay put.
    var visible = readVisibleCells();
    host.style.overflow = 'visible';
    [].forEach.call(host.querySelectorAll('.tray-cell'), function (cell) { if (visible.indexOf(cell) < 0) cell.style.visibility = 'hidden'; });
    setTimeout(function () {
      host.style.overflow = '';
      [].forEach.call(host.querySelectorAll('.tray-cell'), function (cell) { cell.style.visibility = ''; });
    }, Motion.isReduced() ? 0 : 460);
    // The veil goes first, so the panel's words never print over the page's.
    Motion.body(host).set({ o: 0 }).to({ o: 1 }, 'hand', { delay: 80 });
    host.querySelector('[data-close]').focus({ preventScroll: true });
    visible.forEach(function (cell, i) {
      var c = cell.getBoundingClientRect();
      Motion.body(cell).set({ x: r.left - c.left, y: r.top - c.top, s: 0.9 }).to({ x: 0, y: 0, s: 1 }, 'travel', { delay: Math.min(i * 18, 180) });
    });
  }

  /** Returns the cards a Find has left in view: a move on all means all that can be seen. */
  function readShown() {
    var ids = [].map.call(host.querySelectorAll('.tray-cell:not([hidden]) .card'), function (c) { return c.dataset.id; });
    return current.filter(function (e) { return ids.indexOf(e.id) >= 0; });
  }

  /** Keeps the words of the buttons true to what is in view. */
  function drawBulkWords() {
    var shown = readShown(), open = shown.filter(function (e) { return !e.task; });
    var hand = host.querySelector('[data-all="hand"]'), dismiss = host.querySelector('[data-all="dismiss"]');
    var all = host.querySelector('.tray-all');
    if (all) all.hidden = open.length < 1;
    if (hand && open.length) {
      delete hand.dataset.sure;
      hand.style.minWidth = '';
      hand.classList.remove('btn--accent');
      hand.lastChild.textContent = 'Hand ' + (open.length === current.length ? 'all ' : '') + open.length + ' to ' + Card.readWorkflows(open[0])[0].name;
    }
    if (dismiss) dismiss.textContent = open.length === current.length ? 'Dismiss all' : 'Dismiss ' + open.length;
    var none = host.querySelector('.tray-none');
    if (none) none.hidden = shown.length > 0;
  }

  /** Returns the cells that can be seen, because only they need to travel. */
  function readVisibleCells() {
    var box = host.getBoundingClientRect();
    return [].filter.call(host.querySelectorAll('.tray-cell'), function (c) {
      return c.getBoundingClientRect().top < box.bottom;
    });
  }

  /** Folds the cards back into the pile they came from. */
  function hide() {
    if (!host || host.hidden || closing) return;
    closing = true;
    host.classList.add('is-closing');
    // A pile has been visited once it has been opened, so its news is no longer news.
    current.forEach(function (e) { e.fresh = false; });
    var r = source.getBoundingClientRect();
    // The pile may have run out while the tray was open. Then the cards have nowhere to fold to, and the tray only fades.
    var hasHome = r.width > 0;
    scrim.classList.remove('is-on');
    if (hasHome) {
      host.style.overflow = 'visible';
      readVisibleCells().forEach(function (cell) {
        var c = cell.getBoundingClientRect();
        Motion.body(cell).to({ x: r.left - c.left, y: r.top - c.top, s: 0.9 }, 'travel');
      });
    }
    Motion.body(host).to({ o: 0 }, 'travel', { delay: 150, done: function () {
      host.hidden = true;
      closing = false;
      host.classList.remove('is-closing');
      Motion.body(host).clear();
      if (!Open.isOpen()) scrim.hidden = true;
      App.layOut(true);
      App.releaseArrivals(null);
    } });
    if (hasHome && source.focus) source.focus({ preventScroll: true });
    else document.getElementById('main').focus({ preventScroll: true });
  }

  function isOpen() { return !!host && !host.hidden && !closing; }

  /** Takes a card out of the tray, when a move has taken it off the page. */
  function remove(id) {
    if (!host || host.hidden) return;
    var card = host.querySelector('.card[data-id="' + id + '"]');
    if (card) card.parentNode.remove();
    current = current.filter(function (e) { return e.id !== id; });
    var n = host.querySelector('.tray-h small');
    if (n) n.textContent = current.length;
    refresh();
    // The card that held focus is gone, so the next one takes it and the keys keep working.
    var next = host.querySelector('.tray-cell:not([hidden]) .card');
    if (next && !host.hidden && !closing && !host.contains(document.activeElement) && !Open.isOpen()) next.focus({ preventScroll: true });
  }

  /** Writes a card in the open tray again, after a signal landed on it, and lights its rim. */
  function drawNews(e) {
    var seen = host && !host.hidden && host.querySelector('.card[data-id="' + e.id + '"]');
    if (!seen) return false;
    Card.redrawBody(seen, e, { now: App.state.now, usual: null });
    seen.dataset.landed = 'plain';
    seen.classList.add('is-landed');
    setTimeout(function () { seen.classList.remove('is-landed'); }, 1300);
    return true;
  }

  /** Keeps the tray true to its cards, and closes it when none are left. */
  function refresh() {
    if (!host || host.hidden) return;
    if (!current.length) { hide(); return; }
    drawBulkWords();
  }

  /** The keys of the tray: they move through its cards and act on the one with focus. */
  function onKey(ev) {
    var k = ev.key;
    if (ev.target.matches('input')) {
      if (k === 'Escape' && ev.target.value) { ev.preventDefault(); ev.target.value = ''; ev.target.dispatchEvent(new Event('input', { bubbles: true })); return; }
      if (k === 'ArrowDown') {
        ev.preventDefault();
        var first = host.querySelector('.tray-cell:not([hidden]) .card');
        if (first) first.focus();
        return;
      }
      if (k !== 'Escape') return;
    }
    if (k === 'Escape') { ev.preventDefault(); hide(); return; }
    if (ev.repeat && 'hteg'.indexOf(k) >= 0) return;
    var cards = [].filter.call(host.querySelectorAll('.tray-cell:not([hidden]) .card'), function () { return true; });
    var at = cards.indexOf(document.activeElement);
    var card = cards[at];
    if (k === 'j' || k === 'ArrowDown' || k === 'ArrowRight') { ev.preventDefault(); (cards[at + 1] || cards[0]).focus(); return; }
    if (k === 'k' || k === 'ArrowUp' || k === 'ArrowLeft') { ev.preventDefault(); (cards[Math.max(0, at - 1)] || cards[0]).focus(); return; }
    if (!card) return;
    if (k === 'Enter' || k === ' ') { ev.preventDefault(); Open.show(card.dataset.id, card, true); return; }
    var name = { h: 'hand', t: 'take', e: 'dismiss', g: 'go' }[k];
    if (!name) return;
    ev.preventDefault();
    var next = cards[at + 1] || cards[at - 1];
    if (Moves.perform(name, card.dataset.id, card) && next && next.isConnected) next.focus();
  }
  function start() {
    host = document.getElementById('tray');
    scrim = document.getElementById('scrim');
    scrim.addEventListener('click', function () { if (isOpen() && !Open.isOpen()) hide(); });
    host.addEventListener('click', function (ev) {
      if (ev.target.closest('[data-close]')) { hide(); return; }
      var all = ev.target.closest('[data-all]');
      if (all) {
        var open = readShown().filter(function (e) { return !e.task; });
        if (all.dataset.all !== 'hand') { Moves.dismissAll(open); return; }
        // Many runs at once deserve a second press, because each one spends real work.
        if (open.length > 10 && !all.dataset.sure) {
          all.style.minWidth = all.offsetWidth + 'px';
          all.dataset.sure = '1';
          all.classList.add('btn--accent');
          all.lastChild.textContent = 'Start ' + open.length + ' runs';
          setTimeout(function () { if (all.isConnected) drawBulkWords(); }, 3000);
          return;
        }
        Moves.handAll(open, Card.readWorkflows(open[0])[0].name);
        return;
      }
      var act = ev.target.closest('[data-act]');
      var card = ev.target.closest('.card');
      if (!card) return;
      if (act) { ev.stopPropagation(); Moves.perform(act.dataset.act, card.dataset.id, act); return; }
      Open.show(card.dataset.id, card);
    });
    host.addEventListener('input', function (ev) {
      var q = ev.target.value.toLowerCase();
      [].forEach.call(host.querySelectorAll('.tray-cell'), function (cell) {
        cell.hidden = !!q && cell.textContent.toLowerCase().indexOf(q) < 0;
      });
      drawBulkWords();
      var shown = host.querySelectorAll('.tray-cell:not([hidden]) .card');
      [].forEach.call(host.querySelectorAll('.tray-cell .card'), function (c) { c.tabIndex = -1; });
      if (shown[0]) shown[0].tabIndex = 0;
      Landing.announce(shown.length + ' of ' + current.length + ' shown');
    });
    host.addEventListener('focusin', function (ev) {
      var card = ev.target.closest('.card');
      if (!card) return;
      [].forEach.call(host.querySelectorAll('.tray-cell .card'), function (c) { c.tabIndex = c === card ? 0 : -1; });
    });
  }
  return { show: show, hide: hide, drawNews: drawNews, isOpen: isOpen, remove: remove, refresh: refresh, onKey: onKey, start: start };
})();
