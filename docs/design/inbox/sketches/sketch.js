// Quick composition sketches. Throwaway: they exist to choose a direction, and are kept as the record of that choice.
(function () {
  var P = {
    juno: ['Juno Park', 198], felix: ['Felix Marsh', 345], omar: ['Omar Haddad', 52], ines: ['Ines Carvalho', 282],
    theo: ['Theo Brandt', 132], wren: ['Wren Adeyemi', 312], kofi: ['Kofi Mensah', 78], tessa: ['Tessa Lindqvist', 240], you: ['Rogier', 78],
  };
  function av(k, s) { var p = P[k]; var i = p[0].split(' ').map(function (w) { return w[0]; }).join(''); return '<span class="av" style="--avh:' + p[1] + ';width:' + (s || 20) + 'px;height:' + (s || 20) + 'px">' + i + '</span>'; }
  function br(n, s) { return Crew.brand(n, s || 18); }
  window.S = {
    av: av, br: br,
    noticed: [
      { t: 'Coupon codes refused after the last release', why: 'Came back on Monday, after being marked fixed', src: ['sentry'], n: '212 events · 19 shoppers' },
      { t: 'Search feed drops products with no brand', why: 'The loudest error in the shop', src: ['sentry', 'linear'], n: '1,480 events · 73 shoppers' },
      { t: 'Photo carousel crashes on old tablets', why: 'Seven errors, one cause', src: ['sentry'], n: '96 events · 1 shopper' },
    ],
    clock: [
      { k: 'pr', m: 'github', id: '#6204', g: 'storefront-web', t: 'Cache delivery slot lookups for five minutes', p: 'juno', r: 'Juno asked for your review', w: '5d', h: 131 },
      { k: 'pr', m: 'github', id: '#6209', g: 'storefront-web', t: 'Split the basket summary into smaller components', p: 'felix', r: 'Felix asked for your review', w: '5d', h: 129 },
      { k: 'pr', m: 'github', id: '#6213', g: 'storefront-web', t: 'Show unit prices on multi-buy offers', p: 'felix', r: 'Felix asked again, after changes', w: '4d', h: 119, c: 1 },
      { k: 'mail', m: 'gmail', id: 'Thursday', g: 'Mail', t: 'Decision needed: freeze dates for the spring sale', p: 'tessa', r: 'Tessa asks you to decide', w: '2d', h: 48 },
      { k: 'pr', m: 'github', id: '#6238', g: 'storefront-web', t: 'Retry card payments once on a gateway timeout', p: 'ines', r: 'Checks failed', bad: 1, w: '32h', h: 32 },
      { k: 'pr', m: 'github', id: '#6241', g: 'storefront-web', t: 'Drop the unused wishlist endpoints', p: 'theo', r: 'Theo asked for your review', w: '26h', h: 26 },
      { k: 'pr', m: 'github', id: '#6252', g: 'storefront-web', t: 'Move promo banner copy into the content tool', p: 'wren', r: 'Wren asked again', w: '10h', h: 10, c: 1 },
      { k: 'pr', m: 'github', id: '#6255', g: 'storefront-web', t: 'Add a loading state to the address finder', p: 'juno', r: 'Juno asked for your review', w: '9h', h: 9 },
      { k: 'pr', m: 'github', id: '#6257', g: 'storefront-web', t: 'Round loyalty points down at checkout', p: 'kofi', r: 'Checks failed', bad: 1, w: '8h', h: 8, c: 1 },
      { k: 'pr', m: 'github', id: '#6258', g: 'storefront-web', t: 'Stop sending duplicate order emails', p: 'tessa', r: 'Tessa asked for your review', w: '7h', h: 7 },
      { k: 'pr', m: 'github', id: '#6263', g: 'storefront-web', t: 'Refund delivery on a fully returned order', p: 'kofi', r: 'Kofi asked again', w: '4h', h: 4, c: 1 },
      { k: 'pr', m: 'github', id: '#6266', g: 'storefront-web', t: 'Remove the old store credit page', p: 'wren', r: 'Wren asked for your review', w: '2h', h: 2 },
    ],
    mine: [
      { k: 'pr', m: 'github', id: '#6118', g: 'storefront-web', t: 'Move multi-buy rules into the price engine', r: 'Your checks failed', bad: 1, w: '20d', h: 470 },
      { k: 'pr', m: 'github', id: '#3299', g: 'platform-core', t: 'Drop debug logging from the gateway', r: 'Your checks failed', bad: 1, w: '12d', h: 290 },
      { k: 'pr', m: 'github', id: '#6195', g: 'storefront-web', t: 'Shorten the address form', p: 'omar', r: 'Omar requested changes', w: '5d', h: 120 },
      { k: 'pr', m: 'github', id: '#6189', g: 'storefront-web', t: 'Label the quantity buttons for screen readers', r: 'Approved, ready to merge', good: 1, w: '6d', h: 140 },
    ],
    shelf: [
      { g: 'Returns', items: [
        { m: 'linear', id: 'OPS-41', t: 'Scan a returned crate at the depot door', team: 'Depot' },
        { m: 'linear', id: 'OPS-44', t: 'Print a return label without a print queue', team: 'Depot' },
        { m: 'linear', id: 'OPS-47', t: 'Start the refund when the depot confirms', team: 'Depot' },
        { m: 'linear', id: 'OPS-58', t: 'Add depot opening hours to the returns page', team: 'Depot' } ] },
      { g: 'Shop', items: [
        { m: 'linear', id: 'SHOP-318', t: 'Basket drawer traps focus in one browser', team: 'Shop' },
        { m: 'linear', id: 'SHOP-342', t: 'Typo tolerance for short search words', team: 'Shop' },
        { m: 'linear', id: 'SHOP-355', t: 'Order history hides cancelled items', team: 'Shop' },
        { m: 'linear', id: 'SHOP-360', t: 'Slot picker jumps when a slot sells out', team: 'Shop' },
        { m: 'linear', id: 'SHOP-361', t: 'Brand filter is empty for own-label goods', team: 'Shop' },
        { m: 'linear', id: 'SHOP-364', t: 'Coupon box accepts spaces and then fails', team: 'Shop' },
        { m: 'linear', id: 'SHOP-366', t: 'Decide the default photo for bundles', team: 'Shop' } ] },
      { g: 'Platform', items: [
        { m: 'linear', id: 'PLAT-118', t: 'Agree a retry rule for browser tests', team: 'Platform' },
        { m: 'linear', id: 'PLAT-124', t: 'Document the staging refresh steps', team: 'Platform' } ] },
    ],
  };
  var side =
    '<div class="side-top"><button class="icon-btn">' + Crew.icon('sidebar', 16) + '</button></div>' +
    '<div class="seg seg--side"><button>Threads</button><button aria-pressed="true">Hercule <b class="count count--you" style="margin-left:6px">6</b></button></div>' +
    '<div class="side-actions"><button class="nav-row">' + Crew.icon('compose', 15) + '<span>New thread</span><kbd>⌘N</kbd></button><button class="icon-btn">' + Crew.icon('search', 15) + '</button></div>' +
    '<section class="side-sec"><h3 class="side-h"><span>Work</span></h3>' +
    '<a class="nav-row">' + Crew.icon('office', 15) + '<span>Overview</span></a>' +
    '<a class="nav-row is-on">' + Crew.icon('intake', 15) + '<span>Inbox</span><b class="count count--you">8</b></a>' +
    '<a class="nav-row">' + Crew.icon('workflows', 15) + '<span>Workflows</span></a>' +
    '<a class="nav-row">' + Crew.icon('discussions', 15) + '<span>Discussions</span></a>' +
    '<a class="nav-row">' + Crew.icon('wiki', 15) + '<span>Wiki</span></a></section>' +
    '<section class="side-sec"><h3 class="side-h"><span>System</span></h3><a class="nav-row">' + Crew.icon('fleet', 15) + '<span>Fleet</span></a><a class="nav-row">' + Crew.icon('connections', 15) + '<span>Connections</span></a></section>' +
    '<div style="flex:1"></div><div class="side-foot"><div class="side-sum"><b>3</b> working · <b class="you-ink">2</b> waiting · <b>2</b> idle</div><div class="side-me">' + Crew.you(24) + '<span class="side-name">Rogier</span></div></div>';
  document.addEventListener('DOMContentLoaded', function () {
    var el = document.querySelector('.side'); if (el) el.innerHTML = side;
  });
})();
