// The pointer. There is one current card, shared with the keys. Hovering a card shows its moves. A second click at the same spot
// repeats a dismiss on the card that came into that place, the way closing a tab brings the next tab under the pointer.
window.Pointer = (function () {
  var hover = null, lastX = 0, lastY = 0, lastT = 0, keysAtX = 0, keysAtY = 0, settledAt = 0, settleTimer = 0;
  var lastAct = null, actX = 0, actY = 0, actT = 0;

  /** Reads what lies under a resting pointer, once the page has stopped moving. */
  function reread() {
    if (Keys.isUsingKeys() || !lastT) return;
    var under = document.elementFromPoint(lastX, lastY);
    setHover(under && under.closest('.card[data-id]:not(.is-leaving), .part[data-id]'));
  }

  /** Gives the pointer back the card an Undo has just put under it. */
  function takeBack(el) { if (hover) handOver(el); }

  /** Notes where the pointer rests when the keys take over. */
  function noteKeys() { keysAtX = lastX; keysAtY = lastY; }

  /** Lets go of a card that is leaving. */
  function forget(el) { if (hover === el) hover = null; }

  /** Takes away a thing's new mark, once the person has seen what landed on it. */
  function clearFresh(el) {
    var e = App.findEntity(el.dataset.id);
    if (e && e.fresh) { e.fresh = false; var dot = el.querySelector('.c-fresh'); if (dot) dot.remove(); }
  }

  function setHover(el) {
    if (el === hover) return;
    if (hover) hover.classList.remove('is-hover');
    hover = el;
    if (!el) { Keys.setCurrent(null, 'pointer'); return; }
    if (el.classList.contains('is-source')) return;
    el.classList.add('is-hover');
    clearFresh(el);
    Keys.setCurrent(el.dataset.id, 'pointer');
  }

  /** Forgets the hover without touching the keys' current card. */
  function clearHover() {
    if (hover) hover.classList.remove('is-hover');
    hover = null;
  }

  /** Hands the pointer's card over to the one that takes its place. Hit tests wait until the page has stopped moving. */
  function handOver(el) {
    settledAt = performance.now() + 320;
    if (hover) hover.classList.remove('is-hover');
    hover = el || null;
    if (!el) { Keys.setCurrent(null, 'pointer'); return; }
    el.classList.add('is-hover');
    Keys.setCurrent(el.dataset.id, 'pointer');
  }

  function start() {
    var page = document.getElementById('page');
    page.addEventListener('pointermove', function (ev) {
      if (document.documentElement.dataset.dragging) return;
      lastX = ev.clientX; lastY = ev.clientY; lastT = ev.timeStamp;
      // A pointer resting on the page must not take over from the keys for a nudge of the desk: only real travel does.
      if (Keys.isUsingKeys() && Math.hypot(lastX - keysAtX, lastY - keysAtY) < 12) return;
      // While the page closes up, what is under the pointer is a moving target. Where it came to rest is read as soon as it stops.
      if (performance.now() < settledAt) { clearTimeout(settleTimer); settleTimer = setTimeout(reread, settledAt - performance.now() + 10); return; }
      var plaque = ev.target.closest('.plaque');
      setHover(ev.target.closest('.part[data-id]') || ev.target.closest('.card[data-id]:not(.is-leaving)'));
      document.querySelectorAll('.plaque.is-hover').forEach(function (p) { if (p !== plaque) p.classList.remove('is-hover'); });
      if (plaque) { plaque.classList.add('is-hover'); Keys.setCurrent(plaque.dataset.id, 'pointer'); }
      if (!plaque && !ev.target.closest('.card, .part')) Keys.setCurrent(null, 'pointer');
    });
    page.addEventListener('pointerleave', function () {
      setHover(null);
      document.querySelectorAll('.plaque.is-hover').forEach(function (p) { p.classList.remove('is-hover'); });
    });
    page.addEventListener('click', function (ev) {
      var isSameSpot = lastAct && Math.hypot(ev.clientX - actX, ev.clientY - actY) < 4 && performance.now() - actT < 1500;
      if (isSameSpot && hover && hover.classList.contains('card')) {
        actT = performance.now();
        Moves.perform(lastAct, hover.dataset.id);
        return;
      }
      var hint = ev.target.closest('[data-hint]');
      if (hint) { Moves.link(App.findEntity(hint.dataset.hint), App.findEntity(hint.dataset.other)); return; }
      var echo = ev.target.closest('.echo');
      if (echo) { Moves.reveal(echo.dataset.id); return; }
      var act = ev.target.closest('[data-act]');
      var card = ev.target.closest('.card[data-id], .plaque');
      if (act && card) {
        // The second click of a double click on Take it must not land on the On Work that replaced it.
        if (act.dataset.act === 'go' && performance.now() - actT < 400) return;
        lastAct = act.dataset.act === 'dismiss' ? 'dismiss' : null;
        actX = ev.clientX; actY = ev.clientY; actT = performance.now();
        ev.stopPropagation();
        Moves.perform(act.dataset.act, card.dataset.id, act);
        return;
      }
      var opens = ev.target.closest('.part[data-id], .b-open[data-id]') || card;
      if (opens) Open.show(opens.dataset.id, opens);
    });
  }

  return { start: start, setHover: setHover, clearHover: clearHover, handOver: handOver, forget: forget, noteKeys: noteKeys, reread: reread, takeBack: takeBack, clearFresh: clearFresh, readHover: function () { return hover; } };
})();
