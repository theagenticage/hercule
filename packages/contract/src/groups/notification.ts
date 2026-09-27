/**
 * Notifications: the core's one record of something the user should know, or
 * decide.
 *
 * A notification with actions is a decision; one without is informational.
 * There is one status axis. A decision is created `open` and stays open until
 * it is resolved. An informational notification is created `resolved`, with no
 * resolution, because there is nothing to answer. Nothing but the resolution
 * ever changes: new facts are a new notification. There is no read state
 * either; a screen marks what is new with the user's "since you last checked"
 * marker (`lastChecked.notifications`).
 *
 * The core stamps the producer from the credential, never from the payload: a
 * session produces as itself and a workflow step as its run and step. The core
 * produces its own `core.*` kinds, which nobody else may use.
 *
 * Spec 10 §7 owns the record, its lifecycle and the router.
 */
import { PluginId } from "@hercule/plugin-host";
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Forbidden, Internal, InvalidState, NotFound, Unauthenticated, Validation } from "../errors";
import { Actor, Id, Timestamp } from "../ids";
import { isOperationId } from "../operations";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { atMost, bounded } from "../strings";
import { EventId } from "./event";

/** The longest kind. A kind is a dotted name, not a sentence. */
export const MAX_NOTIFICATION_KIND_LENGTH = 128;

/** The longest title. A title is a line, not a paragraph. */
export const MAX_NOTIFICATION_TITLE_LENGTH = 512;

/** The longest body. It is markdown a producer writes. */
export const MAX_NOTIFICATION_BODY_LENGTH = 64 * 1024;

/**
 * The most subjects one notification lists. A triage offer groups a handful
 * of events; far more than that is a list the user cannot read at a glance.
 */
export const MAX_NOTIFICATION_SUBJECTS = 64;

/** The most answers one decision offers. More is a form, not a question. */
export const MAX_NOTIFICATION_ACTIONS = 16;

/** The longest answer id. */
export const MAX_ACTION_ID_LENGTH = 64;

/** The longest answer label. A label is a button's text. */
export const MAX_ACTION_LABEL_LENGTH = 128;

/** The longest answer description. It is fine print under one answer. */
export const MAX_ACTION_DESCRIPTION_LENGTH = 4 * 1024;

/**
 * The most bytes a bound operation's input may take once written as JSON. The
 * input is stored as given and executed when the user answers, so it holds
 * ids and a few words, never a document.
 */
export const MAX_BOUND_INPUT_BYTES = 16 * 1024;

/** The longest withdrawal reason. It is one line under the notification. */
export const MAX_WITHDRAW_REASON_LENGTH = 256;

/**
 * A notification's kind: dotted, lowercase, namespaced by its producer:
 * `core.run-failed`, `triage.proposal`, `plugin.gmail.token-expiring`.
 */
export const NotificationKind = Schema.String.check(
  Schema.isMaxLength(MAX_NOTIFICATION_KIND_LENGTH),
  Schema.isPattern(/^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/, {
    description: "dotted lowercase words, such as triage.proposal",
  }),
);

export type NotificationKind = Schema.Schema.Type<typeof NotificationKind>;

/** The prefix of the kinds only the core produces. */
export const CORE_KIND_PREFIX = "core.";

/** Open: still wants an answer from the user. Resolved: nothing left to answer. */
export const NotificationStatus = Schema.Literals(["open", "resolved"]);

export type NotificationStatus = Schema.Schema.Type<typeof NotificationStatus>;

/**
 * Who produced a notification. The core stamps it from the caller's
 * credential. `plugin` is part of the record's shape, but nothing produces it
 * until plugins can create notifications.
 */
export const NotificationProducer = Schema.Union([
  Schema.Struct({ type: Schema.Literal("core") }),
  Schema.Struct({ type: Schema.Literal("run"), runId: Id, stepId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("plugin"), pluginId: PluginId }),
  Schema.Struct({ type: Schema.Literal("session"), sessionId: Id }),
]);

export type NotificationProducer = Schema.Schema.Type<typeof NotificationProducer>;

/**
 * The key a user mutes a producer by: `workflow:<id>`, `plugin:<id>` or
 * `assistant:<id>`. The user's `notifications.muted` setting lists them, and
 * each notification carries the one its producer resolves to.
 */
export const MuteKey = Schema.NonEmptyString.check(
  Schema.isPattern(/^(workflow|plugin|assistant):.+$/, {
    description: "`workflow:<id>`, `plugin:<id>` or `assistant:<id>`",
  }),
);

export type MuteKey = Schema.Schema.Type<typeof MuteKey>;

/** Returns the schema of a subject that names one thing by its id. */
const buildIdSubject = <const Kind extends string, Value extends Schema.Top>(
  kind: Kind,
  id: Value,
) => Schema.Struct({ kind: Schema.Literal(kind), id });

/**
 * One thing a notification is about. A trigger has no id of its own, so it is
 * named by its workflow and its id in that workflow's source.
 */
export const NotificationSubject = Schema.Union([
  buildIdSubject("task", Id),
  buildIdSubject("run", Id),
  buildIdSubject("session", Id),
  buildIdSubject("workflow", Id),
  buildIdSubject("connection", Id),
  buildIdSubject("runner", Id),
  buildIdSubject("subscription", Id),
  buildIdSubject("plugin", PluginId),
  buildIdSubject("event", EventId),
  Schema.Struct({ kind: Schema.Literal("trigger"), workflowId: Id, triggerId: Schema.String }),
]);

export type NotificationSubject = Schema.Schema.Type<typeof NotificationSubject>;

/**
 * The operation an answer runs when the user takes it: a contract operation
 * id and its input. The input is stored as given. It is not yet checked
 * against the operation's input schema, and no answer can be taken yet
 * (spec 10 §7.4, ticket #85).
 */
export const BoundOperation = Schema.Struct({
  op: Schema.String.check(
    Schema.makeFilter((op) =>
      isOperationId(op)
        ? undefined
        : `There is no operation named ${JSON.stringify(op)}. Bind a contract operation id, such as run.start.`,
    ),
  ),
  input: Schema.Unknown.check(
    Schema.makeFilter((input) =>
      new TextEncoder().encode(JSON.stringify(input) ?? "").byteLength <= MAX_BOUND_INPUT_BYTES
        ? undefined
        : `The input is larger than ${MAX_BOUND_INPUT_BYTES} bytes of JSON. Bind ids, not documents.`,
    ),
  ),
});

export type BoundOperation = Schema.Schema.Type<typeof BoundOperation>;

/** One answer to a decision. */
export const BoundAction = Schema.Struct({
  id: Schema.String.check(
    Schema.isMaxLength(MAX_ACTION_ID_LENGTH),
    Schema.isPattern(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
      description: "lowercase letters and digits, single dashes between them",
    }),
  ),
  /** The answer's text: "Start Bugfix", "Allow". */
  label: bounded(1, MAX_ACTION_LABEL_LENGTH),
  /** What choosing this answer means, in the producer's markdown. */
  description: Schema.optionalKey(bounded(1, MAX_ACTION_DESCRIPTION_LENGTH)),
  /** `null` resolves the decision and runs nothing: "Dismiss", "Neither". */
  operation: Schema.NullOr(BoundOperation),
  /** The quiet primary answer. At most one per notification. */
  primary: Schema.optionalKey(Schema.Boolean),
});

export type BoundAction = Schema.Schema.Type<typeof BoundAction>;

/**
 * Where a notification was resolved: `web`, `core`, `connection:<id>` (a
 * channel click), `session:<id>` or `plugin:<id>`.
 */
export const ResolutionOrigin = Schema.String.check(
  Schema.isPattern(/^(web|core|(connection|session):[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|plugin:[a-z0-9][a-z0-9-]*)$/, {
    description: "web, core, connection:<id>, session:<id> or plugin:<id>",
  }),
);

export type ResolutionOrigin = Schema.Schema.Type<typeof ResolutionOrigin>;

/**
 * How a decision was resolved:
 *
 * - `decided`: an answer was taken, here or wherever the question was answered.
 * - `handled`: an assistant covered it in a conversation.
 * - `withdrawn`: the question stopped existing. `reason` says why.
 */
export const Resolution = Schema.Struct({
  kind: Schema.Literals(["decided", "handled", "withdrawn"]),
  /** Set when `decided`: the answer taken. */
  actionId: Schema.optionalKey(Schema.String),
  /** Who resolved it. */
  actor: Actor,
  origin: ResolutionOrigin,
  /** Set when `handled`: the conversation whose assistant covered it. */
  conversationId: Schema.optionalKey(Id),
  /** Set when `withdrawn`: one line. */
  reason: Schema.optionalKey(Schema.String),
  at: Timestamp,
});

export type Resolution = Schema.Schema.Type<typeof Resolution>;

export const Notification = Schema.Struct({
  id: Id,
  kind: NotificationKind,
  title: bounded(1, MAX_NOTIFICATION_TITLE_LENGTH),
  /** Markdown. It frames the question on a decision. */
  body: Schema.optionalKey(bounded(1, MAX_NOTIFICATION_BODY_LENGTH)),
  producer: NotificationProducer,
  /** The key that mutes this notification's producer. Absent for the core, which cannot be muted. */
  muteKey: Schema.optionalKey(MuteKey),
  subject: Schema.Array(NotificationSubject),
  /** Set when the core derived the notification from exactly one event, such as `run.failed`. */
  eventId: Schema.optionalKey(EventId),
  /** Empty for an informational notification; the answers of a decision. */
  actions: Schema.Array(BoundAction),
  status: NotificationStatus,
  /** Set once a decision is resolved. An informational notification never has one. */
  resolution: Schema.optionalKey(Resolution),
  createdAt: Timestamp,
});

export type Notification = Schema.Schema.Type<typeof Notification>;

/**
 * Refuses a list of answers that repeats an id or marks more than one answer
 * primary. An answer is taken by its id, and the design shows one primary
 * answer at most.
 */
const refuseAmbiguousActions = Schema.makeFilter((actions: ReadonlyArray<BoundAction>) => {
  const ids = actions.map((action) => action.id);
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
  if (repeated !== undefined) {
    return `Two answers have the id ${JSON.stringify(repeated)}. Give each answer its own id.`;
  }
  return actions.filter((action) => action.primary === true).length > 1
    ? "More than one answer is marked primary. Mark at most one."
    : undefined;
});

/**
 * The payload of `notification.create`. The service decodes it too, so the
 * built-in action sends the same shape as a request. The producer is stamped
 * from the credential and is not part of the payload.
 */
export const NotificationCreateInput = Schema.Struct({
  kind: NotificationKind.check(
    Schema.makeFilter((kind) =>
      kind.startsWith(CORE_KIND_PREFIX)
        ? "Only the core produces core.* notifications. Use a kind in your own namespace, such as triage.fyi."
        : undefined,
    ),
  ),
  title: bounded(1, MAX_NOTIFICATION_TITLE_LENGTH),
  body: Schema.optionalKey(bounded(1, MAX_NOTIFICATION_BODY_LENGTH)),
  /** Answers make the notification a decision. Without them it is informational. */
  actions: Schema.optionalKey(
    atMost(BoundAction, MAX_NOTIFICATION_ACTIONS).check(refuseAmbiguousActions),
  ),
  subject: Schema.optionalKey(atMost(NotificationSubject, MAX_NOTIFICATION_SUBJECTS)),
});

export type NotificationCreateInput = Schema.Schema.Type<typeof NotificationCreateInput>;

/** What `notification.create` returns. */
export const NotificationCreateResult = Schema.Struct({ notificationId: Id });

export type NotificationCreateResult = Schema.Schema.Type<typeof NotificationCreateResult>;

/** The payload of `notification.withdraw`. */
export const NotificationWithdrawInput = Schema.Struct({
  /** One line the user reads under the notification: "answered in the session". */
  reason: bounded(1, MAX_WITHDRAW_REASON_LENGTH).check(
    Schema.isPattern(/^[^\r\n]*$/, { description: "one line" }),
  ),
});

export type NotificationWithdrawInput = Schema.Schema.Type<typeof NotificationWithdrawInput>;

/**
 * The filters of `notification.query`. A notification must match every field
 * given. `since` keeps notifications created at or after that instant.
 */
export const NotificationFilter = Schema.Struct({
  kind: Schema.optionalKey(NotificationKind),
  status: Schema.optionalKey(NotificationStatus),
  since: Schema.optionalKey(Timestamp),
});

export type NotificationFilter = Schema.Schema.Type<typeof NotificationFilter>;

/** What a notification listing may be sorted by. The default is newest first. */
export const NOTIFICATION_SORT_FIELDS = ["createdAt"] as const;

export const notification = HttpApiGroup.make("notification")
  .add(
    HttpApiEndpoint.get("query", "/notifications", {
      query: Schema.Struct({
        ...NotificationFilter.fields,
        ...pageParams(NOTIFICATION_SORT_FIELDS).fields,
      }),
      success: page(Notification),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.get("read", "/notifications/:id", {
      params: { id: Id },
      success: Notification,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("create", "/notifications", {
      payload: NotificationCreateInput,
      success: NotificationCreateResult,
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.post("withdraw", "/notifications/:id/withdraw", {
      params: { id: Id },
      payload: NotificationWithdrawInput,
      success: Notification,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
  )
  .middleware(Authenticated);
