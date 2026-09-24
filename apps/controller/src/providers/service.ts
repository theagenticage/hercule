/**
 * The provider instance operations. An instance is a row plus its provider
 * definition: `displayName` and `declared` are added when the row is read,
 * never copied into the row, so they cannot go stale.
 *
 * A row whose provider this build does not have is not listed and cannot be
 * read, but the row is kept, so a later build that has the provider again
 * finds it.
 *
 * A method that takes only an id does not decode it again: the transport has
 * already decoded a request's id against the contract, and a caller inside
 * the controller passes an id it read from a stored row.
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
 * The user is waiting in a dialog. Most of the time goes to a cold CLI
 * contacting the vendor.
 */
const LOGIN_DEADLINE: Duration.Duration = Duration.seconds(30);

/** Lets tests set a deadline short enough to wait for. */
export const ProviderLoginDeadline = Context.Reference<Duration.Duration>(
  "hercule/controller/providers/ProviderLoginDeadline",
  { defaultValue: (): Duration.Duration => LOGIN_DEADLINE },
);

/**
 * Longer than the wait for the URL, because it covers the vendor's own
 * exchange, and giving up early would report a failure for a login that in
 * fact stored a credential. But no longer than this: the HTTP server that
 * sends the response closes a request held too long, so a longer wait could
 * never be answered anyway.
 */
const LOGIN_CODE_DEADLINE: Duration.Duration = Duration.minutes(2);

/**
 * The runner's own 5min installer timeout plus the round trip, so a runner
 * that is still installing is not cut off by this deadline.
 */
const HARNESS_INSTALL_DEADLINE: Duration.Duration = Duration.minutes(6);

/** The instance and the runner a login runs on. The credential is stored on that runner only. */
const LoginInput = Schema.Struct({ id: Id, ...ProviderLoginInput.fields });

export type LoginInput = Schema.Schema.Type<typeof LoginInput>;

const LoginCodeInput = Schema.Struct({ id: Id, ...ProviderLoginCodeInput.fields });

export type LoginCodeInput = Schema.Schema.Type<typeof LoginCodeInput>;

const UpdateInput = Schema.Struct({ id: Id, ...ProviderInstanceUpdateInput.fields });

export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const ProbeInput = Schema.Struct({ runnerId: Id, instanceId: Id });

export type ProbeInput = Schema.Schema.Type<typeof ProbeInput>;

const InstallInput = Schema.Struct({ runnerId: Id, providerId: Schema.String });

export type InstallInput = Schema.Schema.Type<typeof InstallInput>;

const decodeCreate = Schema.decodeUnknownEffect(ProviderInstanceCreateInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);
const decodeLogin = Schema.decodeUnknownEffect(LoginInput);
const decodeLoginCode = Schema.decodeUnknownEffect(LoginCodeInput);
const decodeProbe = Schema.decodeUnknownEffect(ProbeInput);
const decodeInstall = Schema.decodeUnknownEffect(InstallInput);

const NO_SUCH_INSTANCE = "no such provider instance";

/** The owner kind a provider instance's credentials are stored under in the secrets table. */
const OWNER_KIND: SecretOwnerKind = "provider-instance";

type ReadError = Unauthenticated | Forbidden | SqlError | Schema.SchemaError;

type CreateError = ReadError | Validation;

type WriteError = CreateError | NotFound;

type AskError = WriteError | InvalidState;

/**
 * Converts a decryption failure into an `InvalidState` error. A stored
 * credential that does not decrypt fails the operation that needed it: a
 * probe run as if there were no credential would look like a credential
 * nobody entered. It is reported as a state rather than a fault, because the
 * user fixes it by entering the credential again.
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
  answer._tag === "loginFailed" ? answer.message : "the login did not return a URL";

/**
 * Validates a config against the provider's schema, and fails with every
 * error at once, so a form can show each message under its own field. The
 * schema excludes the secret fields: those are stored in the secrets table,
 * so a secret written into the config is an unknown key and is rejected by
 * name.
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
   * Lists the fields the plugin marked secret, with the plugin's own labels,
   * and whether this instance has a value stored under each name. The value
   * itself is never read here: an instance shows that a credential exists,
   * never what it is.
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

  /**
   * Reads one instance without a grant check, because the calling operation
   * has already checked its grant. Fails with `NotFound` if there is no such
   * instance, or if this build does not have its provider.
   */
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
              { path: ["providerId"], message: `no plugin registered the provider ${id}` },
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
        // Disconnected, gone or silent all mean the same to the user: the
        // runner did not answer.
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

    read: (id: Id): Effect.Effect<ProviderInstance, Exclude<WriteError, Validation>> =>
      Effect.gen(function* () {
        yield* requireGrant("provider.read");
        return yield* readInstanceOrFail(id);
      }),

    /**
     * Returns the URL the harness printed; the user opens it in their own
     * browser, since the runner's machine may have none.
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
        // Absent rather than empty: a code means the login is finished in the
        // user's browser, not through this exchange.
        return {
          url: answer.url,
          ...(answer.userCode === undefined ? {} : { userCode: answer.userCode }),
        };
      }),

    /**
     * Sends a login code to the runner, and returns a fresh snapshot once the
     * login finishes. A rejected code fails only this call and leaves the login
     * running, so the user can paste again. The snapshot comes from a new
     * probe, because the harness has not yet been asked whose credential it
     * holds.
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
          const said = answer.message ?? "that code was rejected";
          return yield* Effect.fail(
            createValidationError([{ path: ["code"], message: said }], said),
          );
        }
        // Records who put a credential on which runner. Never the URL or the
        // code, which are valid for this exchange only.
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
     * Probes one instance on one runner now, and returns the snapshot. The
     * fleet is swept hourly anyway; this is for when something changed
     * outside Hercule and the user does not want to wait.
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
     * Installs a provider's harness on a runner, and returns the runner. The
     * runner reports its facts before it reports that the install finished,
     * so the returned runner is up to date. Every instance is then probed on
     * that runner, because a newly installed harness has never been probed.
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

    /**
     * Creates a second account on a provider, or the first account on a
     * provider the boot did not seed. Returns the new instance.
     */
    create: (input: ProviderInstanceCreateInput): Effect.Effect<ProviderInstance, CreateError> =>
      Effect.gen(function* () {
        yield* requireGrant("provider.create");
        const decoded = yield* Effect.mapError(decodeCreate(input), createDecodeValidationError);
        const definition = yield* readProviderDefinitionOrFail(decoded.providerId);
        yield* readConfig(definition, decoded.config);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // Inside the transaction, so two concurrent calls cannot give a
            // single-account provider two instances.
            if (!definition.supportsMultipleInstances) {
              const existing = yield* instances.list();
              if (existing.some((row) => row.providerId === definition.id)) {
                return yield* Effect.fail(
                  createValidationError([
                    {
                      path: ["providerId"],
                      message: `${definition.displayName} supports only one account, and one already exists`,
                    },
                  ]),
                );
              }
            }
            // One clock read, inside the transaction, so the row and its audit
            // entry have the same timestamp.
            const at = yield* nowIso;
            const stored = yield* instances.insert({ ...decoded, at });
            yield* audit.append({
              kind: "provider.created",
              actor: yield* currentStamp,
              payload: { instanceId: stored.id, providerId: stored.providerId },
              record: { topic: "provider", id: stored.id },
              at,
            });
            // A new instance has no snapshots or secrets yet.
            return buildProviderInstance(stored, definition, [], []);
          }),
        );
      }),

    /**
     * Updates an instance and returns it. An empty patch is rejected, because
     * it would change `updatedAt` and write an audit entry for no change.
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
            // Read back rather than merged in memory, so the caller gets the
            // row as it was written, whatever the update changed.
            return yield* readInstanceOrFail(id);
          }),
        ).pipe(
          // After the commit, without waiting: the update makes every
          // runner's snapshot stale, but the response only needs the update.
          Effect.tap(() => Effect.forkDetach(probes.sweepInstance(id))),
        );
      }),

    /**
     * Deletes an instance and its stored credentials. It reads the row, not
     * the full instance, so an instance whose provider this build no longer
     * has can still be deleted. If this was the provider's only instance, the
     * next boot creates a new default one.
     */
    delete: (id: Id): Effect.Effect<Record<string, never>, Exclude<WriteError, Validation>> =>
      Effect.gen(function* () {
        yield* requireGrant("provider.delete");
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
            // In the same transaction that deletes the row: a credential left
            // behind would belong to an owner that no longer exists, and the
            // next instance given this id would inherit it.
            const held = (yield* secrets.refs(OWNER_KIND, [id])).get(id) ?? [];
            yield* Effect.forEach(
              held,
              (ref) => secrets.delete(buildProviderInstanceOwner(id), ref.name),
              {
                discard: true,
              },
            );
            yield* instances.delete(id);
            // Ids and the name rather than the config document, because the
            // log is kept for months.
            yield* audit.append({
              kind: "provider.deleted",
              actor: yield* currentStamp,
              payload: { instanceId: id, providerId: stored.providerId, name: stored.name },
              record: { topic: "provider", id },
              at,
            });
            return {};
          }),
          // This table could never have stored a name containing `|`, so a
          // delete that fails on one means a broken row, not a bad request.
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
