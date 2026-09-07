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
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { ProviderDefinition } from "@hydra/plugin-host";
import type { LoginCode, LoginFailed, LoginResult, LoginStart, LoginUrl } from "@hydra/protocol";
import {
  invalidState,
  Id,
  notFound,
  ProviderInstanceCreateInput,
  ProviderInstanceUpdateInput,
  ProviderLoginCodeInput,
  ProviderLoginInput,
  validation,
  validationOf,
  type CapabilitySnapshot,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type ProviderInstance,
  type Unauthenticated,
  type Validation,
} from "@hydra/contract";
import { requireGrant, USER_ACTOR } from "../actor";
import { nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { PluginHost } from "../plugins";
// The two runner modules directly rather than the domain's index: the runner
// service reaches this domain, so going through it would close a cycle.
import { requireAdapter } from "../runners/adapters";
import { RunnerPresence, type Answer } from "../runners/presence";
import { runnerRepository } from "../runners/repository";
import { ProviderProbes, ProviderProbeDeadline } from "./probes";
import { providerRepository, type StoredInstance, type StoredSnapshot } from "./repository";
import { floorFor, versionVerdict } from "./version";

/**
 * How long the machine has to print the vendor's URL. The user is watching a
 * dialog, and a cold CLI reaching the vendor is what takes the time.
 */
const LOGIN_DEADLINE: Duration.Duration = Duration.seconds(30);

/** Tests hand over a deadline they can wait out. */
export const ProviderLoginDeadline = Context.Reference<Duration.Duration>(
  "hydra/controller/providers/ProviderLoginDeadline",
  { defaultValue: (): Duration.Duration => LOGIN_DEADLINE },
);

/**
 * How long the pasted code has. Longer than the URL's wait because this one
 * covers the vendor's own exchange with its server: giving up early would tell
 * the user a login failed that in fact wrote a credential.
 */
const LOGIN_CODE_DEADLINE: Duration.Duration = Duration.minutes(2);

/** Which machine a login runs on. The credential lands on that machine alone. */
const LoginInput = Schema.Struct({ id: Id, ...ProviderLoginInput.fields });

export type LoginInput = Schema.Schema.Type<typeof LoginInput>;

const LoginCodeInput = Schema.Struct({ id: Id, ...ProviderLoginCodeInput.fields });

export type LoginCodeInput = Schema.Schema.Type<typeof LoginCodeInput>;

/** What identifies one instance, and what an edit does to it. */
const UpdateInput = Schema.Struct({ id: Id, ...ProviderInstanceUpdateInput.fields });

export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const Identified = Schema.Struct({ id: Id });

export type Identified = Schema.Schema.Type<typeof Identified>;

const decodeCreate = Schema.decodeUnknownEffect(ProviderInstanceCreateInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);
const decodeIdentified = Schema.decodeUnknownEffect(Identified);
const decodeLogin = Schema.decodeUnknownEffect(LoginInput);
const decodeLoginCode = Schema.decodeUnknownEffect(LoginCodeInput);

const NO_SUCH_INSTANCE = "no such provider instance";

type ReadError = Unauthenticated | Forbidden | SqlError | Schema.SchemaError;

type CreateError = ReadError | Validation;

type WriteError = CreateError | NotFound;

type LoginError = WriteError | InvalidState;

/** What a runner answers a login frame with. */
type LoginAnswer = LoginUrl | LoginFailed | LoginResult;

const isLoginAnswer = (answer: Answer): answer is LoginAnswer =>
  answer._tag === "loginUrl" || answer._tag === "loginFailed" || answer._tag === "loginResult";

/** The machine's own words for why the exchange stopped. */
const refusalIn = (answer: LoginAnswer): string =>
  answer._tag === "loginFailed" ? answer.message : "the login did not answer with a URL";

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
  const probes = yield* ProviderProbes;
  const presence = yield* RunnerPresence;
  const runners = yield* runnerRepository;

  const definitions = Effect.map(
    host.providers(),
    (registered) => new Map(registered.map((definition) => [definition.id, definition])),
  );

  const compose = (
    stored: StoredInstance,
    definition: ProviderDefinition,
    snapshots: ReadonlyArray<StoredSnapshot>,
  ): ProviderInstance => ({
    ...stored,
    displayName: definition.displayName,
    binaryName: definition.binaryName,
    declared: definition.declared,
    snapshots: snapshots
      .filter((snapshot) => snapshot.instanceId === stored.id)
      .map((snapshot) => ({
        runnerId: snapshot.runnerId,
        probedAt: snapshot.probedAt,
        harnessVersion: snapshot.harnessVersion,
        versionVerdict: versionVerdict(snapshot.harnessVersion, floorFor(stored.providerId)),
        auth: snapshot.auth,
        models: snapshot.models,
      })),
  });

  const all: Effect.Effect<
    ReadonlyArray<ProviderInstance>,
    SqlError | Schema.SchemaError
  > = Effect.gen(function* () {
    const known = yield* definitions;
    const stored = yield* instances.list();
    const snapshots = yield* instances.snapshots();
    return stored.flatMap((row) => {
      const definition = known.get(row.providerId);
      return definition === undefined ? [] : [compose(row, definition, snapshots)];
    });
  });

  /** One instance, without the grant check: a write has already been checked once. */
  const one = (
    id: string,
  ): Effect.Effect<ProviderInstance, NotFound | SqlError | Schema.SchemaError> =>
    Effect.gen(function* () {
      const known = yield* definitions;
      const stored = yield* instances.one(id);
      const snapshots = yield* instances.snapshotsOf(id);
      const found = Option.flatMap(stored, (row) =>
        Option.map(Option.fromNullishOr(known.get(row.providerId)), (definition) =>
          compose(row, definition, snapshots),
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

  /** The machine, once it is one that can run this provider's login at all. */
  const drivable = (runnerId: string, providerId: string): Effect.Effect<void, LoginError> =>
    Effect.gen(function* () {
      const runner = yield* runners.read(runnerId);
      if (Option.isNone(runner)) return yield* Effect.fail(notFound("no such runner"));
      yield* requireAdapter(runner.value, providerId, "runnerId");
    });

  /** One login frame out, its answer back, under the deadline a caller can wait. */
  const asked = (
    runnerId: string,
    request: LoginStart | LoginCode,
    deadline: Duration.Duration,
  ): Effect.Effect<LoginAnswer, InvalidState> =>
    Effect.gen(function* () {
      const answer = yield* presence.asked(runnerId, request, deadline);
      const login = Option.filter(answer, isLoginAnswer);
      return yield* Option.match(login, {
        // A machine holding no connection, one that ended first and one that
        // said nothing in time are all the same thing to the user: it did not
        // answer.
        onNone: () =>
          Effect.fail(
            invalidState(
              `that runner did not answer the login within ${Duration.format(deadline)}`,
            ),
          ),
        onSome: Effect.succeed,
      });
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

    /**
     * Starts the vendor's own login for this instance on one machine and hands
     * back the URL it printed. The user opens that URL in whatever browser they
     * are at: the machine running the harness may have none.
     */
    login: (input: LoginInput): Effect.Effect<{ readonly url: string }, LoginError> =>
      Effect.gen(function* () {
        yield* requireGrant("provider.login");
        const { id, runnerId } = yield* Effect.mapError(decodeLogin(input), validationOf);
        const instance = yield* one(id);
        yield* drivable(runnerId, instance.providerId);
        const answer = yield* asked(
          runnerId,
          {
            _tag: "loginStart",
            requestId: crypto.randomUUID(),
            instanceId: id,
            providerId: instance.providerId,
          },
          yield* ProviderLoginDeadline,
        );
        if (answer._tag !== "loginUrl") return yield* Effect.fail(invalidState(refusalIn(answer)));
        return { url: answer.url };
      }),

    /**
     * Hands the machine the code the user pasted back. A code the vendor
     * refuses is a refusal the user can act on by pasting again, so the login
     * stays up and only this call fails; a login that finished is answered with
     * a fresh snapshot, because a harness that has just been logged in has
     * never been asked whose login it is holding.
     */
    submitLoginCode: (input: LoginCodeInput): Effect.Effect<CapabilitySnapshot, LoginError> =>
      Effect.gen(function* () {
        yield* requireGrant("provider.submitLoginCode");
        const { id, runnerId, code } = yield* Effect.mapError(decodeLoginCode(input), validationOf);
        const instance = yield* one(id);
        yield* drivable(runnerId, instance.providerId);
        const answer = yield* asked(
          runnerId,
          { _tag: "loginCode", requestId: crypto.randomUUID(), instanceId: id, code },
          LOGIN_CODE_DEADLINE,
        );
        if (answer._tag !== "loginResult") {
          return yield* Effect.fail(invalidState(refusalIn(answer)));
        }
        if (!answer.ok) {
          const said = answer.message ?? "that code was refused";
          return yield* Effect.fail(validation([{ path: ["code"], message: said }], said));
        }
        // The one thing this feature does that a reader of the log will want
        // back: who put a vendor credential on which machine, and when. Never
        // the URL or the code, which are good for this one exchange only.
        yield* withTransaction(
          sql,
          Effect.flatMap(nowIso, (at) =>
            audit.append({
              kind: "provider.loggedIn",
              actor: USER_ACTOR,
              payload: { instanceId: id, runnerId },
              record: { topic: "provider", id },
              at,
            }),
          ),
        );
        const snapshot = yield* probes.probe(runnerId, id);
        return yield* Option.match(snapshot, {
          onNone: () =>
            Effect.flatMap(ProviderProbeDeadline, (waited) =>
              Effect.fail(
                invalidState(
                  `the login finished, but that runner did not answer the probe within ${Duration.format(waited)}`,
                ),
              ),
            ),
          onSome: Effect.succeed,
        });
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
            return compose(stored, definition, []);
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
        ).pipe(
          // After the commit and without waiting for it: the config is what a
          // probe runs under, so every machine's snapshot of this instance is
          // now stale, and the answer to the edit is the edit.
          Effect.tap(() => Effect.forkDetach(probes.sweepInstance(id))),
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

export class ProviderService extends Context.Service<
  ProviderService,
  Effect.Success<typeof make>
>()("hydra/controller/providers/ProviderService") {}

export const ProviderServiceLayer: Layer.Layer<
  ProviderService,
  never,
  SqlClient.SqlClient | PluginHost | AuditLog | ProviderProbes | RunnerPresence
> = Layer.effect(ProviderService)(make);
