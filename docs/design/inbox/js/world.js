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
  var relations = [];   // the claims of this world, rebuilt with its entities
  var contexts = [];    // the things that give context, rebuilt with them

  /** Records that a plugin reports one thing as part of another. A thing can have many parents, and a team is one path among them. */
  function partOf(from) {
    [].slice.call(arguments, 1).forEach(function (to) { if (to) relations.push({ from: from, rel: 'part-of', to: to, claim: { type: 'source' } }); });
  }
  /** Records a link between two peers, and who claims it. */
  function link(from, to, claim) { relations.push({ from: from, rel: 'linked', to: to, claim: claim }); }

  function signal(key, h, who, value, note) { return { id: 's' + ++uid, key: key, at: hoursAgo(h), who: who || null, value: value || null, note: note || null, open: true }; }

  function pr(number, repo, title, author, h, state, extra) {
    extra = extra || {};
    var signals = extra.signals || [signal('reviewRequested', h, author)];
    partOf('pr-' + number, 'repo-' + repo);
    return {
      id: 'pr-' + number, kind: 'github/pull-request', concern: extra.concern === undefined ? 'reviewRequested' : extra.concern, title: title, since: hoursAgo(h),
      fields: { number: number, repo: repo, author: author, state: state, diff: extra.diff || [12 + (number * 7) % 180, (number * 3) % 64], files: extra.files || 1 + (number % 9) },
      signals: signals, task: extra.task || null,
    };
  }
  function mine(number, repo, title, days, state, signals, extra) {
    return pr(number, repo, title, 'you', days * 24, state, Object.assign({ concern: 'opened', signals: signals }, extra || {}));
  }
  function parked(number, repo, title, days) {
    return Object.assign(mine(number, repo, title, days, 'passing', [signal('waiting', days * 24)]), { settled: true, parked: 'with reviewers' });
  }
  /** Returns a ticket. `parents` are the ids of everything it is part of: its projects, its milestone, its team. */
  function issue(key, title, parents, state, h, extra) {
    extra = extra || {};
    partOf.apply(null, ['ln-' + key].concat(parents));
    return {
      id: 'ln-' + key, kind: 'linear/issue', concern: 'assigned', title: title, since: hoursAgo(h),
      fields: { key: key, state: state, assignee: 'you', priority: extra.priority || 0 },
      signals: extra.signals || [signal('assigned', h)], task: null,
    };
  }

  /** Returns a thing that gives context. Progress is here only when the source reports it: the page never works it out from what it can see. */
  function context(id, kind, title, extra) {
    extra = extra || {};
    return { id: id, kind: kind, concern: null, title: title, since: hoursAgo(extra.age || 2000), fields: { state: extra.state || null, target: extra.target || null }, progress: extra.progress || null, signals: extra.signals || [], task: null, about: extra.about || null };
  }

  /** Returns the things that give context, and records how they sit in each other. */
  function buildContexts() {
    var list = [
      context('repo-storefront-web', 'github/repository', 'storefront-web'),
      context('repo-platform-core', 'github/repository', 'platform-core'),
      context('repo-insights-jobs', 'github/repository', 'insights-jobs'),
      context('label-spring', 'gmail/label', 'Spring sale'),
      context('chan-checkout', 'slack/channel', '#checkout'),
      context('sproj-checkout-api', 'sentry/project', 'checkout-api'),
      context('team-depot', 'linear/team', 'Depot'),
      context('team-shop', 'linear/team', 'Shop'),
      context('team-platform', 'linear/team', 'Platform'),
      context('ini-returns', 'linear/initiative', 'Returns without a phone call', { state: 'onTrack' }),
      context('ini-spring', 'linear/initiative', 'Ready for the spring sale', { state: 'onTrack' }),
      context('ini-checkout', 'linear/initiative', 'A checkout that never drops a basket', { state: 'atRisk' }),
      context('prj-retries', 'linear/project', 'Payment retries', { state: 'atRisk', progress: { done: 4, total: 9 }, target: '14 Nov', about: 'One retry on a gateway timeout, and a clear message when it fails too.', signals: [signal('update', 90, 'tessa-lindqvist', null, 'The gateway team cannot give us a timeout figure until Friday.'), signal('health', 26, 'tessa-lindqvist', 'at risk')] }),
      context('prj-depot', 'linear/project', 'Returns at the depot', { state: 'onTrack', progress: { done: 8, total: 13 }, target: '28 Nov', about: 'A returned crate is scanned at the door, and the refund starts when the depot confirms it.', signals: [signal('update', 120, 'omar-haddad', null, 'Scanners are on the Rotterdam dock. Refunds next.'), signal('target', 44, null, '28 Nov')] }),
      context('prj-slots', 'linear/project', 'Delivery slots', { state: 'onTrack', progress: { done: 3, total: 6 }, target: '5 Dec', about: 'Slots that hold while you check out.', signals: [signal('update', 70, 'juno-park')] }),
      context('prj-polish', 'linear/project', 'Basket and search polish', { state: 'onTrack', progress: { done: 11, total: 18 }, about: 'Small things people keep telling us about.' }),
      context('prj-browsers', 'linear/project', 'Browser test reliability', { about: 'No more re-runs before a release.' }),
      context('ms-door', 'linear/milestone', 'Door scanning', { target: '14 Nov', progress: { done: 5, total: 7 } }),
      context('ms-refund', 'linear/milestone', 'Refund on receipt', { target: '28 Nov', progress: { done: 3, total: 6 } }),
      context('ms-timeouts', 'linear/milestone', 'Gateway timeouts', { target: '7 Nov', progress: { done: 2, total: 4 } }),
      context('round-rotterdam', 'quayside/round', 'Rotterdam winter stock', { state: 'open', progress: { done: 3, total: 5 }, target: '21 Nov', signals: [signal('update', 8)] }),
      context('site-rotterdam', 'quayside/site', 'Rotterdam depot'),
    ];
    partOf('prj-depot', 'ini-returns', 'ini-spring', 'team-depot');
    partOf('prj-retries', 'ini-checkout', 'team-shop');
    partOf('prj-slots', 'ini-spring', 'team-shop', 'team-depot');
    partOf('prj-polish', 'ini-checkout', 'team-shop');
    partOf('prj-browsers', 'team-platform');
    partOf('ms-door', 'prj-depot');
    partOf('ms-refund', 'prj-depot');
    partOf('ms-timeouts', 'prj-retries');
    partOf('round-rotterdam', 'site-rotterdam');
    return list;
  }

  /** Records the links of the morning: some reported by a source, some made by a person, and references found in text, which stay hints. */
  function buildLinks() {
    link('ln-SHOP-371', 'pr-6238', { type: 'source', by: 'Linear', at: hoursAgo(60) });
    link('ln-SHOP-371', 'se-1', { type: 'person', by: 'you', at: hoursAgo(13) });
    link('ln-SHOP-380', 'pr-6118', { type: 'source', by: 'Linear', at: hoursAgo(470) });
    link('ln-SHOP-380', 'restricted-1', { type: 'source', by: 'Linear', at: hoursAgo(200) });
    link('pr-6263', 'ln-OPS-47', { type: 'text', by: 'GitHub', evidence: 'the description of #6263', at: hoursAgo(40) });
    link('pr-6126', 'ln-SHOP-318', { type: 'text', by: 'GitHub', evidence: 'a comment on #6126', at: hoursAgo(28) });
    link('ln-PLAT-131', 'pr-3299', { type: 'source', by: 'Linear', at: hoursAgo(300) });
    link('ln-PLAT-127', 'pr-3318', { type: 'source', by: 'Linear', at: hoursAgo(150) });
    link('ln-SHOP-349', 'pr-6195', { type: 'source', by: 'Linear', at: hoursAgo(125) });
    link('ln-SHOP-351', 'pr-6189', { type: 'source', by: 'Linear', at: hoursAgo(137) });
    link('ln-OPS-41', 'pr-6271', { type: 'source', by: 'Linear', at: hoursAgo(30) });
    link('ln-OPS-41', 'qs-2', { type: 'person', by: 'omar-haddad', at: hoursAgo(26) });
  }


  function buildEntities() {
    uid = 0;
    relations = [];
    contexts = buildContexts();
    var list = buildList();
    partOf('mail-1', 'label-spring');
    partOf('sl-1', 'chan-checkout');
    partOf('se-1', 'sproj-checkout-api');
    partOf('se-2', 'sproj-checkout-api');
    partOf('qs-1', 'round-rotterdam');
    partOf('qs-2', 'round-rotterdam');
    list.push(pr(6271, 'storefront-web', 'Read the door scanner over the local network', 'theo-brandt', 30, 'running', { concern: null, signals: [signal('checksPassed', 30)] }));
    buildLinks();
    // What arrived since the last look carries a small mark, so a night's news can be found without anything moving.
    list.forEach(function (e) { if (e.id === 'mail-1' || e.id === 'pr-6255') e.fresh = true; });
    return list;
  }

  function buildList() {
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
        signals: [signal('asked', 50, 'tessa-lindqvist'), signal('replied', 22, 'omar-haddad')], task: null,
      },
      {
        id: 'sl-1', kind: 'slack/thread', concern: 'mentioned', title: 'Can someone check the coupon banner on the tablet layout?', since: hoursAgo(3.3),
        fields: { from: 'wren-adeyemi', channel: '#checkout', replies: 4 },
        signals: [signal('mentioned', 3.3, 'wren-adeyemi')], task: null,
      },
      pr(6126, 'storefront-web', 'Move the order schema to the shared package', 'tessa-lindqvist', 30, 'passing', { concern: 'mentioned', signals: [signal('mentioned', 30, 'tessa-lindqvist')] }),

      // To finish: your own, where the next move is yours.
      mine(6118, 'storefront-web', 'Move multi-buy rules into the price engine', 19.6, 'failing', [signal('checksFailed', 20)]),
      mine(3299, 'platform-core', 'Drop debug logging from the gateway', 12.4, 'failing', [signal('checksFailed', 40)]),
      mine(3318, 'platform-core', 'Run the invoice export on the new job runner', 6.1, 'failing', [signal('checksFailed', 16)]),
      mine(6195, 'storefront-web', 'Shorten the address form', 5.2, 'changes', [signal('changesRequested', 28, 'omar-haddad')]),
      mine(6189, 'storefront-web', 'Label the quantity buttons for screen readers', 5.7, 'approved', [signal('approved', 18, 'ines-carvalho'), signal('readyToMerge', 18)]),
      {
        id: 'se-1', kind: 'sentry/issue', concern: 'assigned', title: 'Payment webhook times out at peak', since: hoursAgo(14),
        fields: { key: 'CHECKOUT-API-4B2', state: 'unresolved', events: 86, users: 41, assignee: 'you' },
        signals: [signal('assigned', 14), signal('spiked', 1.6)], task: null,
      },

      {
        id: 'se-2', kind: 'sentry/issue', concern: 'assigned', title: 'Tax band lookup fails for a new market', since: hoursAgo(40),
        fields: { key: 'CHECKOUT-API-4D1', state: 'regressed', events: 212, users: 19, assignee: 'you' },
        signals: [signal('assigned', 40), signal('cameBack', 9)], task: null,
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
      issue('OPS-41', 'Scan a returned crate at the depot door', ['prj-depot', 'ms-door', 'team-depot'], 'started', 400, { priority: 2, signals: [signal('assigned', 400), signal('moved', 30, null, 'In Progress'), signal('commented', 4, 'theo-brandt', null, 'The door reader arrives Thursday.')] }),
      issue('OPS-44', 'Print a return label without a print queue', ['prj-depot', 'ms-door', 'team-depot'], 'todo', 390, { signals: [signal('assigned', 390), signal('commented', 50, 'omar-haddad')] }),
      issue('OPS-47', 'Start the refund when the depot confirms', ['prj-depot', 'ms-refund', 'team-depot'], 'review', 320, { priority: 2, signals: [signal('assigned', 320), signal('moved', 40, null, 'In Review')] }),
      issue('OPS-58', 'Add depot opening hours to the returns page', ['prj-depot', 'ms-refund', 'team-depot'], 'triage', 140),
      issue('SHOP-371', 'Retry a payment once on a gateway timeout', ['prj-retries', 'ms-timeouts', 'team-shop'], 'review', 150, { priority: 3, signals: [signal('assigned', 150), signal('moved', 60, null, 'In Review'), signal('commented', 26, 'tessa-lindqvist', null, 'Thirty seconds, says the gateway team.')] }),
      issue('SHOP-380', 'Keep multi-buy rules in one place', ['prj-polish', 'team-shop'], 'review', 480, { priority: 1, signals: [signal('assigned', 480), signal('moved', 470, null, 'In Review')] }),
      issue('SHOP-318', 'Basket drawer traps focus in one browser', ['prj-polish', 'team-shop'], 'started', 500, { priority: 2, signals: [signal('assigned', 500), signal('commented', 70, 'felix-marsh')] }),
      issue('SHOP-342', 'Typo tolerance for short search words', ['prj-polish', 'team-shop'], 'todo', 460),
      issue('SHOP-355', 'Order history hides cancelled items', ['prj-polish', 'team-shop'], 'triage', 300, { signals: [signal('assigned', 300), signal('commented', 90, 'wren-adeyemi')] }),
      issue('SHOP-360', 'Slot picker jumps when a slot sells out', ['prj-polish', 'prj-slots', 'team-shop'], 'todo', 260, { priority: 3, signals: [signal('assigned', 260), signal('mentioned', 20, 'juno-park')] }),
      issue('SHOP-364', 'Coupon box accepts spaces and then fails', ['prj-polish', 'team-shop'], 'triage', 200),
      issue('PLAT-118', 'Agree a retry rule for browser tests', ['prj-browsers', 'team-platform'], 'triage', 180, { priority: 2, signals: [signal('assigned', 180), signal('commented', 100, 'kofi-mensah')] }),
      issue('PLAT-131', 'Keep card numbers out of the gateway debug log', ['prj-retries', 'ms-timeouts', 'team-platform'], 'review', 300, { priority: 3, signals: [signal('assigned', 300), signal('moved', 296, null, 'In Review')] }),
      issue('PLAT-127', 'Run the invoice export on the job runner', ['prj-browsers', 'team-platform'], 'review', 160, { signals: [signal('assigned', 160), signal('moved', 150, null, 'In Review')] }),
      issue('SHOP-349', 'A shorter address form on small screens', ['prj-polish', 'team-shop'], 'review', 130, { signals: [signal('assigned', 130), signal('moved', 126, null, 'In Review')] }),
      issue('SHOP-351', 'Label the basket for screen readers', ['prj-polish', 'team-shop'], 'review', 140, { priority: 1, signals: [signal('assigned', 140), signal('moved', 138, null, 'In Review')] }),
      {
        id: 'qs-1', kind: 'quayside/purchase-order', concern: 'signOff', title: 'Chilled crates for the Rotterdam depot', since: hoursAgo(70),
        fields: { key: 'PO-2291', supplier: 'Oakline Foods', state: 'waiting', amount: '€4,120', due: 'Friday', assignee: 'you' },
        signals: [signal('signOff', 70)], task: null,
      },
      {
        id: 'qs-2', kind: 'quayside/purchase-order', concern: 'signOff', title: 'Spare scanners for returns', since: hoursAgo(30),
        fields: { key: 'PO-2304', supplier: 'Marlow Supply', state: 'waiting', amount: '€860', due: 'next week', assignee: 'you' },
        signals: [signal('signOff', 30), signal('delayed', 6, null, 'Monday')], task: null,
      },
    ];
  }

  var S = { name: 'Sentry', mark: 'sentry', hue: null }, L = { name: 'Linear', mark: 'linear', hue: null }, G = { name: 'GitHub', mark: 'github', hue: null };
  var CLUSTERS = [
    { id: 'c-coupons', kind: 'hercule/cluster', title: 'Coupons refused since the last release', why: 'Came back on Monday, after being marked fixed', sources: ['sentry'], figures: '212 events · 19 shoppers', detail: 'Marked fixed two weeks ago, and started again on Monday in the step that applies a coupon to a basket.', parts: [{ plugin: S, title: 'CouponRuleError: rule set missing for market', fact: 'Came back' }], since: hoursAgo(44), signals: [], fields: {}, concern: 'noticed' },
    { id: 'c-search', kind: 'hercule/cluster', title: 'Search feed drops unbranded products', why: 'The loudest error in the shop right now', sources: ['sentry', 'linear'], figures: '1,480 events · 73 shoppers', detail: 'It came back when the brand field became required, and every feed run hits it. SHOP-361 reports the same thing from the shop floor.', parts: [{ plugin: S, title: 'FeedRecordError: no brand to fill a required column', fact: 'Came back' }, { plugin: L, title: 'SHOP-361 Brand filter is empty for own-label goods', fact: 'Triage' }], since: hoursAgo(26), signals: [], fields: {}, concern: 'noticed' },
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
      list.push(pr(n + i, i % 3 ? 'storefront-web' : 'platform-core', verbs[i % verbs.length] + ' ' + things[(i * 7) % things.length], who, 3 + (117 - i) * (117 - i) * 0.035, i % 9 === 0 ? 'failing' : 'passing', i % 9 === 0 ? { signals: [signal('reviewRequested', 3 + (117 - i) * (117 - i) * 0.035, who), signal('checksFailed', 2 + i)] } : undefined));
    }
    for (var d = 0; d < 26; d++) {
      var bump = pr(8000 + d, 'storefront-web', 'Bump ' + ['eslint', 'vite', 'react', 'effect', 'zod-free-schema', 'typescript', 'vitest'][d % 7] + ' to the next minor', 'theo-brandt', 40 + d, 'passing');
      bump.stream = 'Dependency updates';
      list.push(bump);
    }
    var teams = [['Depot', 'prj-depot'], ['Shop', 'prj-polish'], ['Platform', 'prj-browsers'], ['Shop', 'prj-retries'], ['Depot', 'prj-slots'], ['Shop', 'prj-slots']];
    for (var t = 0; t < 120; t++) {
      var g = teams[t % teams.length];
      list.push(issue(g[0].slice(0, 4).toUpperCase() + '-' + (900 + t), verbs[(t * 5) % verbs.length] + ' ' + things[(t * 3) % things.length], [g[1], 'team-' + g[0].toLowerCase()], ['triage', 'todo', 'backlog', 'started'][t % 4], 200 + t * 7));
    }
    return list;
  }

  window.World = { NOW: NOW, hoursAgo: hoursAgo, PEOPLE: PEOPLE, signal: signal, buildEntities: buildEntities, buildVolume: buildVolume, CLUSTERS: CLUSTERS, readContexts: function () { return contexts; }, readRelations: function () { return relations; } };
})();
