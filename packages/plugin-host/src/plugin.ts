import { Effect, Option, Redacted, Schema } from "effect";
import type { PluginManifest } from "./manifest";
import type {
  EventSourceDefinition,
  ProviderDefinition,
  WorkflowActionContribution,
} from "./contributions";
import type {
  ConnectionRegistration,
  ConnectionsRuntime,
  ConnectionTypeContribution,
} from "./connections";

/** A plugin's own failure, with a message its author wrote. */
export class PluginError extends Schema.TaggedError<PluginError>()("PluginError", {
  message: Schema.String,
}) {}

/** Stops everything `activate` started. */
export type Deactivate = Effect.Effect<void, PluginError>;

export interface ProviderRegistration {
  readonly register: (definition: ProviderDefinition) => Effect.Effect<void, PluginError>;
}

export interface EventSourceRegistration {
  readonly register: (definition: EventSourceDefinition) => Effect.Effect<void, PluginError>;
}

export interface WorkflowActionRegistration {
  readonly register: (contribution: WorkflowActionContribution) => Effect.Effect<void, PluginError>;
}

/**
 * The services `register` may call. A service is present only when the
 * manifest requested its capability, so a plugin that did not request one has
 * no way to reach it. These are registration services only: `register` never
 * receives a runtime service.
 */
export interface RegistrationHost {
  readonly providers?: ProviderRegistration;
  readonly connections?: ConnectionRegistration;
  readonly eventSources?: EventSourceRegistration;
  readonly workflowActions?: WorkflowActionRegistration;
}

/** The plugin's durable state, namespaced by plugin id. Values are JSON. */
export interface KeyValueStore {
  readonly get: (key: string) => Effect.Effect<Option.Option<Schema.Json>>;
  readonly set: (key: string, value: Schema.Json) => Effect.Effect<void>;
  readonly delete: (key: string) => Effect.Effect<void>;
  readonly list: () => Effect.Effect<ReadonlyArray<string>>;
}

/** The plugin's own rows in the secrets table, and no one else's. */
export interface PluginSecrets {
  readonly get: (name: string) => Effect.Effect<Option.Option<Redacted.Redacted<string>>>;
  readonly set: (name: string, value: Redacted.Redacted<string>) => Effect.Effect<void>;
  readonly delete: (name: string) => Effect.Effect<void>;
  readonly list: () => Effect.Effect<ReadonlyArray<string>>;
}

/**
 * What `activate` receives: the stored config, already decoded with the
 * manifest's schema, and the runtime service of each granted capability.
 */
export interface ActivationContext {
  readonly config: unknown;
  readonly kv?: KeyValueStore;
  readonly secrets?: PluginSecrets;
  readonly connections?: ConnectionsRuntime;
}

export interface Plugin {
  readonly manifest: PluginManifest;
  /**
   * Declares contributions and nothing else: no I/O, no config, no state. It
   * runs at every boot for every plugin, enabled or not, because its output is
   * the catalog the rest of the system reads while a plugin is disabled.
   */
  readonly register: (host: RegistrationHost) => Effect.Effect<void, PluginError>;
  /** Runs only for an enabled plugin, once the whole catalog exists. */
  readonly activate: (ctx: ActivationContext) => Effect.Effect<Deactivate, PluginError>;
}

/**
 * Registers a provider through the host. Fails with a `PluginError` when the
 * manifest did not request the `providers` capability.
 *
 * Every service on `RegistrationHost` is optional, because the host builds one
 * only for a capability the manifest lists. A plugin still has to handle the
 * missing case, and the right handling is always the same: fail, with a
 * message the user reads in Settings. The three functions below do the same
 * for the other registration services.
 */
export const registerProvider = (
  host: RegistrationHost,
  definition: ProviderDefinition,
): Effect.Effect<void, PluginError> =>
  host.providers === undefined
    ? Effect.fail(new PluginError({ message: "the providers capability was not granted" }))
    : host.providers.register(definition);

export const registerConnectionType = (
  host: RegistrationHost,
  contribution: ConnectionTypeContribution,
): Effect.Effect<void, PluginError> =>
  host.connections === undefined
    ? Effect.fail(new PluginError({ message: "the connections capability was not granted" }))
    : host.connections.registerType(contribution);

export const registerEventSource = (
  host: RegistrationHost,
  definition: EventSourceDefinition,
): Effect.Effect<void, PluginError> =>
  host.eventSources === undefined
    ? Effect.fail(new PluginError({ message: "the event-sources capability was not granted" }))
    : host.eventSources.register(definition);

export const registerWorkflowAction = (
  host: RegistrationHost,
  contribution: WorkflowActionContribution,
): Effect.Effect<void, PluginError> =>
  host.workflowActions === undefined
    ? Effect.fail(new PluginError({ message: "the workflow-actions capability was not granted" }))
    : host.workflowActions.register(contribution);
