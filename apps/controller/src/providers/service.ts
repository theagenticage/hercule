/**
 * Provider instances as the API sees them: `provider.query`, `read`, `create`,
 * `update` and `delete`.
 *
 * An instance is a row plus the definition behind it. `displayName` and
 * `declared` are composed here from the provider the plugin registered, never
 * copied into the row, so they cannot go stale against the build.
 *
 * A row whose provider this build does not carry is not listed and not
 * readable: there is no definition to describe it with, and inventing one would
 * be claiming capabilities nothing can honour. The row stays, so a build that
 * carries the provider again finds the instance where it left it.
 *
 * Config is read against the provider's own Effect Schema, so a caller reaching
 * these methods without a transport is held to the same shape a request is.
 * Every mutation writes its audit entry in the same transaction as the row, and
 * names the instance so a live subscriber refetches exactly what changed.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { ProviderDefinition } from "@hydra/plugin-host";
import {
  Id,
  notFound,
  ProviderInstanceCreateInput,
  ProviderInstanceUpdateInput,
  validation,
  validationOf,
  type Forbidden,
  type NotFound,
  type ProviderInstance,
  type Unauthenticated,
  type Validation,
} from "@hydra/contract";
import { requireGrant, USER_ACTOR } from "../actor";
import { nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { PluginHost } from "../plugins";
import { providerRepository, type StoredInstance } from "./repository";

/** What identifies one instance, and what an edit does to it. */
const UpdateInput = Schema.Struct({ id: Id, ...ProviderInstanceUpdateInput.fields });

export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const Identified = Schema.Struct({ id: Id });

export type Identified = Schema.Schema.Type<typeof Identified>;

const decodeCreate = Schema.decodeUnknownEffect(ProviderInstanceCreateInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);
const decodeIdentified = Schema.decodeUnknownEffect(Identified);

const NO_SUCH_INSTANCE = "no such provider instance";

type ReadError = Unauthenticated | Forbidden | SqlError | Schema.SchemaError;

type CreateError = ReadError | Validation;

type WriteError = CreateError | NotFound;

/**
 * Every issue at once, so a form can put each message under its own field, and
 * an unnamed key is refused rather than dropped.
 */
const readConfig = (
  definition: ProviderDefinition,
  config: Schema.Json,
): Effect.Effect<void, Validation> =>
  Effect.asVoid(
    Effect.mapError(
      Schema.decodeUnknownEffect(definition.configSchema as Schema.Codec<unknown>, {
        errors: "all",
        onExcessProperty: "error",
      })(config),
      validationOf,
    ),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const instances = yield* providerRepository;
  const host = yield* PluginHost;
  const audit = yield* AuditLog;

  const definitions = Effect.map(
    host.providers(),
    (registered) => new Map(registered.map((definition) => [definition.id, definition])),
  );

  const compose = (stored: StoredInstance, definition: ProviderDefinition): ProviderInstance => ({
    ...stored,
    displayName: definition.displayName,
    declared: definition.declared,
    // Filled in once runners report what they found; nothing writes one yet.
    snapshots: [],
  });

  const all: Effect.Effect<
    ReadonlyArray<ProviderInstance>,
    SqlError | Schema.SchemaError
  > = Effect.gen(function* () {
    const known = yield* definitions;
    const stored = yield* instances.list();
    return stored.flatMap((row) => {
      const definition = known.get(row.providerId);
      return definition === undefined ? [] : [compose(row, definition)];
    });
  });

  /** One instance, without the grant check: a write has already been checked once. */
  const one = (
    id: string,
  ): Effect.Effect<ProviderInstance, NotFound | SqlError | Schema.SchemaError> =>
    Effect.gen(function* () {
      const known = yield* definitions;
      const stored = yield* instances.one(id);
      const found = Option.flatMap(stored, (row) =>
        Option.map(Option.fromNullishOr(known.get(row.providerId)), (definition) =>
          compose(row, definition),
        ),
      );
      return yield* Option.match(found, {
        onNone: () => Effect.fail(notFound(NO_SUCH_INSTANCE)),
        onSome: Effect.succeed,
      });
    });

  /** The provider a write names, or the refusal that says nothing registered it. */
  const provider = (id: string): Effect.Effect<ProviderDefinition, Validation | SqlError> =>
    Effect.flatMap(definitions, (known) => {
      const definition = known.get(id);
      return definition === undefined
        ? Effect.fail(validation([{ path: ["providerId"], message: `no plugin registered ${id}` }]))
        : Effect.succeed(definition);
    });

  return {
    query: (): Effect.Effect<ReadonlyArray<ProviderInstance>, ReadError> =>
      Effect.gen(function* () {
        yield* requireGrant("provider.query");
        return yield* all;
      }),

    read: (input: Identified): Effect.Effect<ProviderInstance, WriteError> =>
      Effect.gen(function* () {
        yield* requireGrant("provider.read");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        return yield* one(id);
      }),

    /** Opens a second account on a provider, or the first on one the boot missed. */
    create: (input: ProviderInstanceCreateInput): Effect.Effect<ProviderInstance, CreateError> =>
      Effect.gen(function* () {
        yield* requireGrant("provider.create");
        const decoded = yield* Effect.mapError(decodeCreate(input), validationOf);
        const definition = yield* provider(decoded.providerId);
        yield* readConfig(definition, decoded.config);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // Inside the transaction, because a provider that declines several
            // accounts must not end up with two by way of two calls at once.
            if (!definition.supportsMultipleInstances) {
              const existing = yield* instances.list();
              if (existing.some((row) => row.providerId === definition.id)) {
                return yield* Effect.fail(
                  validation([
                    {
                      path: ["providerId"],
                      message: `${definition.displayName} holds one account, and it already has one`,
                    },
                  ]),
                );
              }
            }
            // One clock read, inside the transaction: the row and the entry
            // that records it carry the same instant.
            const at = yield* nowIso;
            const stored = yield* instances.insert({ ...decoded, at });
            yield* audit.append({
              kind: "provider.created",
              actor: USER_ACTOR,
              payload: { instanceId: stored.id, providerId: stored.providerId },
              record: { topic: "provider", id: stored.id },
              at,
            });
            return compose(stored, definition);
          }),
        );
      }),

    /**
     * Renames an instance or gives it a new config. A patch that names no field
     * is refused: it would move `updatedAt` and stamp an entry describing
     * nothing.
     */
    update: (input: UpdateInput): Effect.Effect<ProviderInstance, WriteError> =>
      Effect.gen(function* () {
        yield* requireGrant("provider.update");
        const { id, ...patch } = yield* Effect.mapError(decodeUpdate(input), validationOf);
        if (Object.keys(patch).length === 0) {
          return yield* Effect.fail(validation([{ path: [], message: "name a field to change" }]));
        }
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const before = yield* one(id);
            if (patch.config !== undefined) {
              yield* Effect.flatMap(provider(before.providerId), (definition) =>
                readConfig(definition, patch.config as Schema.Json),
              );
            }
            yield* instances.update(id, patch, at);
            yield* audit.append({
              kind: "provider.updated",
              actor: USER_ACTOR,
              payload: { instanceId: id, fields: Object.keys(patch) },
              record: { topic: "provider", id },
              at,
            });
            // Read back rather than merge in memory: what the caller gets is
            // the row that was written, whatever the edit touched.
            return yield* one(id);
          }),
        );
      }),

    /**
     * Removes an instance and everything the fleet reported about it. The next
     * boot opens a fresh one when this was the provider's only instance.
     *
     * This works off the row rather than the composed instance, so a row left
     * behind by a build that no longer carries its provider is still something
     * the user can take away.
     */
    delete: (input: Identified): Effect.Effect<Record<string, never>, WriteError> =>
      Effect.gen(function* () {
        yield* requireGrant("provider.delete");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const stored = yield* Effect.flatMap(
              instances.one(id),
              Option.match({
                onNone: () => Effect.fail(notFound(NO_SUCH_INSTANCE)),
                onSome: Effect.succeed,
              }),
            );
            yield* instances.delete(id);
            // Names rather than the config document: the log is kept for months
            // and an instance's config is where a provider's secrets will live.
            yield* audit.append({
              kind: "provider.deleted",
              actor: USER_ACTOR,
              payload: { instanceId: id, providerId: stored.providerId, name: stored.name },
              record: { topic: "provider", id },
              at,
            });
            return {};
          }),
        );
      }),
  };
});

/** The provider instance service. */
export class ProviderService extends Context.Service<
  ProviderService,
  Effect.Success<typeof make>
>()("hydra/controller/providers/ProviderService") {}

export const ProviderServiceLayer: Layer.Layer<
  ProviderService,
  never,
  SqlClient.SqlClient | PluginHost | AuditLog
> = Layer.effect(ProviderService)(make);
