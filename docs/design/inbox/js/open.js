// The open card. A card opens where it lies: its top-left corner stays put, the title stays where the eye already is, and
// the card unfolds across its neighbours. Nothing behind it moves.
window.Open = (function () {
  var K = Kinds.KINDS, W = World;
  var host, scrim, openId = null, sourceEl = null;

  function saySince(d, now) {
    var h = (now - d) / 36e5;
    if (h < 1) return Math.max(1, Math.round(h * 60)) + ' min ago';
    if (h < 24) return Math.round(h) + 'h ago';
    var days = Math.round(h / 24);
    return days === 1 ? 'Yesterday' : days + ' days ago';
  }

  function drawSignals(e, now) {
    var kind = K[e.kind];
    return '<ol class="o-signals">' + e.signals.map(function (s, i) {
      var r = Card.sayReason(kind, s);
      var latest = i === e.signals.length - 1;
      return '<li class="o-signal' + (latest ? ' is-latest' : '') + ' tone-' + r.tone + '"><span class="o-dot"></span>' +
        '<span class="o-text">' + Card.esc(r.text) + (s.note ? '<q>' + Card.esc(s.note) + '</q>' : '') + '</span>' +
        '<time>' + saySince(s.at, now) + '</time></li>';
    }).join('') + '</ol>';
  }

  function drawLedger(e) {
    var flows = Card.readWorkflows(e);
    if (e.task) {
      return '<div class="o-ledger"><button class="o-row" data-act="go"><span class="o-label">See it on Work</span><span class="o-says">' + (e.task.by === 'you' ? 'You took this on.' : Card.esc(e.task.by) + ' is working on it.') + ' The Task carries the same link.</span><kbd>G</kbd></button></div>';
    }
    var rows = flows.map(function (w, i) {
      return '<button class="o-row' + (i === 0 ? ' is-first' : '') + '" data-act="hand-to" data-i="' + i + '"><span class="o-label">' + Crew.face(w.name, { pose: 'idle', size: 22 }) + Card.esc(w.name) + '</span><span class="o-says">' + Card.esc(w.says) + '</span><kbd>' + (flows.length === 1 ? 'H' : i + 1) + '</kbd></button>';
    }).join('');
    return '<div class="o-ledger">' + rows +
      '<button class="o-row" data-act="take"><span class="o-label">' + Card.drawPerson('you', 22) + 'Take it on myself</span><span class="o-says">Creates a Task with no run.</span><kbd>T</kbd></button>' +
      '<button class="o-row o-row--quiet" data-act="dismiss"><span class="o-label">Dismiss</span><span class="o-says">Takes it off your Inbox. ' + Card.esc(K[e.kind].plugin.name) + ' is not told.</span><kbd>E</kbd></button>' +
      '</div>';
  }

  function drawOpen(e) {
    var now = App.state.now, kind = K[e.kind], f = e.fields;
    var status = kind.status && kind.status[f.state];
    var who = kind.person && W.PEOPLE[f[kind.person]];
    var id = Card.fill(kind.identifier, f), ctx = Card.fill(kind.context, f);
    return '<div class="o-head">' +
      '<div class="c-mark">' + Card.drawMark(kind.plugin) + '</div>' +
      '<h2 class="o-title">' + Card.esc(e.title) + '</h2>' +
      '<button class="icon-btn icon-btn--sm o-close" data-close title="Close (Esc)">' + Crew.icon('close', 13) + '</button>' +
      '<div class="o-meta"><span>' + Card.esc(kind.noun) + '</span>' + [id, ctx].filter(Boolean).map(function (x) { return '<i>·</i><span>' + Card.esc(x) + '</span>'; }).join('') + (who ? '<i>·</i><span>' + Card.esc(who.name) + '</span>' : '') + '</div>' +
      '</div>' +
      (e.signals.length ? '<section class="o-sec">' + drawSignals(e, now) + '</section>' : '') +
      '<div class="o-facts">' + (status ? '<span class="o-status">' + Card.drawShape(status, 15) + Card.esc(status.word) + '</span>' : '') + Card.drawFacts(kind, f) + '<a class="o-source" data-source>Open in ' + Card.esc(kind.plugin.name) + ' ' + Crew.icon('external', 12) + '</a></div>' +
      drawLedger(e);
  }

  function drawOpenPlaque(c) {
    var flows = K['hercule/cluster'].workflows.noticed;
    return '<div class="o-head o-head--plaque">' +
      '<div class="c-mark">' + Crew.logo(22, { mono: true }) + '</div>' +
      '<h2 class="o-title">' + Card.esc(c.title) + '</h2>' +
      '<button class="icon-btn icon-btn--sm o-close" data-close title="Close (Esc)">' + Crew.icon('close', 13) + '</button>' +
      '<div class="o-meta"><span>Noticed by Hercule</span><i>·</i><span>' + Card.esc(c.figures) + '</span></div></div>' +
      '<p class="o-note">' + Card.esc(c.detail) + '</p>' +
      '<ol class="o-parts">' + c.parts.map(function (p) { return '<li>' + Card.drawMark(p.plugin, 15) + '<span>' + Card.esc(p.title) + '</span><small>' + Card.esc(p.fact) + '</small></li>'; }).join('') + '</ol>' +
      '<div class="o-ledger">' + flows.map(function (w, i) {
        return '<button class="o-row' + (i === 0 ? ' is-first' : '') + '" data-act="hand-to" data-i="' + i + '"><span class="o-label">' + Crew.face(w.name, { pose: 'idle', size: 22 }) + Card.esc(w.name) + '</span><span class="o-says">' + Card.esc(w.says) + '</span><kbd>' + (i + 1) + '</kbd></button>';
      }).join('') +
      '<button class="o-row" data-act="take"><span class="o-label">' + Card.drawPerson('you', 22) + 'Take it on myself</span><span class="o-says">Creates a Task with no run.</span><kbd>T</kbd></button>' +
      '<button class="o-row o-row--quiet" data-act="dismiss"><span class="o-label">Back to Intake</span><span class="o-says">Hercule should not have raised this.</span><kbd>E</kbd></button></div>';
  }

  /** Opens a card where it lies. */
  function show(id, anchor) {
    var e = App.findEntity(id);
    if (!e) return;
    if (openId) hide(true);
    Pointer.setHover(null);
    Pointer.unpeek();
    var plaque = e.kind === 'hercule/cluster';
    sourceEl = anchor || (plaque ? document.querySelector('.plaque[data-id="' + id + '"]') : App.els()[id]);
    openId = id;
    var r = sourceEl.getBoundingClientRect();
    var main = document.getElementById('main').getBoundingClientRect();
    host.className = 'open' + (plaque ? ' open--plaque' : ' paper-' + K[e.kind].paper);
    host.innerHTML = plaque ? drawOpenPlaque(e) : drawOpen(e);
    host.hidden = false;
    host.style.width = '';
    var w = Math.max(520, Math.round(r.width));
    host.style.width = w + 'px';
    var h = host.offsetHeight;
    var left = Math.max(main.left + 16, Math.min(r.left - 1, main.right - w - 16));
    var top = Math.min(r.top, innerHeight - h - 16);
    top = Math.max(main.top + 12, top);
    host.style.left = left + 'px';
    host.style.top = top + 'px';
    scrim.hidden = false;
    scrim.classList.add('is-on');
    sourceEl.classList.add('is-source');
    App.state.open = id;
    if (!Motion.isReduced()) {
      var ease = Motion.curve('travel').ease, ms = Math.min(Motion.curve('travel').ms, 520);
      var clipFrom = 'inset(' + Math.max(0, r.top - top) + 'px ' + Math.max(0, w - (r.left - left) - r.width) + 'px ' + Math.max(0, top + h - r.top - Math.min(r.height, 64)) + 'px ' + Math.max(0, r.left - left) + 'px round 12px)';
      host.animate([{ clipPath: clipFrom }, { clipPath: 'inset(-40px -40px -60px -40px round 14px)' }], { duration: ms, easing: ease });
      // The title is the same object in both places: it grows from where it lay, so the eye never loses it.
      var from = sourceEl.querySelector('.c-title, .pl-title'), to = host.querySelector('.o-title');
      if (from && to) {
        var a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
        var scale = parseFloat(getComputedStyle(from).fontSize) / parseFloat(getComputedStyle(to).fontSize);
        to.style.transformOrigin = '0 0';
        to.animate([{ transform: 'translate(' + (a.left - b.left) + 'px,' + (a.top - b.top) + 'px) scale(' + scale + ')' }, { transform: 'none' }], { duration: ms, easing: ease });
      }
      [].forEach.call(host.querySelectorAll('.o-sec, .o-note, .o-parts, .o-facts, .o-row'), function (el, i) {
        el.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 240, delay: 60 + i * 22, fill: 'backwards', easing: 'cubic-bezier(.22,.9,.24,1)' });
      });
    }
    var first = host.querySelector('.o-row');
    if (first) first.focus({ preventScroll: true });
  }

  function hide(instant) {
    if (!openId) return;
    var src = sourceEl, id = openId;
    openId = null;
    App.state.open = null;
    scrim.classList.remove('is-on');
    var finish = function () {
      host.hidden = true;
      if (!openId) scrim.hidden = true;
      if (src) src.classList.remove('is-source');
    };
    if (instant || Motion.isReduced() || !src) { finish(); return; }
    var r = src.getBoundingClientRect(), b = host.getBoundingClientRect();
    var clipTo = 'inset(' + Math.max(0, r.top - b.top) + 'px ' + Math.max(0, b.right - r.right) + 'px ' + Math.max(0, b.bottom - r.top - Math.min(r.height, 64)) + 'px ' + Math.max(0, r.left - b.left) + 'px round 12px)';
    host.animate([{ clipPath: 'inset(-40px -40px -60px -40px round 14px)', opacity: 1 }, { clipPath: clipTo, opacity: 0.4 }], { duration: 200, easing: 'cubic-bezier(.5,0,.3,1)' }).finished.then(finish, finish);
    Keys.focus(id);
  }

  function isOpen() { return !!openId; }
  function current() { return openId; }

  function act(btn) {
    var id = openId;
    var e = App.findEntity(id);
    var a = btn.dataset.act;
    hide(true);
    if (a === 'hand-to') {
      var flows = Card.readWorkflows(e);
      Moves.hand(e, flows[Number(btn.dataset.i)]);
    } else Moves.perform(a, id, btn);
  }

  function start() {
    host = document.getElementById('open');
    scrim = document.getElementById('scrim');
    scrim.addEventListener('click', function () { hide(); });
    host.addEventListener('click', function (ev) {
      if (ev.target.closest('[data-close]')) { hide(); return; }
      var b = ev.target.closest('[data-act]');
      if (b) act(b);
    });
  }

  return { show: show, hide: hide, isOpen: isOpen, current: current, act: act, start: start };
})();
