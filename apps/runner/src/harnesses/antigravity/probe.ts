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
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import type { AcpConnection, AcpError, AcpHandlers, SessionSettings } from "@hercule/acp";
import type { AdapterError, AdapterFailed, ProbeResult } from "@hercule/protocol";
import { buildAdapterFailed } from "../adapter-error-builders";
import { writeFileAtomically } from "../atomic-file";
import type { HarnessRunnerContext } from "../index";
import { PROBE_DEADLINE, buildFailedProbe } from "../probe";
import { describeFileFailure, isMissingPath, isRealFolder, UUID_PATTERN } from "../session-files";
import { truncateFact } from "../text";
import {
  ANTIGRAVITY_NAME,
  checkAccountUsable,
  openSignedInAgy,
  readAgyVersion,
  type AgySeam,
  type AgySpawn,
  type OpenedConversation,
  type SignedInAgy,
} from "./agy";
import { readLoginFile, readRegularFile } from "./harness-home";
import { buildModelCatalog } from "./model-catalog";

/**
 * The answer `agy` gives to `session/resume` for a conversation it has no
 * files for: the error -32603 with text that starts "Failed to read session"
 * (measured on a real `agy`). The probe replaces its conversation only for
 * this answer. It is a dependency on the wording of `agy`.
 */
const MISSING_CONVERSATION_CODE = -32603;
const MISSING_CONVERSATION_TEXT = "Failed to read session";

/** How long `session/close` may take. `agy` keeps the conversation either way, and the process ends next. */
const CLOSE_DEADLINE = Duration.seconds(2);

/** What a probe finds out about a signed-in account. */
type AccountFindings = Pick<ProbeResult, "auth" | "models">;

/** The working folder of the probe's conversation, directly in the Harness Home. */
const PROBE_FOLDER = "hercule-probe";

/** The file in the Harness Home that holds the id of the probe's conversation, as one line. */
const PROBE_CONVERSATION_FILE = "hercule-probe-conversation";

/** The most bytes of the conversation file that are read. A UUID line is 37. */
const PROBE_CONVERSATION_FILE_LIMIT = 128;

/**
 * Makes the working folder of the probe's conversation, `<home>/hercule-probe`,
 * with mode 0700 when it is missing, and returns its path. Fails with an
 * `AdapterFailed` when the folder cannot be made, or when something that is not
 * a real folder, such as a link or a file, is in its place.
 *
 * The folder is fixed, not new for each probe, because `agy` adds a file below
 * `implicit/` for every new working folder it sees, and nothing removes it.
 */
const makeProbeFolder = (home: string): Effect.Effect<string, AdapterFailed> =>
  Effect.tryPromise({
    try: async () => {
      const folder = join(home, PROBE_FOLDER);
      try {
        await mkdir(folder, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (!(await isRealFolder(folder))) throw new Error("it is not a folder");
      return folder;
    },
    catch: (error) =>
      buildAdapterFailed(
        `Could not make the working folder for the ${ANTIGRAVITY_NAME} check on this runner: ${describeFileFailure(error)}`,
      ),
  });

/**
 * Returns the id of the probe's conversation, or undefined when there is none
 * to use. A missing file, and a regular file whose text is not exactly one
 * UUID (empty, too long, anything else), mean none: the probe then makes a new
 * conversation and its id replaces the file. Fails with an `AdapterFailed` for
 * everything else: a folder, a link or a FIFO in the file's place, and any I/O
 * error such as permission denied. The probe could not store a new id over
 * those either, and would make a conversation every time it runs.
 */
const readConversationId = (home: string): Effect.Effect<string | undefined, AdapterFailed> =>
  Effect.tryPromise({
    try: async () => {
      try {
        const { text, isTruncated } = await readRegularFile(
          join(home, PROBE_CONVERSATION_FILE),
          PROBE_CONVERSATION_FILE_LIMIT,
        );
        const id = text.trim();
        return isTruncated || !UUID_PATTERN.test(id) ? undefined : id;
      } catch (error) {
        if (isMissingPath(error)) return undefined;
        throw error;
      }
    },
    catch: (error) =>
      buildAdapterFailed(
        `Could not read the conversation of the ${ANTIGRAVITY_NAME} check on this runner: ${describeFileFailure(error)}`,
      ),
  });

/**
 * Stores `id` as the id of the probe's conversation, replacing the one there.
 * The file is written to a temporary file in the Harness Home and then
 * renamed, so a reader never sees half of it. Fails with an `AdapterFailed`
 * when `id` is not a UUID, before anything is written, or when the file cannot
 * be written.
 */
const writeConversationId = (home: string, id: string): Effect.Effect<void, AdapterFailed> =>
  UUID_PATTERN.test(id)
    ? Effect.try({
        try: () => writeFileAtomically(join(home, PROBE_CONVERSATION_FILE), `${id}\n`),
        catch: (error) =>
          buildAdapterFailed(
            `Could not remember the conversation of the ${ANTIGRAVITY_NAME} check on this runner: ${describeFileFailure(error)}`,
          ),
      })
    : Effect.fail(
        buildAdapterFailed(
          `${ANTIGRAVITY_NAME} gave a conversation id that is not a UUID, so the check cannot keep that conversation`,
        ),
      );

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
 * Resumes the conversation `storedId`. Returns undefined when `agy` says it has
 * no such conversation (`MISSING_CONVERSATION_CODE` with
 * `MISSING_CONVERSATION_TEXT`), for example because its files are gone, and
 * logs that: the caller makes a new conversation. Fails with the error for
 * every other failure, so an `agy` that refuses `session/resume` for another
 * reason costs no conversation per probe, and the probe reports the words of
 * `agy`. A missing sign-in fails with `HarnessLoginMissing`, so it can never
 * make a signed-in account look signed out by replacing the conversation. A
 * resume that is unreadable, times out or ends with the connection is not
 * known to have failed for good, so none of them replaces the stored
 * conversation either.
 */
const resumeConversation = (
  agy: SignedInAgy,
  storedId: string,
  folder: string,
): Effect.Effect<OpenedConversation | undefined, AcpError | AdapterError> =>
  agy
    .resumeConversation({ nativeSessionId: storedId, cwd: folder, mcpServers: [] })
    .pipe(
      Effect.catch((error) =>
        error._tag === "AcpError" &&
        error.reason === "refused" &&
        error.code === MISSING_CONVERSATION_CODE &&
        (error.harnessMessage ?? "").includes(MISSING_CONVERSATION_TEXT)
          ? Effect.as(
              Effect.logWarning(
                `${ANTIGRAVITY_NAME} has no conversation to resume for its check, so a new one is made: ${error.message}`,
              ),
              undefined,
            )
          : Effect.fail(error),
      ),
    );

/**
 * Makes a new conversation and stores its id in the Harness Home, replacing
 * the id there. `agy` hands the id over as soon as it replies, and the store
 * runs in that same step, which cannot be interrupted, and before the check of
 * the new worker's login. So a failing check still leaves the id stored, and
 * the next probe resumes the conversation instead of making another.
 *
 * An interruption while `session/new` is waiting, such as the probe's
 * deadline, stops `agy` before its reply: the conversation may exist, but
 * nobody knows its id, and the next probe makes another. That costs one
 * conversation per probe only for as long as `session/new` keeps timing out.
 *
 * Fails with the error of `newConversation`, or with an `AdapterFailed` when
 * the id is not a UUID or cannot be stored: a probe that forgot its
 * conversation would make a new one every time.
 */
const makeConversation = (
  agy: SignedInAgy,
  home: string,
  folder: string,
): Effect.Effect<OpenedConversation, AcpError | AdapterError> =>
  agy.newConversation({ cwd: folder, mcpServers: [] }, (id) => writeConversationId(home, id));

/** Tells `agy` the conversation is over. It never fails and never takes longer than `CLOSE_DEADLINE`. */
const closeConversation = (connection: AcpConnection, id: string): Effect.Effect<void> =>
  connection.closeSession(id).pipe(Effect.timeoutOption(CLOSE_DEADLINE), Effect.ignore);

/**
 * Opens the probe's own conversation and returns the plan and the settings
 * `agy` gives for the account: the stored conversation when `agy` resumes it,
 * else a new one. Two probes that find no stored id at the same time may each
 * make a conversation. The last id written wins, and the other conversation
 * stays in `agy`'s files. There is no locking, because it costs one
 * conversation, once.
 *
 * The stored id is read before `agy` starts, so a stored file that cannot be
 * read fails the probe before it can make a conversation. The scope owns the
 * `agy` process, and closing it stops the process.
 */
const openProbeConversation = (
  spawn: AgySpawn,
  ctx: HarnessRunnerContext,
  binary: string,
): Effect.Effect<
  {
    readonly settings: SessionSettings;
    readonly planLabel: string | undefined;
    readonly isHeldByGoogle: boolean;
  },
  AdapterError | AcpError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const storedId = yield* readConversationId(ctx.home);
    const folder = yield* makeProbeFolder(ctx.home);
    const handlers = yield* buildDecliningHandlers;
    const agy = yield* openSignedInAgy(spawn, ctx, binary, { cwd: folder, handlers });
    const resumed =
      storedId === undefined ? undefined : yield* resumeConversation(agy, storedId, folder);
    const conversation = resumed ?? (yield* makeConversation(agy, ctx.home, folder));
    yield* closeConversation(agy.connection, conversation.id);
    return {
      settings: conversation.settings,
      planLabel: agy.planLabel,
      isHeldByGoogle: conversation.isHeldByGoogle,
    };
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
    const emailBefore = (yield* readLoginFile(ctx.home))?.email;
    const { settings, planLabel, isHeldByGoogle } = yield* Effect.scoped(
      openProbeConversation(spawn, ctx, binary),
    );
    const models = buildModelCatalog(settings);
    const usable = checkAccountUsable(planLabel, models, isHeldByGoogle);
    if (Result.isFailure(usable)) return yield* Effect.fail(usable.failure);
    const emailAfter = (yield* readLoginFile(ctx.home))?.email;
    if (emailAfter === undefined) {
      return yield* Effect.fail(
        buildAdapterFailed(
          `Could not read who is signed in to ${ANTIGRAVITY_NAME}. Sign in again on this runner.`,
        ),
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
 * Returns the probe result for what the account check found. A missing login
 * (`HarnessLoginMissing`) means the account is signed out. Any other failure
 * is an `error`, so that being offline never reads as signed out.
 */
const buildProbeResult = (
  version: string | null,
  account: Result.Result<AccountFindings, AdapterError | AcpError>,
): ProbeResult => {
  if (Result.isSuccess(account))
    return { harnessVersion: version, ...account.success, usage: null };
  const error = account.failure;
  return error._tag === "HarnessLoginMissing"
    ? { harnessVersion: version, auth: { status: "unauthenticated" }, models: [], usage: null }
    : buildFailedProbe(version, error.message);
};

/**
 * Builds the probe function from how `agy` is spawned and how a command is run.
 * The probe never fails: every error becomes a probe result, and every result
 * carries the version of `agy` when it was read in time.
 *
 * The version and the account are read at the same time, and each gets
 * `PROBE_DEADLINE` for its work. That is not a wall for the whole probe. When
 * the work ends or is interrupted, the process is stopped the normal way:
 * SIGTERM, and SIGKILL after `STOP_GRACE`. That comes on top of
 * `PROBE_DEADLINE`, and the controller waits for a probe long enough for both.
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
