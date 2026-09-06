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
import * as Semaphore from "effect/Semaphore";
import {
  configJsonSchema,
  HOST_API,
  PluginError,
  PluginManifest,
  ProviderDefinition,
  type ActivationContext,
  type Deactivate,
  type KeyValueStore,
  type Plugin,
  type PluginCapability,
  type PluginSecrets,
  type RegistrationHost,
} from "@hydra/plugin-host";
import {
  issuesOf,
  MAX_PLUGIN_MESSAGE_LENGTH,
  validationOf,
  type PluginRefusalReason,
  type PluginStatus,
  type Validation,
} from "@hydra/contract";
import { nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { CurrentActor, SYSTEM_ACTOR, USER_ACTOR } from "../actor";
import { Secrets, type SecretOwner } from "../secrets";
import { pluginRepository, type NewContribution, type PluginState } from "./repository";

/**
 * The capabilities this build can actually hand a plugin. The manifest schema
 * accepts every name the plugin system will ever have, so a plugin written
 * against a later build is refused with the missing name rather than silently
 * activated without the surface it asked for.
 */
const IMPLEMENTED: ReadonlyArray<PluginCapability> = ["providers", "kv", "secrets"];

/** What the boot made of one plugin's manifest, for whoever lists plugins. */
export interface LoadedPlugin {
  readonly id: string;
  readonly displayName: string;
  readonly hostApi: number;
  readonly capabilities: ReadonlyArray<PluginCapability>;
  /**
   * Absent for every plugin that was turned away: the schema is derived once
   * the manifest has been accepted, so no refusal reaches one. There is no form
   * to generate in any of the three cases, and `status` says which it was.
   */
  readonly configSchema?: JsonSchema.JsonSchema;
  readonly status: PluginStatus;
}

/**
 * What the host holds about one plugin.
 *
 * The manifest is the decoded copy, not the object the plugin exposes: every
 * scope the plugin gets - its KV keys, its secret owner, its catalog rows - is
 * derived from its id, and a plugin whose `manifest` is a getter could
 * otherwise answer with another plugin's id after it had been checked.
 *
 * The teardown lives beside the status because they change together and nothing
 * else may reach it.
 */
interface Entry extends LoadedPlugin {
  readonly plugin: Plugin;
  readonly manifest: PluginManifest;
  /** Absent while the plugin is not running. */
  readonly deactivate: Deactivate | undefined;
  /**
   * Whether this process may still start the plugin. A `register` that failed
   * left no contributions to run against, and a teardown that failed left
   * machinery a second `activate` would pile on top of. Both need a restart.
   */
  readonly startable: boolean;
}

/** What a caller outside the host may see of an entry. */
const exposed = (entry: Entry): LoadedPlugin => ({
  id: entry.id,
  displayName: entry.displayName,
  hostApi: entry.hostApi,
  capabilities: entry.capabilities,
  ...(entry.configSchema === undefined ? {} : { configSchema: entry.configSchema }),
  status: entry.status,
});

/** The one extension point with a consumer; the column takes any name. */
const PROVIDER = "provider";

/**
 * Reads a config against a plugin's own schema, reporting every issue at once
 * so the settings form can put each message under the field it is about. A key
 * the schema does not name is refused rather than dropped, so a stale form
 * field is said out loud instead of quietly ignored.
 *
 * The schema arrives as an opaque value across the host boundary, so its
 * decoded type is `unknown` here; it is the plugin's own hook that gives it a
 * type again.
 */
const decodeConfig = (
  schema: Schema.Top,
  config: Schema.Json,
): Effect.Effect<unknown, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(schema as Schema.Codec<unknown>, {
    errors: "all",
    onExcessProperty: "error",
  })(config);

/**
 * A message the plugin wrote, cut to what the API will carry.
 *
 * The text is the plugin's own and has no bound of its own, while it is served
 * on every listing and kept in the log for months, so it is cut here rather
 * than at either reader: one bound, applied where the message is made, is what
 * makes the published maximum true of every message that carries one.
 */
const bounded = (message: string): string =>
  message.length <= MAX_PLUGIN_MESSAGE_LENGTH
    ? message
    : `${message.slice(0, MAX_PLUGIN_MESSAGE_LENGTH - 3)}...`;

/** A decode failure as one line naming the fields it is about. */
const fieldMessage = (error: Schema.SchemaError): string =>
  bounded(
    issuesOf(error)
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; "),
  );

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
  bounded(
    Option.match(Cause.findErrorOption(cause), {
      onSome: (error) => error.message,
      onNone: () => {
        const defect = Cause.squash(cause);
        return defect instanceof Error ? defect.message : String(defect);
      },
    }),
  );

/**
 * Refuses an empty key or secret name before it reaches a table. It is a defect
 * rather than a failure because the surface a plugin programs against declares
 * no error, and the host catches it as the plugin's own crash either way - with
 * a sentence its author can act on instead of a statement the database refused.
 */
const named = (what: string, value: string): Effect.Effect<void> =>
  value.length === 0
    ? Effect.die(new PluginError({ message: `A plugin ${what} cannot be empty.` }))
    : Effect.void;

/** A decode failure as a plugin author reads it: which field, and what was wrong. */
const asPluginError = (error: Schema.SchemaError): PluginError =>
  new PluginError({
    message: fieldMessage(error),
  });

/** The row a boot just wrote for this plugin. Its absence is a defect, not a state. */
const stateOf = (states: ReadonlyMap<string, PluginState>, id: string): PluginState => {
  const state = states.get(id);
  if (state === undefined) throw new Error(`The plugin ${id} has no stored row.`);
  return state;
};

/**
 * Enough to find the offending plugin in the registry file. The id it claims is
 * the useful half, but that is the field most likely to be what is wrong, so
 * where it is not a string the position in the registry stands in for it.
 */
const nameOf = (manifest: unknown, index: number): string => {
  const id = (manifest as { readonly id?: unknown } | null | undefined)?.id;
  return typeof id === "string" ? `"${id}"` : `at registry position ${String(index)}`;
};

/**
 * The manifest as the host will read it from here on: decoded, and a copy. A
 * compiled-in plugin whose manifest does not decode is a build mistake, so it
 * stops the boot naming what is wrong rather than being listed as refused.
 */
const decodeManifest = (manifest: unknown, index: number): Effect.Effect<PluginManifest> =>
  Schema.decodeUnknownEffect(PluginManifest, { errors: "all" })(manifest).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.die(
        new Error(
          `The plugin ${nameOf(manifest, index)} has an invalid manifest: ${fieldMessage(error)}`,
        ),
      ),
    ),
  );

/**
 * Everything decided from the manifest alone, before the plugin's own code is
 * allowed to run: the reason it cannot be loaded, or the config schema the
 * settings form will be generated from.
 */
const inspect = (
  manifest: PluginManifest,
): Result.Result<JsonSchema.JsonSchema, PluginRefusalReason> => {
  if (manifest.hostApi !== HOST_API) {
    return Result.fail({ kind: "hostApi", expected: HOST_API, actual: manifest.hostApi });
  }
  const missing = manifest.capabilities.find((capability) => !IMPLEMENTED.includes(capability));
  if (missing !== undefined) {
    return Result.fail({ kind: "unimplementedCapability", capability: missing });
  }
  return Result.mapError(configJsonSchema(manifest.configSchema), (error) => ({
    kind: "unsupportedConfigSchema",
    message: bounded(error.message),
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
  const secrets = yield* Secrets;
  const audit = yield* AuditLog;
  const entries = yield* Ref.make<ReadonlyMap<string, Entry>>(new Map());
  /**
   * One permit for the whole host, held across a whole move: reading a
   * plugin's state, running its hooks and writing the result. Without it two
   * moves interleave around the await inside a hook and the second decides on
   * what the first has already changed - two activations, a teardown that runs
   * twice, an instance left running under a row that says disabled. One
   * user's controller queues moves at no cost; a permit per plugin would not
   * help, because a move reads and writes rows the whole host shares.
   */
  const gate = yield* Semaphore.make(1);

  const patch = (id: string, change: Partial<Entry>): Effect.Effect<void> =>
    Ref.update(entries, (current) => {
      const entry = current.get(id);
      if (entry === undefined) return current;
      const next = new Map(current);
      next.set(id, { ...entry, ...change });
      return next;
    });

  /**
   * Says a hook failed: in the status the user reads, and on the audit log,
   * which is what a notification is routed from.
   */
  const markErrored = (
    id: string,
    phase: "activate" | "deactivate",
    message: string,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      yield* patch(id, {
        status: { _tag: "errored", message },
        deactivate: undefined,
        // What a failed teardown left behind is still running, so nothing may
        // start the plugin again until the process that holds it is gone.
        ...(phase === "deactivate" ? { startable: false } : {}),
      });
      const at = yield* nowIso;
      // The boot's own activation pass has no user behind it, so the row says
      // what actually caused it rather than blaming whoever logged in last.
      const actor = yield* Effect.map(CurrentActor, (who) =>
        who._tag === "user" ? USER_ACTOR : SYSTEM_ACTOR,
      );
      yield* withTransaction(
        sql,
        audit.append({
          kind: "plugin.errored",
          actor,
          payload: { pluginId: id, phase, message },
          record: { topic: "plugin", id },
          at,
        }),
      );
    });

  /**
   * The plugin's own slice of the KV table. A statement the database refused is
   * a defect rather than an error: the surface a plugin programs against says
   * these calls cannot fail, and a plugin has nothing to do about a broken
   * database anyway.
   */
  const keyValueStore = (pluginId: string): KeyValueStore => ({
    get: (key) => Effect.andThen(named("key", key), Effect.orDie(repository.kvGet(pluginId, key))),
    set: (key, value) =>
      Effect.andThen(named("key", key), Effect.orDie(repository.kvSet(pluginId, key, value))),
    delete: (key) =>
      Effect.andThen(named("key", key), Effect.orDie(repository.kvDelete(pluginId, key))),
    list: () => Effect.orDie(repository.kvKeys(pluginId)),
  });

  /**
   * The plugin's own rows in the one secrets table, and no one else's: the
   * owner is fixed here, so nothing a plugin passes can widen it.
   */
  const pluginSecrets = (pluginId: string): PluginSecrets => {
    const owner: SecretOwner = { kind: "plugin", id: pluginId };
    return {
      get: (name) => Effect.andThen(named("name", name), Effect.orDie(secrets.get(owner, name))),
      set: (name, value) =>
        Effect.andThen(
          named("name", name),
          Effect.orDie(Effect.asVoid(secrets.set(owner, name, value))),
        ),
      delete: (name) =>
        Effect.andThen(
          named("name", name),
          Effect.orDie(Effect.asVoid(secrets.delete(owner, name))),
        ),
      list: () => Effect.orDie(secrets.names(owner)),
    };
  };

  /** The runtime surfaces of the capabilities this manifest asked for, and no others. */
  const activationContext = (manifest: PluginManifest, config: unknown): ActivationContext => ({
    config,
    ...(manifest.capabilities.includes("kv") ? { kv: keyValueStore(manifest.id) } : {}),
    ...(manifest.capabilities.includes("secrets") ? { secrets: pluginSecrets(manifest.id) } : {}),
  });

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
    manifest: PluginManifest,
    declared: Array<NewContribution>,
  ): Effect.Effect<PluginStatus> =>
    Effect.suspend(() => plugin.register(registrationHost(manifest, declared))).pipe(
      Effect.as<PluginStatus>({ _tag: "inactive" }),
      Effect.catchCause((cause) =>
        Effect.succeed<PluginStatus>({ _tag: "errored", message: messageOf(cause) }),
      ),
    );

  /**
   * Brings one plugin into line with what the user decided: started with the
   * config as it now stands, or stopped because the user disabled it.
   *
   * A stored config the plugin's schema no longer accepts leaves it errored
   * with the field named, because `activate` is specified to receive a decoded
   * config and there is nothing honest to hand it instead.
   */
  const refresh = (id: string, state: PluginState): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const entry = (yield* Ref.get(entries)).get(id);
      if (entry === undefined) return;
      // A plugin the process can no longer start stays as it is: starting it
      // would run a second instance beside whatever the last one left behind.
      if (!state.enabled || !entry.startable) {
        if (entry.startable) {
          yield* patch(id, { status: { _tag: "inactive" }, deactivate: undefined });
        }
        return;
      }

      const config = yield* decodeConfig(entry.manifest.configSchema, state.config);
      yield* Effect.suspend(() =>
        entry.plugin.activate(activationContext(entry.manifest, config)),
      ).pipe(
        Effect.matchCauseEffect({
          onSuccess: (deactivate) => patch(id, { status: { _tag: "active" }, deactivate }),
          onFailure: (cause) => markErrored(id, "activate", messageOf(cause)),
        }),
      );
    }).pipe(
      // A stored config the plugin's schema no longer reads is the same fact as
      // a refusal to start: the plugin cannot run, and the user is told which
      // setting is wrong.
      Effect.catchTag("SchemaError", (error) => markErrored(id, "activate", fieldMessage(error))),
    );

  /**
   * Stops one plugin, and answers whether it is now cleanly stopped. A
   * deactivate that failed leaves machinery behind that only a restart clears,
   * so the caller does not start the plugin again on top of it.
   */
  const stop = (id: string): Effect.Effect<boolean, SqlError> =>
    Effect.gen(function* () {
      const entry = (yield* Ref.get(entries)).get(id);
      if (entry === undefined) return true;
      if (entry.deactivate === undefined) {
        // Nothing is running, so the plugin is already stopped - unless an
        // earlier teardown failed, in which case what it left behind is not.
        if (entry.startable) yield* patch(id, { status: { _tag: "inactive" } });
        return entry.startable;
      }
      return yield* entry.deactivate.pipe(
        Effect.matchCauseEffect({
          onSuccess: () =>
            Effect.as(patch(id, { status: { _tag: "inactive" }, deactivate: undefined }), true),
          onFailure: (cause) => Effect.as(markErrored(id, "deactivate", messageOf(cause)), false),
        }),
      );
    });

  return {
    /**
     * Loads the registry: refuse, register, write the catalog, then activate
     * every plugin the user left enabled. A plugin that fails registration
     * keeps none of what it managed to declare, so the catalog never holds half
     * a plugin.
     *
     * Activation runs here rather than in the background, one plugin after
     * another: `boot` returning means the whole registry has been given its
     * chance, and one plugin's failure costs only that plugin.
     */
    boot: (registry: ReadonlyArray<Plugin>): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const booted = new Map<string, Entry>();
        const catalog: Array<NewContribution> = [];

        for (const [index, plugin] of registry.entries()) {
          // The decoded copy, and the only manifest anything reads afterwards:
          // what the plugin exposes may answer differently on a second read.
          const manifest = yield* decodeManifest(plugin.manifest, index);
          if (booted.has(manifest.id)) {
            // Ids namespace KV keys, secrets and contributions, so two plugins
            // sharing one would share all three. The registry is a file in this
            // binary, so this is a build mistake and not a runtime condition.
            return yield* Effect.die(
              new Error(`The plugin registry lists ${manifest.id} more than once.`),
            );
          }
          const facts = {
            plugin,
            manifest,
            deactivate: undefined,
            startable: true,
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
          const status = yield* registerPass(plugin, manifest, declared);
          const registered = status._tag !== "errored";
          if (registered) catalog.push(...declared);
          booted.set(manifest.id, {
            ...facts,
            // A plugin that failed to register contributed nothing, so there is
            // nothing for an `activate` to run against until the next boot.
            startable: registered,
            configSchema: inspected.success,
            status,
          });
        }

        const at = yield* nowIso;
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            yield* repository.ensure([...booted.keys()], at);
            yield* repository.rewriteCatalog(catalog);
          }),
        );
        yield* Ref.set(entries, booted);

        // Every booted id was given a row in the transaction just above, and
        // the column's `json_valid` check is what rules out a row that cannot
        // be read, so neither the missing row nor the decode is a real state.
        const states = yield* Effect.orDie(repository.states());
        yield* gate.withPermits(1)(
          Effect.forEach(
            [...booted].filter(([, entry]) => entry.status._tag === "inactive"),
            ([id]) => refresh(id, stateOf(states, id)),
            { discard: true },
          ),
        );
      }),

    /** Where a plugin stands, or `None` for an id this boot never saw. */
    status: (id: string): Effect.Effect<Option.Option<PluginStatus>> =>
      Effect.map(Ref.get(entries), (booted) => {
        const entry = booted.get(id);
        return entry === undefined ? Option.none() : Option.some(entry.status);
      }),

    /** Every plugin the last boot loaded, in registry order. */
    loaded: (): Effect.Effect<ReadonlyArray<LoadedPlugin>> =>
      Effect.map(Ref.get(entries), (booted) => [...booted.values()].map(exposed)),

    refresh,
    stop,

    /** Runs one whole move - its reads, its hooks and its writes - on its own. */
    serialized: <A, E, R>(move: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      gate.withPermits(1)(move),

    /**
     * Whether this process can still start the plugin, or whether what an
     * earlier hook left behind means only a restart will do.
     */
    startable: (id: string): Effect.Effect<boolean> =>
      Effect.map(Ref.get(entries), (booted) => booted.get(id)?.startable ?? false),

    /**
     * Reads a config the way `activate` will: against the plugin's own schema,
     * every issue at once, so the settings form can put each message under the
     * field it is about.
     */
    validate: (id: string, config: Schema.Json): Effect.Effect<void, Validation> =>
      Effect.flatMap(Ref.get(entries), (booted) => {
        const entry = booted.get(id);
        // Every caller has already read the plugin, so an id this boot never
        // saw is a mistake in the controller rather than a bad request.
        return entry === undefined
          ? Effect.die(new Error(`No plugin named ${id} was loaded.`))
          : Effect.asVoid(
              Effect.mapError(decodeConfig(entry.manifest.configSchema, config), validationOf),
            );
      }),
  };
});

export class PluginHost extends Context.Service<PluginHost, Effect.Success<typeof make>>()(
  "hydra/controller/plugins/PluginHost",
) {}

export const PluginHostLayer: Layer.Layer<
  PluginHost,
  never,
  SqlClient.SqlClient | Secrets | AuditLog
> = Layer.effect(PluginHost)(make);
