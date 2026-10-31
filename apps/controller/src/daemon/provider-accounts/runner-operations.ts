/**
 * The Provider Account operations that talk to a runner: signing an account
 * in, submitting the sign-in code, probing one account on a runner, and
 * creating or updating an account, which probes it again when its credential
 * changes.
 *
 * Each one checks the grant, asks the provider-accounts domain whether the
 * request can be made, sends the frame, and has the domain record the
 * outcome. A sign-in runs in this order: the domain prepares it, the runner
 * is asked, the domain accepts the result, the runner is probed, and the
 * answer is the account.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import {
  createDecodeValidationError,
  createInvalidStateError,
  createValidationError,
  Id,
  ProviderAccountSignInCodeInput,
  ProviderAccountSignInInput,
  type CapabilitySnapshot,
  type Conflict,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type ProviderAccount,
  type ProviderAccountSignInStarted,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { requireGrant } from "../../actor";
import { AssistantService } from "../../assistants";
import type { GrantsError } from "../../permissions";
import {
  ProviderAccountService,
  type CreateInput,
  type UpdateInput,
} from "../../provider-accounts";
import {
  describeSignInFailure,
  ProviderAccountProbeDeadline,
  ProviderAccountProbing,
} from "./probing";

/**
 * The user is waiting in a dialog. Most of the time goes to a cold CLI
 * contacting the vendor.
 */
const SIGN_IN_DEADLINE: Duration.Duration = Duration.seconds(30);

/** Lets tests set a deadline short enough to wait for. */
export const ProviderAccountSignInDeadline = Context.Reference<Duration.Duration>(
  "hercule/controller/daemon/ProviderAccountSignInDeadline",
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

/** The account and the runner a sign-in runs on. The credential is stored on that runner only. */
const SignInInput = Schema.Struct({ id: Id, ...ProviderAccountSignInInput.fields });

type SignInInput = Schema.Schema.Type<typeof SignInInput>;

const SignInCodeInput = Schema.Struct({ id: Id, ...ProviderAccountSignInCodeInput.fields });

type SignInCodeInput = Schema.Schema.Type<typeof SignInCodeInput>;

const ProbeInput = Schema.Struct({
  runnerId: Id,
  providerAccountId: Id,
  harnessId: Schema.optionalKey(Schema.String),
});

type ProbeInput = Schema.Schema.Type<typeof ProbeInput>;

const decodeSignIn = Schema.decodeUnknownEffect(SignInInput);
const decodeSignInCode = Schema.decodeUnknownEffect(SignInCodeInput);
const decodeProbe = Schema.decodeUnknownEffect(ProbeInput);

type ReadError = Unauthenticated | Forbidden | SqlError | Schema.SchemaError;

type AskError = ReadError | Validation | NotFound | InvalidState;

const make = Effect.gen(function* () {
  const accounts = yield* ProviderAccountService;
  const probing = yield* ProviderAccountProbing;
  const assistants = yield* AssistantService;

  return {
    /**
     * Adds an account as `ProviderAccountService.create` does. An account that
     * comes with a key is ready at once, so in the same transaction the
     * default assistant is created on it when no assistant exists (see
     * `AssistantService.createDefaultIfNone`), and the key is probed on every
     * connected runner without waiting, so its models are read.
     *
     * An account that signs in is not ready yet: it gets no assistant and no
     * probe here. `submitSignInCode` creates the assistant when the sign-in
     * succeeds. An assistant bound to an account that is never signed in could
     * not be deleted by discarding the account.
     *
     * This lives in the controller daemon because the assistants domain
     * already imports the provider-accounts domain, so the provider-accounts
     * domain cannot call it. The assistant fails the whole create when the
     * caller may not create assistants.
     */
    create: (
      input: CreateInput,
    ): Effect.Effect<
      ProviderAccount,
      ReadError | Validation | Conflict | InvalidState | GrantsError
    > =>
      Effect.gen(function* () {
        if (input.credentials === undefined) return yield* accounts.create(input);
        const created = yield* accounts.create(input, (account) =>
          assistants.createDefaultIfNone(account.id),
        );
        // After the commit, without waiting: the response only needs the account.
        yield* Effect.forkDetach(probing.sweepProviderAccount(created.id));
        return created;
      }),

    /**
     * Updates an account as `ProviderAccountService.update` does, and then,
     * when the update gave it a credential, probes it again on every
     * connected runner without waiting, because the stored snapshots were
     * taken with the old credential.
     */
    update: (
      input: UpdateInput,
    ): Effect.Effect<
      ProviderAccount,
      ReadError | Validation | NotFound | Conflict | InvalidState
    > =>
      Effect.gen(function* () {
        const updated = yield* accounts.update(input);
        // After the commit, without waiting: the response only needs the update.
        if (input.credentials !== undefined) {
          yield* Effect.forkDetach(probing.sweepProviderAccount(input.id));
        }
        return updated;
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
        const { harnessId, method, harnessAccount } = yield* accounts.prepareSignIn(id, runnerId);
        const answer = yield* probing.startLogin(
          runnerId,
          id,
          { harnessId, harnessAccount, method },
          yield* ProviderAccountSignInDeadline,
          // The first sign-in makes the account ready for use. Nobody waits
          // for the runner's report of the login's end, so the log is where a
          // failure goes.
          assistants
            .createDefaultIfNone(id)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logError(
                  "Creating the default assistant after a device sign-in failed",
                  cause,
                ),
              ),
            ),
        );
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
     * sign-in running, so the user can paste again.
     *
     * A token flow returns the token with its result and the domain stores it.
     * The account is then probed on the runner before the answer, because the
     * harness has not yet been asked whose credential it holds. When that
     * snapshot is not `ok` the call fails with InvalidState carrying the
     * snapshot's message, such as a login as someone else than the account.
     * It fails the same way when the account changed twice while the probe
     * ran, because then no snapshot is known to describe this sign-in. The
     * sign-in itself stays recorded.
     *
     * Once the probe finds the account signed in, the account is ready, so
     * its Model Catalog is read (without waiting, with a probe of its own),
     * and the default assistant is created on it when no assistant exists (see
     * `create`). That fails the call when the caller may not create assistants, after the
     * sign-in is recorded.
     */
    submitSignInCode: (
      input: SignInCodeInput,
    ): Effect.Effect<ProviderAccount, AskError | GrantsError> =>
      Effect.gen(function* () {
        yield* requireGrant("providerAccount.submitSignInCode");
        const { id, runnerId, code } = yield* Effect.mapError(
          decodeSignInCode(input),
          createDecodeValidationError,
        );
        const { harnessId } = yield* accounts.prepareSignIn(id, runnerId);
        const answer = yield* probing.submitLoginCode(
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
        yield* accounts.acceptSignIn(id, runnerId, harnessId, answer.token);
        const snapshot = yield* probing.probeToCheckSignIn(runnerId, id, harnessId);
        if (Option.isNone(snapshot)) {
          const waited = yield* ProviderAccountProbeDeadline;
          return yield* Effect.fail(
            createInvalidStateError(
              `the sign-in finished, but that runner did not answer the probe within ${Duration.format(waited)}`,
            ),
          );
        }
        if (snapshot.value.auth.status !== "ok") {
          return yield* Effect.fail(
            createInvalidStateError(
              snapshot.value.auth.message ??
                "the sign-in finished, but that runner does not report the account as signed in",
            ),
          );
        }
        yield* assistants.createDefaultIfNone(id);
        return yield* accounts.readProviderAccount(id);
      }),

    /**
     * Refreshes an account and returns it at once: its Model Catalog is read
     * again on the runner the catalog chooses, without waiting. That is one
     * probe, not a probe of every harness on every runner; the hourly sweep
     * keeps the other snapshots fresh. The outcome arrives on the `provider`
     * live topic when the read ends.
     *
     * Fails with `NotFound` when the account does not exist.
     */
    refresh: (id: Id): Effect.Effect<ProviderAccount, ReadError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("providerAccount.refresh");
        const account = yield* accounts.readProviderAccount(id);
        yield* Effect.forkDetach(probing.readCatalog(id));
        return account;
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
        const probedHarnessId = yield* accounts.requireProbeTarget(
          runnerId,
          providerAccountId,
          harnessId,
        );
        const outcome = yield* probing.probe(runnerId, providerAccountId, probedHarnessId);
        switch (outcome._tag) {
          case "stored":
            return outcome.snapshot;
          case "superseded":
            return yield* Effect.fail(
              createInvalidStateError("The account changed while it was probed. Probe again."),
            );
          case "unanswered": {
            const waited = yield* ProviderAccountProbeDeadline;
            return yield* Effect.fail(
              createInvalidStateError(
                `that runner did not answer the probe within ${Duration.format(waited)}`,
              ),
            );
          }
        }
      }),
  };
});

export class ProviderAccountRunnerOperations extends Context.Service<
  ProviderAccountRunnerOperations,
  Effect.Success<typeof make>
>()("hercule/controller/daemon/ProviderAccountRunnerOperations") {}

export const ProviderAccountRunnerOperationsLayer: Layer.Layer<
  ProviderAccountRunnerOperations,
  never,
  ProviderAccountService | ProviderAccountProbing | AssistantService
> = Layer.effect(ProviderAccountRunnerOperations)(make);
