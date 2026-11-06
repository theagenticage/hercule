// The keyboard. There is one current card, shared with the pointer, and every key acts on it. Every move moves on to the next
// card that still waits, so a stack can be worked through with one hand. Arrows move through the page the way it is laid out.
window.Keys = (function () {
  var current = null, usingKeys = false, marked = null;

  /** Returns the cards of the page as columns of ids, in the order the eye reads them. */
  function readGrid() {
    var columns = App.readColumns();
    var cols = columns.map(function () { return []; });
    columns.forEach(function (names, c) {
      names.forEach(function (n) {
        var host = document.querySelector('[data-stack="' + n + '"]');
        if (!host) return;
        var cards = [].slice.call(host.querySelectorAll('.card')).filter(function (el) { return el._plan && !el.classList.contains('is-leaving'); });
        cards.sort(function (a, b) { return a._plan.y - b._plan.y; });
        cards.forEach(function (el) { cols[c].push(el.dataset.id || el.dataset.pile); });
      });
    });
    return cols;
  }

  /** Returns the whole page in reading order: what Hercule noticed, then the stacks, column by column. */
  function readFlat() {
    var plaques = [].map.call(document.querySelectorAll('.plaque'), function (p) { return p.dataset.id; });
    return plaques.concat([].concat.apply([], readGrid()));
  }

  /** Returns the card lying just under this one in its stack, by order. */
  function readBelow(id) {
    var el = readEl(id);
    var cards = [].slice.call(el.parentNode.querySelectorAll('.card')).filter(function (c) { return c._plan && !c.classList.contains('is-pile') && !c.classList.contains('is-leaving'); });
    cards.sort(function (a, b) { return a._plan.y - b._plan.y; });
    var next = cards[cards.indexOf(el) + 1];
    return next ? next.dataset.id : null;
  }

  function readEl(id) { return App.els()[id] || document.querySelector('.plaque[data-id="' + id + '"]'); }

  /** Returns the next card after this one that still waits on the person. Work runs down a stack and never onto the plate. */
  function readNextWaiting(id) {
    var grid = readGrid(), col = grid.filter(function (c) { return c.indexOf(id) >= 0; })[0];
    var isWaiting = function (x) { var e = App.findEntity(x); return x !== id && e && !e.task; };
    if (!col) {
      var plaques = readFlat().filter(function (x) { var e = App.findEntity(x); return e && e.kind === 'hercule/cluster' && !e.task && x !== id; });
      return plaques[0] || null;
    }
    var at = col.indexOf(id);
    return col.slice(at + 1).filter(isWaiting)[0] || col.slice(0, at).reverse().filter(isWaiting)[0] || null;
  }

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
    var el = id && readEl(id);
    if (!el) { Pointer.unpeek(); return; }
    Pointer.clearHover();
    marked = id;
    el.classList.add('is-focus');
    if (el.classList.contains('card') && !el.classList.contains('is-pile')) Pointer.measureActs(el);
    el.focus({ preventScroll: true });
    if (el.classList.contains('card') && !el.classList.contains('is-pile') && el.dataset.level !== 'full') Pointer.peek(el);
    else Pointer.unpeek();
  }

  function focus(id) { setCurrent(id, 'keys'); }

  function move(dx, dy) {
    var cols = readGrid();
    if (!current || !readEl(current)) { focus(readFlat()[0]); return; }
    var c = 0, r = 0;
    cols.forEach(function (col, ci) { var i = col.indexOf(current); if (i >= 0) { c = ci; r = i; } });
    if (dy) { focus(cols[c][Math.max(0, Math.min(cols[c].length - 1, r + dy))]); return; }
    var nc = Math.max(0, Math.min(cols.length - 1, c + dx));
    if (!cols[nc].length) return;
    var me = readEl(current).getBoundingClientRect().top, best = cols[nc][0], gap = Infinity;
    cols[nc].forEach(function (id) { var d = Math.abs(readEl(id).getBoundingClientRect().top - me); if (d < gap) { gap = d; best = id; } });
    focus(best);
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
    if (el.classList.contains('is-pile')) { Moves.showToast('A pile opens with Enter.'); return; }
    var next = readNextWaiting(id);
    var anchor = el.querySelector('[data-act="hand"]') || el;
    var moveOn = function () { if (next && readEl(next)) focus(next); else setCurrent(null, 'keys'); };
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
    if (ev.target.matches('input, textarea, select')) { if (ev.key === 'Escape') ev.target.blur(); return; }
    if (Menu.key(ev)) { ev.preventDefault(); return; }
    var k = ev.key;
    if ((ev.metaKey || ev.ctrlKey) && k === 'z') { ev.preventDefault(); Moves.undo(); return; }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (Help.isOpen() && (k === 'Escape' || k === '?')) { ev.preventDefault(); Help.toggle(); return; }
    if (Tray.isOpen() && !Open.isOpen()) { Tray.onKey(ev); return; }
    if (Open.isOpen()) { onKeyInOpenCard(ev, k); return; }
    if (Pages.current() === 'intake') { Pages.onKey(ev); return; }
    if (Pages.current() !== 'inbox') return;
    // The page's keys belong to the page. A control elsewhere, such as the sidebar, keeps its own.
    if (ev.target !== document.body && !ev.target.closest('#page, #main')) return;
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
      var chosen = readEl(current);
      if (chosen && chosen.classList.contains('is-pile')) Tray.show(chosen);
      else if (chosen) Open.show(current, null, true);
    }
    else if (k === 'Escape') { var was = current; if (was) { setCurrent(null, 'keys'); } }
    else if (k === 'h' && current) act('hand');
    else if (k === 't' && current) act('take');
    else if (k === 'e' && current) act('dismiss');
    else if (k === 'g' && current) act('go');
    else if (k === '?') Help.toggle();
    else handled = false;
    if (handled) ev.preventDefault();
  }

  /** The keys inside an open card: a walk through the cards in one place, and the moves, each moving on to the next card. */
  function onKeyInOpenCard(ev, k) {
    if (k === 'Escape') { ev.preventDefault(); Open.hide(); return; }
    if (ev.repeat) return;
    var id = Open.current();
    // A card opened from a tray has no neighbours on the page to walk to.
    var inTray = Open.isFromTray();
    var flat = readFlat().filter(function (x) { return !!App.findEntity(x); }), i = flat.indexOf(id);
    if (k === 'j' || k === 'k') {
      ev.preventDefault();
      var to = !inTray && flat[i + (k === 'j' ? 1 : -1)];
      if (to) { Open.walk(to); current = to; }
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
    var next = !inTray && readNextWaiting(id);
    // The next card opens in the same place, and the move plays on the card behind it.
    if (next && App.findEntity(next)) { Open.walk(next); current = next; }
    else Open.hide(true);
    if (name === 'hand') Moves.hand(e, pick); else Moves.perform(name, id);
  }

  function start() {
    document.addEventListener('click', function (ev) { if (ev.target.closest('[data-help]')) Help.toggle(); });
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Tab') return;
      if (Open.isOpen()) trap(ev, document.getElementById('open'));
      else if (Tray.isOpen()) trap(ev, document.getElementById('tray'));
    });
    document.addEventListener('keydown', onKey);
    document.getElementById('page').addEventListener('focusin', function (ev) {
      var c = ev.target.closest('.card, .plaque');
      var id = c && (c.dataset.id || c.dataset.pile);
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

  return { start: start, focus: focus, focusQuietly: focusQuietly, clear: clear, setCurrent: setCurrent, readBelow: readBelow, current: function () { return current; }, isUsingKeys: function () { return usingKeys; } };
})();

// The sheet of keys, on ?.
window.Help = (function () {
  var el;
  var KEYS = [['↑ ↓ ← →', 'Move through the page'], ['J K', 'Next, previous'], ['Space ↩', 'Open the card, or fan a pile'], ['H', 'Hand to an agent'], ['1 2 3', 'Pick a workflow'], ['T', 'Take it on myself'], ['E', 'Dismiss'], ['G', 'See its Task on Work'], ['⌘Z', 'Undo, as far back as you like'], ['Esc', 'Close, or let go']];
  function toggle() {
    if (!el) {
      el = document.createElement('aside');
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
