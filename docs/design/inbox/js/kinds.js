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
      noun: 'Pull request',
      plugin: { name: 'GitHub', mark: 'github', hue: null, solid: true },
      paper: 'bond',
      density: 'open',
      pace: 'fast',
      patience: 24,
      stacks: { reviewRequested: 'review', mentioned: 'answer', opened: 'finish' },
      identifier: '#{number}',
      context: '{repo}',
      group: 'repo',
      person: 'author',
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
      noun: 'Issue',
      plugin: { name: 'Linear', mark: 'linear', hue: 277 },
      paper: 'ledger',
      density: 'tight',
      leadsWithIdentifier: true,
      pace: 'slow',
      patience: 336,
      stacks: { assigned: 'shelf', mentioned: 'shelf' },
      identifier: '{key}',
      context: '{team}',
      group: 'project',
      person: 'assignee',
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
      noun: 'Mail thread',
      plugin: { name: 'Gmail', mark: 'gmail', hue: 25 },
      paper: 'manila',
      density: 'open',
      pace: 'fast',
      patience: 48,
      stacks: { addressed: 'answer' },
      identifier: '{messages} messages',
      context: '{label}',
      group: 'label',
      person: 'from',
      status: null,
      facts: [{ field: 'deadline', form: 'date' }],
      reasons: {
        asked: { say: '{person} asks you to decide', tone: 'you' },
        replied: { say: '{person} replied', tone: 'plain' },
      },
      workflows: { addressed: [REPLY] },
    },

    'slack/thread': {
      noun: 'Slack thread',
      plugin: { name: 'Slack', mark: 'slack', hue: 330, solid: true },
      paper: 'bond',
      density: 'open',
      pace: 'fast',
      patience: 8,
      stacks: { mentioned: 'answer' },
      identifier: '{channel}',
      context: '{replies} replies',
      group: 'channel',
      person: 'from',
      status: null,
      facts: [],
      reasons: { mentioned: { say: '{person} tagged you', tone: 'plain' }, replied: { say: '{person} replied', tone: 'plain' } },
      workflows: { mentioned: [REPLY] },
    },

    'sentry/issue': {
      noun: 'Error',
      plugin: { name: 'Sentry', mark: 'sentry', hue: 300 },
      paper: 'bond',
      density: 'open',
      pace: 'fast',
      patience: 12,
      stacks: { assigned: 'finish' },
      identifier: '{key}',
      context: '{project}',
      group: 'project',
      person: null,
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
      noun: 'Purchase order',
      plugin: { name: 'Quayside', mark: 'quayside', hue: 205 },
      paper: 'sage',
      density: 'tight',
      leadsWithIdentifier: true,
      pace: 'slow',
      patience: 120,
      stacks: { signOff: 'shelf' },
      identifier: '{key}',
      context: '{supplier}',
      group: 'site',
      person: null,
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
      stacks: {},
      identifier: '',
      context: '',
      group: null,
      person: null,
      status: null,
      facts: [],
      reasons: {},
      workflows: { noticed: [INVESTIGATE, SECOND] },
    },
  };

  // A mark an invented plugin declares: four bollard-and-rope strokes on the 24-unit brand grid.
  window.CREW_BRANDS.quayside = 'M2 15.5C5 15.5 5 18 8 18s3-2.5 6-2.5 3 2.5 6 2.5c.8 0 1.4-.2 2-.4V21c-.6.2-1.2.4-2 .4-3 0-3-2.5-6-2.5s-3 2.5-6 2.5-3-2.5-6-2.5v-3.4ZM7 3h10v2.6l-3.4 3v3.9H10.4V8.6L7 5.6V3Z';

  window.Kinds = { SHAPES: SHAPES, TONES: TONES, KINDS: KINDS };
})();
