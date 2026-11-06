// Home: the board the reader opens every morning. One stage axis runs down the whole page.
// Plans sit at the top, each a thin line across the stages that unfolds in place to show its cards.
// Work with no plan sits below in the same columns, in project lanes that fold away.
// A piece is drawn in one place only: on its plan, or in its project's lane.
{
  const CARD_WIDTH = 236, GAP = 10, DRAWER_WIDTH = 458, SWITCHER_HEIGHT = 60;
  const KIND_WORDS = { review:'review', mention:'mention', pr:'PR', ticket:'ticket', errors:'error report', other:'item', thread:'thread' };
  const SIGNAL_KINDS = ['review', 'mention'];
  // A cell never grows past this many rows, so a lane or an open ribbon has the same height at 60 pieces as at 300.
  const MOST_ROWS = 3;
  // Plans past this many rest behind one line, so that work with no plan still starts high on the page.
  const MOST_PLANS_AT_REST = 10;
  // Only this many cards of a fan fly out of the pile. The rest start below the fold of the fan, where nobody sees them fly.
  const MOST_FLYING_CARDS = 24;
  // The key of the fanned-open pile lives here so that a re-render, such as opening a card's details, keeps it open.
  let openPile = null;
  // How far the open fan is scrolled, so that opening a card's details does not jump a long fan back to its top.
  let fanScrollTop = 0;
  // The ribbon the last click folded or unfolded, with the height it had, so the next render can animate it.
  let movingPlan = null;

  const countWords = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // Returns the one muted line of a card: who asked for a review, else what is left,
  // and when that is only a filler word, what the piece is.
  function pickMutedLine(w) {
    const asker = w.where.match(/requested by (\S+)/);
    if (asker) return `Asked by ${asker[1]}`;
    if (w.left && !/^(everything|nothing|a review)$/i.test(w.left.trim())) return w.left;
    const what = w.what.replace(/\.$/, '');
    return what === w.name ? 'Not started' : what;
  }

  // Returns which pile a piece belongs to within one cell, or null when it stays a card of its own.
  // Threads stay cards because each one is its own line of thought; streams of PRs and tickets do not need that.
  function pickPileGroup(w) {
    if (w.stage === 'landed') return 'landed';
    if (SIGNAL_KINDS.includes(w.kind)) return 'signals';
    return w.kind === 'thread' ? null : w.kind;
  }

  // Splits the pieces of one cell into piles and cards, both in the oldest-first order of api.pieces().
  // When more is left than the cell has room for, the oldest cards join a pile of their own.
  function arrangeCell(pieces, stage) {
    const grouped = new Map();
    for (const w of pieces) {
      const group = pickPileGroup(w);
      if (group) grouped.set(group, [...(grouped.get(group) || []), w]);
    }
    const piled = new Set(), piles = [];
    for (const [group, ws] of grouped) {
      if (ws.length < (group === 'landed' || group === 'signals' ? 2 : 3)) continue;
      piles.push({ group, pieces:ws });
      ws.forEach(w => piled.add(w));
    }
    const cards = pieces.filter(w => !piled.has(w));
    const room = MOST_ROWS * (stage === 'reviewing' ? 2 : 1) - piles.length;
    if (cards.length <= room) return { piles, cards };
    const overflow = cards.length - Math.max(room - 1, 0);
    return { piles:[...piles, { group:'older', pieces:cards.slice(0, overflow) }], cards:cards.slice(overflow) };
  }

  // Returns the line every piece of a pile has in common, or nothing when they differ.
  function describeSharedStep(pieces) {
    const lines = new Set(pieces.map(pickMutedLine));
    return lines.size === 1 ? [...lines][0] : '';
  }

  // Returns what a pile hides that needs the reader, such as "2 real thinking, 5 quick calls", or nothing when none of it does.
  function describeNeeds(pieces) {
    const thinking = pieces.filter(w => w.need === 'think').length, quick = pieces.filter(w => w.need === 'quick').length;
    return [thinking && `${thinking} real thinking`, quick && countWords(quick, 'quick call')].filter(Boolean).join(', ');
  }

  // Returns the words on the top of a pile. `count` is set only when the title does not already give the number.
  function describePile({ group, pieces }) {
    const n = pieces.length;
    if (group === 'landed') return { title:`${n} landed` };
    if (group === 'older') return { title:`${n} older pieces`, line:describeNeeds(pieces) };
    if (group === 'signals') {
      const reviews = pieces.filter(w => w.kind === 'review').length, mentions = n - reviews;
      return { title:'Reviews and mentions', count:n, line:[reviews && countWords(reviews, 'review'), mentions && countWords(mentions, 'mention')].filter(Boolean).join(', ') };
    }
    return { title:countWords(n, KIND_WORDS[group]), line:describeSharedStep(pieces) || describeNeeds(pieces) };
  }

  function renderCard(w, api) {
    return `<article class="hm-card ${api.cls(w)}" data-id="${w.id}"><h4>${api.esc(w.name)}</h4><p>${api.esc(pickMutedLine(w))}</p><footer><i class="hm-need"></i>${api.quiet(w)}</footer></article>`;
  }

  function renderPile(key, pile, api) {
    const { esc, hit, quietDays, quiet } = api, ws = pile.pieces;
    const { title, count, line } = describePile(pile);
    const matches = ws.filter(hit).length;
    const freshest = ws.reduce((a, b) => (quietDays(a) <= quietDays(b) ? a : b));
    const aged = api.cls(freshest).split(' ').filter(c => /^(wear|fog)/.test(c)).join(' ');
    const need = ws.some(w => w.need === 'think') ? 'think' : ws.some(w => w.need === 'quick') ? 'quick' : '';
    const sheets = ws.length >= 8 ? 3 : ws.length >= 4 ? 2 : 1;
    return `<button class="hm-pile ${pile.group === 'landed' ? 'hm-landed' : ''} ${matches ? '' : 'dim'} ${aged} ${need} ${key === openPile ? 'is-open' : ''}" data-pile="${esc(key)}" style="--hm-sheets:${sheets}">
      ${'<i></i>'.repeat(sheets)}
      <span><b>${esc(title)}</b>${count ? `<em>${count}</em>` : ''}${line ? `<u>${esc(line)}</u>` : ''}<small><i class="hm-need"></i>${matches && matches < ws.length ? `${matches} of ${ws.length} match` : quiet(freshest)}</small></span>
    </button>`;
  }

  // Draws one cell of cards. Lanes and open ribbons share it, so a pile means the same thing everywhere.
  function renderCell(owner, stage, pieces, api, piles) {
    const { piles:rested, cards } = arrangeCell(pieces, stage);
    return rested.map(pile => {
      const key = `${owner}/${stage}/${pile.group}`;
      piles.set(key, pile.pieces);
      return renderPile(key, pile, api);
    }).join('') + cards.map(w => renderCard(w, api)).join('');
  }

  // Draws one mark per piece. Pieces that need the reader come first and each group stays oldest first,
  // so a mark only moves when its need changes, and a busy line still reads as a short count.
  function renderMarks(pieces, api) {
    const rank = w => (w.need === 'think' ? 0 : w.need === 'quick' ? 1 : 2);
    return [...pieces].sort((a, b) => rank(a) - rank(b)).map(w => `<span class="hm-mark ${api.cls(w)}" data-id="${w.id}" title="${api.esc(w.name)}"></span>`).join('');
  }

  // Draws a stage's piece count in its column, for a row that is folded and shows no cards.
  function renderCount(pieces, api) {
    if (!pieces.length) return '';
    const matches = pieces.filter(api.hit).length;
    return `<span class="hm-count ${matches ? '' : 'dim'}">${matches && matches < pieces.length ? `${matches} of ${pieces.length}` : pieces.length}</span>`;
  }

  function renderRibbon(i, startsProject, isOpen, api, piles) {
    const { esc, stages } = api;
    const furthest = Math.max(...i.pieces.map(w => stages.findIndex(([s]) => s === w.stage)));
    const cells = stages.map(([s]) => {
      const ws = i.pieces.filter(w => w.stage === s);
      return `<div class="hm-cell hm-cell-${s}">${isOpen ? renderCell(i.id, s, ws, api, piles) : renderMarks(ws, api)}</div>`;
    }).join('');
    const chevron = `<button class="hm-fold" aria-expanded="${isOpen}" title="${isOpen ? 'Fold this plan to one line' : 'Open this plan'}"><i></i></button>`;
    const dim = i.pieces.some(api.hit) ? '' : 'dim';
    return `<section class="hm-ribbon ${startsProject ? 'hm-next-project' : ''} ${isOpen ? 'is-open' : ''}" data-plan="${i.id}" style="--hm-c:${api.color(i.id, 50, 58)};--hm-reach-end:${furthest + 3}">
      <i class="hm-tail ${dim}"></i><i class="hm-reach ${dim}"></i>
      <div class="hm-head ${dim}">
        ${chevron}<h3 title="${esc(i.name)}">${esc(i.name)}</h3>
        ${isOpen ? `<p>${esc(i.intent)}</p>` : ''}<div class="hm-measure" title="${esc(i.progress || i.target || '')}">${api.bullet(i)}</div>
        ${isOpen ? `<span class="hm-details" data-init="${i.id}">Plan details</span>` : ''}
      </div>
      ${cells}
    </section>`;
  }

  function renderLane(g, isFolded, api, piles) {
    const { esc, stages } = api;
    const cells = stages.map(([s]) => {
      const ws = g.loose.filter(w => w.stage === s);
      return `<div class="hm-cell hm-cell-${s}">${isFolded ? renderCount(ws, api) : renderCell(g.project, s, ws, api, piles)}</div>`;
    }).join('');
    return `<section class="hm-lane ${isFolded ? 'is-folded' : ''}">
      <button class="hm-lane-head" data-lane="${esc(g.project)}" aria-expanded="${!isFolded}"><i class="hm-chev"></i><b>${esc(g.project)}</b><em>${g.loose.length}</em></button>
      ${cells}
    </section>`;
  }

  // Sets the fan's box and columns. The fan stays left of where the details drawer opens and above the prototype
  // switcher, so a reader can walk through a pile with the drawer open. A fan too tall for the window scrolls.
  function placeFan(fan, pile) {
    const count = fan.children.length, origin = pile.getBoundingClientRect();
    const cardHeight = fan.firstElementChild.offsetHeight;
    const topLimit = document.querySelector('.top').offsetHeight + 12, bottomLimit = innerHeight - SWITCHER_HEIGHT;
    const rightLimit = Math.max(innerWidth - DRAWER_WIDTH, CARD_WIDTH + 36);
    const fitting = Math.max(1, Math.floor((rightLimit - 18 + GAP) / (CARD_WIDTH + GAP)));
    const columns = Math.min(fitting, count, Math.max(3, Math.ceil(Math.sqrt(count * 1.5))));
    const rows = Math.ceil(count / columns);
    const width = columns * (CARD_WIDTH + GAP) - GAP;
    const height = Math.min(rows * (cardHeight + GAP) - GAP, bottomLimit - topLimit);
    fan.style.gridTemplateColumns = `repeat(${columns}, ${CARD_WIDTH}px)`;
    fan.style.left = `${Math.max(18, Math.min(origin.left + origin.width / 2 - width / 2, rightLimit - width))}px`;
    fan.style.top = `${Math.max(topLimit, Math.min(origin.top, bottomLimit - height))}px`;
    fan.style.height = `${height}px`;
    fan.classList.toggle('scrolls', rows * (cardHeight + GAP) - GAP > height);
  }

  function flyFromPile(fan, pile, reverse) {
    const origin = pile.getBoundingClientRect();
    return [...fan.children].slice(0, MOST_FLYING_CARDS).map((card, i) => {
      const box = card.getBoundingClientRect();
      const frames = [{ transform:`translate(${origin.left - box.left}px, ${origin.top - box.top}px)`, opacity:.4 }, { transform:'none' }];
      return card.animate(reverse ? frames.reverse() : frames, reverse ? { duration:160, easing:'ease-in', fill:'forwards' } : { duration:320, delay:i * 12, easing:'cubic-bezier(.2,.85,.25,1)', fill:'backwards' });
    });
  }

  function closeFan(root) {
    const fan = root.querySelector('.hm-fan'), pile = root.querySelector('[data-pile].is-open');
    openPile = null;
    root.querySelector('.hm-scrim').classList.remove('on');
    pile?.classList.remove('is-open');
    if (!pile) return void (fan.innerHTML = '');
    Promise.all(flyFromPile(fan, pile, true).map(a => a.finished)).then(() => { fan.innerHTML = ''; }, () => {});
  }

  Shell.register({ id:'home', label:'Home: board with plans', render(el, api) {
    const { esc, stages } = api;
    const all = api.pieces(), groups = api.groups();
    const opened = api.load('opened', {}), folded = api.load('folded', {}), showAllPlans = api.load('showAllPlans', false);
    const plans = groups.flatMap(g => g.inits);
    const restingPlans = showAllPlans ? [] : plans.slice(MOST_PLANS_AT_REST);
    const shownPlans = plans.slice(0, plans.length - restingPlans.length);
    const piles = new Map();

    const axis = stages.map(([s, label]) => `<div class="hm-stage"><span class="mark" style="background:var(--s-${s})"></span>${label}<em>${all.filter(w => w.stage === s).length}</em></div>`).join('');
    const ribbons = shownPlans.map((i, n) => renderRibbon(i, n > 0 && i.project !== shownPlans[n - 1].project, !!opened[i.id], api, piles)).join('');
    const restingPieces = restingPlans.flatMap(i => i.pieces);
    const moreLine = plans.length <= MOST_PLANS_AT_REST ? '' : `<button class="hm-more" data-more>
      <span class="hm-more-name">${showAllPlans ? 'Show fewer plans' : `${restingPlans.length} more plans`}</span>
      ${stages.map(([s]) => `<span class="hm-cell">${renderCount(restingPieces.filter(w => w.stage === s), api)}</span>`).join('')}
    </button>`;
    const lanes = groups.filter(g => g.loose.length).map(g => renderLane(g, !!folded[g.project], api, piles)).join('');

    const fanned = openPile && piles.get(openPile);
    if (!fanned) openPile = null;

    el.innerHTML = `<div class="v-home">
      <div class="hint hm-hint"><span>Each line is a plan and each dot a piece at its stage. Click a line to open it. Work with no plan sits below by project.</span><span class="hm-key"><i class="think"></i>real thinking<i class="quick"></i>a quick call</span></div>
      <div class="hm-frame">
        <div class="hm-rules"><i></i><i></i><i></i><i></i><i></i><i></i></div>
        <div class="hm-axis"><div>${Object.values(opened).some(Boolean) ? '<button class="hm-fold-all">Fold all plans</button>' : ''}</div>${axis}</div>
        <div class="hm-ribbons">${ribbons}${moreLine}</div>
        <div class="hm-divider">Not in a plan</div>
        ${lanes}
      </div>
      <div class="hm-scrim ${fanned ? 'on' : ''}"></div>
      <div class="hm-fan">${fanned ? fanned.map(w => renderCard(w, api)).join('') : ''}</div>
    </div>`;

    const root = el.firstElementChild, fan = root.querySelector('.hm-fan'), scrim = root.querySelector('.hm-scrim');
    root.style.setProperty('--hm-top', `${document.querySelector('.top').offsetHeight}px`);

    root.querySelectorAll('[data-plan]').forEach(ribbon => ribbon.onclick = e => {
      if (e.target.closest('[data-id],[data-init],[data-pile]')) return;
      const id = ribbon.dataset.plan, now = api.load('opened', {});
      movingPlan = { id, height:ribbon.offsetHeight };
      api.store('opened', { ...now, [id]:!now[id] });
      api.rerender();
    });
    root.querySelector('.hm-fold-all')?.addEventListener('click', () => { api.store('opened', {}); api.rerender(); });
    root.querySelector('[data-more]')?.addEventListener('click', () => { api.store('showAllPlans', !showAllPlans); api.rerender(); });
    root.querySelectorAll('[data-lane]').forEach(button => button.onclick = () => {
      const lane = button.dataset.lane, now = api.load('folded', {});
      api.store('folded', { ...now, [lane]:!now[lane] });
      api.rerender();
    });
    root.querySelectorAll('[data-pile]').forEach(pile => pile.onclick = () => {
      if (pile.dataset.pile === openPile) return closeFan(root);
      openPile = pile.dataset.pile;
      fan.innerHTML = piles.get(openPile).map(w => renderCard(w, api)).join('');
      pile.classList.add('is-open');
      scrim.classList.add('on');
      placeFan(fan, pile);
      fan.scrollTop = fanScrollTop = 0;
      flyFromPile(fan, pile, false);
    });
    scrim.onclick = () => closeFan(root);
    fan.onscroll = () => { fanScrollTop = fan.scrollTop; };
    if (fanned) {
      placeFan(fan, root.querySelector(`[data-pile="${CSS.escape(openPile)}"]`));
      fan.scrollTop = fanScrollTop;
    }

    if (movingPlan) {
      const ribbon = root.querySelector(`[data-plan="${CSS.escape(movingPlan.id)}"]`);
      ribbon.classList.add('is-moving');
      ribbon.animate([{ height:`${movingPlan.height}px` }, { height:`${ribbon.offsetHeight}px` }], { duration:220, easing:'cubic-bezier(.2,.85,.25,1)' }).onfinish = () => ribbon.classList.remove('is-moving');
      movingPlan = null;
    }
  }});

  // Escape closes the details first, as the shell does, and only then the fan.
  addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !openPile || document.body.dataset.view !== 'home') return;
    if (document.getElementById('drawer').hidden) closeFan(document.querySelector('.v-home'));
  }, true);
}
