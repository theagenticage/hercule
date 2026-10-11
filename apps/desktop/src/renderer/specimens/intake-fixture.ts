/**
 * The records of the Intake specimen (intake.tsx): Rogier's To do in the
 * Intake design (docs/design/intake-directions/asks/desktop/intake.html),
 * the same six asks as signals from the Sentry, GitHub, Linear and Slack
 * plugins, in the same order. `pnpm compare:bureau` compares the `review`
 * scene with the design's page, edited by intake-reference.ts to open the
 * same ask.
 *
 * Each scene opens Intake on one state. `node scripts/capture-intake.ts`
 * captures each scene in both themes:
 *
 * - `review`: Marta's review request open, with its change, her words, and
 *   Approve as the suggested answer;
 * - `changes`: Sanne's requested changes open, a thread of review comments
 *   with a typed reply as the suggested answer;
 * - `checks`: the failed checks open, with a check's log;
 * - `mention`: Jonas's question from Linear, with a block this app does not
 *   know;
 * - `resolved`: Marta's review request, already answered on GitHub when its
 *   pane opens, as a link to a resolved signal opens it. A signal resolved
 *   while its pane is open says "Resolved elsewhere" instead, which a still
 *   page cannot show; intake.integration.test.tsx covers it;
 * - `closed`: no signal selected, so the list has the full width;
 * - `empty`: nothing on To do;
 * - `snooze`: Marta's review request with its snooze menu open, as `H` opens it;
 * - `bulk`: three rows checked, with the bar's Done hovered: the row
 *   Done leaves alone fades, and the rows it takes get the accent rule;
 * - `toast`: Marta's review request marked done with `E`, and the toast
 *   that says so;
 * - `failed`: the same move failing, its error in the toast's place;
 * - `later`: the Later view, with Pieter's snoozed review request open;
 * - `done`: the Done view, with Sanne's approved review request open;
 * - `hover-now`: the pointer on the Sentry alert, a Now row, which shows
 *   Snooze, an empty place where Done would be, and Not urgent;
 * - `hover-signal`: the pointer on Jonas's question, a row with Snooze and
 *   Done;
 * - `hover-later`: the Later view, the pointer on Sanne's snoozed question,
 *   with Unsnooze and Done;
 * - `hover-done`: the Done view, the pointer on a row, which has no moves;
 * - `evening`: the snooze menu opened at 18:41, when This evening is past
 *   and disabled;
 * - `toast-bulk`: Marta's review request marked done, then the next row
 *   checked, so the toast stands above the bulk bar;
 * - `everything`: the Everything view, sixteen events newest first: the
 *   fifth row went on to a Task and a session as well, so its line ends in
 *   "+1", and one has no title, so its kind stands in for it;
 * - `everything-end`: the same list scrolled to its end, with the line that
 *   says no older event is left;
 * - `everything-pane`: the event that came to the most open, with every
 *   handling in the pane;
 * - `everything-search`: the search field holding "pieter", with the events
 *   it finds;
 * - `everything-filter`: the "What came of it" filter on Raised a signal;
 * - `everything-no-match`: a search that finds no event;
 * - `everything-empty`: no event received yet.
 *
 * Done also holds a signal a newer one replaced, from yesterday, so the
 * `done` and `hover-done` scenes show its "Replaced by a newer one" line.
 *
 * Every scene on To do shows the foot, because the Done list holds seven
 * signals cleared today, as the design does.
 */
import {
  HAND_TO_ACTION_PREFIX,
  type Event,
  type EventWithFacts,
  type PluginDetail,
  type PluginMark,
  type Signal,
  type SignalAction,
} from "@hercule/contract";
import type { FetchLike } from "@hercule/client-core";
import { stopSpecimenClockAt } from "./fixed-clock";
import { SPECIMEN_NOW, SPECIMEN_RECORDS } from "./sidebar-fixture";
import type { IntakeRecords, SidebarRecords } from "./shell-page";

/** Builds an installed, active plugin named `displayName`, with `mark` when it declares one. */
const buildPlugin = (id: string, displayName: string, mark?: PluginMark): PluginDetail => ({
  id,
  displayName,
  ...(mark !== undefined && { mark }),
  hostApi: 2,
  capabilities: [],
  enabled: true,
  status: { _tag: "active" },
  config: {},
  contributions: [],
  intake: { eventKinds: [], signalKinds: [] },
});

/**
 * The marks of Sentry, Linear and Slack, as their plugins would declare them:
 * the Bureau book's brands.js draws them on a 24-unit grid (Simple Icons,
 * CC0), so each path here is the book's scaled by 2/3 onto the 16-unit grid
 * a plugin's mark is drawn on. GitHub's is the one the GitHub plugin
 * declares, scaled the same way.
 */
const GITHUB_MARK: PluginMark = {
  paths: [
    "M8 .198c-4.42 0-8 3.582-8 8 0 3.535333 2.292 6.533333 5.47 7.59.4.075333.546667-.172.546667-.384667 0-.19-.006667-.693333-.01-1.36-2.225333.482667-2.694667-1.073333-2.694667-1.073333C2.948 12.046667 2.422 11.8 2.422 11.8c-.724667-.496.056-.486.056-.486 .803333.056 1.225333 .824 1.225333 .824 .713333 1.223333 1.872667 .87 2.33.665333.072-.517333.278-.87.506667-1.07-1.776667-.2-3.644-.888-3.644-3.953333 0-.873333.31-1.586667 .823333-2.146667-.09-.202-.36-1.015333.07-2.117333 0 0 .67-.214667 2.2 .82.64-.178 1.32-.266 2-.27 .68.004 1.36.092 2 .27 1.52-1.034667 2.19-.82 2.19-.82.43 1.102.16 1.915333.08 2.117333.51.56 .82 1.273333 .82 2.146667 0 3.073333-1.87 3.75-3.65 3.946667.28.24.54 .730667.54 1.48 0 1.070667-.01 1.930667-.01 2.190667 0 .21.14.46.55.38C13.71 14.728 16 11.728 16 8.198c0-4.418-3.582-8-8-8",
  ],
};
const SENTRY_MARK: PluginMark = {
  paths: [
    "M9.273333 1.67c-0.582 -0.965333 -1.981333 -0.965333 -2.562667 0L4.602667 5.28a10.318667 10.318667 0 0 1 5.686667 8.540667h-1.480667A8.867333 8.867333 0 0 0 3.856 6.542667l-1.950667 3.373333a5.1 5.1 0 0 1 2.956667 3.898667H1.462667a0.243333 0.243333 0 0 1 -0.198667 -0.356l0.942 -1.601333a3.44 3.44 0 0 0 -1.076 -0.608667L0.197333 12.85a1.454667 1.454667 0 0 0 0.541333 1.999333 1.493333 1.493333 0 0 0 0.724 0.192h4.655333a6.214667 6.214667 0 0 0 -2.563333 -5.545333l0.74 -1.281333a7.646667 7.646667 0 0 1 3.3 6.826667h3.943333a11.494667 11.494667 0 0 0 -5.256667 -10.186667l1.496 -2.563333a0.246667 0.246667 0 0 1 0.336 -0.086667c0.17 0.093333 6.5 11.138667 6.618667 11.266667a0.243333 0.243333 0 0 1 -0.218 0.362h-1.524667c0.019333 0.408 0.019333 0.815333 0 1.220667h1.531333a1.470667 1.470667 0 0 0 1.281333 -2.206667z",
  ],
};
const LINEAR_MARK: PluginMark = {
  paths: [
    "M1.924 2.786667A7.988 7.988 0 0 1 7.993333 0C12.416 0 16 3.584 16 8.006c0 2.426667 -1.08 4.602 -2.786667 6.07L1.924667 2.786667ZM1.211333 3.750667l11.037333 11.037333c-0.349333 0.22 -0.716667 0.413333 -1.1 0.577333L0.634 4.851333c0.164667 -0.383333 0.358 -0.750667 0.577333 -1.1ZM0.214667 6.108667l9.676667 9.676667c-0.473333 0.114667 -0.962 0.188 -1.463333 0.214667L0 7.572a8 8 0 0 1 0.214667 -1.463333Zm-0.113333 3.241333 6.548667 6.549333a8.013333 8.013333 0 0 1 -6.549333 -6.549333Z",
  ],
};
const SLACK_MARK: PluginMark = {
  paths: [
    "M3.361333 10.11a1.685333 1.685333 0 0 1 -1.68 1.682A1.685333 1.685333 0 0 1 0 10.11a1.684667 1.684667 0 0 1 1.681333 -1.68h1.68v1.68zM4.208667 10.11a1.684667 1.684667 0 0 1 1.680667 -1.68 1.684667 1.684667 0 0 1 1.680667 1.68v4.208667A1.685333 1.685333 0 0 1 5.889333 16a1.685333 1.685333 0 0 1 -1.680667 -1.681333v-4.208667zM5.889333 3.361333a1.685333 1.685333 0 0 1 -1.680667 -1.68A1.685333 1.685333 0 0 1 5.889333 0a1.685333 1.685333 0 0 1 1.680667 1.681333v1.68H5.889333zM5.889333 4.208667a1.685333 1.685333 0 0 1 1.680667 1.680667 1.685333 1.685333 0 0 1 -1.680667 1.680667H1.681333A1.685333 1.685333 0 0 1 0 5.889333a1.685333 1.685333 0 0 1 1.681333 -1.680667h4.208zM12.637333 5.889333a1.685333 1.685333 0 0 1 1.681333 -1.680667A1.685333 1.685333 0 0 1 16 5.889333a1.685333 1.685333 0 0 1 -1.681333 1.680667h-1.681333V5.889333zM11.792 5.889333a1.685333 1.685333 0 0 1 -1.682 1.680667 1.684667 1.684667 0 0 1 -1.68 -1.680667V1.681333A1.684667 1.684667 0 0 1 10.11 0a1.685333 1.685333 0 0 1 1.682 1.681333v4.208zM10.11 12.637333a1.685333 1.685333 0 0 1 1.682 1.681333A1.685333 1.685333 0 0 1 10.11 16a1.684667 1.684667 0 0 1 -1.68 -1.681333v-1.681333h1.68zM10.11 11.792a1.684667 1.684667 0 0 1 -1.68 -1.682 1.684 1.684 0 0 1 1.68 -1.68h4.208667A1.684667 1.684667 0 0 1 16 10.11a1.685333 1.685333 0 0 1 -1.681333 1.682h-4.208667z",
  ],
};

/** The installed plugins, which name each signal's source, in the design's order. */
const INTAKE_PLUGINS: ReadonlyArray<PluginDetail> = [
  buildPlugin("sentry", "Sentry", SENTRY_MARK),
  buildPlugin("github", "GitHub", GITHUB_MARK),
  buildPlugin("linear", "Linear", LINEAR_MARK),
  buildPlugin("slack", "Slack", SLACK_MARK),
];

/** The Connection each plugin's signals come through. */
const CONNECTION_IDS: Readonly<Record<string, string>> = {
  sentry: "01a0ec64-6e80-7000-8000-0000000000c1",
  github: "01a0ec64-6e80-7000-8000-0000000000c2",
  linear: "01a0ec64-6e80-7000-8000-0000000000c3",
  slack: "01a0ec64-6e80-7000-8000-0000000000c4",
};

/** Returns the moment `minutes` before the specimen's clock, as a timestamp. */
const minutesAgo = (minutes: number): string =>
  new Date(SPECIMEN_NOW - minutes * 60_000).toISOString();

/** Returns the Connection of the plugin that raises signals of `kind`. */
const findConnectionId = (kind: string): string => {
  const connectionId = CONNECTION_IDS[kind.slice(0, kind.indexOf("/"))];
  if (connectionId === undefined) throw new Error(`The fixture has no Connection for ${kind}.`);
  return connectionId;
};

/** Builds a signal numbered `number`, raised from event `number` `minutes` ago. */
const buildSignal = (
  number: number,
  minutes: number,
  signal: Pick<Signal, "kind" | "title"> & Partial<Signal>,
): Signal => ({
  id: `01a0ec64-7a00-7000-8000-${String(number).padStart(12, "0")}`,
  origin: {
    type: "event",
    eventId: number,
    connectionId: findConnectionId(signal.kind),
    threadRef: `thread-${String(number)}`,
  },
  priority: "normal",
  blocks: [],
  actions: [],
  match: {},
  status: "open",
  createdAt: minutesAgo(minutes),
  ...signal,
});

/**
 * Builds an answer that runs the plugin operation `op` through its plugin's
 * Connection. Its describe line reads `line`, where `**` marks a name, as
 * in "Approves **#1294**".
 */
const buildAction = (
  id: string,
  label: string,
  op: string,
  line: string,
  extra: Partial<SignalAction> = {},
): SignalAction => ({
  id,
  label,
  operation: { op, connectionId: findConnectionId(op), input: {} },
  describeLine: buildDescribeLine(line),
  ...extra,
});

/** Splits `line` at each `**`: every second part is a marked name. Empty parts are dropped. */
const buildDescribeLine = (line: string): NonNullable<SignalAction["describeLine"]> =>
  line
    .split("**")
    .map((text, index) => ({
      kind: index % 2 === 1 ? ("marked" as const) : ("text" as const),
      text,
    }))
    .filter((part) => part.text !== "");

/** The answer "Done", which takes a signal off the list on `system` too. */
const buildDone = (system: string): SignalAction => ({
  id: "done",
  label: "Done",
  operation: null,
  describeLine: [{ kind: "text", text: `Takes it off your list. ${system} is not told` }],
});

/**
 * The ids of the workflows the signals are handed to. A workflow's face is
 * built from its id, so each id was found by scripts/find-look-seeds.ts to
 * give the face the design draws for that workflow's name.
 */
const WORKFLOW_IDS = {
  "Address review": "01a0ec64-6e80-7000-8000-0000000000c3",
  "Review PR": "01a0ec64-6e80-7000-8000-0000000000f8",
  "Fix bug": "01a0ec64-6e80-7000-8000-0000000001a4",
} as const;

/** Starts a workflow on the signal: an answer that hands the work to an agent. */
const buildHandOff = (workflow: keyof typeof WORKFLOW_IDS, line: string): SignalAction => ({
  id: `${HAND_TO_ACTION_PREFIX}${WORKFLOW_IDS[workflow]}`,
  label: `Start "${workflow}"`,
  operation: { op: "run.start", input: { workflowId: WORKFLOW_IDS[workflow], inputs: {} } },
  describeLine: buildDescribeLine(line),
});

const SANNE = { name: "Sanne" };

/** Sentry's alert on checkout: urgent, so it heads the list under Now. */
const ALERT = buildSignal(1, 169, {
  kind: "sentry/alert-for-you",
  title: "Checkout fails for EU cards with 3-D Secure",
  priority: "urgent",
  asker: "Sentry",
  place: "webshop-prod",
  // The design draws Sentry's own blocks, which are types this app does not know.
  blocks: [{ type: "signal" }, { type: "note" }],
});

/** Sanne requested changes on Rogier's pull request. */
const CHANGES = buildSignal(2, 201, {
  kind: "github/changes-requested",
  title: "Move the promo banner to the CMS",
  asker: "Sanne",
  place: "webshop #1298",
  // Snoozed for an hour, and back on To do since then.
  snooze: { until: minutesAgo(140), snoozedAt: minutesAgo(200) },
  blocks: [
    {
      type: "messages",
      omitted: 0,
      messages: [
        {
          author: SANNE,
          at: minutesAgo(201),
          location: { path: "src/promo/banner.tsx", line: 42 },
          text: "This still reads the old flag. Read it from the CMS entry too, or the banner shows twice.",
        },
        {
          author: SANNE,
          at: minutesAgo(201),
          location: { path: "src/promo/cms.ts", line: 18 },
          text: "Cache this. It runs on every page view.",
        },
      ],
    },
  ],
  actions: [
    buildHandOff(
      "Address review",
      "Starts **Address review** on **webshop** with pull request **#1298** and its **2** review comments",
    ),
    buildAction(
      "reply",
      "Reply…",
      "github/review.reply",
      "Posts your reply to the review on **#1298** as **rogier**",
      { field: { name: "body", placeholder: "Reply to Sanne's review…" } },
    ),
    buildDone("GitHub"),
  ],
});

/** Marta asked Rogier to review her pull request. */
const REVIEW = buildSignal(3, 143, {
  kind: "github/review-requested",
  title: "Retry Stripe webhooks with backoff",
  asker: "Marta",
  place: "payments-api #1294",
  blocks: [
    {
      type: "change",
      from: "marta/webhook-backoff",
      to: "main",
      files: 6,
      additions: 142,
      deletions: 38,
      checks: { passed: 4, failed: 0, pending: 0 },
    },
    {
      type: "messages",
      omitted: 0,
      messages: [
        {
          author: { name: "Marta" },
          at: minutesAgo(143),
          text: "Stripe retries a failed webhook for three days, but we drop it after the first 500. This adds a queue with exponential backoff and a dead-letter table.",
        },
      ],
    },
  ],
  actions: [
    buildAction(
      "approve",
      "Approve",
      "github/pr.review",
      "Approves pull request **#1294** in **rogier/payments-api** as **rogier**",
      { primary: true },
    ),
    buildAction(
      "comment",
      "Comment…",
      "github/pr.review",
      "Posts your comment on **#1294** as **rogier**",
      {
        field: { name: "body", placeholder: "Comment on #1294…" },
      },
    ),
    buildHandOff(
      "Review PR",
      "Starts **Review PR** on **payments-api** with pull request **#1294**. You still approve it yourself",
    ),
    buildDone("GitHub"),
  ],
});

/** The checks failed on Rogier's pull request. */
const CHECKS = buildSignal(4, 80, {
  kind: "github/checks-failed",
  title: "Show VAT per line on invoices",
  asker: "GitHub Actions",
  place: "webshop #1300",
  blocks: [
    {
      type: "checks",
      rows: [
        {
          name: "test / invoices",
          state: "failed",
          log: "✕ invoice › rounds VAT per line\n  expected 2.10, received 2.09",
        },
      ],
      passed: 2,
      omitted: 0,
    },
  ],
  actions: [
    buildHandOff(
      "Fix bug",
      "Starts **Fix bug** on **webshop** with pull request **#1300** and the failing check **test / invoices**",
    ),
    buildAction(
      "rerun",
      "Re-run",
      "github/checks.rerun",
      "Re-runs **test / invoices** on **#1300**",
    ),
    buildDone("GitHub"),
  ],
});

/**
 * Jonas asked Rogier a question on a Linear issue; its fields block is a type
 * this app does not know. No Linear plugin exists yet, so its kind is named
 * the way the design labels it, "question for you".
 */
const MENTION = buildSignal(5, 40, {
  kind: "linear/question-for-you",
  title: "Refunds for partial captures",
  asker: "Jonas",
  place: "PAY-212",
  blocks: [
    {
      type: "text",
      markdown:
        "**@rogier** should a partial refund go back through Stripe first, or through our ledger first? I need it to settle the API shape before the cycle ends.",
    },
    { type: "fields" },
  ],
  actions: [
    buildAction(
      "reply",
      "Reply",
      "linear/comment.create",
      "Posts your comment on **PAY-212** as **Rogier**",
      {
        primary: true,
        field: { name: "body", placeholder: "Reply to Jonas on PAY-212…" },
      },
    ),
    buildDone("Linear"),
  ],
});

/**
 * Pieter tagged Rogier in a Slack thread. No Slack plugin exists yet, so its
 * kind is named the way the design labels it, "tagged in a thread".
 */
const SLACK = buildSignal(6, 12, {
  kind: "slack/tagged-in-a-thread",
  title: "Codes with a trailing space are rejected",
  asker: "Pieter",
  place: "#acceptance",
  actions: [
    buildAction(
      "reply",
      "Reply",
      "slack/thread.reply",
      "Posts your reply in the **#acceptance** thread as **@rogier**",
      { primary: true, field: { name: "body", placeholder: "Reply in the thread…" } },
    ),
    buildDone("Slack"),
  ],
});

/** The signals on To do, in the order the controller lists them: oldest first. */
const TO_DO: ReadonlyArray<Signal> = [ALERT, CHANGES, REVIEW, CHECKS, MENTION, SLACK];

/** Returns the moment at `clock`, `HH:MM` in UTC, `days` after the specimen's day. */
const atClock = (days: number, clock: string): string => {
  const [hours = 0, minutes = 0] = clock.split(":").map(Number);
  const day = new Date(SPECIMEN_NOW);
  return new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + days, hours, minutes),
  ).toISOString();
};

/** Pieter's review request, snoozed until this afternoon. */
const LAZY_IMAGES = buildSignal(7, 100, {
  kind: "github/review-requested",
  title: "Lazy-load product images",
  asker: "Pieter",
  place: "webshop #1296",
  snooze: { until: atClock(0, "14:00"), snoozedAt: minutesAgo(96) },
  blocks: [
    {
      type: "messages",
      omitted: 0,
      messages: [
        {
          author: { name: "Pieter" },
          at: minutesAgo(100),
          text: "Images below the fold now load when they scroll into view. The product page drops from 2.1 MB to 640 KB.",
        },
      ],
    },
  ],
  actions: [
    buildAction(
      "approve",
      "Approve",
      "github/pr.review",
      "Approves pull request **#1296** in **rogier/webshop** as **rogier**",
      { primary: true },
    ),
    buildDone("GitHub"),
  ],
});

/** Sanne's question on a Linear issue, snoozed until Monday morning. */
const VAT_COPY = buildSignal(8, 970, {
  kind: "linear/question-for-you",
  title: "Checkout copy for the VAT line",
  asker: "Sanne",
  place: "PAY-219",
  snooze: { until: atClock(6, "09:00"), snoozedAt: minutesAgo(958) },
  actions: [buildDone("Linear")],
});

/** The signals on Later, soonest snooze first, as the controller lists them. */
const LATER: ReadonlyArray<Signal> = [LAZY_IMAGES, VAT_COPY];

/**
 * Builds a signal resolved `resolvedMinutes` ago, with `outcome` as the line
 * the Done list shows. `actor` resolved it: the user by default, or a plugin
 * when the signal ended on its source.
 */
const buildResolved = (
  number: number,
  resolvedMinutes: number,
  outcome: string,
  signal: Pick<Signal, "kind" | "title"> & Partial<Signal>,
  { kind = "decided", actor = "user" }: { kind?: "decided" | "withdrawn"; actor?: string } = {},
): Signal =>
  buildSignal(number, resolvedMinutes + 20, {
    ...signal,
    status: "resolved",
    resolution: {
      kind,
      outcome,
      actor,
      origin: actor === "user" ? "web" : actor,
      at: minutesAgo(resolvedMinutes),
    },
  });

/**
 * The signals on Done, newest first: the seven the design clears today, then
 * one from yesterday, so the foot counts today's seven.
 */
const DONE: ReadonlyArray<Signal> = [
  buildResolved(9, 38, "Approved #1293", {
    kind: "github/review-requested",
    title: "Show stock per warehouse",
    asker: "Sanne",
    place: "webshop #1293",
  }),
  buildResolved(
    10,
    65,
    "Answered in Linear",
    {
      kind: "linear/question-for-you",
      title: "Currency for refunds in the ledger",
      asker: "Jonas",
      place: "PAY-209",
    },
    { actor: "plugin:linear" },
  ),
  buildResolved(11, 93, "Handed to Fix bug", {
    kind: "github/checks-failed",
    title: "Round cart totals once, at checkout",
    asker: "GitHub Actions",
    place: "webshop #1291",
  }),
  buildResolved(12, 109, "Replied in #releases", {
    kind: "slack/tagged-in-a-thread",
    title: "Is the acceptance deploy blocked?",
    asker: "Jonas",
    place: "#releases",
  }),
  buildResolved(
    13,
    135,
    "Reviewed on GitHub",
    {
      kind: "github/review-requested",
      title: "Remove the old promo flag",
      asker: "Sanne",
      place: "webshop #1282",
    },
    { actor: "plugin:github" },
  ),
  buildResolved(14, 160, "Done, nothing sent", {
    kind: "linear/assigned-to-you",
    title: "Write the weekly planning notes",
    asker: "Sanne",
    place: "PAY-200",
  }),
  buildResolved(
    15,
    185,
    "Pieter closed #1286 without merging it",
    {
      kind: "github/review-requested",
      title: "Try the new checkout copy",
      asker: "Pieter",
      place: "webshop #1286",
    },
    { kind: "withdrawn", actor: "plugin:github" },
  ),
  buildResolved(16, 1101, "Handed to Address review", {
    kind: "github/changes-requested",
    title: "Coupon field loses focus on mobile",
    asker: "Pieter",
    place: "webshop #1288",
  }),
  {
    ...buildResolved(
      17,
      1130,
      "Withdrawn",
      {
        kind: "github/review-requested",
        title: "Review the refund webhook",
        asker: "Marta",
        place: "payments-api #1290",
      },
      { kind: "withdrawn", actor: "plugin:github" },
    ),
    replacedBy: REVIEW.id,
  },
];

/** Builds the event a signal was raised from, whose address gives the pane its "Open on" link. */
const buildEvent = (signal: Signal, url: string): Event => {
  if (signal.origin.type !== "event")
    throw new Error(`${signal.title} was not raised from an event.`);
  const { eventId, connectionId } = signal.origin;
  const source = signal.kind.slice(0, signal.kind.indexOf("/"));
  return {
    id: eventId,
    source,
    connectionId,
    system: source,
    kind: `${source}.notification`,
    occurredAt: signal.createdAt,
    receivedAt: signal.createdAt,
    dedupKey: `${source}-${String(eventId)}`,
    refs: [],
    url,
    payload: {},
    raw: null,
    actor: null,
    title: signal.title,
    author: signal.asker ?? null,
  };
};

const TASK_ID = "01a0ec64-7b00-7000-8000-000000000001";
const SESSION_ID = "01a0ec64-7c00-7000-8000-000000000001";

/**
 * Builds the event `id`, received `minutes` ago, with no handling. `event`
 * gives what makes it differ: its source, kind, title and author, and the
 * facts of what came of it.
 */
const buildListedEvent = (
  id: number,
  minutes: number,
  event: Pick<Event, "source" | "kind" | "title" | "author"> & Partial<EventWithFacts>,
): EventWithFacts => ({
  id,
  connectionId: CONNECTION_IDS[event.source] ?? null,
  system: event.source,
  occurredAt: minutesAgo(minutes),
  receivedAt: minutesAgo(minutes),
  dedupKey: `${event.source}-${String(id)}`,
  refs: [],
  url: null,
  payload: {},
  raw: null,
  actor: null,
  signals: [],
  resolvedSignals: [],
  tasks: [],
  knownBy: [],
  ...event,
});

/** Returns the fact that `signal` was raised from an event. */
const raisedSignal = (signal: Signal): EventWithFacts["signals"][number] => ({
  signalId: signal.id,
  kind: signal.kind,
  status: signal.status,
  title: signal.title,
});

/** Returns the event `signal` was raised from, at `url`, with the fact that it raised `signal`. */
const buildSignalEvent = (signal: Signal, url: string): EventWithFacts => ({
  ...buildEvent(signal, url),
  signals: [raisedSignal(signal)],
  resolvedSignals: [],
  tasks: [],
  knownBy: [],
});

/**
 * Intake's events, newest first, as Everything lists them: the six events
 * behind To do, one that went on to a Task and to a session as well (so its
 * row ends in "+1"), one that ended a signal and reached three other places,
 * and events nothing came of, one of them with no title.
 */
const EVENTS: ReadonlyArray<EventWithFacts> = [
  buildSignalEvent(SLACK, "https://acme.slack.com/archives/acceptance"),
  buildListedEvent(30, 25, {
    source: "github",
    kind: "github.push",
    title: "Round cart totals once, at checkout",
    author: "Pieter",
    url: "https://github.com/rogier/webshop/commit/9f3c2ab",
  }),
  buildSignalEvent(MENTION, "https://linear.app/acme/issue/PAY-212"),
  buildListedEvent(31, 52, {
    source: "linear",
    kind: "linear.issue.updated",
    title: "PAY-219 moved to In progress",
    author: "Sanne",
  }),
  {
    ...buildSignalEvent(CHECKS, "https://github.com/rogier/webshop/pull/1300"),
    tasks: [{ taskId: TASK_ID, title: "Show VAT per line on invoices" }],
    knownBy: [
      {
        subscriptionId: "01a0ec64-7d00-7000-8000-000000000001",
        holder: { kind: "session", id: SESSION_ID },
        title: "Fix the VAT rounding",
      },
    ],
  },
  buildListedEvent(32, 96, {
    source: "github",
    kind: "github.pull_request.closed",
    title: "Pieter closed #1286 without merging it",
    author: "Pieter",
    url: "https://github.com/rogier/webshop/pull/1286",
    refs: ["github:pr:rogier/webshop#1286"],
    signals: [
      {
        signalId: "01a0ec64-7e00-7000-8000-000000000001",
        kind: "proposal",
        status: "open",
        title: "Retire the old checkout copy",
      },
    ],
    resolvedSignals: [
      {
        signalId: DONE[6]!.id,
        kind: DONE[6]!.kind,
        title: DONE[6]!.title,
        outcome: "Pieter closed #1286 without merging it",
      },
    ],
    tasks: [{ taskId: TASK_ID, title: "Drop the checkout copy experiment" }],
    knownBy: [
      {
        subscriptionId: "01a0ec64-7d00-7000-8000-000000000002",
        holder: { kind: "session", id: SESSION_ID },
        title: "Release thread",
      },
    ],
  }),
  buildSignalEvent(REVIEW, "https://github.com/rogier/payments-api/pull/1294"),
  buildSignalEvent(ALERT, "https://sentry.io/organizations/acme/issues/4521"),
  buildSignalEvent(CHANGES, "https://github.com/rogier/webshop/pull/1298"),
  buildListedEvent(33, 240, {
    source: "github",
    kind: "github.push",
    title: "Sanne pushed 3 commits to marta/webhook-backoff",
    author: "Sanne",
  }),
  buildListedEvent(34, 300, {
    source: "sentry",
    kind: "sentry.deploy",
    title: "Deploy of webshop-prod finished",
    author: null,
  }),
  buildListedEvent(35, 360, {
    source: "slack",
    kind: "slack.message",
    title: null,
    author: null,
  }),
  buildListedEvent(36, 420, {
    source: "github",
    kind: "github.release",
    title: "Release v2.31.0 published",
    author: "Marta",
  }),
  buildListedEvent(37, 480, {
    source: "github",
    kind: "github.issue_comment",
    title: "Pieter commented on #1296",
    author: "Pieter",
  }),
  buildListedEvent(38, 540, {
    source: "github",
    kind: "github.check_suite",
    title: "Nightly dependency check passed",
    author: "GitHub Actions",
  }),
  buildListedEvent(39, 600, {
    source: "linear",
    kind: "linear.comment",
    title: "Jonas commented on PAY-209",
    author: "Jonas",
  }),
];

/** Returns the events whose title or author holds `text`, as the controller's search matches them. */
const searchEvents = (text: string): ReadonlyArray<EventWithFacts> =>
  EVENTS.filter((event) =>
    `${event.title ?? ""} ${event.author ?? ""}`.toLowerCase().includes(text),
  );

/** Returns a scene that opens Everything on `everything`. `play` is what the user does once it opens. */
const buildEverythingScene = (
  name: string,
  everything: NonNullable<IntakeRecords["everything"]>,
  play?: () => Promise<void>,
): IntakeScene => ({
  name,
  records: RECORDS,
  intake: { signal: null, event: null, view: "everything", everything },
  ...(play !== undefined && { play }),
});

/** One state of Intake the specimen draws. */
export interface IntakeScene {
  /** The scene's name in `?scene=` and in its capture's file name. */
  readonly name: string;
  /** The shell's records, with the signals on To do, Later and Done, and the plugins. */
  readonly records: SidebarRecords;
  /** What Intake opens on: the selected signal, its event, the view, and how moves are answered. */
  readonly intake: IntakeRecords;
  /**
   * Plays what the user does after Intake opens, such as pressing `H`.
   * Resolves once the page shows the result. None when left out.
   */
  readonly play?: () => Promise<void>;
  /**
   * The element the pointer rests on when the scene is captured, as a CSS
   * selector. A page cannot put itself under `:hover`, so the capture
   * script moves the pointer there. None when left out.
   */
  readonly hover?: string;
}

const RECORDS: SidebarRecords = {
  ...SPECIMEN_RECORDS,
  signals: TO_DO,
  later: LATER,
  done: DONE,
  plugins: INTAKE_PLUGINS,
};

/** Waits until the page holds an element that matches `selector`. Fails after five seconds. */
const waitForElement = async (selector: string): Promise<Element> => {
  const deadline = performance.now() + 5000;
  for (;;) {
    const element = document.querySelector(selector);
    if (element !== null) return element;
    if (performance.now() > deadline) {
      throw new Error(`The scene never drew ${selector}. Check the page's console for the error.`);
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
};

/**
 * Presses `keys` on Intake's selected row, one after the other, as the user
 * would. A key written `Shift+j` is pressed with Shift held.
 */
const pressKeys = async (...keys: ReadonlyArray<string>): Promise<void> => {
  ((await waitForElement(".ask-row.is-on")) as HTMLElement).focus();
  for (const key of keys) {
    const shiftKey = key.startsWith("Shift+");
    const name = shiftKey ? key.slice("Shift+".length) : key;
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: shiftKey ? name.toUpperCase() : name,
        shiftKey,
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
};

/** Answers a move as the controller does when every signal it names moved. */
const answerMoveDone: FetchLike = async (url, init) => {
  // The client sends the body as bytes, which a Response reads back as JSON.
  const { signalIds } = (await new Response(init?.body).json()) as { signalIds: string[] };
  const field = { "mark-done": "done", snooze: "snoozed", unsnooze: "unsnoozed" }[
    url.slice(url.lastIndexOf("/") + 1)
  ];
  return Response.json({ [field ?? "lowered"]: signalIds, skipped: [] });
};

/** Fails a move as the controller does when its database cannot take the write. */
const answerMoveFailed: FetchLike = () =>
  Promise.resolve(
    Response.json(
      { error: { code: "internal", message: "The database is busy. Try again in a moment." } },
      { status: 500 },
    ),
  );

/**
 * Returns a scene that opens `signal`, read as `read`, with the event at
 * `url`. `intake` adds what else the scene opens with, such as its view,
 * and `play` what the user does once it opens.
 */
const buildScene = (
  name: string,
  signal: Signal,
  url: string,
  {
    read = signal,
    intake = {},
    play,
    hover,
  }: {
    read?: Signal;
    intake?: Partial<IntakeRecords>;
    play?: () => Promise<void>;
    hover?: Signal;
  } = {},
): IntakeScene => ({
  name,
  records: RECORDS,
  intake: { signal: read, event: buildEvent(signal, url), ...intake },
  ...(play !== undefined && { play }),
  ...(hover !== undefined && { hover: selectRow(hover) }),
});

/** Returns the selector of the row of `signal`, which the pointer rests on in a hover scene. */
const selectRow = (signal: Signal): string => `.ask-row[data-signal-id="${signal.id}"]`;

const REVIEW_URL = "https://github.com/rogier/payments-api/pull/1294";

/** Every scene, in the order they are captured. The first is the one `pnpm compare:bureau` compares. */
export const INTAKE_SCENES: ReadonlyArray<IntakeScene> = [
  buildScene("review", REVIEW, REVIEW_URL),
  buildScene("changes", CHANGES, "https://github.com/rogier/webshop/pull/1298"),
  buildScene("checks", CHECKS, "https://github.com/rogier/webshop/pull/1300"),
  buildScene("mention", MENTION, "https://linear.app/acme/issue/PAY-212"),
  buildScene("resolved", REVIEW, REVIEW_URL, {
    read: {
      ...REVIEW,
      status: "resolved",
      resolution: {
        kind: "decided",
        actionId: "approve",
        outcome: "Approved on GitHub",
        actor: "system",
        origin: "core",
        at: minutesAgo(2),
      },
    },
  }),
  { name: "closed", records: RECORDS, intake: { signal: null, event: null } },
  {
    name: "empty",
    records: { ...RECORDS, signals: [] },
    intake: { signal: null, event: null },
  },
  buildScene("snooze", REVIEW, REVIEW_URL, {
    play: async () => {
      await pressKeys("h");
      await waitForElement(".asks-snooze");
    },
  }),
  buildScene("bulk", CHANGES, "https://github.com/rogier/webshop/pull/1298", {
    play: async () => {
      // Checks Sanne's changes, then the alert above it, then Marta's review
      // request below. The alert offers no Done, so Done leaves it alone.
      await pressKeys("x", "Shift+k", "Shift+j", "Shift+j");
      const bar = await waitForElement(".asks-bulk");
      const done = [...bar.querySelectorAll("button")].find((button) =>
        button.textContent.startsWith("Done"),
      );
      // The capture window never has the system's focus, so it gets no focus
      // events, and the scene hovers the button instead.
      done?.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      await waitForElement(".ask-item.is-kept");
    },
  }),
  buildScene("toast", REVIEW, REVIEW_URL, {
    intake: { answerMove: answerMoveDone },
    play: async () => {
      await pressKeys("e");
      await waitForElement(".asks-toast:not(.asks-toast--fail)");
    },
  }),
  buildScene("failed", REVIEW, REVIEW_URL, {
    intake: { answerMove: answerMoveFailed },
    play: async () => {
      await pressKeys("e");
      await waitForElement(".asks-toast--fail");
    },
  }),
  buildScene("later", LAZY_IMAGES, "https://github.com/rogier/webshop/pull/1296", {
    intake: { view: "later" },
  }),
  buildScene("done", DONE[0]!, "https://github.com/rogier/webshop/pull/1293", {
    intake: { view: "done" },
  }),
  buildScene("hover-now", REVIEW, REVIEW_URL, { hover: ALERT }),
  buildScene("hover-signal", REVIEW, REVIEW_URL, { hover: MENTION }),
  buildScene("hover-later", LAZY_IMAGES, "https://github.com/rogier/webshop/pull/1296", {
    intake: { view: "later" },
    hover: VAT_COPY,
  }),
  buildScene("hover-done", DONE[0]!, "https://github.com/rogier/webshop/pull/1293", {
    intake: { view: "done" },
    hover: DONE[4]!,
  }),
  buildScene("evening", REVIEW, REVIEW_URL, {
    play: async () => {
      stopSpecimenClockAt(SPECIMEN_NOW + 9 * 3_600_000);
      await pressKeys("h");
      await waitForElement(".asks-snooze");
    },
  }),
  buildScene("toast-bulk", REVIEW, REVIEW_URL, {
    intake: { answerMove: answerMoveDone },
    play: async () => {
      await pressKeys("e");
      await waitForElement(".asks-toast:not(.asks-bulk)");
      await pressKeys("x");
      await waitForElement(".asks-bulk");
    },
  }),
  buildEverythingScene("everything", { events: EVENTS }),
  buildEverythingScene("everything-end", { events: EVENTS }, async () => {
    const scroll = (await waitForElement(".asks-scroll")) as HTMLElement;
    scroll.scrollTop = scroll.scrollHeight;
    await waitForElement(".asks-end");
  }),
  buildEverythingScene("everything-pane", { events: EVENTS, selectedEventId: 32 }),
  buildEverythingScene("everything-search", { events: searchEvents("pieter"), text: "pieter" }),
  buildEverythingScene("everything-filter", {
    events: EVENTS.filter((event) => event.signals.some((signal) => signal.kind !== "proposal")),
    handling: "raised-signal",
  }),
  buildEverythingScene("everything-no-match", { events: [], text: "invoice" }),
  buildEverythingScene("everything-empty", { events: [] }),
];
