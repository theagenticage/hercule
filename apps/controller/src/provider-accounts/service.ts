/**
 * The Provider Account operations: reading accounts, adding one, renaming one,
 * changing its default harness, replacing its key, and deleting it.
 *
 * An account is a row plus the snapshots runners reported for it. The record
 * is built from the row's public fields one by one, never by spreading the
 * row, so a field that is stored but not public cannot leak into a response.
 *
 * Signing an account in, probing it and installing a harness also send frames
 * to runners, so the controller daemon runs them.
 * This service holds the finite parts they call: checking that a request can
 * be made, and recording its outcome. Of a sign-in that is `prepareSignIn`
 * before the frames and `acceptSignIn` after them.
 *
 * A method that takes only an id does not decode it again: the transport has
 * already decoded a request's id against the contract, and a caller inside
 * the controller passes an id it read from a stored row.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  createConflictError,
  createDecodeValidationError,
  createInvalidStateError,
  createNotFoundError,
  createValidationError,
  Id,
  ProviderAccountCreateInput,
  ProviderAccountUpdateInput,
  type AccountUsageReading,
  type Conflict,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type ModelCatalog,
  type ProviderAccount,
  type ProviderAccountReadiness,
  type RunnerDetail,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import type { AccountKind } from "@hercule/plugin-host";
import type { HarnessAccount, LoginMethod } from "@hercule/protocol";
import { currentStamp, requireGrant } from "../actor";
import { announce, nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { formatInlineCode, Notifier } from "../notifications";
import {
  decideProviderAccountHarness,
  findAccountKind,
  findCredentialSecretName,
  PluginHost,
  type RegisteredHarness,
  type RegisteredProvider,
} from "../plugins";
import { PromotionState } from "../promotion";
import { NO_SUCH_RUNNER, requireAdapter, requireOnline, runnerRepository } from "../runners";
import { buildProviderAccountOwner, Secrets } from "../secrets";
import { AccountUsage } from "../usage";
import type { Settings } from "../settings";
import { buildVersionKey, harnessRepository } from "../harnesses";
import { ProviderAccountRunners } from "./account-runners";
import { describeSnapshot } from "./describe-snapshot";
import { HarnessAccounts } from "./harness-account";
import { ProviderKeyRequests } from "./provider-key-requests";
import type { StoredModelCatalogSummary } from "./model-catalog-repository";
import { ModelCatalogs } from "./model-catalogs";
import { ModelProfileMembership } from "./model-profile-membership";
import {
  providerAccountRepository,
  type StoredProviderAccount,
  type StoredSnapshot,
} from "./repository";
import { decideHarnessOnRunner, describeProviderAccount, findHarnessProblem } from "./runnability";
import { providerAccountUses, type ProviderAccountUses } from "./uses";

const UpdateInput = Schema.Struct({ id: Id, ...ProviderAccountUpdateInput.fields });

export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);

const decodeCreate = Schema.decodeUnknownEffect(ProviderAccountCreateInput);

export type CreateInput = Schema.Schema.Type<typeof ProviderAccountCreateInput>;

const NO_SUCH_ACCOUNT = "no such provider account";

type ReadError = Unauthenticated | Forbidden | SqlError | Schema.SchemaError;

/** How long a token Hercule made works, counted from the moment it is stored. */
const TOKEN_LIFETIME_YEARS = 1;

/** Returns the instant a token stored at `at` stops working. */
const computeTokenExpiry = (at: string): string => {
  const expiry = new Date(at);
  expiry.setUTCFullYear(expiry.getUTCFullYear() + TOKEN_LIFETIME_YEARS);
  return expiry.toISOString();
};

/**
 * How long before a credential stops working the account warns about it:
 * 14 days (spec 06 section 18.3).
 */
const EXPIRY_WARNING_DAYS = 14;

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

/** What a sign-in needs to know before the runner is asked. */
export interface SignInPreparation {
  /** The qualified id of the harness the sign-in runs in: the account's default harness. */
  readonly harnessId: string;
  /** What the login produces: a login left on the runner, or a token for the controller to keep. */
  readonly method: LoginMethod;
  /** The account as the `loginStart` frame carries it. It never holds a credential. */
  readonly harnessAccount: HarnessAccount;
}

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
  const runners = yield* runnerRepository;
  const reportedVersions = yield* harnessRepository;
  const secrets = yield* Secrets;
  const keyRequests = yield* ProviderKeyRequests;
  const harnessAccounts = yield* HarnessAccounts;
  const notifier = yield* Notifier;
  const accountUsage = yield* AccountUsage;
  const promotion = yield* PromotionState;
  const catalogs = yield* ModelCatalogs;
  const accountRunners = yield* ProviderAccountRunners;
  const membership = yield* ModelProfileMembership;

  const announceAccountChanged = (id: string): Effect.Effect<void> =>
    announce({ _tag: "record", topic: "provider", id, kind: "updated" });

  /**
   * Returns what the user does about an expiring credential: make a new
   * token for a kind whose sign-in makes one, replace the key otherwise.
   */
  const describeRenewal = (
    account: Pick<StoredProviderAccount, "providerId" | "kind">,
    providers: ReadonlyArray<RegisteredProvider>,
  ): string => {
    const makesToken = findAccountKind(providers, account)?.setup.some(
      (step) => step.kind === "harness-login" && step.method === "create-token",
    );
    return makesToken === true
      ? "make a new token for the account"
      : "set a new key for the account";
  };

  const buildProviderAccount = (
    stored: StoredProviderAccount,
    snapshots: ReadonlyArray<StoredSnapshot>,
    usage: ReadonlyArray<AccountUsageReading>,
    catalog: StoredModelCatalogSummary | undefined,
    readiness: ReadonlyArray<ProviderAccountReadiness>,
  ): ProviderAccount => ({
    id: stored.id,
    providerId: stored.providerId,
    kind: stored.kind,
    label: stored.label,
    identity: stored.identity,
    planLabel: stored.planLabel,
    defaultHarnessId: stored.defaultHarnessId,
    expiresAt: stored.credentialExpiresAt,
    usage,
    failure: stored.failure,
    snapshots: snapshots
      .filter((snapshot) => snapshot.providerAccountId === stored.id)
      .map(describeSnapshot),
    modelCount: catalog?.modelCount ?? 0,
    catalogReadAt: catalog?.readAt ?? null,
    catalogError: catalog?.error ?? null,
    readiness,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  });

  /**
   * Builds the public record of each stored account. The snapshots are passed
   * in, because a caller that reads one account reads only its own. The usage
   * readings, the catalogs and the readiness rows are read once for all the
   * accounts, so the number of queries does not grow with the number of accounts.
   */
  const buildProviderAccounts = (
    stored: ReadonlyArray<StoredProviderAccount>,
    snapshots: ReadonlyArray<StoredSnapshot>,
  ): Effect.Effect<ReadonlyArray<ProviderAccount>, SqlError | Schema.SchemaError> =>
    Effect.gen(function* () {
      const usage = yield* accountUsage.readAll();
      const summaries = yield* catalogs.listSummaries();
      const readiness = yield* accountRunners.listReadiness(stored.map((account) => account.id));
      return stored.map((account) =>
        buildProviderAccount(
          account,
          snapshots,
          usage.get(account.id) ?? [],
          summaries.get(account.id),
          readiness.get(account.id) ?? [],
        ),
      );
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
      const [account] = yield* buildProviderAccounts([stored], yield* accounts.listSnapshots(id));
      return account!;
    });

  /** Reads every account with its snapshots, oldest account first. Checks no grant. */
  const readProviderAccounts = (): Effect.Effect<
    ReadonlyArray<ProviderAccount>,
    SqlError | Schema.SchemaError
  > =>
    Effect.gen(function* () {
      const stored = yield* accounts.list();
      // One query for the whole list rather than one per account.
      return yield* buildProviderAccounts(stored, yield* accounts.listAllSnapshots());
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
   * Returns the account's kind and what its sign-in produces (the `method` of
   * the kind's `harness-login` step). Fails with `InvalidState` when the kind
   * has no such step: a key account has nothing to sign in to.
   */
  const readSignInStep = (
    account: StoredProviderAccount,
  ): Effect.Effect<{ kind: AccountKind; method: LoginMethod }, InvalidState | SqlError> =>
    Effect.gen(function* () {
      const providers = yield* host.providers();
      const provider = providers.find((candidate) => candidate.id === account.providerId);
      const kind = provider?.kinds.find((candidate) => candidate.id === account.kind);
      if (provider === undefined || kind === undefined) {
        return yield* Effect.fail(
          createInvalidStateError(
            `this build has no ${account.providerId} provider with an account kind ${account.kind}, so it cannot sign that account in`,
          ),
        );
      }
      for (const step of kind.setup) {
        if (step.kind === "harness-login") return { kind, method: step.method };
      }
      return yield* Effect.fail(
        createInvalidStateError(
          `${provider.displayName} ${kind.title} accounts have no sign-in step; they hold a key, which you set with \`hercule provider-account update\``,
        ),
      );
    });

  /**
   * Checks credentials against an account's kind and fails with `Validation`
   * when they do not fit. They fit when the kind has a `credentials` setup
   * step, at least one field is named and every name is a field of that step.
   * Returns the provider and the kind, for the key check that follows.
   */
  const validateCredentials = (
    account: { readonly providerId: string; readonly kind: string },
    credentials: Readonly<Record<string, string>>,
  ): Effect.Effect<{ provider: RegisteredProvider; kind: AccountKind }, Validation | SqlError> =>
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
        const login = kind.setup.find((candidate) => candidate.kind === "harness-login");
        const advice =
          login === undefined
            ? ""
            : login.method === "create-token"
              ? `: Hercule makes the token itself. Use "Make a new token" instead`
              : "; sign in on a machine instead, with `hercule provider-account sign-in`";
        return yield* Effect.fail(
          createValidationError([
            {
              path: ["credentials"],
              message: `${provider.displayName} ${kind.title} accounts take no credentials${advice}`,
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
      return { provider, kind };
    });

  /**
   * Asks the provider whether it accepts the key in `credentials`, and fails
   * as `ProviderKeyRequests.check` does when it does not. The key is the value of
   * the field named like the kind's credential Secret.
   */
  const checkKey = (
    provider: RegisteredProvider,
    kind: AccountKind,
    credentials: Readonly<Record<string, string>>,
  ): Effect.Effect<void, Validation | InvalidState> => {
    const name = findCredentialSecretName(kind);
    const key = name === undefined ? undefined : credentials[name];
    // `validateCredentials` has already checked that the kind takes this field.
    return key === undefined
      ? Effect.die(new Error(`the account kind ${kind.id} has no key field to check`))
      : keyRequests.check(provider, kind, Redacted.make(key));
  };

  /**
   * Checks that the account can run in the harness and that the harness is
   * installed on at least one runner (spec 06 section 15.4). Fails with
   * `Validation` on `defaultHarnessId`, with the reason, when it cannot.
   */
  const requireRunnableHarness = (
    account: {
      readonly providerId: string;
      readonly kind: string;
      readonly defaultHarnessId: string;
    },
    harnessId: string,
  ): Effect.Effect<void, Validation | SqlError> =>
    Effect.gen(function* () {
      const choice = decideProviderAccountHarness(
        yield* host.providers(),
        yield* host.harnesses(),
        account,
        harnessId,
      );
      if (choice._tag === "refused") {
        return yield* Effect.fail(
          createValidationError([{ path: ["defaultHarnessId"], message: choice.reason }]),
        );
      }
      const fleet = yield* runners.listFacts();
      const versions = yield* reportedVersions.readReportedVersions();
      const problem = findHarnessProblem(
        choice.harness,
        fleet.map(({ id, facts }) =>
          decideHarnessOnRunner(
            facts,
            choice.harness,
            versions.get(buildVersionKey(choice.harness.id, id)) ?? null,
          ),
        ),
      );
      if (problem !== null) {
        return yield* Effect.fail(
          createValidationError([{ path: ["defaultHarnessId"], message: problem }]),
        );
      }
    });

  /**
   * Checks that making `harnessId` the account's default harness leaves every
   * Model Profile without a model listed twice in one section. An entry that
   * follows the account's default moves with it, and lands on the entry of the
   * same model that already names `harnessId`. Fails with `Validation` on
   * `defaultHarnessId`, naming the profile and the model, when one does.
   */
  const requireNoProfileClash = (
    account: StoredProviderAccount,
    harnessId: string,
  ): Effect.Effect<void, Validation | SqlError> =>
    Effect.gen(function* () {
      const [clash] = yield* membership.findDefaultHarnessClashes(account.id, harnessId);
      if (clash === undefined) return;
      const harnesses = yield* host.harnesses();
      const nameOf = (id: string): string =>
        harnesses.find((harness) => harness.id === id)?.displayName ?? id;
      return yield* Effect.fail(
        createValidationError([
          {
            path: ["defaultHarnessId"],
            message: `The Model Profile "${clash.profileName}" holds ${clash.model} in ${nameOf(account.defaultHarnessId)} and in ${nameOf(harnessId)}, so ${nameOf(harnessId)} as the default would list it twice. Take one of the two out of the profile first.`,
          },
        ]),
      );
    });

  /** Returns the message for a label another account of the provider already has. */
  const describeLabelClash = (providerName: string, label: string | null): string =>
    label === null
      ? `another ${providerName} account already has no label; give that one a label first, or give this one a label`
      : `another ${providerName} account is already labelled "${label}"; choose another label`;

  /**
   * Records that the provider refused the account's key or token, which a
   * usage read learned. `credentialGeneration` is the generation the refused
   * credential was sent under: a refusal of an older credential is ignored,
   * so it cannot fail the new one, and so is one for an account that was
   * deleted.
   *
   * When the account was not failed, it becomes failed and, in the same
   * transaction, raises `core.account-failed` with `message` as its body.
   * When it was failed already, only the stored message is replaced and no
   * second notification is raised: the account must stop being failed first
   * (`recordCredentialAccepted`, or a new credential). Announces the account
   * on the `provider` topic when something was stored.
   */
  const recordCredentialRefused = (
    providerAccountId: string,
    credentialGeneration: number,
    message: string,
  ): Effect.Effect<void, SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const outcome = yield* accounts.markCredentialRefused(
          providerAccountId,
          credentialGeneration,
          message,
          yield* nowIso,
        );
        if (outcome === "ignored") return;
        if (outcome === "failed") {
          const stored = yield* readStoredOrFail(providerAccountId).pipe(Effect.orDie);
          const name = describeProviderAccount(stored, yield* host.providers());
          yield* notifier.createCoreNotification({
            kind: "core.account-failed",
            title: `${name} stopped working`,
            // The provider's words are third-party text and the body is
            // markdown: as inline code they cannot add a link or an image.
            body: formatInlineCode(message),
            subject: [{ kind: "providerAccount", id: providerAccountId }],
          });
        }
        yield* announceAccountChanged(providerAccountId);
      }),
    );

  /**
   * Records that the provider accepted the account's key or token. Clears the
   * account's failure and announces the account on the `provider` topic. Does
   * nothing when the account is not failed, when `credentialGeneration` is not
   * the account's current one, or when the account was deleted.
   */
  const recordCredentialAccepted = (
    providerAccountId: string,
    credentialGeneration: number,
  ): Effect.Effect<void, SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const cleared = yield* accounts.clearFailure(
          providerAccountId,
          credentialGeneration,
          yield* nowIso,
        );
        if (cleared) yield* announceAccountChanged(providerAccountId);
      }),
    );

  return {
    /** Returns every account with its snapshots, oldest account first. */
    query: (): Effect.Effect<ReadonlyArray<ProviderAccount>, ReadError> =>
      Effect.gen(function* () {
        yield* requireGrant("providerAccount.query");
        return yield* readProviderAccounts();
      }),

    read: (id: Id): Effect.Effect<ProviderAccount, ReadError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("providerAccount.read");
        return yield* readProviderAccountOrFail(id);
      }),

    /**
     * Adds an account and returns it.
     *
     * - `providerId` and `kind` must name a registered Provider and one of
     *   its account kinds, else `Validation`.
     * - `credentials` is required for a kind with a `credentials` setup step
     *   and refused for any other. A kind that signs in is created with none,
     *   and is signed in afterwards with the account's id.
     * - `defaultHarnessId`, when given, must be a harness the account can run
     *   in that is installed on a runner. Left out, it is the provider's own
     *   harness, even when that is installed nowhere yet.
     * - `label` is required when another account of the provider exists, and
     *   must differ from theirs (`Conflict`).
     *
     * A new key is checked with the provider first (see `ProviderKeyRequests.check`),
     * before the write transaction opens, so no transaction waits on the
     * network and a refused key stores nothing. The row, the credential
     * Secret and the audit entry are then written together.
     *
     * `alsoWrite`, when given, runs in the same transaction after the account
     * is written, and receives it. If it fails, the account is not created
     * and this fails with its error. It is how a caller in a higher layer
     * writes what the new account makes necessary, such as the default
     * assistant, without this domain importing that domain.
     *
     * The caller probes the account after a key, as for `update`.
     */
    create: <E = never>(
      input: CreateInput,
      alsoWrite?: (account: ProviderAccount) => Effect.Effect<void, E>,
    ): Effect.Effect<ProviderAccount, ReadError | Validation | Conflict | InvalidState | E> =>
      Effect.gen(function* () {
        yield* requireGrant("providerAccount.create");
        const request = yield* Effect.mapError(decodeCreate(input), createDecodeValidationError);
        const providers = yield* host.providers();
        const provider = providers.find((candidate) => candidate.id === request.providerId);
        if (provider === undefined) {
          return yield* Effect.fail(
            createValidationError([
              {
                path: ["providerId"],
                message: `no plugin registered the provider ${request.providerId}; the registered providers are ${providers.map((candidate) => candidate.id).join(", ")}`,
              },
            ]),
          );
        }
        const kind = provider.kinds.find((candidate) => candidate.id === request.kind);
        if (kind === undefined) {
          return yield* Effect.fail(
            createValidationError([
              {
                path: ["kind"],
                message: `${provider.displayName} has no account kind ${request.kind}; the kinds are ${provider.kinds.map((candidate) => candidate.id).join(", ")}`,
              },
            ]),
          );
        }
        const holdsKey = kind.setup.some((step) => step.kind === "credentials");
        // A key kind with none given is checked too, so the message names the field to give.
        const credentials = holdsKey ? (request.credentials ?? {}) : request.credentials;
        if (credentials !== undefined) {
          yield* validateCredentials(request, credentials);
        }
        const label = request.label ?? null;
        const defaultHarnessId = request.defaultHarnessId ?? provider.defaultHarnessId;
        if (request.defaultHarnessId !== undefined) {
          yield* requireRunnableHarness(
            { providerId: provider.id, kind: kind.id, defaultHarnessId },
            request.defaultHarnessId,
          );
        }
        /** Fails when the label is missing or taken, as the accounts stand now. */
        const requireFreeLabel = Effect.gen(function* () {
          const others = (yield* accounts.list()).filter(
            (account) => account.providerId === provider.id,
          );
          if (label === null && others.length > 0) {
            return yield* Effect.fail(
              createValidationError([
                { path: ["label"], message: "Give this one a name, so you can tell them apart." },
              ]),
            );
          }
          if (label !== null && others.some((account) => account.label === label)) {
            return yield* Effect.fail(
              createConflictError(describeLabelClash(provider.displayName, label)),
            );
          }
        });
        // Before the key check, so a name that cannot work costs no request.
        yield* requireFreeLabel;
        if (credentials !== undefined) yield* checkKey(provider, kind, credentials);
        const created = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            // Again: another account may have been added while the key was checked.
            yield* requireFreeLabel;
            const stored = yield* accounts.insert({
              providerId: provider.id,
              kind: kind.id,
              label,
              defaultHarnessId,
              at,
            });
            yield* Effect.forEach(
              Object.entries(credentials ?? {}),
              ([name, value]) =>
                secrets.set(buildProviderAccountOwner(stored.id), name, Redacted.make(value)),
              { discard: true },
            );
            yield* audit.append({
              kind: "providerAccount.created",
              actor: yield* currentStamp,
              // Ids and the label, never a credential's value.
              payload: {
                providerAccountId: stored.id,
                providerId: stored.providerId,
                kind: stored.kind,
                label: stored.label,
              },
              record: { topic: "provider", id: stored.id },
              at,
            });
            const [account] = yield* buildProviderAccounts([stored], []);
            if (alsoWrite !== undefined) yield* alsoWrite(account!);
            return account!;
          }),
          // Field names come from the kind's declaration, which the plugin host
          // rejects at registration if one contains `|`, so this cannot fail.
        ).pipe(Effect.catchTag("SecretNameError", Effect.die));
        return created;
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
     * - `defaultHarnessId` must be a harness the account can run in that is
     *   installed on a runner, as for `create`, else `Validation`. It is also
     *   refused `Validation` when it would put one model twice into a section
     *   of a Model Profile: an entry that follows the default would land on
     *   the same model's entry that already names the new default.
     * - `credentials` is accepted only for a kind with a `credentials` setup
     *   step, and only with that step's field names. A token account takes
     *   none: its token is made by a sign-in. The new key is checked with the
     *   provider before anything is written, and a refused key changes
     *   nothing, not even the label in the same request. The values are
     *   stored as Secrets owned by the account and never returned. A new key
     *   clears the account's identity and plan label, because it may belong
     *   to someone else (spec 06 section 11).
     *
     * The caller probes the account again on every connected runner after a
     * new credential, because the stored snapshots were taken with the old
     * one. A label change leaves the snapshots true, so it probes nothing.
     */
    update: (
      input: UpdateInput,
    ): Effect.Effect<
      ProviderAccount,
      ReadError | Validation | NotFound | Conflict | InvalidState
    > =>
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
        // Everything that can refuse the request and everything that waits on
        // the network happens before the transaction, which then only writes.
        const existing = yield* readStoredOrFail(id);
        if (patch.defaultHarnessId !== undefined) {
          yield* requireRunnableHarness(existing, patch.defaultHarnessId);
        }
        if (patch.credentials !== undefined) {
          const { provider, kind } = yield* validateCredentials(existing, patch.credentials);
          yield* checkKey(provider, kind, patch.credentials);
        }
        const updated = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const before = yield* readStoredOrFail(id);
            if (
              patch.defaultHarnessId !== undefined &&
              patch.defaultHarnessId !== before.defaultHarnessId
            ) {
              yield* requireNoProfileClash(before, patch.defaultHarnessId);
            }
            if (patch.label !== undefined) {
              if (yield* accounts.isLabelTaken(before.providerId, patch.label, id)) {
                const providers = yield* host.providers();
                const name =
                  providers.find((provider) => provider.id === before.providerId)?.displayName ??
                  before.providerId;
                return yield* Effect.fail(
                  createConflictError(describeLabelClash(name, patch.label)),
                );
              }
            }
            if (patch.credentials !== undefined) {
              yield* Effect.forEach(
                Object.entries(patch.credentials),
                ([name, value]) =>
                  secrets.set(buildProviderAccountOwner(id), name, Redacted.make(value)),
                { discard: true },
              );
              // The new key may belong to someone else. See spec 06 section 11.
              yield* accounts.clearIdentity(id, at);
              // An answer to a probe sent with the old key must not be stored.
              // It also clears the account's failure and expiry warning.
              yield* accounts.advanceCredentialGeneration(id, at);
              // The new key may be someone else's, so its readings no longer apply.
              yield* accountUsage.clear(id);
            }
            yield* accounts.update(
              id,
              {
                ...(patch.label === undefined ? {} : { label: patch.label }),
                ...(patch.defaultHarnessId === undefined
                  ? {}
                  : { defaultHarnessId: patch.defaultHarnessId }),
              },
              at,
            );
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
     * using the account in between. The account's Secrets, Capability
     * Snapshots and Model Catalog go with it, and it leaves every Model
     * Profile. Ended sessions keep the account's id as history.
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
            // The account leaves every Model Profile in the same transaction.
            yield* membership.removeProviderAccount(id);
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
     * Returns the account's stored Model Catalog: the models of the last
     * successful read, when it ended, and why the last read failed, if it
     * did. Reading it fetches nothing from the provider. Fails with
     * `NotFound` when the account does not exist.
     */
    readCatalog: (id: Id): Effect.Effect<ModelCatalog, ReadError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("providerAccount.readCatalog");
        return yield* catalogs.read(id);
      }),

    /**
     * Reads one account with its snapshots, or fails with `NotFound`. Checks
     * no grant: the caller has checked the grant of its own operation.
     */
    readProviderAccount: readProviderAccountOrFail,

    /**
     * Reads every account with its snapshots, oldest account first, as
     * `query` does. Checks no grant: the caller has checked the grant of its
     * own operation.
     */
    readProviderAccounts,

    /**
     * Checks that the account can be signed in on the runner and returns what
     * the sign-in frames need: the harness it runs in (the account's default
     * harness), what the login produces, and the account as the frame carries
     * it, which never holds a credential. A token account's old token must not
     * reach the login that replaces it, and a token account with no token yet
     * or an expired one must still sign in.
     *
     * Fails with `NotFound` when the account or the runner does not exist, and
     * with `InvalidState` when the account's kind has no sign-in step or the
     * runner cannot drive the harness. Checks no grant.
     */
    prepareSignIn: (
      id: Id,
      runnerId: string,
    ): Effect.Effect<SignInPreparation, NotFound | SqlError | Validation | InvalidState> =>
      Effect.gen(function* () {
        const account = yield* readStoredOrFail(id);
        const { method } = yield* readSignInStep(account);
        const harnessId = account.defaultHarnessId;
        yield* validateRunnerCanDrive(runnerId, harnessId, "runnerId");
        const harnessAccount = yield* harnessAccounts.prepareSignIn(id, harnessId);
        return { harnessId, method, harnessAccount };
      }),

    /**
     * Records what a successful login changed, after the runner reported it.
     * `token` is the secret the runner returned with the result.
     *
     * - A `sign-in` kind returns no token (the login is in the Harness Home on
     *   the runner), and one that arrives is refused with `InvalidState`
     *   without being stored.
     * - A `create-token` kind must return one, else `InvalidState`. It is
     *   stored as the account's credential Secret, the account's expiry
     *   becomes one year from now, and its identity and plan label are
     *   cleared, because the new token may belong to someone else (spec 06
     *   section 11). All of it is one transaction.
     *
     * Every accepted sign-in advances the account's credential generation in
     * the same transaction, so a probe sent before the sign-in is ignored when
     * its answer arrives. In the same transaction the runner's snapshot of the
     * account in the harness is marked as not signed in ("Checking the
     * sign-in…"), so that runner is not placed on an `ok` taken before this
     * sign-in while the probe that checks it runs.
     *
     * Appends the `providerAccount.signedIn` audit entry. Neither the token
     * nor anything the user typed is in an error or the audit entry. Fails
     * with `NotFound` when the account was deleted in the meantime. Checks no
     * grant.
     */
    acceptSignIn: (
      id: Id,
      runnerId: string,
      harnessId: string,
      token: string | undefined,
    ): Effect.Effect<
      void,
      NotFound | InvalidState | SqlError | Schema.SchemaError | Unauthenticated
    > =>
      Effect.gen(function* () {
        const actor = yield* currentStamp;
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const account = yield* readStoredOrFail(id);
            const { kind, method } = yield* readSignInStep(account);
            if (method === "sign-in") {
              if (token !== undefined) {
                return yield* Effect.fail(
                  createInvalidStateError(
                    "that runner returned a token for a sign-in that makes none, so nothing was stored",
                  ),
                );
              }
            } else {
              const secretName = findCredentialSecretName(kind);
              if (secretName === undefined) {
                return yield* Effect.die(
                  new Error(`the account kind ${kind.id} makes a token but names no Secret for it`),
                );
              }
              if (token === undefined || token === "") {
                return yield* Effect.fail(
                  createInvalidStateError(
                    "the token flow finished without a token, so nothing was stored. Try again.",
                  ),
                );
              }
              yield* secrets.set(buildProviderAccountOwner(id), secretName, Redacted.make(token));
              yield* accounts.setCredentialExpiry(id, computeTokenExpiry(at), at);
              // The new token may belong to someone else. See spec 06 section 11.
              yield* accounts.clearIdentity(id, at);
              // The new token may be someone else's, so its readings no longer apply.
              yield* accountUsage.clear(id);
            }
            // After every accepted sign-in, whatever it stores.
            yield* accounts.recordAcceptedSignIn(id, runnerId, harnessId, at);
            yield* audit.append({
              kind: "providerAccount.signedIn",
              actor,
              payload: { providerAccountId: id, runnerId, harnessId },
              record: { topic: "provider", id },
              at,
            });
          }),
          // The name comes from the plugin catalog, which refuses names the
          // secrets store rejects.
        ).pipe(Effect.catchTag("SecretNameError", Effect.die));
      }),

    /**
     * Raises one `core.account-expiring` notification for each account whose
     * credential stops working within 14 days (spec 06 section 18.3) and that
     * has not been warned about that credential. A credential that has expired
     * already is warned about once too, so an account whose controller was off
     * at the 14-day mark still hears of it. A new credential makes the account
     * warnable again. Each account is marked and its notification raised in
     * one transaction, so a crash cannot mark an account without warning, nor
     * warn twice. The controller daemon calls it on a timer; it checks no
     * grant.
     */
    notifyExpiring: (): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const nowMillis = yield* Clock.currentTimeMillis;
          const at = new Date(nowMillis).toISOString();
          const cutoff = new Date(nowMillis + EXPIRY_WARNING_DAYS * MILLIS_PER_DAY).toISOString();
          const expiring = yield* accounts.claimExpiryWarnings(cutoff, at);
          if (expiring.length === 0) return;
          const providers = yield* host.providers();
          for (const account of expiring) {
            const name = describeProviderAccount(account, providers);
            const renewal = describeRenewal(account, providers);
            const daysLeft = Math.ceil(
              (Date.parse(account.credentialExpiresAt) - nowMillis) / MILLIS_PER_DAY,
            );
            yield* notifier.createCoreNotification({
              kind: "core.account-expiring",
              ...(daysLeft <= 0
                ? {
                    title: `${name} has expired`,
                    body: `Its sessions cannot start until you ${renewal}.`,
                  }
                : {
                    title: `${name} expires in ${daysLeft} ${daysLeft === 1 ? "day" : "days"}`,
                    body: `Its sessions stop working then. ${renewal.charAt(0).toUpperCase()}${renewal.slice(1)} before that.`,
                  }),
              subject: [{ kind: "providerAccount", id: account.id }],
            });
            yield* announceAccountChanged(account.id);
          }
        }),
      ),

    /**
     * Reads the account's usage from its provider's endpoint with the
     * account's key, and stores the outcome (spec 06 section 18.2). It is for
     * a kind whose `usage` is `readBy: "endpoint"`. The controller daemon calls
     * it after `claimRead` and checks no grant. Nothing is returned, and the
     * key is never logged.
     *
     * - The provider accepted the key: the readings are stored as read, and
     *   the account's failure is cleared.
     * - The provider refused the key (a 401, or an answer its plugin reads as
     *   a refusal): the account is failed with the provider's words.
     * - Anything else (no answer in time, 403, 429, 5xx, a redirect, an answer
     *   the plugin cannot read, a stored key that cannot be decrypted or
     *   cannot be sent in a header) is logged as a warning, and the account
     *   keeps its status.
     *
     * The readings (or the refusal) are stored in one transaction, and only
     * when the account still has the credential generation it had before the
     * request. A key replaced while the read was in flight therefore gets
     * neither the old key's readings nor its refusal. The transaction waits
     * for the promotion gate, but the request does not hold it, and a sealed
     * controller stores nothing.
     *
     * Does nothing for an account that does not exist, that has no stored
     * key, or whose kind does not read usage from an endpoint.
     */
    readUsageWithKey: (
      providerAccountId: string,
    ): Effect.Effect<void, SqlError | Schema.SchemaError> =>
      Effect.gen(function* () {
        const found = yield* accounts.one(providerAccountId);
        if (Option.isNone(found)) return;
        const account = found.value;
        const providers = yield* host.providers();
        const provider = providers.find(({ id }) => id === account.providerId);
        const kind = findAccountKind(providers, account);
        const parse = provider?.parseUsageBody[account.kind];
        const secretName = kind === undefined ? undefined : findCredentialSecretName(kind);
        if (kind?.usage?.readBy !== "endpoint" || parse === undefined || secretName === undefined) {
          return;
        }
        // The generation is read before the key. A key replaced in between
        // makes this read's outcome stale, and a stale outcome is not stored.
        const generation = account.credentialGeneration;
        const key = yield* secrets.get(buildProviderAccountOwner(account.id), secretName).pipe(
          // The name comes from the plugin catalog, which refuses names the
          // secrets store rejects.
          Effect.catchTag("SecretNameError", Effect.die),
          Effect.catchTag("SecretDecryptError", (error) =>
            Effect.logWarning(
              `Could not read the usage of account ${account.id}: its stored key cannot be decrypted`,
              error,
            ).pipe(Effect.as(Option.none<Redacted.Redacted<string>>())),
          ),
        );
        if (Option.isNone(key)) return;
        const outcome = yield* keyRequests.readUsage(kind.usage, parse, key.value);
        if (outcome._tag === "unavailable") {
          yield* Effect.logWarning(
            `Could not read the usage of account ${account.id} from ${provider?.displayName}: ${outcome.reason}`,
          );
          return;
        }
        const store = withTransaction(
          sql,
          Effect.gen(function* () {
            const current = yield* accounts.one(account.id);
            if (Option.isNone(current) || current.value.credentialGeneration !== generation) {
              return;
            }
            if (outcome._tag === "readings") {
              yield* accountUsage.record(account.id, outcome.readings, { source: "read" });
              yield* recordCredentialAccepted(account.id, generation);
            } else {
              yield* recordCredentialRefused(account.id, generation, outcome.message);
            }
          }),
        );
        yield* promotion.whenServingOr(store, () => Effect.void);
      }),

    /**
     * Checks that the account can be probed in the harness on the runner and
     * returns the harness to probe: the one given, or the account's default
     * harness when none is given.
     *
     * Fails with `NotFound` when the runner or the account does not exist,
     * with `InvalidState` when the runner is offline, and with `Validation`
     * when no plugin registered the harness. The registry is checked before
     * the account, so an id no plugin registered gets the list of registered
     * ids, not a message about the account. Checks no grant.
     */
    requireProbeTarget: (
      runnerId: string,
      providerAccountId: string,
      harnessId: string | undefined,
    ): Effect.Effect<string, NotFound | SqlError | Validation | InvalidState> =>
      Effect.gen(function* () {
        yield* requireOnline(yield* readRunnerOrFail(runnerId));
        const account = yield* readStoredOrFail(providerAccountId);
        const probedHarnessId = harnessId ?? account.defaultHarnessId;
        yield* readHarnessDefinitionOrFail(probedHarnessId);
        return probedHarnessId;
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
  | Secrets
  | Settings
  | ProviderKeyRequests
  | PromotionState
  | HarnessAccounts
  | Notifier
  | AccountUsage
  | ModelCatalogs
  | ProviderAccountRunners
  | ModelProfileMembership
> = Layer.effect(ProviderAccountService)(make);
