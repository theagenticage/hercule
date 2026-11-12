// PROTOTYPE - what plugins declare, as plain data. Nothing in the views branches on a source or a kind:
// every word, shape, field, facet, saved query and block on the page comes from these tables.
// tools/check.mjs fails if a view file names a source.
window.Kinds = (function () {
  "use strict";

  // A source is a plugin's event source. `hue` is the mark's declared hue (an oklch angle), drawn at the
  // theme's --mark-l and --mark-c, so no plugin can be louder than a name. A source with no hue draws in ink.
  var SOURCES = {
    github: { name: "GitHub", mark: "github", hue: null, open: "Open on GitHub" },
    linear: { name: "Linear", mark: "linear", hue: 268, open: "Open in Linear" },
    sentry: { name: "Sentry", mark: "sentry", hue: 312, open: "Open in Sentry" },
    gmail: { name: "Gmail", mark: "gmail", hue: null, open: "Open in Gmail" },
    slack: { name: "Slack", mark: "slack", hue: 335, open: "Open in Slack" },
    quayside: { name: "Quayside", mark: "quayside", hue: 196, open: "Open in Quayside" },
  };

  // A kind's Card Face: `identifier`, `place` (the field shown at the row's end), `context` (a field a quiet
  // row says after its status) and `fact` (a number or amount it says there). The core fills the slots.
  // Status glyphs: a shape from the core's fixed set, and a tone. `source` draws in the source's hue,
  // `quiet` in faint ink, `good` and `bad` in the app's green and tomato. Nothing else is coloured.
  // Shapes: ring dashed quarter half most check cross fork draft join alert return hold dot
  var KINDS = {
    "github/pull-request": {
      source: "github", noun: "Pull request", plural: "Pull requests", lasting: 1,
      identifier: "#{number}", place: "repo",
      statuses: {
        draft: { word: "Draft", shape: "draft", tone: "quiet" },
        open: { word: "Open", shape: "fork", tone: "source" },
        failing: { word: "Checks failing", shape: "cross", tone: "bad" },
        changes: { word: "Changes requested", shape: "hold", tone: "source" },
        approved: { word: "Approved", shape: "check", tone: "good" },
        merged: { word: "Merged", shape: "join", tone: "source" },
      },
      fields: ["repo", "author", "checks", "review"],
    },
    "linear/issue": {
      source: "linear", noun: "Issue", plural: "Issues", lasting: 3,
      identifier: "{key}", place: "team", context: "project",
      statuses: {
        triage: { word: "Triage", shape: "dashed", tone: "source" },
        backlog: { word: "Backlog", shape: "dashed", tone: "quiet" },
        todo: { word: "Todo", shape: "ring", tone: "quiet" },
        started: { word: "In Progress", shape: "half", tone: "source" },
        review: { word: "In Review", shape: "most", tone: "source" },
        done: { word: "Done", shape: "check", tone: "source" },
      },
      fields: ["team", "project", "status", "priority", "assignee"],
    },
    "sentry/issue": {
      source: "sentry", noun: "Error", plural: "Errors", lasting: 2,
      identifier: "{key}", place: "project", fact: "events",
      statuses: {
        new: { word: "New", shape: "alert", tone: "source" },
        escalating: { word: "Escalating", shape: "alert", tone: "bad" },
        ongoing: { word: "Ongoing", shape: "alert", tone: "quiet" },
        regressed: { word: "Regressed", shape: "return", tone: "bad" },
        resolved: { word: "Resolved", shape: "check", tone: "good" },
      },
      fields: ["team", "project", "level", "events", "users"],
    },
    "gmail/thread": {
      source: "gmail", noun: "Email", plural: "Emails", lasting: 0,
      identifier: null, place: "label",
      statuses: {},
      fields: ["from", "label"],
    },
    "slack/thread": {
      source: "slack", noun: "Thread", plural: "Threads", lasting: 0,
      identifier: null, place: "channel",
      statuses: {},
      fields: ["channel", "from"],
    },
    "quayside/order": {
      source: "quayside", noun: "Purchase order", plural: "Purchase orders", lasting: 1,
      identifier: "{key}", place: "round", fact: "amount",
      statuses: {
        signoff: { word: "Sign-off", shape: "ring", tone: "source" },
        held: { word: "Held", shape: "hold", tone: "source" },
      },
      fields: ["round", "site", "amount"],
    },
  };

  // Fields a plugin declares, typed. `facet` marks the ones Browse lists and Narrow offers.
  // `token` is how the search bar spells it. A field may be declared by several kinds: one spelling.
  var FIELDS = {
    source: { label: "Source", token: "source", type: "text", core: 1 },
    kind: { label: "Kind", token: "kind", type: "text", core: 1 },
    from: { label: "From", token: "from", type: "person", core: 1 },
    waiting: { label: "Waiting", token: "waiting", type: "duration", core: 1 },
    account: { label: "Account", token: "account", type: "text", core: 1 },
    repo: { label: "Repository", plural: "Repositories", token: "repo", type: "text", facet: 1 },
    author: { label: "Author", token: "author", type: "person" },
    checks: { label: "Checks", plural: "Checks", token: "checks", type: "text", facet: 1 },
    review: { label: "Review", token: "review", type: "text" },
    team: { label: "Team", plural: "Teams", token: "team", type: "text", facet: 1 },
    project: { label: "Project", plural: "Projects", token: "project", type: "text", facet: 1 },
    status: { label: "Status", plural: "Statuses", token: "status", type: "text", facet: 1 },
    priority: { label: "Priority", token: "priority", type: "text" },
    assignee: { label: "Assignee", token: "assignee", type: "person" },
    level: { label: "Level", plural: "Levels", token: "level", type: "text", facet: 1 },
    events: { label: "Events", token: "events", type: "number" },
    users: { label: "Users", token: "users", type: "number" },
    label: { label: "Label", plural: "Labels", token: "label", type: "text", facet: 1 },
    channel: { label: "Channel", plural: "Channels", token: "channel", type: "text", facet: 1 },
    round: { label: "Delivery round", plural: "Delivery rounds", token: "round", type: "text", facet: 1 },
    site: { label: "Site", plural: "Sites", token: "site", type: "text", facet: 1 },
    amount: { label: "Amount", token: "amount", type: "money" },
  };

  // Browse: the facets each source lists, in the plugin's order. `known` lists values with nothing of
  // yours yet (every Linear project), and `health` names the field that holds a value's health.
  var BROWSE = {
    linear: [{ field: "project", known: "projects", health: 1 }, { field: "team" }, { field: "status" }],
    github: [{ field: "repo" }, { field: "checks" }],
    sentry: [{ field: "team" }, { field: "project" }, { field: "level" }],
    gmail: [{ field: "label" }],
    slack: [{ field: "channel" }],
    quayside: [{ field: "round" }, { field: "site" }],
  };

  // Saved queries: a name and a query over declared fields. The core's first, then the plugins'.
  // `order` is the saved query's own order; the list head says it. No user creates, renames or deletes one.
  var SAVED = [
    { id: "waits", name: "Someone waits on me", icon: "clock", q: { asks: 1, held: 0 }, order: "waiting", triage: 1 },
    { id: "mine", name: "Mine", icon: "user", q: { mine: 1 }, order: "newest" },
    { id: "updates", name: "Updates", icon: "eye", q: { asks: 0, held: 0 }, order: "newest" },
    { id: "hercule", name: "With Hercule", icon: "agent", q: { held: 1 }, order: "newest" },
    { id: "all", name: "Everything", icon: "intake", q: {}, order: "newest" },
    { id: "reviews", name: "Review requests", source: "github", q: { signal: "review", held: 0 }, order: "waiting" },
    { id: "errors", name: "Errors on me", source: "sentry", q: { kind: "sentry/issue", mine: 1 }, order: "waiting" },
  ];

  var ORDER_WORDS = { waiting: "Longest waiting first", newest: "Newest first" };

  // Signal kinds: the sentence a row says, what the section is called, and its answers (signal.act).
  // `primary` marks the one suggested answer. Done (signal.markDone) is added by the core to every section.
  var SIGNALS = {
    review: { noun: "review request", say: "{by} asked for your review", answers: [{ id: "approve", label: "Approve", primary: 1, desc: "Approves {ref} as you on {source}." }, { id: "changes", label: "Request changes…", field: 1, desc: "Asks {author} for changes, with your note." }, { id: "comment", label: "Comment…", field: 1, desc: "Posts your comment on {ref}." }], ends: "Review requested" },
    mention: { noun: "mention", say: "{by} mentioned you", answers: [{ id: "reply", label: "Reply…", field: 1, primary: 1, desc: "Replies to {by} on {ref}." }], ends: "Mentioned" },
    checks: { noun: "failing checks", say: "Checks failed on your pull request", answers: [{ id: "rerun", label: "Re-run failed checks", desc: "Runs the failed checks again on {source}." }], ends: "Checks failed" },
    asked: { noun: "question", say: "{by} asks you", answers: [{ id: "reply", label: "Reply…", field: 1, primary: 1, desc: "Replies to {by} from your account." }, { id: "archive", label: "Archive", desc: "Archives the thread in {source}." }], ends: "Asks you" },
    regressed: { noun: "regression", say: "Came back after it was resolved", answers: [{ id: "resolve", label: "Resolve", desc: "Marks it resolved in {source}." }, { id: "ignore", label: "Ignore for a day", desc: "Mutes it in {source} for 24 hours." }], ends: "Regressed" },
    assigned: { noun: "assignment", say: "{by} assigned it to you", answers: [], ends: "Assigned" },
    signoff: { noun: "sign-off request", say: "Waits for your sign-off", answers: [{ id: "sign", label: "Sign off", primary: 1, desc: "Signs off {ref} in {source}." }, { id: "hold", label: "Hold…", field: 1, desc: "Holds {ref} with your reason." }], ends: "Sign-off" },
    proposal: { say: "Proposal", answers: [], ends: "Proposal" },
    "link-suggestion": { say: "Belongs with", answers: [], ends: "Link suggestion" },
  };

  return { SOURCES: SOURCES, KINDS: KINDS, FIELDS: FIELDS, BROWSE: BROWSE, SAVED: SAVED, SIGNALS: SIGNALS, ORDER_WORDS: ORDER_WORDS };
})();
