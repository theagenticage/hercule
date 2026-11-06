// The one generic card. It draws every kind from the fields kinds.js declares, and holds no branch on a kind's id.
(function () {
  var K = window.Kinds, W = window.World;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  /** Returns the SVG of a status shape in its tone, with the status word as its accessible name. */
  function drawShape(status, size) {
    size = size || 16;
    return '<span class="shape tone-' + status.tone + '" role="img" aria-label="' + esc(status.word) + '" title="' + esc(status.word) + '">' +
      '<svg viewBox="0 0 16 16" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + K.SHAPES[status.shape] + '</svg></span>';
  }

  /** Returns a plugin's mark, drawn in the hue the plugin declares. Hercule's own kind draws Hercule's head. */
  function drawMark(plugin, size) {
    size = size || 20;
    // A solid mark carries more weight than a line drawing, so it is drawn a little smaller to look the same size.
    if (plugin.solid) size = Math.round(size * 0.9);
    var style = plugin.hue == null ? '' : ' style="--mark-hue:' + plugin.hue + '"';
    var svg = plugin.mark === 'hercule' ? Crew.logo(size, { mono: true }) : Crew.brand(plugin.mark, size);
    return '<span class="mark' + (plugin.hue == null ? '' : ' mark--hue') + '"' + style + ' role="img" aria-label="' + esc(plugin.name) + '">' + svg + '</span>';
  }

  /** Returns a person's monogram. People are letters, never faces: faces are for colleagues. */
  function drawPerson(key, size) {
    var p = W.PEOPLE[key];
    if (!p) return '';
    size = size || 16;
    var letters = p.name.split(' ').map(function (w) { return w[0]; }).join('').slice(0, 2);
    var cls = key === 'you' ? 'person person--you' : 'person';
    return '<span class="' + cls + '" style="--person-hue:' + p.hue + ';--person-size:' + size + 'px" title="' + esc(p.name) + '" aria-hidden="true">' + letters + '</span>';
  }

  /** Fills a declared template such as "#{number}" from an entity's fields. */
  function fill(template, fields) {
    return String(template || '').replace(/\{(\w+)\}/g, function (_, k) { return fields[k] == null ? '' : fields[k]; });
  }

  /** Returns the sentence a signal puts on its card: the kind's phrase with the person's short name. */
  function sayReason(kind, s) {
    var phrase = kind.reasons[s.key] || { say: s.key, tone: 'plain' };
    var who = s.who && W.PEOPLE[s.who] ? W.PEOPLE[s.who].short : '';
    return { text: phrase.say.replace('{person}', who).replace('{value}', s.value || ''), tone: phrase.tone };
  }

  /** Returns how long something has waited, as a short figure such as 5d or 26h. */
  function sayWait(since, now) {
    var h = (now - since) / 36e5;
    if (h < 1) return Math.max(1, Math.round(h * 60)) + 'm';
    if (h < 24) return Math.round(h) + 'h';
    return Math.round(h / 24) + 'd';
  }

  /** Returns a wait in words, for a screen reader. */
  function sayWaitInWords(since, now) {
    var h = (now - since) / 36e5;
    var n = h < 48 ? Math.max(1, Math.round(h)) : Math.round(h / 24);
    return n + (h < 48 ? ' hour' : ' day') + (n === 1 ? '' : 's');
  }

  /** Returns the ramp step of a wait, measured against the patience the kind declares. */
  function rampWait(since, now, patience) {
    var ratio = (now - since) / 36e5 / patience;
    return ratio >= 3 ? 'overdue' : ratio >= 1 ? 'stale' : ratio >= 0.25 ? 'recent' : 'fresh';
  }

  var FORMS = {
    delta: function (v) { return '<span class="f-plus">+' + v[0] + '</span> <span class="f-minus">−' + v[1] + '</span>'; },
    count: function (v, f) { return v.toLocaleString('en-GB') + ' ' + f.unit + (v === 1 ? '' : 's'); },
    word: function (v) { return esc(v); },
    date: function (v) { return 'Due ' + esc(v); },
    money: function (v) { return esc(v); },
    bars: function (v) {
      return '<span class="f-bars" role="img" aria-label="Priority ' + v + ' of 3">' + [1, 2, 3].map(function (i) { return '<i class="' + (i <= v ? 'on' : '') + '"></i>'; }).join('') + '</span>';
    },
  };

  function drawFacts(kind, fields) {
    return kind.facts.filter(function (f) { return fields[f.field]; }).map(function (f) {
      return '<span class="fact">' + FORMS[f.form](fields[f.field], f) + '</span>';
    }).join('');
  }

  /** Returns the workflows that fit an entity, in the order its kind declares them. */
  function readWorkflows(e) {
    var kind = K.KINDS[e.kind];
    return (kind.workflows[e.concern] || []).slice();
  }

  /** Returns the sentence a card says: who or what brought it here, and how many signals sit behind it. */
  function describeLine(e) {
    var kind = K.KINDS[e.kind];
    if (e.task) return { text: e.task.by === 'you' ? 'You took it on' : e.task.by + ' has it', tone: 'plain', more: 0 };
    var latest = e.signals[e.signals.length - 1];
    if (!latest) return { text: '', tone: 'plain', more: 0 };
    // A lasting thing that has only been assigned has nothing to say yet, and saying so on every card is noise.
    if (kind.card === 'rich' && e.signals.length === 1 && latest.key === e.concern) return { text: '', tone: 'plain', more: 0 };
    var reason = sayReason(kind, latest);
    return { text: reason.text, tone: reason.tone, more: Math.max(0, e.signals.length - 1) };
  }

  /** Returns the moves of a card, by name. They take the place of its head line while the pointer is on the card. */
  function drawActs(e) {
    if (e.task) return '<button class="c-act c-act--go" tabindex="-1" data-act="go" title="See its Task on Work (G)">On Work ' + Crew.icon('arrow', 12) + '</button>';
    var flows = readWorkflows(e);
    var handName = flows.length === 1 ? flows[0].name : 'Hand to…';
    var hand = flows.length
      ? '<button class="c-act c-act--hand" tabindex="-1" data-act="hand" title="' + esc(flows.length === 1 ? 'Hand to ' + flows[0].name : 'Hand to an agent') + ' (H)">' +
        flows.slice(0, 2).map(function (w) { return Crew.face(w.name, { pose: 'idle', size: 18 }); }).join('') + '<span>' + esc(handName) + '</span></button>'
      : '';
    return hand + '<button class="c-act c-act--take" tabindex="-1" data-act="take" title="Take it on myself (T)">Take it</button>' +
      '<button class="c-act c-act--plain" tabindex="-1" data-act="dismiss" title="Dismiss (E)" aria-label="Dismiss">' + Crew.icon('close', 14) + '</button>';
  }

  /** Returns the sentence of a card with its news mark, and the count of what sits behind it. */
  function drawLine(e) {
    var line = describeLine(e);
    if (!line.text) return '';
    return '<div class="c-line tone-' + line.tone + '">' + (e.fresh ? '<i class="c-fresh" title="New since you last looked"><span class="sr">New</span></i>' : '') +
      '<span class="c-roll"><span class="c-said">' + esc(line.text) + '</span></span>' + (line.more ? '<span class="c-more">+' + line.more + '</span>' : '') + '</div>';
  }

  /** Returns the wait of a card that has one. */
  function drawWait(e, now) {
    var kind = K.KINDS[e.kind];
    if (kind.pace !== 'fast' || e.task) return '';
    return '<div class="c-pace" data-ramp="' + rampWait(e.since, now, kind.patience) + '"><span aria-hidden="true">' + sayWait(e.since, now) + '</span><span class="sr">Waiting ' + sayWaitInWords(e.since, now) + '</span></div>';
  }

  /** Returns the status of a thing as shape and word, or nothing when its state is the usual one. */
  function drawStatus(e, size) {
    var kind = K.KINDS[e.kind], status = kind.status && kind.status[e.fields.state];
    return status ? '<span class="c-status">' + drawShape(status, size || 15) + '<span>' + esc(status.word) + '</span></span>' : '';
  }

  /** Returns whether a thing belongs to the person rather than to a colleague. */
  function isMine(e) {
    var kind = K.KINDS[e.kind];
    return !!kind.owner && e.fields[kind.owner] === 'you';
  }

  /** Returns a compact card: everything a person needs to deal with a small thing fast, in four words and a name. */
  function drawCompactBody(e, ctx) {
    var kind = K.KINDS[e.kind], f = e.fields;
    var status = kind.status && kind.status[f.state];
    var where = (Relations.readHomes(e)[0] || {}).title;
    var id = fill(kind.identifier, f);
    return '<div class="c-mark">' + drawMark(kind.plugin, 16) + '</div>' +
      '<h3 class="c-title" title="' + esc(e.title) + '">' + (e.partial ? '<i class="sk sk--title"></i>' : esc(e.title)) + '</h3>' +
      drawWait(e, ctx.now) +
      '<div class="c-under">' + (status && !status.norm ? '<span class="c-shape">' + drawShape(status, 13) + '</span>' : '') + drawLine(e) + '</div>' +
      '<div class="c-where">' + esc(id) + (where && where !== id ? ' · ' + esc(where) : '') + (isMine(e) ? ' · yours' : '') + '</div>' +
      '<div class="c-acts">' + drawActs(e) + '</div>';
  }

  /** Returns a rich card: status first, then the title, then what it is part of and its facts. */
  function drawRichBody(e, ctx) {
    var kind = K.KINDS[e.kind], f = e.fields;
    var bars = kind.facts.filter(function (x) { return x.form === 'bars' && f[x.field]; }).map(function (x) { return FORMS.bars(f[x.field]); }).join('');
    var facts = kind.facts.filter(function (x) { return x.form !== 'bars' && f[x.field]; }).map(function (x) { return '<span class="fact">' + FORMS[x.form](f[x.field], x) + '</span>'; });
    // What the card is part of, below the place it is shown under, so the block's head is never repeated on every card.
    var section = kind.section && Relations.readParents(e).filter(function (p) { return p.kind === kind.section; }).map(function (p) { return esc(p.title) + (p.fields.target ? ', ' + esc(p.fields.target) : ''); });
    var under = (section || []).concat(facts);
    return '<div class="c-head"><span class="c-mark">' + drawMark(kind.plugin, 16) + '</span>' + drawStatus(e, 15) + bars + '<span class="c-id">' + esc(fill(kind.identifier, f)) + '</span>' + drawWait(e, ctx.now) + '</div>' +
      '<h3 class="c-title" title="' + esc(e.title) + '">' + (e.partial ? '<i class="sk sk--title"></i>' : esc(e.title)) + '</h3>' +
      drawLine(e) +
      (under.length ? '<div class="c-facts">' + under.join('<i>·</i>') + '</div>' : '') +
      '<div class="c-acts">' + drawActs(e) + '</div>';
  }

  /** Returns the HTML inside a card, in the shape its kind declares. `ctx` holds the world's clock. */
  function drawCardBody(e, ctx) { return K.KINDS[e.kind].card === 'compact' ? drawCompactBody(e, ctx) : drawRichBody(e, ctx); }

  /** Returns a thing that rides on a card, as one row of the sheet tucked under it. The row says what the part asks, if it asks anything. */
  function drawPart(part, ctx) {
    if (part.restricted) {
      return '<div class="part part--closed" title="' + esc(Relations.sayClaim(part.link.claim)) + '"><span class="p-mark">' + Crew.icon('lock', 13) + '</span><span class="p-title">Something you do not have access to</span></div>';
    }
    var e = part.e, kind = K.KINDS[e.kind], line = describeLine(e);
    var status = kind.status && kind.status[e.fields.state];
    // A part that asks something of the person says what it asks. The rest say how they stand.
    var asks = e.concern && !e.task;
    var first = asks ? e.signals.filter(function (s) { return s.key === e.concern; })[0] : null;
    var said = first ? sayReason(kind, first).text : (asks ? line.text : (e.task ? line.text : (status ? status.word : '')));
    var news = asks && first && line.text !== said ? line.text : '';
    return '<div class="part' + (asks ? ' is-asking' : '') + '" role="button" data-id="' + e.id + '" tabindex="-1" title="' + esc(Relations.sayClaim(part.link.claim)) + '">' +
      '<span class="p-mark">' + drawMark(kind.plugin, 14) + '</span>' +
      '<span class="p-title">' + esc(e.title) + '</span>' + drawWait(e, ctx.now) +
      '<span class="p-line">' + (e.fresh ? '<i class="c-fresh"><span class="sr">New</span></i>' : '') + (status && !status.norm ? drawShape(status, 12) : '') + '<span class="p-said">' + esc(said) + '</span>' + (news ? '<span class="p-news tone-' + line.tone + '">' + esc(news) + '</span>' : '') + '</span>' +
      (asks ? '<span class="c-acts">' + drawActs(e) + '</span>' : '') + '</div>';
  }

  /** Returns who holds the card now: a colleague behind the top edge with its paws on it, as on Work, or the person's own tab. */
  function drawHolder(e) {
    if (!e.task) return '';
    if (e.task.by === 'you') return '<span class="card-holder"><i class="card-tab"></i></span>';
    return '<span class="card-holder"><span class="card-head" data-pose="working">' + Crew.peek(e.task.by, { pose: 'working', size: 30, crop: 34 }) + '</span></span>' +
      '<span class="card-paws" data-pose="working" style="--hue:var(--hue-' + Crew.lookFor(e.task.by).hue + ')"><i></i><i></i></span>';
  }

  /** Returns the class list of a card for its kind and its state. */
  function cardClasses(e) {
    var kind = K.KINDS[e.kind];
    return ['card', 'card--' + kind.card, 'paper-' + kind.paper].join(' ');
  }

  /** Returns what a screen reader says for a card: the kind, the title, why it is here, and how long it has waited. */
  function sayCard(e) {
    var kind = K.KINDS[e.kind], line = describeLine(e);
    var status = kind.status && kind.status[e.fields.state];
    return [kind.noun, fill(kind.identifier, e.fields), e.title, line.text, status ? status.word : '', kind.pace === 'fast' && !e.task ? 'waiting ' + sayWaitInWords(e.since, W.NOW) : '', line.more ? line.more + ' earlier signals' : ''].filter(Boolean).join(', ');
  }

  /**
   * Redraws a card's words in place. The sheet and whatever stands behind it stay, so their own transitions can run,
   * and so a colleague who has already risen is not drawn again.
   */
  function redrawBody(el, e, ctx) {
    [].slice.call(el.children).forEach(function (c) {
      if (!c.matches('.card-stock, .card-holder, .card-paws')) c.remove();
    });
    el.insertAdjacentHTML('beforeend', drawCardBody(e, ctx));
    if (!e.task) [].forEach.call(el.querySelectorAll('.card-holder, .card-paws'), function (c) { c.remove(); });
    if (e.task || e.quiet) el.dataset.height = 'flat'; else delete el.dataset.height;
  }

  /** Returns a new card element for an entity. */
  function createCard(e, ctx) {
    var el = document.createElement('div');
    el.className = cardClasses(e);
    if (e.task || e.quiet) el.dataset.height = 'flat';
    el.dataset.id = e.id;
    el.tabIndex = -1;
    el.setAttribute('role', 'listitem');
    el.setAttribute('aria-label', sayCard(e));
    el.innerHTML = drawHolder(e) + '<i class="card-stock"></i>' + drawCardBody(e, ctx);
    return el;
  }

  /** Returns the plugin that owns a mark. */
  function readPlugin(mark) {
    var id = Object.keys(K.KINDS).filter(function (k) { return K.KINDS[k].plugin.mark === mark; })[0];
    return id ? K.KINDS[id].plugin : { name: mark, mark: mark, hue: null };
  }

  /** Returns the marks of what a noticed thing combines: the first in full, any second as a badge on its corner. */
  function drawSources(sources) {
    return '<span class="pl-mark">' + drawMark(readPlugin(sources[0]), 18) + '</span>' + (sources[1] ? '<span class="pl-badge">' + drawMark(readPlugin(sources[1]), 9) + '</span>' : '');
  }

  /** Returns the HTML of one thing Hercule noticed, as it lies on the card he hands you. */
  function drawPlaque(c) {
    var flows = readWorkflows(c);
    var why = c.task ? (c.task.by === 'you' ? 'You took it on' : c.task.by + ' has it') : c.why;
    return '<div class="plaque' + (c.task ? ' is-handed' : '') + '" role="listitem" data-id="' + c.id + '"  tabindex="-1" aria-label="' + esc(c.title) + '. ' + esc(why) + '">' +
      '<div class="pl-marks">' + drawSources(c.sources) + '</div>' +
      '<h3 class="pl-title">' + esc(c.title) + '</h3>' +
      '<div class="pl-why">' + esc(why) + '</div>' +
      '<div class="c-acts pl-acts">' + (c.task
        ? '<button class="c-act c-act--go" tabindex="-1" data-act="go" title="See its Task on Work (G)">On Work ' + Crew.icon('arrow', 12) + '</button>'
        : '<button class="c-act c-act--hand" tabindex="-1" data-act="hand" title="Hand to an agent (H)" aria-label="Hand to an agent">' + flows.slice(0, 2).map(function (w) { return Crew.face(w.name, { pose: 'idle', size: 18 }); }).join('') + '<span>Hand to…</span></button>' +
          '<button class="c-act c-act--take" tabindex="-1" data-act="take" title="Take it on myself (T)" aria-label="Take it on myself">Take it</button>' +
          '<button class="c-act c-act--plain" tabindex="-1" data-act="dismiss" title="Back to Intake (E)" aria-label="Back to Intake">' + Crew.icon('close', 14) + '</button>') + '</div>' +
      '</div>';
  }

  window.Card = {
    createCard: createCard, drawPart: drawPart, drawStatus: drawStatus, drawLine: drawLine, isMine: isMine, readPlugin: readPlugin, redrawBody: redrawBody, sayCard: sayCard, drawHolder: drawHolder, drawCardBody: drawCardBody, cardClasses: cardClasses, drawPlaque: drawPlaque, drawMark: drawMark, drawPerson: drawPerson, drawShape: drawShape,
    describeLine: describeLine, sayReason: sayReason, sayWait: sayWait, rampWait: rampWait, readWorkflows: readWorkflows, fill: fill, esc: esc, drawFacts: drawFacts,
  };
})();
