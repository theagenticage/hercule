// Hover and peek. A card under the pointer shows its actions. After a short rest it shows its whole face, over the cards
// in front of it. No other card moves, so the pointer's target never shifts.
window.Pointer = (function () {
  var PEEK_DELAY = 260;  // ms of rest before the first peek
  var LEAVE_DELAY = 140; // ms before a peek closes when the pointer has left the stack
  var hover = null, peeked = null, timer = 0, leaveTimer = 0;

  /** Shows the whole face of a card. Its lower part takes no pointer, so the cards under it can still be reached. */
  function peek(el) {
    if (peeked === el) return;
    unpeek();
    if (!el._plan || el.dataset.level === 'full') return;
    peeked = el;
    var host = el.parentNode;
    el.querySelector('.c-hit').style.height = el._plan.show + 'px';
    el.classList.add('is-peek');
    var height = measurePeek(el);
    var over = el._plan.y + height - Number(host.dataset.depth || 0) - 8;
    markUnder(el, host, height);
    el.style.height = el._plan.show + 'px';
    void el.offsetHeight;
    el.style.transition = '';
    el.style.height = height + 'px';
    if (over > 0) Motion.body(el).to({ y: -over }, 'glide');
  }

  /** Returns how tall a card stands in a peek: its whole face at strip size. */
  function measurePeek(el) {
    var was = el.style.height;
    el.style.transition = 'none';
    el.style.height = 'auto';
    var whole = el.offsetHeight + 10;
    el.style.height = was;
    return whole;
  }

  /** Hides the second line of the strip a peek ends on, so no sliver of a hidden card shows under it. */
  function markUnder(el, host, height) {
    var bottom = el._plan.y + height;
    [].forEach.call(host.children, function (c) {
      c.classList.toggle('is-under', !!(c !== el && c._plan && c._plan.y < bottom && c._plan.y + c._plan.show > bottom));
    });
  }

  function unpeek() {
    var el = peeked;
    if (!el) return;
    peeked = null;
    if (el._plan) {
      el.style.height = el._plan.show + 'px';
      Motion.body(el).to({ y: 0 }, 'glide');
      [].forEach.call(el.parentNode.children, function (c) { c.classList.remove('is-under'); });
    }
    var done = function () {
      if (el === peeked) return;
      el.classList.remove('is-peek');
      if (el._rest) el.style.height = el._rest + 'px';
    };
    setTimeout(done, Motion.isReduced() ? 0 : 170);
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
    if (!el) { leaveTimer = setTimeout(unpeek, LEAVE_DELAY); return; }
    clearTimeout(leaveTimer);
    el.classList.add('is-hover');
    measureActs(el);
    clearFresh(el);
    if (peeked) peek(el);
    else timer = setTimeout(function () { if (hover === el) peek(el); }, PEEK_DELAY);
  }

  function start() {
    var page = document.getElementById('page');
    page.addEventListener('pointermove', function (ev) {
      if (document.documentElement.dataset.dragging) return;
      setHover(ev.target.closest('.card:not(.is-pile)'));
      var plaque = ev.target.closest('.plaque');
      document.querySelectorAll('.plaque.is-hover').forEach(function (p) { if (p !== plaque) p.classList.remove('is-hover'); });
      if (plaque) plaque.classList.add('is-hover');
    });
    page.addEventListener('pointerleave', function () {
      setHover(null);
      document.querySelectorAll('.plaque.is-hover').forEach(function (p) { p.classList.remove('is-hover'); });
      Moves.closeHoles();
    });
    page.addEventListener('click', function (ev) {
      var folded = ev.target.closest('.pile, .card.is-pile, .stack-foot');
      if (folded) { Tray.show(folded); return; }
      var act = ev.target.closest('[data-act]');
      var card = ev.target.closest('.card, .plaque');
      if (!card) return;
      if (act) { ev.stopPropagation(); Moves.perform(act.dataset.act, card.dataset.id, act); return; }
      Open.show(card.dataset.id);
    });
  }

  return { start: start, peek: peek, unpeek: unpeek, setHover: setHover, measureActs: measureActs, peeked: function () { return peeked; } };
})();
