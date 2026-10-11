/**
 * Signals: what Intake puts in front of the user because a move is asked of
 * them, such as a review someone requested or work triage prepared.
 *
 * A Signal is its own record, never a Notification; the two share only the
 * shape of a Bound Action. A signal is created `open` and stays open while a
 * move is asked of the user. It resolves as `decided` when the user makes
 * their move, or `withdrawn` when no move is asked any more. Apart from its
 * resolution, and Not urgent lowering its priority, a signal never changes:
 * a new question is a new signal that replaces the old one.
 *
 * A signal's body is a list of Blocks: data its producer fills, drawn by each
 * app in its own way. Every limit on a block is enforced here, so a producer
 * that writes too much fails loudly and nothing is cut silently.
 *
 * Spec 10 §9 owns the record and its rules; spec 11 §2 (`signal`) owns the
 * operations.
 */
import { PluginId } from "@hercule/plugin-host";
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import {
  CapExceeded,
  Forbidden,
  Internal,
  InvalidState,
  NotFound,
  Unauthenticated,
  Validation,
} from "../errors";
import { Actor, Id, isQualifiedId, Timestamp } from "../ids";
import { Authenticated } from "../security";
import { atMost, bounded } from "../strings";
import { EventId } from "./event";
import {
  BoundAction,
  countJsonBytes,
  DescribeLine,
  MAX_ACTION_ID_LENGTH,
  MAX_BOUND_INPUT_BYTES,
  MAX_NOTIFICATION_ACTIONS,
  MAX_WITHDRAW_REASON_LENGTH,
  refuseAmbiguousActions,
  ResolutionOrigin,
} from "./notification";
import { TaskCreateInput, TaskPriority } from "./task";

/** The longest kind: a core kind, or a plugin's qualified kind such as `github/review-requested`. */
export const MAX_SIGNAL_KIND_LENGTH = 128;

/** The longest title. A title is a line, not a paragraph. */
export const MAX_SIGNAL_TITLE_LENGTH = 512;

/** The longest `asker`, the name of who waits on the user. */
export const MAX_SIGNAL_ASKER_LENGTH = 256;

/** The longest `place`, where the question is asked, such as `acme/webshop#1296`. */
export const MAX_SIGNAL_PLACE_LENGTH = 512;

/** The longest reason a raiser gives for a signal. It is one line. */
export const MAX_SIGNAL_REASON_LENGTH = 512;

/** The most events one raised signal names. */
export const MAX_SIGNAL_EVENT_IDS = 64;

/** The most blocks one signal holds. */
export const MAX_SIGNAL_BLOCKS = 8;

/** The longest markdown of a text block, in characters. */
export const MAX_TEXT_BLOCK_LENGTH = 32 * 1024;

/** The most messages a messages block holds. The producer records the rest in `omitted`. */
export const MAX_BLOCK_MESSAGES = 20;

/** The longest text of one message, in characters. The producer sets `truncated` when it cuts. */
export const MAX_MESSAGE_TEXT_LENGTH = 16 * 1024;

/** The most people one message lists as recipients, in `to` and in `cc` each. */
export const MAX_MESSAGE_RECIPIENTS = 50;

/** The most attachments one message lists by name. */
export const MAX_MESSAGE_ATTACHMENTS = 50;

/** The most failed or pending rows a checks block holds. The producer records the rest in `omitted`. */
export const MAX_CHECK_ROWS = 20;

/** The most lines of a check's log. */
export const MAX_CHECK_LOG_LINES = 40;

/** The longest log of a check, in characters, so 40 very long lines are still refused. */
export const MAX_CHECK_LOG_LENGTH = 8 * 1024;

/** The longest name a block shows: a person, a branch, a file path, a check. */
export const MAX_BLOCK_NAME_LENGTH = 256;

/** The longest link a block carries. */
export const MAX_BLOCK_URL_LENGTH = 2048;

/**
 * The longest typed reply, in characters. The reply fills a field of the
 * action's bound input, so when the action is taken the core also checks that
 * the filled input still fits in `MAX_BOUND_INPUT_BYTES` of JSON. A character
 * can take more than one byte, so a reply under this limit can still be
 * refused there.
 */
export const MAX_SIGNAL_REPLY_LENGTH = 16 * 1024;

/**
 * The longest outcome, the one line the Done list shows. It holds "Accepted "
 * and the longest task title. A plugin action's longer outcome line is cut to
 * this length, because the action has already run when the line is written.
 */
export const MAX_SIGNAL_OUTCOME_LENGTH = 1024;

/**
 * The most bytes one raised signal may take once written as JSON. Each field
 * has its own limit, but together they still allow megabytes, and every open
 * signal is read each time To do loads.
 */
export const MAX_SIGNAL_BYTES = 256 * 1024;

/**
 * The kinds the core owns. They are not prefixed. `signal.raise` raises these
 * and no other:
 *
 * - `proposal`: work the raiser prepared and asks the user to accept. The core
 *   lays out Accept, which creates the signal's `task`, and Dismiss.
 * - `offer`: an action to take now, with no Task behind it.
 * - `unsure`: the raiser could not decide, and the signal says what and why.
 * - `fyi`: worth knowing, nothing to do.
 */
export const CORE_SIGNAL_KINDS = ["proposal", "offer", "unsure", "fyi"] as const;

export type CoreSignalKind = (typeof CORE_SIGNAL_KINDS)[number];

/** Checks whether a kind is one of the core's own kinds. */
export const isCoreSignalKind = (kind: string): kind is CoreSignalKind =>
  (CORE_SIGNAL_KINDS as ReadonlyArray<string>).includes(kind);

/**
 * The id of the core's Done action. The core adds it to every plugin kind and
 * to `fyi`, and nobody else may use the id.
 */
export const DONE_ACTION_ID = "done";

/** The id of the core's Accept action on a proposal, which creates the proposal's `task`. */
export const ACCEPT_ACTION_ID = "accept";

/** The id of the core's Dismiss action on a proposal or an offer. */
export const DISMISS_ACTION_ID = "dismiss";

/**
 * The start of the id of each Hand to action the core adds to an offer, an
 * `unsure` or an `fyi`: `hand-to-` and the id of the workflow it starts.
 */
export const HAND_TO_ACTION_PREFIX = "hand-to-";

/**
 * Checks whether an action id belongs to an action only the core adds:
 * Accept, Dismiss, Done, or a Hand to action. A raiser may not use one, so
 * clients and the core can tell the core's actions apart by their ids.
 */
const isCoreActionId = (id: string): boolean =>
  id === ACCEPT_ACTION_ID ||
  id === DISMISS_ACTION_ID ||
  id === DONE_ACTION_ID ||
  id.startsWith(HAND_TO_ACTION_PREFIX);

/**
 * A signal's kind: a core kind, which is one lowercase word, or a plugin's
 * kind, which is a qualified id such as `github/review-requested`.
 */
export const SignalKind = Schema.String.check(
  Schema.isMaxLength(MAX_SIGNAL_KIND_LENGTH),
  Schema.makeFilter((kind) =>
    /^[a-z0-9]+(-[a-z0-9]+)*$/.test(kind) || isQualifiedId(kind)
      ? undefined
      : `${JSON.stringify(kind)} is not a signal kind. Write a core kind, such as fyi, or a plugin's qualified kind, such as github/review-requested.`,
  ),
);

export type SignalKind = Schema.Schema.Type<typeof SignalKind>;

/** Open: a move is still asked of the user. Resolved: nothing is asked any more. */
export const SignalStatus = Schema.Literals(["open", "resolved"]);

export type SignalStatus = Schema.Schema.Type<typeof SignalStatus>;

/** A line of text that holds no line break. */
const buildOneLine = (maximum: number) =>
  bounded(1, maximum).check(Schema.isPattern(/^[^\r\n]*$/, { description: "one line" }));

/** A count a block shows, such as the number of files a change touches. */
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** A link to a page on the source. */
const SourceUrl = Schema.String.check(
  Schema.isMaxLength(MAX_BLOCK_URL_LENGTH),
  Schema.isPattern(/^https?:\/\/\S+$/, { description: "an http or https URL" }),
);

/** A person a block shows. An app draws their initials when there is no avatar. */
export const Person = Schema.Struct({
  name: bounded(1, MAX_BLOCK_NAME_LENGTH),
  handle: Schema.optionalKey(bounded(1, MAX_BLOCK_NAME_LENGTH)),
  /** Loaded inline, so only https is accepted. */
  avatarUrl: Schema.optionalKey(
    Schema.String.check(
      Schema.isMaxLength(MAX_BLOCK_URL_LENGTH),
      Schema.isPattern(/^https:\/\/\S+$/, { description: "an https URL" }),
    ),
  ),
});

export type Person = Schema.Schema.Type<typeof Person>;

/** A block of markdown. */
export const TextBlock = Schema.Struct({
  type: Schema.Literal("text"),
  markdown: bounded(1, MAX_TEXT_BLOCK_LENGTH),
});

export type TextBlock = Schema.Schema.Type<typeof TextBlock>;

/** One message of a thread: a comment, a review comment or a mail. */
export const ThreadMessage = Schema.Struct({
  author: Person,
  at: Timestamp,
  /** Markdown. */
  text: Schema.String.check(Schema.isMaxLength(MAX_MESSAGE_TEXT_LENGTH)),
  /** Set when the producer cut the text. */
  truncated: Schema.optionalKey(Schema.Literal(true)),
  /** The message on its source. Mail has none. */
  url: Schema.optionalKey(SourceUrl),
  mentionsYou: Schema.optionalKey(Schema.Literal(true)),
  /** A review comment's file and line. */
  location: Schema.optionalKey(
    Schema.Struct({
      path: bounded(1, MAX_BLOCK_NAME_LENGTH),
      line: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    }),
  ),
  /** A mail's recipients. */
  recipients: Schema.optionalKey(
    Schema.Struct({
      to: atMost(Person, MAX_MESSAGE_RECIPIENTS),
      cc: atMost(Person, MAX_MESSAGE_RECIPIENTS),
    }),
  ),
  /** The names of the attachments. The source keeps the files. */
  attachments: Schema.optionalKey(
    atMost(Schema.Struct({ name: bounded(1, MAX_BLOCK_NAME_LENGTH) }), MAX_MESSAGE_ATTACHMENTS),
  ),
});

export type ThreadMessage = Schema.Schema.Type<typeof ThreadMessage>;

/** A block of messages from a thread, oldest first. The first message is always kept. */
export const MessagesBlock = Schema.Struct({
  type: Schema.Literal("messages"),
  messages: atMost(ThreadMessage, MAX_BLOCK_MESSAGES).check(Schema.isMinLength(1)),
  /** How many earlier messages the producer left out. */
  omitted: Count,
});

export type MessagesBlock = Schema.Schema.Type<typeof MessagesBlock>;

/** A pull request or a deployment, as totals. It holds no file list and no diff. */
export const ChangeBlock = Schema.Struct({
  type: Schema.Literal("change"),
  /** A branch or a tag. */
  from: bounded(1, MAX_BLOCK_NAME_LENGTH),
  /** A branch or a tag. */
  to: bounded(1, MAX_BLOCK_NAME_LENGTH),
  files: Count,
  additions: Count,
  deletions: Count,
  commits: Schema.optionalKey(Count),
  checks: Schema.optionalKey(Schema.Struct({ passed: Count, failed: Count, pending: Count })),
});

export type ChangeBlock = Schema.Schema.Type<typeof ChangeBlock>;

/** One failed or pending check. */
export const CheckRow = Schema.Struct({
  name: bounded(1, MAX_BLOCK_NAME_LENGTH),
  state: Schema.Literals(["failed", "pending"]),
  url: Schema.optionalKey(SourceUrl),
  /** The end of the check's log, as plain text. */
  log: Schema.optionalKey(
    bounded(1, MAX_CHECK_LOG_LENGTH).check(
      Schema.makeFilter((log) =>
        log.split("\n").length <= MAX_CHECK_LOG_LINES
          ? undefined
          : `The log has more than ${MAX_CHECK_LOG_LINES} lines. Keep its last ${MAX_CHECK_LOG_LINES} lines.`,
      ),
    ),
  ),
});

export type CheckRow = Schema.Schema.Type<typeof CheckRow>;

/** A list of checks. Failed and pending checks are rows; passing ones are a count. */
export const ChecksBlock = Schema.Struct({
  type: Schema.Literal("checks"),
  rows: atMost(CheckRow, MAX_CHECK_ROWS),
  passed: Count,
  /** How many failed or pending rows the producer left out. */
  omitted: Count,
});

export type ChecksBlock = Schema.Schema.Type<typeof ChecksBlock>;

/** The block types this version of the contract knows. */
export const KNOWN_BLOCK_TYPES = ["text", "messages", "change", "checks"] as const;

/** A block of one of the types this version of the contract knows. */
export const KnownBlock = Schema.Union([TextBlock, MessagesBlock, ChangeBlock, ChecksBlock]);

export type KnownBlock = Schema.Schema.Type<typeof KnownBlock>;

/**
 * A block of a type this version of the contract does not know, from a newer
 * core. An app draws nothing for it, or one plain line, and the rest of the
 * signal still decodes. A known type never matches it, so a known block that
 * breaks a limit is refused instead of read as unknown.
 */
export const UnknownBlock = Schema.Struct({
  type: Schema.String.check(
    Schema.makeFilter((type) =>
      (KNOWN_BLOCK_TYPES as ReadonlyArray<string>).includes(type)
        ? `The ${type} block does not fit its schema.`
        : undefined,
    ),
  ),
});

export type UnknownBlock = Schema.Schema.Type<typeof UnknownBlock>;

/** One part of a signal's body, as a read returns it. */
export const Block = Schema.Union([KnownBlock, UnknownBlock]);

export type Block = Schema.Schema.Type<typeof Block>;

/**
 * Where a signal came from:
 *
 * - `event`: the core raised it from one event of a plugin's kind. `threadRef`
 *   is the thread it is about. `screened` is set when the Screener let it
 *   through.
 * - `api`: an actor raised it with `signal.raise`. `runId` and `workflowId`
 *   are set when the actor is a run's session or step.
 */
export const SignalOrigin = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("event"),
    eventId: EventId,
    connectionId: Id,
    threadRef: Schema.String,
    screened: Schema.optionalKey(Schema.Struct({ runId: Id, reason: Schema.String })),
  }),
  Schema.Struct({
    type: Schema.Literal("api"),
    actor: Actor,
    runId: Schema.optionalKey(Id),
    workflowId: Schema.optionalKey(Id),
    eventIds: Schema.Array(EventId),
    reason: Schema.String,
  }),
]);

export type SignalOrigin = Schema.Schema.Type<typeof SignalOrigin>;

/**
 * One action of a stored signal. The core adds the describe line to the
 * actions of an open signal when the user reads it, because only the user
 * takes an action. A resolved signal's actions carry none.
 */
export const SignalAction = Schema.Struct({
  ...BoundAction.fields,
  describeLine: Schema.optionalKey(DescribeLine),
});

export type SignalAction = Schema.Schema.Type<typeof SignalAction>;

/**
 * How a signal was resolved:
 *
 * - `decided`: the user made their move, in Hercule or on the source.
 *   `actionId` is the action taken, or the action an end on the source maps to.
 * - `withdrawn`: no move is asked of the user any more.
 *
 * `outcome` is the one line the Done list shows, written when the signal
 * resolves: "Approved #1293", "Replied in Gmail". `eventId` is the event that
 * ended the signal on its source.
 */
export const SignalResolution = Schema.Struct({
  kind: Schema.Literals(["decided", "withdrawn"]),
  actionId: Schema.optionalKey(Schema.String),
  eventId: Schema.optionalKey(EventId),
  outcome: Schema.String.check(Schema.isMaxLength(MAX_SIGNAL_OUTCOME_LENGTH)),
  actor: Actor,
  origin: ResolutionOrigin,
  at: Timestamp,
});

export type SignalResolution = Schema.Schema.Type<typeof SignalResolution>;

/**
 * Each match field's value, worked out when the signal is written. An Ignore
 * Rule matches signals by them. Empty for a core kind.
 */
export const SignalMatch = Schema.Record(Schema.String, Schema.String);

export type SignalMatch = Schema.Schema.Type<typeof SignalMatch>;

/** A snooze on an open signal: it is off To do until `until`. */
export const SignalSnooze = Schema.Struct({ until: Timestamp, snoozedAt: Timestamp });

export type SignalSnooze = Schema.Schema.Type<typeof SignalSnooze>;

/**
 * A signal as a read returns it: what is asked of the user, where it came
 * from, its body, the actions the user may take, and, once it is resolved,
 * how.
 */
export const Signal = Schema.Struct({
  id: Id,
  kind: SignalKind,
  origin: SignalOrigin,
  title: bounded(1, MAX_SIGNAL_TITLE_LENGTH),
  /** Who waits on the user: "Marta". */
  asker: Schema.optionalKey(bounded(1, MAX_SIGNAL_ASKER_LENGTH)),
  /** Where the question is asked: "acme/webshop#1296". */
  place: Schema.optionalKey(bounded(1, MAX_SIGNAL_PLACE_LENGTH)),
  /** `urgent` shows as Now. */
  priority: TaskPriority,
  blocks: atMost(Block, MAX_SIGNAL_BLOCKS),
  actions: Schema.Array(SignalAction),
  match: SignalMatch,
  /** Set when the plugin's `build` failed and the signal was written from the event instead. */
  buildError: Schema.optionalKey(Schema.Struct({ message: Schema.String, at: Timestamp })),
  /** On a proposal: the Task that Accept creates. */
  task: Schema.optionalKey(TaskCreateInput),
  /** On the core's Ignore Rule offer: the rule that Ignore creates. */
  ignoreRule: Schema.optionalKey(Schema.Struct({ kind: SignalKind, match: SignalMatch })),
  status: SignalStatus,
  resolution: Schema.optionalKey(SignalResolution),
  /** The newer signal that replaced this one. */
  replacedBy: Schema.optionalKey(Id),
  createdAt: Timestamp,
  /** Read beside the record, never stored on it: set while the signal is snoozed. */
  snooze: Schema.optionalKey(SignalSnooze),
});

export type Signal = Schema.Schema.Type<typeof Signal>;

/**
 * The filters of `signal.query`. `view` picks the list; only `to-do` exists
 * so far, the open signals that are not snoozed. `source` is the id of the
 * plugin whose kind the signal is.
 */
export const SignalFilter = Schema.Struct({
  view: Schema.optionalKey(Schema.Literals(["to-do"])),
  kind: Schema.optionalKey(SignalKind),
  source: Schema.optionalKey(PluginId),
});

export type SignalFilter = Schema.Schema.Type<typeof SignalFilter>;

/**
 * The payload of `signal.raise`. The core fills in the origin from the
 * caller, never from the payload. It refuses:
 *
 * - a kind that is not a core kind, because a plugin's kind is raised only
 *   from its events;
 * - the priority `urgent`, which only a plugin's kind may have;
 * - a `proposal` without `task`, or with actions of its own, because a
 *   proposal's actions are the core's Accept and Dismiss;
 * - `task` on any other kind, which nothing would create;
 * - a `task` larger than `MAX_BOUND_INPUT_BYTES` of JSON, because Accept
 *   binds the task as its input;
 * - an action with an id only the core uses: `accept`, `dismiss`, `done`, or
 *   one that starts with `hand-to-`;
 * - a signal larger than `MAX_SIGNAL_BYTES` of JSON.
 */
export const SignalRaiseInput = Schema.Struct({
  kind: Schema.String.check(
    Schema.makeFilter((kind) =>
      isCoreSignalKind(kind)
        ? undefined
        : `${JSON.stringify(kind)} cannot be raised. Raise one of: ${CORE_SIGNAL_KINDS.join(", ")}. A plugin's kind is raised only from its events.`,
    ),
  ),
  title: bounded(1, MAX_SIGNAL_TITLE_LENGTH),
  /** One line: why the raiser put this in front of the user. */
  reason: buildOneLine(MAX_SIGNAL_REASON_LENGTH),
  /** The events the signal is about. */
  eventIds: atMost(EventId, MAX_SIGNAL_EVENT_IDS),
  priority: Schema.optionalKey(
    TaskPriority.check(
      Schema.makeFilter((priority) =>
        priority === "urgent"
          ? "A raised signal cannot be urgent. Use high, normal or low."
          : undefined,
      ),
    ),
  ),
  /** The body. A raised signal takes the block types this contract knows, and no other. */
  blocks: Schema.optionalKey(atMost(KnownBlock, MAX_SIGNAL_BLOCKS)),
  actions: Schema.optionalKey(
    atMost(BoundAction, MAX_NOTIFICATION_ACTIONS).check(
      refuseAmbiguousActions,
      Schema.makeFilter((actions: ReadonlyArray<BoundAction>) =>
        actions.flatMap((action, index) =>
          isCoreActionId(action.id)
            ? [
                {
                  path: [index, "id"],
                  issue: `The id ${action.id} belongs to an action the core adds. Give your action another id: not ${ACCEPT_ACTION_ID}, ${DISMISS_ACTION_ID} or ${DONE_ACTION_ID}, and not one that starts with ${HAND_TO_ACTION_PREFIX}.`,
                },
              ]
            : [],
        ),
      ),
    ),
  ),
  /** On a proposal: the `task.create` input that Accept runs. */
  task: Schema.optionalKey(TaskCreateInput),
}).check(
  Schema.makeFilter((input) => {
    if (input.kind === "proposal") {
      if (input.task === undefined) {
        return {
          path: ["task"],
          issue: "A proposal needs task: the Task that Accept creates.",
        };
      }
      if (input.actions !== undefined && input.actions.length > 0) {
        return {
          path: ["actions"],
          issue:
            "A proposal takes no actions of its own: the core adds Accept and Dismiss. Leave out actions, or raise an offer instead.",
        };
      }
      if (countJsonBytes(input.task) > MAX_BOUND_INPUT_BYTES) {
        return {
          path: ["task"],
          issue: `The task is larger than ${MAX_BOUND_INPUT_BYTES} bytes of JSON, and Accept binds it as its input. Shorten the description, or put the details in a block.`,
        };
      }
      return undefined;
    }
    return input.task === undefined
      ? undefined
      : {
          path: ["task"],
          issue: `Only a proposal carries task. Leave out task, or raise a proposal instead of ${input.kind}.`,
        };
  }),
  Schema.makeFilter((input) =>
    countJsonBytes(input) <= MAX_SIGNAL_BYTES
      ? undefined
      : `The signal is larger than ${MAX_SIGNAL_BYTES} bytes of JSON. Shorten its blocks, and link to the source for the rest.`,
  ),
);

export type SignalRaiseInput = Schema.Schema.Type<typeof SignalRaiseInput>;

/** What `signal.raise` returns. */
export const SignalRaiseResult = Schema.Struct({ signalId: Id });

export type SignalRaiseResult = Schema.Schema.Type<typeof SignalRaiseResult>;

/**
 * The payload of `signal.act`: the action the user takes, and the text of a
 * typed reply when the action has a `field`. Done is not taken here: it has
 * its own operation, `signal.markDone`.
 */
export const SignalActInput = Schema.Struct({
  actionId: Schema.String.check(
    Schema.isMaxLength(MAX_ACTION_ID_LENGTH),
    Schema.makeFilter((actionId) =>
      actionId === DONE_ACTION_ID
        ? "Done is not taken with signal.act. Call signal.markDone instead."
        : undefined,
    ),
  ),
  text: Schema.optionalKey(bounded(1, MAX_SIGNAL_REPLY_LENGTH)),
});

export type SignalActInput = Schema.Schema.Type<typeof SignalActInput>;

/** The payload of `signal.withdraw`. */
export const SignalWithdrawInput = Schema.Struct({
  /** One line the user reads in Done: "the build passed on retry". */
  reason: buildOneLine(MAX_WITHDRAW_REASON_LENGTH),
});

export type SignalWithdrawInput = Schema.Schema.Type<typeof SignalWithdrawInput>;

/**
 * The signal operations: list To do, read one signal, raise a signal, take
 * one of its actions as the user, and withdraw a signal its raiser no longer
 * needs answered.
 */
export const signal = HttpApiGroup.make("signal")
  .add(
    // The to-do view is not paged: every client counts the whole list.
    HttpApiEndpoint.get("query", "/signals", {
      query: SignalFilter,
      success: Schema.Array(Signal),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.get("read", "/signals/:id", {
      params: { id: Id },
      success: Signal,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("raise", "/signals/raise", {
      payload: SignalRaiseInput,
      success: SignalRaiseResult,
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    // The errors include every error of the operations an action may run,
    // because a failed operation's own error is returned unchanged.
    HttpApiEndpoint.post("act", "/signals/:id/act", {
      params: { id: Id },
      payload: SignalActInput,
      success: Signal,
      error: [
        Unauthenticated,
        Forbidden,
        Validation,
        NotFound,
        InvalidState,
        CapExceeded,
        Internal,
      ],
    }),
    HttpApiEndpoint.post("withdraw", "/signals/:id/withdraw", {
      params: { id: Id },
      payload: SignalWithdrawInput,
      success: Signal,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
  )
  .middleware(Authenticated);
