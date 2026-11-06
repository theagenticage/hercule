// The keyboard. There is one current card, shared with the pointer, and every key acts on it. Every move moves on to the next
// card that still waits, so a stack can be worked through with one hand. Arrows move through the page the way it is laid out.
window.Keys = (function () {
  var current = null, usingKeys = false, marked = null;

  /** Returns everything that can hold the current mark, in the order the eye reads the page. */
  function readTargets() {
    return [].filter.call(document.querySelectorAll('#page .plaque, #page .card[data-id], #page .part[data-id]'), function (el) { return el.offsetParent !== null && !el.classList.contains('is-leaving'); });
  }

  /** Returns the whole page in reading order, as ids. */
  function readFlat() { return readTargets().map(function (el) { return el.dataset.id; }); }

  function readEl(id) { return document.querySelector('#page .plaque[data-id="' + id + '"], #page .card[data-id="' + id + '"], #page .part[data-id="' + id + '"]'); }

  /** Returns what still waits after this card, in reading order, nearest first. It is read before a move, because a move can take the card off the page. */
  function readWaitingOrder(id) {
    var flat = readFlat(), i = flat.indexOf(id);
    return flat.slice(i + 1).concat(flat.slice(0, Math.max(0, i)).reverse()).filter(function (x) { var e = App.findEntity(x); return e && !e.task; });
  }

  /** Returns the thing to move on to after a move. */
  function pickNext(order) { return order.filter(function (id) { return !!readEl(id); })[0] || null; }

  /** Makes a card the current card. By keyboard it also takes focus, shows the ring and shows its whole face. */
  function setCurrent(id, how) {
    if (how === 'pointer' && usingKeys) {
      // The pointer takes over only by reaching a card. Passing over empty desk leaves the keys where they are.
      if (id === null) return;
    }
    var was = marked && readEl(marked);
    if (was) was.classList.remove('is-focus');
    marked = null;
    current = id;
    if (how === 'pointer') { usingKeys = false; return; }
    usingKeys = true;
    Pointer.noteKeys();
    var el = id && readEl(id);
    if (!el) { current = null; return; }
    bringIntoView(el);
    Pointer.clearHover();
    marked = id;
    el.classList.add('is-focus');
    Pointer.clearFresh(el);
    el.focus({ preventScroll: true });
  }

  function focus(id) { setCurrent(id, 'keys'); }

  /** Scrolls a small window so the current card can be seen. It sets the page's scroll, so a page around a frame stays put. */
  function bringIntoView(el) {
    var page = document.getElementById('page');
    var r = el.getBoundingClientRect(), box = page.getBoundingClientRect();
    if (r.top < box.top) page.scrollTop -= box.top - r.top + 44;
    else if (r.bottom > box.bottom) page.scrollTop += r.bottom - box.bottom + 56;
  }

  /** Moves the current mark to the nearest thing in a direction, by where things lie on screen, so the keys follow the page's own shape. */
  function move(dx, dy) {
    var all = readTargets();
    var el = current && readEl(current);
    if (!el) { if (all[0]) focus(all[0].dataset.id); return; }
    var me = el.getBoundingClientRect(), mx = me.left + me.width / 2, my = me.top + me.height / 2;
    var best = null, score = Infinity;
    all.forEach(function (c) {
      if (c === el) return;
      var r = c.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      var along = dx ? (x - mx) * dx : (y - my) * dy, across = dx ? Math.abs(y - my) : Math.abs(x - mx);
      if (along <= 4) return;
      var s = along + across * 2.5;
      if (s < score) { score = s; best = c; }
    });
    if (best) focus(best.dataset.id);
  }

  function walk(step) {
    var flat = readFlat(), i = flat.indexOf(current);
    focus(flat[Math.max(0, Math.min(flat.length - 1, i + step))]);
  }

  /** Runs a move on the current card, and moves on to the next card that waits. A key always takes over from the pointer. */
  function act(name) {
    var id = current;
    var el = id && readEl(id);
    if (!el) return;
    // The thing may have left already, while its part of the page fades.
    if (!App.findEntity(id)) return;
    var order = readWaitingOrder(id);
    var anchor = el.querySelector('[data-act="hand"]') || el;
    var moveOn = function () {
      var next = pickNext(order);
      if (next) focus(next); else setCurrent(null, 'keys');
    };
    var severalFit = name === 'hand' && Card.readWorkflows(App.findEntity(id)).length > 1;
    if (!Moves.perform(name, id, anchor, moveOn)) return;
    if (name !== 'go' && !severalFit) moveOn();
  }

  /** Keeps Tab inside the open card or the tray. */
  function trap(ev, host) {
    var stops = [].slice.call(host.querySelectorAll('button:not([tabindex="-1"]), a[href], input, [tabindex="0"]'));
    if (!stops.length) return;
    stops = stops.filter(function (el) { return el.offsetParent !== null; });
    var i = stops.indexOf(document.activeElement);
    ev.preventDefault();
    stops[i < 0 ? (ev.shiftKey ? stops.length - 1 : 0) : (i + (ev.shiftKey ? -1 : 1) + stops.length) % stops.length].focus();
  }

  function onKey(ev) {
    if (ev.target.matches('input, textarea, select')) {
      if (ev.key === 'Escape') ev.target.blur();
      return;
    }
    if (Menu.key(ev)) { ev.preventDefault(); return; }
    var k = ev.key;
    if ((ev.metaKey || ev.ctrlKey) && k === 'z') { ev.preventDefault(); Moves.undo(); return; }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // While the help sheet is open, the keys behind it do nothing.
    if (Help.isOpen()) { if (k === 'Escape' || k === '?') { ev.preventDefault(); Help.toggle(); } return; }
    if (Open.isOpen()) { onKeyInOpenCard(ev, k); return; }
    // The page's keys belong to the page. A control elsewhere, such as the sidebar, keeps its own.
    if (ev.target !== document.body && !ev.target.closest('#page, #main')) return;
    if (Pages.current() === 'intake') { Pages.onKey(ev); return; }
    if (Pages.current() !== 'inbox') return;
    // The letters act on a card, so only with focus on a card, or nowhere in particular.
    var isFree = ev.target === document.body || ev.target.id === 'main' || ev.target.closest('.card, .plaque');
    if ('hteg'.indexOf(k) >= 0 && !isFree) return;
    // A real control keeps its own keys.
    if ((k === 'Enter' || k === ' ') && ev.target.closest('button, a, [role="menuitem"]')) return;
    // A held key must never run through the stack.
    if (ev.repeat && 'hteg'.indexOf(k) >= 0) return;
    var handled = true;
    if (k === 'ArrowDown') move(0, 1);
    else if (k === 'ArrowUp') move(0, -1);
    else if (k === 'ArrowLeft') move(-1, 0);
    else if (k === 'ArrowRight') move(1, 0);
    else if (k === 'j') walk(1);
    else if (k === 'k') walk(-1);
    else if ((k === 'Enter' || k === ' ') && current) {
      if (readEl(current)) Open.show(current, readEl(current), true);
    }
    else if (k === 'Escape') {
      if (current) setCurrent(null, 'keys');
      // A pointer resting on a card gets it back, so the next key acts on what is under the hand.
      var under = Pointer.readHover();
      if (under) setCurrent(under.dataset.id, 'pointer');
    }
    else if (k === 'h' && current) act('hand');
    else if (k === 't' && current) act('take');
    else if (k === 'e' && current) act('dismiss');
    else if (k === 'g' && current) act('go');
    else if (k === '?') Help.toggle();
    else handled = false;
    if (handled) ev.preventDefault();
  }

  /** Moves the current card along with a walk of the open sheet, and takes the ring off the card left behind. */
  function noteWalk(id) {
    var was = marked && readEl(marked);
    if (was) was.classList.remove('is-focus');
    current = id;
    marked = null;
  }

  /** The keys inside an open card: a walk through the cards in one place, and the moves, each moving on to the next card. */
  function onKeyInOpenCard(ev, k) {
    if (k === 'Escape') { ev.preventDefault(); Open.hide(); return; }
    if (ev.repeat) return;
    var id = Open.current();
    var flat = readFlat(), i = flat.indexOf(id);
    if (k === 'j' || k === 'k') {
      ev.preventDefault();
      var to = flat[i + (k === 'j' ? 1 : -1)];
      if (to) { Open.walk(to); noteWalk(to); }
      return;
    }
    var e = App.findEntity(id), flows = Card.readWorkflows(e), n = Number(k);
    var name = k === 't' ? 'take' : k === 'e' ? 'dismiss' : k === 'g' ? 'go' : (k === 'h' || n >= 1) ? 'hand' : null;
    if (!name) return;
    ev.preventDefault();
    // Check first: a move that does not apply stays on the card and says why.
    var why = Moves.refuse(name, e);
    if (why) { Moves.showToast(why); return; }
    if (name === 'hand' && k === 'h' && flows.length > 1) { Open.focusFirstMove(); return; }
    if (name === 'hand' && n > flows.length) return;
    var pick = name === 'hand' ? flows[n >= 1 ? n - 1 : 0] : null;
    if (name === 'go') { Open.hide(true); Moves.perform('go', id); return; }
    var next = pickNext(readWaitingOrder(id));
    // The next card opens in the same place, and the move plays on the card behind it.
    if (next) { Open.walk(next); noteWalk(next); }
    else { Open.hide(true); current = null; }
    if (name === 'hand') Moves.hand(e, pick); else Moves.perform(name, id);
  }

  function start() {
    document.addEventListener('click', function (ev) { if (ev.target.closest('[data-help]')) Help.toggle(); });
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Tab') return;
      if (Open.isOpen()) trap(ev, document.getElementById('open'));
    });
    document.addEventListener('keydown', onKey);
    document.getElementById('page').addEventListener('focusin', function (ev) {
      var c = ev.target.closest('.card, .plaque, .part');
      var id = c && c.dataset.id;
      if (usingKeyboardFocus && id && id !== current) focus(id);
    });
    // The ring and the peek are for someone working by keyboard. A click that moves focus draws neither.
    document.addEventListener('pointerdown', function () { usingKeyboardFocus = false; }, true);
    document.addEventListener('keydown', function () { usingKeyboardFocus = true; }, true);
  }
  var usingKeyboardFocus = false;

  /** Forgets the current card, when the page it lay on has gone. */
  function clear() { current = null; marked = null; usingKeys = false; }

  /** Gives an element focus without the ring, for focus that comes back after a pointer move. */
  function focusQuietly(el) {
    var was = usingKeyboardFocus;
    usingKeyboardFocus = false;
    el.focus({ preventScroll: true });
    usingKeyboardFocus = was;
  }

  return { start: start, readAfter: readWaitingOrder, focus: focus, focusQuietly: focusQuietly, clear: clear, setCurrent: setCurrent, current: function () { return current; }, isUsingKeys: function () { return usingKeys; } };
})();

// The sheet of keys, on ?.
window.Help = (function () {
  var el;
  var KEYS = [['↑ ↓ ← →', 'Move through the page'], ['J K', 'Next, previous'], ['Space ↩', 'Open the card'], ['H', 'Hand to an agent'], ['1 2 3', 'Pick a workflow'], ['T', 'Take it on myself'], ['E', 'Dismiss'], ['G', 'See its Task on Work'], ['⌘Z', 'Undo, as far back as you like'], ['Esc', 'Close, or let go']];
  function toggle() {
    if (!el) {
      el = document.createElement('div');
      el.className = 'keys';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', 'Keys');
      el.innerHTML = '<h2>Keys</h2>' + KEYS.map(function (k) { return '<div><kbd>' + k[0] + '</kbd><span>' + k[1] + '</span></div>'; }).join('');
      document.getElementById('main').appendChild(el);
      return;
    }
    el.hidden = !el.hidden;
  }
  function isOpen() { return !!el && !el.hidden; }
  return { toggle: toggle, isOpen: isOpen };
})();
