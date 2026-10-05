/**
 * The session service: the session row, its lifecycle, the inputs waiting on
 * it, and the stream of events it leaves behind.
 *
 * This service stores a session from a spec that is already decided, and
 * turns what a runner reports about a session into rows. It also builds the
 * frames sent to a runner about a session, because the frame contents belong
 * to this domain. But nothing here talks to a runner: the controller daemon,
 * one layer up, decides when a frame is sent and over which connection. So the
 * methods the daemon calls return frames, or return what is left to do,
 * instead of doing it.
 *
 * A method that takes only ids does not decode them again: the transport has
 * already decoded a request's ids against the contract, and a caller inside
 * the controller passes ids it read from stored rows.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  SessionSpec,
  type AccessMode,
  type ApprovalDecision,
  type Delivery,
  type ModelSelection,
  type OpenRequest,
  type ProviderEvent,
  type QuestionAnswers,
  type SessionBinding,
  type SessionInput,
  type SessionInputResult,
  type SessionInterrupt,
  type SessionRespondToApprovalRequest,
  type SessionRespondToQuestion,
  type SessionStart,
  type SessionStop,
  type WorkspaceStepKey,
} from "@hercule/protocol";
import {
  createDecodeValidationError,
  createInvalidStateError,
  createNotFoundError,
  createValidationError,
  DEFAULT_PAGE_LIMIT,
  Id,
  INPUT_SORT_FIELDS,
  INPUT_UPDATE_FIELDS,
  InvalidState,
  NotFound,
  SESSION_SORT_FIELDS,
  SessionFilter,
  TRANSCRIPT_SORT_FIELDS,
  type Forbidden,
  type Input,
  type Session,
  type SessionStatus,
  type SortDirection,
  type TranscriptRow,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { currentStamp, requireGrant, SYSTEM_ACTOR } from "../actor";
import { PluginHost } from "../plugins";
import {
  afterCommit,
  announce,
  nowIso,
  buildPageInputFields,
  refuseCursor,
  resolveSortDirection,
  withTransaction,
  type Page,
} from "../db";
import { mintToken, hashToken } from "../credentials";
import { AuditLog } from "../events";
import { Notifier } from "../notifications";
import { SessionTokens } from "../permissions";
import type { SecretDecryptError } from "../secrets";
import { WorkspaceService, type GithubAccount } from "../workspaces";
import {
  APPROVAL_ANSWER_IDS,
  buildApprovalNotification,
  buildRequestSubject,
  buildWaitEndedWithdrawReason,
  buildWithdrawReason,
  WITHDRAW_REASON_SESSION_ENDED,
  type WaitEndedBy,
} from "./approval-notification";
import { inputRepository, type LostWakeUp, type NewMatchedInput, type StoredInput } from "./inputs";
import { SessionObserver, type SessionEndReason } from "./observer";
import { sessionRecordComposer } from "./records";
import { isResumeHeld } from "./resume-hold";
import {
  readSessionOrFail,
  sessionRepository,
  type QueuePosition,
  type SessionAccess,
  type StoredSession,
} from "./repository";
import {
  fold,
  computeOpenRequestAfter,
  isRequestEvent,
  startTracking,
  type Folded,
  type Tracked,
} from "./stream";

const QueryInput = Schema.Struct({
  ...SessionFilter.fields,
  ...buildPageInputFields(SESSION_SORT_FIELDS),
});

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

const TranscriptInput = Schema.Struct({ id: Id, ...buildPageInputFields(TRANSCRIPT_SORT_FIELDS) });

export type TranscriptInput = Schema.Schema.Type<typeof TranscriptInput>;

const InputQueryInput = Schema.Struct({ id: Id, ...buildPageInputFields(INPUT_SORT_FIELDS) });

export type InputQueryInput = Schema.Schema.Type<typeof InputQueryInput>;

const InputUpdate = Schema.Struct({ id: Id, inputId: Id, ...INPUT_UPDATE_FIELDS });

export type InputUpdate = Schema.Schema.Type<typeof InputUpdate>;

export interface SessionPage {
  readonly items: ReadonlyArray<Session>;
  readonly nextCursor?: string;
}

export interface TranscriptPage {
  readonly items: ReadonlyArray<TranscriptRow>;
  readonly nextCursor?: string;
}

export interface InputPage {
  readonly items: ReadonlyArray<Input>;
  readonly nextCursor?: string;
}

/**
 * Everything needed to store one new session, whether it starts a
 * conversation or continues another session. Every value is already decided:
 * the controller daemon chose the runner and opened the workspace before this
 * row is written.
 */
export interface CreateRequest {
  /**
   * Created by the caller, not by the insert. The workspace is opened in the
   * same transaction, and a thread's own worktree is created on a branch named
   * after the thread, so the id has to exist before either row does.
   */
  readonly id: string;
  readonly permissionProfileId: string;
  /** The Agent the session was spawned from; `undefined` for a Thread. */
  readonly agentId: string | undefined;
  /** The assistant's conversation the session answers; `undefined` for any other session. */
  readonly conversationId: string | undefined;
  /**
   * The run, agent step and iteration whose prompt the session opens with;
   * `undefined` for any other session. The run and step are stored on the
   * session, and the iteration on its first input.
   */
  readonly step: WorkspaceStepKey | undefined;
  readonly runnerId: string;
  readonly requestedAccessMode: AccessMode;
  readonly parentSessionId: string | undefined;
  /** The spec sent to the runner. The row's stored fields are taken from it. */
  readonly spec: SessionSpec;
  readonly prompt: string;
  /**
   * The session's title, chosen by the caller, or `undefined` to take it
   * from the prompt (`buildTitle`).
   */
  readonly title: string | undefined;
  readonly kind: "session.spawned" | "session.continued";
  /** The audit entry's payload, apart from the new session's id. */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly projectId: string | undefined;
  /** The branch the main workspace is switched to before the harness starts. */
  readonly checkoutBranch: string | undefined;
  /** The GitHub account this session pushes as. */
  readonly githubConnectionId: string | undefined;
  /**
   * The timestamp, chosen by the caller: the workspace it opened and this row
   * are written together and share one timestamp. The actor is read from the
   * ambient context, so it is not passed.
   */
  readonly at: string;
}

/** A session claimed for starting, and the complete frame that starts it. */
export interface StartRequest {
  readonly sessionId: string;
  readonly frame: SessionStart;
}

/**
 * What a start frame needs from outside this domain, passed in by the caller:
 * the credential readers, and the id of the controller's local runner. The
 * controller daemon passes its own credential readers, so this domain never
 * reads a secret itself.
 */
export interface StartNeeds {
  readonly readGithubAccount: (connectionId: string) => Effect.Effect<GithubAccount | undefined>;
  /**
   * Returns the provider instance's credentials, decrypted for this frame and
   * stored nowhere. Fails when they cannot be decrypted, which skips the
   * session: a session started without its key would report that it is not
   * logged in.
   */
  readonly readSecrets: (
    instanceId: string,
    providerId: string,
  ) => Effect.Effect<Record<string, string>, SqlError | SecretDecryptError>;
  /**
   * The id of the controller's local runner, or `undefined` while it is not
   * known. A Thread starting on this runner gets the `userMaterial` flag.
   */
  readonly localRunnerId: string | undefined;
}

/** One user input to store, and the model selection the session runs under from then on. */
export interface TakeInputRequest<E> {
  readonly sessionId: string;
  /** The model selection the session runs under from this input on. */
  readonly modelSelection: ModelSelection;
  /**
   * Builds the encoded spec a resumed session goes back on the queue with,
   * from the session as it is read inside the transaction, for an input that
   * resumes an exited session; `undefined` for a session that is still live.
   * It runs only once `resume` has decided the session is resumed.
   */
  readonly buildResumeSpec: ((session: StoredSession) => Effect.Effect<string, E>) | undefined;
  readonly text: string;
  readonly at: string;
  /**
   * Claims the row in the insert, for an input sent to an idle session. The
   * input is sent as soon as it exists, so nothing else may claim it.
   */
  readonly claimed: boolean;
  /** The agent step iteration this input is the prompt for; `undefined` for any other input. */
  readonly stepIteration?: number;
}

/**
 * What the controller daemon still has to do after a report's rows are
 * committed. Each item means sending a frame to a runner, which this domain
 * never does itself.
 */
export interface AppliedReport {
  /** The session's new status, or `undefined` when this report did not change it. */
  readonly moved: SessionStatus | undefined;
  /**
   * `true` when the session exited while input it keeps was still waiting
   * for it. The caller resumes the session after the commit, so the input
   * runs.
   */
  readonly exitedHoldingInput?: true;
}

/** Converts a page to the contract's shape, where a missing cursor is an absent key, not `null`. */
const toPageOutput = <A>(listing: Page<A>): { items: ReadonlyArray<A>; nextCursor?: string } => ({
  items: listing.items,
  ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
});

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeTranscript = Schema.decodeUnknownEffect(TranscriptInput);
const decodeInputQuery = Schema.decodeUnknownEffect(InputQueryInput);
const decodeInputUpdate = Schema.decodeUnknownEffect(InputUpdate);
const encodeSpec = Schema.encodeUnknownSync(SessionSpec);
const decodeSpecDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionSpec));

/** Newest first: a session list is read as a history. */
const DEFAULT_DIRECTION: SortDirection = "desc";

/** Oldest first: a transcript is read forwards, the way it happened. */
const TRANSCRIPT_DIRECTION: SortDirection = "asc";

/** Oldest first: inputs are sent in the order the caller sent them. */
const INPUT_DIRECTION: SortDirection = "asc";

const NO_SUCH_INPUT = "no such input on that session";

const ALREADY_SENT = "that input has already been sent to the runner";

/**
 * The refusal of a second answer to one request. The runner still reports
 * the request as open until the harness has taken the first answer, so
 * without this check a second click would send the harness a second answer.
 */
const ALREADY_ANSWERED =
  "that request was already answered, so this answer was not sent; " +
  "read the session again to see whether it is waiting on a request now";

/**
 * The refusal of an answer to a request whose wait already ended without an
 * answer: the user interrupted the turn or stopped the session, or the
 * harness moved on. The runner may still report the request as open for a
 * moment, but the harness no longer waits for this answer.
 */
const WAIT_ENDED =
  "that request no longer waits for an answer: the turn was interrupted, the session was stopped, " +
  "or the harness moved on, so this answer was not sent; " +
  "read the session again to see whether it is waiting on a request now";

/**
 * The refusal of `input.update` and `input.cancel` on a session that answers
 * an assistant's conversation. The conversation already shows the input as
 * the owner's message. A changed text would reach the assistant as words the
 * owner never wrote there, and a cancelled one would leave the owner with no
 * reply and no notice.
 */
const CONVERSATION_INPUT_FIXED =
  "this input is the owner's message in an assistant's conversation, so it cannot be changed or cancelled; " +
  "to correct or withdraw it, send a follow-up message with conversation.send";

/**
 * The refusal of `input.update`, `input.cancel` and `input.steer` on the
 * prompt of an agent step. The workflow run waits for the turn that prompt
 * starts:
 *
 * - a changed text would run a step the workflow never defined;
 * - a cancelled prompt would leave the run waiting for a turn that never
 *   comes;
 * - a prompt steered into a running turn would end the step with that
 *   turn's answer.
 */
const STEP_INPUT_FIXED =
  "this input is the prompt of a workflow run's agent step, so it cannot be changed, cancelled or steered; " +
  "it is sent when the session is next idle; to stop the step, cancel the run with run.cancel";

/** Why a step prompt was cancelled when its run ended before the prompt was sent. */
const STEP_RUN_ENDED = "the step's run ended before this prompt was sent";

/** Why an input was cancelled on a session that `endOnLostRunners` ended. */
const RUNNER_LOST =
  "that session's runner was not heard from for longer than the session's absolute timeout, " +
  "so the session was ended before this input was sent";

/**
 * Returns why a queued input was never sent. It is stored on the input when
 * its session exits, for a session that does not keep its input.
 */
const describeExited = (reason: string): string =>
  `that session's harness exited (${reason}) before this input was sent`;

/**
 * Returns the provider-native session id from a `session.started` event, if
 * it has one. The key is the same as `SessionBinding`'s field, because it is
 * the same value. When the event has none, the id stays null until the next
 * sessions report.
 */
const findNativeId = (event: ProviderEvent): string | undefined =>
  event._tag === "session.started" ? event.providerRefs?.nativeSessionId : undefined;

/** The maximum length of a session title, as shown in a sidebar row. */
const MAX_TITLE_LENGTH = 80;

/**
 * Builds a session's short title, trimmed and cut to `MAX_TITLE_LENGTH`:
 * `chosen` when the caller chose a title, otherwise the first non-blank line
 * of the session's first prompt. That way a sidebar row has something to show
 * without reading the transcript.
 */
const buildTitle = (chosen: string | undefined, prompt: string): string => {
  const title = chosen ?? prompt.split("\n").find((one) => one.trim().length > 0) ?? "";
  return title.trim().slice(0, MAX_TITLE_LENGTH);
};

type ReadError = Unauthenticated | Forbidden | Validation | SqlError;

type InputError = ReadError | NotFound | InvalidState | Schema.SchemaError;

/**
 * Checks whether a session keeps its inputs that are still waiting when it
 * exits, so they go to the next process when it is resumed. Only a session
 * that answers an assistant's conversation keeps them, whatever the reason,
 * because they are the owner's messages. A session whose conversation was
 * deleted keeps nothing: it is history, and nobody reads its answers.
 */
const keepsInputsOnExit = (
  session: Pick<StoredSession, "conversationId" | "conversationDeleted">,
): boolean => session.conversationId !== null && !session.conversationDeleted;

/**
 * Checks whether an agent step's session keeps its waiting step prompt
 * through its last exit, so the prompt resumes the session in place.
 * `exited` is the session as read after the exit. It keeps the prompt when
 * all of these hold:
 *
 * - an agent step started the session;
 * - the exit left the harness's native state behind (`exitReason` is
 *   `idle_unload` or `runner_restart`), so the next turn continues the same
 *   transcript;
 * - the session can be resumed (`resumable`);
 * - the crash-loop guard is not armed: a session that was resumed for this
 *   prompt and exited before it started a turn would most likely fail the
 *   same way again.
 *
 * Otherwise the prompt is cancelled, and the runs domain fails the step. Any
 * other exit, such as a stop or a timeout, ends the step's session for good.
 * When the step's run ends, the run cancels the prompts it still has waiting
 * (`cancelStepPromptsOfEndedRun`), so a kept prompt never resumes a session
 * for a run that has ended.
 */
const keepsStepPromptOnExit = (
  exited: Pick<StoredSession, "runId" | "exitReason" | "resumable" | "crashGuardArmed">,
): boolean =>
  exited.runId !== null &&
  (exited.exitReason === "idle_unload" || exited.exitReason === "runner_restart") &&
  exited.resumable &&
  !exited.crashGuardArmed;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* sessionRepository;
  const recordComposer = yield* sessionRecordComposer;
  const inputs = yield* inputRepository;
  const readSession = readSessionOrFail(sessions);
  const tokens = yield* SessionTokens;
  const audit = yield* AuditLog;
  const observer = yield* SessionObserver;
  const workspaces = yield* WorkspaceService;
  const notifier = yield* Notifier;

  /**
   * Each session's ingest state: its last sequence number and the delta text
   * held for it. This lives in memory only. After a restart the sequence is
   * read again from the rows, and no text is held. An entry is removed when
   * the session exits, whatever ends it.
   */
  const tracking = new Map<string, Tracked>();

  /**
   * Puts an exited session back on the queue, with the spec that resumes its
   * own transcript, when the session may be resumed now. Returns whether it
   * did. It refuses, writing nothing, when:
   *
   * - the session is no longer exited, or its transcript cannot be resumed
   *   (`resumable` on the row);
   * - no input is waiting for it, so a resumed process would have nothing to
   *   do;
   * - an input is still on the wire: the send that claimed it has not heard
   *   back yet, and it will put the input back to waiting or record it as
   *   delivered. Resuming before that would let the input be sent twice;
   * - the crash-loop guard holds the session back (`isResumeHeld`).
   *
   * `buildSpec` is given the session as read inside the transaction, and
   * runs only once the session is resumed, because building an assistant's
   * resume spec also writes the session's access. The check and
   * the write run in one transaction, joining the caller's as a savepoint
   * when there is one, so two callers racing to resume the same session
   * resume it once.
   *
   * A caller that writes more than this one change passes
   * `announceTheMove: false` and announces once for everything it wrote. A
   * caller that writes only this change passes `true`.
   */
  const resume = <E>(
    sessionId: string,
    buildSpec: (session: StoredSession) => Effect.Effect<string, E>,
    at: string,
    announceTheMove: boolean,
  ): Effect.Effect<boolean, E | SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const found = yield* sessions.one(sessionId);
        if (Option.isNone(found)) return false;
        const session = found.value;
        if (session.status !== "exited" || !session.resumable) return false;
        if (!session.inputWaiting) return false;
        if (yield* inputs.holdsInputOnTheWire(sessionId)) return false;
        if (isResumeHeld(session)) return false;
        yield* sessions.resume(sessionId, yield* buildSpec(session), at);
        if (session.workspaceId !== null) {
          yield* workspaces.acquire({ kind: "session", id: sessionId }, session.workspaceId, at);
        }
        // Armed until the resumed process starts a turn or new input is
        // stored. If it exits before either, it is not resumed again for the
        // same input (`isResumeHeld`).
        yield* sessions.setCrashGuardArmed(sessionId, true);
        // The resumed process numbers its events from zero again, so the held
        // ingest state no longer applies. It is dropped once the resume is
        // committed, like any other cache invalidation.
        yield* afterCommit(() => {
          tracking.delete(sessionId);
        });
        if (announceTheMove) {
          yield* announce({ _tag: "record", topic: "session", id: sessionId, kind: "updated" });
        }
        return true;
      }),
    );

  /**
   * Returns an input that a caller can still edit, cancel or steer. Fails when:
   *
   * - the session has no input with that id (`NotFound`);
   * - the input was already delivered or cancelled (`InvalidState`);
   * - the input was already sent to the runner (`InvalidState`). The runner
   *   already has its text and it cannot be taken back, so reporting it as
   *   edited or cancelled would be wrong;
   * - the input is the prompt of an agent step (`InvalidState`).
   */
  const queuedInput = (
    sessionId: string,
    inputId: string,
  ): Effect.Effect<StoredInput, NotFound | InvalidState | SqlError> =>
    Effect.gen(function* () {
      const found = yield* inputs.one(sessionId, inputId);
      if (Option.isNone(found)) return yield* Effect.fail(createNotFoundError(NO_SUCH_INPUT));
      if (found.value.status !== "queued") {
        return yield* Effect.fail(
          createInvalidStateError(`that input was already ${found.value.status}`),
        );
      }
      if (found.value.sentAt !== null)
        return yield* Effect.fail(createInvalidStateError(ALREADY_SENT));
      if (found.value.stepIteration !== null)
        return yield* Effect.fail(createInvalidStateError(STEP_INPUT_FIXED));
      return found.value;
    });

  /**
   * Checks that the queued inputs of a session may be changed or cancelled.
   * Fails with `NotFound` when there is no such session, and with
   * `InvalidState` when the session answers an assistant's conversation:
   * input to an assistant goes only through `conversation.send`, and the
   * conversation keeps what was sent.
   */
  const requireChangeableInputs = (
    sessionId: string,
  ): Effect.Effect<void, NotFound | InvalidState | SqlError> =>
    Effect.flatMap(readSession(sessionId), (session) =>
      session.conversationId === null
        ? Effect.void
        : Effect.fail(createInvalidStateError(CONVERSATION_INPUT_FIXED)),
    );

  /**
   * Announces each session that moved to `exited` and forgets its token and
   * ingest state, without touching its inputs. Part of `endSessions`.
   */
  const forgetSessions = (ids: ReadonlyArray<string>): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        ids,
        (id) => announce({ _tag: "record", topic: "session", id, kind: "updated" }),
        { discard: true },
      );
      // From now on the row's status is what makes the token invalid. This
      // only drops what was cached from the token while the session ran. It
      // runs after the commit, so a call in flight cannot cache the old row
      // again between the drop and the write becoming visible.
      yield* afterCommit(() => {
        tokens.forgetSessions(ids);
        for (const id of ids) tracking.delete(id);
      });
    });

  /**
   * Withdraws the approval notification about the request a session was
   * waiting on, if one was open. It does nothing when the request was
   * already answered through the controller, because that answer resolved
   * the notification.
   */
  const withdrawOpenRequestNotification = (
    session: Pick<StoredSession, "id" | "openRequest">,
    reason: string,
  ): Effect.Effect<void, SqlError> =>
    session.openRequest === null
      ? Effect.void
      : notifier.withdrawDecisionsAbout(
          [buildRequestSubject(session.id, session.openRequest.requestId)],
          reason,
        );

  /**
   * Stores the request a session now waits on, or `null` for none, and keeps
   * the approval notification in step with it, in the caller's transaction:
   *
   * - the notification about the request that stops waiting is withdrawn
   *   with `reason`;
   * - an approval request that starts waiting raises a new notification. A
   *   request reported again with the same id keeps its notification.
   *
   * `session` is the row as it was before this change.
   */
  const replaceOpenRequest = (
    session: StoredSession,
    request: OpenRequest | null,
    reason: string,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      yield* sessions.setOpenRequest(session.id, request);
      if (session.openRequest?.requestId === request?.requestId) return;
      yield* withdrawOpenRequestNotification(session, reason);
      const notification =
        request === null ? undefined : buildApprovalNotification(session, request);
      if (notification !== undefined) yield* notifier.createCoreNotification(notification);
    });

  /**
   * Does the cleanup after sessions move to `exited`, whatever ended them.
   * Every path that ends a session calls this, in the transaction that ended
   * it. For each session, it:
   *
   * - stores `reason` on the row, where `keepsStepPromptOnExit` reads it;
   * - cancels its inputs not yet sent, storing `cancelReason` on them when
   *   one is given, unless the session keeps them (`keepsInputsOnExit`,
   *   `keepsStepPromptOnExit`);
   * - releases its lease on its workspace: `idle` when it can be resumed,
   *   so a thread the user may come back to keeps its files for the long
   *   window, and `orphan` when it cannot;
   * - withdraws the approval notification about the request it was waiting
   *   on;
   * - tells `SessionObserver` that the session exited, and whether the
   *   crash-loop guard now holds it back from a resume;
   * - forgets its token and ingest state, and announces it once.
   *
   * `ended` holds the rows as they were just before the end.
   */
  const endSessions = (
    ended: ReadonlyArray<StoredSession>,
    reason: SessionEndReason,
    cancelReason?: string,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      for (const session of ended) {
        yield* sessions.setExitReason(session.id, reason);
        // Read again after the exit: whether the session can be resumed is
        // computed only for an exited row.
        const after = yield* sessions.one(session.id);
        const keeps =
          Option.isSome(after) &&
          (keepsInputsOnExit(after.value) || keepsStepPromptOnExit(after.value));
        if (!keeps) {
          yield* inputs.cancelQueued(session.id, cancelReason);
        }
        // For an exit the harness reported, `applyReport` has already
        // withdrawn the notification, so this call finds it resolved and does
        // nothing. For every other end, the notification is withdrawn here.
        yield* withdrawOpenRequestNotification(session, WITHDRAW_REASON_SESSION_ENDED);
        if (session.workspaceId !== null && Option.isSome(after)) {
          yield* workspaces.release(
            { kind: "session", id: session.id },
            after.value.resumable ? "idle" : "orphan",
            after.value.exitedAt ?? (yield* nowIso),
          );
        }
        // A session whose inputs were cancelled has nothing waiting, so the
        // guard cannot hold it.
        yield* observer.sessionExited({
          session,
          reason,
          resumeHeld: keeps && isResumeHeld(after.value),
        });
      }
      yield* forgetSessions(ended.map((session) => session.id));
    });

  /**
   * Ends every session waiting on a workspace that could not be created. The
   * sessions never started, so there is no harness to stop and nothing to send
   * to the runner. The user needs the reason, so the runner's error message is
   * stored as a `session.exited` row on each session's stream, where the exit
   * is shown.
   */
  const endForWorkspace = (
    workspaceId: string,
    message: string | null,
  ): Effect.Effect<void, SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const at = yield* nowIso;
        const ended = yield* sessions.endInWorkspace(workspaceId, at);
        for (const { id } of ended) {
          yield* sessions.append(id, {
            seq: 0,
            at,
            event: {
              _tag: "session.exited",
              eventId: crypto.randomUUID(),
              sessionId: id,
              at,
              reason: "workspace_failed",
              ...(message === null ? {} : { message }),
            },
          });
          yield* audit.append({
            kind: "session.stopped",
            actor: SYSTEM_ACTOR,
            payload: { sessionId: id, workspaceId, reason: "workspace_failed" },
            at,
          });
          // The exit is a row on this session's stream, so clients watching
          // the session's transcript must be notified.
          yield* announce({ _tag: "transcript", sessionId: id });
        }
        yield* endSessions(ended, "workspace_failed", message ?? undefined);
      }),
    );

  /**
   * Moves an `idle` session to `busy`, because an input the runner received
   * opened a turn. Returns whether the session moved. Leaves the session
   * alone when it is in any other status, or when another runner holds it
   * now. Runs inside the caller's transaction.
   *
   * From that answer until the turn ends, a turn is running, even before the
   * runner reports `turn.started`. So an exit in between is an exit during a
   * turn, and the owner is told.
   */
  const openTurn = (runnerId: string, sessionId: string): Effect.Effect<boolean, SqlError> =>
    Effect.gen(function* () {
      const found = yield* sessions.one(sessionId);
      if (Option.isNone(found)) return false;
      const session = found.value;
      if (session.runnerId !== runnerId || session.status !== "idle") return false;
      yield* sessions.moved(session.id, "busy", yield* nowIso);
      // A turn opened, so the process did work: the crash-loop guard no
      // longer applies to it, as when `turn.started` moves it to `busy`.
      yield* sessions.setCrashGuardArmed(session.id, false);
      return true;
    });

  return {
    query: (input: QueryInput): Effect.Effect<SessionPage, ReadError> =>
      Effect.gen(function* () {
        yield* requireGrant("session.query");
        const {
          limit,
          cursor,
          sort,
          status,
          runnerId,
          agentId,
          permissionProfileId,
          conversationId,
          runId,
          thread,
        } = yield* Effect.mapError(decodeQuery(input), createDecodeValidationError);
        // A Thread is a session with no Agent behind it. `agentId` filters for
        // the sessions of one Agent, and `thread` filters for the sessions
        // with no Agent, so no session can match both. A query with both would
        // return an empty page, which looks like "there are none" instead of
        // "the query is wrong".
        if (agentId !== undefined && thread !== undefined) {
          return yield* Effect.fail(
            createValidationError([
              {
                path: ["thread"],
                message:
                  "a Thread is a session with no agent, so a query cannot ask for both: " +
                  "send agentId to list one agent's sessions, or thread to list the " +
                  "sessions that have no agent",
              },
            ]),
          );
        }
        const listing = yield* refuseCursor(
          sessions.list({
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: resolveSortDirection(sort, DEFAULT_DIRECTION),
            status,
            runnerId,
            agentId,
            permissionProfileId,
            conversationId,
            runId,
            thread,
          }),
        );
        const composeRecord = yield* recordComposer;
        return toPageOutput({ ...listing, items: listing.items.map(composeRecord) });
      }),

    /**
     * Reads and decodes the spec that was sent to the runner for one session.
     * Fails with `NotFound` when there is no such session. A session that
     * continues this session's transcript runs under this spec. It is read
     * back rather than built again, so the continuation runs under exactly
     * what the parent ran under, including fields nothing else reads.
     *
     * It checks no grant. The caller is the controller daemon, which runs a
     * resume or a fork, and the operation behind it already checked its grant.
     */
    readSpec: (
      sessionId: string,
    ): Effect.Effect<SessionSpec, NotFound | SqlError | Schema.SchemaError> =>
      Effect.gen(function* () {
        const document = yield* sessions.readSpecDocument(sessionId);
        if (Option.isNone(document))
          return yield* Effect.fail(createNotFoundError("no such session"));
        return yield* decodeSpecDocument(document.value);
      }),

    read: (id: Id): Effect.Effect<Session, Exclude<ReadError | NotFound, Validation>> =>
      Effect.gen(function* () {
        yield* requireGrant("session.read");
        return (yield* recordComposer)(yield* readSession(id));
      }),

    /**
     * Returns a page of the session's normalized stream, in position order
     * (spec 11 section 2). Reads the session first, so a new session with no
     * rows yet returns an empty page and a missing session fails with
     * `NotFound`.
     */
    transcript: (input: TranscriptInput): Effect.Effect<TranscriptPage, ReadError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("transcript.read");
        const { id, limit, cursor, sort } = yield* Effect.mapError(
          decodeTranscript(input),
          createDecodeValidationError,
        );
        yield* readSession(id);
        const listing = yield* refuseCursor(
          sessions.transcript({
            sessionId: id,
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: resolveSortDirection(sort, TRANSCRIPT_DIRECTION),
          }),
        );
        return toPageOutput(listing);
      }),

    /**
     * Stores a new session, its first input and the audit entry for it,
     * joining the caller's transaction. This is the only place a session
     * decided by the controller daemon is written. The session is always
     * stored as `queued`: whether the runner has room for it right now is
     * decided by dispatch, the same way for a new session as for any other.
     */
    create: (open: CreateRequest): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const actor = yield* currentStamp;
        yield* sessions.insert({
          id: open.id,
          title: buildTitle(open.title, open.prompt),
          permissionProfileId: open.permissionProfileId,
          agentId: open.agentId,
          conversationId: open.conversationId,
          step: open.step,
          instanceId: open.spec.instanceId,
          runnerId: open.runnerId,
          workspaceId: open.spec.workspaceId,
          projectId: open.projectId,
          checkoutBranch: open.checkoutBranch,
          githubConnectionId: open.githubConnectionId,
          requestedAccessMode: open.requestedAccessMode,
          accessMode: open.spec.accessMode,
          // The row stores exactly the spec the runner receives, byte for
          // byte, not a re-encoding of a similar object.
          spec: JSON.stringify(encodeSpec(open.spec)),
          modelSelection: open.spec.modelSelection,
          parentSessionId: open.parentSessionId,
          at: open.at,
        });
        // The prompt is stored as an ordinary input, waiting with the
        // session. It is sent when the harness starts, and a controller that
        // restarts in between still has it.
        yield* inputs.insert({
          sessionId: open.id,
          source: "user",
          actor,
          text: open.prompt,
          at: open.at,
          ...(open.step === undefined ? {} : { stepIteration: open.step.iteration }),
        });
        yield* audit.append({
          kind: open.kind,
          actor,
          record: { topic: "session", id: open.id },
          payload: {
            ...open.payload,
            sessionId: open.id,
            ...(open.spec.workspaceId === null ? {} : { workspaceId: open.spec.workspaceId }),
          },
          at: open.at,
        });
      }),

    /**
     * Moves up to `room` of this runner's oldest queued sessions to
     * `starting`, and returns the complete start frame for each: the token,
     * the spec, the GitHub account it pushes as, when a Connection is set, and
     * the `userMaterial` flag that lets a Thread on the local runner see User
     * Material.
     * Joins the caller's transaction and reads what the frames need inside it,
     * which is fine because a database read and a decrypt do not wait on a
     * runner. The daemon sends the frames only after that transaction commits.
     */
    starting: (
      runnerId: string,
      room: number,
      needs: StartNeeds,
    ): Effect.Effect<ReadonlyArray<StartRequest>, SqlError> =>
      Effect.gen(function* () {
        const at = yield* nowIso;
        const claimed: Array<StartRequest> = [];
        const skipped: Array<string> = [];
        const keyless: Array<string> = [];
        // The loop moves past every row it reads, including rows that fail to
        // decode, so each candidate is fetched and decoded once. A runner's
        // room is for sessions that can start, not for specs that cannot.
        let after: QueuePosition | undefined;
        while (claimed.length < room) {
          const queued = yield* sessions.oldestQueued(runnerId, room - claimed.length, after);
          if (queued.length === 0) break;
          for (const row of queued) {
            after = { createdAt: row.createdAt, id: row.id };
            if (claimed.length >= room) break;
            // Normally the same codec wrote and reads a stored spec, so one
            // that fails to decode was queued by an older build. It stays
            // queued, where a user can see it and stop it, and the loop
            // continues.
            const spec = yield* Effect.option(decodeSpecDocument(row.spec));
            if (Option.isNone(spec)) {
              skipped.push(row.id);
              continue;
            }
            // Read per row, before the row leaves the queue: a credential that
            // fails to decrypt is one session's problem, and failing here
            // would roll back every other session claimed in this batch. It is
            // read now rather than stored, like the account's token: the frame
            // is the only place it is written down.
            const secrets = yield* Effect.option(
              needs.readSecrets(spec.value.instanceId, row.providerId),
            );
            if (Option.isNone(secrets)) {
              keyless.push(row.id);
              continue;
            }
            // The session's own token for the public API. It is created for
            // this start and its hash is stored in the same update that marks
            // the session as starting, so the token is valid exactly while the
            // row says the session is running. A resume also passes through
            // here, so its new token replaces the one the previous process
            // held.
            const token = mintToken();
            yield* sessions.started(row.id, hashToken(token), at);
            yield* announce({ _tag: "record", topic: "session", id: row.id, kind: "updated" });
            // The account's token is read now rather than stored: the only
            // place it is written is the frame that carries it to the runner.
            const account =
              row.githubConnectionId === null
                ? undefined
                : yield* needs.readGithubAccount(row.githubConnectionId);
            claimed.push({
              sessionId: row.id,
              frame: {
                _tag: "sessionStart",
                sessionId: row.id,
                providerId: row.providerId,
                config: row.config as Schema.Json,
                secrets: secrets.value,
                spec: spec.value,
                token,
                ...(account === undefined
                  ? {}
                  : { ghToken: account.token, gitIdentity: account.gitIdentity }),
                ...(row.checkoutBranch === null ? {} : { checkoutBranch: row.checkoutBranch }),
                // Only a Thread on the local runner sees User Material (spec
                // 06 section 9.1). The flag is decided here at every start
                // rather than stored on the spec, so a resume or a fork of a
                // Thread is decided again.
                ...(row.agentId === null && needs.localRunnerId === runnerId
                  ? { userMaterial: true }
                  : {}),
              },
            });
          }
        }
        // Logged, because to every observer a skipped row looks like one
        // waiting for room. Only this log shows otherwise.
        if (skipped.length > 0) {
          yield* Effect.logError(
            "skipped queued sessions whose stored spec no longer decodes; they stay queued",
            skipped,
          );
        }
        if (keyless.length > 0) {
          yield* Effect.logError(
            "skipped queued sessions whose provider instance's stored credential could not be " +
              "decrypted; they stay queued",
            keyless,
          );
        }
        return claimed;
      }),

    /**
     * Builds the frame that stops a session's harness. The daemon decides when
     * to send it, and writes the changes around it.
     */
    stopping: (sessionId: string): SessionStop => ({ _tag: "sessionStop", sessionId }),

    /**
     * Builds the frame that sends one stored input to the session's runner,
     * with the session's current model selection. The selection goes with
     * every input because only the adapter knows whether the input starts a
     * turn, and a harness accepts a model change only at the start of a turn.
     *
     * The prompt of an agent step carries the step's key, so the runner knows
     * the turn it starts is the step's and reports its result.
     */
    inputFrame: (
      session: Pick<StoredSession, "runId" | "stepId" | "modelSelection">,
      row: StoredInput,
    ): SessionInput => ({
      _tag: "sessionInput",
      requestId: row.id,
      sessionId: row.sessionId,
      input: {
        text: row.text,
        modelSelection: session.modelSelection,
        ...(row.stepIteration === null || session.runId === null || session.stepId === null
          ? {}
          : {
              step: { runId: session.runId, stepId: session.stepId, iteration: row.stepIteration },
            }),
      },
    }),

    /**
     * Builds the frame that stops the turn a session is running. The result
     * arrives in the session's stream as `turn.completed`, so the daemon sends
     * this frame without waiting for a reply.
     */
    interrupting: (sessionId: string): SessionInterrupt => ({
      _tag: "sessionInterrupt",
      sessionId,
    }),

    /**
     * Builds the frame that decides the approval a session's harness is
     * waiting on. The result arrives in the session's stream as
     * `request.resolved`, so the daemon sends this frame without waiting for
     * a reply.
     */
    respondingToApprovalRequest: (
      sessionId: string,
      requestId: string,
      decision: ApprovalDecision,
    ): SessionRespondToApprovalRequest => ({
      _tag: "sessionRespondToApprovalRequest",
      sessionId,
      requestId,
      decision,
    }),

    /**
     * Builds the frame that answers the question a session's harness is
     * waiting on, with the same report as `respondingToApprovalRequest`.
     */
    respondingToQuestion: (
      sessionId: string,
      requestId: string,
      answers: QuestionAnswers,
    ): SessionRespondToQuestion => ({
      _tag: "sessionRespondToQuestion",
      sessionId,
      requestId,
      answers,
    }),

    /**
     * Resolves the approval notification about a session's request as
     * decided, with the answer that sends `decision`, stamped with the
     * current actor. The controller daemon calls it in the transaction that
     * answers the request, so the notification shows the request as answered,
     * wherever the answer came from. Does nothing when no open notification
     * offers that answer, as for a `question` request, which raises none.
     *
     * Fails with `InvalidState` when the notification about the request is
     * already resolved, with a different message for each case:
     *
     * - the request was answered before;
     * - its wait ended without an answer: the user interrupted the turn or
     *   stopped the session, or the harness moved on, and the notification
     *   was withdrawn.
     *
     * The failure rolls back the caller's transaction, so no second answer is
     * recorded or sent.
     */
    resolveApprovalNotification: (
      sessionId: string,
      requestId: string,
      decision: ApprovalDecision,
    ): Effect.Effect<void, InvalidState | SqlError> =>
      Effect.flatMap(
        notifier.answerDecisionsAbout(
          buildRequestSubject(sessionId, requestId),
          APPROVAL_ANSWER_IDS[decision],
        ),
        (outcome) => {
          switch (outcome) {
            case "decided":
            case "none":
              return Effect.void;
            case "already-decided":
            case "already-handled":
              return Effect.fail(createInvalidStateError(ALREADY_ANSWERED));
            case "already-withdrawn":
              return Effect.fail(createInvalidStateError(WAIT_ENDED));
          }
        },
      ),

    /**
     * Withdraws the approval notification about the request a session waits
     * on, because the user ended the wait without answering: by interrupting
     * the turn or by stopping the session. The withdraw reason stored on the
     * notification names which of the two. Reads the session in the caller's
     * transaction, so it sees the request that is open when the transaction
     * runs. Does nothing when no request is open or its notification is
     * already resolved.
     */
    withdrawApprovalNotification: (
      sessionId: string,
      endedBy: WaitEndedBy,
    ): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.flatMap(sessions.one(sessionId), (found) =>
          Option.isNone(found)
            ? Effect.void
            : withdrawOpenRequestNotification(found.value, buildWaitEndedWithdrawReason(endedBy)),
        ),
      ),

    /**
     * Puts a session back on the queue when no runner accepted its start frame.
     * Runs in its own transaction, because the one that claimed the row
     * committed before the frame was sent.
     */
    requeue: (sessionId: string): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          // The update also clears the token hash. The token was sent on a
          // frame nobody accepted, so nothing holds it, and no one may call the
          // API as a queued session. The cache is cleared after the commit,
          // like any other invalidation, so a call in flight cannot cache the
          // old row again before the write is visible.
          yield* sessions.moved(sessionId, "queued", yield* nowIso);
          yield* afterCommit(() => {
            tokens.forgetSessions([sessionId]);
          });
          yield* announce({ _tag: "record", topic: "session", id: sessionId, kind: "updated" });
        }),
      ),

    /**
     * Stops a session that was never sent to a runner, so no runner needs to
     * be told, and returns whether it did. Returns `false`, changing nothing,
     * when the session is no longer `queued`: dispatch may have sent it to its
     * runner since the caller read it, and then only the runner can end it.
     * Joins the caller's transaction, which also writes the audit entry.
     */
    endQueued: (sessionId: string, at: string): Effect.Effect<boolean, SqlError> =>
      Effect.gen(function* () {
        const ended = yield* sessions.endQueued(sessionId, at);
        if (Option.isNone(ended)) return false;
        yield* endSessions([ended.value], "stopped");
        return true;
      }),

    /**
     * Ends every session still open on a runner, with the same cleanup as any
     * other move to `exited` (`endSessions`), and each session is announced
     * once. Joins the caller's transaction as a savepoint.
     * Returns the ended sessions as they were before. A caller retiring the
     * runner tells it to stop each one that was `starting`, `idle` or `busy`
     * before closing the connection.
     */
    endOnRunner: (runnerId: string): Effect.Effect<ReadonlyArray<StoredSession>, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const at = yield* nowIso;
          const ended = yield* sessions.endOnRunner(runnerId, at);
          yield* endSessions(ended, "runner_retired");
          yield* Effect.forEach(
            ended,
            ({ id }) =>
              audit.append({
                kind: "session.stopped",
                actor: SYSTEM_ACTOR,
                payload: { sessionId: id, runnerId, reason: "runner_retired" },
                at,
              }),
            { discard: true },
          );
          return ended;
        }),
      ),

    endForWorkspace,

    /**
     * Cancels the step prompts still waiting on the sessions of a run that
     * has ended, exited sessions included. A session that kept its prompt
     * through an exit (`keepsStepPromptOnExit`) would otherwise be resumed
     * for a turn that the run no longer wants. Joins the caller's
     * transaction, which ends the run.
     */
    cancelStepPromptsOfEndedRun: (runId: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const touched = yield* inputs.cancelStepPromptsOfRun(runId, STEP_RUN_ENDED);
        for (const id of touched) {
          yield* announce({ _tag: "record", topic: "session", id, kind: "updated" });
        }
      }),

    /**
     * Ends every running session on a lost runner: the runner is not in
     * `connected`, and nothing was heard about the session for longer than the
     * session's absolute timeout (the repository method explains that limit).
     * Without this, a session on a runner that never comes back would keep a
     * valid token forever. Joins the caller's transaction, which is where
     * `connected` was read. Nothing is sent to a runner, because none of these
     * runners is connected. Returns the ended sessions as they were before.
     */
    endOnLostRunners: (
      connected: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<StoredSession>, SqlError> =>
      Effect.gen(function* () {
        const at = yield* nowIso;
        const ended = yield* sessions.endOnLostRunners(connected, at);
        yield* endSessions(ended, "runner_lost", RUNNER_LOST);
        yield* Effect.forEach(
          ended,
          ({ id, runnerId }) =>
            audit.append({
              kind: "session.reconciled",
              actor: SYSTEM_ACTOR,
              record: { topic: "session" as const, id },
              payload: { sessionId: id, runnerId, reason: "runner_lost" },
              at,
            }),
          { discard: true },
        );
        return ended;
      }),

    /**
     * Sets the model selection the session runs under from now on, joining the
     * caller's transaction. The stored `spec` is not changed: it is the spec
     * the runner was started with, and a resume or a fork reads the session's
     * `modelSelection` instead.
     */
    setSelection: (
      sessionId: string,
      modelSelection: ModelSelection,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* sessions.setModelSelection(sessionId, modelSelection);
        yield* announce({ _tag: "record", topic: "session", id: sessionId, kind: "updated" });
      }),

    /**
     * Sets the access mode and permission profile an exited session resumes
     * under, joining the caller's transaction. The caller also puts the same
     * access mode in the resume spec, so the row shows what the resumed
     * harness runs under. It is kept on the service, not read straight from
     * the repository, because it is a write, and every write to a session
     * goes through this service.
     *
     * It checks no grant. The caller is the controller daemon, resuming an
     * assistant's session under the assistant's current settings.
     */
    setAccess: (sessionId: string, access: SessionAccess): Effect.Effect<void, SqlError> =>
      sessions.setAccess(sessionId, access),

    /**
     * Stores one user input and the model selection the session runs under
     * from then on. For an exited session, it also puts the session back on
     * the queue with its resume spec, when `resume` allows it; otherwise the
     * input waits, and a later resume sends it. Joins the caller's
     * transaction, so when the caller fails, for example on an invalid model
     * option, neither the new selection nor the input is stored.
     */
    takeInput: <E = never>(taking: TakeInputRequest<E>): Effect.Effect<StoredInput, E | SqlError> =>
      Effect.gen(function* () {
        yield* sessions.setModelSelection(taking.sessionId, taking.modelSelection);
        const created = yield* inputs.insert({
          sessionId: taking.sessionId,
          source: "user",
          actor: yield* currentStamp,
          text: taking.text,
          at: taking.at,
          ...(taking.claimed ? { sentAt: taking.at } : {}),
          ...(taking.stepIteration === undefined ? {} : { stepIteration: taking.stepIteration }),
        });
        // Someone is asking again, so the session may be resumed for every
        // input that waits.
        yield* sessions.setCrashGuardArmed(taking.sessionId, false);
        // After the insert: a session is resumed only while it has input
        // waiting, and this input is what it resumes for.
        if (taking.buildResumeSpec !== undefined) {
          yield* resume(taking.sessionId, taking.buildResumeSpec, taking.at, false);
        }
        yield* announce({
          _tag: "record",
          topic: "session",
          id: taking.sessionId,
          kind: "updated",
        });
        return created;
      }),

    resume,

    /**
     * Stores the input created by one subscription match, joining the caller's
     * transaction. Returns `none` when that subscription and event already
     * have an input, so an event that reaches the event router twice wakes the
     * session only once.
     *
     * The input is stored as waiting, never claimed. How it reaches the
     * session is decided after the write is committed: it is sent now, held
     * until the running turn ends, or the session is started again.
     */
    storeMatchedInput: (
      matched: NewMatchedInput,
    ): Effect.Effect<Option.Option<StoredInput>, SqlError> =>
      Effect.gen(function* () {
        const created = yield* inputs.insertMatched(matched);
        if (Option.isNone(created)) return created;
        yield* sessions.setCrashGuardArmed(matched.sessionId, false);
        yield* announce({
          _tag: "record",
          topic: "session",
          id: matched.sessionId,
          kind: "updated",
        });
        return created;
      }),

    /**
     * Cancels every input still waiting from one subscription, and stores the
     * reason the subscription ended, so a reader of the input sees why it was
     * never delivered.
     */
    cancelMatchedInputs: (subscriptionId: string, reason: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        for (const sessionId of yield* inputs.cancelQueuedForSubscription(subscriptionId, reason)) {
          yield* announce({ _tag: "record", topic: "session", id: sessionId, kind: "updated" });
        }
      }),

    /**
     * Gives up on the input waiting for an exited session that cannot be
     * resumed. `refusal` is the reason the resume was refused.
     *
     * - A session that answers no conversation, such as a Thread, keeps its
     *   input queued, where its reader can see it was not delivered and
     *   cancel it.
     * - A session that answers a conversation has its waiting input
     *   cancelled, and `SessionObserver` is told. Nobody reads that session's
     *   inputs: the owner reads the conversation, so input left queued there
     *   would never be answered and never be explained.
     * - A session started by an agent step is treated the same way. Its run
     *   waits for the step's prompt to be answered, and is told through
     *   `SessionObserver` so the step fails instead of waiting forever.
     *
     * Runs in its own transaction, and reads the session again inside it, so
     * input that a resume by another caller has just made deliverable is
     * never cancelled. An input still on the wire is left to the send that
     * claimed it.
     */
    dropUnresumableInputs: (sessionId: string, refusal: string): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const found = yield* sessions.one(sessionId);
          if (Option.isNone(found)) return;
          const session = found.value;
          if (session.status !== "exited") return;
          if (session.conversationId === null && session.runId === null) return;
          const cancelled = yield* inputs.cancelQueued(
            sessionId,
            `the session could not be resumed: ${refusal}`,
          );
          if (cancelled === 0) return;
          yield* announce({ _tag: "record", topic: "session", id: sessionId, kind: "updated" });
          yield* observer.inputsDropped({ session, refusal });
        }),
      ),

    /**
     * Prepares the sessions of a conversation that is about to be deleted.
     * Joins the caller's transaction. It:
     *
     * - cancels every queued input of every session that answers the
     *   conversation, sent or not, with `reason`, so none of those sessions
     *   is resumed to run it;
     * - releases the workspace lease of every exited session in it again, as
     *   `orphan`. Such a session released its lease as `idle` when it could
     *   still be resumed, but once its conversation is gone nothing can
     *   resume it, so its workspace is kept only for the short window.
     *
     * A session that has not exited yet is left to its own exit, which
     * releases its lease as `orphan` because its conversation is gone by then.
     */
    abandonConversation: (conversationId: string, reason: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        for (const sessionId of yield* inputs.cancelForConversation(conversationId, reason)) {
          yield* announce({ _tag: "record", topic: "session", id: sessionId, kind: "updated" });
        }
        const at = yield* nowIso;
        for (const sessionId of yield* sessions.listExitedWithWorkspaceInConversation(
          conversationId,
        )) {
          yield* workspaces.release({ kind: "session", id: sessionId }, "orphan", at);
        }
      }),

    queuedInput,

    /**
     * Marks an input as sent and returns the row as the update found it.
     * Returns `none` when another caller, such as a second steer or a flush,
     * claimed it first.
     */
    claimInput: (inputId: string): Effect.Effect<Option.Option<StoredInput>, SqlError> =>
      Effect.flatMap(nowIso, (at) => inputs.claim(inputId, at)),

    /**
     * Claims the oldest input still waiting on a session that just changed to
     * idle. Returns `none` when no input is waiting. The caller runs this in
     * the transaction that moves the session to idle.
     *
     * An input sent and still unanswered does not block this claim. It was
     * sent before the turn that just ended, so that turn already took it,
     * and the runner can take one new input now.
     *
     * Running in the same transaction matters: no other caller can read the
     * session as idle before this row is claimed. Otherwise a delivery pass
     * could claim the oldest row first, and this claim would take the next
     * one, which puts two inputs on the wire at once.
     */
    claimOldest: (sessionId: string): Effect.Effect<Option.Option<StoredInput>, SqlError> =>
      Effect.gen(function* () {
        const next = yield* inputs.oldestWaiting(sessionId);
        if (Option.isNone(next)) return Option.none();
        return yield* inputs.claim(next.value.id, yield* nowIso);
      }),

    /**
     * Claims the oldest input still waiting on an idle session, for a
     * delivery pass that finds the session idle. Returns `none` when no input
     * is waiting, when the session is not `idle`, or when another input of
     * the session is sent and not yet answered: that input's turn may not
     * have started yet, and the runner takes one input per turn.
     */
    claimOldestUnlessOneIsOnTheWire: (
      sessionId: string,
    ): Effect.Effect<Option.Option<StoredInput>, SqlError> =>
      Effect.flatMap(nowIso, (at) => inputs.claimOldestUnlessOneIsOnTheWire(sessionId, at)),

    /**
     * Records the delivery the runner reported for an input it received, as
     * the send that waited for the answer. The row changes only while it
     * still holds this send's claim (`row.sentAt`).
     *
     * An input that opened a turn also moves the `idle` session held by
     * `runnerId` to `busy`, in the same transaction. The same answer reaches
     * `applyInputResult` on another fiber, and it can get there later. If
     * only that method moved the session, the session would for a moment
     * read `idle` with no input sent and unanswered, and the next delivery
     * pass would send a second input into the turn that just opened.
     */
    delivered: (
      row: StoredInput,
      delivery: Delivery,
      runnerId: string,
    ): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const recorded = yield* inputs.delivered(row.id, row.sentAt, delivery, yield* nowIso);
          // Only the first to record the answer moves the session. When
          // `applyInputResult` recorded it already, the turn may have ended
          // since, and moving the session now would leave it `busy` for good.
          if (recorded && delivery === "opened") yield* openTurn(runnerId, row.sessionId);
          yield* announce({ _tag: "record", topic: "session", id: row.sessionId, kind: "updated" });
        }),
      ),

    /**
     * Applies a runner's result for one input, in order with the session's
     * events. A rejected input changes nothing here: the send that waits for
     * the result puts it back to waiting.
     *
     * A delivered input is recorded on the row while a send still holds it.
     * The waiting send (`delivered`) and this method both get the answer, and
     * whichever runs first records it. Once it is recorded here, a waiting
     * send that runs after the turn ended cannot move the session back to
     * `busy`.
     *
     * An input that opened a turn moves an `idle` session to `busy`, even
     * when the send gave up waiting before the answer came, because the
     * runner did open a turn. The session is left alone when:
     *
     * - it is already `busy`: the runner reported `turn.started` before this
     *   result, or the waiting send recorded the answer first;
     * - it is in any other status but `idle`, such as `exited`;
     * - another runner holds it now, so the result is stale.
     */
    applyInputResult: (
      runnerId: string,
      result: SessionInputResult,
    ): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          if (!result.ok || result.delivery === undefined) return;
          const found = yield* inputs.read(result.requestId);
          if (Option.isNone(found)) return;
          const row = found.value;
          const recorded =
            row.sentAt !== null &&
            (yield* inputs.delivered(row.id, row.sentAt, result.delivery, yield* nowIso));
          const moved = result.delivery === "opened" && (yield* openTurn(runnerId, row.sessionId));
          if (recorded || moved) {
            yield* announce({
              _tag: "record",
              topic: "session",
              id: row.sessionId,
              kind: "updated",
            });
          }
        }),
      ),

    /**
     * Handles an input whose delivery failed. It goes back to waiting with the
     * reason, except when the session exited in the meantime and does not
     * keep its input through that exit: then it is cancelled. The rule is the
     * same as for the inputs not yet sent when the session exited
     * (`keepsInputsOnExit`, `keepsStepPromptOnExit`). The session is read
     * inside this transaction, so the check cannot race the write that exits
     * the session.
     *
     * When an agent step's prompt is cancelled, `SessionObserver` is told, so
     * the step's run does not wait for a turn that never comes. A step prompt
     * that goes back to waiting on an exited session resumes it, like any
     * kept input: the next delivery pass does that.
     */
    undelivered: (row: StoredInput, reason: string): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const now = yield* sessions.one(row.sessionId);
          const dropped =
            Option.isSome(now) &&
            now.value.status === "exited" &&
            !keepsInputsOnExit(now.value) &&
            !keepsStepPromptOnExit(now.value);
          if (dropped) {
            yield* inputs.cancelWithReason(row.id, row.sentAt, reason);
            if (row.stepIteration !== null) {
              yield* observer.inputsDropped({ session: now.value, refusal: reason });
            }
          } else {
            yield* inputs.requeue(row.id, row.sentAt, reason);
          }
          yield* announce({ _tag: "record", topic: "session", id: row.sessionId, kind: "updated" });
        }),
      ),

    /**
     * Applies a runner's report of the sessions it holds. Stores the native id
     * from each binding, then ends every session the controller thinks runs on
     * this runner but the report leaves out. A runner restart shows up only in
     * this report, because a disconnect without notice tells the controller
     * nothing. Runs in one transaction, so a dispatch by the caller afterwards
     * always sees the final result.
     *
     * The mismatch can also go the other way: the report lists a session the
     * controller already ended while the runner was unreachable. Returns the
     * ids of those sessions, so the caller can tell the runner to stop each.
     */
    bound: (
      runnerId: string,
      bindings: ReadonlyArray<SessionBinding>,
    ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          yield* Effect.forEach(
            bindings,
            (binding) =>
              sessions.bind(
                binding.sessionId,
                runnerId,
                binding.instanceId,
                binding.nativeSessionId,
              ),
            { discard: true },
          );
          const at = yield* nowIso;
          const gone = yield* sessions.reportedGone(
            runnerId,
            bindings.map((binding) => binding.sessionId),
            at,
          );
          // `endSessions` completes the token revocation. The rows are now
          // `exited`, which makes their tokens invalid, and anything cached
          // from those tokens while the sessions ran is dropped after the
          // commit.
          yield* endSessions(gone, "runner_restart");
          yield* Effect.forEach(
            gone,
            ({ id }) =>
              audit.append({
                kind: "session.reconciled",
                actor: SYSTEM_ACTOR,
                record: { topic: "session" as const, id },
                payload: { sessionId: id, runnerId, reason: "runner_restart" },
                at,
              }),
            { discard: true },
          );
          return yield* sessions.listExitedAmong(
            runnerId,
            bindings.map((binding) => binding.sessionId),
          );
        }),
      ),

    /**
     * Checks one event a runner reported against the session it names, and
     * folds it into the stored stream. Writes nothing: it works out the
     * stream rows before any transaction opens. Returns `undefined` when there
     * is nothing to write: the session does not exist, is not on this runner,
     * or has already seen the event.
     *
     * A delta's tap is announced here, before the transaction and never inside
     * it. A delta is not stored until it is flushed, but a client watching the
     * session must see it as soon as it is reported. So the tap is sent
     * whether or not the write that follows succeeds.
     */
    foldReport: (
      runnerId: string,
      seq: number,
      event: ProviderEvent,
    ): Effect.Effect<Folded | undefined, SqlError> =>
      Effect.gen(function* () {
        const id = event.sessionId;
        const found = yield* sessions.one(id);
        // A runner may report only on sessions placed on it. An event for any
        // other session is ignored.
        if (Option.isNone(found) || found.value.runnerId !== runnerId) return undefined;
        const held = tracking.get(id) ?? startTracking(yield* sessions.ingestState(id));
        const folded = fold(held, seq, event);
        if (folded === undefined) return undefined;
        if (event._tag === "content.delta") {
          yield* announce({
            _tag: "tap",
            sessionId: id,
            item: {
              turnId: event.turnId,
              itemId: event.itemId,
              streamKind: event.streamKind,
              delta: event.delta,
            },
          });
        }
        return folded;
      }),

    /**
     * Writes one folded report: its stream rows and the status change they
     * cause commit together (spec 04, Truth model). Joins the caller's
     * transaction, so the caller's other writes for the report commit with it.
     * Returns what is left to do after the commit, because that affects more
     * than this session's rows.
     *
     * The session is read again here, inside the transaction, and every
     * decision about its status and its open request is made from that read.
     * Something else, such as a retired runner, can end the session between
     * `foldReport` and this write. A report that arrives that late is still
     * recorded, but it never moves the session or opens a request on it, so
     * it cannot raise an approval notification that nothing would withdraw.
     */
    applyReport: (
      runnerId: string,
      event: ProviderEvent,
      folded: Folded,
    ): Effect.Effect<AppliedReport, SqlError> =>
      Effect.gen(function* () {
        const id = event.sessionId;
        // `foldReport` found the row, and sessions are never deleted.
        const session = Option.getOrThrow(yield* sessions.one(id));
        const before = session.status;
        // Only these events can open or close a request. An event for a
        // session that has already exited never opens a request again.
        const requestEvent = before !== "exited" && isRequestEvent(event) ? event : undefined;
        // The open request after this event, or `undefined` for no change.
        const park =
          requestEvent === undefined
            ? undefined
            : computeOpenRequestAfter(requestEvent, session.openRequest);
        const at = yield* nowIso;
        for (const row of folded.rows) yield* sessions.append(id, row);
        if (folded.rows.length > 0) {
          yield* announce({ _tag: "transcript", sessionId: id });
        }
        // After the rows, so the observer can read what this report wrote.
        yield* observer.sessionReported(session, event);
        // Written together with the status change from the same event, so a
        // session that reads `idle` already has its provider-native id.
        const native = findNativeId(event);
        if (native !== undefined) {
          yield* sessions.bind(id, runnerId, session.instanceId, native);
        }
        if (requestEvent !== undefined && park !== undefined) {
          yield* replaceOpenRequest(session, park, buildWithdrawReason(requestEvent));
        }
        // A session starting or exiting is what counts as use of its
        // workspace. The time is shown to the user; how long the workspace is
        // kept is decided by its leases, not by this time.
        if (
          session.workspaceId !== null &&
          (event._tag === "session.started" || event._tag === "session.exited")
        ) {
          yield* workspaces.touched(session.workspaceId, at);
        }
        // `exited` is final, so a stray event after it is still recorded but
        // never brings the session back to life. Spec 06 §4.1 owns the rule.
        const moved =
          folded.status === undefined || folded.status === before || before === "exited"
            ? undefined
            : folded.status;
        let exitedHoldingInput = false;
        if (moved !== undefined) {
          yield* sessions.moved(id, moved, at);
          // A turn started, so the resumed process did work: the crash-loop
          // guard no longer applies to it.
          if (moved === "busy") yield* sessions.setCrashGuardArmed(id, false);
          if (event._tag === "session.exited") {
            yield* endSessions([session], event.reason, describeExited(event.reason));
            // A session that keeps its input through an exit is resumed for
            // it once this is committed. The caller does that, because it
            // sends frames.
            exitedHoldingInput = Option.isSome(yield* inputs.oldestWaiting(id));
          } else {
            yield* announce({ _tag: "record", topic: "session", id, kind: "updated" });
          }
        } else {
          // No announce: most events do not change the status, and a refetch
          // for each of them would flood clients. A request opening or closing
          // is the exception: it changes no status, but the user has to see
          // the request card.
          yield* sessions.touched(id, at);
          if (park !== undefined) {
            yield* announce({ _tag: "record", topic: "session", id, kind: "updated" });
          }
        }
        // Updated only after the commit: a failed transaction leaves the held
        // text and the sequence as they were. Nothing resends the frame,
        // because there is no outbox yet (spec 03 section 2.3).
        //
        // The entry is removed when the session exits and on any event after
        // that. Otherwise an event for an exited session would put the entry
        // back, and nothing would ever remove it.
        yield* afterCommit(() => {
          if (folded.status === "exited" || before === "exited") {
            tracking.delete(id);
          } else {
            tracking.set(id, folded.next);
          }
        });
        return {
          moved,
          ...(exitedHoldingInput ? { exitedHoldingInput: true as const } : {}),
        };
      }),

    /** Returns a page of every input this session was given, oldest first, whatever their status. */
    queryInputs: (input: InputQueryInput): Effect.Effect<InputPage, ReadError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("input.query");
        const { id, limit, cursor, sort } = yield* Effect.mapError(
          decodeInputQuery(input),
          createDecodeValidationError,
        );
        yield* readSession(id);
        const listing = yield* refuseCursor(
          inputs.list({
            sessionId: id,
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: resolveSortDirection(sort, INPUT_DIRECTION),
          }),
        );
        return toPageOutput(listing);
      }),

    /**
     * Replaces the text of an input still waiting on its session, and returns
     * the changed input. Fails with `InvalidState` when the input was already
     * sent, delivered or cancelled, or when the session answers an
     * assistant's conversation.
     */
    updateInput: (input: InputUpdate): Effect.Effect<Input, InputError> =>
      Effect.gen(function* () {
        yield* requireGrant("input.update");
        const { id, inputId, text } = yield* Effect.mapError(
          decodeInputUpdate(input),
          createDecodeValidationError,
        );
        yield* requireChangeableInputs(id);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const row = yield* queuedInput(id, inputId);
            yield* inputs.rewrite(inputId, text);
            yield* announce({ _tag: "record", topic: "session", id, kind: "updated" });
            return { ...row, text };
          }),
        );
      }),

    /**
     * Cancels an input still waiting on its session, and returns the
     * cancelled input. Fails with `InvalidState` when the input was already
     * sent, delivered or cancelled, or when the session answers an
     * assistant's conversation.
     */
    cancelInput: (
      sessionId: Id,
      inputId: Id,
    ): Effect.Effect<Input, Exclude<InputError, Validation>> =>
      Effect.gen(function* () {
        yield* requireGrant("input.cancel");
        yield* requireChangeableInputs(sessionId);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const row = yield* queuedInput(sessionId, inputId);
            yield* inputs.cancel(inputId);
            yield* announce({ _tag: "record", topic: "session", id: sessionId, kind: "updated" });
            return { ...row, status: "cancelled" as const };
          }),
        );
      }),
  };
});

/**
 * The session service. It has two kinds of method, and nothing else catches a
 * method wired where the other kind belongs:
 *
 * - `query`, `read`, `transcript`, `queryInputs`, `updateInput` and
 *   `cancelInput` are operations. Each checks its own grant and decodes any
 *   input object it takes, and a route handler calls it directly.
 * - Every other method changes rows or builds a frame, and checks no grant.
 *   Only the controller daemon calls them, after checking the grant for the
 *   operation it is running. Putting one of them on a route would expose it
 *   to anyone who can reach the API.
 */
export class SessionService extends Context.Service<SessionService, Effect.Success<typeof make>>()(
  "hercule/controller/sessions/SessionService",
) {}

export const SessionServiceLayer: Layer.Layer<
  SessionService,
  never,
  | SqlClient.SqlClient
  | AuditLog
  | SessionTokens
  | PluginHost
  | SessionObserver
  | WorkspaceService
  | Notifier
> = Layer.effect(SessionService)(make);

/**
 * Cancels every input that was sent but unanswered when the controller
 * stopped (`inputRepository.cancelStranded`). It runs once at boot, after
 * migrations and before anything is placed on a runner. It is not part of
 * building `SessionServiceLayer`, because the boot builds every layer before
 * it runs migrations, and a query against a column a fresh database does not
 * have yet would fail there.
 *
 * Returns the wake-ups lost with the cancelled inputs. Handling a lost
 * wake-up is not this domain's job: the sessions domain knows nothing about
 * subscriptions.
 */
export const cancelStrandedInputs: Effect.Effect<
  ReadonlyArray<LostWakeUp>,
  SqlError,
  SqlClient.SqlClient
> = Effect.flatMap(inputRepository, (inputs) =>
  inputs.cancelStranded(
    "the controller restarted while this input was being sent to the runner; " +
      "it is unknown whether the harness received it, so it was not sent again",
  ),
);
