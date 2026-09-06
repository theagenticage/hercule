/**
 * The plugin host: what happens to the compiled-in plugin registry at boot.
 *
 * Every plugin is read before any of it runs. A plugin built against another
 * host contract, asking for a capability this build does not implement, or
 * carrying a config schema the generated settings form cannot render, is
 * refused: its code never executes, so a broken plugin cannot take the boot
 * with it. What is left registers its contributions, which are decoded against
 * the contribution schema before they are believed, so nothing that cannot be
 * serialized reaches the catalog.
 *
 * The catalog is then rewritten whole, in one transaction. Registration is
 * pure - no config, no state, the same answer at every boot - so this boot's
 * output is the entire truth and there is nothing to diff or reconcile.
 *
 * What a boot found is kept in memory rather than in a column: `errored` is a
 * fact about this process, and the next boot is the retry.
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as JsonSchema from "effect/JsonSchema";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  configJsonSchema,
  HOST_API,
  PluginError,
  ProviderDefinition,
  type Plugin,
  type PluginCapability,
  type PluginManifest,
  type RegistrationHost,
} from "@hydra/plugin-host";
import { issuesOf } from "@hydra/contract";
import { nowIso, withTransaction } from "../db";
import { pluginRepository, type NewContribution } from "./repository";

/**
 * The capabilities this build can actually hand a plugin. The manifest schema
 * accepts every name the plugin system will ever have, so a plugin written
 * against a later build is refused with the missing name rather than silently
 * activated without the surface it asked for.
 */
const IMPLEMENTED: ReadonlyArray<PluginCapability> = ["providers"];

/** Why a plugin was not loaded. Each reason is decided before its code runs. */
export type RefusalReason =
  | { readonly kind: "hostApi"; readonly expected: number; readonly actual: number }
  | { readonly kind: "unimplementedCapability"; readonly capability: PluginCapability }
  | { readonly kind: "unsupportedConfigSchema"; readonly message: string };

/** Where a plugin stands in this process. */
export type PluginStatus =
  | { readonly _tag: "active" }
  | { readonly _tag: "inactive" }
  | { readonly _tag: "errored"; readonly message: string }
  | { readonly _tag: "refused"; readonly reason: RefusalReason };

/** What the boot made of one plugin's manifest, for whoever lists plugins. */
export interface LoadedPlugin {
  readonly id: string;
  readonly displayName: string;
  readonly hostApi: number;
  readonly capabilities: ReadonlyArray<PluginCapability>;
  /** Absent when the plugin was refused for a schema that cannot be rendered. */
  readonly configSchema?: JsonSchema.JsonSchema;
  readonly status: PluginStatus;
}

/** The one extension point with a consumer; the column takes any name. */
const PROVIDER = "provider";

// An excess key is refused rather than stripped: a plugin that hands over a
// field the host does not know is wrong about the contract, and silently
// dropping it would let an unserializable value look accepted.
const decodeProvider = Schema.decodeUnknownEffect(ProviderDefinition, {
  errors: "all",
  onExcessProperty: "error",
});

/**
 * What the plugin said went wrong, or what it crashed with when it said
 * nothing. One line either way: this is shown to the user in Settings, where a
 * stack trace would say less than the sentence at the top of it.
 */
const messageOf = (cause: Cause.Cause<PluginError>): string =>
  Option.match(Cause.findErrorOption(cause), {
    onSome: (error) => error.message,
    onNone: () => {
      const defect = Cause.squash(cause);
      return defect instanceof Error ? defect.message : String(defect);
    },
  });

/** A decode failure as a plugin author reads it: which field, and what was wrong. */
const asPluginError = (error: Schema.SchemaError): PluginError =>
  new PluginError({
    message: issuesOf(error)
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; "),
  });

/**
 * Everything decided from the manifest alone, before the plugin's own code is
 * allowed to run: the reason it cannot be loaded, or the config schema the
 * settings form will be generated from.
 */
const inspect = (manifest: PluginManifest): Result.Result<JsonSchema.JsonSchema, RefusalReason> => {
  if (manifest.hostApi !== HOST_API) {
    return Result.fail({ kind: "hostApi", expected: HOST_API, actual: manifest.hostApi });
  }
  const missing = manifest.capabilities.find((capability) => !IMPLEMENTED.includes(capability));
  if (missing !== undefined) {
    return Result.fail({ kind: "unimplementedCapability", capability: missing });
  }
  return Result.mapError(configJsonSchema(manifest.configSchema), (error) => ({
    kind: "unsupportedConfigSchema",
    message: error.message,
  }));
};

/**
 * What one plugin's `register` may call: a surface per capability its manifest
 * asked for, and nothing else. Registration surfaces only, so a plugin cannot
 * reach runtime machinery before the catalog it belongs to exists.
 *
 * Declarations land in the array the caller owns, which is also how a second
 * contribution under an id already taken is caught here rather than by the
 * catalog's primary key, where it would take every other plugin's rows with it.
 */
const registrationHost = (
  manifest: PluginManifest,
  declared: Array<NewContribution>,
): RegistrationHost => ({
  ...(manifest.capabilities.includes("providers")
    ? {
        providers: {
          register: (definition) =>
            Effect.gen(function* () {
              const decoded = yield* decodeProvider(definition).pipe(
                Effect.mapError(asPluginError),
              );
              // The catalog persists the derived JSON Schema: what the plugin
              // authored is a live Effect Schema, which no consumer of the
              // catalog can read.
              const configSchema = configJsonSchema(decoded.configSchema);
              if (Result.isFailure(configSchema)) {
                return yield* Effect.fail(
                  new PluginError({
                    message: `the provider ${decoded.id}: ${configSchema.failure.message}`,
                  }),
                );
              }
              if (
                declared.some((row) => row.extensionPoint === PROVIDER && row.id === decoded.id)
              ) {
                return yield* Effect.fail(
                  new PluginError({
                    message: `the ${PROVIDER} contribution ${decoded.id} is registered twice`,
                  }),
                );
              }
              declared.push({
                owner: manifest.id,
                extensionPoint: PROVIDER,
                id: decoded.id,
                definition: { ...decoded, configSchema: configSchema.success },
              });
            }),
        },
      }
    : {}),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* pluginRepository;
  const loaded = yield* Ref.make<ReadonlyMap<string, LoadedPlugin>>(new Map());

  /**
   * Runs `register`, or says why it did not.
   *
   * Everything the hook can do wrong is caught: a typed failure, a thrown
   * exception before it returns an Effect, and a crash inside one. A plugin is
   * third-party-shaped code, and one of them breaking must cost that plugin its
   * contributions and nothing else.
   */
  const registerPass = (
    plugin: Plugin,
    declared: Array<NewContribution>,
  ): Effect.Effect<PluginStatus> =>
    Effect.suspend(() => plugin.register(registrationHost(plugin.manifest, declared))).pipe(
      Effect.as<PluginStatus>({ _tag: "inactive" }),
      Effect.catchCause((cause) =>
        Effect.succeed<PluginStatus>({ _tag: "errored", message: messageOf(cause) }),
      ),
    );

  return {
    /**
     * Loads the registry: refuse, register, then write the catalog. A plugin
     * that fails registration keeps none of what it managed to declare, so the
     * catalog never holds half a plugin.
     */
    boot: (registry: ReadonlyArray<Plugin>): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const booted = new Map<string, LoadedPlugin>();
        const catalog: Array<NewContribution> = [];

        for (const plugin of registry) {
          const { manifest } = plugin;
          if (booted.has(manifest.id)) {
            // Ids namespace KV keys, secrets and contributions, so two plugins
            // sharing one would share all three. The registry is a file in this
            // binary, so this is a build mistake and not a runtime condition.
            return yield* Effect.die(
              new Error(`The plugin registry lists ${manifest.id} more than once.`),
            );
          }
          const facts = {
            id: manifest.id,
            displayName: manifest.displayName,
            hostApi: manifest.hostApi,
            capabilities: manifest.capabilities,
          };

          const inspected = inspect(manifest);
          if (Result.isFailure(inspected)) {
            booted.set(manifest.id, {
              ...facts,
              status: { _tag: "refused", reason: inspected.failure },
            });
            continue;
          }

          const declared: Array<NewContribution> = [];
          const status = yield* registerPass(plugin, declared);
          if (status._tag !== "errored") catalog.push(...declared);
          booted.set(manifest.id, { ...facts, configSchema: inspected.success, status });
        }

        const at = yield* nowIso;
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            yield* repository.ensure([...booted.keys()], at);
            yield* repository.rewriteCatalog(catalog);
          }),
        );
        yield* Ref.set(loaded, booted);
      }),

    /** Where a plugin stands, or `None` for an id this boot never saw. */
    status: (id: string): Effect.Effect<Option.Option<PluginStatus>> =>
      Effect.map(Ref.get(loaded), (booted) => {
        const entry = booted.get(id);
        return entry === undefined ? Option.none() : Option.some(entry.status);
      }),

    /** Every plugin the last boot loaded, in registry order. */
    loaded: (): Effect.Effect<ReadonlyArray<LoadedPlugin>> =>
      Effect.map(Ref.get(loaded), (booted) => [...booted.values()]),
  };
});

export class PluginHost extends Context.Service<PluginHost, Effect.Success<typeof make>>()(
  "hydra/controller/plugins/PluginHost",
) {}

export const PluginHostLayer: Layer.Layer<PluginHost, never, SqlClient.SqlClient> =
  Layer.effect(PluginHost)(make);
