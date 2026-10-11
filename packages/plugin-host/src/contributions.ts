import { type Effect, Schema } from "effect";
import { AccessMode } from "@hercule/protocol";
import type { ConnectionUnavailable } from "./connections";
import { SchemaValue } from "./manifest";
import { TaskPriority } from "./limits";
import type { KeyValueStore, PluginError } from "./plugin";

const Support = Schema.Literals(["native", "unsupported"]);

/**
 * Static facts about the pinned harness version behind a provider. Every value
 * is a fact, never a fallback: the controller decides what an unsupported mode
 * falls back to, so nothing here records it.
 */
export const DeclaredCapabilities = Schema.Struct({
  /**
   * `unsupported` means the harness cannot take input into a running turn.
   * Steering still works for every session: the controller interrupts the
   * running turn and sends the input as the next turn.
   */
  steering: Support,
  fork: Support,
  modelSwitch: Schema.Literals(["in-session", "new-session"]),
  accessModes: Schema.Record(AccessMode, Support),
  mcpPassthrough: Support,
  disallowedTools: Support,
  structuredOutput: Schema.Literals(["supported", "unsupported"]),
});

export type DeclaredCapabilities = Schema.Schema.Type<typeof DeclaredCapabilities>;

/**
 * The longest name a contribution may have. Ids and display names are stored in
 * database columns and sent over the wire, so a name that is too long is
 * rejected at registration rather than written as a row nothing can read back.
 */
export const MAX_CONTRIBUTION_NAME_LENGTH = 128;

/**
 * The name of one contribution: a provider, an event source, or whatever a
 * later extension point contributes. One limit for all of them, because they
 * are all stored in the same columns.
 */
const ContributionName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_CONTRIBUTION_NAME_LENGTH),
);

/**
 * The unqualified id a plugin gives an event source, a workflow action or a
 * Connection type. The host prefixes it with the plugin id and a `/` to build
 * the qualified id (`github/pr.merge`). A `/` in the word would make the
 * qualified id ambiguous, so it is rejected.
 */
export const ContributionWord = ContributionName.check(
  Schema.isPattern(/^[^/]+$/, {
    message:
      "The id cannot contain a / character, because the host joins it to the plugin id with a / to build the qualified id.",
  }),
);

/**
 * A provider's static self-description, which is all a provider plugin
 * contributes. `defaultConfig` is a value rather than a function, because a
 * function cannot be stored in the catalog.
 */
export const ProviderDefinition = Schema.Struct({
  id: ContributionName,
  displayName: ContributionName,
  /** The harness's executable name on `PATH`, which links a runner's facts to an instance. */
  binaryName: ContributionName,
  /** Several accounts of one harness, kept apart by per-instance config dirs. */
  supportsMultipleInstances: Schema.Boolean,
  /** Per-instance logical settings only: environment and model defaults, never paths. */
  configSchema: SchemaValue,
  defaultConfig: Schema.Json,
  declared: DeclaredCapabilities,
});

export type ProviderDefinition = Schema.Schema.Type<typeof ProviderDefinition>;

/**
 * One event kind, as the plugin that emits it declares it: the schema of the
 * event's payload, and one line describing what the event means. The host
 * derives JSON Schema from the schema for the catalog, and keeps the schema
 * itself to validate emitted payloads.
 *
 * `availableToTriage` is the default of the kind's Intake switch: whether
 * triage may read events of this kind. It is required, so the plugin author
 * decides it for every kind. A kind that matters only because it ends a
 * signal, such as a removed review request, is usually not available.
 */
export interface EventKindDeclaration {
  readonly description: string;
  readonly schema: Schema.Top;
  readonly availableToTriage: boolean;
}

/**
 * The two names that identify an event source. They are stored in a column and
 * sent over the wire, so the host decodes them rather than trusting the
 * plugin. The kinds are not here: each declaration holds a live schema, which
 * a schema like this one cannot validate.
 */
export const EventSourceNames = Schema.Struct({
  id: ContributionWord,
  connectionType: ContributionName,
});

/**
 * How often the host polls one feed, in whole seconds. `defaultIntervalSeconds`
 * is the interval a Connection gets until the user sets its own.
 * `minIntervalSeconds` is the shortest interval the plugin allows; the host
 * refuses a shorter one from the user. Without it, the default is also the
 * shortest.
 */
export const FeedDeclaration = Schema.Struct({
  defaultIntervalSeconds: Schema.Int.check(Schema.isGreaterThan(0)),
  minIntervalSeconds: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
});

export type FeedDeclaration = Schema.Schema.Type<typeof FeedDeclaration>;

/**
 * The credentials were rejected by the external system. An ingest handle
 * fails with this error, instead of a `PluginError`, when retrying cannot
 * help: the host sets the Connection to `needs-reauth` at once, without
 * retries, and stops polling it until the user signs in again.
 */
export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
  message: Schema.String,
}) {}

/**
 * The Connection an ingest handle is opened for. `config` is the Connection's
 * own config, decoded against the Connection type's `configSchema`. When the
 * user edits the config, the host closes the handle and opens a new one, so a
 * handle never has to check whether its config is still current.
 */
export interface IngestConnection {
  readonly id: string;
  readonly config: unknown;
  /**
   * The user's account on the external system, as the Connection type's
   * `validate` returned it at sign-in. A source compares it with what an
   * event names to work out facts such as "this review was requested from
   * you".
   */
  readonly accountId: string;
  /** The user's account name on the external system, such as a GitHub login. */
  readonly displayName: string;
}

/**
 * One event, as a plugin emits it. The host adds the event's `source` column
 * (the plugin's id), the Connection, and the time the event was received.
 *
 * - `kind` is one of the kinds the event source declared, and `payload` must
 *   match that kind's schema.
 * - `dedupKey` identifies the fact the event records. The log keeps one event
 *   per `source`, Connection and dedup key, so emitting the same fact twice
 *   writes it once.
 * - `occurredAt` is when the fact happened in the external system, as an ISO
 *   8601 timestamp.
 * - `refs` are the canonical references of the things the event is about,
 *   such as `github:issue:owner/repo#42`.
 * - `url` is where a person opens the event in the external system.
 * - `system` is the external system the event is about. It defaults to the
 *   plugin's id.
 * - `raw` is the external system's own body, as a JSON object. It is stored,
 *   and no expression can read it.
 * - `title` is one line saying what happened, built from the payload:
 *   "Marta requested your review on #1293". Intake shows it, and search
 *   finds the event by it.
 * - `author` is who caused the event on the external system, such as a
 *   GitHub login, or null when nobody did.
 *
 * The host refuses a `payload` or a `raw` larger than `MAX_EMITTED_FIELD_BYTES`,
 * each measured on its own as UTF-8 JSON.
 */
export interface EmittedEvent {
  readonly kind: string;
  readonly dedupKey: string;
  readonly occurredAt: string;
  readonly payload: unknown;
  readonly refs: ReadonlyArray<string>;
  readonly url?: string;
  readonly system?: string;
  readonly raw?: Schema.JsonObject;
  readonly title: string;
  readonly author: string | null;
}

/**
 * The largest `payload`, and the largest `raw`, an emitted event may carry,
 * each as UTF-8 JSON: 256 KiB. It leaves room for a long text field, such as
 * a GitHub issue body of 65,536 characters, or for a whole object from an
 * external API with the repositories and labels nested in it, while keeping
 * one event from bloating the log. An emit over the limit fails, and so does
 * the poll that made it, so the limit is generous on purpose.
 */
export const MAX_EMITTED_FIELD_BYTES = 256 * 1024;

/** The Resources linked to the Connection an ingest handle is opened for. */
export interface ConnectionResources {
  /**
   * Returns every Resource that acts through this Connection, read at the
   * moment of the call, so a Resource the user links later is in the next
   * answer. `remote` is the canonical remote of a repo, such as
   * `github.com/owner/repo`, and null for every other kind.
   */
  readonly list: () => Effect.Effect<ReadonlyArray<LinkedResource>>;
}

/** One Resource, as an ingest handle reads it. */
export interface LinkedResource {
  readonly id: string;
  readonly kind: "repo" | "folder" | "mailbox";
  readonly label: string | null;
  readonly remote: string | null;
}

/**
 * What the host passes to `open`: the services one ingest handle uses for the
 * Connection it was opened for.
 */
export interface IngestContext {
  /**
   * Appends one event to the event log, stamped with this Connection. Fails
   * with a `PluginError` when the kind is not one the event source declared,
   * when the payload does not match the kind's schema, or when the payload or
   * `raw` is larger than its limit. Emitting an event whose dedup key the log
   * already holds succeeds and writes nothing.
   */
  readonly emit: (event: EmittedEvent) => Effect.Effect<void, PluginError>;
  /**
   * The plugin's state for this Connection only: cursors, snapshots and
   * markers. The host deletes it when the Connection is deleted, and when the
   * user resets the plugin's state, so the next poll starts from now.
   */
  readonly state: KeyValueStore;
  /**
   * Returns the Connection's credentials, read at the moment of the call. An
   * access token is refreshed first when it has expired or is about to. See
   * `ConnectionsRuntime.credentials` for the shape.
   */
  readonly credentials: () => Effect.Effect<Record<string, string>, ConnectionUnavailable>;
  /** Present only when the manifest requested the `resources` capability. */
  readonly resources?: ConnectionResources;
  /**
   * Returns the open signals raised from this Connection's events, read at
   * the moment of the call. A source uses it to watch the threads that have
   * one, so it sees the event that ends the signal even when the thread is
   * outside what its feeds read.
   */
  readonly openSignals: () => Effect.Effect<ReadonlyArray<OpenSignal>>;
}

/** One open signal, as an ingest handle reads it. */
export interface OpenSignal {
  /** The qualified signal kind, such as `github/review-requested`. */
  readonly kind: string;
  /** The thread the signal is about, as the kind's `threadRef` worked it out. */
  readonly threadRef: string;
  readonly raisedAt: string;
}

/** What one poll tells the host about the next one. */
export interface PollResult {
  /**
   * The shortest wait before this feed is polled again, in seconds, when the
   * external system asked for one (a `Retry-After` or `X-Poll-Interval`
   * header). The host never polls sooner than the feed's interval, and never
   * sooner than this. A value above 86,400 (one day) counts as one day, and
   * a value that is not a finite number is ignored.
   */
  readonly nextAfterSeconds?: number;
}

/**
 * One open ingest loop for one Connection. The host calls `poll` once per
 * feed tick, never two at a time for the same handle, and calls `close` once,
 * after the last poll has finished.
 */
export interface IngestHandle {
  /**
   * Fetches what changed in one feed since the last poll and emits an event
   * for each change. Fails with an `AuthError` when the credentials were
   * rejected, and with a `PluginError` for any other failure, which the host
   * retries with backoff. The host stops a poll that runs longer than 5
   * minutes and counts it as a failure.
   */
  readonly poll: (feed: string) => Effect.Effect<PollResult, AuthError | PluginError>;
  /**
   * Releases what `open` acquired. The host calls it when it stops ingesting
   * the Connection: before it opens a new handle for the same Connection, when
   * the Connection is deleted, disabled or needs reauthorization, and when the
   * plugin stops. The host waits at most 10 seconds for it, then logs an error
   * and moves on.
   */
  readonly close: Effect.Effect<void>;
}

/**
 * What a plugin contributes as a source of events: its unqualified id, the
 * Connection type its events arrive through, every kind it can emit, the feeds
 * the host polls, and `open`, which starts ingesting for one Connection. The
 * host prefixes the id with the plugin's id, so two plugins may each call
 * their source `github` and still have two different sources.
 *
 * Each kind's name must start with the plugin's id as its first segment. That
 * makes a kind unique across plugins, and lets a reader of the catalog find
 * the owner of a kind without a second column. The host rejects a kind that
 * does not start with the plugin's id.
 *
 * The host owns the clock and the plugin owns the numbers. The host runs one
 * timer per Connection and feed, retries failures with backoff, and sets the
 * Connection's status. The plugin declares each feed's interval and does the
 * fetching. A source emits through the `events` capability, so the host
 * refuses to register a source whose manifest did not request it.
 */
export interface EventSourceContribution {
  readonly id: string;
  readonly connectionType: string;
  readonly kinds: Record<string, EventKindDeclaration>;
  /**
   * The feeds the host polls, by name, such as `notifications`. A source
   * declares at least one, and no feed's default interval may be longer than
   * one day (86,400 seconds): the host refuses the source otherwise.
   */
  readonly feeds: Record<string, FeedDeclaration>;
  /**
   * The kinds of Signal this source's events can raise. None when left out.
   * The host refuses the source when two kinds share a word, or when a kind
   * reads an event kind the source does not declare.
   */
  readonly signalKinds?: ReadonlyArray<SignalKindDeclaration>;
  /**
   * Starts ingesting for one Connection. The host opens a handle for every
   * Connection of the source's type that is `connected` or `error` while the
   * plugin is active. Its first poll of each feed records where the feed
   * stands and emits nothing, so a new Connection never emits history. Fails
   * as `poll` fails.
   */
  readonly open: (
    connection: IngestConnection,
    context: IngestContext,
  ) => Effect.Effect<IngestHandle, AuthError | PluginError>;
}

/**
 * One kind of Signal an event source can raise, such as a review request.
 * Everything but `build` is data that the core evaluates: the plugin never
 * writes a Signal itself. Each expression is CEL over `event`, the stored
 * event without its `raw` body. Spec 10 §9.2 owns how the core raises one.
 *
 * - `word` is the unqualified kind. The host qualifies it with the plugin's
 *   id, so `review-requested` becomes `github/review-requested`.
 * - `label` and `description` are shown to the user: the label on Intake,
 *   the description in Intake's settings.
 * - `from` lists the event kinds the rule reads. The rule never runs on
 *   another kind.
 * - `rule` returns `"yes"`, `"no"` or `"undecided"`: whether the event is a
 *   signal of this kind by itself, is not, or needs the Screener.
 * - `guidance` is what the Screener reads when the rule returns `undecided`.
 * - `threadRef` returns the thread the signal is about, as a string. One
 *   thread has at most one open signal of each kind: a newer one replaces it.
 * - `namesYou` says whether the kind names the user directly, not a team. A
 *   kind that names the user is raised even when a run already receives the
 *   event.
 * - `priority` is the default; `build` may change it.
 * - `matchFields` are what an Ignore Rule may match on. Each `path` returns
 *   the field's value.
 * - `ends` are the events that end an open signal of this kind.
 * - `build` turns the event into the signal's content. It is the one piece
 *   of plugin code, and it may read the external system.
 */
export interface SignalKindDeclaration {
  readonly word: string;
  readonly label: string;
  readonly description: string;
  readonly from: ReadonlyArray<string>;
  readonly rule: string;
  readonly guidance: string;
  readonly threadRef: string;
  readonly namesYou: boolean;
  readonly priority: TaskPriority;
  readonly matchFields: ReadonlyArray<SignalMatchField>;
  readonly ends: ReadonlyArray<SignalEndDeclaration>;
  readonly build: (
    event: StoredEvent,
    context: SignalBuildContext,
  ) => Effect.Effect<SignalDraft, PluginError>;
}

/** One field an Ignore Rule may match on, such as the repo. `path` is CEL over `event`. */
export interface SignalMatchField {
  readonly name: string;
  readonly label: string;
  readonly path: string;
}

/**
 * One event that ends an open signal of a kind. The core checks every event
 * from the signal's Connection against the ends of the open signals on the
 * same thread.
 *
 * - `eventKind` is the kind of the ending event, and `condition` is CEL over
 *   `event` that must return true as well, when it is given.
 * - `resolution` is `decided` when the event is the user's own answer, such
 *   as their review, and `withdrawn` when no move is asked of them any more,
 *   such as a merged pull request.
 * - `outcome` is CEL that returns the line the signal keeps once it ended:
 *   "Reviewed on GitHub", "Merged by marta".
 * - `actionId` is the answer this end stands for, when there is one: an
 *   approval on GitHub stands for the Approve answer.
 */
export interface SignalEndDeclaration {
  readonly eventKind: string;
  readonly condition?: string;
  readonly resolution: "decided" | "withdrawn";
  readonly outcome: string;
  readonly actionId?: string;
}

/**
 * An event as the log stores it, as `build` reads it. `id` is its position
 * in the log. `title` and `author` are null for an event stored before the
 * source set them.
 */
export interface StoredEvent {
  readonly id: number;
  readonly kind: string;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly refs: ReadonlyArray<string>;
  readonly url: string | null;
  readonly title: string | null;
  readonly author: string | null;
}

/** What the host passes to `build`: the Connection the event arrived through, and its credentials. */
export interface SignalBuildContext {
  readonly connection: IngestConnection;
  /** Returns the Connection's credentials, read at the moment of the call, as `IngestContext.credentials` does. */
  readonly credentials: () => Effect.Effect<Record<string, string>, ConnectionUnavailable>;
}

/**
 * One answer `build` lays out. It binds one of the plugin's own workflow
 * actions, named by its unqualified id (`pr.review`), so a plugin can bind no
 * other plugin's action. The core qualifies the id and binds the signal's own
 * Connection, so the plugin cannot pick another.
 *
 * - `input` is the action's input, without its Connection.
 * - `primary` marks the suggested answer. At most one answer is primary.
 * - `field` makes the answer a typed reply: `name` is the top-level text
 *   field of `input` that the user's text fills in, and `placeholder` is the
 *   grey text of the empty box.
 */
export const SignalDraftAction = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
  action: Schema.String,
  input: Schema.Record(Schema.String, Schema.Unknown),
  primary: Schema.optionalKey(Schema.Boolean),
  field: Schema.optionalKey(Schema.Struct({ name: Schema.String, placeholder: Schema.String })),
});

export type SignalDraftAction = Schema.Schema.Type<typeof SignalDraftAction>;

/**
 * The content `build` returns for one signal. The core decodes it with this
 * schema, which checks only its shape, and then checks the whole signal
 * against the contract. When either check fails, the core writes the signal
 * from the event instead, as it does when `build` fails.
 *
 * - `asker` is who waits on the user ("marta"), and `place` is where the
 *   question is asked ("acme/webshop#1296").
 * - `blocks` are the signal's body. Their types and limits are the
 *   contract's `Block`. Here a block needs only its `type`, and its other
 *   fields are kept as they are, for the contract's check to read.
 * - `actions` are the plugin's own answers. The core adds Done and the
 *   workflows that can take the signal, so `build` never declares them.
 */
export const SignalDraft = Schema.Struct({
  title: Schema.String,
  asker: Schema.optionalKey(Schema.String),
  place: Schema.optionalKey(Schema.String),
  priority: Schema.optionalKey(TaskPriority),
  blocks: Schema.Array(
    Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
      Schema.Record(Schema.String, Schema.Unknown),
    ]),
  ),
  actions: Schema.Array(SignalDraftAction),
});

export type SignalDraft = Schema.Schema.Type<typeof SignalDraft>;

/**
 * The id and display name of a workflow action. Both are stored in a column
 * and sent over the API, so the host decodes them instead of trusting the
 * plugin. The input and output schemas and `execute` are not in this schema,
 * because a schema cannot validate an Effect schema or a function.
 */
export const WorkflowActionNames = Schema.Struct({
  id: ContributionWord,
  displayName: ContributionName,
});

/**
 * The error a workflow action fails with. The step record stores it. `code`
 * is a short machine-readable identifier for the kind of failure, and
 * `message` is a sentence for a person.
 */
export class ActionError extends Schema.TaggedError<ActionError>()("ActionError", {
  code: Schema.String,
  message: Schema.String,
}) {}

/**
 * The context passed to one execution of a workflow action. A public-API
 * client for the run will be added when the first action needs one.
 */
export interface ActionContext {
  /**
   * The Connection the step acts through. Set for an action that declares a
   * Connection type, and only for it. The step names the Connection in its
   * `connection` param. `credentials` has the shape
   * `ConnectionsRuntime.credentials` returns, read and refreshed just before
   * the action runs, and `config` is the Connection's own config.
   */
  readonly connection?: {
    readonly id: string;
    readonly credentials: Record<string, string>;
    readonly config: unknown;
  };
  /**
   * The run and the step that called the action. Absent when the action
   * runs as the user's answer to a Notification or a Signal, because no run
   * is involved then.
   */
  readonly run?: { readonly runId: string; readonly stepId: string };
  /**
   * Aborts when the run is cancelled while the action executes, or when the
   * controller stops the work that runs an answer. An action that waits on
   * something outside the controller, such as an HTTP request, passes it on
   * so the wait ends with the work.
   */
  readonly signal: AbortSignal;
}

/**
 * The places a workflow action, or a contract operation, may be bound:
 *
 * - `workflow.step`: called by an action step of a workflow.
 * - `notification.answer`: run by a Bound Action on a decision Notification,
 *   when the user takes it. A plugin action may not list it (`AnswerAction`).
 * - `signal.answer`: run by a Bound Action on a Signal, when the user takes it.
 */
export const BINDING_PLACES = ["workflow.step", "notification.answer", "signal.answer"] as const;

export const BindingPlace = Schema.Literals(BINDING_PLACES);

export type BindingPlace = Schema.Schema.Type<typeof BindingPlace>;

/** A place where a plugin's workflow action may be bound: every place but `notification.answer`. */
type PluginBindingPlace = Exclude<BindingPlace, "notification.answer">;

/** A place where the user's answer runs a bound operation: every place but a workflow step. */
export type AnswerPlace = Exclude<BindingPlace, "workflow.step">;

/**
 * One piece of a describe line. It has one of two kinds:
 *
 * - `text` is the ordinary words of the line.
 * - `marked` is set apart from the words around it; the apps render it in
 *   ink. It is either the live name of an entity the answer acts on, such as
 *   a workflow or a session, or a value the answer sends or sets, such as the
 *   text of an input or a new title.
 *
 * It lives here, not in the contract, because a plugin action that may be
 * bound as an answer writes its own describe line.
 */
export const DescribeLinePart = Schema.Struct({
  kind: Schema.Literals(["text", "marked"]),
  text: Schema.String,
});

export type DescribeLinePart = Schema.Schema.Type<typeof DescribeLinePart>;

/**
 * The fields every workflow action has, wherever it may be bound.
 *
 * - `id` is the unqualified id, often `<entity>.<verb>` such as `pr.merge`.
 *   The host prefixes the plugin id, so a step calls the action as
 *   `github/pr.merge`.
 * - `input` is the schema of the step's params. It must be a struct, because
 *   a step writes its params as named fields. An action that declares a
 *   `connection` must not have a `connection` field in `input`: the step's
 *   `connection` param names the Connection, and the host removes it before
 *   decoding the rest.
 * - `output` is the schema of the action's result, which an expression reads
 *   as `steps.<id>.output`.
 */
interface WorkflowActionFields {
  readonly id: string;
  readonly displayName: string;
  /** One line, shown in the action picker. */
  readonly description: string;
  readonly input: Schema.Top;
  readonly output: Schema.Top;
  /** The qualified type of the Connection the action acts through, if it uses one. */
  readonly connection?: { readonly type: string };
  readonly execute: (input: unknown, context: ActionContext) => Effect.Effect<unknown, ActionError>;
}

/**
 * A workflow action that only an action step may call. Leaving out
 * `usableIn` means the same as listing `workflow.step` alone.
 */
export interface WorkflowStepAction extends WorkflowActionFields {
  readonly usableIn?: readonly ["workflow.step"];
}

/**
 * A workflow action that the user's answer may run, on a Signal. It may list
 * `workflow.step` too. It may not list `notification.answer`: taking a
 * decision Notification's answer runs its operation in the same transaction
 * as the resolution, and a plugin action runs outside any transaction.
 *
 * - `describe` returns the describe line for one frozen input. It must be
 *   pure: it reads only `input`. The plugin writes the line, so the producer
 *   that binds the action cannot make it say something else. It gets the
 *   input as it is stored on the answer, before decoding, and without the
 *   text of a typed reply: the user has not typed it yet.
 * - `outcome` returns the one line a Signal keeps once this action, taken as
 *   its answer, succeeds: "Replied to Marta Visser". It must be pure too.
 *   It gets the stored input with the typed reply filled in. Without it, the
 *   core writes the line from the answer's label.
 */
export interface AnswerAction extends WorkflowActionFields {
  readonly usableIn: readonly [PluginBindingPlace, ...ReadonlyArray<PluginBindingPlace>];
  readonly describe: (input: unknown) => ReadonlyArray<DescribeLinePart>;
  readonly outcome?: (input: unknown) => string;
}

/**
 * A workflow action that a plugin registers. Where it may be bound decides
 * its shape: an action that lists a `*.answer` place in `usableIn` must have
 * `describe`, and TypeScript refuses one without it. Spec 05 §4.4 owns the
 * rules.
 */
export type WorkflowActionContribution = WorkflowStepAction | AnswerAction;
