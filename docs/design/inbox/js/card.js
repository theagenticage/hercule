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
    // A plugin may arrive with a mark the page does not have yet, and a card must still draw.
    var svg = plugin.mark === 'hercule' ? Crew.logo(size, { mono: true }) : window.CREW_BRANDS[plugin.mark] ? Crew.brand(plugin.mark, size) : Crew.icon('link', size);
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
      return '<span class="fact">' + (FORMS[f.form] || FORMS.word)(fields[f.field], f) + '</span>';
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
    return hand + '<button class="c-act c-act--take" tabindex="-1" data-act="take" title="Take it (T)">Take it</button>' +
      '<button class="c-act c-act--plain" tabindex="-1" data-act="dismiss" title="Dismiss (E)" aria-label="Dismiss">' + Crew.icon('close', 14) + '</button>';
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

  /** Returns the short name of a thing, for a line that points at it. */
  function sayReference(e) {
    var kind = K.KINDS[e.kind];
    return kind.reference === 'title' ? e.title : fill(kind.identifier, e.fields);
  }

  /** Returns whether a thing belongs to the person rather than to a colleague. */
  function isMine(e) {
    var kind = K.KINDS[e.kind];
    return !!kind.owner && e.fields[kind.owner] === 'you';
  }

  /** Returns what a compact card says under its title: who, and only what is unusual, with where it belongs. */
  function drawUnder(e) {
    var kind = K.KINDS[e.kind], f = e.fields, line = describeLine(e);
    var status = kind.status && kind.status[f.state];
    var latest = e.signals[e.signals.length - 1];
    // The column's title already says these are requests, so the usual one needs only a name.
    var isUsual = !e.task && latest && latest.key === e.concern && latest.who;
    var said = isUsual ? W.PEOPLE[latest.who].short : line.text;
    var where = Relations.readHomes(e).map(function (p) { return p.title; }).join(', ');
    return '<div class="c-under">' + (e.fresh ? '<i class="c-fresh" title="New since you last looked"><span class="sr">New</span></i>' : '') +
      (status && !status.norm && !e.task ? '<span class="c-shape">' + drawShape(status, 13) + '</span>' : '') +
      '<span class="c-roll tone-' + (isUsual ? 'plain' : line.tone) + '"><span class="c-said">' + esc(said) + '</span></span>' +
      (where ? '<span class="c-where">' + esc(where) + (isMine(e) ? ' · yours' : '') + '</span>' : '') + '</div>';
  }

  /** Returns a compact card: a title and one line, built to be dealt with fast. */
  function drawCompactBody(e, ctx) {
    var kind = K.KINDS[e.kind];
    return '<div class="c-mark">' + drawMark(kind.plugin, 16) + '</div>' +
      '<h3 class="c-title" title="' + esc(e.title) + '">' + (e.partial ? '<i class="sk sk--title"></i>' : esc(e.title)) + '</h3>' +
      drawWait(e, ctx.now) + drawUnder(e) +
      '<div class="c-acts">' + drawActs(e) + '</div>';
  }

  /** Returns what a row says under its title: where it sits below the place it is shown under, its facts, and the latest thing that happened. */
  function drawContext(e, ctx) {
    var kind = K.KINDS[e.kind], f = e.fields, parts = [];
    var near = Relations.readParents(e).filter(function (p) { return p !== ctx.place && (p.kind === kind.home || p.kind === kind.section); });
    near.forEach(function (p) { parts.push(esc(p.title) + (p.fields.target ? ', ' + esc(p.fields.target) : '')); });
    kind.facts.filter(function (x) { return x.form !== 'bars' && f[x.field]; }).forEach(function (x) { parts.push((FORMS[x.form] || FORMS.word)(f[x.field], x)); });
    var line = describeLine(e);
    var latest = e.signals[e.signals.length - 1];
    var news = line.text ? '<span class="c-news tone-' + line.tone + '">' + esc(line.text) + (latest && !e.task ? ' <small>' + sayWait(latest.at, ctx.now) + '</small>' : '') + '</span>' : '';
    return '<div class="c-context">' + (e.fresh ? '<i class="c-fresh" title="New since you last looked"><span class="sr">New</span></i>' : '') + parts.map(function (p) { return '<span>' + p + '</span>'; }).join('') + news + '</div>';
  }

  /** Returns a row of lasting work: status in a fixed place at the left, because here status is the point, then the title and what happened. */
  function drawRichBody(e, ctx) {
    var kind = K.KINDS[e.kind], f = e.fields;
    var hasMark = ctx.place && ctx.place.kind && K.KINDS[ctx.place.kind].plugin === kind.plugin;
    return '<div class="c-rail">' + (hasMark ? '' : '<span class="c-mark">' + drawMark(kind.plugin, 15) + '</span>') + drawStatus(e, 15) + '</div>' +
      '<div class="c-main"><h3 class="c-title" title="' + esc(e.title) + '">' + (e.partial ? '<i class="sk sk--title"></i>' : esc(e.title)) + '</h3>' + drawContext(e, ctx) + '</div>' +
      '<div class="c-end"><span class="c-id">' + esc(fill(kind.identifier, f)) + '</span>' + drawWait(e, ctx.now) + '</div>' +
      '<div class="c-acts">' + drawActs(e) + '</div>';
  }

  /** Returns the HTML inside a card, in the shape its kind declares. `ctx` holds the world's clock and the place it is shown under. */
  function drawCardBody(e, ctx) { return K.KINDS[e.kind].card === 'compact' ? drawCompactBody(e, ctx) : drawRichBody(e, ctx); }

  /** Returns a thing that rides on a row. A part that asks something says what it asks and has its moves. Anything else is one quiet line. */
  function drawPart(part, ctx) {
    if (part.restricted) {
      return '<div class="part part--closed" title="' + esc(Relations.sayClaim(part.link.claim)) + '"><span class="p-mark">' + Crew.icon('lock', 13) + '</span><span class="p-title">' + esc(Relations.sayRestricted(part.link.claim)) + '</span></div>';
    }
    var e = part.e, kind = K.KINDS[e.kind], line = describeLine(e);
    var status = kind.status && kind.status[e.fields.state];
    var title = esc(Relations.sayClaim(part.link.claim));
    var where = (Relations.readHomes(e)[0] || {}).title;
    var mark = '<span class="p-mark">' + drawMark(kind.plugin, 14) + '</span>';
    var fresh = e.fresh ? '<i class="c-fresh"><span class="sr">New</span></i>' : '';
    if (!part.rides || !e.concern || e.task || e.settled) {
      return '<div class="part part--quiet" role="button" data-id="' + e.id + '" tabindex="-1" title="' + title + '">' + mark + '<span class="p-title">' + esc(e.title) + '</span><span class="p-said">' + fresh + (e.task ? esc(line.text) : (status ? esc(status.word) : '')) + '</span></div>';
    }
    // The ask comes first. What has happened since follows, with its shape beside its words.
    var ask = e.signals.filter(function (s) { return s.key === e.concern; })[0];
    var said = isMine(e) ? 'Yours' : (ask ? sayReason(kind, ask).text : line.text);
    var news = line.text && line.text !== said ? '<span class="p-news tone-' + line.tone + '">' + (status && !status.norm ? drawShape(status, 12) : '') + esc(line.text) + '</span>' : '';
    return '<div class="part is-asking" role="button" data-id="' + e.id + '" tabindex="-1" title="' + title + '">' + mark +
      '<span class="p-title">' + esc(e.title) + '</span>' + drawWait(e, ctx.now) +
      '<span class="p-line">' + fresh + '<span class="p-said">' + esc(said) + '</span>' + news + '<span class="p-id">' + esc(fill(kind.identifier, e.fields)) + (where ? ' ' + esc(where) : '') + '</span></span>' +
      '<span class="c-acts">' + drawActs(e) + '</span></div>';
  }

  /** Returns who holds the card now. They stand at the end of its first line, in the place of the wait: rows have no free edge. */
  function drawHolder(e) {
    if (!e.task) return '';
    var title = esc(e.task.by === 'you' ? 'You have it' : e.task.by + ' has it');
    return '<span class="c-holder" title="' + title + '"><span class="c-holder-in">' + (e.task.by === 'you' ? drawPerson('you', 18) : Crew.face(e.task.by, { pose: 'working', size: 22 })) + '</span></span>';
  }

  /** Returns the class list of a card for its kind and its state. */
  function cardClasses(e) {
    var kind = K.KINDS[e.kind];
    return ['card', 'card--' + kind.card].join(' ');
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
      if (!c.matches('.card-stock, .c-holder')) c.remove();
    });
    el.insertAdjacentHTML('beforeend', drawCardBody(e, ctx));
    if (!e.task) [].forEach.call(el.querySelectorAll('.c-holder'), function (c) { c.remove(); });
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
    el.innerHTML = drawHolder(e) + (K.KINDS[e.kind].card === 'compact' ? '<i class="card-stock"></i>' : '') + drawCardBody(e, ctx);
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
          '<button class="c-act c-act--take" tabindex="-1" data-act="take" title="Take it (T)">Take it</button>' +
          '<button class="c-act c-act--plain" tabindex="-1" data-act="dismiss" title="Back to Intake (E)" aria-label="Back to Intake">' + Crew.icon('close', 14) + '</button>') + '</div>' +
      '</div>';
  }

  window.Card = {
    createCard: createCard, sayReference: sayReference, drawContext: drawContext, drawPart: drawPart, drawStatus: drawStatus, isMine: isMine, readPlugin: readPlugin, redrawBody: redrawBody, sayCard: sayCard, drawHolder: drawHolder, drawCardBody: drawCardBody, cardClasses: cardClasses, drawPlaque: drawPlaque, drawMark: drawMark, drawPerson: drawPerson, drawShape: drawShape,
    describeLine: describeLine, sayReason: sayReason, sayWait: sayWait, rampWait: rampWait, readWorkflows: readWorkflows, fill: fill, esc: esc, drawFacts: drawFacts,
  };
})();
