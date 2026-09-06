import { Effect, Option, Redacted, Schema } from "effect";
import type { PluginManifest } from "./manifest";
import type { ProviderDefinition } from "./contributions";

/** A plugin's own failure, in the words its author chose. */
export class PluginError extends Schema.TaggedError<PluginError>()("PluginError", {
  message: Schema.String,
}) {}

/** Stops everything `activate` started. */
export type Deactivate = Effect.Effect<void, PluginError>;

export interface ProviderRegistration {
  readonly register: (definition: ProviderDefinition) => Effect.Effect<void, PluginError>;
}

/**
 * What `register` may call. A surface is present only when the manifest asked
 * for its capability, so a plugin that did not request one has no way to reach
 * it. Registration surfaces only: `register` never sees a runtime one.
 */
export interface RegistrationHost {
  readonly providers?: ProviderRegistration;
}

/** The plugin's durable state, namespaced by plugin id. Values are JSON. */
export interface KeyValueStore {
  readonly get: (key: string) => Effect.Effect<Option.Option<Schema.Json>>;
  readonly set: (key: string, value: Schema.Json) => Effect.Effect<void>;
  readonly delete: (key: string) => Effect.Effect<void>;
  readonly list: () => Effect.Effect<ReadonlyArray<string>>;
}

/** The plugin's own rows in the one secrets table, and no one else's. */
export interface PluginSecrets {
  readonly get: (name: string) => Effect.Effect<Option.Option<Redacted.Redacted<string>>>;
  readonly set: (name: string, value: Redacted.Redacted<string>) => Effect.Effect<void>;
  readonly delete: (name: string) => Effect.Effect<void>;
  readonly list: () => Effect.Effect<ReadonlyArray<string>>;
}

/**
 * What `activate` receives: the stored config, already decoded against the
 * manifest's schema, and the runtime surface of each granted capability.
 */
export interface ActivationContext {
  readonly config: unknown;
  readonly kv?: KeyValueStore;
  readonly secrets?: PluginSecrets;
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
