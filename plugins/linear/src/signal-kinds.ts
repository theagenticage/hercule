/**
 * The kinds of Signal Linear's events raise: an issue that joined the issues
 * the user watches, a mention of the user, and an issue assigned to the user.
 *
 * Everything but `build` is CEL the core evaluates over the stored event.
 * Every rule answers `yes`, so no Linear event goes to the Screener: the user
 * chooses what matters with the Connection's filters and with Ignore Rules.
 * The thread is the event's first ref: the issue (`linear:issue:<workspace
 * id>/<issue id>`), or the project or document a notification is about. So a
 * later event about the same issue ends the open signals of the thread.
 *
 * `build` reads nothing from Linear. Every event already carries the issue,
 * the comment or the description, and the signal only lays them out. There
 * are no answers yet, because the plugin has no workflow actions in v1.
 */
import { Effect, Schema } from "effect";
import {
  MAX_BLOCK_NAME_LENGTH,
  MAX_BLOCK_URL_LENGTH,
  MAX_MESSAGE_TEXT_LENGTH,
  MAX_SIGNAL_TITLE_LENGTH,
  PluginError,
  type SignalDraft,
  type SignalEndDeclaration,
  type SignalKindDeclaration,
  type SignalMatchField,
  type StoredEvent,
} from "@hercule/plugin-host";
import {
  CommentBlock,
  IssueBlock,
  LinearUser,
  MentionComment,
  SubjectBlock,
  WorkspaceBlock,
} from "./kinds";
import { cutText } from "./text";

/** The thread of every kind: the issue or the subject, by its External Ref. */
const THREAD_REF = "event.refs[0]";

/** Linear's priority number for an urgent issue. */
const URGENT_PRIORITY = 1;

/** The name a message shows for an author Linear does not name, such as an integration. */
const UNKNOWN_AUTHOR = "Unknown";

/** The parts of an issue event's payload that `build` reads. */
const IssuePayload = Schema.Struct({
  workspace: WorkspaceBlock,
  issue: IssueBlock,
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  creator: Schema.optionalKey(Schema.NullOr(LinearUser)),
});

/** The parts of a `linear.assigned` payload that `build` reads. */
const AssignedPayload = Schema.Struct({ ...IssuePayload.fields, actor: LinearUser });

/** The parts of a `linear.mentioned` payload that `build` reads: about an issue, or about a subject. */
const MentionPayload = Schema.Struct({
  workspace: WorkspaceBlock,
  issue: Schema.optionalKey(IssueBlock),
  subject: Schema.optionalKey(SubjectBlock),
  actor: LinearUser,
  comment: Schema.NullOr(MentionComment),
  description: Schema.optionalKey(Schema.String),
});

type MentionPayload = Schema.Schema.Type<typeof MentionPayload>;

/**
 * The CEL that returns the first of the issue's label names in alphabetical
 * order, or null when it has none. CEL has no sort, so it keeps the name that
 * is not after any other. CEL compares strings by character code, so a name
 * that starts with a capital comes before one that starts lower case.
 */
const FIRST_LABEL_PATH = [
  "size(event.payload.issue.labels) == 0 ? null :",
  "event.payload.issue.labels.map(label, label.name)",
  ".filter(name, event.payload.issue.labels.all(other, name <= other.name))[0]",
].join(" ");

/** The match fields an Ignore Rule can match an issue on, by name. */
const MATCH_FIELDS = {
  team: { name: "team", label: "Team", path: "event.payload.issue.team.key" },
  project: {
    name: "project",
    label: "Project",
    // An issue in no project has no project to match on.
    path: "event.payload.issue.project != null ? event.payload.issue.project.name : null",
  },
  label: { name: "label", label: "Label", path: FIRST_LABEL_PATH },
  assignee: {
    name: "assignee",
    label: "Assignee",
    // An unassigned issue has no assignee to match on.
    path: "event.payload.issue.assignee != null ? event.payload.issue.assignee.name : null",
  },
  author: { name: "author", label: "Author", path: "event.author" },
} satisfies Record<string, SignalMatchField>;

/** The CEL line a closed issue ends a signal with, by how it closed. */
const CLOSED_OUTCOME = [
  'event.payload.how == "completed" ? "Done in Linear" :',
  'event.payload.how == "canceled" ? "Canceled in Linear" :',
  'event.payload.how == "duplicate" ? "Marked duplicate in Linear" :',
  'event.payload.how == "archived" ? "Archived in Linear" :',
  '"Deleted in Linear"',
].join(" ");

/** The end every kind has: the issue closed. No end is the user's answer in v1, so all withdraw. */
const CLOSED_END: SignalEndDeclaration = {
  eventKind: "linear.issue.closed",
  resolution: "withdrawn",
  outcome: CLOSED_OUTCOME,
};

/**
 * The end an issue leaving the watched set makes of a `linear/issue` signal.
 * An issue that left because somebody else got it is named by its new
 * assignee.
 */
const LEFT_END: SignalEndDeclaration = {
  eventKind: "linear.issue.left",
  resolution: "withdrawn",
  outcome: [
    "event.payload.reassigned && event.payload.issue.assignee != null ?",
    '"Assigned to " + event.payload.issue.assignee.name :',
    `"No longer matches this Connection's filters"`,
  ].join(" "),
};

/** Returns the text on one line: line breaks and runs of spaces become one space. */
const buildOneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Returns the text as a markdown code span, which shows it as it is whatever it holds. */
const buildCodeSpan = (text: string): string =>
  `\`${buildOneLine(cutText(text, MAX_BLOCK_NAME_LENGTH)).replaceAll("`", "'")}\``;

/** Returns the issue's title line, `SHOP-123 Checkout fails`, cut to the signal's limit. */
const buildIssueTitle = (issue: IssueBlock): string =>
  cutText(buildOneLine(`${issue.identifier} ${issue.title}`), MAX_SIGNAL_TITLE_LENGTH);

/** Returns where the issue lives, as `<workspace url key>/<team key>`. */
const buildIssuePlace = (workspace: WorkspaceBlock, issue: IssueBlock): string =>
  `${workspace.urlKey}/${issue.team.key}`;

/** Returns `high` for an issue Linear marks urgent, else `normal`. */
const decidePriority = (issue: IssueBlock) =>
  issue.priority === URGENT_PRIORITY ? ("high" as const) : ("normal" as const);

/** Builds the block that lists what Linear knows about the issue. Empty fields are left out. */
const buildFactsBlock = (issue: IssueBlock) => {
  const lines = [
    `- Team: ${buildCodeSpan(issue.team.name)}`,
    `- State: ${buildCodeSpan(issue.state.name)}`,
    `- Priority: ${buildCodeSpan(issue.priorityLabel)}`,
    `- Assigned to: ${issue.assignee === null ? "nobody" : buildCodeSpan(issue.assignee.name)}`,
    ...(issue.project === null ? [] : [`- Project: ${buildCodeSpan(issue.project.name)}`]),
    ...(issue.projectMilestone === null
      ? []
      : [`- Milestone: ${buildCodeSpan(issue.projectMilestone.name)}`]),
    ...(issue.labels.length === 0
      ? []
      : [`- Labels: ${issue.labels.map((label) => buildCodeSpan(label.name)).join(", ")}`]),
    ...(issue.dueDate === null ? [] : [`- Due: ${buildCodeSpan(issue.dueDate)}`]),
    ...(issue.estimate === null ? [] : [`- Estimate: ${buildCodeSpan(String(issue.estimate))}`]),
  ];
  return { type: "text", markdown: lines.join("\n") };
};

/** Returns the blocks of a description: one `text` block, or none when the description is empty. */
const buildDescriptionTextBlocks = (description: string | null | undefined) =>
  description === null || description === undefined || description.trim() === ""
    ? []
    : [{ type: "text", markdown: description }];

/**
 * Converts a Linear timestamp into the canonical form a block's timestamp
 * takes. A value that is not a date is returned as it is, and the core then
 * refuses the draft.
 */
const convertLinearTimestamp = (at: string): string => {
  const time = Date.parse(at);
  return Number.isNaN(time) ? at : new Date(time).toISOString();
};

/** Returns one message of a `messages` block, its text cut to the block's limit and marked when cut. */
const buildMessage = (
  author: LinearUser | null,
  at: string,
  text: string,
  url: string | null,
  mentionsYou: boolean,
) => ({
  author: { name: cutText(author?.name ?? UNKNOWN_AUTHOR, MAX_BLOCK_NAME_LENGTH) },
  at: convertLinearTimestamp(at),
  text: cutText(text, MAX_MESSAGE_TEXT_LENGTH),
  ...(text.length > MAX_MESSAGE_TEXT_LENGTH ? { truncated: true as const } : {}),
  ...(url !== null && url.length <= MAX_BLOCK_URL_LENGTH ? { url } : {}),
  ...(mentionsYou ? { mentionsYou: true as const } : {}),
});

/** Returns one comment as a message. A comment Linear names no author for is shown as by `fallbackAuthor`. */
const buildCommentMessage = (
  comment: CommentBlock,
  fallbackAuthor: LinearUser | null,
  mentionsYou: boolean,
) =>
  buildMessage(
    comment.author ?? fallbackAuthor,
    comment.createdAt,
    comment.body,
    comment.url,
    mentionsYou,
  );

/**
 * Returns the `messages` block of a mention, oldest first:
 *
 * - for a mention in a comment, the comment it replies to when there is one,
 *   then the comment itself, marked as mentioning the user;
 * - for a mention in a description, the description, by the user who
 *   mentioned them;
 * - no block when there is no text to show, such as a mention in a project's
 *   description.
 */
const buildMentionBlocks = (payload: MentionPayload, event: StoredEvent) => {
  const { comment, actor, description } = payload;
  const messages =
    comment !== null
      ? [
          ...(comment.parent === null ? [] : [buildCommentMessage(comment.parent, null, false)]),
          buildCommentMessage(comment, actor, true),
        ]
      : description === undefined || description.trim() === ""
        ? []
        : [buildMessage(actor, event.occurredAt, description, event.url, true)];
  return messages.length === 0 ? [] : [{ type: "messages", messages, omitted: 0 }];
};

/** Decodes an event's payload, failing with a `PluginError` when it is not the one the plugin emits. */
const decodePayload = <S extends Schema.Codec<unknown, unknown>>(schema: S, event: StoredEvent) =>
  Effect.mapError(
    Schema.decodeUnknownEffect(schema)(event.payload),
    (error) =>
      new PluginError({
        message: `The Linear event ${String(event.id)} has an unexpected payload: ${error.message}`,
      }),
  );

/**
 * Builds a `linear/issue` signal: the issue's identifier and title, a facts
 * block and the description. Fails with a `PluginError` when the event's
 * payload is not the one the plugin emits.
 */
const buildIssueSignal = (event: StoredEvent): Effect.Effect<SignalDraft, PluginError> =>
  Effect.map(decodePayload(IssuePayload, event), ({ workspace, issue, description }) => ({
    title: buildIssueTitle(issue),
    place: buildIssuePlace(workspace, issue),
    priority: decidePriority(issue),
    blocks: [buildFactsBlock(issue), ...buildDescriptionTextBlocks(description)],
    actions: [],
  }));

/**
 * Builds a `linear/mention` signal: the issue's identifier and title, or the
 * subject's title, asked by the user who mentioned, with the comment or the
 * description that mentions the user. Fails with a `PluginError` when the
 * event's payload is not the one the plugin emits.
 */
const buildMentionSignal = (event: StoredEvent): Effect.Effect<SignalDraft, PluginError> =>
  Effect.map(decodePayload(MentionPayload, event), (payload) => {
    const { workspace, issue, subject, actor } = payload;
    return {
      title:
        issue === undefined
          ? cutText(buildOneLine(subject?.title ?? event.title ?? ""), MAX_SIGNAL_TITLE_LENGTH)
          : buildIssueTitle(issue),
      asker: actor.name,
      place: issue === undefined ? workspace.urlKey : buildIssuePlace(workspace, issue),
      priority: "normal",
      blocks: buildMentionBlocks(payload, event),
      actions: [],
    };
  });

/**
 * Builds a `linear/assigned` signal: the issue's identifier and title, asked
 * by the user who assigned it, with the description as a message by the
 * issue's creator and a facts block. Fails with a `PluginError` when the
 * event's payload is not the one the plugin emits.
 */
const buildAssignedSignal = (event: StoredEvent): Effect.Effect<SignalDraft, PluginError> =>
  Effect.map(
    decodePayload(AssignedPayload, event),
    ({ workspace, issue, description, creator, actor }) => ({
      title: buildIssueTitle(issue),
      asker: actor.name,
      place: buildIssuePlace(workspace, issue),
      priority: decidePriority(issue),
      blocks: [
        ...(description === null || description === undefined || description.trim() === ""
          ? []
          : [
              {
                type: "messages",
                messages: [
                  buildMessage(creator ?? null, issue.createdAt, description, issue.url, false),
                ],
                omitted: 0,
              },
            ]),
        buildFactsBlock(issue),
      ],
      actions: [],
    }),
  );

/** The signal kinds of the Linear event source. */
export const LINEAR_SIGNAL_KINDS: ReadonlyArray<SignalKindDeclaration> = [
  {
    word: "issue",
    label: "Issue",
    description: "An issue joined the Linear issues you watch.",
    from: ["linear.issue.entered"],
    rule: '"yes"',
    guidance:
      "An issue joined the issues the user watches through the Connection's filters. It is always a signal.",
    threadRef: THREAD_REF,
    namesYou: false,
    priority: "normal",
    matchFields: [
      MATCH_FIELDS.team,
      MATCH_FIELDS.project,
      MATCH_FIELDS.label,
      MATCH_FIELDS.assignee,
    ],
    ends: [CLOSED_END, LEFT_END],
    build: buildIssueSignal,
  },
  {
    word: "mention",
    label: "Mention",
    description: "Someone mentioned you in Linear.",
    from: ["linear.mentioned"],
    rule: '"yes"',
    guidance:
      "Someone mentioned the user in a Linear comment or description. It is always a signal.",
    threadRef: THREAD_REF,
    namesYou: true,
    priority: "normal",
    matchFields: [
      {
        ...MATCH_FIELDS.team,
        // A mention in a project or a document has no issue, so no team to match on.
        path: `has(event.payload.issue) ? ${MATCH_FIELDS.team.path} : null`,
      },
      MATCH_FIELDS.author,
    ],
    ends: [
      {
        eventKind: "linear.notification.archived",
        resolution: "withdrawn",
        outcome: `"Marked done in Linear's inbox"`,
      },
      CLOSED_END,
    ],
    build: buildMentionSignal,
  },
  {
    word: "assigned",
    label: "Assigned to you",
    description: "Someone assigned you an issue in Linear.",
    from: ["linear.assigned"],
    rule: '"yes"',
    guidance: "Someone assigned the user a Linear issue. It is always a signal.",
    threadRef: THREAD_REF,
    namesYou: true,
    priority: "normal",
    matchFields: [MATCH_FIELDS.team, MATCH_FIELDS.project, MATCH_FIELDS.author],
    ends: [
      {
        eventKind: "linear.issue.unassigned",
        resolution: "withdrawn",
        outcome: '"Unassigned in Linear"',
      },
      CLOSED_END,
    ],
    build: buildAssignedSignal,
  },
];
