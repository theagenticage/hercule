/**
 * The kinds of Signal Sentry's events raise: an issue that entered the
 * issues the user watches, one that came back after it was resolved or
 * archived, and one that Sentry marked escalating.
 *
 * Everything but `build` is CEL the core evaluates over the stored event.
 * Every kind's thread is the issue: an event's first ref is the issue's own
 * (`sentry:issue:4501/1001`), so a later event about the same issue ends the
 * open signals of the thread.
 *
 * `build` reads nothing from Sentry. Every event already carries the issue
 * and, when Sentry had one, its latest event, and the signal only lays them
 * out, cut to the limits the core checks.
 */
import { Effect, Schema } from "effect";
import {
  MAX_SIGNAL_TITLE_LENGTH,
  PluginError,
  type SignalBuildContext,
  type SignalDraft,
  type SignalDraftAction,
  type SignalEndDeclaration,
  type SignalKindDeclaration,
  type StoredEvent,
} from "@hercule/plugin-host";
import { readMemberName, readUserId } from "./identity";
import { IssueBlock, LatestEvent, ReturnedFrom } from "./kinds";
import { isAssignedToUser } from "./sentry-objects";
import { cutText } from "./text";

/** The thread of every kind: the issue, by its External Ref. */
const THREAD_REF = "event.refs[0]";

/** The longest text a block shows from Sentry on one line, such as the culprit. */
const MAX_FACT_LENGTH = 300;

/** The longest exception message the stack trace block shows. */
const MAX_EXCEPTION_VALUE_LENGTH = 2000;

/** The longest function name or file name of a stack frame the block shows. */
const MAX_FRAME_PART_LENGTH = 200;

/** The parts of an event's payload that `build` reads. */
const SignalPayload = Schema.Struct({
  org: Schema.Struct({ id: Schema.String, slug: Schema.String }),
  issue: IssueBlock,
  after: Schema.optionalKey(ReturnedFrom),
  release: Schema.optionalKey(Schema.String),
  latestEvent: Schema.optionalKey(LatestEvent),
});

type SignalPayload = Schema.Schema.Type<typeof SignalPayload>;

/** The match fields of every kind: what an Ignore Rule can match an issue on. */
const MATCH_FIELDS = [
  { name: "project", label: "Project", path: "event.payload.issue.project.slug" },
  { name: "level", label: "Level", path: "event.payload.issue.level" },
  { name: "errorType", label: "Error type", path: "event.payload.issue.type" },
  {
    name: "assignee",
    label: "Assignee",
    // An unassigned issue has no assignee to match on.
    path: "event.payload.issue.assignedTo != null ? event.payload.issue.assignedTo.name : null",
  },
];

/**
 * The CEL line a `left` event ends a signal with. An issue that no longer
 * matches because somebody else got it is named by the assignee, one that
 * had no event for the whole window by the window, and one Sentry no longer
 * has says so.
 */
const LEFT_OUTCOME = [
  'event.payload.reason == "unmatched" ?',
  "(event.payload.reassigned && event.payload.issue.assignedTo != null ?",
  '"Assigned to " + event.payload.issue.assignedTo.name :',
  `"No longer matches this Connection's filters") :`,
  'event.payload.reason == "aged-out" ?',
  '"No events in " + string(event.payload.lastSeenDays) + " days" :',
  '"Deleted or merged in Sentry"',
].join(" ");

/**
 * Returns the ends every kind has. The user's own resolving or archiving
 * decides the signal with the matching answer. Somebody else's, and an issue
 * leaving the watched issues, withdraw it.
 */
const buildCommonEnds = (): ReadonlyArray<SignalEndDeclaration> => [
  {
    eventKind: "sentry.issue.resolved",
    condition: "event.payload.byYou",
    resolution: "decided",
    outcome: '"Resolved in Sentry"',
    actionId: "resolve",
  },
  {
    eventKind: "sentry.issue.resolved",
    condition: "!event.payload.byYou",
    resolution: "withdrawn",
    outcome: '"Resolved in Sentry"',
  },
  {
    eventKind: "sentry.issue.archived",
    condition: "event.payload.byYou",
    resolution: "decided",
    outcome: '"Archived in Sentry"',
    actionId: "archive",
  },
  {
    eventKind: "sentry.issue.archived",
    condition: "!event.payload.byYou",
    resolution: "withdrawn",
    outcome: '"Archived in Sentry"',
  },
  {
    eventKind: "sentry.issue.left",
    resolution: "withdrawn",
    outcome: LEFT_OUTCOME,
  },
];

/** Returns the end that a newer event about the same issue makes of an older signal. */
const buildNewerSignalEnd = (
  eventKind: "sentry.issue.escalating" | "sentry.issue.regressed",
): SignalEndDeclaration => ({
  eventKind,
  resolution: "withdrawn",
  outcome:
    eventKind === "sentry.issue.escalating"
      ? '"Escalating, see the newer signal"'
      : '"Came back, see the newer signal"',
});

/** Returns the text on one line: each run of whitespace, line breaks included, becomes one space, and the ends are trimmed. */
const collapseWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Returns the text as a markdown code span, which shows it as it is whatever it holds. */
const buildCodeSpan = (text: string, maximum = MAX_FACT_LENGTH): string =>
  `\`${collapseWhitespace(cutText(text, maximum)).replaceAll("`", "'")}\``;

/**
 * Returns the text in a markdown code fence. The fence is one backtick longer
 * than the longest run of backticks inside the text, so the text cannot close
 * it early.
 */
const buildCodeFence = (text: string): string => {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${text}\n${fence}`;
};

/** Builds the block that lists what Sentry knows about the issue. */
const buildFactsBlock = (payload: SignalPayload) => {
  const { issue, latestEvent } = payload;
  const lines = [
    `- Project: ${buildCodeSpan(issue.project.slug)}`,
    `- Level: ${buildCodeSpan(issue.level)}`,
    ...(issue.priority === null ? [] : [`- Priority: ${buildCodeSpan(issue.priority)}`]),
    `- Assigned to: ${issue.assignedTo === null ? "nobody" : buildCodeSpan(issue.assignedTo.name)}`,
    `- Events: ${buildCodeSpan(issue.count)} (${String(issue.userCount)} users)`,
    `- First seen: ${buildCodeSpan(issue.firstSeen)}`,
    `- Last seen: ${buildCodeSpan(issue.lastSeen)}`,
    ...(issue.culprit === "" ? [] : [`- Culprit: ${buildCodeSpan(issue.culprit)}`]),
    ...(latestEvent?.environment === undefined
      ? []
      : [`- Environment: ${buildCodeSpan(latestEvent.environment)}`]),
    ...(latestEvent?.release === undefined
      ? []
      : [`- Release: ${buildCodeSpan(latestEvent.release)}`]),
  ];
  return { type: "text", markdown: lines.join("\n") };
};

/**
 * Builds the block with the latest event's stack trace, innermost call first
 * as a JavaScript stack trace lists it. Returns no block when the event has
 * no exception.
 */
const buildStackTraceBlocks = (
  payload: SignalPayload,
): ReadonlyArray<{ type: string; markdown: string }> => {
  const exception = payload.latestEvent?.exception;
  if (exception === undefined) return [];
  const heading = collapseWhitespace(
    cutText(`${exception.type ?? "Error"}: ${exception.value ?? ""}`, MAX_EXCEPTION_VALUE_LENGTH),
  );
  const frames = [...exception.frames].reverse().map((frame) => {
    const place = cutText(frame.filename ?? "unknown", MAX_FRAME_PART_LENGTH);
    const line = frame.lineNo === null ? "" : `:${String(frame.lineNo)}`;
    return `  at ${cutText(frame.function ?? "<anonymous>", MAX_FRAME_PART_LENGTH)} (${place}${line})`;
  });
  return [{ type: "text", markdown: buildCodeFence([heading, ...frames].join("\n")) }];
};

/**
 * Returns the answers: Resolve, Archive (until the issue escalates), and Assign
 * to me, which is left out when the issue is already assigned to the user.
 * None is primary, because ending an issue must never be the suggested
 * answer.
 */
const buildAnswers = (
  payload: SignalPayload,
  user: { readonly id: string; readonly name: string },
): ReadonlyArray<SignalDraftAction> => {
  const { issue, org } = payload;
  const address = {
    orgSlug: org.slug,
    issueId: issue.id,
    shortId: issue.shortId,
    projectSlug: issue.project.slug,
  };
  return [
    { id: "resolve", label: "Resolve", action: "issue.resolve", input: address },
    {
      id: "archive",
      label: "Archive",
      action: "issue.archive",
      input: { ...address, until: "escalating" },
    },
    ...(isAssignedToUser(issue, user.id)
      ? []
      : [
          {
            id: "assign",
            label: "Assign to me",
            action: "issue.assign",
            input: { ...address, assignee: { type: "user", id: user.id, name: user.name } },
          },
        ]),
  ];
};

/** Builds the first block of a kind that says why the signal was raised, or no block for the plain kind. */
const buildHeadlineBlocks = (
  kind: "issue" | "regressed" | "escalating",
  payload: SignalPayload,
): ReadonlyArray<{ type: string; markdown: string }> => {
  if (kind === "escalating") {
    return [{ type: "text", markdown: `Escalating: ${buildCodeSpan(payload.issue.count)} events` }];
  }
  if (kind === "regressed") {
    const place = payload.release === undefined ? "" : ` in ${buildCodeSpan(payload.release)}`;
    const history = payload.after === undefined ? "" : ` after it was ${payload.after}`;
    return [{ type: "text", markdown: `Came back${place}${history}` }];
  }
  return [];
};

/**
 * Builds the signal of one kind from the event alone: the issue's short id
 * and title, a facts block, and the latest event's stack trace when the
 * event has one. The `regressed` and `escalating` kinds add a block first that
 * says why the signal was raised. Fails with a `PluginError` when the
 * event's payload is not the one the plugin emits.
 */
const buildIssueSignal =
  (kind: "issue" | "regressed" | "escalating") =>
  (event: StoredEvent, context: SignalBuildContext): Effect.Effect<SignalDraft, PluginError> =>
    Effect.gen(function* () {
      const payload = yield* Effect.mapError(
        Schema.decodeUnknownEffect(SignalPayload)(event.payload),
        (error) =>
          new PluginError({
            message: `The Sentry event ${String(event.id)} has an unexpected payload: ${error.message}`,
          }),
      );
      const { issue, org } = payload;
      const user = {
        id: readUserId(context.connection.accountId),
        name: readMemberName(context.connection.displayName),
      };
      return {
        title: cutText(
          collapseWhitespace(`${issue.shortId} ${issue.title}`),
          MAX_SIGNAL_TITLE_LENGTH,
        ),
        place: `${org.slug}/${issue.project.slug}`,
        priority: kind === "issue" && issue.priority !== "high" ? "normal" : "high",
        blocks: [
          ...buildHeadlineBlocks(kind, payload),
          buildFactsBlock(payload),
          ...buildStackTraceBlocks(payload),
        ],
        actions: buildAnswers(payload, user),
      };
    });

/** The signal kinds of the Sentry event source. */
export const SENTRY_SIGNAL_KINDS: ReadonlyArray<SignalKindDeclaration> = [
  {
    word: "issue",
    label: "Issue",
    description: "An issue you watch is new to you in Sentry.",
    from: ["sentry.issue.entered"],
    rule: '"yes"',
    guidance:
      "An issue joined the issues the user watches, because it is new or newly assigned to the user or their teams. It is always a signal.",
    threadRef: THREAD_REF,
    namesYou: false,
    priority: "normal",
    matchFields: MATCH_FIELDS,
    ends: [
      ...buildCommonEnds(),
      buildNewerSignalEnd("sentry.issue.escalating"),
      buildNewerSignalEnd("sentry.issue.regressed"),
    ],
    build: buildIssueSignal("issue"),
  },
  {
    word: "regressed",
    label: "Issue came back",
    description: "A resolved or archived issue you watched had a new event.",
    from: ["sentry.issue.regressed"],
    rule: '"yes"',
    guidance: "An issue the user had resolved or archived came back. It is always a signal.",
    threadRef: THREAD_REF,
    namesYou: false,
    priority: "high",
    matchFields: MATCH_FIELDS,
    ends: [...buildCommonEnds(), buildNewerSignalEnd("sentry.issue.escalating")],
    build: buildIssueSignal("regressed"),
  },
  {
    word: "escalating",
    label: "Issue escalating",
    description: "Sentry marked an issue you watch escalating: its events spiked.",
    from: ["sentry.issue.escalating"],
    rule: '"yes"',
    guidance: "Sentry saw a spike in an issue's events. It is always a signal.",
    threadRef: THREAD_REF,
    namesYou: false,
    priority: "high",
    matchFields: MATCH_FIELDS,
    ends: [...buildCommonEnds(), buildNewerSignalEnd("sentry.issue.regressed")],
    build: buildIssueSignal("escalating"),
  },
];
