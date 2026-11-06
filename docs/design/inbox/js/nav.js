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
    return '<a class="nav-row' + (r.id === 'inbox' ? ' is-on' : '') + '" href="#" data-nav="' + r.id + '"' + (r.id === 'inbox' ? ' aria-current="page"' : '') + '>' + Crew.icon(r.icon, 16) + '<span>' + r.label + '</span>' + (r.id === 'inbox' ? '<i class="nav-new" hidden></i><b class="count" data-nav-count="inbox"></b>' : '') + '</a>';
  }
  function draw() {
    document.getElementById('side').innerHTML =
      '<div class="side-top"><button class="icon-btn" title="Hide the sidebar">' + Crew.icon('sidebar', 16) + '</button></div>' +
      '<div class="seg seg--side"><button>Threads</button><button aria-pressed="true">Hercule</button></div>' +
      '<div class="side-actions"><button class="nav-row">' + Crew.icon('compose', 16) + '<span>New thread</span><kbd>⌘N</kbd></button><button class="icon-btn" title="Search" aria-label="Search">' + Crew.icon('search', 16) + '</button><button class="icon-btn" title="Home" aria-label="Home">' + Crew.icon('office', 16) + '</button></div>' +
      '<div class="side-scroll"><section class="side-sec"><h3 class="side-h"><span>Waiting on you</span><span class="count count--you">2</span></h3>' +
      '<div class="side-row">' + Crew.face('Cut over the invoice export', { pose: 'waiting', size: 24 }) + '<span class="side-text"><span class="side-name">Cut over the invoice export</span><span class="side-ask">Approve the cutover for Monday?</span></span></div>' +
      '<div class="side-row">' + Crew.face('Restore a basket after sign-in', { pose: 'waiting', size: 24 }) + '<span class="side-text"><span class="side-name">Restore a basket after sign-in</span><span class="side-ask">Highest quantity, or add them?</span></span></div></section>' +
      '<section class="side-sec"><h3 class="side-h"><span>Work</span></h3>' + rows.map(drawRow).join('') + '</section>' +
      '<section class="side-sec"><h3 class="side-h"><span>System</span></h3><a class="nav-row" href="#">' + Crew.icon('fleet', 16) + '<span>Fleet</span></a><a class="nav-row" href="#">' + Crew.icon('connections', 16) + '<span>Connections</span></a></section></div>' +
      '<div class="side-foot"><div class="side-sum"><b>3</b> working · <b class="you-ink">2</b> waiting · <b>2</b> idle</div><div class="side-me">' + Card.drawPerson('you', 24) + '<span class="side-name">Noa</span><button class="icon-btn icon-btn--sm" title="Settings">' + Crew.icon('sliders', 14) + '</button></div></div>';
  }
  function setCount(id, n) {
    var el = document.querySelector('[data-nav-count="' + id + '"]');
    if (!el) return;
    var was = el.textContent;
    el.textContent = n || '';
    el.hidden = !n;
    if (was && String(n) !== was) Motion.animate(el, [{ transform: 'translateY(' + (n > Number(was) ? 4 : -4) + 'px)', opacity: 0.3 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(.22,.9,.24,1)' });
  }
  /** Shows or hides the dot that says something new reached the Inbox since you were last there. */
  function setNew(isNew) {
    var dot = document.querySelector('.nav-new');
    if (dot) dot.hidden = !isNew;
  }
  return { draw: draw, setCount: setCount, setNew: setNew };
})();
