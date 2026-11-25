/**
 * Probes an Antigravity account without running a session: the version of
 * `agy`, whether the account is signed in, who it is, its plan and its models
 * (spec 06 section 3.2).
 *
 * `agy models` cannot run in a Harness Home, so the models come from the reply
 * to `session/new`. That opens a conversation, and `agy` has no call that
 * deletes one. The probe therefore closes the conversation, waits until the
 * `agy` process has exited, and then deletes the conversation's files itself.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import type { AcpConnection, AcpError, AcpHandlers, SessionSettings } from "@hercule/acp";
import type { AdapterError, ProbeResult } from "@hercule/protocol";
import { buildAdapterFailed } from "../adapter-error-builders";
import type { HarnessRunnerContext } from "../index";
import { PROBE_DEADLINE, buildFailedProbe } from "../probe";
import type { Run } from "../process";
import { truncateFact } from "../text";
import { isSignInRequired, openSignedInAgy, readAgyVersion, type AgySpawn } from "./agy";
import { deleteSessionFiles, makeScratchFolder, readSignedInEmail } from "./harness-home";
import { buildModelCatalog } from "./model-catalog";

/** How long `session/close` may take. `agy` keeps the conversation's files either way, and the process ends next. */
const CLOSE_DEADLINE = Duration.seconds(2);

/** What a probe finds out about a signed-in account. */
type AccountFindings = Pick<ProbeResult, "auth" | "models">;

/**
 * The handlers of a probe's connection. A probe sends no prompt, so `agy`
 * should send nothing that needs an answer. If it does, the answer is "no",
 * and the message is logged without its `raw` text, which may hold secrets.
 *
 * The log line is written with the services of the fiber that builds the
 * handlers, because the connection calls them outside any fiber, and a plain
 * `Effect.runFork` there would miss the runner's log file.
 */
const buildDecliningHandlers = Effect.map(Effect.context<never>(), (services): AcpHandlers => ({
  onSessionUpdate: () => undefined,
  onApprovalRequest: () => Effect.succeed({ outcome: "cancelled" }),
  onElicitation: () => Effect.succeed({ action: "cancel" }),
  onUnhandledMessage: ({ method, reason }) => {
    void Effect.runForkWith(services)(
      Effect.logWarning(
        `Antigravity sent a message while its account was checked, and it was not used: ${method}: ${reason}`,
      ),
    );
  },
}));

/**
 * Opens a conversation and stores its id in `conversation` in the same step
 * that receives the reply. An interruption can therefore never leave a
 * conversation whose id nobody knows. Fails with the error of `session/new`.
 */
const openConversation = (
  connection: AcpConnection,
  cwd: string,
  conversation: Ref.Ref<string | undefined>,
): Effect.Effect<{ readonly id: string; readonly settings: SessionSettings }, AcpError> =>
  Effect.uninterruptibleMask((restore) =>
    restore(connection.newSession({ cwd, mcpServers: [] })).pipe(
      Effect.tap((reply) => Ref.set(conversation, reply.nativeSessionId)),
      Effect.map((reply) => ({ id: reply.nativeSessionId, settings: reply })),
    ),
  );

/** Tells `agy` the conversation is over. It never fails and never takes longer than `CLOSE_DEADLINE`. */
const closeConversation = (connection: AcpConnection, id: string): Effect.Effect<void> =>
  connection.closeSession(id).pipe(Effect.timeoutOption(CLOSE_DEADLINE), Effect.ignore);

/**
 * Opens a conversation in a scratch folder of the Harness Home and returns
 * the account's plan and the settings `agy` sent for it. The scope owns the
 * scratch folder and the `agy` process, and closing it stops the process.
 */
const readSettings = (
  spawn: AgySpawn,
  ctx: HarnessRunnerContext,
  binary: string,
  conversation: Ref.Ref<string | undefined>,
): Effect.Effect<
  { readonly settings: SessionSettings; readonly planLabel: string | undefined },
  AdapterError | AcpError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const cwd = yield* makeScratchFolder(ctx.home);
    const handlers = yield* buildDecliningHandlers;
    const { connection, planLabel } = yield* openSignedInAgy(spawn, ctx, binary, { cwd, handlers });
    const { id, settings } = yield* openConversation(connection, cwd, conversation);
    yield* closeConversation(connection, id);
    return { settings, planLabel };
  });

/**
 * Reads the signed-in account's email, plan and models. Fails with a typed
 * error for every outcome that is not a result: a missing login, a refused
 * `session/new`, no models, no email, or a second person who signed in while
 * the check ran. Fails when it takes longer than `PROBE_DEADLINE`.
 *
 * The email in the token file is read before the process opens and again after
 * the models are read. A sign-in rewrites that file while a probe may be
 * running, and a result built from both people would be wrong.
 */
const readAccount = (
  spawn: AgySpawn,
  ctx: HarnessRunnerContext,
  binary: string,
  conversation: Ref.Ref<string | undefined>,
): Effect.Effect<AccountFindings, AdapterError | AcpError> =>
  Effect.gen(function* () {
    const emailBefore = yield* readSignedInEmail(ctx.home);
    const { settings, planLabel } = yield* Effect.scoped(
      readSettings(spawn, ctx, binary, conversation),
    );
    const models = buildModelCatalog(settings);
    // With a login token that has not expired yet, `agy` answers `authenticate`
    // without asking Google, and lists no models when it cannot reach Google or
    // Google refuses the login. An `ok` with no models would empty the
    // account's Model Catalog.
    if (models.length === 0) {
      return yield* Effect.fail(
        buildAdapterFailed(
          "Antigravity listed no models for this account. The runner may be offline, or Google may have refused the sign-in.",
        ),
      );
    }
    const emailAfter = yield* readSignedInEmail(ctx.home);
    if (emailAfter === undefined) {
      return yield* Effect.fail(
        buildAdapterFailed("Could not read who is signed in to Antigravity."),
      );
    }
    if (emailAfter !== emailBefore) {
      return yield* Effect.fail(
        buildAdapterFailed(
          "Someone signed in to Antigravity while the account was checked. Check it again.",
        ),
      );
    }
    const findings: AccountFindings = {
      auth: {
        status: "ok",
        identity: truncateFact(emailAfter),
        ...(planLabel === undefined ? {} : { planLabel }),
      },
      models,
    };
    return findings;
  }).pipe(
    Effect.timeoutOption(PROBE_DEADLINE),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            buildAdapterFailed(
              `Antigravity did not answer within ${String(Duration.toSeconds(PROBE_DEADLINE))} seconds`,
            ),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );

/**
 * Reads the account, and then deletes the files of the conversation the
 * check opened. The files are deleted whichever way the check ends,
 * interruption included, and only when the id of the conversation was
 * received: the probe never guesses whose files to remove. Fails with the
 * check's error, or with an `AdapterFailed` when the files cannot be removed.
 */
const readAccountAndRemoveFiles = (
  spawn: AgySpawn,
  ctx: HarnessRunnerContext,
  binary: string,
): Effect.Effect<AccountFindings, AdapterError | AcpError> =>
  Effect.acquireUseRelease(
    Ref.make<string | undefined>(undefined),
    (conversation) => readAccount(spawn, ctx, binary, conversation),
    // Runs after the scope of `readSettings` closed, so the `agy` process has
    // exited and nothing writes to the conversation's files any more.
    (conversation) =>
      Effect.flatMap(Ref.get(conversation), (id) =>
        id === undefined
          ? Effect.void
          : deleteSessionFiles(ctx.home, id).pipe(
              Effect.mapError((error) =>
                buildAdapterFailed(
                  `Could not remove the files of the Antigravity check: ${error.message}`,
                ),
              ),
            ),
      ),
  );

/**
 * Returns the probe result for what the account check found. A missing login,
 * and the `-32000` "Authentication required" of `session/new`, mean the
 * account is signed out. Any other failure is an `error`, so that being offline
 * never reads as signed out.
 */
const buildProbeResult = (
  version: string | null,
  account: Result.Result<AccountFindings, AdapterError | AcpError>,
): ProbeResult => {
  if (Result.isSuccess(account))
    return { harnessVersion: version, ...account.success, usage: null };
  const error = account.failure;
  return error._tag === "HarnessLoginMissing" ||
    (error._tag === "AcpError" && isSignInRequired(error))
    ? { harnessVersion: version, auth: { status: "unauthenticated" }, models: [], usage: null }
    : buildFailedProbe(version, error.message);
};

/**
 * Builds the probe function from how `agy` is spawned and how a command is run.
 * The probe never fails: every error becomes a probe result, and every result
 * carries the version of `agy` when it was read in time.
 *
 * The version and the account are read at the same time, each inside
 * `PROBE_DEADLINE`. Stopping the process, which has a grace period of its own,
 * and deleting the conversation's files come after it, inside the 20 seconds
 * the controller waits.
 */
export const makeProbe =
  (seam: { readonly spawn: AgySpawn; readonly run: Run }) =>
  (ctx: HarnessRunnerContext, binary: string): Effect.Effect<ProbeResult> =>
    Effect.all(
      [
        readAgyVersion(seam.run, ctx, binary).pipe(
          Effect.timeoutOption(PROBE_DEADLINE),
          Effect.map(Option.getOrNull),
        ),
        Effect.result(readAccountAndRemoveFiles(seam.spawn, ctx, binary)),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.map(([version, account]) => buildProbeResult(version, account)));
