import { type Effect, Schema } from "effect";
import { AccessMode } from "@hercule/protocol";
import { SchemaValue } from "./manifest";

const Support = Schema.Literals(["native", "unsupported"]);

/**
 * Static facts about the pinned harness version behind a provider. Every value
 * is a fact, never a fallback: what an unsupported mode degrades to is the
 * controller's policy, so nothing here says it.
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
 * The longest name a contribution may carry. Ids and display names reach both
 * columns and the wire, so an overrun is refused at registration rather than
 * written as a row nothing can read back.
 */
export const MAX_CONTRIBUTION_NAME_LENGTH = 128;

/**
 * The name of one contribution: a provider, an event source, or whatever a
 * later extension point contributes. One bound for all of them, because they
 * all reach the same columns.
 */
const ContributionName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_CONTRIBUTION_NAME_LENGTH),
);

/**
 * The bare word a plugin calls a contribution that the host qualifies: an
 * event source, a workflow action or a Connection type. The host puts the
 * plugin's id and a `/` in front of it to make the qualified id, so a `/` in
 * the word would give the qualified id two readings.
 */
export const ContributionWord = ContributionName.check(
  Schema.isPattern(/^[^/]+$/, { message: "The word cannot hold a / character." }),
);

/**
 * A provider's static self-description, which is the whole of what a provider
 * plugin contributes. `defaultConfig` is the value the plugin's own function
 * already returned: a function would not survive the crossing into the catalog.
 */
export const ProviderDefinition = Schema.Struct({
  id: ContributionName,
  displayName: ContributionName,
  /** The harness's own name on `PATH`, which is what joins a runner's facts to an instance. */
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
 * One event kind, as the plugin that emits it declares it: what the payload of
 * such an event must be, and one line saying what the event means. The host
 * derives JSON Schema from the schema for the catalog and keeps the schema
 * itself, which is what an emitted payload is read against.
 */
export interface EventKindDeclaration {
  readonly description: string;
  readonly schema: Schema.Top;
}

/**
 * The two names an event source is identified by. They reach a column and the
 * wire, so they are decoded rather than taken as the plugin wrote them. The
 * kinds are not here: each declaration holds a live schema, which no schema
 * of this kind can describe.
 */
export const EventSourceNames = Schema.Struct({
  id: ContributionWord,
  connectionType: ContributionName,
});

/**
 * What a plugin contributes as a source of events: the bare word it calls
 * itself, the Connection type its events arrive through, and every kind it can
 * emit. The host qualifies the bare word with the plugin's id, so two plugins
 * may each call themselves `github` and still name two different sources.
 *
 * Each kind's name carries the plugin's id as its first segment, which makes a
 * kind unique across plugins and lets a reader of the catalog find the owner of
 * a kind without a second column. The host refuses a kind that does not.
 */
export interface EventSourceDefinition {
  readonly id: string;
  readonly connectionType: string;
  readonly kinds: Record<string, EventKindDeclaration>;
}

/**
 * The two names a workflow action is identified and shown by. They reach a
 * column and the wire, so they are decoded rather than taken as the plugin
 * wrote them. The schemas and `execute` are not here: no schema of this kind
 * can describe a live schema or a function.
 */
export const WorkflowActionNames = Schema.Struct({
  id: ContributionWord,
  displayName: ContributionName,
});

/**
 * An action failed, in words the step record keeps. `code` is a short word a
 * program can tell failures apart by, and `message` is the sentence for a
 * person.
 */
export class ActionError extends Schema.TaggedError<ActionError>()("ActionError", {
  code: Schema.String,
  message: Schema.String,
}) {}

/**
 * Where one execution of a workflow action sits. The run's API client and its
 * cancel signal join this context when runs execute actions.
 */
export interface ActionContext {
  /**
   * The Connection the step acts through, with its credentials and config
   * decoded. Present only for an action that declares a connection type.
   */
  readonly connection?: {
    readonly id: string;
    readonly credentials: unknown;
    readonly config: unknown;
  };
  readonly run: { readonly runId: string; readonly stepId: string };
}

/**
 * What a plugin contributes as a workflow action: the thing an action step
 * calls. `id` is the bare word, often `<entity>.<verb>` such as `pr.merge`;
 * the host qualifies it with the plugin's id, so a step names the action as
 * `github/pr.merge`.
 *
 * `input` is the shape of the step's params and must be a struct, because a
 * step writes its params as named fields. `output` is what the step answers,
 * which an expression reads as `steps.<id>.output`.
 */
export interface WorkflowActionContribution {
  readonly id: string;
  readonly displayName: string;
  /** One line, shown where an author picks an action. */
  readonly description: string;
  readonly input: Schema.Top;
  readonly output: Schema.Top;
  /** The qualified type of the one Connection the action acts through, where it acts through one. */
  readonly connection?: { readonly type: string };
  readonly execute: (input: unknown, context: ActionContext) => Effect.Effect<unknown, ActionError>;
}
