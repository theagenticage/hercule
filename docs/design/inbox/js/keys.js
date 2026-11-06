// The keyboard. Every action has a key, and arrows move through the page the way it is laid out.
window.Keys = (function () {
  var K = Kinds.KINDS;
  var focused = null;

  /** Returns the cards of the page as columns of ids, in the order the eye reads them. */
  function readGrid() {
    var cols = [[], [], []];
    document.querySelectorAll('.plaque').forEach(function (p, i) { cols[Math.min(i, 2)].push(p.dataset.id); });
    App.COLUMNS.forEach(function (names, c) {
      names.forEach(function (n) {
        var host = document.querySelector('[data-stack="' + n + '"]');
        var cards = [].slice.call(host.querySelectorAll('.card')).filter(function (el) { return el._plan && !el.classList.contains('is-leaving'); });
        cards.sort(function (a, b) { return a._plan.y - b._plan.y; });
        cards.forEach(function (el) { cols[c].push(el.dataset.id); });
      });
    });
    return cols;
  }

  function readEl(id) { return App.els()[id] || document.querySelector('.plaque[data-id="' + id + '"]'); }

  /** Moves the keyboard's focus to a card, and shows its whole face. */
  function focus(id) {
    var prev = focused && readEl(focused);
    if (prev) prev.classList.remove('is-focus');
    focused = id;
    var el = id && readEl(id);
    if (!el) return;
    el.classList.add('is-focus');
    if (el.classList.contains('card')) Pointer.measureActs(el);
    el.focus({ preventScroll: true });
    if (el.classList.contains('card')) { if (el.dataset.level === 'full') Pointer.unpeek(); else Pointer.peek(el); }
    else Pointer.unpeek();
  }

  function move(dx, dy) {
    var cols = readGrid();
    if (!focused) { focus(cols[0][0] || cols[1][0] || cols[2][0]); return; }
    var c = 0, r = 0;
    cols.forEach(function (col, ci) { var i = col.indexOf(focused); if (i >= 0) { c = ci; r = i; } });
    if (dy) { focus(cols[c][Math.max(0, Math.min(cols[c].length - 1, r + dy))]); return; }
    var nc = Math.max(0, Math.min(2, c + dx));
    if (!cols[nc].length) return;
    var me = readEl(focused).getBoundingClientRect().top, best = cols[nc][0], gap = Infinity;
    cols[nc].forEach(function (id) { var d = Math.abs(readEl(id).getBoundingClientRect().top - me); if (d < gap) { gap = d; best = id; } });
    focus(best);
  }

  function walk(step) {
    var flat = [].concat.apply([], readGrid());
    var i = flat.indexOf(focused);
    focus(flat[Math.max(0, Math.min(flat.length - 1, i + step))]);
  }

  function onKey(ev) {
    if (ev.target.matches('input, textarea, select')) return;
    if (Menu.key(ev)) { ev.preventDefault(); return; }
    var k = ev.key;
    if ((ev.metaKey || ev.ctrlKey) && k === 'z') { ev.preventDefault(); Moves.undo(); return; }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (Open.isOpen()) {
      if (k === 'Escape') { ev.preventDefault(); Open.hide(); return; }
      var id = Open.current();
      if (k === 'j' || k === 'k') { ev.preventDefault(); var flat = [].concat.apply([], readGrid()); var i = flat.indexOf(id); var next = flat[i + (k === 'j' ? 1 : -1)]; if (next) { Open.hide(true); Open.show(next); focused = next; } return; }
      var map = { h: '[data-act="hand-to"]', t: '[data-act="take"]', e: '[data-act="dismiss"]', g: '[data-act="go"]' };
      var n = Number(k);
      var sel = n >= 1 ? '[data-act="hand-to"][data-i="' + (n - 1) + '"]' : map[k];
      var b = sel && document.querySelector('#open ' + sel);
      if (b) { ev.preventDefault(); Open.act(b); }
      return;
    }
    if (Pages.current() !== 'inbox') return;
    var handled = true;
    if (k === 'ArrowDown') move(0, 1);
    else if (k === 'ArrowUp') move(0, -1);
    else if (k === 'ArrowLeft') move(-1, 0);
    else if (k === 'ArrowRight') move(1, 0);
    else if (k === 'j') walk(1);
    else if (k === 'k') walk(-1);
    else if ((k === 'Enter' || k === ' ') && focused) Open.show(focused);
    else if (k === 'Escape') { if (focused) { var el = readEl(focused); if (el) el.classList.remove('is-focus'); Pointer.unpeek(); focused = null; } }
    else if (k === 'h' && focused) Moves.perform('hand', focused, readEl(focused).querySelector('[data-act="hand"]') || readEl(focused));
    else if (k === 't' && focused) Moves.perform('take', focused);
    else if (k === 'e' && focused) { var cols = [].concat.apply([], readGrid()); var at = cols.indexOf(focused); var gone = focused; Moves.perform('dismiss', gone); focus(cols[at + 1] || cols[at - 1]); }
    else if (k === 'g' && focused) Moves.perform('go', focused);
    else if (k === '?') Help.toggle();
    else handled = false;
    if (handled) ev.preventDefault();
  }

  /** Keeps Tab inside the open card or the tray, and hands focus to the page's keys when a card takes it. */
  function trap(ev, host) {
    var stops = [].slice.call(host.querySelectorAll('button, a[data-source]'));
    if (!stops.length) return;
    var i = stops.indexOf(document.activeElement);
    ev.preventDefault();
    stops[(i + (ev.shiftKey ? -1 : 1) + stops.length) % stops.length].focus();
  }

  function start() {
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Tab') return;
      if (Open.isOpen()) trap(ev, document.getElementById('open'));
      else if (Tray.isOpen()) trap(ev, document.getElementById('tray'));
    });
    document.addEventListener('keydown', onKey);
    document.getElementById('page').addEventListener('focusin', function (ev) {
      var c = ev.target.closest('.card[data-id], .plaque');
      if (c && c.dataset.id !== focused) focus(c.dataset.id);
    });
  }
  return { start: start, focus: focus, focused: function () { return focused; } };
})();

// The sheet of keys, on ?.
window.Help = (function () {
  var el;
  var KEYS = [['↑ ↓ ← →', 'Move through the page'], ['J K', 'Next, previous'], ['Space', 'Open the card'], ['H', 'Hand to an agent'], ['T', 'Take it on myself'], ['E', 'Dismiss'], ['G', 'See its Task on Work'], ['⌘Z', 'Undo'], ['Esc', 'Close, or let go']];
  function toggle() {
    if (!el) {
      el = document.createElement('aside');
      el.className = 'keys';
      el.innerHTML = '<h2>Keys</h2>' + KEYS.map(function (k) { return '<div><kbd>' + k[0] + '</kbd><span>' + k[1] + '</span></div>'; }).join('');
      document.getElementById('main').appendChild(el);
      return;
    }
    el.hidden = !el.hidden;
  }
  return { toggle: toggle };
})();
