/**
 * Provider instances as the API sees them. An instance is a row plus its
 * provider definition: `displayName` and `declared` are composed at read, never
 * copied into the row, so they cannot go stale.
 *
 * A row whose provider this build does not carry is not listed and not
 * readable, but the row stays, so a build that carries the provider again finds
 * it.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { decodeAgainst, type ProviderDefinition } from "@hydra/plugin-host";
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
  type RunnerDetail,
  type Unauthenticated,
  type Validation,
} from "@hydra/contract";
import { requireGrant, USER_ACTOR } from "../actor";
import { nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { PluginHost } from "../plugins";
import {
  requireAdapter,
  requireOnline,
  RunnerPresence,
  runnerRepository,
  type Answer,
} from "../runners";
import { ProviderProbes, ProviderProbeDeadline } from "./probes";
import { providerRepository, type StoredInstance, type StoredSnapshot } from "./repository";
import { floorFor, versionVerdict } from "./version";

/**
 * The user is watching a dialog; a cold CLI reaching the vendor is what takes
 * the time.
 */
const LOGIN_DEADLINE: Duration.Duration = Duration.seconds(30);

/** Tests hand over a deadline they can wait out. */
export const ProviderLoginDeadline = Context.Reference<Duration.Duration>(
  "hydra/controller/providers/ProviderLoginDeadline",
  { defaultValue: (): Duration.Duration => LOGIN_DEADLINE },
);

/**
 * Longer than the URL's wait: it covers the vendor's own exchange, and giving
 * up early would report a failure that in fact wrote a credential. No longer
 * than that: the HTTP server this answer goes out on cuts a held request, so a
 * wait measured in browser-time could never have been answered anyway.
 */
const LOGIN_CODE_DEADLINE: Duration.Duration = Duration.minutes(2);

/**
 * The runner's own 5min installer budget plus the round trip, so a machine
 * still working is not cut off here.
 */
const HARNESS_INSTALL_DEADLINE: Duration.Duration = Duration.minutes(6);

/** Which machine a login runs on. The credential lands on that machine alone. */
const LoginInput = Schema.Struct({ id: Id, ...ProviderLoginInput.fields });

export type LoginInput = Schema.Schema.Type<typeof LoginInput>;

const LoginCodeInput = Schema.Struct({ id: Id, ...ProviderLoginCodeInput.fields });

export type LoginCodeInput = Schema.Schema.Type<typeof LoginCodeInput>;

const UpdateInput = Schema.Struct({ id: Id, ...ProviderInstanceUpdateInput.fields });

export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const Identified = Schema.Struct({ id: Id });

export type Identified = Schema.Schema.Type<typeof Identified>;

const ProbeInput = Schema.Struct({ runnerId: Id, instanceId: Id });

export type ProbeInput = Schema.Schema.Type<typeof ProbeInput>;

const InstallInput = Schema.Struct({ runnerId: Id, providerId: Schema.String });

export type InstallInput = Schema.Schema.Type<typeof InstallInput>;

const decodeCreate = Schema.decodeUnknownEffect(ProviderInstanceCreateInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);
const decodeIdentified = Schema.decodeUnknownEffect(Identified);
const decodeLogin = Schema.decodeUnknownEffect(LoginInput);
const decodeLoginCode = Schema.decodeUnknownEffect(LoginCodeInput);
const decodeProbe = Schema.decodeUnknownEffect(ProbeInput);
const decodeInstall = Schema.decodeUnknownEffect(InstallInput);

const NO_SUCH_INSTANCE = "no such provider instance";

const NO_SUCH_RUNNER = "no such runner";

type ReadError = Unauthenticated | Forbidden | SqlError | Schema.SchemaError;

type CreateError = ReadError | Validation;

type WriteError = CreateError | NotFound;

type AskError = WriteError | InvalidState;

type LoginAnswer = LoginUrl | LoginFailed | LoginResult;

const isLoginAnswer = (answer: Answer): answer is LoginAnswer =>
  answer._tag === "loginUrl" || answer._tag === "loginFailed" || answer._tag === "loginResult";

const refusalIn = (answer: LoginAnswer): string =>
  answer._tag === "loginFailed" ? answer.message : "the login did not answer with a URL";

/** All errors at once, so a form can put each message under its own field. */
const readConfig = (
  definition: ProviderDefinition,
  config: Schema.Json,
): Effect.Effect<void, Validation> =>
  Effect.asVoid(Effect.mapError(decodeAgainst(definition.configSchema, config), validationOf));

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

  const provider = (id: string): Effect.Effect<ProviderDefinition, Validation | SqlError> =>
    Effect.flatMap(definitions, (known) => {
      const definition = known.get(id);
      return definition === undefined
        ? Effect.fail(validation([{ path: ["providerId"], message: `no plugin registered ${id}` }]))
        : Effect.succeed(definition);
    });

  const machine = (runnerId: string): Effect.Effect<RunnerDetail, NotFound | SqlError> =>
    Effect.gen(function* () {
      const runner = yield* runners.read(runnerId);
      if (Option.isNone(runner)) return yield* Effect.fail(notFound(NO_SUCH_RUNNER));
      return runner.value;
    });

  const drivable = (
    runnerId: string,
    providerId: string,
    field: string,
  ): Effect.Effect<void, AskError> =>
    Effect.flatMap(machine(runnerId), (runner) => requireAdapter(runner, providerId, field));

  const asked = (
    runnerId: string,
    request: LoginStart | LoginCode,
    deadline: Duration.Duration,
  ): Effect.Effect<LoginAnswer, InvalidState> =>
    Effect.gen(function* () {
      const answer = yield* presence.asked(runnerId, request, deadline);
      const login = Option.filter(answer, isLoginAnswer);
      return yield* Option.match(login, {
        // Disconnected, gone, or silent are one thing to the user: it did not
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
     * Returns the URL the harness printed; the user opens it in their own
     * browser, since the machine may have none.
     */
    login: (
      input: LoginInput,
    ): Effect.Effect<{ readonly url: string; readonly userCode?: string }, AskError> =>
      Effect.gen(function* () {
        yield* requireGrant("provider.login");
        const { id, runnerId } = yield* Effect.mapError(decodeLogin(input), validationOf);
        const instance = yield* one(id);
        yield* drivable(runnerId, instance.providerId, "runnerId");
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
        // Absent rather than empty: a code is what tells the user's browser,
        // not this exchange, to finish the login.
        return {
          url: answer.url,
          ...(answer.userCode === undefined ? {} : { userCode: answer.userCode }),
        };
      }),

    /**
     * A refused code leaves the login up, so the user can paste again; only
     * this call fails. A finished login is answered with a fresh probe, because
     * the harness has not yet been asked whose credential it holds.
     */
    submitLoginCode: (input: LoginCodeInput): Effect.Effect<CapabilitySnapshot, AskError> =>
      Effect.gen(function* () {
        yield* requireGrant("provider.submitLoginCode");
        const { id, runnerId, code } = yield* Effect.mapError(decodeLoginCode(input), validationOf);
        const instance = yield* one(id);
        yield* drivable(runnerId, instance.providerId, "runnerId");
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
        // Who put a credential on which machine. Never the URL or the code -
        // they are good for this exchange only.
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

    /**
     * The fleet is swept hourly anyway; this is for when something changed
     * outside Hydra and the user will not wait.
     */
    probe: (input: ProbeInput): Effect.Effect<CapabilitySnapshot, AskError> =>
      Effect.gen(function* () {
        yield* requireGrant("runner.probe");
        const { runnerId, instanceId } = yield* Effect.mapError(decodeProbe(input), validationOf);
        yield* requireOnline(yield* machine(runnerId));
        const snapshot = yield* probes.probe(runnerId, instanceId);
        return yield* Option.match(snapshot, {
          onNone: () =>
            Effect.flatMap(ProviderProbeDeadline, (waited) =>
              Effect.fail(
                invalidState(
                  `that runner did not answer the probe within ${Duration.format(waited)}`,
                ),
              ),
            ),
          onSome: Effect.succeed,
        });
      }),

    /**
     * The runner reports its facts before it says the install finished, so the
     * row answered with is the machine as it now is. Every instance on it is
     * swept: a just-installed harness has never been asked anything.
     */
    installHarness: (input: InstallInput): Effect.Effect<RunnerDetail, AskError> =>
      Effect.gen(function* () {
        yield* requireGrant("runner.installHarness");
        const { runnerId, providerId } = yield* Effect.mapError(decodeInstall(input), validationOf);
        yield* drivable(runnerId, providerId, "providerId");
        const answer = yield* presence.asked(
          runnerId,
          { _tag: "installRequest", requestId: crypto.randomUUID(), providerId },
          HARNESS_INSTALL_DEADLINE,
        );
        if (Option.isNone(answer) || answer.value._tag !== "installResult") {
          const waited = Duration.format(HARNESS_INSTALL_DEADLINE);
          return yield* Effect.fail(
            invalidState(`that runner did not finish the install within ${waited}`),
          );
        }
        if (!answer.value.ok) {
          return yield* Effect.fail(invalidState(answer.value.message ?? "the install failed"));
        }
        yield* Effect.forkDetach(probes.sweepRunner(runnerId));
        return yield* machine(runnerId);
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
     * An empty patch is refused: it would move `updatedAt` and stamp an entry
     * describing nothing.
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
          // After the commit, unawaited: the edit stales every machine's
          // snapshot, but the answer to the edit is the edit.
          Effect.tap(() => Effect.forkDetach(probes.sweepInstance(id))),
        );
      }),

    /**
     * Works off the row, not the composed instance, so an instance whose
     * provider this build no longer carries can still be deleted. The next boot
     * re-seeds if this was the provider's only instance.
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
