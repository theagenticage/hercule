/**
 * The Provider Account operations: reading accounts, renaming one, replacing
 * its key, deleting it, signing it in on a runner, and probing it.
 *
 * An account is a row plus the snapshots runners reported for it. The record
 * is built from the row's public fields one by one, never by spreading the
 * row, so a field that is stored but not public cannot leak into a response.
 *
 * This domain sends the sign-in, probe and harness-install frames to runners
 * itself, which no other domain does: they belong in the controller daemon
 * (ADR 0033). It is kept here as an exception, because it creates no
 * dependency cycle. Issue #209 moves it, and ticket #934 absorbs #209.
 *
 * A method that takes only an id does not decode it again: the transport has
 * already decoded a request's id against the contract, and a caller inside
 * the controller passes an id it read from a stored row.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { LoginCode, LoginFailed, LoginResult, LoginStart, LoginUrl } from "@hercule/protocol";
import {
  createConflictError,
  createDecodeValidationError,
  createInvalidStateError,
  createNotFoundError,
  createValidationError,
  Id,
  ProviderAccountSignInCodeInput,
  ProviderAccountSignInInput,
  ProviderAccountUpdateInput,
  type CapabilitySnapshot,
  type Conflict,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type ProviderAccount,
  type ProviderAccountSignInStarted,
  type RunnerDetail,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { currentStamp, requireGrant } from "../actor";
import { nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { PluginHost, type RegisteredHarness, type RegisteredProvider } from "../plugins";
import {
  NO_SUCH_RUNNER,
  requireAdapter,
  requireOnline,
  RunnerConnections,
  runnerRepository,
  type Answer,
} from "../runners";
import { buildProviderAccountOwner, Secrets } from "../secrets";
import type { Settings } from "../settings";
import { describeSnapshot } from "./describe-snapshot";
import { HarnessAccounts } from "./harness-account";
import { ProviderAccountProbeDeadline, ProviderAccountProbes } from "./probes";
import {
  providerAccountRepository,
  type StoredProviderAccount,
  type StoredSnapshot,
} from "./repository";
import { providerAccountUses, type ProviderAccountUses } from "./uses";

/**
 * The user is waiting in a dialog. Most of the time goes to a cold CLI
 * contacting the vendor.
 */
const SIGN_IN_DEADLINE: Duration.Duration = Duration.seconds(30);

/** Lets tests set a deadline short enough to wait for. */
export const ProviderAccountSignInDeadline = Context.Reference<Duration.Duration>(
  "hercule/controller/provider-accounts/ProviderAccountSignInDeadline",
  { defaultValue: (): Duration.Duration => SIGN_IN_DEADLINE },
);

/**
 * Longer than the wait for the URL, because it covers the vendor's own
 * exchange, and giving up early would report a failure for a sign-in that in
 * fact stored a credential. But no longer than this: the HTTP server that
 * sends the response closes a request held too long, so a longer wait could
 * never be answered anyway.
 */
const SIGN_IN_CODE_DEADLINE: Duration.Duration = Duration.minutes(2);

/**
 * The runner's own 5min installer timeout plus the round trip, so a runner
 * that is still installing is not cut off by this deadline.
 */
const HARNESS_INSTALL_DEADLINE: Duration.Duration = Duration.minutes(6);

/** The account and the runner a sign-in runs on. The credential is stored on that runner only. */
const SignInInput = Schema.Struct({ id: Id, ...ProviderAccountSignInInput.fields });

type SignInInput = Schema.Schema.Type<typeof SignInInput>;

const SignInCodeInput = Schema.Struct({ id: Id, ...ProviderAccountSignInCodeInput.fields });

type SignInCodeInput = Schema.Schema.Type<typeof SignInCodeInput>;

const UpdateInput = Schema.Struct({ id: Id, ...ProviderAccountUpdateInput.fields });

type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const ProbeInput = Schema.Struct({
  runnerId: Id,
  providerAccountId: Id,
  harnessId: Schema.optionalKey(Schema.String),
});

type ProbeInput = Schema.Schema.Type<typeof ProbeInput>;

const InstallInput = Schema.Struct({ runnerId: Id, harnessId: Schema.String });

type InstallInput = Schema.Schema.Type<typeof InstallInput>;

const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);
const decodeSignIn = Schema.decodeUnknownEffect(SignInInput);
const decodeSignInCode = Schema.decodeUnknownEffect(SignInCodeInput);
const decodeProbe = Schema.decodeUnknownEffect(ProbeInput);
const decodeInstall = Schema.decodeUnknownEffect(InstallInput);

const NO_SUCH_ACCOUNT = "no such provider account";

type ReadError = Unauthenticated | Forbidden | SqlError | Schema.SchemaError;

type AskError = ReadError | Validation | NotFound | InvalidState;

type LoginAnswer = LoginUrl | LoginFailed | LoginResult;

const isLoginAnswer = (answer: Answer): answer is LoginAnswer =>
  answer._tag === "loginUrl" || answer._tag === "loginFailed" || answer._tag === "loginResult";

const describeSignInFailure = (answer: LoginAnswer): string =>
  answer._tag === "loginFailed" ? answer.message : "the sign-in did not return a URL";

/**
 * Names an account the way a user reads it: its provider, then its label if it
 * has one ("Anthropic · work").
 */
export const describeProviderAccount = (
  account: StoredProviderAccount,
  providers: ReadonlyArray<RegisteredProvider>,
): string => {
  const name = providers.find((provider) => provider.id === account.providerId)?.displayName;
  return `${name ?? account.providerId}${account.label === null ? "" : ` · ${account.label}`}`;
};

/** Joins names into a quoted list for a message: `"a", "b"`. */
const quoteNames = (names: ReadonlyArray<string>): string =>
  names.map((name) => `"${name}"`).join(", ");

/**
 * Lists what blocks a delete, one phrase per blocker, each saying what to
 * change. Returns an empty list when nothing uses the account.
 */
const describeUses = (uses: ProviderAccountUses): ReadonlyArray<string> => {
  const blockers: Array<string> = [];
  if (uses.agents.length > 0) {
    blockers.push(
      `the ${uses.agents.length === 1 ? "Agent" : "Agents"} ${quoteNames(uses.agents)}`,
    );
  }
  if (uses.assistants.length > 0) {
    blockers.push(
      `the ${uses.assistants.length === 1 ? "assistant" : "assistants"} ${quoteNames(uses.assistants)}`,
    );
  }
  if (uses.usedByTextGeneration) {
    blockers.push("the Text Generation model setting (textGeneration.model)");
  }
  if (uses.threadDefaultUsers > 0) {
    blockers.push(
      `the default account for new Threads of ${uses.threadDefaultUsers} ${uses.threadDefaultUsers === 1 ? "user" : "users"} (thread.providerAccountId)`,
    );
  }
  if (uses.runningSessions > 0) {
    blockers.push(
      `${uses.runningSessions} ${uses.runningSessions === 1 ? "session" : "sessions"} that ${uses.runningSessions === 1 ? "is" : "are"} queued, starting, idle or busy (let ${uses.runningSessions === 1 ? "it" : "them"} end)`,
    );
  }
  return blockers;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const accounts = yield* providerAccountRepository;
  const uses = yield* providerAccountUses;
  const host = yield* PluginHost;
  const audit = yield* AuditLog;
  const probes = yield* ProviderAccountProbes;
  const connections = yield* RunnerConnections;
  const runners = yield* runnerRepository;
  const secrets = yield* Secrets;
  const harnessAccounts = yield* HarnessAccounts;

  const buildProviderAccount = (
    stored: StoredProviderAccount,
    snapshots: ReadonlyArray<StoredSnapshot>,
  ): ProviderAccount => ({
    id: stored.id,
    providerId: stored.providerId,
    kind: stored.kind,
    label: stored.label,
    identity: stored.identity,
    planLabel: stored.planLabel,
    defaultHarnessId: stored.defaultHarnessId,
    snapshots: snapshots
      .filter((snapshot) => snapshot.providerAccountId === stored.id)
      .map(describeSnapshot),
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  });

  /** Reads the stored row, or fails with `NotFound`. Checks no grant. */
  const readStoredOrFail = (
    id: string,
  ): Effect.Effect<StoredProviderAccount, NotFound | SqlError> =>
    Effect.flatMap(accounts.one(id), (found) =>
      Option.match(found, {
        onNone: () => Effect.fail(createNotFoundError(NO_SUCH_ACCOUNT)),
        onSome: Effect.succeed,
      }),
    );

  /** Reads one account with its snapshots, or fails with `NotFound`. Checks no grant. */
  const readProviderAccountOrFail = (
    id: string,
  ): Effect.Effect<ProviderAccount, NotFound | SqlError | Schema.SchemaError> =>
    Effect.gen(function* () {
      const stored = yield* readStoredOrFail(id);
      return buildProviderAccount(stored, yield* accounts.listSnapshots(id));
    });

  /**
   * Returns the definition of the registered harness with this qualified id.
   * Fails with `Validation` when no plugin registered it, and the message
   * lists the ids that are registered, so a caller who wrote a bare name such
   * as `codex` sees the qualified one to use.
   */
  const readHarnessDefinitionOrFail = (id: string): Effect.Effect<RegisteredHarness, Validation> =>
    Effect.flatMap(host.harnesses(), (registered) => {
      const definition = registered.find((candidate) => candidate.id === id);
      return definition === undefined
        ? Effect.fail(
            createValidationError([
              {
                path: ["harnessId"],
                message: `no plugin registered the harness ${id}; the registered harnesses are ${registered.map((candidate) => candidate.id).join(", ")}`,
              },
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
    harnessId: string,
    field: string,
  ): Effect.Effect<void, NotFound | SqlError | Validation | InvalidState> =>
    Effect.flatMap(readRunnerOrFail(runnerId), (runner) =>
      requireAdapter(runner, harnessId, field),
    );

  /**
   * Checks that the account's kind signs in with the harness's own login, and
   * fails with `InvalidState` when it does not: a key account has nothing to
   * sign in to.
   */
  const requireSignInStep = (
    account: StoredProviderAccount,
  ): Effect.Effect<void, InvalidState | SqlError> =>
    Effect.flatMap(host.providers(), (providers) => {
      const provider = providers.find((candidate) => candidate.id === account.providerId);
      const kind = provider?.kinds.find((candidate) => candidate.id === account.kind);
      if (provider === undefined || kind === undefined) {
        return Effect.fail(
          createInvalidStateError(
            `this build has no ${account.providerId} provider with an account kind ${account.kind}, so it cannot sign that account in`,
          ),
        );
      }
      return kind.setup.some((step) => step.kind === "harness-login")
        ? Effect.void
        : Effect.fail(
            createInvalidStateError(
              `${provider.displayName} ${kind.title} accounts have no sign-in step; they hold a key, which you set with \`hercule provider-account update\``,
            ),
          );
    });

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
              `that runner did not answer the sign-in within ${Duration.format(deadline)}`,
            ),
          ),
        onSome: Effect.succeed,
      });
    });

  /**
   * Checks the credentials of an update against the account's kind and fails
   * with `Validation` when they do not fit. They fit when the kind has a
   * `credentials` setup step and every name is a field of that step.
   */
  const validateCredentials = (
    account: StoredProviderAccount,
    credentials: Readonly<Record<string, string>>,
  ): Effect.Effect<void, Validation | SqlError> =>
    Effect.gen(function* () {
      const providers = yield* host.providers();
      const provider = providers.find((candidate) => candidate.id === account.providerId);
      const kind = provider?.kinds.find((candidate) => candidate.id === account.kind);
      if (provider === undefined || kind === undefined) {
        return yield* Effect.fail(
          createValidationError([
            {
              path: ["credentials"],
              message: `this build has no ${account.providerId} provider with an account kind ${account.kind}, so it cannot say which credentials that account takes`,
            },
          ]),
        );
      }
      const step = kind.setup.find((candidate) => candidate.kind === "credentials");
      if (step === undefined) {
        const signIn = kind.setup.some((candidate) => candidate.kind === "harness-login");
        return yield* Effect.fail(
          createValidationError([
            {
              path: ["credentials"],
              message: `${provider.displayName} ${kind.title} accounts take no credentials${signIn ? "; sign in on a machine instead, with `hercule provider-account sign-in`" : ""}`,
            },
          ]),
        );
      }
      const names = step.fields.map((field) => field.name);
      const given = Object.keys(credentials);
      if (given.length === 0) {
        return yield* Effect.fail(
          createValidationError([
            {
              path: ["credentials"],
              message: `name at least one credential field: ${names.join(", ")}`,
            },
          ]),
        );
      }
      const unknown = given.filter((name) => !names.includes(name));
      if (unknown.length > 0) {
        return yield* Effect.fail(
          createValidationError(
            unknown.map((name) => ({
              path: ["credentials", name],
              message: `${provider.displayName} ${kind.title} accounts have no credential field ${name}; the fields are ${names.join(", ")}`,
            })),
          ),
        );
      }
    });

  return {
    /** Returns every account with its snapshots, oldest account first. */
    query: (): Effect.Effect<ReadonlyArray<ProviderAccount>, ReadError> =>
      Effect.gen(function* () {
        yield* requireGrant("providerAccount.query");
        const stored = yield* accounts.list();
        // One query for the whole list rather than one per account.
        const snapshots = yield* accounts.listAllSnapshots();
        return stored.map((account) => buildProviderAccount(account, snapshots));
      }),

    read: (id: Id): Effect.Effect<ProviderAccount, ReadError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("providerAccount.read");
        return yield* readProviderAccountOrFail(id);
      }),

    /**
     * Updates an account and returns it. A field left out is not changed; an
     * empty patch is rejected, because it would change `updatedAt` and write
     * an audit entry for no change.
     *
     * - `label` must differ from every other account's label at the same
     *   provider. An account with no label counts as having one value, so
     *   setting `null` clashes with another label-less account. A clash fails
     *   with `Conflict`.
     * - `credentials` is accepted only for a kind with a `credentials` setup
     *   step, and only with that step's field names. The values are stored as
     *   Secrets owned by the account and never returned. They are not checked
     *   with the provider yet; #934 adds that check before anything is stored.
     *
     * After the commit, a new credential makes the account probed again on
     * every connected runner, because the stored snapshots were taken with the
     * old one. A label change leaves the snapshots true, so it probes nothing.
     */
    update: (
      input: UpdateInput,
    ): Effect.Effect<ProviderAccount, ReadError | Validation | NotFound | Conflict> =>
      Effect.gen(function* () {
        yield* requireGrant("providerAccount.update");
        const { id, ...patch } = yield* Effect.mapError(
          decodeUpdate(input),
          createDecodeValidationError,
        );
        if (Object.keys(patch).length === 0) {
          return yield* Effect.fail(
            createValidationError([{ path: [], message: "name a field to change" }]),
          );
        }
        const updated = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const before = yield* readStoredOrFail(id);
            if (patch.label !== undefined) {
              if (yield* accounts.isLabelTaken(before.providerId, patch.label, id)) {
                const providers = yield* host.providers();
                const name =
                  providers.find((provider) => provider.id === before.providerId)?.displayName ??
                  before.providerId;
                return yield* Effect.fail(
                  createConflictError(
                    patch.label === null
                      ? `another ${name} account already has no label; give that one a label first, or give this one a label`
                      : `another ${name} account is already labelled "${patch.label}"; choose another label`,
                  ),
                );
              }
            }
            if (patch.credentials !== undefined) {
              yield* validateCredentials(before, patch.credentials);
              yield* Effect.forEach(
                Object.entries(patch.credentials),
                ([name, value]) =>
                  secrets.set(buildProviderAccountOwner(id), name, Redacted.make(value)),
                { discard: true },
              );
            }
            yield* accounts.update(id, patch.label === undefined ? {} : { label: patch.label }, at);
            yield* audit.append({
              kind: "providerAccount.updated",
              actor: yield* currentStamp,
              // The names of the fields, never a credential's value.
              payload: { providerAccountId: id, fields: Object.keys(patch) },
              record: { topic: "provider", id },
              at,
            });
            // Read back rather than merged in memory, so the caller gets the
            // row as it was written, whatever the update changed.
            return yield* readProviderAccountOrFail(id);
          }),
          // Field names come from the kind's declaration, which the plugin host
          // rejects at registration if one contains `|`, so this cannot fail.
        ).pipe(Effect.catchTag("SecretNameError", Effect.die));
        // After the commit, without waiting: the response only needs the update.
        if (patch.credentials !== undefined)
          yield* Effect.forkDetach(probes.sweepProviderAccount(id));
        return updated;
      }),

    /**
     * Deletes an account and returns `{}`. It is refused with `InvalidState`
     * while anything still uses the account: an Agent or assistant, the
     * Text Generation model setting, any user's default account for new
     * Threads, or a session that is queued, starting, idle or busy. The
     * message names each one and says to change them first.
     *
     * The check and the delete run in one transaction, so nothing can start
     * using the account in between. The account's Secrets and Capability
     * Snapshots go with it. Ended sessions keep the account's id as history.
     */
    delete: (id: Id): Effect.Effect<Record<string, never>, ReadError | NotFound | InvalidState> =>
      Effect.gen(function* () {
        yield* requireGrant("providerAccount.delete");
        const providers = yield* host.providers();
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const stored = yield* readStoredOrFail(id);
            const blockers = describeUses(yield* uses.findUses(id));
            if (blockers.length > 0) {
              return yield* Effect.fail(
                createInvalidStateError(
                  `${describeProviderAccount(stored, providers)} is still in use, so it was not deleted. Change these first: ${blockers.join("; ")}.`,
                ),
              );
            }
            // In the same transaction that deletes the row: a credential left
            // behind would belong to an owner that no longer exists, and an
            // account later given this id would inherit it.
            const held = (yield* secrets.refs("provider-account", [id])).get(id) ?? [];
            yield* Effect.forEach(
              held,
              (ref) => secrets.delete(buildProviderAccountOwner(id), ref.name),
              { discard: true },
            );
            yield* accounts.delete(id);
            yield* audit.append({
              kind: "providerAccount.deleted",
              actor: yield* currentStamp,
              // Ids and the label rather than anything stored beside the
              // account, because the log is kept for months.
              payload: {
                providerAccountId: id,
                providerId: stored.providerId,
                kind: stored.kind,
                label: stored.label,
              },
              record: { topic: "provider", id },
              at,
            });
            return {};
          }),
          // The secret names here are ones the secrets store listed itself, so
          // a delete that fails on one means a broken row, not a bad request.
        ).pipe(Effect.catchTag("SecretNameError", Effect.die));
      }),

    /**
     * Starts a sign-in on a runner, through the account's default harness, and
     * returns the URL the harness printed; the user opens it in their own
     * browser, since the runner's machine may have none. For a device login it
     * also returns the code to type there and when that code expires.
     *
     * Fails with `InvalidState` when the account's kind has no sign-in step,
     * the runner is offline, or the harness printed no URL.
     */
    signIn: (input: SignInInput): Effect.Effect<ProviderAccountSignInStarted, AskError> =>
      Effect.gen(function* () {
        yield* requireGrant("providerAccount.signIn");
        const { id, runnerId } = yield* Effect.mapError(
          decodeSignIn(input),
          createDecodeValidationError,
        );
        const account = yield* readStoredOrFail(id);
        yield* requireSignInStep(account);
        const harnessId = account.defaultHarnessId;
        yield* validateRunnerCanDrive(runnerId, harnessId, "runnerId");
        const harnessAccount = yield* harnessAccounts.prepare(id, harnessId);
        const requestId = crypto.randomUUID();
        // Expected before the runner is asked, because a device login that
        // fails at once can report its end before this fiber reads the answer.
        // It is forgotten when the ask fails or is interrupted, since a login
        // whose answer is never read would otherwise stay awaited for as long
        // as the controller runs.
        yield* probes.expectLoginEnd(runnerId, id, harnessId, requestId);
        const answer = yield* askRunner(
          runnerId,
          { _tag: "loginStart", requestId, harnessId, harnessAccount },
          yield* ProviderAccountSignInDeadline,
        ).pipe(Effect.onError(() => probes.forgetLoginEnd(runnerId, requestId)));
        if (answer._tag !== "loginUrl") {
          yield* probes.forgetLoginEnd(runnerId, requestId);
          return yield* Effect.fail(createInvalidStateError(describeSignInFailure(answer)));
        }
        // Absent rather than empty: a code means the login is finished in the
        // user's browser, not through this exchange. A login finished by
        // pasting a code reports no end.
        yield* probes.recordPrintedLogin(runnerId, id, harnessId, requestId, {
          reportsEnd: answer.userCode !== undefined,
        });
        if (answer.userCode === undefined) return { url: answer.url };
        if (answer.expiresInSeconds === undefined) {
          return { url: answer.url, userCode: answer.userCode };
        }
        // The runner sends how long the code lasts, not when it ends, so the
        // instant is computed on this clock and the two clocks never need to
        // agree.
        const now = yield* Clock.currentTimeMillis;
        return {
          url: answer.url,
          userCode: answer.userCode,
          expiresAt: new Date(now + answer.expiresInSeconds * 1000).toISOString(),
        };
      }),

    /**
     * Sends a sign-in code to the runner, and returns the account once the
     * sign-in finishes. A rejected code fails only this call and leaves the
     * sign-in running, so the user can paste again. The account comes back
     * with a fresh snapshot from a new probe, because the harness has not yet
     * been asked whose credential it holds.
     */
    submitSignInCode: (input: SignInCodeInput): Effect.Effect<ProviderAccount, AskError> =>
      Effect.gen(function* () {
        yield* requireGrant("providerAccount.submitSignInCode");
        const { id, runnerId, code } = yield* Effect.mapError(
          decodeSignInCode(input),
          createDecodeValidationError,
        );
        const account = yield* readStoredOrFail(id);
        yield* requireSignInStep(account);
        const harnessId = account.defaultHarnessId;
        yield* validateRunnerCanDrive(runnerId, harnessId, "runnerId");
        const answer = yield* askRunner(
          runnerId,
          { _tag: "loginCode", requestId: crypto.randomUUID(), providerAccountId: id, code },
          SIGN_IN_CODE_DEADLINE,
        );
        if (answer._tag !== "loginResult") {
          return yield* Effect.fail(createInvalidStateError(describeSignInFailure(answer)));
        }
        if (!answer.ok) {
          const refusal = answer.message ?? "that code was rejected";
          return yield* Effect.fail(
            createValidationError([{ path: ["code"], message: refusal }], refusal),
          );
        }
        // Records who put a credential on which runner. Never the URL or the
        // code, which are valid for this exchange only.
        const actor = yield* currentStamp;
        yield* withTransaction(
          sql,
          Effect.flatMap(nowIso, (at) =>
            audit.append({
              kind: "providerAccount.signedIn",
              actor,
              payload: { providerAccountId: id, runnerId, harnessId },
              record: { topic: "provider", id },
              at,
            }),
          ),
        );
        const snapshot = yield* probes.probe(runnerId, id, harnessId);
        if (Option.isNone(snapshot)) {
          const waited = yield* ProviderAccountProbeDeadline;
          return yield* Effect.fail(
            createInvalidStateError(
              `the sign-in finished, but that runner did not answer the probe within ${Duration.format(waited)}`,
            ),
          );
        }
        return yield* readProviderAccountOrFail(id);
      }),

    /**
     * Probes one account in one harness (left out: the account's default
     * harness) on one runner now, and returns the snapshot. The fleet is swept
     * hourly anyway; this is for when something changed outside Hercule and
     * the user does not want to wait.
     */
    probe: (input: ProbeInput): Effect.Effect<CapabilitySnapshot, AskError> =>
      Effect.gen(function* () {
        yield* requireGrant("runner.probe");
        const { runnerId, providerAccountId, harnessId } = yield* Effect.mapError(
          decodeProbe(input),
          createDecodeValidationError,
        );
        yield* requireOnline(yield* readRunnerOrFail(runnerId));
        const account = yield* readStoredOrFail(providerAccountId);
        const probedHarnessId = harnessId ?? account.defaultHarnessId;
        // The registry is checked first: an id no plugin registered gets the
        // list of registered ids, not a message about the account.
        yield* readHarnessDefinitionOrFail(probedHarnessId);
        const snapshot = yield* probes.probe(runnerId, providerAccountId, probedHarnessId);
        return yield* Option.match(snapshot, {
          onNone: () =>
            Effect.flatMap(ProviderAccountProbeDeadline, (waited) =>
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
     * Installs a harness on a runner, and returns the runner. The runner
     * reports its facts before it reports that the install finished, so the
     * returned runner is up to date. Every account is then probed on that
     * runner, because a newly installed harness has never been probed.
     *
     * It sends the install frame from this domain, which is the exception
     * named at the top of this file (issue #209, absorbed by ticket #934).
     */
    installHarness: (input: InstallInput): Effect.Effect<RunnerDetail, AskError> =>
      Effect.gen(function* () {
        yield* requireGrant("runner.installHarness");
        const { runnerId, harnessId } = yield* Effect.mapError(
          decodeInstall(input),
          createDecodeValidationError,
        );
        // The registry is checked first: an id no plugin registered gets the
        // list of registered ids, not a message about the runner's build.
        yield* readHarnessDefinitionOrFail(harnessId);
        yield* validateRunnerCanDrive(runnerId, harnessId, "harnessId");
        const answer = yield* connections.asked(
          runnerId,
          { _tag: "installRequest", requestId: crypto.randomUUID(), harnessId },
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
  };
});

export class ProviderAccountService extends Context.Service<
  ProviderAccountService,
  Effect.Success<typeof make>
>()("hercule/controller/provider-accounts/ProviderAccountService") {}

export const ProviderAccountServiceLayer: Layer.Layer<
  ProviderAccountService,
  never,
  | SqlClient.SqlClient
  | PluginHost
  | AuditLog
  | ProviderAccountProbes
  | RunnerConnections
  | Secrets
  | Settings
  | HarnessAccounts
> = Layer.effect(ProviderAccountService)(make);
