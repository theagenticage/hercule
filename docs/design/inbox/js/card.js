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
    if (h < 48) return Math.round(h) + 'h';
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

  /** Returns what the second line of a card says: who or what brought the card here, and how many signals sit behind it. */
  function describeLine(e, usualReason) {
    var kind = K.KINDS[e.kind], f = e.fields;
    if (e.task) {
      var by = e.task.by === 'you'
        ? { face: '', text: 'You took it on', tone: 'plain' }
        : { face: '', text: e.task.by + ' has it', tone: 'plain' };
      return { lead: by.face, text: by.text, tone: by.tone, more: 0 };
    }
    var latest = e.signals[e.signals.length - 1];
    var rest = Math.max(0, e.signals.length - 1);
    if (!latest) return { lead: '', text: '', tone: 'plain', more: 0 };
    var reason = sayReason(kind, latest);
    var who = latest.who || (kind.person && f[kind.person] !== 'you' ? f[kind.person] : null);
    var usual = latest.key === usualReason;
    var text = reason.text;
    if (usual && who) text = W.PEOPLE[who].name;
    if (usual && !who) text = [fill(kind.identifier, f), fill(kind.context, f)].filter(Boolean).join(' · ');
    return { lead: who ? drawPerson(who) : '', text: text, tone: usual ? 'usual' : reason.tone, more: rest, isIdentity: usual && !who };
  }

  /** Returns the HTML inside a card. `ctx` holds the world's clock and the reason the stack takes for granted. */
  function drawCardBody(e, ctx) {
    var kind = K.KINDS[e.kind], f = e.fields;
    var line = describeLine(e, ctx.usual);
    var status = kind.status && kind.status[f.state];
    // The reason already says it in words and colour, so the shape does not say it again at rest.
    var isSaid = status && line.tone === 'bad' && status.tone === 'bad';
    var pace = kind.pace === 'fast' && !e.task ? sayWait(e.since, ctx.now) : '';
    var flows = readWorkflows(e);
    var hand = flows.length
      ? '<button class="c-act c-act--hand" tabindex="-1" data-act="hand" title="Hand to ' + esc(flows.length === 1 ? flows[0].name : 'an agent') + ' (H)" aria-label="Hand to ' + esc(flows.length === 1 ? flows[0].name : 'an agent') + '"' + (flows.length > 1 ? ' aria-haspopup="menu"' : '') + '>' +
        flows.slice(0, 2).map(function (w) { return Crew.face(w.name, { pose: 'idle', size: 20 }); }).join('') + '<span>' + esc(flows.length === 1 ? flows[0].name : 'Hand to…') + '</span></button>'
      : '';
    var acts = e.task
      ? '<button class="c-act c-act--go" tabindex="-1" data-act="go" title="See its Task on Work (G)">On Work ' + Crew.icon('arrow', 12) + '</button>'
      : hand +
        '<button class="c-act c-act--take" tabindex="-1" data-act="take" title="Take it on myself (T)" aria-label="Take it on myself">' + drawPerson('you', 18) + '<span>Take</span></button>' +
        '<button class="c-act c-act--plain" tabindex="-1" data-act="dismiss" title="Dismiss (E)" aria-label="Dismiss">' + Crew.icon('close', 14) + '</button>';
    return '<div class="c-mark">' + drawMark(kind.plugin, kind.density === 'tight' ? 18 : 20) + '</div>' +
      '<h3 class="c-title" title="' + esc(e.title) + '">' + (e.partial ? '<i class="sk sk--title"></i>' : esc(e.title)) + '</h3>' +
      '<div class="c-pace" data-ramp="' + rampWait(e.since, ctx.now, kind.patience) + '"' + (pace ? ' aria-label="Waiting ' + sayWaitInWords(e.since, ctx.now) + '"' : '') + '>' + pace + '</div>' +
      '<div class="c-line tone-' + line.tone + '">' + (e.fresh ? '<i class="c-fresh" title="New since you last looked"><span class="sr">New</span></i>' : '') + '<span class="c-who">' + line.lead + '</span><span class="c-roll"><span class="c-said">' + esc(line.text) + '</span></span>' + '<span class="c-more"' + (line.more ? '' : ' hidden') + '>+<span class="c-more-n">' + line.more + '</span></span></div>' +
      '<div class="c-status' + (status && (status.norm || isSaid) ? ' is-norm' : '') + '">' + (status ? drawShape(status) : '') + '</div>' +
      '<div class="c-foot">' + (line.isIdentity ? '' : '<span class="c-id">' + esc(fill(kind.identifier, f)) + '</span><span class="c-ctx">' + esc(fill(kind.context, f)) + '</span>') + '<span class="c-facts">' + drawFacts(kind, f) + '</span></div>' +
      '<div class="c-hit"></div>' +
      '<div class="c-acts">' + acts + '</div>';
  }

  /** Returns what stands behind the card's top edge: who holds it now, by the rule Work's cards follow. */
  function drawHolder(e) {
    if (!e.task) return '';
    if (e.task.by === 'you') return '<span class="card-holder"><i class="card-tab" data-need="quick"></i></span>';
    var hue = Crew.lookFor(e.task.by).hue;
    return '<span class="card-holder"><span class="card-head" data-pose="working">' + Crew.peek(e.task.by, { pose: 'working', size: 30, crop: 34 }) + '</span></span>' +
      '<span class="card-paws" data-pose="working" style="--hue:var(--hue-' + hue + ')"><i></i><i></i></span>';
  }

  /** Returns the class list of a card for its kind and its state. */
  function cardClasses(e) {
    var kind = K.KINDS[e.kind];
    var c = ['card', 'paper-' + kind.paper, 'density-' + kind.density, 'pace-' + kind.pace];
    return c.join(' ');
  }

  /** Returns what a screen reader says for a card: the kind, the title, why it is here, and how long it has waited. */
  function sayCard(e) {
    var kind = K.KINDS[e.kind], line = describeLine(e, null);
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

  /** Returns the marks of what a plaque combines: the first in full, any second as a badge on its corner. */
  function drawSources(sources) {
    var first = '<span class="pl-mark">' + Crew.brand(sources[0], 22) + '</span>';
    return first + (sources[1] ? '<span class="pl-badge">' + Crew.brand(sources[1], 10) + '</span>' : '');
  }

  /** Returns the HTML of a plaque: one thing Hercule noticed, on the lacquer plate. */
  function drawPlaque(c) {
    var flows = readWorkflows(c);
    return '<div class="plaque" role="listitem" data-id="' + c.id + '" tabindex="-1" aria-label="' + esc(c.title) + '. ' + esc(c.why) + '">' +
      '<div class="pl-marks">' + drawSources(c.sources) + '</div>' +
      '<h3 class="pl-title">' + esc(c.title) + '</h3>' +
      '<div class="pl-why">' + esc(c.why) + '</div>' +
      '<div class="c-acts pl-acts"><button class="c-act c-act--hand" tabindex="-1" data-act="hand" title="Hand to an agent (H)" aria-label="Hand to an agent">' + flows.slice(0, 2).map(function (w) { return Crew.face(w.name, { pose: 'idle', size: 21 }); }).join('') + '</button>' +
      '<button class="c-act" tabindex="-1" data-act="take" title="Take it on myself (T)" aria-label="Take it on myself">' + drawPerson('you', 20) + '</button>' +
      '<button class="c-act c-act--plain" tabindex="-1" data-act="dismiss" title="Back to Intake (E)" aria-label="Back to Intake">' + Crew.icon('close', 14) + '</button></div>' +
      '</div>';
  }

  window.Card = {
    createCard: createCard, redrawBody: redrawBody, sayCard: sayCard, drawHolder: drawHolder, drawCardBody: drawCardBody, cardClasses: cardClasses, drawPlaque: drawPlaque, drawMark: drawMark, drawPerson: drawPerson, drawShape: drawShape,
    describeLine: describeLine, sayReason: sayReason, sayWait: sayWait, rampWait: rampWait, readWorkflows: readWorkflows, fill: fill, esc: esc, drawFacts: drawFacts,
  };
})();
