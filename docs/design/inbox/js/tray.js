// A pile fanned open. The cards that folded or settled spread out from where they lay, in a tray over the page. It is the one
// place in the Inbox that scrolls, because it is the one place you ask to see everything.
window.Tray = (function () {
  var host, scrim, source = null;
  function drawTitle(el) {
    if (el.dataset.foot) return App.STACKS[el.dataset.foot].title + ': settled';
    if (el.classList.contains('is-pile')) return el.querySelector('.c-title').textContent;
    return 'Newer cards';
  }
  function show(el) {
    var members = el._members || [];
    source = el;
    var r = el.getBoundingClientRect();
    var main = document.getElementById('main').getBoundingClientRect();
    var w = Math.min(760, main.width - 64);
    host.hidden = false;
    host.style.width = w + 'px';
    host.innerHTML = '<div class="tray-h"><h2>' + Card.esc(drawTitle(el)) + ' <small>' + members.length + '</small></h2><button class="icon-btn icon-btn--sm" data-close title="Close (Esc)">' + Crew.icon('close', 13) + '</button></div>' +
      '<div class="tray-grid">' + members.map(function (e) {
        return '<div class="tray-cell" data-open="' + e.id + '"></div>';
      }).join('') + '</div>';
    [].forEach.call(host.querySelectorAll('.tray-cell'), function (cell, i) {
      var e = members[i];
      var card = Card.createCard(e, { now: App.state.now, usual: null });
      card.classList.add('is-whole');
      card.dataset.level = 'full';
      cell.appendChild(card);
    });
    var h = Math.min(host.offsetHeight, innerHeight - 80);
    var left = Math.max(main.left + 24, Math.min(r.left, main.right - w - 24));
    var top = Math.max(60, Math.min(r.top - h + 40, innerHeight - h - 24));
    host.style.left = left + 'px';
    host.style.top = top + 'px';
    host.style.maxHeight = h + 'px';
    scrim.hidden = false;
    scrim.classList.add('is-on');
    if (!Motion.isReduced()) {
      var ox = r.left + r.width / 2 - left, oy = r.top - top;
      host.style.transformOrigin = ox + 'px ' + oy + 'px';
      host.animate([{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: Motion.curve('fan').ms * 0.7, easing: Motion.curve('fan').ease });
      [].forEach.call(host.querySelectorAll('.tray-cell'), function (cell, i) {
        if (i > 12) return;
        cell.animate([{ opacity: 0, transform: 'translateY(' + (oy > 80 ? 22 : -22) + 'px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: Motion.curve('fan').ms * 0.8, delay: i * 18, fill: 'backwards', easing: Motion.curve('fan').ease });
      });
    }
  }
  function hide() {
    if (host.hidden) return;
    host.hidden = true;
    scrim.classList.remove('is-on');
    if (!Open.isOpen()) scrim.hidden = true;
  }
  function isOpen() { return !host.hidden; }
  function start() {
    host = document.getElementById('tray');
    scrim = document.getElementById('scrim');
    scrim.addEventListener('click', hide);
    host.addEventListener('click', function (ev) {
      if (ev.target.closest('[data-close]')) { hide(); return; }
      var card = ev.target.closest('.card');
      if (card) Open.show(card.dataset.id, card);
    });
  }
  return { show: show, hide: hide, isOpen: isOpen, start: start };
})();
