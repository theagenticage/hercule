// The small live frames of the story page. Each draws real cards with the real renderer, outside the window.
window.Frames = (function () {
  var K = Kinds.KINDS, W = World;

  /** Returns a card element laid out as a whole card, for a frame outside a stack. */
  function drawLooseCard(e, usual) {
    var card = Card.createCard(e, { now: W.NOW, usual: usual || null });
    card.classList.add('is-whole', 'card--loose');
    card.dataset.level = 'full';
    return card;
  }

  /** Returns the declared table of a kind as text, the way a plugin would write it. */
  function sayTable(id) {
    var k = K[id];
    var lines = [];
    var push = function (key, value) { lines.push('<span class="t-k">' + key + '</span> <span class="t-v">' + Card.esc(value) + '</span>'); };
    push('noun', k.noun);
    push('mark', k.plugin.mark + (k.plugin.hue == null ? '' : ', hue ' + k.plugin.hue));
    push('stock', k.paper);
    push('density', k.density);
    push('pace', k.pace + ', patience ' + k.patience + 'h');
    push('identifier', k.identifier);
    push('context', k.context);
    push('person', k.person || 'none');
    push('status', k.status ? Object.keys(k.status).length + ' states' : 'none');
    push('facts', k.facts.map(function (f) { return f.field + ' as ' + f.form; }).join(', ') || 'none');
    push('group by', k.group || 'none');
    return lines.join('<br>');
  }

  /** Draws one card of each kind, each beside the table that made it. */
  function drawKinds(host) {
    var all = W.buildEntities();
    var pick = ['pr-6213', 'ln-SHOP-360', 'mail-1', 'qs-2', 'se-1', 'sl-1'];
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
