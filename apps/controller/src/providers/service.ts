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
import {
  decodeAgainst,
  listSecretFields,
  excludeSecretFields,
  type ProviderDefinition,
} from "@hercule/plugin-host";
import type { LoginCode, LoginFailed, LoginResult, LoginStart, LoginUrl } from "@hercule/protocol";
import {
  createInvalidStateError,
  Id,
  createNotFoundError,
  ProviderInstanceCreateInput,
  ProviderInstanceUpdateInput,
  ProviderLoginCodeInput,
  ProviderLoginInput,
  createValidationError,
  createDecodeValidationError,
  type CapabilitySnapshot,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type ProviderInstance,
  type RunnerDetail,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { currentStamp, requireGrant } from "../actor";
import { nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { PluginHost } from "../plugins";
import {
  buildProviderInstanceOwner,
  Secrets,
  type SecretDecryptError,
  type SecretNameRef,
  type SecretOwnerKind,
} from "../secrets";
import {
  NO_SUCH_RUNNER,
  requireAdapter,
  requireOnline,
  RunnerConnections,
  runnerRepository,
  type Answer,
} from "../runners";
import { ProviderProbes, ProviderProbeDeadline } from "./probes";
import { providerRepository, type StoredInstance, type StoredSnapshot } from "./repository";
import { findVersionFloor, computeVersionVerdict } from "./version";

/**
 * The user is watching a dialog; a cold CLI reaching the vendor is what takes
 * the time.
 */
const LOGIN_DEADLINE: Duration.Duration = Duration.seconds(30);

/** Tests hand over a deadline they can wait out. */
export const ProviderLoginDeadline = Context.Reference<Duration.Duration>(
  "hercule/controller/providers/ProviderLoginDeadline",
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

/** Who a provider instance's credentials belong to in the secrets table. */
const OWNER_KIND: SecretOwnerKind = "provider-instance";

type ReadError = Unauthenticated | Forbidden | SqlError | Schema.SchemaError;

type CreateError = ReadError | Validation;

type WriteError = CreateError | NotFound;

type AskError = WriteError | InvalidState;

/**
 * A stored credential that will not decrypt fails the move that needed it: a
 * probe answered as if there were none would read as a credential nobody
 * entered. Said as a state rather than as a fault, because it is one the user
 * settles by entering the credential again.
 */
const createUndecryptableError = (error: SecretDecryptError): InvalidState =>
  createInvalidStateError(
    `the credential stored as ${error.name} for that provider instance could not be ` +
      "decrypted; enter it again to replace it",
  );

type LoginAnswer = LoginUrl | LoginFailed | LoginResult;

const isLoginAnswer = (answer: Answer): answer is LoginAnswer =>
  answer._tag === "loginUrl" || answer._tag === "loginFailed" || answer._tag === "loginResult";

const describeLoginFailure = (answer: LoginAnswer): string =>
  answer._tag === "loginFailed" ? answer.message : "the login did not answer with a URL";

/**
 * All errors at once, so a form can put each message under its own field. Read
 * against the schema without its secret-valued fields: those live in the
 * secrets table, so one written into the config is an unknown key and is
 * refused by name.
 */
const readConfig = (
  definition: ProviderDefinition,
  config: Schema.Json,
): Effect.Effect<void, Validation> =>
  Effect.asVoid(
    Effect.mapError(
      decodeAgainst(excludeSecretFields(definition.configSchema), config),
      createDecodeValidationError,
    ),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const instances = yield* providerRepository;
  const host = yield* PluginHost;
  const audit = yield* AuditLog;
  const probes = yield* ProviderProbes;
  const connections = yield* RunnerConnections;
  const runners = yield* runnerRepository;
  const secrets = yield* Secrets;

  const definitions = Effect.map(
    host.providers(),
    (registered) => new Map(registered.map((definition) => [definition.id, definition])),
  );

  /**
   * What the plugin marked secret, said in its own words, with whether this
   * instance has a value stored under each name. The value itself is never
   * read here: an instance says a credential is there, never what it is.
   */
  const listInstanceSecretFields = (
    definition: ProviderDefinition,
    stored: ReadonlyArray<SecretNameRef>,
  ): ProviderInstance["secretFields"] =>
    listSecretFields(definition.configSchema).map((field) => ({
      ...field,
      set: stored.some((ref) => ref.name === field.name),
    }));

  const buildProviderInstance = (
    stored: StoredInstance,
    definition: ProviderDefinition,
    snapshots: ReadonlyArray<StoredSnapshot>,
    held: ReadonlyArray<SecretNameRef>,
  ): ProviderInstance => ({
    ...stored,
    displayName: definition.displayName,
    binaryName: definition.binaryName,
    declared: definition.declared,
    secretFields: listInstanceSecretFields(definition, held),
    snapshots: snapshots
      .filter((snapshot) => snapshot.instanceId === stored.id)
      .map((snapshot) => ({
        runnerId: snapshot.runnerId,
        probedAt: snapshot.probedAt,
        harnessVersion: snapshot.harnessVersion,
        versionVerdict: computeVersionVerdict(
          snapshot.harnessVersion,
          findVersionFloor(stored.providerId),
        ),
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
    // One query for the page rather than one per row.
    const held = yield* secrets.refs(
      OWNER_KIND,
      stored.map((row) => row.id),
    );
    return stored.flatMap((row) => {
      const definition = known.get(row.providerId);
      return definition === undefined
        ? []
        : [buildProviderInstance(row, definition, snapshots, held.get(row.id) ?? [])];
    });
  });

  /** One instance, without the grant check: a write has already been checked once. */
  const readInstanceOrFail = (
    id: string,
  ): Effect.Effect<ProviderInstance, NotFound | SqlError | Schema.SchemaError> =>
    Effect.gen(function* () {
      const known = yield* definitions;
      const stored = yield* instances.one(id);
      const snapshots = yield* instances.snapshotsOf(id);
      const held = yield* secrets.refs(OWNER_KIND, [id]);
      const found = Option.flatMap(stored, (row) =>
        Option.map(Option.fromNullishOr(known.get(row.providerId)), (definition) =>
          buildProviderInstance(row, definition, snapshots, held.get(id) ?? []),
        ),
      );
      return yield* Option.match(found, {
        onNone: () => Effect.fail(createNotFoundError(NO_SUCH_INSTANCE)),
        onSome: Effect.succeed,
      });
    });

  const readProviderDefinitionOrFail = (
    id: string,
  ): Effect.Effect<ProviderDefinition, Validation | SqlError> =>
    Effect.flatMap(definitions, (known) => {
      const definition = known.get(id);
      return definition === undefined
        ? Effect.fail(
            createValidationError([
              { path: ["providerId"], message: `no plugin registered ${id}` },
            ]),
          )
        : Effect.succeed(definition);
    });

  const readRunnerOrFail = (runnerId: string): Effect.Effect<RunnerDetail, NotFound | SqlError> =>
    Effect.gen(function* () {
      const runner = yield* runners.read(runnerId);
      if (Option.isNone(runner)) return yield* Effect.fail(createNotFoundError(NO_SUCH_RUNNER));
      return runner.value;
    });

  const validateRunnerCanDrive = (
    runnerId: string,
    providerId: string,
    field: string,
  ): Effect.Effect<void, AskError> =>
    Effect.flatMap(readRunnerOrFail(runnerId), (runner) =>
      requireAdapter(runner, providerId, field),
    );

  const askRunner = (
    runnerId: string,
    request: LoginStart | LoginCode,
    deadline: Duration.Duration,
  ): Effect.Effect<LoginAnswer, InvalidState> =>
    Effect.gen(function* () {
      const answer = yield* connections.asked(runnerId, request, deadline);
      const login = Option.filter(answer, isLoginAnswer);
      return yield* Option.match(login, {
        // Disconnected, gone, or silent are one thing to the user: it did not
        // answer.
        onNone: () =>
          Effect.fail(
            createInvalidStateError(
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
        const { id } = yield* Effect.mapError(decodeIdentified(input), createDecodeValidationError);
        return yield* readInstanceOrFail(id);
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
        const { id, runnerId } = yield* Effect.mapError(
          decodeLogin(input),
          createDecodeValidationError,
        );
        const instance = yield* readInstanceOrFail(id);
        yield* validateRunnerCanDrive(runnerId, instance.providerId, "runnerId");
        const answer = yield* askRunner(
          runnerId,
          {
            _tag: "loginStart",
            requestId: crypto.randomUUID(),
            instanceId: id,
            providerId: instance.providerId,
          },
          yield* ProviderLoginDeadline,
        );
        if (answer._tag !== "loginUrl")
          return yield* Effect.fail(createInvalidStateError(describeLoginFailure(answer)));
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
        const { id, runnerId, code } = yield* Effect.mapError(
          decodeLoginCode(input),
          createDecodeValidationError,
        );
        const instance = yield* readInstanceOrFail(id);
        yield* validateRunnerCanDrive(runnerId, instance.providerId, "runnerId");
        const answer = yield* askRunner(
          runnerId,
          { _tag: "loginCode", requestId: crypto.randomUUID(), instanceId: id, code },
          LOGIN_CODE_DEADLINE,
        );
        if (answer._tag !== "loginResult") {
          return yield* Effect.fail(createInvalidStateError(describeLoginFailure(answer)));
        }
        if (!answer.ok) {
          const said = answer.message ?? "that code was refused";
          return yield* Effect.fail(
            createValidationError([{ path: ["code"], message: said }], said),
          );
        }
        // Who put a credential on which machine. Never the URL or the code -
        // they are good for this exchange only.
        const actor = yield* currentStamp;
        yield* withTransaction(
          sql,
          Effect.flatMap(nowIso, (at) =>
            audit.append({
              kind: "provider.loggedIn",
              actor,
              payload: { instanceId: id, runnerId },
              record: { topic: "provider", id },
              at,
            }),
          ),
        );
        const snapshot = yield* probes
          .probe(runnerId, id)
          .pipe(
            Effect.catchTag("SecretDecryptError", (error) =>
              Effect.fail(createUndecryptableError(error)),
            ),
          );
        return yield* Option.match(snapshot, {
          onNone: () =>
            Effect.flatMap(ProviderProbeDeadline, (waited) =>
              Effect.fail(
                createInvalidStateError(
                  `the login finished, but that runner did not answer the probe within ${Duration.format(waited)}`,
                ),
              ),
            ),
          onSome: Effect.succeed,
        });
      }),

    /**
     * The fleet is swept hourly anyway; this is for when something changed
     * outside Hercule and the user will not wait.
     */
    probe: (input: ProbeInput): Effect.Effect<CapabilitySnapshot, AskError> =>
      Effect.gen(function* () {
        yield* requireGrant("runner.probe");
        const { runnerId, instanceId } = yield* Effect.mapError(
          decodeProbe(input),
          createDecodeValidationError,
        );
        yield* requireOnline(yield* readRunnerOrFail(runnerId));
        const snapshot = yield* probes
          .probe(runnerId, instanceId)
          .pipe(
            Effect.catchTag("SecretDecryptError", (error) =>
              Effect.fail(createUndecryptableError(error)),
            ),
          );
        return yield* Option.match(snapshot, {
          onNone: () =>
            Effect.flatMap(ProviderProbeDeadline, (waited) =>
              Effect.fail(
                createInvalidStateError(
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
        const { runnerId, providerId } = yield* Effect.mapError(
          decodeInstall(input),
          createDecodeValidationError,
        );
        yield* validateRunnerCanDrive(runnerId, providerId, "providerId");
        const answer = yield* connections.asked(
          runnerId,
          { _tag: "installRequest", requestId: crypto.randomUUID(), providerId },
          HARNESS_INSTALL_DEADLINE,
        );
        if (Option.isNone(answer) || answer.value._tag !== "installResult") {
          const waited = Duration.format(HARNESS_INSTALL_DEADLINE);
          return yield* Effect.fail(
            createInvalidStateError(`that runner did not finish the install within ${waited}`),
          );
        }
        if (!answer.value.ok) {
          return yield* Effect.fail(
            createInvalidStateError(answer.value.message ?? "the install failed"),
          );
        }
        yield* Effect.forkDetach(probes.sweepRunner(runnerId));
        return yield* readRunnerOrFail(runnerId);
      }),

    /** Opens a second account on a provider, or the first on one the boot missed. */
    create: (input: ProviderInstanceCreateInput): Effect.Effect<ProviderInstance, CreateError> =>
      Effect.gen(function* () {
        yield* requireGrant("provider.create");
        const decoded = yield* Effect.mapError(decodeCreate(input), createDecodeValidationError);
        const definition = yield* readProviderDefinitionOrFail(decoded.providerId);
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
                  createValidationError([
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
              actor: yield* currentStamp,
              payload: { instanceId: stored.id, providerId: stored.providerId },
              record: { topic: "provider", id: stored.id },
              at,
            });
            // Nothing can be stored under an instance that did not exist a moment ago.
            return buildProviderInstance(stored, definition, [], []);
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
        const { id, ...patch } = yield* Effect.mapError(
          decodeUpdate(input),
          createDecodeValidationError,
        );
        if (Object.keys(patch).length === 0) {
          return yield* Effect.fail(
            createValidationError([{ path: [], message: "name a field to change" }]),
          );
        }
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const before = yield* readInstanceOrFail(id);
            if (patch.config !== undefined) {
              yield* Effect.flatMap(readProviderDefinitionOrFail(before.providerId), (definition) =>
                readConfig(definition, patch.config as Schema.Json),
              );
            }
            yield* instances.update(id, patch, at);
            yield* audit.append({
              kind: "provider.updated",
              actor: yield* currentStamp,
              payload: { instanceId: id, fields: Object.keys(patch) },
              record: { topic: "provider", id },
              at,
            });
            // Read back rather than merge in memory: what the caller gets is
            // the row that was written, whatever the edit touched.
            return yield* readInstanceOrFail(id);
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
        const { id } = yield* Effect.mapError(decodeIdentified(input), createDecodeValidationError);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const stored = yield* Effect.flatMap(
              instances.one(id),
              Option.match({
                onNone: () => Effect.fail(createNotFoundError(NO_SUCH_INSTANCE)),
                onSome: Effect.succeed,
              }),
            );
            // In the transaction that deletes the row: a credential left
            // behind belongs to an owner that no longer exists, and the next
            // instance to be given this id would inherit it.
            const held = (yield* secrets.refs(OWNER_KIND, [id])).get(id) ?? [];
            yield* Effect.forEach(
              held,
              (ref) => secrets.delete(buildProviderInstanceOwner(id), ref.name),
              {
                discard: true,
              },
            );
            yield* instances.delete(id);
            // Names rather than the config document: the log is kept for months.
            yield* audit.append({
              kind: "provider.deleted",
              actor: yield* currentStamp,
              payload: { instanceId: id, providerId: stored.providerId, name: stored.name },
              record: { topic: "provider", id },
              at,
            });
            return {};
          }),
          // A name with a `|` in it is one this table could never have stored,
          // so a delete refusing on one is a broken row, not a bad request.
        ).pipe(Effect.catchTag("SecretNameError", Effect.die));
      }),
  };
});

export class ProviderService extends Context.Service<
  ProviderService,
  Effect.Success<typeof make>
>()("hercule/controller/providers/ProviderService") {}

export const ProviderServiceLayer: Layer.Layer<
  ProviderService,
  never,
  SqlClient.SqlClient | PluginHost | AuditLog | ProviderProbes | RunnerConnections | Secrets
> = Layer.effect(ProviderService)(make);
