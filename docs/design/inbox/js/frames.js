// The small live frames of the story page. Each draws real cards with the real renderer, outside the window.
window.Frames = (function () {
  var K = Kinds.KINDS, W = World;

  /** Returns a card laid out on its own, for a frame outside the page. */
  function drawLooseCard(e) {
    var card = Card.createCard(e, { now: W.NOW });
    card.classList.add('card--loose');
    return card;
  }

  /** Returns the declared table of a kind as text, the way a plugin would write it. */
  function sayTable(id) {
    var k = K[id];
    var lines = [];
    var push = function (key, value) { lines.push('<span class="t-k">' + key + '</span> <span class="t-v">' + Card.esc(value) + '</span>'); };
    push('noun', k.noun);
    push('mark', k.plugin.mark + (k.plugin.hue == null ? '' : ', hue ' + k.plugin.hue));
    push('card', k.card);
    push('pace', k.pace + ', patience ' + k.patience + 'h');
    push('identifier', k.identifier);
    push('person', k.person || 'none');
    push('owner', k.owner || 'none');
    push('status', k.status ? Object.keys(k.status).length + ' states' : 'none');
    push('facts', k.facts.map(function (f) { return f.field + ' as ' + f.form; }).join(', ') || 'none');
    push('home', k.home ? K[k.home].noun : 'none');
    if (k.section) push('section', K[k.section].noun);
    return lines.join('<br>');
  }

  /** Draws one card of each kind, each beside the table that made it. */
  function drawKinds(host) {
    var all = W.buildEntities();
    Relations.load(all, W.readContexts(), W.readRelations());
    var pick = ['pr-6213', 'ln-OPS-41', 'se-2', 'qs-2'];
    host.innerHTML = '';
    pick.forEach(function (id) {
      var e = all.filter(function (x) { return x.id === id; })[0];
      var cell = document.createElement('div');
      cell.className = 'k-cell';
      cell.innerHTML = '<div class="k-card"></div><pre class="k-table">' + sayTable(e.kind) + '</pre>';
      cell.firstChild.appendChild(drawLooseCard(e));
      host.appendChild(cell);
    });
  }

  return { drawKinds: drawKinds, drawLooseCard: drawLooseCard };
})();
