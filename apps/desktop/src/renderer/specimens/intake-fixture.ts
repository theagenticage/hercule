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
 * - `empty`: nothing on To do.
 */
import {
  HAND_TO_ACTION_PREFIX,
  type Event,
  type PluginDetail,
  type PluginMark,
  type Signal,
  type SignalAction,
} from "@hercule/contract";
import { SPECIMEN_NOW, SPECIMEN_RECORDS } from "./sidebar-fixture";
import type { SidebarRecords } from "./shell-page";

/** Builds an installed, active plugin named `displayName`, with `mark` when it declares one. */
const buildPlugin = (id: string, displayName: string, mark?: PluginMark): PluginDetail => ({
  id,
  displayName,
  ...(mark !== undefined && { mark }),
  hostApi: 1,
  capabilities: [],
  enabled: true,
  status: { _tag: "active" },
  config: {},
  contributions: [],
});

/**
 * The marks of Sentry, Linear and Slack, as their plugins would declare them:
 * the Bureau book's brands.js draws them on a 24-unit grid (Simple Icons,
 * CC0), so each path here is the book's scaled by 2/3 onto the 16-unit grid
 * a plugin's mark is drawn on. GitHub declares none here, because the app
 * still keeps its own copy of GitHub's mark (#526).
 */
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
  buildPlugin("github", "GitHub"),
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
  };
};

/** One state of Intake the specimen draws. */
export interface IntakeScene {
  /** The scene's name in `?scene=` and in its capture's file name. */
  readonly name: string;
  /** The shell's records, with the signals on To do and the plugins. */
  readonly records: SidebarRecords;
  /** The selected signal, as the controller reads it, or `null` for none. */
  readonly signal: Signal | null;
  /** The event the selected signal was raised from, or `null` for none. */
  readonly event: Event | null;
}

const RECORDS: SidebarRecords = { ...SPECIMEN_RECORDS, signals: TO_DO, plugins: INTAKE_PLUGINS };

/** Returns a scene that opens `signal`, read as `read`, with the event at `url`. */
const buildScene = (
  name: string,
  signal: Signal,
  url: string,
  read: Signal = signal,
): IntakeScene => ({
  name,
  records: RECORDS,
  signal: read,
  event: buildEvent(signal, url),
});

/** Every scene, in the order they are captured. The first is the one `pnpm compare:bureau` compares. */
export const INTAKE_SCENES: ReadonlyArray<IntakeScene> = [
  buildScene("review", REVIEW, "https://github.com/rogier/payments-api/pull/1294"),
  buildScene("changes", CHANGES, "https://github.com/rogier/webshop/pull/1298"),
  buildScene("checks", CHECKS, "https://github.com/rogier/webshop/pull/1300"),
  buildScene("mention", MENTION, "https://linear.app/acme/issue/PAY-212"),
  buildScene("resolved", REVIEW, "https://github.com/rogier/payments-api/pull/1294", {
    ...REVIEW,
    status: "resolved",
    resolution: {
      kind: "decided",
      actionId: "approve",
      outcome: "Approved #1294",
      actor: "plugin:github",
      origin: "plugin:github",
      at: minutesAgo(2),
    },
  }),
  { name: "closed", records: RECORDS, signal: null, event: null },
  {
    name: "empty",
    records: { ...RECORDS, signals: [] },
    signal: null,
    event: null,
  },
];
