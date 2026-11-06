// The other places a card leads to: Intake, grouped by entity, and a stand-in for Work, which the Overview design owns.
window.Pages = (function () {
  var K = Kinds.KINDS, W = World;
  var current = 'inbox';
  var raised = {};
  var at = -1; // the row of Intake the keys are on

  // Intake's rows: every outside thing that sent a signal, most of which never needed anyone.
  var ROWS = [
    { id: 'in-coupon', mark: 'sentry', title: 'CouponRuleError: rule set missing for market "default"', ref: 'CHECKOUT-API-3H1', n: 14, last: '4m', state: 'noticed', noticed: 'c-coupons' },
    { id: 'in-feed', mark: 'sentry', title: 'FeedRecordError: product has no brand to fill a required column', ref: 'SEARCH-API-1Z4', n: 23, last: '12m', state: 'noticed', noticed: 'c-search' },
    { id: 'in-6238', mark: 'github', title: 'Retry card payments once on a gateway timeout', ref: '#6238', n: 7, last: '22m', state: 'inbox', signals: ['Ines asked for your review', 'Checks failed', 'CI started', 'CI finished', 'Pushed 2 commits', 'Bot comment: coverage', 'Omar commented'] },
    { id: 'in-bot', mark: 'github', title: 'Bump vite to the next minor', ref: '#6271', n: 3, last: '35m', state: 'quiet' },
    { id: 'in-tablet', mark: 'sentry', title: 'TypeError: slideWatcher.observe is not a function', ref: 'STOREFRONT-WEB-2K9', n: 11, last: '1h', state: 'noticed', noticed: 'c-photos' },
    { id: 'in-tax', mark: 'sentry', title: 'RangeError: tax band index out of range', ref: 'CHECKOUT-API-4D1', n: 5, last: '1h', state: 'quiet', can: true },
    { id: 'in-ops', mark: 'linear', title: 'Add depot opening hours to the returns page', ref: 'OPS-58', n: 2, last: '2h', state: 'inbox' },
    { id: 'in-deploy', mark: 'github', title: 'Deploy to staging finished', ref: 'storefront-web', n: 12, last: '2h', state: 'quiet' },
    { id: 'in-slack', mark: 'slack', title: 'Is the depot scanner firmware safe to roll out?', ref: '#depots', n: 6, last: '3h', state: 'quiet', can: true },
    { id: 'in-mail', mark: 'gmail', title: 'Your October invoice from the hosting provider', ref: 'Mail', n: 1, last: '5h', state: 'quiet' },
    { id: 'in-cron', mark: 'sentry', title: 'Nightly rollup took longer than usual', ref: 'INSIGHTS-JOBS-77', n: 4, last: '7h', state: 'quiet', can: true },
    { id: 'in-6258', mark: 'github', title: 'Stop sending duplicate order emails', ref: '#6258', n: 2, last: '7h', state: 'inbox' },
  ];

  var MARKS = {};
  Object.keys(K).forEach(function (id) { MARKS[K[id].plugin.mark] = K[id].plugin; });

  function drawRow(r) {
    var said = { noticed: 'Noticed', inbox: 'In your Inbox', quiet: '' }[r.state];
    return '<li class="in-row' + (r.state === 'quiet' ? ' is-quiet' : '') + '" data-row="' + r.id + '" tabindex="0"' + (r.signals ? ' aria-expanded="false"' : '') + '>' +
      '<span class="in-mark">' + Card.drawMark(MARKS[r.mark], 16) + '</span>' +
      '<span class="in-t"><b>' + Card.esc(r.title) + '</b><small>' + Card.esc(r.ref) + '</small>' + (raised[r.id] || said ? '<em class="in-state">' + (raised[r.id] ? 'In your Inbox' : said) + '</em>' : '') + '</span>' +
      '<span class="in-end">' + (r.can && !raised[r.id] ? '<button class="btn btn--sm in-raise" data-raise="' + r.id + '">Raise</button>' : '<i></i>') +
      '<span class="in-n" title="Signals">' + r.n + '</span><span>' + r.last + '</span></span>' +
      (r.signals ? '<ol class="in-signals">' + r.signals.map(function (s) { return '<li>' + Card.esc(s) + '</li>'; }).join('') + '</ol>' : '') +
      '</li>';
  }

  function drawIntake() {
    var page = document.getElementById('page');
    page.dataset.mode = 'intake';
    page.innerHTML = '<div class="in-wrap"><h2 class="in-head"><b>214</b><span>Signals about 61 things</span></h2>' +
      '<ul class="in-list">' + ROWS.map(drawRow).join('') + '</ul><div class="in-more">49 more things, all quiet</div></div>';
  }

  function setView(name, keepState) {
    if (name === current && !keepState) return;
    if (Open.isOpen()) Open.hide(true);
    Menu.hide();
    Keys.clear();
    Pointer.unpeek();
    current = name;
    document.querySelectorAll('[data-nav]').forEach(function (r) { r.classList.toggle('is-on', r.dataset.nav === (name === 'work' ? 'overview' : 'inbox')); });
    document.getElementById('main').dataset.page = name;
    Tray.hide();
    drawPill(name);
    if (name === 'intake') { at = -1; drawIntake(); App.state.mode = 'intake'; return; }
    if (name === 'work') { Work.draw(); App.state.mode = 'work'; return; }
    Nav.setNew(false);
    App.state.mode = 'stacks';
    page().dataset.mode = 'stacks';
    if (keepState) return;
    App.settle();
    App.redraw();
  }
  function page() { return document.getElementById('page'); }

  /** Sets the pill for the place on screen: the Inbox's own, or the one Overview draws. */
  function drawPill(name) {
    var pill = document.getElementById('pill');
    var hadFocus = document.activeElement && document.activeElement.dataset.view;
    pill.innerHTML = name === 'work'
      ? '<h1 class="pill-title">Overview</h1><button class="ptab">' + Crew.icon('office', 14) + 'Office</button><button class="ptab is-on">' + Crew.icon('tasks', 14) + 'Work</button>'
      : '<h1 class="pill-title">Inbox</h1><button class="ptab' + (name === 'intake' ? '' : ' is-on') + '" data-view="cards"' + (name === 'intake' ? '' : ' aria-current="page"') + '>Cards</button><button class="ptab' + (name === 'intake' ? ' is-on' : '') + '" data-view="intake"' + (name === 'intake' ? ' aria-current="page"' : '') + '>Intake</button>';
    var again = hadFocus && pill.querySelector('[data-view="' + hadFocus + '"]');
    if (again) again.focus();
    document.querySelector('.ib-end').hidden = name !== 'inbox';
  }

  /** Raises a row of Intake to the Inbox: the row lifts, a token flies to the Cards tab, and a card waits there. */
  function raise(id) {
    var r = ROWS.filter(function (x) { return x.id === id; })[0];
    var row = document.querySelector('[data-row="' + id + '"]');
    raised[id] = true;
    var from = row.querySelector('.in-mark').getBoundingClientRect();
    var to = document.querySelector('[data-view="cards"]').getBoundingClientRect();
    Motion.animate(row, [{ transform: 'none' }, { transform: 'translateY(-3px)', offset: 0.3 }, { transform: 'none' }], { duration: 420, easing: 'ease-out' });
    Motion.fly('<span class="token">' + Crew.brand(r.mark, 14) + '</span>', from, to).then(function () {
      Motion.animate(document.querySelector('[data-view="cards"]'), [{ background: 'color-mix(in oklab, var(--accent) 22%, transparent)' }, { background: 'transparent' }], { duration: 700, easing: 'ease-out' });
    });
    App.state.entities.push(Scenes.raisedEntity(r));
    row.querySelector('.in-raise').outerHTML = '<i></i>';
    row.querySelector('.in-t').insertAdjacentHTML('beforeend', '<em class="in-state">In your Inbox</em>');
    row.focus({ preventScroll: true });
    Landing.announce('In your Inbox: ' + r.title);
    row.classList.remove('is-quiet');
    Nav.setCount('inbox', App.countOverdue());
  }

  function goToWork(e) {
    var el = e && App.els()[e.id];
    var r = el && el.getBoundingClientRect();
    setView('work');
    if (e) Work.reveal(e, r);
  }

  function start() {
    document.addEventListener('click', function (ev) {
      if (ev.target.closest('a[href="#"]')) ev.preventDefault();
      var v = ev.target.closest('[data-view]');
      if (v) { setView(v.dataset.view === 'intake' ? 'intake' : 'inbox'); return; }
      var n = ev.target.closest('[data-nav]');
      if (n && n.dataset.nav === 'overview') { setView('work'); return; }
      if (n && n.dataset.nav === 'inbox') { setView('inbox'); return; }
      var b = ev.target.closest('[data-raise]');
      if (b) { raise(b.dataset.raise); return; }
      var row = ev.target.closest('.in-row');
      if (row) { row.setAttribute('aria-expanded', row.classList.toggle('is-open')); at = [].indexOf.call(row.parentNode.children, row); }
    });
  }

  /** The keys of Intake: J and K move, Enter opens a row, R raises it, Esc goes back to the cards. */
  function onKey(ev) {
    var rows = document.querySelectorAll('.in-row'), k = ev.key;
    if (k === 'Escape') { ev.preventDefault(); setView('inbox'); document.querySelector('[data-view="cards"]').focus(); return; }
    var here = ev.target.closest && ev.target.closest('.in-row');
    if (here) at = [].indexOf.call(rows, here);
    if (k === 'j' || k === 'ArrowDown') at = Math.min(rows.length - 1, at + 1);
    else if (k === 'k' || k === 'ArrowUp') at = Math.max(0, at - 1);
    else if (k === 'Enter' && rows[at] && !ev.target.closest('button')) rows[at].setAttribute('aria-expanded', rows[at].classList.toggle('is-open'));
    else if (k === 'r' && rows[at]) { var b = rows[at].querySelector('[data-raise]'); if (b) raise(b.dataset.raise); }
    else return;
    ev.preventDefault();
    [].forEach.call(rows, function (r, i) { r.classList.toggle('is-at', i === at); });
    if (rows[at]) rows[at].focus({ preventScroll: false });
  }

  return { current: function () { return current; }, goToWork: goToWork, setView: setView, onKey: onKey, start: start };
})();

// A stand-in for Work, so that the way through can be walked. The Overview design owns the real board.
window.Work = (function () {
  var K = Kinds.KINDS;
  var STAGES = [['Exploring', []], ['Planned', ['Guest checkout without an account']], ['Building', ['Serve smaller product photos']], ['In review', ['Restore a basket after sign-in', 'Delivery slot page feels slow at noon']], ['Landed', []]];
  function drawTask(title, holder) {
    return '<article class="card work-card">' + (holder || '') + '<i class="card-stock"></i><div class="card-text"><span class="card-title">' + Card.esc(title) + '</span></div></article>';
  }
  function draw() {
    var page = document.getElementById('page');
    page.dataset.mode = 'work';
    var tasks = App.state.entities.filter(function (e) { return e.task && !e.settled; });
    page.innerHTML = '<div class="work"><p class="work-note">A stand-in. The Overview design owns this board.</p><div class="work-cols">' + STAGES.map(function (s, i) {
      var mine = i === 3 ? tasks.filter(function (e) { return e.task.by !== 'you'; }) : i === 0 ? tasks.filter(function (e) { return e.task.by === 'you'; }) : [];
      return '<section class="work-col"><h3>' + s[0] + '</h3>' + s[1].map(function (t) { return drawTask(t); }).join('') + mine.map(function (e) {
        return '<div data-task="' + e.id + '">' + drawTask(e.title, Card.drawHolder(e)) + '</div>';
      }).join('') + '</section>';
    }).join('') + '</div></div>';
  }
  function reveal(e, from) {
    var el = document.querySelector('[data-task="' + e.id + '"]');
    if (!el || Motion.isReduced()) return;
    var to = el.getBoundingClientRect();
    if (from) {
      var dx = from.left - to.left, dy = from.top - to.top;
      el.animate([{ transform: 'translate(' + dx + 'px,' + dy + 'px)', opacity: 0.4 }, { transform: 'none', opacity: 1 }], { duration: Motion.curve('travel').ms, easing: Motion.curve('travel').ease });
    }
    el.querySelector('.card-stock').animate([{ outline: '0 solid transparent' }, { outline: '3px solid color-mix(in oklab, var(--accent) 34%, transparent)', offset: 0.2 }, { outline: '0 solid transparent' }], { duration: 1400, delay: 200 });
  }
  return { draw: draw, reveal: reveal };
})();
