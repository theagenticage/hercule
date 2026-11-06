// The pointer. The card under it is the current card, the same one the keys act on. It shows its actions at once, and after a
// short rest its whole face, over the cards in front of it. No other card moves, so the pointer's target never shifts.
window.Pointer = (function () {
  var PEEK_DELAY = 260;  // ms of rest before the first peek
  var HAND_OVER = 70;    // ms of rest before a showing peek moves to another card
  var LEAVE_DELAY = 140; // ms before a peek closes when the pointer has left the stack
  var hover = null, peeked = null, timer = 0, leaveTimer = 0;
  var speed = 0, lastX = 0, lastY = 0, lastT = 0, overWrap = null;

  /** Returns how tall a card stands in a peek: its whole face at strip size, kept inside the window. */
  function measurePeek(el) {
    var was = el.style.height;
    el.style.transition = 'none';
    el.style.height = 'auto';
    var whole = el.offsetHeight + 10;
    var room = innerHeight - el.getBoundingClientRect().top - 8;
    el.style.height = was;
    return Math.min(whole, room);
  }

  /** Hides the second line of the strip a peek ends on, so no sliver of a hidden card shows under it. */
  function markUnder(el, host, height) {
    var bottom = el._plan.y + height;
    [].forEach.call(host.children, function (c) {
      c.classList.toggle('is-under', !!(c !== el && c._plan && c._plan.y < bottom && c._plan.y + c._plan.show > bottom));
    });
  }

  /** Shows the whole face of a card. Its lower part takes no pointer, so the cards under it can still be reached. */
  function peek(el) {
    if (peeked === el) return;
    unpeek();
    if (!el._plan || el.dataset.level === 'full' || el.classList.contains('is-pile') || el.classList.contains('is-leaving')) return;
    peeked = el;
    var host = el.parentNode;
    el.querySelector('.c-hit').style.height = el._plan.show + 'px';
    el.classList.add('is-peek');
    var height = measurePeek(el);
    markUnder(el, host, height);
    el.style.height = el._plan.show + 'px';
    void el.offsetHeight;
    el.style.transition = '';
    el.style.height = height + 'px';
  }

  function unpeek() {
    var el = peeked;
    if (!el) return;
    peeked = null;
    if (el._plan) {
      el.style.height = el._plan.show + 'px';
      [].forEach.call(el.parentNode.children, function (c) { c.classList.remove('is-under'); });
    }
    setTimeout(function () {
      if (el === peeked) return;
      el.classList.remove('is-peek');
      if (el._rest) el.style.height = el._rest + 'px';
    }, Motion.isReduced() ? 0 : 230);
  }

  /** Tells a card how wide its actions are, so its title can end before them. */
  function measureActs(el) {
    var acts = el.querySelector('.c-acts');
    if (acts) el.style.setProperty('--acts-w', acts.offsetWidth - 4 + 'px');
  }

  /** Takes away a card's new mark, once the person has seen what landed on it. */
  function clearFresh(el) {
    var e = App.findEntity(el.dataset.id);
    if (e && e.fresh) { e.fresh = false; var dot = el.querySelector('.c-fresh'); if (dot) dot.remove(); }
  }

  function setHover(el) {
    if (el === hover) return;
    if (hover) hover.classList.remove('is-hover');
    hover = el;
    clearTimeout(timer);
    if (!el) {
      leaveTimer = setTimeout(unpeek, LEAVE_DELAY);
      Keys.setCurrent(null, 'pointer');
      return;
    }
    clearTimeout(leaveTimer);
    el.classList.add('is-hover');
    measureActs(el);
    clearFresh(el);
    Keys.setCurrent(el.dataset.id, 'pointer');
    // A peek hands over at once only to a pointer that has slowed down, so a quick exit does not ripple through the stack.
    timer = setTimeout(function () { if (hover === el) peek(el); }, peeked ? (speed > 0.8 ? 220 : HAND_OVER) : PEEK_DELAY);
  }

  /** Forgets the hover without touching the keys' current card. */
  function clearHover() {
    clearTimeout(timer);
    if (hover) hover.classList.remove('is-hover');
    hover = null;
  }

  /** Reads what is under the pointer again, after a move changed the page beneath it. */
  function refresh() {
    var el = document.elementFromPoint(lastX, lastY);
    if (!el || !lastT) return;
    setHover(el.closest('.stack .card:not(.is-pile):not(.is-leaving)'));
  }

  function start() {
    var page = document.getElementById('page');
    page.addEventListener('pointermove', function (ev) {
      if (document.documentElement.dataset.dragging) return;
      speed = Math.hypot(ev.clientX - lastX, ev.clientY - lastY) / Math.max(1, ev.timeStamp - lastT);
      lastX = ev.clientX; lastY = ev.clientY; lastT = ev.timeStamp;
      setHover(ev.target.closest('.card:not(.is-pile):not(.is-leaving)'));
      var plaque = ev.target.closest('.plaque');
      document.querySelectorAll('.plaque.is-hover').forEach(function (p) { if (p !== plaque) p.classList.remove('is-hover'); });
      if (plaque) { plaque.classList.add('is-hover'); Keys.setCurrent(plaque.dataset.id, 'pointer'); }
      var wrap = ev.target.closest('[data-wrap]');
      if (wrap !== overWrap) { overWrap = wrap; App.releaseArrivals(wrap && wrap.dataset.wrap); }
    });
    page.addEventListener('pointerleave', function () {
      setHover(null);
      overWrap = null;
      App.releaseArrivals(null);
      document.querySelectorAll('.plaque.is-hover').forEach(function (p) { p.classList.remove('is-hover'); });
    });
    page.addEventListener('click', function (ev) {
      var folded = ev.target.closest('.card.is-pile, .stack-foot');
      if (folded) { Tray.show(folded); return; }
      var act = ev.target.closest('[data-act]');
      var card = ev.target.closest('.card, .plaque');
      if (!card) return;
      if (act) { ev.stopPropagation(); Moves.perform(act.dataset.act, card.dataset.id, act); return; }
      Open.show(card.dataset.id);
    });
  }

  return { start: start, peek: peek, unpeek: unpeek, setHover: setHover, clearHover: clearHover, refresh: refresh, measureActs: measureActs, stackUnderPointer: function () { return overWrap && overWrap.dataset.wrap; } };
})();
