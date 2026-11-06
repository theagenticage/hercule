// The table a plugin declares. A plugin never ships UI: everything the Inbox draws about a kind comes from
// these fields, and js/card.js has no branch on a kind's id. DESIGN.md explains each field.
(function () {
  // The fixed set of status shapes, on the app's 16-unit icon grid, 1.5 stroke, round caps.
  var ring = '<circle cx="8" cy="8" r="5.6"/>';
  var wedge = function (d) { return ring + '<path d="' + d + '" fill="currentColor" stroke="none"/>'; };
  var SHAPES = {
    ring: ring,
    dashed: '<circle cx="8" cy="8" r="5.6" stroke-dasharray="2.1 2.3"/>',
    quarter: wedge('M8 8V4.4A3.6 3.6 0 0 1 11.6 8Z'),
    half: wedge('M8 4.4a3.6 3.6 0 0 1 0 7.2Z'),
    most: wedge('M8 8V4.4a3.6 3.6 0 1 1-3.6 3.6Z'),
    fork: '<circle cx="4.5" cy="3.9" r="1.5"/><circle cx="4.5" cy="12.1" r="1.5"/><circle cx="11.5" cy="12.1" r="1.5"/><path d="M4.5 5.4v5.2M11.5 10.6V6.9a2.3 2.3 0 0 0-2.3-2.3H7.9"/><path d="M9.5 2.9 7.8 4.6l1.7 1.7"/>',
    join: '<circle cx="4.5" cy="3.9" r="1.5"/><circle cx="4.5" cy="12.1" r="1.5"/><circle cx="11.5" cy="8" r="1.5"/><path d="M4.5 5.4v5.2M4.5 5.4C5 7.2 7 8 10 8"/>',
    check: ring + '<path d="M5.4 8.2l1.8 1.8 3.4-3.7"/>',
    cross: ring + '<path d="M6 6l4 4M10 6l-4 4"/>',
    hold: ring + '<path d="M5.2 8h5.6"/>',
    alert: '<path d="M8 2.6 13.9 13H2.1Z"/><path d="M8 6.6v3"/><circle cx="8" cy="11.2" r=".55" fill="currentColor" stroke="none"/>',
  };

  // The fixed set of tones. Each maps to one reserved colour of the design system.
  var TONES = ['quiet', 'active', 'you', 'good', 'bad'];

  var AGENT_REVIEW = { name: 'Agent review', says: 'Writes a review for you to send.' };
  var REPAIR = { name: 'Repair the build', says: 'Finds why checks failed and pushes a fix.' };
  var DRAFT = { name: 'Draft a change', says: 'Opens a draft pull request.' };
  var SECOND = { name: 'Build it with a second opinion', says: 'Builds it, then another agent reviews it.' };
  var REPLY = { name: 'Draft a reply', says: 'Writes a reply for you to send.' };
  var INVESTIGATE = { name: 'Find the cause', says: 'Follows the error to the commit behind it.' };

  var KINDS = {
    'github/pull-request': {
      card: 'compact',
      noun: 'Pull request',
      plugin: { name: 'GitHub', mark: 'github', hue: null, solid: true },
      paper: 'bond',
      density: 'open',
      pace: 'fast',
      patience: 24,
      identifier: '#{number}',
      person: 'author',
      owner: 'author',
      home: 'github/repository',
      status: {
        passing: { shape: 'fork', tone: 'good', word: 'Open, checks passed', norm: true },
        running: { shape: 'fork', tone: 'quiet', word: 'Open, checks running' },
        failing: { shape: 'cross', tone: 'bad', word: 'Checks failed' },
        changes: { shape: 'hold', tone: 'you', word: 'Changes requested' },
        approved: { shape: 'check', tone: 'good', word: 'Approved' },
        draft: { shape: 'dashed', tone: 'quiet', word: 'Draft' },
        merged: { shape: 'join', tone: 'quiet', word: 'Merged' },
      },
      facts: [
        { field: 'diff', form: 'delta' },
        { field: 'files', form: 'count', unit: 'file' },
      ],
      reasons: {
        reviewRequested: { say: '{person} asked for your review', tone: 'plain' },
        reReview: { say: '{person} asked again', tone: 'plain' },
        changesRequested: { say: '{person} requested changes', tone: 'you' },
        checksFailed: { say: 'Checks failed', tone: 'bad' },
        checksPassed: { say: 'Checks passed', tone: 'plain' },
        mentioned: { say: '{person} mentioned you', tone: 'plain' },
        approved: { say: '{person} approved it', tone: 'good' },
        commented: { say: '{person} commented', tone: 'plain' },
        readyToMerge: { say: 'Approved, ready to merge', tone: 'good' },
        waiting: { say: 'With reviewers', tone: 'plain' },
        merged: { say: 'Merged by {person}', tone: 'plain' },
      },
      workflows: {
        reviewRequested: [AGENT_REVIEW],
        mentioned: [REPLY],
        opened: [REPAIR, SECOND],
      },
    },

    'linear/issue': {
      card: 'rich',
      noun: 'Issue',
      plugin: { name: 'Linear', mark: 'linear', hue: 277 },
      paper: 'ledger',
      density: 'tight',
      leadsWithIdentifier: true,
      pace: 'slow',
      patience: 336,
      identifier: '{key}',
      person: 'assignee',
      owner: 'assignee',
      home: 'linear/project',
      section: 'linear/milestone',
      status: {
        triage: { shape: 'dashed', tone: 'quiet', word: 'Triage', norm: true },
        backlog: { shape: 'dashed', tone: 'quiet', word: 'Backlog' },
        todo: { shape: 'ring', tone: 'quiet', word: 'Todo' },
        started: { shape: 'half', tone: 'active', word: 'In Progress' },
        review: { shape: 'most', tone: 'active', word: 'In Review' },
        done: { shape: 'check', tone: 'good', word: 'Done' },
      },
      facts: [
        { field: 'priority', form: 'bars' },
        { field: 'milestone', form: 'word' },
      ],
      reasons: {
        assigned: { say: 'Assigned to you', tone: 'plain' },
        mentioned: { say: '{person} mentioned you', tone: 'plain' },
        moved: { say: 'Moved to {value}', tone: 'plain' },
        commented: { say: '{person} commented', tone: 'plain' },
      },
      workflows: { assigned: [DRAFT, SECOND], mentioned: [DRAFT] },
    },

    'gmail/thread': {
      card: 'compact',
      noun: 'Mail thread',
      plugin: { name: 'Gmail', mark: 'gmail', hue: 25 },
      paper: 'manila',
      density: 'open',
      pace: 'fast',
      patience: 48,
      identifier: '{messages} messages',
      person: 'from',
      owner: null,
      home: 'gmail/label',
      status: null,
      facts: [{ field: 'deadline', form: 'date' }],
      reasons: {
        asked: { say: '{person} asks you to decide', tone: 'you' },
        replied: { say: '{person} replied', tone: 'plain' },
      },
      workflows: { addressed: [REPLY] },
    },

    'slack/thread': {
      card: 'compact',
      noun: 'Slack thread',
      plugin: { name: 'Slack', mark: 'slack', hue: 330, solid: true },
      paper: 'bond',
      density: 'open',
      pace: 'fast',
      patience: 8,
      identifier: '{channel}',
      person: 'from',
      owner: null,
      home: 'slack/channel',
      status: null,
      facts: [],
      reasons: { mentioned: { say: '{person} tagged you', tone: 'plain' }, replied: { say: '{person} replied', tone: 'plain' } },
      workflows: { mentioned: [REPLY] },
    },

    'sentry/issue': {
      card: 'rich',
      noun: 'Error',
      plugin: { name: 'Sentry', mark: 'sentry', hue: 300 },
      paper: 'bond',
      density: 'open',
      pace: 'fast',
      patience: 12,
      identifier: '{key}',
      person: null,
      owner: 'assignee',
      home: 'sentry/project',
      status: {
        unresolved: { shape: 'alert', tone: 'bad', word: 'Unresolved' },
        regressed: { shape: 'alert', tone: 'bad', word: 'Came back' },
        resolved: { shape: 'check', tone: 'quiet', word: 'Resolved' },
      },
      facts: [
        { field: 'events', form: 'count', unit: 'event' },
        { field: 'users', form: 'count', unit: 'shopper' },
      ],
      reasons: {
        assigned: { say: 'Assigned to you', tone: 'plain' },
        cameBack: { say: 'Came back after the fix', tone: 'bad' },
        spiked: { say: 'Tripled in the last hour', tone: 'bad' },
      },
      workflows: { assigned: [INVESTIGATE, REPAIR] },
    },

    // An invented plugin. It ships this table and a mark, and no code: its cards are drawn by the same renderer.
    'quayside/purchase-order': {
      card: 'rich',
      noun: 'Purchase order',
      plugin: { name: 'Quayside', mark: 'quayside', hue: 205 },
      paper: 'sage',
      density: 'tight',
      leadsWithIdentifier: true,
      pace: 'slow',
      patience: 120,
      identifier: '{key}',
      person: null,
      owner: 'assignee',
      home: 'quayside/round',
      status: {
        waiting: { shape: 'ring', tone: 'quiet', word: 'Waiting for your sign-off', norm: true },
        held: { shape: 'dashed', tone: 'quiet', word: 'Held at the quay' },
      },
      facts: [
        { field: 'amount', form: 'money' },
        { field: 'due', form: 'date' },
      ],
      reasons: { signOff: { say: 'Waiting for your sign-off', tone: 'plain' }, delayed: { say: 'Delivery moved to {value}', tone: 'plain' } },
      workflows: { signOff: [] },
    },

    // Hercule's own kind. It belongs to no plugin, because triage can combine sources.
    'hercule/cluster': {
      noun: 'Noticed',
      plugin: { name: 'Hercule', mark: 'hercule', hue: null },
      paper: 'bond',
      density: 'open',
      pace: 'noticed',
      patience: 0,
      identifier: '',
      person: null,
      owner: null,
      status: null,
      facts: [],
      reasons: {},
      workflows: { noticed: [INVESTIGATE, SECOND] },
    },
  };

  /**
   * Adds the kinds that give context: a repository, a project, a team. They are ordinary entities that nothing has made a card of.
   * A plugin declares them like any kind, so a new hierarchy needs a table and no new code.
   */
  function addContextKind(id, plugin, noun, status, reasons) {
    KINDS[id] = { noun: noun, plugin: plugin, paper: 'bond', density: 'open', pace: 'context', patience: 0, identifier: '', person: null, owner: null, status: status || null, facts: [], reasons: reasons || {}, workflows: {} };
  }
  var HEALTH = {
    onTrack: { shape: 'check', tone: 'good', word: 'On track' },
    atRisk: { shape: 'hold', tone: 'you', word: 'At risk' },
    offTrack: { shape: 'cross', tone: 'bad', word: 'Off track' },
  };
  var UPDATES = { update: { say: '{person} posted an update', tone: 'plain' }, target: { say: 'Target moved to {value}', tone: 'plain' }, health: { say: 'Marked {value}', tone: 'plain' } };
  addContextKind('github/repository', KINDS['github/pull-request'].plugin, 'Repository');
  addContextKind('linear/milestone', KINDS['linear/issue'].plugin, 'Milestone', null, UPDATES);
  addContextKind('linear/project', KINDS['linear/issue'].plugin, 'Project', HEALTH, UPDATES);
  addContextKind('linear/initiative', KINDS['linear/issue'].plugin, 'Initiative', HEALTH, UPDATES);
  addContextKind('linear/team', KINDS['linear/issue'].plugin, 'Team');
  addContextKind('gmail/label', KINDS['gmail/thread'].plugin, 'Label');
  addContextKind('slack/channel', KINDS['slack/thread'].plugin, 'Channel');
  addContextKind('sentry/project', KINDS['sentry/issue'].plugin, 'Project');
  addContextKind('quayside/round', KINDS['quayside/purchase-order'].plugin, 'Delivery round', { open: { shape: 'half', tone: 'active', word: 'Receiving' } }, { update: { say: 'Two pallets booked in', tone: 'plain' } });
  addContextKind('quayside/site', KINDS['quayside/purchase-order'].plugin, 'Site');

  // A mark an invented plugin declares: four bollard-and-rope strokes on the 24-unit brand grid.
  window.CREW_BRANDS.quayside = 'M2 15.5C5 15.5 5 18 8 18s3-2.5 6-2.5 3 2.5 6 2.5c.8 0 1.4-.2 2-.4V21c-.6.2-1.2.4-2 .4-3 0-3-2.5-6-2.5s-3 2.5-6 2.5-3-2.5-6-2.5v-3.4ZM7 3h10v2.6l-3.4 3v3.9H10.4V8.6L7 5.6V3Z';

  window.Kinds = { SHAPES: SHAPES, TONES: TONES, KINDS: KINDS };
})();
