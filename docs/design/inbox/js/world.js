// Northwind Market, an invented company. Every person, repository and ticket here is made up.
(function () {
  var NOW = new Date('2026-11-04T08:42:00');
  var hoursAgo = function (h) { return new Date(NOW.getTime() - h * 36e5); };

  var PEOPLE = {
    'juno-park': { name: 'Juno Park', short: 'Juno', hue: 198 },
    'felix-marsh': { name: 'Felix Marsh', short: 'Felix', hue: 345 },
    'omar-haddad': { name: 'Omar Haddad', short: 'Omar', hue: 52 },
    'ines-carvalho': { name: 'Ines Carvalho', short: 'Ines', hue: 282 },
    'theo-brandt': { name: 'Theo Brandt', short: 'Theo', hue: 132 },
    'wren-adeyemi': { name: 'Wren Adeyemi', short: 'Wren', hue: 312 },
    'kofi-mensah': { name: 'Kofi Mensah', short: 'Kofi', hue: 78 },
    'tessa-lindqvist': { name: 'Tessa Lindqvist', short: 'Tessa', hue: 240 },
    you: { name: 'Noa', short: 'You', hue: 78 },
  };

  var uid = 0;
  function signal(key, h, who, value, note) { return { id: 's' + ++uid, key: key, at: hoursAgo(h), who: who || null, value: value || null, note: note || null, open: true }; }

  function pr(number, repo, title, author, h, state, extra) {
    extra = extra || {};
    var signals = extra.signals || [signal('reviewRequested', h, author)];
    return {
      id: 'pr-' + number, kind: 'github/pull-request', concern: extra.concern || 'reviewRequested', title: title, since: hoursAgo(h),
      fields: { number: number, repo: repo, author: author, state: state, diff: extra.diff || [12 + (number * 7) % 180, (number * 3) % 64], files: extra.files || 1 + (number % 9) },
      signals: signals, task: extra.task || null, project: extra.project || repo,
    };
  }
  function mine(number, repo, title, days, state, signals, extra) {
    return pr(number, repo, title, 'you', days * 24, state, Object.assign({ concern: 'opened', signals: signals }, extra || {}));
  }
  function parked(number, repo, title, days) {
    return Object.assign(mine(number, repo, title, days, 'passing', [signal('waiting', days * 24)]), { settled: true, parked: 'with reviewers' });
  }
  function issue(key, title, team, project, state, h, extra) {
    extra = extra || {};
    return {
      id: 'ln-' + key, kind: 'linear/issue', concern: 'assigned', title: title, since: hoursAgo(h),
      fields: { key: key, team: team, project: project, state: state, assignee: 'you', priority: extra.priority || 0, milestone: extra.milestone || null },
      signals: extra.signals || [signal('assigned', h)], task: null, project: project || team,
    };
  }

  function buildEntities() {
    uid = 0;
    return [
      // To review. Oldest first, as a person waits.
      pr(6204, 'storefront-web', 'Cache delivery slot lookups for five minutes', 'juno-park', 131.4, 'passing', { diff: [142, 38], files: 6 }),
      pr(6209, 'storefront-web', 'Split the basket summary into smaller components', 'felix-marsh', 129.2, 'passing', { diff: [318, 244], files: 11 }),
      pr(6213, 'storefront-web', 'Show unit prices on multi-buy offers', 'felix-marsh', 118.7, 'changes', { diff: [96, 12], files: 4, signals: [signal('reviewRequested', 216, 'felix-marsh'), signal('changesRequested', 170, 'omar-haddad'), signal('reReview', 118.7, 'felix-marsh')] }),
      pr(6238, 'storefront-web', 'Retry card payments once on a gateway timeout', 'ines-carvalho', 31.5, 'failing', { diff: [58, 9], files: 3, signals: [signal('reviewRequested', 31.5, 'ines-carvalho'), signal('checksFailed', 30.9)] }),
      pr(6241, 'storefront-web', 'Drop the unused wishlist endpoints', 'theo-brandt', 26.1, 'passing', { diff: [4, 412], files: 9 }),
      pr(6252, 'storefront-web', 'Move promo banner copy into the content tool', 'wren-adeyemi', 10.2, 'passing', { signals: [signal('reviewRequested', 60, 'wren-adeyemi'), signal('reReview', 10.2, 'wren-adeyemi')] }),
      pr(6255, 'storefront-web', 'Add a loading state to the address finder', 'juno-park', 9.3, 'passing', { signals: [signal('reviewRequested', 9.3, 'juno-park'), signal('approved', 5, 'theo-brandt')] }),
      pr(6257, 'storefront-web', 'Round loyalty points down at checkout', 'kofi-mensah', 8.1, 'failing', { signals: [signal('reviewRequested', 50, 'kofi-mensah'), signal('reReview', 8.1, 'kofi-mensah'), signal('checksFailed', 7.6)] }),
      pr(6258, 'storefront-web', 'Stop sending duplicate order emails', 'tessa-lindqvist', 7.2, 'passing'),
      pr(6260, 'storefront-web', 'Log the reason when a coupon is refused', 'ines-carvalho', 6.2, 'failing', { signals: [signal('reviewRequested', 6.2, 'ines-carvalho'), signal('checksFailed', 5.9)] }),
      pr(6263, 'storefront-web', 'Refund delivery on a fully returned order', 'kofi-mensah', 4.4, 'running', { signals: [signal('reviewRequested', 40, 'kofi-mensah'), signal('reReview', 4.4, 'kofi-mensah')] }),
      pr(6266, 'storefront-web', 'Remove the old store credit page', 'wren-adeyemi', 2.1, 'passing'),

      // To answer.
      {
        id: 'mail-1', kind: 'gmail/thread', concern: 'addressed', title: 'Decision needed: freeze dates for the spring sale', since: hoursAgo(50),
        fields: { from: 'tessa-lindqvist', messages: 5, label: 'Spring sale', deadline: 'Thursday' },
        signals: [signal('asked', 50, 'tessa-lindqvist'), signal('replied', 22, 'omar-haddad')], task: null, project: 'Spring sale',
      },
      {
        id: 'sl-1', kind: 'slack/thread', concern: 'mentioned', title: 'Can someone check the coupon banner on the tablet layout?', since: hoursAgo(3.3),
        fields: { from: 'wren-adeyemi', channel: '#checkout', replies: 4 },
        signals: [signal('mentioned', 3.3, 'wren-adeyemi')], task: null, project: null,
      },
      pr(6126, 'storefront-web', 'Move the order schema to the shared package', 'tessa-lindqvist', 30, 'passing', { concern: 'mentioned', signals: [signal('mentioned', 30, 'tessa-lindqvist')] }),
      pr(6088, 'storefront-web', 'Agree a naming rule for feature flags', 'omar-haddad', 20, 'passing', { concern: 'mentioned', signals: [signal('mentioned', 20, 'omar-haddad')] }),

      // To finish: your own, where the next move is yours.
      mine(6118, 'storefront-web', 'Move multi-buy rules into the price engine', 19.6, 'failing', [signal('checksFailed', 20)]),
      mine(3299, 'platform-core', 'Drop debug logging from the gateway', 12.4, 'failing', [signal('checksFailed', 40)]),
      mine(3318, 'platform-core', 'Run the invoice export on the new job runner', 6.1, 'failing', [signal('checksFailed', 16)]),
      mine(6195, 'storefront-web', 'Shorten the address form', 5.2, 'changes', [signal('changesRequested', 28, 'omar-haddad')]),
      mine(6189, 'storefront-web', 'Label the quantity buttons for screen readers', 5.7, 'approved', [signal('approved', 18, 'ines-carvalho'), signal('readyToMerge', 18)]),
      {
        id: 'se-1', kind: 'sentry/issue', concern: 'assigned', title: 'Payment webhook times out at peak', since: hoursAgo(14),
        fields: { key: 'CHECKOUT-API-4B2', project: 'checkout-api', state: 'unresolved', events: 86, users: 41 },
        signals: [signal('assigned', 14), signal('spiked', 1.6)], task: null, project: 'checkout-api',
      },

      // Yours, with someone else: they settle at the foot of the stack, because the next move is not yours.
      parked(6147, 'storefront-web', 'Price engine: handle weighed items', 13.2),
      parked(6171, 'storefront-web', 'Show the price breakdown in the basket', 8.4),
      parked(6135, 'storefront-web', 'Lazy-load photos below the fold', 15.3),
      parked(6162, 'storefront-web', 'Preload the checkout font', 9.8),
      parked(3331, 'platform-core', 'Freeze time in the order expiry tests', 2.3),
      parked(1487, 'insights-jobs', 'Nightly basket size rollup', 1.4),
      parked(3337, 'platform-core', 'Quarantine the flaky order expiry test', 8.1),
      parked(3338, 'platform-core', 'Quarantine the flaky slot booking test', 8),
      parked(3339, 'platform-core', 'Quarantine the flaky coupon refusal test', 6.3),
      parked(3340, 'platform-core', 'Quarantine the flaky address lookup test', 6.2),
      parked(3341, 'platform-core', 'Quarantine the flaky refund webhook test', 6.1),
      parked(3342, 'platform-core', 'Quarantine the flaky search paging test', 1.2),
      parked(3326, 'platform-core', 'Add a runbook for queue backlog alerts', 10.2),
      Object.assign(pr(6199, 'storefront-web', 'Tidy the delivery cut-off copy', 'theo-brandt', 70, 'passing'), { settled: true, task: { by: 'Agent review' } }),
      Object.assign(pr(6201, 'storefront-web', 'Add the photo carousel', 'wren-adeyemi', 90, 'merged', { signals: [signal('merged', 40, 'omar-haddad')] }), { settled: true, quiet: true }),

      // On the shelf: slow things, by project.
      issue('OPS-41', 'Scan a returned crate at the depot door', 'Depot', 'Returns', 'triage', 400),
      issue('OPS-44', 'Print a return label without a print queue', 'Depot', 'Returns', 'triage', 390),
      issue('OPS-47', 'Start the refund when the depot confirms', 'Depot', 'Returns', 'triage', 320, { milestone: 'Spring sale', priority: 2 }),
      issue('OPS-58', 'Add depot opening hours to the returns page', 'Depot', 'Returns', 'triage', 140),
      issue('SHOP-318', 'Basket drawer traps focus in one browser', 'Shop', 'Shop', 'started', 500, { priority: 2 }),
      issue('SHOP-342', 'Typo tolerance for short search words', 'Shop', 'Shop', 'todo', 460),
      issue('SHOP-355', 'Order history hides cancelled items', 'Shop', 'Shop', 'triage', 300),
      issue('SHOP-360', 'Slot picker jumps when a slot sells out', 'Shop', 'Shop', 'triage', 260, { priority: 3 }),
      issue('SHOP-364', 'Coupon box accepts spaces and then fails', 'Shop', 'Shop', 'triage', 200),
      issue('PLAT-118', 'Agree a retry rule for browser tests', 'Platform', 'Platform', 'triage', 180, { priority: 2 }),
      {
        id: 'qs-1', kind: 'quayside/purchase-order', concern: 'signOff', title: 'Chilled crates for the Rotterdam depot', since: hoursAgo(70),
        fields: { key: 'PO-2291', supplier: 'Oakline Foods', state: 'waiting', amount: '€4,120', due: 'Friday', site: 'Depots' },
        signals: [signal('signOff', 70)], task: null, project: 'Depots',
      },
      {
        id: 'qs-2', kind: 'quayside/purchase-order', concern: 'signOff', title: 'Spare scanners for returns', since: hoursAgo(30),
        fields: { key: 'PO-2304', supplier: 'Marlow Supply', state: 'waiting', amount: '€860', due: 'Next week', site: 'Depots' },
        signals: [signal('signOff', 30), signal('delayed', 6, null, 'Monday')], task: null, project: 'Depots',
      },
    ];
  }

  var S = { name: 'Sentry', mark: 'sentry', hue: null }, L = { name: 'Linear', mark: 'linear', hue: null }, G = { name: 'GitHub', mark: 'github', hue: null };
  var CLUSTERS = [
    { id: 'c-coupons', kind: 'hercule/cluster', title: 'Coupons refused since the last release', why: 'Came back on Monday, after being marked fixed', sources: ['sentry'], figures: '212 events · 19 shoppers', detail: 'Marked fixed two weeks ago, and started again on Monday in the step that applies a coupon to a basket.', parts: [{ plugin: S, title: 'CouponRuleError: rule set missing for market', fact: '212 events' }], since: hoursAgo(44), signals: [], fields: {}, concern: 'noticed' },
    { id: 'c-search', kind: 'hercule/cluster', title: 'Search feed drops unbranded products', why: 'The loudest error in the shop right now', sources: ['sentry', 'linear'], figures: '1,480 events · 73 shoppers', detail: 'It came back when the brand field became required, and every feed run hits it. SHOP-361 reports the same thing from the shop floor.', parts: [{ plugin: S, title: 'FeedRecordError: no brand to fill a required column', fact: '1,480 events' }, { plugin: L, title: 'SHOP-361 Brand filter is empty for own-label goods', fact: 'Triage' }], since: hoursAgo(26), signals: [], fields: {}, concern: 'noticed' },
    { id: 'c-photos', kind: 'hercule/cluster', title: 'Photo carousel crashes on old tablets', why: 'Seven errors with one cause', sources: ['sentry', 'github'], figures: '96 events · 1 shopper', detail: 'The carousel assumes a browser feature that old tablets lack. Pull request #6201 added the call.', parts: [{ plugin: S, title: 'TypeError: slideWatcher.observe is not a function', fact: '38 events' }, { plugin: S, title: 'TypeError: carousel.next is not a function', fact: '21 events' }, { plugin: S, title: '5 more with the same cause', fact: '37 events' }, { plugin: G, title: '#6201 Add the photo carousel', fact: 'Merged' }], since: hoursAgo(20), signals: [], fields: {}, concern: 'noticed' },
  ];

  /** Returns a person's key, to spread the invented volume over everyone. */
  var names = ['juno-park', 'felix-marsh', 'omar-haddad', 'ines-carvalho', 'theo-brandt', 'wren-adeyemi', 'kofi-mensah', 'tessa-lindqvist'];
  var verbs = ['Tidy', 'Split', 'Cache', 'Retry', 'Rename', 'Harden', 'Trim', 'Speed up', 'Document', 'Remove', 'Log', 'Guard'];
  var things = ['the basket drawer', 'delivery slot lookups', 'the coupon banner', 'the address finder', 'order emails', 'the returns label', 'the search feed', 'photo decoding', 'the price engine', 'loyalty points', 'the refund webhook', 'depot opening hours', 'the checkout font', 'stock counts', 'the invoice export'];

  /** Returns about 300 invented entities, for the heavy morning: a week away from the desk. */
  function buildVolume() {
    var list = buildEntities();
    var n = 7000;
    for (var i = 0; i < 118; i++) {
      var who = names[i % names.length];
      list.push(pr(n + i, i % 3 ? 'storefront-web' : 'platform-core', verbs[i % verbs.length] + ' ' + things[(i * 7) % things.length], who, 3 + i * 1.3, i % 9 === 0 ? 'failing' : 'passing', i % 9 === 0 ? { signals: [signal('reviewRequested', 3 + i * 1.3, who), signal('checksFailed', 2 + i)] } : undefined));
    }
    for (var d = 0; d < 26; d++) {
      var bump = pr(8000 + d, 'storefront-web', 'Bump ' + ['eslint', 'vite', 'react', 'effect', 'zod-free-schema', 'typescript', 'vitest'][d % 7] + ' to the next minor', 'theo-brandt', 40 + d, 'passing');
      bump.stream = 'Dependency updates';
      list.push(bump);
    }
    var teams = [['Depot', 'Returns'], ['Shop', 'Shop'], ['Platform', 'Platform'], ['Shop', 'Search'], ['Depot', 'Depots'], ['Platform', 'Observability']];
    for (var t = 0; t < 120; t++) {
      var g = teams[t % teams.length];
      list.push(issue(g[0].slice(0, 4).toUpperCase() + '-' + (900 + t), verbs[(t * 5) % verbs.length] + ' ' + things[(t * 3) % things.length], g[0], g[1], ['triage', 'todo', 'backlog', 'started'][t % 4], 200 + t * 7));
    }
    return list;
  }

  window.World = { NOW: NOW, hoursAgo: hoursAgo, PEOPLE: PEOPLE, signal: signal, buildEntities: buildEntities, buildVolume: buildVolume, CLUSTERS: CLUSTERS };
})();
