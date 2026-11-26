/**
 * Probes an Antigravity account without running a session: the version of
 * `agy`, whether the account is signed in, who it is, its plan and its models
 * (spec 06 section 3.2).
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
import type { Run } from "../process";
import { truncateFact } from "../text";
import {
  isSignInRequired,
  openSignedInAgy,
  readAgyVersion,
  readUsablePlan,
  type AgySpawn,
} from "./agy";
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
        `Antigravity sent a message while its account was checked, and it was not used: ${method}: ${reason}`,
      ),
    );
  },
}));

/**
 * Resumes the conversation whose id is stored in the Harness Home. Returns
 * undefined when none is stored, or when `agy` cannot resume it for any reason
 * but a missing sign-in, for example because its files are gone. That is logged,
 * and the caller makes a new conversation. Fails only with the `AcpError` that
 * means the account is not signed in: a failed resume must never make a signed-in
 * account read as signed out.
 */
const resumeStoredConversation = (
  connection: AcpConnection,
  home: string,
  folder: string,
): Effect.Effect<ProbeConversation | undefined, AcpError> =>
  Effect.gen(function* () {
    const id = yield* readProbeConversationId(home);
    if (id === undefined) return undefined;
    return yield* connection
      .resumeSession({ nativeSessionId: id, cwd: folder, mcpServers: [] })
      .pipe(
        Effect.map((settings) => ({ id, settings })),
        Effect.catch((error) =>
          isSignInRequired(error)
            ? Effect.fail(error)
            : Effect.as(
                Effect.logWarning(
                  `Could not resume the conversation of the Antigravity check, so a new one is made: ${error.message}`,
                ),
                undefined,
              ),
        ),
      );
  });

/**
 * Makes a new conversation and stores its id in the Harness Home, replacing
 * the id there. The reply and the store are one step that cannot be
 * interrupted, so an interruption never leaves a conversation whose id is
 * lost. Fails with the error of `session/new`, or with an `AdapterFailed` when
 * the id cannot be stored: a probe that forgot its conversation would make a
 * new one every time.
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
 * The scope owns the `agy` process, and closing it stops the process.
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
    const folder = yield* makeProbeFolder(ctx.home);
    const handlers = yield* buildDecliningHandlers;
    const { connection, planLabel } = yield* openSignedInAgy(spawn, ctx, binary, {
      cwd: folder,
      handlers,
    });
    const conversation =
      (yield* resumeStoredConversation(connection, ctx.home, folder)) ??
      (yield* makeConversation(connection, ctx.home, folder));
    yield* closeConversation(connection, conversation.id);
    return { settings: conversation.settings, planLabel };
  });

/**
 * Reads the signed-in account's email, plan and models. Fails with a typed
 * error for every outcome that is not a result: a missing login, a refused
 * `session/new`, an account `agy` cannot use (see `readUsablePlan`), no
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
    const usable = readUsablePlan(planLabel, settings);
    if (Result.isFailure(usable)) return yield* Effect.fail(usable.failure);
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
        planLabel: usable.success,
      },
      models: buildModelCatalog(settings),
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
 * The version and the account are read at the same time, each inside
 * `PROBE_DEADLINE`. Stopping the process, which has a grace period of its own,
 * comes after it, inside the 20 seconds the controller waits.
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
        Effect.result(readAccount(seam.spawn, ctx, binary)),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.map(([version, account]) => buildProbeResult(version, account)));
