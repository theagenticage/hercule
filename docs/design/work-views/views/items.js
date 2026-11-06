// Inbox: the external entities that concern the reader. The card is the entity, and the signals about it sit inside the card, so two signals
// about one pull request are one card and never two. The whole page is drawn from ENTITY_KINDS, the table a plugin would contribute to:
// every card goes through the same renderCard, and a kind only picks values for its fixed slots. Nothing here sorts by activity: every list
// is oldest first, and acting on a card only changes how that card looks, so a card stays where the reader last saw it.
{
  // Brand marks on a 24-unit grid, from Simple Icons (CC0).
  const MARKS = {
    github:{ name:'GitHub', color:'var(--gh-ink)', path:'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12' },
    linear:{ name:'Linear', color:'var(--ln-brand)', path:'M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z' },
    sentry:{ name:'Sentry', color:'var(--sentry)', path:'M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z' },
  };
  // GitHub's own icons on a 16-unit grid, so that a pull request is drawn in the marks people know from GitHub.
  const OCTICON_PATHS = {
    pullRequest:'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z',
    checkCircle:'M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16Zm3.78-9.72a.751.751 0 0 0-.018-1.042.751.751 0 0 0-1.042-.018L6.75 9.19 5.28 7.72a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042l2 2a.75.75 0 0 0 1.06 0Z',
    xCircle:'M2.343 13.657A8 8 0 1 1 13.658 2.343 8 8 0 0 1 2.343 13.657ZM6.03 4.97a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042L6.94 8 4.97 9.97a.749.749 0 0 0 .326 1.275.749.749 0 0 0 .734-.215L8 9.06l1.97 1.97a.749.749 0 0 0 1.275-.326.749.749 0 0 0-.215-.734L9.06 8l1.97-1.97a.749.749 0 0 0-.326-1.275.749.749 0 0 0-.734.215L8 6.94Z',
    sync:'M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z',
    fileDiff:'M1 1.75C1 .784 1.784 0 2.75 0h7.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16H2.75A1.75 1.75 0 0 1 1 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V4.664a.25.25 0 0 0-.073-.177l-2.914-2.914a.25.25 0 0 0-.177-.073ZM8 3.25a.75.75 0 0 1 .75.75v1.5h1.5a.75.75 0 0 1 0 1.5h-1.5v1.5a.75.75 0 0 1-1.5 0V7h-1.5a.75.75 0 0 1 0-1.5h1.5V4A.75.75 0 0 1 8 3.25Zm-3 8a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1-.75-.75Z',
    x:'M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z',
    check:'M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z',
  };
  // The product's logo mark on a 32-unit grid: an egg-shaped head with a waxed moustache.
  const LOGO_HEAD = 'M16 2.4c-6.3 0-10.9 7.6-10.9 14.8 0 7.1 4.8 12.4 10.9 12.4s10.9-5.3 10.9-12.4C26.9 10 22.3 2.4 16 2.4z';
  const LOGO_MOUSTACHE = 'M16 19.2c-1.5-1.2-3.4-1.5-5.1-.7-.9.4-1.7.3-2.3-.4-.4-.5-1.2-.3-1.1.4.3 1.9 2 3 4 2.8 1.8-.2 3.3-.9 4.5-1.8 1.2.9 2.7 1.6 4.5 1.8 2 .2 3.7-.9 4-2.8.1-.7-.7-.9-1.1-.4-.6.7-1.4.8-2.3.4-1.7-.8-3.6-.5-5.1.7z';

  // The workflows whose triggers fit each kind of card, by name. This is a simulation: handing a card to one starts nothing.
  const REVIEW_WORKFLOW = 'Agent review';
  const FAILED_CHECK_WORKFLOW = 'Repair the build';
  const TICKET_WORKFLOWS = ['Draft a change', 'Build it with a second opinion'];
  const TRIAGE_WORKFLOWS = ['Build it with a second opinion'];

  // The data says "Ready to merge", but an approved PR can still be stale, so the heading claims only the approval.
  const NEXT_STEP_HEADINGS = { 'Fix the checks':'My PRs: Fix the checks', 'Address requested changes':'My PRs: Address requested changes', 'Ready to merge':'My PRs: Approved', 'Waiting for a review':'My PRs: Waiting for a review' };
  // A review that has waited longer than a working day shows its wait in the warning colour.
  const LONG_WAIT_HOURS = 24;
  // This many cards on one Task are one thing to think about, so they fold to one pile.
  const SHARED_TASK_MINIMUM = 3;
  const PRIORITY_LEVELS = { 'No priority':0, Low:1, Medium:2, High:3 };
  const LINEAR_STATE_TONES = { Triage:'attention', Todo:'quiet', 'In Progress':'active' };
  // The one short line on each triage card. The full reason opens with the tray.
  const TRIAGE_REASONS = {
    'c-coupons':'Came back after the last release',
    'c-search':'Came back, the loudest error in the shop',
    'c-photos':'Seven errors from one carousel',
    'c-slots':'Growing quickly, few shoppers so far',
  };
  // What an act on a card says about the signals it answered, and the words for it in the Undo bar.
  const ACT_OUTCOMES = { taken:'Taken on', left:'Left' };
  const ACT_LABELS = { taken:'Took on', left:'Left', 'sent-back':'Back to Intake:' };

  const sortOldestFirst = (list, ageField) => [...list].sort((a, b) => b[ageField] - a[ageField]);

  // The card under the highlight, by its data-line key. Every render rebuilds the cards and loses focus, so the highlight is kept here and render puts the focus back.
  let highlighted = null;
  // The ids of the cards the s key walks, in the order they are drawn.
  let reviewQueue = [];
  // What can still be undone with the u key, newest last. It lives only as long as the page, because each card keeps its own Undo.
  let undoLog = [];
  // The card whose workflow menu is open, by its data-line key. It lives only as long as the page.
  let openMenu = null;
  // The shell's api, kept for the key listener, which lives outside render.
  let shell = null;

  const pluralize = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const describeWait = hours => (hours >= 48 ? `${Math.floor(hours / 24)}d` : `${Math.max(1, Math.round(hours))}h`);
  const describeAge = days => (days < 1 ? 'today' : `${Math.round(days)}d`);
  const describeLastSeen = days => (days === 0 ? 'today' : `${days}d ago`);
  const describeDate = day => new Date(day).toLocaleDateString('en-GB', { day:'numeric', month:'short' });
  const isFolded = (key, startsFolded, view) => !view.search && (view.folds[key] ?? startsFolded);
  const hasFailingChecks = pr => pr.checks === 'failure';
  const readRepo = pr => pr.url.split('/')[4];
  const readPrNumber = pr => pr.ref.slice(pr.ref.indexOf('#'));

  // Returns a ticket's gist as plain text, or nothing when the ticket body only repeats its own fields. The data cuts a gist off at a fixed length, so a gist that stops mid-sentence ends in dots.
  function describeGist(gist) {
    if (gist.startsWith('- Team:')) return '';
    const text = gist.replace(/^#+ /, '').replace(/[#*`]+/g, '').replace(/\s+/g, ' ').trim();
    return /[.!?:]$/.test(text) ? text : `${text}...`;
  }

  // Returns the group a pull request belongs to, by why it concerns the reader. A review with failing checks can only wait for them to pass, so it has a group of its own that starts folded.
  function pickPrGroup(pr) {
    if (pr.role === 'mention') return 'Mentions';
    if (pr.role === 'mine') return NEXT_STEP_HEADINGS[pr.next];
    return hasFailingChecks(pr) ? 'Checks failing' : 'Reviews';
  }

  // Returns the tickets that sit on the same initiative as a triage cluster, through their Tasks. They make Linear a second source of that cluster.
  const findRelatedTickets = (cluster, view) => (cluster.initiative ? view.entities.filter(entity => entity.kind === 'linear/issue' && view.tasks.get(entity.task)?.initiative === cluster.initiative) : []);

  // Returns the rows of a triage cluster's tray: its Sentry issues, then the Linear tickets it touches.
  function listClusterRows(cluster, view) {
    return [
      ...cluster.issues.map(issue => ({ mark:MARKS.sentry, title:issue.title, ref:issue.ref, state:issue.state, facts:[pluralize(issue.events, 'event'), pluralize(issue.users, 'user'), describeLastSeen(shell.days(issue.last))] })),
      ...findRelatedTickets(cluster, view).map(ticket => ({ mark:MARKS.linear, title:ticket.title, ref:ticket.ref, state:'', facts:['', '', ''] })),
    ];
  }

  // What a kind contributes. Slots are fixed and every one but `label`, `mark`, `material`, `pace` and `title` is optional.
  // A slot given as a string names a field of the entity, and a slot given as a function computes the value from the entity.
  // - mark, identifier, badge, age, ageIsLong, sources: the top row.
  // - material: the surface the card is drawn on: 'box', 'soft' or 'lacquer'.
  // - pace: the shelf the card sits on: 'fast', 'slow', or 'raised' for what triage raised.
  // - status: { shape, tone, words }, with shape 'pull-request', 'circle' or 'dot', and tone 'good', 'bad', 'attention', 'active' or 'quiet'.
  // - title, link, person: the title, the page it links to, and the person drawn with an avatar.
  // - facts: small facts, each { shape, value, words }. FACT_SHAPES holds the shapes. An empty value draws nothing and a list draws one fact per entry.
  // - note, noteLine: the words shown in a popover on hover.
  // - signals: where the signals come from. The `signals` field unless the kind says otherwise.
  // - rows, trayNote: the list a card opens in a tray under its row, for a kind with more to show than its signals.
  // - groupBy: { name, order, folded, compact }: the group of an entity, and how the groups of this kind are drawn.
  // - handTo: the workflows that fit. dismiss: { outcome, words }, for a kind that can be sent away. inQueue: whether the s key walks this card.
  const ENTITY_KINDS = {
    'triage/cluster': {
      label:'Triage', mark:{ isOwnLogo:true }, material:'lacquer', pace:'raised', title:'title',
      sources:(cluster, view) => [MARKS.sentry, ...(findRelatedTickets(cluster, view).length ? [MARKS.linear] : [])],
      signals:cluster => [{ label:TRIAGE_REASONS[cluster.id], at:cluster.last, open:true, outcome:'' }],
      facts:[
        { shape:'figure', value:'events', words:'event' },
        { shape:'figure', value:'users', words:'user' },
        { shape:'figure', value:cluster => cluster.issues.length, words:'issue', opensTray:true },
        { shape:'initiative', value:'initiative' },
        { shape:'text', value:cluster => describeLastSeen(shell.days(cluster.last)) },
      ],
      rows:listClusterRows, trayNote:'why',
      handTo:TRIAGE_WORKFLOWS, dismiss:{ outcome:'sent-back', words:'Back to Intake' },
    },
    'github/pull-request': {
      label:'Pull request', mark:MARKS.github, material:'box', pace:'fast',
      identifier:pr => [readRepo(pr), readPrNumber(pr)], title:'title', link:'url',
      age:pr => (pr.waitingHours ? describeWait(pr.waitingHours) : describeAge(pr.ageDays)), ageIsLong:pr => pr.waitingHours > LONG_WAIT_HOURS,
      status:{ shape:'pull-request', tone:'good', words:'Open' },
      // A PR of the reader's own shows no person, because the group already says whose it is.
      person:pr => (pr.role === 'mine' ? '' : pr.author),
      facts:[
        { shape:'again', value:'rereview', words:'Back for a re-review' },
        { shape:'changes', value:'changesBy', words:name => `${name} asked for changes` },
        { shape:'approved', value:'approvedBy', words:name => `${name} approved` },
        { shape:'passed', value:pr => pr.checks === 'success', words:'Checks passing' },
        { shape:'failed', value:hasFailingChecks, words:'Checks failing' },
      ],
      groupBy:{
        name:pickPrGroup, compact:['Mentions'], folded:['Checks failing', 'My PRs: Waiting for a review'],
        order:['Reviews', 'Checks failing', 'My PRs: Fix the checks', 'My PRs: Address requested changes', 'My PRs: Approved', 'My PRs: Waiting for a review', 'Mentions'],
      },
      handTo:pr => [REVIEW_WORKFLOW, ...(pr.role === 'mine' && hasFailingChecks(pr) ? [FAILED_CHECK_WORKFLOW] : [])],
      dismiss:pr => (pr.role === 'review' ? { outcome:'left', words:'Leave it (press l)' } : null),
      inQueue:pr => pr.role === 'review',
    },
    'linear/issue': {
      label:'Ticket', mark:MARKS.linear, material:'soft', pace:'slow',
      identifier:'ref', title:ticket => ticket.title.replace(/`/g, ''),
      status:{ shape:'circle', tone:ticket => LINEAR_STATE_TONES[ticket.state], words:ticket => ticket.state },
      facts:[
        { shape:'bars', value:ticket => PRIORITY_LEVELS[ticket.priority], words:(level, ticket) => ticket.priority },
        { shape:'tag', value:ticket => ticket.project || ticket.team },
      ],
      note:ticket => describeGist(ticket.gist), noteLine:ticket => [ticket.state, ticket.priority, ticket.team, `${describeAge(ticket.ageDays)} old`].join(' · '),
      groupBy:{ name:() => 'Tickets' }, handTo:TICKET_WORKFLOWS,
    },
    'gmail/thread': {
      label:'Email thread', mark:{ name:'Gmail', color:'#ea4335', path:'M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z' },
      material:'soft', pace:'slow', badge:'Sample', identifier:'state', title:'title', age:'age', person:'from_',
      status:{ shape:'dot', tone:'attention', words:thread => thread.state },
      facts:[{ shape:'text', value:thread => `Due ${thread.deadline}` }],
      groupBy:{ name:() => 'Mail' },
    },
  };

  // Returns the value of a slot for one entity: a string names a field, a function computes the value, and anything else is the value itself.
  function readSlot(slot, entity, view) {
    if (typeof slot === 'string') return entity[slot];
    return typeof slot === 'function' ? slot(entity, view) : slot;
  }

  // Returns every entity once, in the order the page draws them. A pull request can sit in several lists of the data, because the reader can both review
  // a PR and be mentioned on it. The first list keeps the card and the signals of the others join it, so a mention on a PR with a card lands in that card.
  function buildEntities() {
    const pullRequests = new Map();
    const lists = [['review', sortOldestFirst(INBOX.reviews, 'waitingHours')], ['mine', sortOldestFirst(INBOX.mine, 'ageDays')], ['mention', sortOldestFirst(INBOX.mentions, 'ageDays')]];
    for (const [role, list] of lists) {
      for (const pr of list) {
        const known = pullRequests.get(pr.url);
        if (known) known.signals = [...known.signals, ...pr.signals];
        else pullRequests.set(pr.url, { ...pr, kind:'github/pull-request', role });
      }
    }
    return [
      ...INBOX.raised.map(cluster => ({ ...cluster, kind:'triage/cluster' })),
      ...pullRequests.values(),
      ...sortOldestFirst(INBOX.tickets, 'ageDays').map(ticket => ({ ...ticket, kind:'linear/issue' })),
      ...INBOX.sample,
    ].filter(entity => ENTITY_KINDS[entity.kind]);
  }

  // Returns a card's signals, open ones first and the newest first within each. An act on the card answers its open signals, so they show as ended with what became of them.
  function listSignals(entity, kind, act, view) {
    const outcome = act?.kind === 'handed' ? `Handed to ${act.workflow}` : ACT_OUTCOMES[act?.kind];
    const signals = readSlot(kind.signals ?? 'signals', entity, view).map(signal => (act && signal.open ? { ...signal, open:false, outcome } : signal));
    return signals.sort((a, b) => b.open - a.open || b.at.localeCompare(a.at));
  }

  // Returns the words Find looks in for one card.
  function collectFindWords(entity, kind, view) {
    const slots = [kind.identifier, kind.title, kind.person, kind.note].map(slot => readSlot(slot, entity, view));
    const rows = kind.rows ? kind.rows(entity, view).flatMap(row => [row.ref, row.title]) : [];
    return [...slots, kind.label, kind.groupBy?.name(entity), ...readSlot(kind.signals ?? 'signals', entity, view).map(signal => signal.label), ...rows].flat().join(' ').toLowerCase();
  }

  // Returns a hue computed from a name, so that one person keeps one colour on every card. The hue is one of twelve steps round the wheel, because
  // a free hue often lands close to the last one and people then look alike.
  const computeHue = name => ([...name].reduce((hash, letter) => Math.imul(hash ^ letter.charCodeAt(0), 16777619), 2166136261) >>> 0) % 12 * 30;

  // Returns two letters for a person: the first letters of the first two parts of the name, or its first two letters when it is one word.
  function readInitials(name) {
    const parts = name.split(/[\s_-]|(?<=[a-z])(?=[A-Z])/).filter(Boolean);
    return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase();
  }

  const renderOcticon = (name, className = '') => `<svg class="ib-octicon ${className}" viewBox="0 0 16 16" aria-hidden="true"><path d="${OCTICON_PATHS[name]}"/></svg>`;
  const renderLogoMark = () => `<svg class="ib-logo" viewBox="0 0 32 32" aria-hidden="true"><path class="ib-logo-head" d="${LOGO_HEAD}"/><g class="ib-logo-face"><circle cx="12.4" cy="14.6" r="1.55"/><circle cx="19.6" cy="14.6" r="1.55"/><path d="${LOGO_MOUSTACHE}"/></g></svg>`;
  const renderMark = mark => (mark.isOwnLogo ? renderLogoMark() : `<svg class="ib-mark" style="color:${mark.color}" viewBox="0 0 24 24" aria-hidden="true"><path d="${mark.path}"/></svg>`);
  const renderAvatar = (name, view) => `<span class="ib-avatar" style="--hue:${computeHue(name)}" title="${view.esc(name)}">${view.esc(readInitials(name))}</span>`;
  // Draws a small status mark. The mark stands in for a word, so the word stays reachable as a tooltip and for screen readers.
  const renderWordlessMark = (words, mark, view) => `<span class="ib-wordless" role="img" title="${view.esc(words)}" aria-label="${view.esc(words)}">${mark}</span>`;
  const renderUndoButton = id => `<button data-do="undo" data-target="${id}">Undo</button>`;

  // The status shapes a kind can pick from, each drawn in the tone the kind gives it.
  const STATUS_SHAPES = {
    'pull-request':tone => renderOcticon('pullRequest', `ib-tone-${tone}`),
    circle:tone => `<svg class="ib-circle" viewBox="0 0 14 14" aria-hidden="true">${{
      attention:'<circle cx="7" cy="7" r="7" fill="#fc7840"/><path d="M3.8 5.2h6.4M8.6 3.6l1.6 1.6-1.6 1.6M10.2 8.8H3.8M5.4 7.2 3.8 8.8l1.6 1.6" fill="none" stroke="#fff" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>',
      quiet:'<circle cx="7" cy="7" r="6" fill="none" stroke="var(--ln-todo)" stroke-width="1.75"/>',
      active:'<circle cx="7" cy="7" r="6" fill="none" stroke="#f2c94c" stroke-width="1.75"/><path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="#f2c94c"/>',
    }[tone]}</svg>`,
    dot:tone => `<i class="ib-dot ib-tone-${tone}"></i>`,
  };

  // Draws an entity's status, or nothing for a kind that declares none.
  function renderStatus(entity, kind, view) {
    if (!kind.status) return '';
    const { shape, tone, words } = kind.status;
    return renderWordlessMark(readWords(words, entity), STATUS_SHAPES[shape](readWords(tone, entity)), view);
  }

  // Returns a tone or words given as a literal, or computes them with the function given in their place.
  const readWords = (words, ...values) => (typeof words === 'function' ? words(...values) : words);

  // Draws Linear's priority mark: three rising bars with as many lit as the priority is high, or three flat dashes for no priority.
  function renderBars(level) {
    const bars = level
      ? [[1.5, 8, 6], [6.5, 5, 9], [11.5, 2, 12]].map(([x, y, height], at) => `<rect x="${x}" y="${y}" width="3" height="${height}" rx="1" opacity="${at < level ? 1 : 0.28}"/>`).join('')
      : [1.5, 6.5, 11.5].map(x => `<rect x="${x}" y="7.25" width="3" height="1.5" rx=".6" opacity=".55"/>`).join('');
    return `<svg class="ib-bars" viewBox="0 0 16 16" aria-hidden="true">${bars}</svg>`;
  }

  // The fact shapes a kind can pick from. Each takes the fact's value, the fact itself, the entity and the view.
  const renderIconFact = (icon, tone) => (value, fact, entity, view) => renderWordlessMark(readWords(fact.words, value, entity), renderOcticon(icon, `ib-tone-${tone}`), view);
  const FACT_SHAPES = {
    passed:renderIconFact('checkCircle', 'good'),
    failed:renderIconFact('xCircle', 'bad'),
    again:renderIconFact('sync', 'attention'),
    changes:renderIconFact('fileDiff', 'bad'),
    approved:(name, fact, entity, view) => renderWordlessMark(readWords(fact.words, name, entity), `<span class="ib-approval">${renderAvatar(name, view)}${renderOcticon('check')}</span>`, view),
    bars:(level, fact, entity, view) => `<span class="ib-chip">${renderWordlessMark(readWords(fact.words, level, entity), renderBars(level), view)}</span>`,
    tag:(value, fact, entity, view) => `<span class="ib-chip ib-tag" title="${view.esc(value)}"><i></i>${view.esc(value)}</span>`,
    figure:(value, fact, entity, view) => `<span class="ib-figure"><b>${value.toLocaleString('en-GB')}</b>${value === 1 ? fact.words : `${fact.words}s`}${fact.opensTray ? '<i class="ib-chevron"></i>' : ''}</span>`,
    text:(value, fact, entity, view) => `<span class="ib-fact-text">${view.esc(value)}</span>`,
    initiative:(id, fact, entity, view) => {
      const { name } = INITIATIVES.find(initiative => initiative.id === id);
      return `<button class="ib-initiative" data-init="${view.esc(id)}" title="Initiative: ${view.esc(name)}" aria-label="Initiative: ${view.esc(name)}" tabindex="-1" style="background:${view.api.color(id, 58, 55)}"></button>`;
    },
  };

  function renderFacts(entity, kind, view) {
    return (kind.facts ?? []).flatMap(fact => {
      const value = readSlot(fact.value, entity, view);
      if (value === undefined || value === false || value === '') return [];
      return [value].flat().map(one => FACT_SHAPES[fact.shape](one, fact, entity, view));
    }).join('');
  }

  // Returns true when an act left a Task behind. Handing off and taking on do. Leaving a card alone or sending it back does not.
  const createsTask = act => act?.kind === 'handed' || act?.kind === 'taken';

  // Draws the quiet mark that says a Task exists for this card. A real Task opens on click. A Task from an act here is simulated, so there is nothing to open.
  function renderTaskMark(taskId, act, view) {
    const { esc } = view, task = view.tasks.get(taskId);
    if (task) return `<button class="ib-has-task" data-id="${esc(task.id)}" title="Has a Task: ${esc(task.name)}" aria-label="Has a Task: ${esc(task.name)}" tabindex="-1">${renderLogoMark()}<span>Has a Task</span></button>`;
    return createsTask(act) ? `<span class="ib-has-task" title="Has a Task. Simulated: no Task was created.">${renderLogoMark()}<span>Has a Task</span></span>` : '';
  }

  // Draws the reason a card is here: its most recent open signal, with a quiet count of the others. A card with an act shows what became of it instead,
  // and a card with nothing open draws no line at all.
  function renderReason(signals, act, view) {
    const { esc } = view;
    if (act?.kind === 'handed') return `<p class="ib-reason" title="${esc(act.workflow)} is running. Simulated: nothing was started."><i class="ib-spinner" role="img" aria-label="Running"></i><span>${esc(act.workflow)}</span></p>`;
    if (act?.kind === 'left') return '<p class="ib-reason"><span>Left</span></p>';
    const [newest] = signals;
    if (!newest?.open) return '';
    return `<p class="ib-reason"><i class="ib-signal-dot"></i><span>${esc(newest.label)}</span>${signals.length > 1 ? `<em>+${signals.length - 1}</em>` : ''}</p>`;
  }

  // Draws every signal of an opened card, open ones first and ended ones muted. An ended signal also says what became of it.
  function renderSignalList(signals, view) {
    const { esc } = view;
    return `<ol class="ib-signals">${signals.map(signal => `<li class="${signal.open ? 'is-open' : ''}"><i class="ib-signal-dot"></i><span>${esc(signal.label)}</span><time>${describeDate(signal.at)}</time>${signal.outcome ? `<small title="${esc(signal.outcome)}">${esc(signal.outcome)}</small>` : ''}</li>`).join('')}</ol>`;
  }

  function renderHandOffMenu(id, workflows, view) {
    const { esc } = view, isOpen = openMenu === id;
    const entries = workflows.map(workflow => `<button role="menuitem" data-do="hand-off" data-workflow="${esc(workflow)}">${esc(workflow)}</button>`).join('');
    return `<div class="ib-menu-anchor"><button class="ib-primary" data-do="toggle-menu" aria-haspopup="menu" aria-expanded="${isOpen}">Hand to an agent<i class="ib-chevron"></i></button>${isOpen ? `<div class="ib-menu" role="menu">${entries}</div>` : ''}</div>`;
  }

  // Draws what a card offers on hover or focus: the workflows that fit it, one plain choice that starts no run, and a way to dismiss it where the kind has one.
  // One workflow is a single click and several are a small menu. A card already acted on offers only Undo.
  function renderCardOffer(entity, kind, view) {
    const { esc } = view, workflows = readSlot(kind.handTo, entity, view) ?? [], dismiss = readSlot(kind.dismiss, entity, view);
    if (view.acts[entity.id]) return `<div class="ib-act" data-do="nothing">${renderUndoButton(entity.id)}</div>`;
    const handOff = workflows.length === 1
      ? `<button class="ib-primary" data-do="hand-off" data-workflow="${esc(workflows[0])}" title="Hand to an agent: ${esc(workflows[0])}">${esc(workflows[0])}<kbd class="ib-key">s</kbd></button>`
      : workflows.length ? renderHandOffMenu(entity.id, workflows, view) : '';
    return `<div class="ib-act" data-do="nothing">${handOff}${view.tasks.has(entity.task) ? '' : '<button data-do="take-on" title="Creates a Task with no run">Take it on myself</button>'}
      ${dismiss ? `<button class="ib-dismiss" data-do="dismiss" data-outcome="${esc(dismiss.outcome)}" title="${esc(dismiss.words)}" aria-label="${esc(dismiss.words)}">${renderOcticon('x')}</button>` : ''}</div>`;
  }

  // Draws one entity. This is the only card in the page: every kind goes through it, and only the table and the material differ.
  function renderCard(entity, view) {
    const { esc } = view, kind = ENTITY_KINDS[entity.kind], act = view.acts[entity.id], isOpen = view.openCard === entity.id;
    const signals = listSignals(entity, kind, act, view), title = readSlot(kind.title, entity, view), link = readSlot(kind.link, entity, view);
    const person = readSlot(kind.person, entity, view), note = readSlot(kind.note, entity, view), noteLine = readSlot(kind.noteLine, entity, view);
    const [identifier, ...identifierRest] = [readSlot(kind.identifier, entity, view)].flat();
    const age = readSlot(kind.age, entity, view), sources = readSlot(kind.sources, entity, view);
    if (kind.inQueue?.(entity) && !entity.task && !act) reviewQueue.push(entity.id);
    const classes = [`is-${kind.material}`, isOpen ? 'is-open' : '', act ? 'is-done' : '', !act && !signals[0]?.open ? 'is-quiet' : '', openMenu === entity.id ? 'has-menu' : ''].join(' ');
    return `<article class="ib-card ${classes}" data-line="${esc(entity.id)}" data-do="toggle-open">
      <button class="ib-opener" data-focus aria-expanded="${isOpen}" aria-label="${esc(`${kind.label}: ${title}. Show its signals.`)}" tabindex="-1"></button>
      <div class="ib-top">${renderMark(kind.mark)}${identifier ? `<span class="ib-identifier"><b>${esc(identifier)}</b>${identifierRest.map(part => `<span>${esc(part)}</span>`).join('')}</span>` : ''}
        ${kind.badge ? `<span class="ib-badge">${esc(kind.badge)}</span>` : ''}
        <span class="ib-top-side">${renderTaskMark(entity.task, act, view)}${age ? `<span class="ib-age ${readSlot(kind.ageIsLong, entity, view) ? 'is-long' : ''}">${esc(age)}</span>` : ''}${sources ? renderSources(sources) : ''}</span></div>
      <div class="ib-body">${renderStatus(entity, kind, view)}${link ? `<a class="ib-title" href="${esc(link)}" title="${esc(title)}" target="_blank" rel="noreferrer" tabindex="-1">${esc(title)}</a>` : `<span class="ib-title" title="${esc(title)}">${esc(title)}</span>`}</div>
      ${isOpen && !kind.rows ? renderSignalList(signals, view) : renderReason(signals, act, view)}
      <div class="ib-foot">${person ? `${renderAvatar(person, view)}<span class="ib-person">${esc(person)}</span>` : ''}<span class="ib-facts">${renderFacts(entity, kind, view)}</span></div>
      ${note || noteLine ? `<div class="ib-popover" role="tooltip">${note ? `<p>${esc(note)}</p>` : ''}${noteLine ? `<small>${esc(noteLine)}</small>` : ''}</div>` : ''}
      ${renderCardOffer(entity, kind, view)}
    </article>${isOpen && kind.rows ? renderTray(entity, kind, view) : ''}`;
  }

  // Draws the logos of the sources an entity combines, as an overlapping row, so that one source and several read the same way.
  function renderSources(sources) {
    return `<span class="ib-sources" role="img" aria-label="From ${sources.map(source => source.name).join(' and ')}">${sources.map(source => `<span class="ib-source" title="${source.name}">${renderMark(source)}</span>`).join('')}</span>`;
  }

  // Draws the tray of an opened card, for a kind with a list too wide for the card. It sits right after that card, so it opens under the card's own row at any width.
  function renderTray(entity, kind, view) {
    const { esc } = view, trayNote = readSlot(kind.trayNote, entity, view);
    const rows = kind.rows(entity, view).map(row => `<div class="ib-row">${renderMark(row.mark)}<span class="ib-row-title" title="${esc(row.title)}">${esc(row.title)}</span><span class="ib-row-ref">${esc(row.ref)}</span><span class="ib-row-state">${esc(row.state)}</span>${row.facts.map(fact => `<span>${esc(fact)}</span>`).join('')}</div>`).join('');
    return `<div class="ib-tray">${trayNote ? `<p class="ib-tray-note">${esc(trayNote)}</p>` : ''}${rows}</div>`;
  }

  // Draws a pile of cards that folds what it stands for. It sits in the grid like a card, so a folded group costs one cell and no extra line.
  // It shows one status mark per folded card, so that the size of the pile reads without the number.
  function renderPile({ key, kind, entities, text, note, folded, taskId }, view) {
    const { esc } = view, fold = view.search ? 'disabled' : `data-fold="${esc(key)}" aria-expanded="${!folded}"`;
    return `<div class="ib-pile-cell is-${kind.material}"><button class="ib-pile" data-line="${esc(key)}" ${fold} tabindex="-1">
      <span class="ib-top">${renderMark(kind.mark)}<span class="ib-pile-text" title="${esc(text)}">${esc(text)}</span></span>
      <span class="ib-pile-body"><i class="ib-chevron"></i><b>${entities.length}</b><em>${esc(note)}</em><span class="ib-pile-marks">${entities.map(entity => renderStatus(entity, kind, view)).join('')}</span></span>
    </button>${taskId ? renderTaskMark(taskId, null, view) : ''}</div>`;
  }

  // Draws a run of cards, folding those that share a Task into one pile at the place of the oldest of them.
  function renderCards(entities, view) {
    const carriers = entities.map(entity => entity.task).filter(id => view.tasks.has(id));
    const sharedTasks = new Set(carriers.filter(id => carriers.filter(other => other === id).length >= SHARED_TASK_MINIMUM));
    const drawn = new Set();
    return entities.map(entity => {
      if (!sharedTasks.has(entity.task)) return renderCard(entity, view);
      if (drawn.has(entity.task)) return '';
      drawn.add(entity.task);
      const shared = entities.filter(other => other.task === entity.task), key = `task:${entity.task}`, folded = isFolded(key, true, view);
      const pile = renderPile({ key, kind:ENTITY_KINDS[entity.kind], entities:shared, text:view.tasks.get(entity.task).name, note:'', folded, taskId:entity.task }, view);
      return pile + (folded ? '' : shared.map(other => renderCard(other, view)).join(''));
    }).join('');
  }

  // Returns the groups of one shelf: kinds in the order of the table, and groups in the order the kind declares, or as they first occur.
  function buildGroups(entities) {
    return Object.entries(ENTITY_KINDS).flatMap(([kindName, kind]) => {
      const ofKind = entities.filter(entity => entity.kind === kindName), groupBy = kind.groupBy;
      if (!groupBy) return ofKind.length ? [{ name:'', kind, entities:ofKind }] : [];
      return [...new Set([...(groupBy.order ?? []), ...ofKind.map(groupBy.name)])].map(name => ({
        name, kind, entities:ofKind.filter(entity => groupBy.name(entity) === name),
        startsFolded:groupBy.folded?.includes(name), isCompact:groupBy.compact?.includes(name),
      })).filter(group => group.entities.length);
    });
  }

  // Draws the cards of a group, or the pile that stands for them when the group folds.
  function renderGroupCells(group, view) {
    if (!group.startsFolded) return renderCards(group.entities, view);
    const key = `group:${group.name}`, folded = isFolded(key, true, view), oldest = readSlot(group.kind.age, group.entities[0], view);
    const pile = renderPile({ key, kind:group.kind, entities:group.entities, text:group.name, note:oldest ? `oldest ${oldest}` : '', folded }, view);
    return pile + (folded ? '' : renderCards(group.entities, view));
  }

  // Draws the groups of a shelf. A folding group has no heading of its own: its pile joins the grid of the group before it, where the row often has a free cell.
  function renderGroups(groups, view) {
    const sections = [];
    for (const group of groups) {
      const cells = renderGroupCells(group, view);
      if (group.startsFolded && sections.length) sections[sections.length - 1].cells += cells;
      else sections.push({ ...group, cells });
    }
    return sections.map(({ name, entities, isCompact, cells }) => `${name ? `<h3 class="ib-group">${view.esc(name)}<span>${entities.length}</span></h3>` : ''}<div class="ib-grid ${isCompact ? 'is-compact' : ''}">${cells}</div>`).join('');
  }

  // Draws the quiet line on the Triage shelf. A cluster sent back leaves the shelf and joins this line, where it can be undone.
  function renderIntakeNote(view) {
    const sentBack = INBOX.raised.filter(cluster => view.acts[cluster.id]?.kind === 'sent-back');
    const inIntake = INBOX.intakeLeft + sentBack.reduce((sum, cluster) => sum + cluster.issues.length, 0);
    return `${inIntake} of ${INBOX.sentryTotal} Sentry issues stay in Intake${sentBack.map(cluster => `<span>, including ${view.esc(cluster.title)} ${renderUndoButton(cluster.id)}</span>`).join('')}`;
  }

  const SHELVES = [
    { pace:'raised', heading:'Triage', badge:'Simulated', badgeWords:'No triage agent ran. These clusters are invented, like everything else here, to show what triage might raise.', renderNote:renderIntakeNote },
    { pace:'fast', heading:'Fast' },
    { pace:'slow', heading:'Slow' },
  ];

  function renderShelf({ pace, heading, badge, badgeWords, renderNote }, view) {
    const entities = view.entities.filter(entity => {
      const kind = ENTITY_KINDS[entity.kind];
      return kind.pace === pace && view.acts[entity.id]?.kind !== 'sent-back' && (!view.search || collectFindWords(entity, kind, view).includes(view.search));
    });
    if (!entities.length && (view.search || !renderNote)) return '';
    return `<section class="ib-shelf">
      <header class="ib-shelf-head"><h2>${view.esc(heading)}</h2>${badge ? `<span class="ib-badge" title="${view.esc(badgeWords)}">${view.esc(badge)}</span>` : ''}${renderNote ? `<p class="ib-shelf-note">${renderNote(view)}</p>` : ''}</header>
      ${renderGroups(buildGroups(entities), view)}
    </section>`;
  }

  // Draws the last action with its Undo. The bar fades by itself, and the u key and the card's own Undo keep working after that.
  function renderUndoBar(view) {
    const last = undoLog[undoLog.length - 1];
    return last ? `<div class="ib-undo-bar"><span>${view.esc(last.label)}</span><button data-do="undo-last">Undo</button><kbd class="ib-key">u</kbd></div>` : '';
  }

  // A pile is disabled during a search and cannot take focus, so it is not a stop for the highlight.
  const findLines = () => [...document.querySelectorAll('.v-items [data-line]:not([disabled])')];
  const findLine = key => findLines().find(line => line.dataset.line === key);
  const findFocusTarget = line => line.querySelector('[data-focus]') || line;

  // Returns the card straight above or below a line: the nearest card that way, favouring the closest row and then the closest column. Returns nothing at the edge of the page.
  function findLineInColumn(line, lines, direction) {
    const from = line.getBoundingClientRect(), centre = from.left + from.width / 2;
    const measureDistance = box => Math.abs(direction > 0 ? box.top - from.bottom : from.top - box.bottom) * 1000 + Math.abs(box.left + box.width / 2 - centre);
    return lines
      .map(other => ({ other, box:other.getBoundingClientRect() }))
      .filter(({ box }) => (direction > 0 ? box.top >= from.bottom : box.bottom <= from.top))
      .sort((a, b) => measureDistance(a.box) - measureDistance(b.box))[0]?.other;
  }

  // Returns the card the s key would act on: the highlighted one, or the first of the queue when nothing is highlighted.
  function pickNextReview() {
    if (!highlighted) return reviewQueue[0];
    return reviewQueue.includes(highlighted) ? highlighted : null;
  }

  // Puts the small "s" key beside the workflow it would start, so the keyboard path shows itself once the card's offer shows.
  function showNextReview() {
    document.querySelectorAll('.v-items .is-next').forEach(card => card.classList.remove('is-next'));
    findLine(pickNextReview())?.classList.add('is-next');
  }

  function moveHighlight(line) {
    if (!line) return;
    findFocusTarget(line).focus({ preventScroll:true });
    line.scrollIntoView({ block:'nearest' });
  }

  // Folds or unfolds a pile's group. The pile stays where it is on screen.
  function setFolded(line, folded) {
    const key = line.dataset.fold, top = line.getBoundingClientRect().top;
    shell.store('folds', { ...shell.load('folds', {}), [key]:folded });
    shell.rerender();
    scrollBy(0, findLine(key).getBoundingClientRect().top - top);
  }

  // Records what the reader did to one thing, and remembers it for the u key.
  function recordAct(id, act, label) {
    shell.store('cardActs', { ...shell.load('cardActs', {}), [id]:act });
    undoLog = [...undoLog, { id, label }];
    openMenu = null;
    shell.rerender();
  }

  function undoAct(id) {
    const { [id]:undone, ...acts } = shell.load('cardActs', {});
    shell.store('cardActs', acts);
    undoLog = undoLog.filter(entry => entry.id !== id);
    shell.rerender();
  }

  const findEntity = id => buildEntities().find(entity => entity.id === id);

  // Returns the short name of a card, for the Undo bar.
  function readCardName(id) {
    const entity = findEntity(id);
    return entity.ref ?? readSlot(ENTITY_KINDS[entity.kind].title, entity);
  }

  // Returns the workflow the s key hands a card to: the first that fits it.
  function pickFirstWorkflow(id) {
    const entity = findEntity(id);
    return readSlot(ENTITY_KINDS[entity.kind].handTo, entity)[0];
  }

  // Acts on a card. A card in the queue then hands the highlight to the next one, so that one key per card walks the whole queue.
  function actOnCard(id, act, label) {
    const at = reviewQueue.indexOf(id);
    if (at >= 0) highlighted = reviewQueue[at + 1] ?? null;
    recordAct(id, act, label);
    const next = at >= 0 && findLine(highlighted);
    if (next) moveHighlight(next);
  }

  const handOff = (id, workflow) => actOnCard(id, { kind:'handed', workflow }, `Handed ${readCardName(id)} to an agent`);
  const actWithOutcome = (id, kind) => actOnCard(id, { kind }, `${ACT_LABELS[kind]} ${readCardName(id)}`);

  // Opens the workflow menu of one card, or closes it when it is open already. An opened menu takes the focus, so the keyboard can walk it.
  function toggleMenu(id) {
    openMenu = openMenu === id ? null : id;
    shell.rerender();
    document.querySelector('.v-items .ib-menu button')?.focus({ preventScroll:true });
  }

  // Closes the open menu from the keyboard, and gives the focus back to the button that opened it. The offer is hidden until its card has focus,
  // and a hidden button cannot take focus, so the card takes it first.
  function closeMenu() {
    const line = findLine(openMenu);
    openMenu = null;
    shell.rerender();
    const redrawn = findLine(line.dataset.line);
    findFocusTarget(redrawn).focus({ preventScroll:true });
    redrawn.querySelector('[aria-haspopup]').focus({ preventScroll:true });
  }

  function runAction(button) {
    const action = button.dataset.do, id = button.closest('[data-line]')?.dataset.line;
    if (action === 'toggle-open') { shell.store('openCard', shell.load('openCard', '') === id ? '' : id); shell.rerender(); }
    if (action === 'toggle-menu') toggleMenu(id);
    if (action === 'hand-off') handOff(id, button.dataset.workflow);
    if (action === 'take-on') actWithOutcome(id, 'taken');
    if (action === 'dismiss') actWithOutcome(id, button.dataset.outcome);
    if (action === 'undo') undoAct(button.dataset.target);
    if (action === 'undo-last') undoAct(undoLog[undoLog.length - 1].id);
  }

  // Empties the Find box. The highlight comes back into view, now among all the cards around it.
  function clearFind(find) {
    find.value = '';
    find.dispatchEvent(new Event('input'));
    const line = findLine(highlighted);
    if (line) moveHighlight(line);
    else find.blur();
  }

  // Acts on a key pressed on a focused card. j and k, and left and right, walk the cards in reading order. Up and down move within the grid.
  // On a pile, right opens it and left closes it. The o key follows the card's link. Returns true when the key is used up, so the listener can stop it there.
  function handleLineKey(e, line) {
    const lines = findLines(), at = lines.indexOf(line), isOpen = line.getAttribute('aria-expanded') === 'true';
    switch (e.key) {
      case 'ArrowDown': moveHighlight(findLineInColumn(line, lines, 1)); return true;
      case 'ArrowUp': moveHighlight(findLineInColumn(line, lines, -1)); return true;
      case 'j': moveHighlight(lines[at + 1]); return true;
      case 'k': moveHighlight(lines[at - 1]); return true;
      case 'ArrowRight':
        if (line.dataset.fold && !isOpen) setFolded(line, false);
        else moveHighlight(lines[at + 1]);
        return true;
      case 'ArrowLeft':
        if (line.dataset.fold && isOpen) setFolded(line, true);
        else moveHighlight(lines[at - 1]);
        return true;
      case 'o':
        line.querySelector('a.ib-title')?.click();
        return true;
      default: return false;
    }
  }

  // The one key listener of this view. It listens on window in the capture phase, so it runs before the shell's listener on document.
  // Stopping a key here is what keeps left and right from switching views, and it happens only for keys used on a focused card.
  addEventListener('keydown', e => {
    if (document.body.dataset.view !== 'items' || e.ctrlKey || e.metaKey || e.altKey) return;
    const find = document.getElementById('find');
    if (e.target !== find && e.target.matches('input,textarea,select')) return;
    const line = e.target.closest('.v-items [data-line]');
    const stopKey = () => { e.preventDefault(); e.stopPropagation(); };

    if (e.key === 'Escape' && openMenu) { closeMenu(); return stopKey(); }
    const menu = e.target.closest('.v-items .ib-menu');
    if (menu && ['ArrowDown', 'ArrowUp', 'j', 'k'].includes(e.key)) {
      const entries = [...menu.querySelectorAll('button')], step = ['ArrowDown', 'j'].includes(e.key) ? 1 : -1;
      entries[(entries.indexOf(e.target) + step + entries.length) % entries.length].focus();
      return stopKey();
    }

    // The shell redraws on Escape. An open drawer closes first.
    if (e.key === 'Escape') {
      if (!document.getElementById('drawer').hidden) return;
      if (find.value) clearFind(find);
      else if (e.target === find) find.blur();
      else if (shell.load('openCard', '')) shell.store('openCard', '');
      else if (line) { highlighted = null; e.target.blur(); }
      return;
    }
    if (e.target === find) {
      if (e.key === 'ArrowDown') { moveHighlight(findLine(highlighted) || findLines()[0]); stopKey(); }
      return;
    }
    if (line && handleLineKey(e, line)) return stopKey();
    if (e.key === 's' || e.key === 'l') {
      const id = pickNextReview();
      if (id && e.key === 's') handOff(id, pickFirstWorkflow(id));
      if (id && e.key === 'l') actWithOutcome(id, 'left');
      return stopKey();
    }
    if (e.key === 'u') {
      if (undoLog.length) undoAct(undoLog[undoLog.length - 1].id);
      return stopKey();
    }
    if (['ArrowDown', 'ArrowUp', 'j', 'k'].includes(e.key)) { moveHighlight(findLine(highlighted) || findLines()[0]); return stopKey(); }
    if (e.key === '/') { find.focus(); return stopKey(); }
  }, true);

  // A click anywhere else leaves the cards, so that the shell's left and right view switching works again.
  addEventListener('pointerdown', e => {
    if (document.body.dataset.view !== 'items') return;
    if (openMenu && !e.target.closest('.v-items .ib-menu-anchor')) { openMenu = null; shell.rerender(); }
    if (e.target.closest('.v-items [data-line], .drawer')) return;
    highlighted = null;
    showNextReview();
  });

  Shell.register({ id:'items', label:'Inbox', render(el, api) {
    shell = api;
    const view = {
      api, esc:api.esc, search:document.getElementById('find').value.toLowerCase(),
      acts:api.load('cardActs', {}), folds:api.load('folds', {}), openCard:api.load('openCard', ''),
      tasks:new Map(api.pieces().map(w => [w.id, w])), entities:buildEntities(),
    };
    reviewQueue = [];
    const shelves = SHELVES.map(shelf => renderShelf(shelf, view)).join('');
    el.innerHTML = `<div class="v-items">
      ${shelves || '<p class="ib-empty">Nothing matches. Esc clears the search.</p>'}
      ${renderUndoBar(view)}
    </div>`;

    const root = el.firstElementChild, lines = findLines(), line = findLine(highlighted);
    root.style.setProperty('--ib-top', `${document.querySelector('.top').offsetHeight}px`);
    if (lines.length) findFocusTarget(line || lines[0]).tabIndex = 0;
    if (line && document.activeElement === document.body) findFocusTarget(line).focus({ preventScroll:true });
    showNextReview();

    root.addEventListener('focusin', e => {
      const focused = e.target.closest('[data-line]');
      if (focused) { highlighted = focused.dataset.line; showNextReview(); }
    });
    root.onclick = e => {
      // A card toggles open on any click, except on what has a click of its own: its link, its Task mark and its initiative.
      const target = e.target.closest('a, [data-id], [data-init], [data-do], [data-fold]');
      if (!target || target.matches('a, [data-id], [data-init]')) return;
      if (target.dataset.do) runAction(target);
      else setFolded(target, target.getAttribute('aria-expanded') === 'true');
    };
  }});
}
