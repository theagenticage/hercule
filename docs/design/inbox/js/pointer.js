// The pointer. The card under it is the current card, the same one the keys act on. It shows its actions at once, and after a
// short rest its whole face, over the cards in front of it. No other card moves, so the pointer's target never shifts.
window.Pointer = (function () {
  var PEEK_DELAY = 260;  // ms of rest before the first peek
  var HAND_OVER = 70;    // ms of rest before a showing peek moves to another card
  var LEAVE_DELAY = 140; // ms before a peek closes when the pointer has left the stack
  var hover = null, peeked = null, timer = 0, leaveTimer = 0;
  var speed = 0, lastX = 0, lastY = 0, lastT = 0, overWrap = null, settledAt = 0, lastAct = null, keysAtX = 0, keysAtY = 0;
  var actX = 0, actY = 0, actT = 0, onActions = false;

  /** Returns how tall a card stands in a peek: its whole face at strip size, kept inside the window. */
  function measurePeek(el) {
    var was = el.style.height;
    el.style.transition = 'none';
    el.style.height = 'auto';
    var whole = el.offsetHeight + 8;
    var room = innerHeight - el.getBoundingClientRect().top - 8;
    el.style.height = was;
    return Math.min(whole, room);
  }

  /** Hides the words of any strip the edge of a peek would reach, so no line is cut and none is left to read as the peek's own. */
  function markUnder(el, host, height) {
    var bottom = el._plan.y + height;
    [].forEach.call(host.children, function (c) {
      var into = c !== el && c._plan ? bottom - c._plan.y : -1;
      c.classList.toggle('is-under', into > 6 && c._plan && into < c._plan.show);
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
      el.classList.add('is-closing');
      el.style.height = el._plan.show + 'px';
      [].forEach.call(el.parentNode.children, function (c) { c.classList.remove('is-under'); });
    }
    setTimeout(function () {
      el.classList.remove('is-closing');
      if (el === peeked) return;
      el.classList.remove('is-peek');
      if (el._rest) el.style.height = el._rest + 'px';
    }, Motion.isReduced() ? 0 : 230);
  }

  /** Reads what lies under a resting pointer, after a stack has turned over beneath it. */
  function reread() {
    if (Keys.isUsingKeys() || !lastT) return;
    var under = document.elementFromPoint(lastX, lastY);
    setHover(under && under.closest('.stack .card:not(.is-pile):not(.is-leaving):not(.is-folding)'));
  }

  /** Gives the pointer back the card an Undo has just put under it. */
  function takeBack(el) {
    if (hover) handOver(el);
  }

  /** Notes where the pointer rests when the keys take over. */
  function noteKeys() { keysAtX = lastX; keysAtY = lastY; }

  /** Lets go of a card without closing its peek, because the card itself is leaving. */
  function forget(el) {
    if (peeked !== el) { unpeek(); return; }
    peeked = null;
    [].forEach.call(el.parentNode.children, function (c) { c.classList.remove('is-under'); });
  }

  /** Tells a card how wide its actions are, so its title can end before them. */
  function measureActs(el) {
    var acts = el.querySelector('.c-acts');
    // The actions overflow a box of no width, so their width is the sum of the buttons, and 8px of air before them.
    if (acts) el.style.setProperty('--acts-w', [].reduce.call(acts.children, function (sum, b) { return sum + b.offsetWidth + 2; }, 8) + 'px');
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
    if (el.classList.contains('is-source')) return;
    clearTimeout(leaveTimer);
    el.classList.add('is-hover');
    measureActs(el);
    clearFresh(el);
    Keys.setCurrent(el.dataset.id, 'pointer');
    // A peek hands over at once only to a pointer that has slowed down, so a quick exit does not ripple through the stack.
    // A pointer on the actions wants the actions, so the card holds still under it.
    timer = setTimeout(function () { if (hover === el && !onActions) peek(el); }, peeked ? (speed > 0.8 ? 220 : HAND_OVER) : PEEK_DELAY);
  }

  /** Forgets the hover without touching the keys' current card. */
  function clearHover() {
    clearTimeout(timer);
    if (hover) hover.classList.remove('is-hover');
    hover = null;
  }

  /** Hands the pointer's card over to the one that takes its place. Hit tests wait until the page has stopped moving. */
  function handOver(el) {
    settledAt = performance.now() + 320;
    clearTimeout(timer);
    if (hover) hover.classList.remove('is-hover');
    hover = el || null;
    if (!el) { Keys.setCurrent(null, 'pointer'); return; }
    el.classList.add('is-hover');
    measureActs(el);
    Keys.setCurrent(el.dataset.id, 'pointer');
  }

  function start() {
    var page = document.getElementById('page');
    page.addEventListener('pointermove', function (ev) {
      if (document.documentElement.dataset.dragging) return;
      speed = Math.hypot(ev.clientX - lastX, ev.clientY - lastY) / Math.max(1, ev.timeStamp - lastT);
      lastX = ev.clientX; lastY = ev.clientY; lastT = ev.timeStamp;
      // A pointer resting on the page must not take over from the keys for a nudge of the desk: only real travel does.
      if (Keys.isUsingKeys() && Math.hypot(lastX - keysAtX, lastY - keysAtY) < 12) return;
      // While a stack closes up, what is under the pointer is a moving target, so the card handed over stays current.
      if (performance.now() < settledAt) return;
      var plaque = ev.target.closest('.plaque');
      onActions = !!ev.target.closest('.c-acts');
      setHover(ev.target.closest('.card:not(.is-pile):not(.is-leaving)'));
      document.querySelectorAll('.plaque.is-hover').forEach(function (p) { if (p !== plaque) p.classList.remove('is-hover'); });
      if (plaque) { plaque.classList.add('is-hover'); Keys.setCurrent(plaque.dataset.id, 'pointer'); }
      var wrap = ev.target.closest('[data-wrap]');
      if (wrap !== overWrap) { overWrap = wrap; App.releaseArrivals(wrap && wrap.dataset.wrap); }
      if (!plaque && !ev.target.closest('.card')) Keys.setCurrent(null, 'pointer');
    });
    page.addEventListener('pointerleave', function () {
      setHover(null);
      overWrap = null;
      App.releaseArrivals(null);
      document.querySelectorAll('.plaque.is-hover').forEach(function (p) { p.classList.remove('is-hover'); });
    });
    page.addEventListener('click', function (ev) {
      // A second click at the same spot means the same move, on the card now in that place, for as long as the pointer stays.
      var isSameSpot = lastAct && Math.hypot(ev.clientX - actX, ev.clientY - actY) < 4 && performance.now() - actT < 1500;
      if (isSameSpot && hover) {
        actT = performance.now();
        Moves.perform(lastAct, hover.dataset.id);
        return;
      }
      var folded = ev.target.closest('.card.is-pile, .stack-foot');
      if (folded) { Tray.show(folded); return; }
      var act = ev.target.closest('[data-act]');
      var card = ev.target.closest('.card, .plaque');
      if (!card) return;
      if (act) {
        lastAct = act.dataset.act === 'dismiss' ? 'dismiss' : null;
        actX = ev.clientX; actY = ev.clientY; actT = performance.now();
        ev.stopPropagation();
        Moves.perform(act.dataset.act, card.dataset.id, act);
        return;
      }
      Open.show(card.dataset.id);
    });
  }

  return { start: start, peek: peek, unpeek: unpeek, setHover: setHover, clearHover: clearHover, handOver: handOver, forget: forget, noteKeys: noteKeys, reread: reread, takeBack: takeBack, measureActs: measureActs, stackUnderPointer: function () { return overWrap && overWrap.dataset.wrap; } };
})();
