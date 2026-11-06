// List: the plain view of all the work. One column of rows under project headings, then under plan headings.
// A row at rest is a title, one muted line, its stage word and its age. The order comes from api.pieces(), oldest first,
// and nothing ever sorts by activity, so a row stays where the reader last saw it.
{
  const STREAM_KINDS = ['review', 'mention'];
  // A project with more rows than this starts folded, and so do its plans, so that the list opens as a short summary
  // at any volume and each unfolding shows a screenful rather than hundreds of rows.
  const MOST_ROWS_AT_REST = 40;
  // A first sentence shorter than this, such as "Done.", says too little, so the muted line takes the next sentence with it.
  const SHORTEST_LINE = 24;

  // The row under the highlight, by its data-id or data-fold. Every render rebuilds the rows and loses focus,
  // so the highlight is kept here and render puts the focus back.
  let highlighted = null;
  // The shell's api, kept for the key listener, which lives outside render.
  let shell = null;

  const isStreamPiece = w => STREAM_KINDS.includes(w.kind);
  const needsMe = w => w.move === 'you' && (w.need === 'think' || w.need === 'quick');
  const countWords = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const describeAge = days => (days === null ? '' : days === 0 ? 'today' : `${days}d`);

  // Returns what a folded heading hides that needs the reader, such as "3 need me", or nothing when none of it does.
  function describeNeeds(pieces) {
    const count = pieces.filter(needsMe).length;
    return count ? `${count} need${count === 1 ? 's' : ''} me` : '';
  }

  function matchesFilter(w, filter) {
    if (filter === 'all') return true;
    if (filter === 'needs-me') return needsMe(w);
    return filter === 'stalled' ? w.stalled : w.stage === filter;
  }

  // Returns the muted line of a row: the start of `where`, without the dates that the age already shows.
  function describeStanding(w) {
    const sentences = w.where.replace(/ (on|since) \d{4}-\d{2}-\d{2}/g, '').split(/(?<=\.)\s+/);
    const line = sentences[0].length < SHORTEST_LINE ? sentences.slice(0, 2).join(' ') : sentences[0];
    return line.replace(/\.$/, '');
  }

  // Returns the words of a stream line, such as "14 reviews and mentions", naming only the kinds it holds.
  function describeStream(pieces) {
    const reviews = pieces.filter(w => w.kind === 'review').length, mentions = pieces.length - reviews;
    if (reviews && mentions) return `${pieces.length} reviews and mentions`;
    return reviews ? countWords(reviews, 'review') : countWords(mentions, 'mention');
  }

  // Sorts one project's shown pieces into the parts the list draws. A landed piece leaves its plan for the project's landed line.
  function arrangeProject(g, isShown) {
    const isOpenWork = w => isShown(w) && w.stage !== 'landed';
    const plans = g.inits.map(plan => ({ plan, pieces:plan.pieces.filter(isOpenWork) })).filter(p => p.pieces.length);
    const landed = [...g.inits.flatMap(i => i.pieces), ...g.loose].filter(w => isShown(w) && w.stage === 'landed');
    return { project:g.project, plans, loose:g.loose.filter(isOpenWork), landed };
  }

  function renderPiece(w, parent, isNested, { api }) {
    const { esc } = api;
    const stage = api.stages.find(([s]) => s === w.stage)[1];
    const plan = w.initiative ? `<i class="lst-plan" style="background:${api.color(w.initiative, 50, 58)}"></i>` : '';
    return `<div class="lst-row ${isNested ? 'lst-nested' : ''} ${w.id === highlighted ? 'is-highlighted' : ''} ${api.cls(w)}" data-id="${esc(w.id)}" data-parent="${esc(parent)}" role="button" tabindex="-1">
      <span class="lst-gutter">${plan}</span>
      <span class="lst-text"><b>${esc(w.name)}</b><small>${esc(describeStanding(w))}</small></span>
      <span class="lst-stage">${esc(stage)}</span><span class="lst-age">${describeAge(api.quietDays(w))}</span>
    </div>`;
  }

  // Draws a stream or landed line, and its pieces below when it is unfolded. Such a line starts folded.
  // It fades with Wear by its freshest piece, because that piece says how neglected the line really is.
  function renderFoldLine(key, parent, title, pieces, view) {
    const { api } = view, isFolded = view.folds[key] ?? true;
    const freshest = pieces.reduce((a, b) => (api.quietDays(a) <= api.quietDays(b) ? a : b));
    const aged = api.cls(freshest).split(' ').filter(c => /^(wear|fog)/.test(c)).join(' ');
    return `<div class="lst-line ${key === highlighted ? 'is-highlighted' : ''} ${aged}" data-fold="${api.esc(key)}" data-parent="${api.esc(parent)}" aria-expanded="${!isFolded}" role="button" tabindex="-1">
      <span class="lst-gutter"><i class="lst-chevron"></i></span><span class="lst-text">${api.esc(title)}</span><span class="lst-age">${describeAge(api.quietDays(freshest))}</span>
    </div>${isFolded ? '' : pieces.map(w => renderPiece(w, key, true, view)).join('')}`;
  }

  // Draws one run of work. While folds are off, such as during a search, a stream shows as plain rows so that no match hides.
  function renderWork(pieces, parent, view) {
    const stream = pieces.filter(isStreamPiece);
    if (!view.foldsApply || stream.length < 2) return pieces.map(w => renderPiece(w, parent, false, view)).join('');
    const rows = pieces.filter(w => !isStreamPiece(w)).map(w => renderPiece(w, parent, false, view)).join('');
    return rows + renderFoldLine(`stream:${parent}`, parent, describeStream(stream), stream, view);
  }

  function renderHeading({ key, parent = '', kind, title, count, summary = '', plan = '', isFolded }, view) {
    const { api } = view, { esc } = api;
    const fold = view.foldsApply ? `data-fold="${esc(key)}" aria-expanded="${!isFolded}" role="button" tabindex="-1"` : '';
    const colour = plan ? `style="--lst-plan-colour:${api.color(plan, 50, 58)}"` : '';
    return `<div class="lst-heading lst-${kind} ${key === highlighted ? 'is-highlighted' : ''}" ${fold} data-parent="${esc(parent)}" ${colour}>
      <span class="lst-gutter">${view.foldsApply ? '<i class="lst-chevron"></i>' : plan ? '<i class="lst-plan"></i>' : ''}</span>
      <span class="lst-text">${esc(title)}${summary ? `<em>${esc(summary)}</em>` : ''}</span>
      ${plan ? `<span class="lst-details" data-init="${esc(plan)}">Plan details</span>` : ''}<span class="lst-age">${count}</span>
    </div>`;
  }

  // Draws a plan, or the loose work of a project that also has plans, under a heading that folds.
  function renderGroup(key, parent, title, pieces, plan, startsFolded, view) {
    const isFolded = view.foldsApply && (view.folds[key] ?? startsFolded);
    const summary = isFolded ? describeNeeds(pieces) : '';
    return `<div class="lst-group">${renderHeading({ key, parent, kind:'subheading', title, count:pieces.length, summary, plan, isFolded }, view)}${isFolded ? '' : renderWork(pieces, key, view)}</div>`;
  }

  function renderProject({ project, plans, loose, landed }, view) {
    const key = `project:${project}`, openWork = [...plans.flatMap(p => p.pieces), ...loose];
    const isLong = openWork.filter(w => !isStreamPiece(w)).length > MOST_ROWS_AT_REST;
    const isFolded = view.foldsApply && (view.folds[key] ?? isLong);
    const pieces = [...openWork, ...landed];
    const heading = renderHeading({ key, kind:'project', title:project, count:pieces.length, summary:isFolded ? describeNeeds(pieces) : '', isFolded }, view);
    if (isFolded) return `<section class="lst-section">${heading}</section>`;
    const planGroups = plans.map(({ plan, pieces }) => renderGroup(`plan:${plan.id}`, key, plan.name, pieces, plan.id, isLong, view)).join('');
    const looseWork = !plans.length ? renderWork(loose, key, view) : loose.length ? renderGroup(`loose:${project}`, key, 'Not in a plan', loose, '', isLong, view) : '';
    const landedWork = !landed.length ? '' : view.foldsApply ? renderFoldLine(`landed:${project}`, key, `${landed.length} landed`, landed, view) : landed.map(w => renderPiece(w, key, false, view)).join('');
    return `<section class="lst-section">${heading}${planGroups}${looseWork}${landedWork}</section>`;
  }

  const findRows = () => [...document.querySelectorAll('.v-list [data-id], .v-list [data-fold]')];
  const findRow = key => findRows().find(row => (row.dataset.id || row.dataset.fold) === key);
  const isDrawerOpen = () => !document.getElementById('drawer').hidden;

  // Moves the highlight to a row. With the details open, the details follow, so a reader can walk through the list.
  function moveHighlight(row) {
    if (!row) return;
    row.focus({ preventScroll:true });
    row.scrollIntoView({ block:'nearest' });
    if (row.dataset.id && isDrawerOpen()) shell.open(row.dataset.id);
  }

  // Folds or unfolds a row's group. The row stays where it is on screen, even a heading stuck to the top of a long project.
  function setFolded(row, isFolded) {
    const key = row.dataset.fold, top = row.getBoundingClientRect().top;
    shell.store('folds', { ...shell.load('folds', {}), [key]:isFolded });
    shell.rerender();
    scrollBy(0, findRow(key).getBoundingClientRect().top - top);
  }

  // Empties the Find box. The highlight comes back into view, now among all the rows around it.
  function clearFind(find) {
    find.value = '';
    find.dispatchEvent(new Event('input'));
    const row = findRow(highlighted);
    if (row) moveHighlight(row);
    else find.blur();
  }

  // Acts on a key pressed on a focused row. Returns true when the key is used up, so the listener can stop it there.
  function handleRowKey(e, row) {
    const rows = findRows(), at = rows.indexOf(row), isOpen = row.getAttribute('aria-expanded') === 'true';
    switch (e.key) {
      case 'ArrowDown': case 'j': moveHighlight(rows[at + 1]); return true;
      case 'ArrowUp': case 'k': moveHighlight(rows[at - 1]); return true;
      case 'ArrowRight':
        if (row.dataset.fold && !isOpen) setFolded(row, false);
        else if (row.dataset.fold) moveHighlight(rows[at + 1]);
        return true;
      case 'ArrowLeft':
        if (row.dataset.fold && isOpen) setFolded(row, true);
        else moveHighlight(findRow(row.dataset.parent));
        return true;
      case 'Enter': case ' ': {
        const plan = row.querySelector('[data-init]');
        if (row.dataset.id) shell.open(row.dataset.id);
        else if (plan) shell.openInit(plan.dataset.init);
        else setFolded(row, isOpen);
        return true;
      }
      default: return false;
    }
  }

  // Acts on a key pressed in the Find box: down enters the list, and Enter opens the first match.
  function handleFindKey(e) {
    if (e.key === 'ArrowDown') moveHighlight(findRow(highlighted) || findRows()[0]);
    else if (e.key === 'Enter') {
      const match = document.querySelector('.v-list [data-id]');
      if (match) { moveHighlight(match); shell.open(match.dataset.id); }
    } else return false;
    return true;
  }

  // The one key listener of this view. It listens on window in the capture phase, so it runs before the shell's listener on document.
  // Stopping a key here is what keeps left and right from switching views, and it happens only for keys used on a focused row.
  addEventListener('keydown', e => {
    if (document.body.dataset.view !== 'list' || e.ctrlKey || e.metaKey || e.altKey) return;
    const find = document.getElementById('find');
    if (e.target !== find && e.target.matches('input,textarea,select')) return;
    const row = e.target.closest('.v-list [data-id], .v-list [data-fold]');
    const stopKey = () => { e.preventDefault(); e.stopPropagation(); };

    if (e.key === 'Escape') {
      if (isDrawerOpen()) return;
      if (find.value) clearFind(find);
      else if (e.target === find) find.blur();
      else if (row) { highlighted = null; row.blur(); }
      return;
    }
    if (row && handleRowKey(e, row)) return stopKey();
    if (e.target === find) return void (handleFindKey(e) && stopKey());
    if (['ArrowDown', 'ArrowUp', 'j', 'k'].includes(e.key)) { moveHighlight(findRow(highlighted) || findRows()[0]); return stopKey(); }
    if (e.key === '/') { find.focus(); return stopKey(); }
    // Moving the focus during keydown lets the browser type this same character into the Find box.
    if (e.key.length === 1 && e.key !== ' ') find.focus();
  }, true);

  // A click anywhere else leaves the list, so that the shell's left and right view switching works again.
  addEventListener('pointerdown', e => {
    if (!e.target.closest('.v-list [data-id], .v-list [data-fold], .drawer')) highlighted = null;
  });

  Shell.register({ id:'list', label:'List', render(el, api) {
    shell = api;
    const { esc } = api;
    const filter = api.load('filter', 'all');
    const isFinding = document.getElementById('find').value !== '';
    const hits = api.pieces().filter(api.hit);
    const isShown = w => api.hit(w) && matchesFilter(w, filter);
    // The folds step aside when the reader asks for specific rows: every search match must show, and so must the landed work asked for by name.
    const view = { api, folds:api.load('folds', {}), foldsApply:!isFinding && filter !== 'landed' };
    const projects = api.groups().map(g => arrangeProject(g, isShown)).filter(p => p.plans.length || p.loose.length || p.landed.length);

    const filters = [['all', 'All'], ['needs-me', 'Needs me'], ['stalled', 'Stalled'], ...api.stages].map(([value, label]) =>
      `<button class="lst-filter ${value === filter ? 'is-on' : ''}" data-filter="${value}">${esc(label)}<em>${hits.filter(w => matchesFilter(w, value)).length}</em></button>`).join('');

    el.innerHTML = `<div class="v-list">
      <nav class="lst-filters">${filters}</nav>
      <div class="lst-rows">${projects.map(p => renderProject(p, view)).join('') || `<p class="lst-empty">${isFinding ? 'Nothing matches. Esc clears the search.' : 'Nothing here.'}</p>`}</div>
    </div>`;

    const root = el.firstElementChild, rows = findRows(), row = findRow(highlighted);
    root.style.setProperty('--lst-top', `${document.querySelector('.top').offsetHeight}px`);
    if (rows.length) (row || rows[0]).tabIndex = 0;
    if (row && document.activeElement === document.body) row.focus({ preventScroll:true });

    root.addEventListener('focusin', e => {
      const focused = e.target.closest('[data-id], [data-fold]');
      if (focused) highlighted = focused.dataset.id || focused.dataset.fold;
    });
    root.querySelector('.lst-rows').onclick = e => {
      const line = e.target.closest('[data-fold]');
      if (line && !e.target.closest('[data-init]')) setFolded(line, line.getAttribute('aria-expanded') === 'true');
    };
    root.querySelectorAll('[data-filter]').forEach(button => button.onclick = () => {
      api.store('filter', button.dataset.filter);
      api.rerender();
      document.querySelector(`.v-list [data-filter="${button.dataset.filter}"]`).focus();
    });
  }});
}
