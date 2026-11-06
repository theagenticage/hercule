// The real sidebar, Hercule face, with the Inbox where Intake was.
window.Nav = (function () {
  var rows = [
    { id: 'overview', label: 'Overview', icon: 'office' },
    { id: 'inbox', label: 'Inbox', icon: 'intake' },
    { id: 'workflows', label: 'Workflows', icon: 'workflows' },
    { id: 'discussions', label: 'Discussions', icon: 'discussions' },
    { id: 'wiki', label: 'Wiki', icon: 'wiki' },
  ];
  function drawRow(r) {
    return '<a class="nav-row' + (r.id === 'inbox' ? ' is-on' : '') + '" data-nav="' + r.id + '">' + Crew.icon(r.icon, 16) + '<span>' + r.label + '</span>' + (r.id === 'inbox' ? '<i class="nav-new" hidden></i><b class="count" data-nav-count="inbox"></b>' : '') + '</a>';
  }
  function draw() {
    document.getElementById('side').innerHTML =
      '<div class="side-top"><button class="icon-btn" title="Hide the sidebar">' + Crew.icon('sidebar', 16) + '</button></div>' +
      '<div class="seg seg--side"><button>Threads</button><button aria-pressed="true">Hercule <b class="count count--you" style="margin-left:6px">2</b></button></div>' +
      '<div class="side-actions"><button class="nav-row">' + Crew.icon('compose', 16) + '<span>New thread</span><kbd>⌘N</kbd></button><button class="icon-btn">' + Crew.icon('search', 16) + '</button></div>' +
      '<section class="side-sec side-sec--wait"><h3 class="side-h"><span>Waiting on you</span><b class="count count--you">2</b></h3>' +
      '<a class="side-row side-row--who">' + Crew.face('Fix 3-D Secure checkout', { pose: 'waiting', size: 24 }) + '<span class="side-text"><span class="side-name">Fix 3-D Secure checkout for E…</span><span class="side-ask">Run git push?</span></span></a>' +
      '<a class="side-row side-row--who">' + Crew.face('Migrate ops dashboards', { pose: 'waiting', size: 24 }) + '<span class="side-text"><span class="side-name">Migrate ops dashboards</span><span class="side-ask">Keep the old folder?</span></span></a></section>' +
      '<section class="side-sec"><h3 class="side-h"><span>Work</span></h3>' + rows.map(drawRow).join('') + '</section>' +
      '<section class="side-sec"><h3 class="side-h"><span>System</span></h3><a class="nav-row">' + Crew.icon('fleet', 16) + '<span>Fleet</span></a><a class="nav-row">' + Crew.icon('connections', 16) + '<span>Connections</span></a></section>' +
      '<div class="side-grow"></div><div class="side-foot"><div class="side-sum"><b>3</b> working · <b class="you-ink">2</b> waiting · <b>2</b> idle</div><div class="side-me">' + Card.drawPerson('you', 24) + '<span class="side-name">Dana Reyes</span><button class="icon-btn icon-btn--sm" title="Settings">' + Crew.icon('sliders', 14) + '</button></div></div>';
  }
  function setCount(id, n) {
    var el = document.querySelector('[data-nav-count="' + id + '"]');
    if (!el) return;
    var was = el.textContent;
    el.textContent = n || '';
    el.hidden = !n;
    if (was && String(n) !== was) Motion.animate(el, [{ transform: 'translateY(' + (n > Number(was) ? 4 : -4) + 'px)', opacity: 0.3 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(.22,.9,.24,1)' });
  }
  return { draw: draw, setCount: setCount };
})();
