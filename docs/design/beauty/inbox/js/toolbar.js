// The toolbar: Group by and Filter, the same plain controls Work has, with what is active shown as chips that can be removed.
window.Toolbar = (function () {
  var K = Kinds.KINDS;
  var host, menu, openName = null;

  /** Returns the name of the grouping in use. */
  function readGroupName() {
    var g = App.readGroupings().filter(function (x) { return x[0] === App.state.grouping; })[0];
    return g ? g[1] : 'Place';
  }

  /** Draws the two controls and a chip for each active filter. */
  function draw() {
    if (!host) return;
    var filters = App.state.filters;
    host.innerHTML = '<button class="tool" data-tool="group" aria-haspopup="menu" aria-expanded="' + (openName === 'group') + '"><span class="tool-key">Group by</span><b>' + Card.esc(readGroupName()) + '</b></button>' +
      '<button class="tool" data-tool="filter" aria-haspopup="menu" aria-expanded="' + (openName === 'filter') + '">' + Crew.icon('filter', 14) + '<b>Filter</b></button>' +
      filters.map(function (f, i) { return '<button class="chip" data-chip="' + i + '" title="Remove this filter"><b>' + Card.esc(f.label) + '</b>' + Crew.icon('close', 12) + '</button>'; }).join('');
  }

  /** Returns one row of a menu. */
  function drawPick(attr, label, on, note) {
    return '<button class="menu-row menu-pick' + (on ? ' is-on' : '') + '" role="menuitemradio" aria-checked="' + on + '" ' + attr + '><span>' + Card.esc(label) + '</span>' + (note ? '<small>' + note + '</small>' : '') + '</button>';
  }

  /** Returns whether a filter is on. */
  function isOn(facet, value) { return App.state.filters.some(function (f) { return f.facet === facet && f.value === value; }); }

  /** Draws the list of filters: whose it is, then every place something on the page is part of, by the name its kind gives that level. */
  function drawFilterMenu() {
    var byNoun = {}, nouns = [];
    App.readLying().forEach(function (e) {
      Relations.readAncestors(e).forEach(function (p) {
        var noun = K[p.kind].noun;
        if (!byNoun[noun]) { byNoun[noun] = {}; nouns.push(noun); }
        byNoun[noun][p.id] = p;
      });
    });
    // A level with one value narrows nothing, so it is left out.
    nouns = nouns.filter(function (noun) { return Object.keys(byNoun[noun]).length > 1; });
    return '<p class="menu-h">Whose</p>' + drawPick('data-filter="owner" data-value="mine" data-label="Mine"', 'Mine', isOn('owner', 'mine')) + drawPick('data-filter="owner" data-value="others" data-label="Other people\'s"', 'Other people\'s', isOn('owner', 'others')) +
      nouns.map(function (noun) {
        return '<p class="menu-h">' + Card.esc(noun) + '</p>' + Object.keys(byNoun[noun]).map(function (id) { var p = byNoun[noun][id]; return drawPick('data-filter="place" data-value="' + id + '" data-label="' + Card.esc(p.title) + '"', p.title, isOn('place', id)); }).join('');
      }).join('');
  }

  function drawGroupMenu() {
    return App.readGroupings().map(function (g) { return drawPick('data-group="' + g[0] + '"', g[1], App.state.grouping === g[0]); }).join('');
  }

  function open(name, anchor) {
    openName = name;
    menu.innerHTML = name === 'group' ? drawGroupMenu() : drawFilterMenu();
    menu.hidden = false;
    var r = anchor.getBoundingClientRect();
    menu.style.left = r.left + 'px';
    menu.style.top = r.bottom + 6 + 'px';
    draw();
    var first = menu.querySelector('.menu-row');
    if (first) first.focus({ preventScroll: true });
  }

  function close() {
    if (!openName) return;
    openName = null;
    menu.hidden = true;
    draw();
  }

  /** An open menu owns the keyboard: nothing reaches the page behind it. Returns whether it took the key. */
  function key(ev) {
    if (!openName) return false;
    var rows = [].slice.call(menu.querySelectorAll('.menu-row')), at = rows.indexOf(document.activeElement);
    if (ev.key === 'ArrowDown' || ev.key === 'j') rows[(at + 1) % rows.length].focus();
    else if (ev.key === 'ArrowUp' || ev.key === 'k') rows[(at - 1 + rows.length) % rows.length].focus();
    else if ((ev.key === 'Enter' || ev.key === ' ') && at >= 0) rows[at].click();
    return true;
  }

  function start() {
    host = document.getElementById('tools');
    menu = document.getElementById('toolmenu');
    document.addEventListener('click', function (ev) {
      var t = ev.target.closest('[data-tool]');
      if (t) { var name = t.dataset.tool; if (openName === name) close(); else open(name, t); return; }
      var chip = ev.target.closest('[data-chip]');
      if (chip) { App.state.filters.splice(Number(chip.dataset.chip), 1); draw(); App.layOut(); return; }
      var g = ev.target.closest('[data-group]');
      if (g) { App.state.grouping = g.dataset.group; close(); App.layOut(); return; }
      var f = ev.target.closest('[data-filter]');
      if (f) {
        var filters = App.state.filters, facet = f.dataset.filter, value = f.dataset.value;
        var had = filters.filter(function (x) { return x.facet === facet && x.value === value; })[0];
        App.state.filters = filters.filter(function (x) { return x.facet !== facet; });
        if (!had) App.state.filters.push({ facet: facet, value: value, label: f.dataset.label });
        close();
        App.layOut();
        return;
      }
      if (openName && !ev.target.closest('#toolmenu')) close();
    });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && openName) { ev.stopPropagation(); close(); } }, true);
  }

  return { start: start, draw: draw, close: close, key: key };
})();
