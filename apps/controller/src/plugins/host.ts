/**
 * The plugin host: loads the compiled-in registry at boot.
 *
 * Every manifest is read before any plugin code runs, so a plugin that cannot
 * be loaded cannot stop the boot. Registration has no side effects, so the
 * catalog is rewritten in full rather than diffed. Each plugin's status is
 * kept in memory only: `errored` is about this process, and the next boot
 * tries again.
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
  listSecretFields,
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
  createDecodeValidationError,
  type PluginRefusalReason,
  type PluginStatus,
  type Validation,
} from "@hercule/contract";
import { nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { currentStampOrSystem } from "../actor";
import { Secrets, type SecretOwner } from "../secrets";
// The types a plugin declares, and what it reaches its own connections through,
// both live in the connections domain: everything they touch is there. This is
// the only direction the two point in.
import { ConnectionTypes, PluginConfigs, type RegisteredConnectionType } from "../connections";
import { toPluginError, describeFieldIssues, truncateMessage } from "./errors";
import { registerEventSourceContribution, type RegisteredEventKind } from "./event-sources";
import { pluginRepository, type NewContribution } from "./repository";
import {
  CORE_CONTRIBUTION_OWNER,
  registerBuiltInWorkflowActions,
  registerWorkflowActionContribution,
  type RegisteredWorkflowAction,
} from "./workflow-actions";

/**
 * The capabilities this build implements. The manifest schema accepts every
 * capability name the system will ever have, so a plugin written for a later
 * build gets the `refused` status here, with the capability named, instead of
 * being activated without what it asked for.
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
  /** Absent for a `refused` plugin: the schema is derived only after the manifest is accepted. */
  readonly configSchema?: JsonSchema.JsonSchema;
  readonly status: PluginStatus;
}

interface Entry extends LoadedPlugin {
  readonly plugin: Plugin;
  /**
   * The decoded copy, never the plugin's own object: every scope is derived
   * from the id, and a getter on the plugin's object could return a different
   * id after it was checked.
   */
  readonly manifest: PluginManifest;
  readonly deactivate: Deactivate | undefined;
  /**
   * Whether this process may start the plugin. False after a failed
   * `register`, which left no contributions to run, or a failed teardown,
   * which left running parts a second `activate` would add to. Both need a
   * restart.
   */
  readonly startable: boolean;
}

const toLoadedPlugin = (entry: Entry): LoadedPlugin => ({
  id: entry.id,
  displayName: entry.displayName,
  hostApi: entry.hostApi,
  capabilities: entry.capabilities,
  ...(entry.configSchema === undefined ? {} : { configSchema: entry.configSchema }),
  status: entry.status,
});

/** The names of the extension points registered in this file. */
const PROVIDER = "provider";
const CONNECTION_TYPE = "connection-type";

// An unknown key fails the decode rather than being stripped: dropping a field
// the host does not know would make an unserializable value look accepted.
const decodeProvider = Schema.decodeUnknownEffect(ProviderDefinition, {
  errors: "all",
  onExcessProperty: "error",
});

// Decodes the serializable part of a connection type. `validate` is removed
// first: it is a function, and no catalog column can hold one.
const decodeConnectionType = Schema.decodeUnknownEffect(ConnectionType, {
  errors: "all",
  onExcessProperty: "error",
});

/**
 * Returns a one-line message for a failed plugin call: the `PluginError`'s
 * message, or the defect's message. Settings shows this line to the user, and
 * a whole stack trace would tell them less than its first sentence.
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
 * Dies when `value` is empty. A defect, not a failure: the API a plugin
 * programs against declares no error here, and the host treats either as that
 * plugin's crash.
 */
const assertNonEmpty = (what: string, value: string): Effect.Effect<void> =>
  value.length === 0
    ? Effect.die(new PluginError({ message: `A plugin ${what} cannot be empty.` }))
    : Effect.void;

/**
 * Returns a name for a manifest in an error message: its id, or its registry
 * position when the id is not a string. The id is the most useful name, but it
 * is also the field most likely to be invalid.
 */
const describeManifestName = (manifest: unknown, index: number): string => {
  const id = (manifest as { readonly id?: unknown } | null | undefined)?.id;
  return typeof id === "string" ? `"${id}"` : `at registry position ${String(index)}`;
};

/**
 * Decodes a plugin's manifest. Dies when it is invalid: a compiled-in plugin
 * with an invalid manifest is a build mistake, so it stops the boot with the
 * error, rather than being listed with the `refused` status.
 */
const decodeManifest = (manifest: unknown, index: number): Effect.Effect<PluginManifest> =>
  Schema.decodeUnknownEffect(PluginManifest, { errors: "all" })(manifest).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.die(
        new Error(
          `The plugin ${describeManifestName(manifest, index)} has an invalid manifest: ${describeFieldIssues(error)}`,
        ),
      ),
    ),
  );

/**
 * A credential is entered per provider instance and stored under that
 * instance as its owner, so a secret field anywhere else has nowhere to be
 * stored. This is reported at registration, because the form that would show
 * the field is built from the schema rejected here.
 */
const SECRET_FIELDS_ARE_PROVIDER_ONLY =
  "a secret-valued config field is supported on a provider definition only";

/**
 * Checks what can be decided from the manifest alone, before any plugin code
 * runs. Returns the config's JSON Schema, or the reason the plugin is
 * `refused`.
 */
const inspectManifest = (
  manifest: PluginManifest,
): Result.Result<JsonSchema.JsonSchema, PluginRefusalReason> => {
  if (manifest.hostApi !== HOST_API) {
    return Result.fail({ kind: "hostApi", expected: HOST_API, actual: manifest.hostApi });
  }
  const missing = manifest.capabilities.find((capability) => !IMPLEMENTED.includes(capability));
  if (missing !== undefined) {
    return Result.fail({ kind: "unimplementedCapability", capability: missing });
  }
  if (listSecretFields(manifest.configSchema).length > 0) {
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
 * Builds the registration API for one plugin, with only the capabilities its
 * manifest asks for. It offers registration only, so a plugin cannot reach
 * runtime services before the catalog exists. A duplicate contribution id is
 * caught in the caller's array, not by the primary key, where the failed
 * insert would lose every other plugin's rows too.
 *
 * A connection type's id joins the plugin's id and the type name it declared.
 * Two plugins may each declare a type `gmail` and still get two different
 * types, so no plugin can take a name from another.
 */
const buildRegistrationHost = (
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
                Effect.mapError(toPluginError),
              );
              // The catalog stores the derived JSON Schema: the plugin's Effect
              // Schema is an object no catalog reader can use.
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
              // The catalog cannot hold an Effect Schema, so the definition is
              // also kept in memory: decoding an instance's config needs the
              // plugin's Effect Schema, not the JSON Schema derived from it.
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
              // Everything except `validate`, which no JSON column can hold, so
              // it is kept in memory instead.
              const { validate, ...serializable } = contribution;
              const decoded = yield* decodeConnectionType(serializable).pipe(
                Effect.mapError(toPluginError),
              );
              // The id the catalog, the stored rows and every lookup use. Nothing
              // splits it again: a type's plugin is read from the entry
              // registered here, never parsed out of the id.
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
              // A config schema goes into the catalog as the JSON Schema the
              // generated form is built from. The Effect Schema stays in memory,
              // where a connection's stored config is decoded against it.
              if (
                decoded.configSchema !== undefined &&
                listSecretFields(decoded.configSchema).length > 0
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
              // The decoded copy, so the rest of the controller reads what the
              // schema accepted rather than the plugin's own object.
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
  // Not guarded by `gate`, unlike everything else here: registration has no
  // side effects and runs only at boot, so this does not change after boot.
  const providers = yield* Ref.make<ReadonlyArray<ProviderDefinition>>([]);
  /** Every event kind this boot registered, by name. Set at boot, like the providers. */
  const eventKinds = yield* Ref.make<ReadonlyMap<string, RegisteredEventKind>>(new Map());
  /**
   * Every workflow action this boot registered, built-in ones included, keyed
   * by the qualified id a step uses. Set at boot, like the providers.
   */
  const workflowActions = yield* Ref.make<ReadonlyMap<string, RegisteredWorkflowAction>>(new Map());
  /**
   * One permit for the whole host, held across a lifecycle change's reads,
   * plugin hooks and writes. Without it, two changes could interleave while
   * one waits inside a hook, and the second would act on state the first had
   * already changed. One permit per plugin would not be enough: a change
   * touches rows the whole host shares.
   */
  const gate = yield* Semaphore.make(1);

  const patchEntry = (id: string, change: Partial<Entry>): Effect.Effect<void> =>
    Ref.update(entries, (current) => {
      const entry = current.get(id);
      if (entry === undefined) return current;
      const next = new Map(current);
      next.set(id, { ...entry, ...change });
      return next;
    });

  /**
   * Returns the ids of the plugins that are running now. A plugin is active
   * only while it is enabled and its activation succeeded. Disabling a plugin
   * stops it before the enabled flag is written.
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
      yield* patchEntry(id, {
        status: { _tag: "errored", message },
        deactivate: undefined,
        // Whatever a failed teardown left behind is still running, so the
        // plugin must not start again until this process exits.
        ...(phase === "deactivate" ? { startable: false } : {}),
      });
      const at = yield* nowIso;
      // Activation during boot has no actor, so the entry is stamped with the
      // system rather than blaming whoever logged in last. Every other call
      // comes from a request, and is stamped with its actor.
      const actor = yield* currentStampOrSystem;
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
   * Builds a plugin's key-value store. A failed statement dies rather than
   * failing: the plugin API declares that these calls cannot fail, and a
   * plugin cannot do anything useful about a broken database.
   */
  const buildKeyValueStore = (pluginId: string): KeyValueStore => ({
    get: (key) =>
      Effect.andThen(assertNonEmpty("key", key), Effect.orDie(repository.kvGet(pluginId, key))),
    set: (key, value) =>
      Effect.andThen(
        assertNonEmpty("key", key),
        Effect.orDie(repository.kvSet(pluginId, key, value)),
      ),
    delete: (key) =>
      Effect.andThen(assertNonEmpty("key", key), Effect.orDie(repository.kvDelete(pluginId, key))),
    list: () => Effect.orDie(repository.kvKeys(pluginId)),
  });

  /** Builds a plugin's secret store. The owner is fixed here, so nothing a plugin passes can widen its scope. */
  const buildPluginSecrets = (pluginId: string): PluginSecrets => {
    const owner: SecretOwner = { kind: "plugin", id: pluginId };
    return {
      get: (name) =>
        Effect.andThen(assertNonEmpty("name", name), Effect.orDie(secrets.get(owner, name))),
      set: (name, value) =>
        Effect.andThen(
          assertNonEmpty("name", name),
          Effect.orDie(Effect.asVoid(secrets.set(owner, name, value))),
        ),
      delete: (name) =>
        Effect.andThen(
          assertNonEmpty("name", name),
          Effect.orDie(Effect.asVoid(secrets.delete(owner, name))),
        ),
      list: () =>
        Effect.map(Effect.orDie(secrets.refs(owner.kind, [owner.id])), (grouped) =>
          (grouped.get(owner.id) ?? []).map((ref) => ref.name),
        ),
    };
  };

  /** Builds the runtime APIs for the capabilities this manifest asks for, and no others. */
  const buildActivationContext = (
    manifest: PluginManifest,
    config: unknown,
  ): ActivationContext => ({
    config,
    ...(manifest.capabilities.includes("kv") ? { kv: buildKeyValueStore(manifest.id) } : {}),
    ...(manifest.capabilities.includes("secrets")
      ? { secrets: buildPluginSecrets(manifest.id) }
      : {}),
    ...(manifest.capabilities.includes("connections")
      ? { connections: connectionTypes.runtimeFor(manifest.id) }
      : {}),
  });

  /**
   * Runs a plugin's `register`, and returns its status: `inactive` on
   * success, `errored` otherwise. Catches a typed failure, a throw before the
   * Effect starts, and a crash inside it: plugin code is treated like
   * third-party code, and one plugin breaking must affect only that plugin.
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
      plugin.register(buildRegistrationHost(manifest, declared, live, types, kinds, actions)),
    ).pipe(
      Effect.as<PluginStatus>({ _tag: "inactive" }),
      Effect.catchCause((cause) =>
        Effect.succeed<PluginStatus>({ _tag: "errored", message: readCauseMessage(cause) }),
      ),
    );

  /**
   * Starts or stops one plugin to match its stored state: started when it is
   * enabled, stopped otherwise. A stored config the schema no longer accepts
   * marks the plugin errored, naming the field: `activate` needs a decoded
   * config, and there is no correct value to pass instead.
   */
  const refresh = (id: string): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const entry = (yield* Ref.get(entries)).get(id);
      if (entry === undefined) return;
      // Read here rather than passed in, so the plugin starts with the state
      // the database holds after the caller's write.
      const state = yield* Effect.catchTag(repository.state(id), "SchemaError", Effect.die);
      // Starting a plugin this process cannot start would run a second instance
      // next to whatever the last one left behind.
      if (!state.enabled || !entry.startable) {
        if (entry.startable) {
          yield* patchEntry(id, { status: { _tag: "inactive" }, deactivate: undefined });
        }
        return;
      }

      const config = yield* decodeAgainst(entry.manifest.configSchema, state.config);
      yield* Effect.suspend(() =>
        entry.plugin.activate(buildActivationContext(entry.manifest, config)),
      ).pipe(
        Effect.matchCauseEffect({
          onSuccess: (deactivate) => patchEntry(id, { status: { _tag: "active" }, deactivate }),
          onFailure: (cause) => markErrored(id, "activate", readCauseMessage(cause)),
        }),
      );
    }).pipe(
      Effect.catchTag("SchemaError", (error) =>
        markErrored(id, "activate", describeFieldIssues(error)),
      ),
    );

  /**
   * Stops one plugin. Returns whether it is cleanly stopped: a failed
   * deactivate leaves running parts that only a restart clears, and the
   * caller must not start the plugin again on top of them.
   */
  const stop = (id: string): Effect.Effect<boolean, SqlError> =>
    Effect.gen(function* () {
      const entry = (yield* Ref.get(entries)).get(id);
      if (entry === undefined) return true;
      if (entry.deactivate === undefined) {
        // Already stopped, unless an earlier teardown failed and left parts
        // running.
        if (entry.startable) yield* patchEntry(id, { status: { _tag: "inactive" } });
        return entry.startable;
      }
      return yield* entry.deactivate.pipe(
        Effect.matchCauseEffect({
          onSuccess: () =>
            Effect.as(
              patchEntry(id, { status: { _tag: "inactive" }, deactivate: undefined }),
              true,
            ),
          onFailure: (cause) =>
            Effect.as(markErrored(id, "deactivate", readCauseMessage(cause)), false),
        }),
      );
    });

  return {
    /**
     * Loads the registry in four steps: check each manifest, register, write
     * the catalog, then activate.
     *
     * A plugin that fails registration keeps none of what it declared, so the
     * catalog never holds half a plugin. Activation runs here rather than in
     * the background, so when `boot` returns, every plugin has been tried.
     */
    boot: (registry: ReadonlyArray<Plugin>): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const booted = new Map<string, Entry>();
        const catalog: Array<NewContribution> = [];
        const registeredProviders: Array<ProviderDefinition> = [];
        const registeredTypes: Array<RegisteredConnectionType> = [];
        const registeredKinds = new Map<string, RegisteredEventKind>();
        const registeredActions = new Map<string, RegisteredWorkflowAction>();
        // The built-in actions go into the same catalog as the plugins'
        // actions, so every reader finds all actions in one list.
        registerBuiltInWorkflowActions(catalog, registeredActions);

        for (const [index, plugin] of registry.entries()) {
          const manifest = yield* decodeManifest(plugin.manifest, index);
          if (booted.has(manifest.id)) {
            // The id scopes KV keys, secrets and contributions, so two plugins
            // with one id would share all three. The registry is compiled in,
            // so this is a build mistake.
            return yield* Effect.die(
              new Error(`The plugin registry lists ${manifest.id} more than once.`),
            );
          }
          if (manifest.id === CORE_CONTRIBUTION_OWNER) {
            // The built-in contributions are stored under this owner id. A
            // plugin with the same id would control whether they are enabled.
            return yield* Effect.die(
              new Error(
                `The plugin registry lists a plugin with the id ${CORE_CONTRIBUTION_OWNER}. ` +
                  "That id is reserved for the built-in contributions. Give the plugin another id.",
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

          const inspected = inspectManifest(manifest);
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

    /** Returns a plugin's status, or `None` for an id this boot did not load. */
    status: (id: string): Effect.Effect<Option.Option<PluginStatus>> =>
      Effect.map(Ref.get(entries), (booted) => {
        const entry = booted.get(id);
        return entry === undefined ? Option.none() : Option.some(entry.status);
      }),

    /** Returns every plugin the last boot loaded, in registry order. */
    loaded: (): Effect.Effect<ReadonlyArray<LoadedPlugin>> =>
      Effect.map(Ref.get(entries), (booted) => [...booted.values()].map(toLoadedPlugin)),

    /** Returns every provider this boot registered, in registry order. */
    providers: (): Effect.Effect<ReadonlyArray<ProviderDefinition>> => Ref.get(providers),

    /** Returns every event kind this boot registered, by name. */
    eventKinds: (): Effect.Effect<ReadonlyMap<string, RegisteredEventKind>> => Ref.get(eventKinds),

    /**
     * Returns the event kinds of every active plugin. A trigger can use only
     * these kinds. A plugin that is disabled, or that failed to start, ingests
     * no events, so a trigger on one of its kinds could never match.
     */
    listActiveEventKinds: (): Effect.Effect<ReadonlyArray<RegisteredEventKind>> =>
      Effect.map(Effect.zip(Ref.get(eventKinds), listActivePluginIds), ([kinds, active]) =>
        [...kinds.values()].filter((kind) => active.has(kind.pluginId)),
      ),

    /**
     * Returns the workflow actions a step can call, sorted by id: the built-in
     * actions and the actions of every active plugin. The actions of a plugin
     * that is disabled, or that failed to start, are left out, because the
     * plugin is not running to execute them.
     */
    listActiveWorkflowActions: (): Effect.Effect<ReadonlyArray<RegisteredWorkflowAction>> =>
      Effect.map(Effect.zip(Ref.get(workflowActions), listActivePluginIds), ([actions, active]) =>
        [...actions.values()]
          .filter((action) => action.owner === CORE_CONTRIBUTION_OWNER || active.has(action.owner))
          .sort((left, right) => left.id.localeCompare(right.id)),
      ),

    /**
     * Returns the qualified names of the Connection types of every active
     * plugin. A workflow input can take a Connection of only these types,
     * because a plugin that is disabled, or that failed to start, cannot act
     * through its Connections.
     */
    listActiveConnectionTypes: (): Effect.Effect<ReadonlyArray<string>> =>
      Effect.map(Effect.zip(connectionTypes.list(), listActivePluginIds), ([types, active]) =>
        types.filter((type) => active.has(type.pluginId)).map((type) => type.contribution.type),
      ),

    refresh,
    stop,

    serialized: <A, E, R>(move: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      gate.withPermits(1)(move),

    /** Checks whether this process can still start the plugin, or only a restart can. */
    startable: (id: string): Effect.Effect<boolean> =>
      Effect.map(Ref.get(entries), (booted) => booted.get(id)?.startable ?? false),

    /** Validates a config the way `activate` decodes it, without starting the plugin. */
    validate: (id: string, config: Schema.Json): Effect.Effect<void, Validation> =>
      Effect.flatMap(Ref.get(entries), (booted) => {
        const entry = booted.get(id);
        // Every caller has already read the plugin, so an unknown id is a
        // mistake in the controller rather than a bad request.
        return entry === undefined
          ? Effect.die(new Error(`No plugin named ${id} was loaded.`))
          : Effect.asVoid(
              Effect.mapError(
                decodeAgainst(entry.manifest.configSchema, config),
                createDecodeValidationError,
              ),
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
 * Provides the connections domain's `PluginConfigs` service, which reads a
 * plugin's stored config. The plugins domain owns the table, so it provides
 * the service. The interface is declared in the connections domain, so the
 * connections domain does not import this one.
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
