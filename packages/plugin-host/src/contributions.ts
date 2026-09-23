import { type Effect, Schema } from "effect";
import { AccessMode } from "@hercule/protocol";
import { SchemaValue } from "./manifest";

const Support = Schema.Literals(["native", "unsupported"]);

/**
 * Static facts about the pinned harness version behind a provider. Every value
 * is a fact, never a fallback: the controller decides what an unsupported mode
 * falls back to, so nothing here records it.
 */
export const DeclaredCapabilities = Schema.Struct({
  /** `unsupported` means input to a busy session is queued by the controller. */
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
 */
export interface EventKindDeclaration {
  readonly description: string;
  readonly schema: Schema.Top;
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
 * What a plugin contributes as a source of events: its unqualified id, the
 * Connection type its events arrive through, and every kind it can emit. The
 * host prefixes the id with the plugin's id, so two plugins may each call
 * their source `github` and still have two different sources.
 *
 * Each kind's name must start with the plugin's id as its first segment. That
 * makes a kind unique across plugins, and lets a reader of the catalog find
 * the owner of a kind without a second column. The host rejects a kind that
 * does not start with the plugin's id.
 */
export interface EventSourceDefinition {
  readonly id: string;
  readonly connectionType: string;
  readonly kinds: Record<string, EventKindDeclaration>;
}

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
 * The context passed to one execution of a workflow action. The run's API
 * client and its cancel signal will be added when runs execute actions.
 */
export interface ActionContext {
  /**
   * The Connection the step acts through, with its credentials and config
   * decoded. Set only for an action that declares a Connection type.
   */
  readonly connection?: {
    readonly id: string;
    readonly credentials: unknown;
    readonly config: unknown;
  };
  readonly run: { readonly runId: string; readonly stepId: string };
}

/**
 * A workflow action that a plugin registers, for an action step to call.
 *
 * - `id` is the unqualified id, often `<entity>.<verb>` such as `pr.merge`.
 *   The host prefixes the plugin id, so a step calls the action as
 *   `github/pr.merge`.
 * - `input` is the schema of the step's params. It must be a struct, because
 *   a step writes its params as named fields.
 * - `output` is the schema of the action's result, which an expression reads
 *   as `steps.<id>.output`.
 */
export interface WorkflowActionContribution {
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
