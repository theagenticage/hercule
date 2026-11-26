/**
 * Probes an Antigravity account: the version of `agy`, whether the account is
 * signed in, who it is, its plan and its models (spec 06 section 3.2). The
 * probe opens or resumes a conversation but sends no prompt, so no model runs.
 *
 * `agy models` cannot run in a Harness Home, so the models come from the reply
 * to `session/new` or `session/resume`. Both need a conversation, and `agy`
 * has no call that deletes one. Every new conversation adds a row to `agy`'s
 * shared summary database and a new working folder adds a file, and nothing
 * removes them. A probe runs about every hour per account, so the probe does
 * not make a conversation each time. It keeps one conversation per
 * Harness Home, in one fixed working folder, and resumes it. A resume adds
 * nothing.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import type { AcpConnection, AcpError, AcpHandlers, SessionSettings } from "@hercule/acp";
import type { AdapterError, ProbeResult } from "@hercule/protocol";
import { buildAdapterFailed } from "../adapter-error-builders";
import type { HarnessRunnerContext } from "../index";
import { PROBE_DEADLINE, buildFailedProbe } from "../probe";
import { truncateFact } from "../text";
import {
  checkAccountUsable,
  isSignInRequired,
  openSignedInAgy,
  readAgyVersion,
  type AgySeam,
  type AgySpawn,
} from "./agy";
import { ANTIGRAVITY_NAME } from "./harness-name";
import {
  makeProbeFolder,
  readProbeConversationId,
  readSignedInEmail,
  writeProbeConversationId,
} from "./harness-home";
import { buildModelCatalog } from "./model-catalog";

/** How long `session/close` may take. `agy` keeps the conversation either way, and the process ends next. */
const CLOSE_DEADLINE = Duration.seconds(2);

/** What a probe finds out about a signed-in account. */
type AccountFindings = Pick<ProbeResult, "auth" | "models">;

/** The conversation the probe used and the settings `agy` returned for it. */
interface ProbeConversation {
  readonly id: string;
  readonly settings: SessionSettings;
}

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
        `${ANTIGRAVITY_NAME} sent a message while its account was checked, and it was not used: ${method}: ${reason}`,
      ),
    );
  },
}));

/**
 * Resumes the conversation `storedId`. Returns undefined when `agy` refuses to
 * resume it, for example because its files are gone, and logs that: the caller
 * makes a new conversation. Fails with the error for every other failure. A
 * refusal that means the account is not signed in must not make a signed-in
 * account look signed out, and a resume that is unreadable, times out or ends
 * with the connection is not known to have failed for good, so none of them
 * replaces the stored conversation.
 */
const resumeConversation = (
  connection: AcpConnection,
  storedId: string,
  folder: string,
): Effect.Effect<ProbeConversation | undefined, AcpError> =>
  connection.resumeSession({ nativeSessionId: storedId, cwd: folder, mcpServers: [] }).pipe(
    Effect.map((settings) => ({ id: storedId, settings })),
    Effect.catch((error) =>
      error.reason === "refused" && !isSignInRequired(error)
        ? Effect.as(
            Effect.logWarning(
              `${ANTIGRAVITY_NAME} refused to resume the conversation of its check, so a new one is made: ${error.message}`,
            ),
            undefined,
          )
        : Effect.fail(error),
    ),
  );

/**
 * Makes a new conversation and stores its id in the Harness Home, replacing
 * the id there. The reply and the store are one step that cannot be
 * interrupted, so an interruption never leaves a conversation whose id is
 * lost. Fails with the error of `session/new`, or with an `AdapterFailed` when
 * the id is not a UUID or cannot be stored: a probe that forgot its
 * conversation would make a new one every time.
 */
const makeConversation = (
  connection: AcpConnection,
  home: string,
  folder: string,
): Effect.Effect<ProbeConversation, AcpError | AdapterError> =>
  Effect.uninterruptibleMask((restore) =>
    restore(connection.newSession({ cwd: folder, mcpServers: [] })).pipe(
      Effect.tap((reply) => writeProbeConversationId(home, reply.nativeSessionId)),
      Effect.map((reply) => ({ id: reply.nativeSessionId, settings: reply })),
    ),
  );

/** Tells `agy` the conversation is over. It never fails and never takes longer than `CLOSE_DEADLINE`. */
const closeConversation = (connection: AcpConnection, id: string): Effect.Effect<void> =>
  connection.closeSession(id).pipe(Effect.timeoutOption(CLOSE_DEADLINE), Effect.ignore);

/**
 * Returns the plan and the settings `agy` gives for the account, from the
 * probe's own conversation: the stored one when `agy` resumes it, else a new
 * one. Two probes that find no stored id at the same time may each make a
 * conversation. The last id written wins, and the other conversation stays in
 * `agy`'s files. There is no locking, because it costs one conversation, once.
 *
 * The stored id is read before `agy` starts, so a stored file that cannot be
 * read fails the probe before it can make a conversation. The scope owns the
 * `agy` process, and closing it stops the process.
 */
const readSettings = (
  spawn: AgySpawn,
  ctx: HarnessRunnerContext,
  binary: string,
): Effect.Effect<
  { readonly settings: SessionSettings; readonly planLabel: string | undefined },
  AdapterError | AcpError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const storedId = yield* readProbeConversationId(ctx.home);
    const folder = yield* makeProbeFolder(ctx.home);
    const handlers = yield* buildDecliningHandlers;
    const { connection, planLabel, confirmOwnLogin } = yield* openSignedInAgy(spawn, ctx, binary, {
      cwd: folder,
      handlers,
    });
    const resumed =
      storedId === undefined ? undefined : yield* resumeConversation(connection, storedId, folder);
    const conversation = resumed ?? (yield* makeConversation(connection, ctx.home, folder));
    // `session/new` and `session/resume` start a new worker process.
    yield* confirmOwnLogin;
    yield* closeConversation(connection, conversation.id);
    return { settings: conversation.settings, planLabel };
  });

/**
 * Reads the signed-in account's email, plan and models. Fails with a typed
 * error for every outcome that is not a result: a missing login, a refused
 * `session/new`, an account `agy` cannot use (see `checkAccountUsable`), no
 * email, or a second person who signed in while the check ran. Fails when it
 * takes longer than `PROBE_DEADLINE`.
 *
 * The email in the token file is read before the process opens and again after
 * the models are read. A sign-in rewrites that file while a probe may be
 * running, and a result built from both people would be wrong.
 */
const readAccount = (
  spawn: AgySpawn,
  ctx: HarnessRunnerContext,
  binary: string,
): Effect.Effect<AccountFindings, AdapterError | AcpError> =>
  Effect.gen(function* () {
    const emailBefore = yield* readSignedInEmail(ctx.home);
    const { settings, planLabel } = yield* Effect.scoped(readSettings(spawn, ctx, binary));
    const models = buildModelCatalog(settings);
    const usable = checkAccountUsable(planLabel, models);
    if (Result.isFailure(usable)) return yield* Effect.fail(usable.failure);
    const emailAfter = yield* readSignedInEmail(ctx.home);
    if (emailAfter === undefined) {
      return yield* Effect.fail(
        buildAdapterFailed(`Could not read who is signed in to ${ANTIGRAVITY_NAME}.`),
      );
    }
    if (emailAfter !== emailBefore) {
      return yield* Effect.fail(
        buildAdapterFailed(
          `Someone signed in to ${ANTIGRAVITY_NAME} while the account was checked. Check it again.`,
        ),
      );
    }
    const findings: AccountFindings = {
      auth: {
        status: "ok",
        identity: truncateFact(emailAfter),
        planLabel: usable.success,
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
              `${ANTIGRAVITY_NAME} did not answer within ${String(Duration.toSeconds(PROBE_DEADLINE))} seconds`,
            ),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );

/**
 * Returns the probe result for what the account check found. A missing login,
 * and the `-32000` "Authentication required" of `session/new` or
 * `session/resume`, mean the account is signed out. Any other failure is an
 * `error`, so that being offline never reads as signed out.
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
 * The version and the account are read at the same time, and each gets
 * `PROBE_DEADLINE` (15 seconds) for its work. That is not a wall for the whole
 * probe. When the work ends or is interrupted, the process is stopped the
 * normal way: SIGTERM, and SIGKILL after the grace of `stopChild` (2 seconds).
 * That comes on top of the 15 seconds, inside the 20 seconds the controller
 * waits.
 */
export const makeProbe =
  (seam: AgySeam) =>
  (ctx: HarnessRunnerContext, binary: string): Effect.Effect<ProbeResult> =>
    Effect.all(
      [
        readAgyVersion(seam.run, ctx, binary).pipe(
          Effect.timeoutOption(PROBE_DEADLINE),
          Effect.map(Option.getOrNull),
        ),
        Effect.result(readAccount(seam.spawn, ctx, binary)),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.map(([version, account]) => buildProbeResult(version, account)));
