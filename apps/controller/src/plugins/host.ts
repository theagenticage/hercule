/**
 * The plugin host: what a boot makes of the compiled-in registry.
 *
 * Every manifest is read before any plugin code runs, so a plugin that cannot
 * be loaded cannot take the boot with it. Registration is pure, so the catalog
 * is rewritten whole rather than diffed, and what a boot found stays in memory:
 * `errored` is a fact about this process, and the next boot is the retry.
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
  deriveConfigJsonSchema,
  ConnectionType,
  decodeAgainst,
  HOST_API,
  PluginError,
  PluginManifest,
  ProviderDefinition,
  secretFields,
  type ActivationContext,
  type ConnectionTypeContribution,
  type Deactivate,
  type KeyValueStore,
  type Plugin,
  type PluginCapability,
  type PluginSecrets,
  type RegistrationHost,
} from "@hercule/plugin-host";
import {
  validationOf,
  type PluginRefusalReason,
  type PluginStatus,
  type Validation,
} from "@hercule/contract";
import { nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { CurrentActor, stampOf, SYSTEM_ACTOR } from "../actor";
import { Secrets, type SecretOwner } from "../secrets";
// The types a plugin declares, and what it reaches its own connections through,
// both live in the connections domain: everything they touch is there. This is
// the only direction the two point in.
import { ConnectionTypes, PluginConfigs, type RegisteredConnectionType } from "../connections";
import { asPluginError, describeFieldIssues, truncateMessage } from "./errors";
import { registerEventSourceContribution, type RegisteredEventKind } from "./event-sources";
import { pluginRepository, type NewContribution } from "./repository";
import {
  CORE_CONTRIBUTION_OWNER,
  registerBuiltInWorkflowActions,
  registerWorkflowActionContribution,
  type RegisteredWorkflowAction,
} from "./workflow-actions";

/**
 * The manifest schema accepts every capability name the system will ever have,
 * so a plugin written against a later build is refused by name here rather than
 * activated without the surface it asked for.
 */
const IMPLEMENTED: ReadonlyArray<PluginCapability> = [
  "providers",
  "kv",
  "secrets",
  "connections",
  "event-sources",
  "workflow-actions",
];

export interface LoadedPlugin {
  readonly id: string;
  readonly displayName: string;
  readonly hostApi: number;
  readonly capabilities: ReadonlyArray<PluginCapability>;
  /** Absent for a refused plugin: the schema is derived only once the manifest is accepted. */
  readonly configSchema?: JsonSchema.JsonSchema;
  readonly status: PluginStatus;
}

interface Entry extends LoadedPlugin {
  readonly plugin: Plugin;
  /**
   * The decoded copy, never the object the plugin exposes: every scope is
   * derived from the id, and a getter could answer differently once checked.
   */
  readonly manifest: PluginManifest;
  readonly deactivate: Deactivate | undefined;
  /**
   * A failed `register` left no contributions to run against, and a failed
   * teardown left machinery a second `activate` would pile on. Both need a restart.
   */
  readonly startable: boolean;
}

const exposed = (entry: Entry): LoadedPlugin => ({
  id: entry.id,
  displayName: entry.displayName,
  hostApi: entry.hostApi,
  capabilities: entry.capabilities,
  ...(entry.configSchema === undefined ? {} : { configSchema: entry.configSchema }),
  status: entry.status,
});

/** The extension points with a consumer; the column takes any name. */
const PROVIDER = "provider";
const CONNECTION_TYPE = "connection-type";

// An excess key is refused rather than stripped: dropping a field the host does
// not know would let an unserializable value look accepted.
const decodeProvider = Schema.decodeUnknownEffect(ProviderDefinition, {
  errors: "all",
  onExcessProperty: "error",
});

// The serializable half of a connection type. `validate` is taken off first:
// it is a function, and no catalog column can hold one.
const decodeConnectionType = Schema.decodeUnknownEffect(ConnectionType, {
  errors: "all",
  onExcessProperty: "error",
});

/**
 * One line either way, because this is shown to the user in Settings, where a
 * stack trace would say less than the sentence at the top of it.
 */
const readCauseMessage = (cause: Cause.Cause<PluginError>): string =>
  truncateMessage(
    Option.match(Cause.findErrorOption(cause), {
      onSome: (error) => error.message,
      onNone: () => {
        const defect = Cause.squash(cause);
        return defect instanceof Error ? defect.message : String(defect);
      },
    }),
  );

/**
 * A defect, not a failure: the surface a plugin programs against declares no
 * error, and the host catches it as that plugin's crash either way.
 */
const named = (what: string, value: string): Effect.Effect<void> =>
  value.length === 0
    ? Effect.die(new PluginError({ message: `A plugin ${what} cannot be empty.` }))
    : Effect.void;

/**
 * The claimed id is the useful half, but it is also the field most likely to be
 * what is wrong, so a non-string id falls back to the registry position.
 */
const nameOf = (manifest: unknown, index: number): string => {
  const id = (manifest as { readonly id?: unknown } | null | undefined)?.id;
  return typeof id === "string" ? `"${id}"` : `at registry position ${String(index)}`;
};

/**
 * A compiled-in plugin whose manifest does not decode is a build mistake, so it
 * stops the boot naming what is wrong rather than being listed as refused.
 */
const decodeManifest = (manifest: unknown, index: number): Effect.Effect<PluginManifest> =>
  Schema.decodeUnknownEffect(PluginManifest, { errors: "all" })(manifest).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.die(
        new Error(
          `The plugin ${nameOf(manifest, index)} has an invalid manifest: ${describeFieldIssues(error)}`,
        ),
      ),
    ),
  );

/**
 * A credential is entered per provider instance and stored under that
 * instance's own owner, so a secret-valued field has nowhere to live anywhere
 * else. Said at registration, because the form that would render it is built
 * from the schema refused here.
 */
const SECRET_FIELDS_ARE_PROVIDER_ONLY =
  "a secret-valued config field is supported on a provider definition only";

/** Everything decided from the manifest alone, before any plugin code runs. */
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
  if (secretFields(manifest.configSchema).length > 0) {
    return Result.fail({
      kind: "unsupportedConfigSchema",
      message: truncateMessage(`the plugin's own config: ${SECRET_FIELDS_ARE_PROVIDER_ONLY}`),
    });
  }
  return Result.mapError(deriveConfigJsonSchema(manifest.configSchema), (error) => ({
    kind: "unsupportedConfigSchema",
    message: truncateMessage(error.message),
  }));
};

/**
 * Registration surfaces only, so a plugin cannot reach runtime machinery before
 * the catalog exists. A duplicate contribution id is caught against the
 * caller's array, not the primary key, where it would take every other
 * plugin's rows with it.
 *
 * A connection type is identified by the plugin's id and the word it declared,
 * joined: two plugins may each call a type `gmail` and still name two different
 * things, so no plugin can claim a word out from under another.
 */
const registrationHost = (
  manifest: PluginManifest,
  declared: Array<NewContribution>,
  live: Array<ProviderDefinition>,
  types: Array<RegisteredConnectionType>,
  kinds: Map<string, RegisteredEventKind>,
  actions: Map<string, RegisteredWorkflowAction>,
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
              // authored is a live Effect Schema no catalog reader can use.
              const configSchema = deriveConfigJsonSchema(decoded.configSchema);
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
              // The catalog cannot carry an Effect Schema, so the definition
              // stays here too: reading an instance's config back needs the
              // live schema the plugin authored, not the JSON Schema it maps to.
              live.push(decoded);
            }),
        },
      }
    : {}),
  ...(manifest.capabilities.includes("connections")
    ? {
        connections: {
          registerType: (contribution: ConnectionTypeContribution) =>
            Effect.gen(function* () {
              // Everything but `validate`, which no JSON column can hold and
              // which stays in memory here instead.
              const { validate, ...serializable } = contribution;
              const decoded = yield* decodeConnectionType(serializable).pipe(
                Effect.mapError(asPluginError),
              );
              // The identity the catalog, the stored rows and every lookup use.
              // Nothing splits it again: the plugin a type belongs to is read
              // from the entry registered here, never parsed back out.
              const type = `${manifest.id}/${decoded.type}`;
              if (
                declared.some((row) => row.extensionPoint === CONNECTION_TYPE && row.id === type)
              ) {
                return yield* Effect.fail(
                  new PluginError({
                    message: `the ${CONNECTION_TYPE} contribution ${type} is registered twice`,
                  }),
                );
              }
              // A declared config schema reaches the catalog as the JSON Schema
              // the generated form is built from; the live schema stays here,
              // where a connection's stored config is decoded against it.
              if (
                decoded.configSchema !== undefined &&
                secretFields(decoded.configSchema).length > 0
              ) {
                return yield* Effect.fail(
                  new PluginError({
                    message: `the connection type ${type}: ${SECRET_FIELDS_ARE_PROVIDER_ONLY}`,
                  }),
                );
              }
              const configSchema =
                decoded.configSchema === undefined
                  ? undefined
                  : deriveConfigJsonSchema(decoded.configSchema);
              if (configSchema !== undefined && Result.isFailure(configSchema)) {
                return yield* Effect.fail(
                  new PluginError({
                    message: `the connection type ${type}: ${configSchema.failure.message}`,
                  }),
                );
              }
              declared.push({
                owner: manifest.id,
                extensionPoint: CONNECTION_TYPE,
                id: type,
                definition: {
                  ...decoded,
                  type,
                  ...(configSchema === undefined ? {} : { configSchema: configSchema.success }),
                },
              });
              // The decoded copy, so what the rest of the controller reads is
              // what the schema accepted rather than the object a plugin holds.
              types.push({
                pluginId: manifest.id,
                contribution: { ...decoded, type, validate },
              });
            }),
        },
      }
    : {}),
  ...(manifest.capabilities.includes("event-sources")
    ? {
        eventSources: {
          register: (definition) =>
            registerEventSourceContribution(manifest.id, definition, declared, kinds),
        },
      }
    : {}),
  ...(manifest.capabilities.includes("workflow-actions")
    ? {
        workflowActions: {
          register: (contribution) =>
            registerWorkflowActionContribution(manifest.id, contribution, declared, actions),
        },
      }
    : {}),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* pluginRepository;
  const secrets = yield* Secrets;
  const connectionTypes = yield* ConnectionTypes;
  const audit = yield* AuditLog;
  const entries = yield* Ref.make<ReadonlyMap<string, Entry>>(new Map());
  // Outside `gate`, unlike everything else here: registration is pure and runs
  // only at boot, so this is settled for the life of the process.
  const providers = yield* Ref.make<ReadonlyArray<ProviderDefinition>>([]);
  /** Every event kind this boot registered, by name. Settled with the providers. */
  const eventKinds = yield* Ref.make<ReadonlyMap<string, RegisteredEventKind>>(new Map());
  /**
   * Every workflow action this boot registered, the built-in ones included, by
   * the id a step names it by. Settled with the providers.
   */
  const workflowActions = yield* Ref.make<ReadonlyMap<string, RegisteredWorkflowAction>>(new Map());
  /**
   * One permit for the whole host, held across a move's reads, hooks and
   * writes. Without it two moves interleave around the await inside a hook and
   * the second decides on what the first already changed. A permit per plugin
   * would not do: a move touches rows the whole host shares.
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
   * The plugins that run now. A plugin is active only while it is enabled and
   * its activation succeeded: a disable stops it before the flag is written.
   */
  const listActivePluginIds: Effect.Effect<ReadonlySet<string>> = Effect.map(
    Ref.get(entries),
    (booted) =>
      new Set(
        [...booted.values()]
          .filter((entry) => entry.status._tag === "active")
          .map((entry) => entry.id),
      ),
  );

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
        // start the plugin again until this process is gone.
        ...(phase === "deactivate" ? { startable: false } : {}),
      });
      const at = yield* nowIso;
      // The boot's own activation pass has no actor behind it, so the row says
      // what caused it rather than blaming whoever logged in last. Anything
      // else got here through a request, and is stamped with who made it.
      const actor = yield* Effect.map(CurrentActor, (who) =>
        who._tag === "none" ? SYSTEM_ACTOR : stampOf(who),
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
   * A refused statement dies rather than failing: the surface a plugin programs
   * against says these cannot fail, and a plugin cannot act on a broken database.
   */
  const keyValueStore = (pluginId: string): KeyValueStore => ({
    get: (key) => Effect.andThen(named("key", key), Effect.orDie(repository.kvGet(pluginId, key))),
    set: (key, value) =>
      Effect.andThen(named("key", key), Effect.orDie(repository.kvSet(pluginId, key, value))),
    delete: (key) =>
      Effect.andThen(named("key", key), Effect.orDie(repository.kvDelete(pluginId, key))),
    list: () => Effect.orDie(repository.kvKeys(pluginId)),
  });

  /** The owner is fixed here, so nothing a plugin passes can widen its scope. */
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
      list: () =>
        Effect.map(Effect.orDie(secrets.refs(owner.kind, [owner.id])), (grouped) =>
          (grouped.get(owner.id) ?? []).map((ref) => ref.name),
        ),
    };
  };

  /** The runtime surfaces of the capabilities this manifest asked for, and no others. */
  const activationContext = (manifest: PluginManifest, config: unknown): ActivationContext => ({
    config,
    ...(manifest.capabilities.includes("kv") ? { kv: keyValueStore(manifest.id) } : {}),
    ...(manifest.capabilities.includes("secrets") ? { secrets: pluginSecrets(manifest.id) } : {}),
    ...(manifest.capabilities.includes("connections")
      ? { connections: connectionTypes.runtimeFor(manifest.id) }
      : {}),
  });

  /**
   * Catches a typed failure, a throw before the Effect, and a crash inside one:
   * a plugin is third-party-shaped code, and one breaking must cost only it.
   */
  const registerPass = (
    plugin: Plugin,
    manifest: PluginManifest,
    declared: Array<NewContribution>,
    live: Array<ProviderDefinition>,
    types: Array<RegisteredConnectionType>,
    kinds: Map<string, RegisteredEventKind>,
    actions: Map<string, RegisteredWorkflowAction>,
  ): Effect.Effect<PluginStatus> =>
    Effect.suspend(() =>
      plugin.register(registrationHost(manifest, declared, live, types, kinds, actions)),
    ).pipe(
      Effect.as<PluginStatus>({ _tag: "inactive" }),
      Effect.catchCause((cause) =>
        Effect.succeed<PluginStatus>({ _tag: "errored", message: readCauseMessage(cause) }),
      ),
    );

  /**
   * Brings one plugin into line with what the user decided. A stored config the
   * schema no longer accepts leaves it errored with the field named: `activate`
   * takes a decoded config, and there is nothing honest to hand it instead.
   */
  const refresh = (id: string): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const entry = (yield* Ref.get(entries)).get(id);
      if (entry === undefined) return;
      // Read here rather than passed in, so the plugin starts on what the
      // database holds after the caller's own write.
      const state = yield* Effect.catchTag(repository.state(id), "SchemaError", Effect.die);
      // Starting a plugin this process cannot start would run a second instance
      // beside whatever the last one left behind.
      if (!state.enabled || !entry.startable) {
        if (entry.startable) {
          yield* patch(id, { status: { _tag: "inactive" }, deactivate: undefined });
        }
        return;
      }

      const config = yield* decodeAgainst(entry.manifest.configSchema, state.config);
      yield* Effect.suspend(() =>
        entry.plugin.activate(activationContext(entry.manifest, config)),
      ).pipe(
        Effect.matchCauseEffect({
          onSuccess: (deactivate) => patch(id, { status: { _tag: "active" }, deactivate }),
          onFailure: (cause) => markErrored(id, "activate", readCauseMessage(cause)),
        }),
      );
    }).pipe(
      Effect.catchTag("SchemaError", (error) =>
        markErrored(id, "activate", describeFieldIssues(error)),
      ),
    );

  /**
   * Answers whether the plugin is cleanly stopped: a failed deactivate leaves
   * machinery only a restart clears, and the caller must not start over it.
   */
  const stop = (id: string): Effect.Effect<boolean, SqlError> =>
    Effect.gen(function* () {
      const entry = (yield* Ref.get(entries)).get(id);
      if (entry === undefined) return true;
      if (entry.deactivate === undefined) {
        // Already stopped - unless an earlier teardown failed, in which case
        // what it left behind is not.
        if (entry.startable) yield* patch(id, { status: { _tag: "inactive" } });
        return entry.startable;
      }
      return yield* entry.deactivate.pipe(
        Effect.matchCauseEffect({
          onSuccess: () =>
            Effect.as(patch(id, { status: { _tag: "inactive" }, deactivate: undefined }), true),
          onFailure: (cause) =>
            Effect.as(markErrored(id, "deactivate", readCauseMessage(cause)), false),
        }),
      );
    });

  return {
    /**
     * Refuse, register, write the catalog, then activate. A plugin that fails
     * registration keeps none of what it declared, so the catalog never holds
     * half a plugin, and activation runs here rather than in the background, so
     * `boot` returning means the whole registry has had its chance.
     */
    boot: (registry: ReadonlyArray<Plugin>): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const booted = new Map<string, Entry>();
        const catalog: Array<NewContribution> = [];
        const registeredProviders: Array<ProviderDefinition> = [];
        const registeredTypes: Array<RegisteredConnectionType> = [];
        const registeredKinds = new Map<string, RegisteredEventKind>();
        const registeredActions = new Map<string, RegisteredWorkflowAction>();
        // The core's own actions go first and into the same catalog, so every
        // reader finds the built-in actions and the plugins' actions in one list.
        registerBuiltInWorkflowActions(catalog, registeredActions);

        for (const [index, plugin] of registry.entries()) {
          const manifest = yield* decodeManifest(plugin.manifest, index);
          if (booted.has(manifest.id)) {
            // Ids namespace KV keys, secrets and contributions, so two plugins
            // sharing one share all three. The registry is compiled in.
            return yield* Effect.die(
              new Error(`The plugin registry lists ${manifest.id} more than once.`),
            );
          }
          if (manifest.id === CORE_CONTRIBUTION_OWNER) {
            // The core owns the built-in contributions under this id, and a
            // plugin row with it would decide whether they are enabled.
            return yield* Effect.die(
              new Error(
                `The plugin registry lists a plugin with the id ${CORE_CONTRIBUTION_OWNER}. ` +
                  "The core owns its built-in contributions under that id, so no plugin can have it. Give the plugin another id.",
              ),
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
          const live: Array<ProviderDefinition> = [];
          const types: Array<RegisteredConnectionType> = [];
          const kinds = new Map<string, RegisteredEventKind>();
          const actions = new Map<string, RegisteredWorkflowAction>();
          const status = yield* registerPass(
            plugin,
            manifest,
            declared,
            live,
            types,
            kinds,
            actions,
          );
          const registered = status._tag !== "errored";
          if (registered) {
            catalog.push(...declared);
            registeredProviders.push(...live);
            registeredTypes.push(...types);
            for (const [kind, entry] of kinds) registeredKinds.set(kind, entry);
            for (const [id, action] of actions) registeredActions.set(id, action);
          }
          booted.set(manifest.id, {
            ...facts,
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
        yield* Ref.set(providers, registeredProviders);
        yield* Ref.set(eventKinds, registeredKinds);
        yield* Ref.set(workflowActions, registeredActions);
        yield* connectionTypes.replace(registeredTypes);

        yield* gate.withPermits(1)(
          Effect.forEach(
            [...booted].filter(([, entry]) => entry.status._tag === "inactive"),
            ([id]) => refresh(id),
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

    /** Every provider this boot registered, in registry order. */
    providers: (): Effect.Effect<ReadonlyArray<ProviderDefinition>> => Ref.get(providers),

    /** Every event kind this boot registered, by name. */
    eventKinds: (): Effect.Effect<ReadonlyMap<string, RegisteredEventKind>> => Ref.get(eventKinds),

    /**
     * The event kinds of every active plugin. A trigger can name only these:
     * the event sources of a plugin that is disabled, or that did not start,
     * ingest nothing, so a trigger on one of their kinds could never match.
     */
    listActiveEventKinds: (): Effect.Effect<ReadonlyArray<RegisteredEventKind>> =>
      Effect.map(Effect.zip(Ref.get(eventKinds), listActivePluginIds), ([kinds, active]) =>
        [...kinds.values()].filter((kind) => active.has(kind.pluginId)),
      ),

    /**
     * The workflow actions a step can name, ordered by id: the built-in ones,
     * and those of every active plugin. The action of a plugin that is disabled,
     * or that did not start, has nothing running behind it to call.
     */
    listActiveWorkflowActions: (): Effect.Effect<ReadonlyArray<RegisteredWorkflowAction>> =>
      Effect.map(Effect.zip(Ref.get(workflowActions), listActivePluginIds), ([actions, active]) =>
        [...actions.values()]
          .filter((action) => action.owner === CORE_CONTRIBUTION_OWNER || active.has(action.owner))
          .sort((left, right) => left.id.localeCompare(right.id)),
      ),

    /**
     * The qualified name of each Connection type of every active plugin. A
     * workflow input can take a Connection of only these types: a plugin that
     * is disabled, or that did not start, acts through none of its
     * Connections.
     */
    listActiveConnectionTypes: (): Effect.Effect<ReadonlyArray<string>> =>
      Effect.map(Effect.zip(connectionTypes.list(), listActivePluginIds), ([types, active]) =>
        types.filter((type) => active.has(type.pluginId)).map((type) => type.contribution.type),
      ),

    refresh,
    stop,

    serialized: <A, E, R>(move: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      gate.withPermits(1)(move),

    /** Whether this process can still start the plugin, or only a restart will do. */
    startable: (id: string): Effect.Effect<boolean> =>
      Effect.map(Ref.get(entries), (booted) => booted.get(id)?.startable ?? false),

    /** Reads a config the way `activate` will, without starting the plugin. */
    validate: (id: string, config: Schema.Json): Effect.Effect<void, Validation> =>
      Effect.flatMap(Ref.get(entries), (booted) => {
        const entry = booted.get(id);
        // Every caller has already read the plugin, so an unknown id is a
        // mistake in the controller rather than a bad request.
        return entry === undefined
          ? Effect.die(new Error(`No plugin named ${id} was loaded.`))
          : Effect.asVoid(
              Effect.mapError(decodeAgainst(entry.manifest.configSchema, config), validationOf),
            );
      }),
  };
});

export class PluginHost extends Context.Service<PluginHost, Effect.Success<typeof make>>()(
  "hercule/controller/plugins/PluginHost",
) {}

export const PluginHostLayer: Layer.Layer<
  PluginHost,
  never,
  SqlClient.SqlClient | Secrets | AuditLog | ConnectionTypes
> = Layer.effect(PluginHost)(make);

/**
 * What the connections domain reads of a plugin's config, provided by the
 * domain that owns the table. The seam is declared there, so nothing in this
 * direction reaches back into it.
 */
export const PluginConfigsLayer: Layer.Layer<PluginConfigs, never, SqlClient.SqlClient> =
  Layer.effect(PluginConfigs)(
    Effect.map(pluginRepository, (repository) => ({
      of: (id: string) =>
        Effect.map(
          Effect.catchTag(repository.state(id), "SchemaError", Effect.die),
          (state) => state.config,
        ),
    })),
  );
