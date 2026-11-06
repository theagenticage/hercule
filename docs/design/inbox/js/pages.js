// The other places a card leads to: Intake, grouped by entity, and a stand-in for Work, which the Overview design owns.
window.Pages = (function () {
  var K = Kinds.KINDS, W = World;
  var current = 'inbox';
  var raised = {};

  // Intake's rows: every outside thing that sent a signal, most of which never needed anyone.
  var ROWS = [
    { id: 'in-coupon', mark: 'sentry', title: 'CouponRuleError: rule set missing for market "default"', ref: 'CHECKOUT-API-3H1', n: 212, last: '4m', state: 'noticed', noticed: 'c-coupons' },
    { id: 'in-feed', mark: 'sentry', title: 'FeedRecordError: product has no brand to fill a required column', ref: 'SEARCH-API-1Z4', n: 148, last: '12m', state: 'noticed', noticed: 'c-search' },
    { id: 'in-6238', mark: 'github', title: 'Retry card payments once on a gateway timeout', ref: '#6238', n: 7, last: '22m', state: 'inbox', signals: ['Ines asked for your review', 'Checks failed', 'CI started', 'CI finished', 'Pushed 2 commits', 'Bot comment: coverage', 'Omar commented'] },
    { id: 'in-bot', mark: 'github', title: 'Bump vite to the next minor', ref: '#6271', n: 3, last: '35m', state: 'quiet' },
    { id: 'in-tablet', mark: 'sentry', title: 'TypeError: slideWatcher.observe is not a function', ref: 'STOREFRONT-WEB-2K9', n: 38, last: '1h', state: 'noticed', noticed: 'c-photos' },
    { id: 'in-tax', mark: 'sentry', title: 'RangeError: tax band index out of range', ref: 'CHECKOUT-API-4D1', n: 9, last: '1h', state: 'quiet', can: true },
    { id: 'in-ops', mark: 'linear', title: 'Add depot opening hours to the returns page', ref: 'OPS-58', n: 2, last: '2h', state: 'inbox' },
    { id: 'in-deploy', mark: 'github', title: 'Deploy to staging finished', ref: 'storefront-web', n: 31, last: '2h', state: 'quiet' },
    { id: 'in-slack', mark: 'slack', title: 'Is the depot scanner firmware safe to roll out?', ref: '#depots', n: 6, last: '3h', state: 'quiet', can: true },
    { id: 'in-mail', mark: 'gmail', title: 'Your October invoice from the hosting provider', ref: 'Mail', n: 1, last: '5h', state: 'quiet' },
    { id: 'in-cron', mark: 'sentry', title: 'Nightly rollup took longer than usual', ref: 'INSIGHTS-JOBS-77', n: 4, last: '7h', state: 'quiet', can: true },
    { id: 'in-6258', mark: 'github', title: 'Stop sending duplicate order emails', ref: '#6258', n: 2, last: '7h', state: 'inbox' },
  ];

  function drawRow(r) {
    var said = { noticed: 'Noticed', inbox: 'In your Inbox', quiet: '' }[r.state];
    return '<li class="in-row' + (r.state === 'quiet' ? ' is-quiet' : '') + '" data-row="' + r.id + '">' +
      '<span class="in-mark">' + Crew.brand(r.mark, 16) + '</span>' +
      '<span class="in-t"><b>' + Card.esc(r.title) + '</b><small>' + Card.esc(r.ref) + '</small></span>' +
      '<span class="in-end">' + (r.can && !raised[r.id] ? '<button class="btn btn--sm in-raise" data-raise="' + r.id + '">Raise to Inbox</button>' : '<span class="in-state">' + (raised[r.id] ? 'In your Inbox' : said) + '</span>') +
      '<span class="in-n">' + r.n + '</span><span>' + r.last + '</span></span>' +
      (r.signals ? '<ol class="in-signals">' + r.signals.map(function (s) { return '<li>' + Card.esc(s) + '</li>'; }).join('') + '</ol>' : '') +
      '</li>';
  }

  function drawIntake() {
    var page = document.getElementById('page');
    page.dataset.mode = 'intake';
    page.innerHTML = '<div class="in-wrap"><h2 class="in-head"><b>214 signals</b> about 61 things. Nine rose to your Inbox.</h2>' +
      '<p class="in-sub">Everything that arrived, one line per thing, with how many signals it sent.</p>' +
      '<ul class="in-list">' + ROWS.map(drawRow).join('') + '</ul></div>';
  }

  function setView(name) {
    if (Open.isOpen()) Open.hide(true);
    current = name;
    document.querySelectorAll('[data-view]').forEach(function (b) { b.classList.toggle('is-on', b.dataset.view === (name === 'intake' ? 'intake' : 'cards')); });
    document.querySelectorAll('[data-nav]').forEach(function (r) { r.classList.toggle('is-on', r.dataset.nav === (name === 'work' ? 'overview' : 'inbox')); });
    document.getElementById('main').dataset.view = name;
    if (name === 'intake') { drawIntake(); App.state.mode = 'intake'; return; }
    if (name === 'work') { Work.draw(); App.state.mode = 'work'; return; }
    App.state.mode = 'stacks';
    page().dataset.mode = 'stacks';
    App.settle();
    App.redraw();
  }
  function page() { return document.getElementById('page'); }

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
    row.querySelector('.in-raise').outerHTML = '<span class="in-state">In your Inbox</span>';
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
      var v = ev.target.closest('[data-view]');
      if (v) { setView(v.dataset.view === 'intake' ? 'intake' : 'inbox'); return; }
      var n = ev.target.closest('[data-nav]');
      if (n && n.dataset.nav === 'overview') { setView('work'); return; }
      if (n && n.dataset.nav === 'inbox') { setView('inbox'); return; }
      var b = ev.target.closest('[data-raise]');
      if (b) { raise(b.dataset.raise); return; }
      var row = ev.target.closest('.in-row');
      if (row) row.classList.toggle('is-open');
    });
  }

  return { current: function () { return current; }, goToWork: goToWork, setView: setView, start: start };
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
      el.animate([{ transform: 'translate(' + dx + 'px,' + dy + 'px)', opacity: 0.4 }, { transform: 'none', opacity: 1 }], { duration: Motion.curve('open').ms, easing: Motion.curve('open').ease });
    }
    el.animate([{ boxShadow: '0 0 0 0 transparent' }, { boxShadow: '0 0 0 3px color-mix(in oklab, var(--accent) 30%, transparent)', offset: 0.2 }, { boxShadow: '0 0 0 0 transparent' }], { duration: 1400, delay: 200 });
  }
  return { draw: draw, reveal: reveal };
})();
