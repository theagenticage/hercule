/**
 * The session operations that reach the harness running a session on its
 * runner, and the delivery they all send through. `session.update` is here
 * too: it sends nothing itself, but the model selection it sets goes out with
 * the next frame, and the allowed values come from the runner's model catalog.
 *
 * A row is always stored or claimed first and sent afterwards, never the other
 * way round. Anything the runner is told about must be something a caller can
 * read back, edit or cancel, and the runner's reply is written where the
 * caller reads it. No transaction stays open while waiting for that reply.
 *
 * A method that takes only ids does not decode them again: the transport has
 * already decoded a request's ids against the contract, and a caller inside
 * the controller passes ids it read from stored rows.
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
  SessionSpec,
  type ControllerToRunner,
  type ModelSelection,
  type SessionInputResult,
} from "@hercule/protocol";
import {
  createDecodeValidationError,
  createInvalidStateError,
  findNearestSupportedAccessMode,
  Id,
  InvalidState,
  NotFound,
  SESSION_INPUT_FIELDS,
  SESSION_RESPOND_TO_APPROVAL_REQUEST_FIELDS,
  SESSION_RESPOND_TO_QUESTION_FIELDS,
  SESSION_UPDATE_FIELDS,
  type Forbidden,
  type Session,
  type SessionInputOutcome,
  type SessionSelection,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { currentStamp, requireGrant } from "../../actor";
import { agentRepository } from "../../agents";
import { nowIso, withTransaction } from "../../db";
import { AuditLog } from "../../events";
import type { PluginHost } from "../../plugins";
import { providerRepository, resolvedInstance } from "../../providers";
import { RunnerConnections } from "../../runners";
import {
  buildContinuingSpec,
  isResumeHeld,
  readSessionOrFail,
  sessionRecordComposer,
  SessionService,
  sessionRepository,
  validateOptions,
  validateAnswers,
  validateDecision,
  type StoredInput,
  type StoredSession,
} from "../../sessions";
import { Settings, type SettingError } from "../../settings";
import type { WorkspaceService } from "../../workspaces";
import { makeForkAfterCommit } from "./after-commit";
import { Dispatch } from "./dispatch";
import { resumable } from "./resuming";

const InputInput = Schema.Struct({ id: Id, ...SESSION_INPUT_FIELDS });

type InputInput = Schema.Schema.Type<typeof InputInput>;

const UpdateInput = Schema.Struct({ id: Id, ...SESSION_UPDATE_FIELDS });

type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const RespondToApprovalRequestInput = Schema.Struct({
  id: Id,
  ...SESSION_RESPOND_TO_APPROVAL_REQUEST_FIELDS,
});

type RespondToApprovalRequestInput = Schema.Schema.Type<typeof RespondToApprovalRequestInput>;

const RespondToQuestionInput = Schema.Struct({ id: Id, ...SESSION_RESPOND_TO_QUESTION_FIELDS });

type RespondToQuestionInput = Schema.Schema.Type<typeof RespondToQuestionInput>;

const decodeInput = Schema.decodeUnknownEffect(InputInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);
const decodeRespondToApprovalRequest = Schema.decodeUnknownEffect(RespondToApprovalRequestInput);
const decodeRespondToQuestion = Schema.decodeUnknownEffect(RespondToQuestionInput);
const encodeSpec = Schema.encodeUnknownSync(SessionSpec);

/**
 * How long the controller waits for a runner to report what it did with an
 * input. Long enough for a harness to accept a message, short enough that a
 * caller waiting on the reply is not left hanging.
 */
const SESSION_INPUT_DEADLINE: Duration.Duration = Duration.seconds(10);

/** The input deadline. Tests override it with a shorter one. */
export const SessionInputDeadline = Context.Reference<Duration.Duration>(
  "hercule/controller/daemon/SessionInputDeadline",
  { defaultValue: (): Duration.Duration => SESSION_INPUT_DEADLINE },
);

const HAS_EXITED = "that session has exited";

const GONE = "that session's runner is no longer connected";

const NOT_WAITING =
  "that input is no longer waiting: it was sent, delivered or cancelled in the meantime";

const REFUSED = "that session's runner rejected the input";

const NOT_BUSY = "only a busy session can be steered";

/**
 * The refusal of `session.input` on a session that answers an assistant's
 * conversation. Every message the owner gives such a session must be stored
 * in the conversation, and only `conversation.send` stores it there.
 */
const USE_CONVERSATION_SEND =
  "this session belongs to an assistant's conversation; send the message with conversation.send";

/**
 * The refusal of `session.input` on a session whose assistant, and with it
 * the conversation the session answered, was deleted.
 */
const CONVERSATION_DELETED =
  "this session answered an assistant's conversation that was deleted; " +
  "it is kept as history and takes no input";

const NO_OPEN_REQUEST = "that session is not waiting on a request";

/**
 * The harness has moved on: the answer is for a request other than the one it
 * is waiting on now, so applying it would answer the wrong question.
 */
const STALE_REQUEST = "that request is not the one this session is waiting on";

/**
 * The message for an input that did not reach the harness, either because the
 * runner is not connected or because no reply came in time. Both cases look
 * the same to the caller. The row goes back to waiting, and the next change to
 * idle, or a manual steer, tries again.
 */
const NOT_DELIVERED =
  "that session's runner did not take the input; it stays queued for the next turn";

type ReadError = Unauthenticated | Forbidden | Validation | SqlError;

type InputError = ReadError | NotFound | InvalidState | SettingError | Schema.SchemaError;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* SessionService;
  const readSession = readSessionOrFail(yield* sessionRepository);
  const recordComposer = yield* sessionRecordComposer;
  const instances = yield* providerRepository;
  const resolved = yield* resolvedInstance;
  const resumableNativeSession = yield* resumable;
  const connections = yield* RunnerConnections;
  const settings = yield* Settings;
  const audit = yield* AuditLog;
  const { dispatch } = yield* Dispatch;
  const agents = yield* agentRepository;
  const forkAfterCommit = yield* makeForkAfterCommit;

  /**
   * Returns the model selection to use: the given model, or the session's
   * current one, with the given options merged over the current options.
   * Current options are kept only when the model does not change. Fails with
   * a validation error if the runner's catalog does not offer an option.
   *
   * The catalog is read only when options are given. Without options there is
   * nothing to validate, and a plain turn should not wait on a lookup. The
   * read is one snapshot row, so it can stay inside the caller's transaction.
   */
  const resolveModelSelection = (
    session: StoredSession,
    given: SessionSelection,
  ): Effect.Effect<ModelSelection, Validation | SqlError | Schema.SchemaError> =>
    Effect.gen(function* () {
      const model = given.model ?? session.modelSelection.model;
      const picks = given.options ?? {};
      if (Object.keys(picks).length > 0) {
        const snapshots = yield* instances.snapshotsOf(session.instanceId);
        const snapshot = snapshots.find((one) => one.runnerId === session.runnerId);
        yield* validateOptions(snapshot?.models ?? [], model, picks);
      }
      const carried = model === session.modelSelection.model ? session.modelSelection.options : {};
      return { model, options: { ...carried, ...picks } };
    });

  /**
   * Sends one stored input to the session's runner and waits for the runner's
   * result. Returns `none` when the runner is not connected or does not reply
   * in time. The caller has already claimed the row, and the wait happens
   * outside any transaction.
   */
  const deliverTo = (
    session: StoredSession,
    row: StoredInput,
  ): Effect.Effect<Option.Option<SessionInputResult>> =>
    Effect.gen(function* () {
      const deadline = yield* SessionInputDeadline;
      const answer = yield* connections.asked(
        session.runnerId,
        sessions.inputFrame(session, row),
        deadline,
      );
      return Option.filter(
        answer,
        (one): one is SessionInputResult => one._tag === "sessionInputResult",
      );
    });

  /**
   * Sends a row that is already claimed (its `sent_at` is set) and records the
   * result.
   *
   * - If the runner reports a delivery, it is recorded and returned.
   * - If the runner rejects the input or does not reply, the session service
   *   records that, and this fails with an invalid state error with the same
   *   reason.
   *
   * The idle path, a steer and the flush all send inputs through this
   * function, and nothing else does.
   *
   * The session, and so its model selection, is read here after the claim,
   * not earlier by the caller. Otherwise a `session.update` that lands
   * between the caller's read and the claim would be missing from the frame.
   */
  const deliverClaimed = (
    row: StoredInput,
  ): Effect.Effect<SessionInputOutcome, InvalidState | NotFound | SqlError> =>
    Effect.gen(function* () {
      const session = yield* readSession(row.sessionId);
      const answer = yield* deliverTo(session, row);
      const delivery = Option.isSome(answer) && answer.value.ok ? answer.value.delivery : undefined;
      if (delivery !== undefined) {
        yield* sessions.delivered(row, delivery, session.runnerId);
        return { inputId: row.id, result: delivery };
      }
      const reason = Option.isSome(answer) ? (answer.value.message ?? REFUSED) : NOT_DELIVERED;
      yield* sessions.undelivered(row, reason);
      return yield* Effect.fail(createInvalidStateError(reason));
    });

  /**
   * Builds the spec a session is queued with when it resumes its own
   * transcript, and returns it as JSON. The spec is built from the stored spec
   * rather than from scratch, so the resumed session runs under exactly what
   * it ran under before its harness exited.
   */
  const buildResumeSpec = (
    session: StoredSession,
    modelSelection: ModelSelection,
    nativeSessionId: string,
  ): Effect.Effect<string, NotFound | SqlError | SettingError | Schema.SchemaError> =>
    Effect.gen(function* () {
      const spec = buildContinuingSpec(
        yield* sessions.readSpec(session.id),
        yield* settings.all(),
        modelSelection,
        nativeSessionId,
        "resume",
        session.conversationId,
      );
      return JSON.stringify(encodeSpec(spec));
    });

  /**
   * Builds the spec an assistant's session resumes with, and returns it as
   * JSON. It is the stored spec, like any resume, except for what the
   * assistant may do: the access mode and the permission profile are read
   * from the assistant as it is now, and written to the session row in the
   * caller's transaction.
   *
   * An assistant keeps one session for a long time, resuming it after every
   * idle unload, so a change to the assistant would otherwise never reach it.
   * A running harness cannot change its access mode, which is why the change
   * waits for the resume.
   *
   * Fails with `InvalidState` when the provider supports no access mode at or
   * below the assistant's, as a new session would.
   */
  const buildConversationResumeSpec = (
    session: StoredSession,
    nativeSessionId: string,
  ): Effect.Effect<
    string,
    InvalidState | Validation | NotFound | SqlError | SettingError | Schema.SchemaError
  > =>
    Effect.gen(function* () {
      const found = session.agentId === null ? Option.none() : yield* agents.read(session.agentId);
      // A conversation's session is spawned from its assistant, and the
      // assistant's conversations go when it is deleted. The resume check
      // (`resumable`) refuses a session whose conversation is gone, so
      // nothing resumes a session whose assistant is gone.
      if (Option.isNone(found))
        return yield* Effect.die("a conversation's session has no assistant");
      const assistant = found.value;
      const { definition } = yield* resolved(session.instanceId);
      const accessMode = findNearestSupportedAccessMode(
        assistant.accessMode,
        definition.declared.accessModes,
      );
      if (accessMode === undefined) {
        return yield* Effect.fail(
          createInvalidStateError(
            `${definition.displayName} supports no access mode at or below ${assistant.accessMode}`,
          ),
        );
      }
      yield* sessions.setAccess(session.id, {
        requestedAccessMode: assistant.accessMode,
        accessMode,
        permissionProfileId: assistant.permissionProfileId,
      });
      const spec = buildContinuingSpec(
        yield* sessions.readSpec(session.id),
        yield* settings.all(),
        session.modelSelection,
        nativeSessionId,
        "resume",
        session.conversationId,
      );
      return JSON.stringify(encodeSpec({ ...spec, accessMode }));
    });

  /**
   * Sends a queued input that the caller already claimed, and records the
   * result, for a caller with nobody to tell about a failure. Fails only
   * with a database error.
   *
   * If the runner rejects the input or does not reply, `deliverClaimed` puts
   * the row back to waiting, and the next change to idle or delivery pass
   * sends it.
   */
  const sendClaimed = (row: StoredInput): Effect.Effect<void, SqlError> =>
    Effect.catchIf(
      deliverClaimed(row),
      (error): error is InvalidState | NotFound =>
        error instanceof InvalidState || error instanceof NotFound,
      () => Effect.void,
    );

  /**
   * Delivers the queued inputs of a session, after some other caller stored
   * them.
   *
   * The rows are already committed when this runs, so nothing is sent for a
   * write that could roll back. What happens depends on the session's
   * status, exactly as for an input a person types:
   *
   * - an idle session is sent its oldest queued input;
   * - an exited session whose transcript can still be resumed goes back on
   *   the queue with a resume spec, and its inputs are sent when it becomes
   *   idle after the restart. The session service decides whether it may be
   *   resumed now; the crash-loop guard can hold it back;
   * - an exited session that cannot be resumed is handed to the session
   *   service's `dropUnresumableInputs`, which decides what happens to its
   *   input;
   * - a session with any other status, such as busy, is left alone, because
   *   its inputs are sent when it next becomes idle.
   *
   * A session whose runner is not connected gets nothing. The row stays
   * queued, where a reader can see it was not delivered, and the next caller
   * tries again. When such a session has ended for good, the session routing
   * table's sweep ends the subscription that wrote the input.
   *
   * Inputs from a subscription match are not the only ones that get here. An
   * input a person typed that the runner rejected, or whose session went
   * idle or exited without the controller seeing it, is retried on every
   * tick for as long as the session can take it. The check for an input
   * already sent and unanswered keeps those retries to one row at a time.
   */
  const deliverQueuedInput = (
    sessionId: string,
  ): Effect.Effect<void, NotFound | Validation | SqlError | SettingError | Schema.SchemaError> =>
    Effect.gen(function* () {
      const session = yield* readSession(sessionId);
      if (session.status === "idle") {
        // A runner that is not connected cannot be sent anything. Claiming a
        // row only to put it straight back would rewrite the row, and notify
        // every client watching the session, on every pass while the runner
        // is away. With a connection, the session's oldest queued row is
        // sent, whoever wrote it. So a typed input whose delivery failed is
        // retried first, and a matched input waits behind it, as in any
        // queue.
        if (!(yield* connections.holdsConnection(session.runnerId))) return;
        const claimed = yield* sessions.claimOldestUnlessOneIsOnTheWire(sessionId);
        if (Option.isSome(claimed)) yield* sendClaimed(claimed.value);
        return;
      }
      if (session.status !== "exited") return;
      const check = yield* resumableNativeSession(session).pipe(
        Effect.map((nativeSessionId) => ({ nativeSessionId })),
        Effect.catchIf(
          (error): error is InvalidState => error instanceof InvalidState,
          (refused) => Effect.succeed({ refusal: refused.error.message }),
        ),
      );
      if ("refusal" in check) {
        return yield* sessions.dropUnresumableInputs(sessionId, check.refusal);
      }
      // Checked again, with the rest of the rule, inside the resume's
      // transaction. Checked here too, so a held session, which every tick
      // reaches, costs no spec build. The owner was told at the exit that
      // put the hold on, with a "can't be reached" notice.
      if (isResumeHeld(session)) return;
      const { nativeSessionId } = check;
      const resumed = yield* withTransaction(
        sql,
        Effect.flatMap(nowIso, (at) =>
          sessions.resume(
            sessionId,
            (now) =>
              now.conversationId === null
                ? buildResumeSpec(now, now.modelSelection, nativeSessionId)
                : buildConversationResumeSpec(now, nativeSessionId),
            at,
            true,
          ),
        ),
      ).pipe(
        Effect.catchIf(
          (error): error is InvalidState => error instanceof InvalidState,
          // The assistant's access mode has no match in the provider any
          // more, so the session cannot be resumed as the assistant now is.
          (refused) =>
            Effect.as(sessions.dropUnresumableInputs(sessionId, refused.error.message), false),
        ),
      );
      if (!resumed) return;
      // After the commit: dispatch sends a frame to the runner, and a
      // transaction never waits on anything outside the database.
      yield* dispatch(session.runnerId);
    });

  /**
   * Checks the `session.input` grant, decodes the input, and stores it as the
   * next input of its session, in the caller's transaction or in one of its
   * own. Returns the session as it was read and the stored row. Sends
   * nothing: the caller delivers the row once the write has committed.
   *
   * - An idle session will not change to idle again, so no flush would send
   *   its input. The row is stored already claimed, so a cancel or a flush
   *   never sees it as waiting, and the caller sends it.
   * - A session with any other status gets the input queued.
   * - An exited session whose transcript can be resumed goes back on the
   *   queue, with a spec that holds its provider-native session id, and the
   *   row is stored as waiting. The caller dispatches the session.
   *
   * Reading the session, validating the options and both writes share one
   * transaction. So two inputs sent at the same time run one after the other
   * instead of merging their options over the same stale row, and an option
   * the model does not offer rolls everything back, leaving neither a changed
   * selection nor an input row.
   */
  const storeInput = (
    input: InputInput,
  ): Effect.Effect<{ readonly session: StoredSession; readonly row: StoredInput }, InputError> =>
    Effect.gen(function* () {
      yield* requireGrant("session.input");
      const { id, text, ...picks } = yield* Effect.mapError(
        decodeInput(input),
        createDecodeValidationError,
      );
      return yield* withTransaction(
        sql,
        Effect.gen(function* () {
          const session = yield* readSession(id);
          if (session.conversationDeleted) {
            return yield* Effect.fail(createInvalidStateError(CONVERSATION_DELETED));
          }
          if (session.conversationId !== null) {
            return yield* Effect.fail(createInvalidStateError(USE_CONVERSATION_SEND));
          }
          const nativeSessionId =
            session.status === "exited" ? yield* resumableNativeSession(session) : undefined;
          const modelSelection = yield* resolveModelSelection(session, picks);
          const at = yield* nowIso;
          const row = yield* sessions.takeInput({
            sessionId: id,
            modelSelection,
            buildResumeSpec:
              nativeSessionId === undefined
                ? undefined
                : (now: StoredSession) => buildResumeSpec(now, modelSelection, nativeSessionId),
            text,
            at,
            claimed: session.status === "idle",
          });
          return { session, row };
        }),
      );
    });

  /**
   * Reads the session `id` and the request it is parked on, and checks that
   * the request is `requestId`. Fails with `InvalidState` when the session
   * has exited, waits on no request, or waits on a different one, and with
   * `NotFound` when there is no such session.
   */
  const readOpenRequest = (id: Id, requestId: string) =>
    Effect.gen(function* () {
      const session = yield* readSession(id);
      if (session.status === "exited")
        return yield* Effect.fail(createInvalidStateError(HAS_EXITED));
      const open = session.openRequest;
      if (open === null) return yield* Effect.fail(createInvalidStateError(NO_OPEN_REQUEST));
      if (open.requestId !== requestId)
        return yield* Effect.fail(createInvalidStateError(STALE_REQUEST));
      return { session, open };
    });

  /**
   * Runs `writes` in a transaction, and sends `frame` to a runner once that
   * transaction commits. Fails with `InvalidState`, and writes nothing, when
   * the runner is not connected.
   *
   * The transaction may be the caller's: `notification.act` runs an answer
   * and resolves its decision in one transaction. The frame then waits for
   * the caller's commit, and is never sent if the caller rolls back. So the
   * runner is never told about a change the database does not hold.
   *
   * The runner can still drop off between the check and the send. The frame
   * is then lost, as it would be if the socket closed just after the send;
   * the failure is logged. Nothing sends the frame again:
   *
   * - a lost interrupt or stop can simply be asked for again;
   * - a lost decision on an approval leaves the harness waiting on its
   *   request, and a second decision is refused because the approval
   *   notification is already decided. The user interrupts or stops the
   *   session to end the wait;
   * - a question raises no notification, so lost answers to a question can
   *   simply be sent again.
   *
   * The runner's report of what the frame did is applied in a later
   * transaction, after this one commits, so that report always finds these
   * writes. For example, the `request.resolved` that follows an answer finds
   * the approval notification already resolved, and does not withdraw it.
   */
  const writeThenTellRunner = <E>(
    runnerId: string,
    frame: ControllerToRunner,
    writes: Effect.Effect<void, E>,
  ): Effect.Effect<void, E | InvalidState | SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        if (!(yield* connections.holdsConnection(runnerId))) {
          return yield* Effect.fail(createInvalidStateError(GONE));
        }
        yield* writes;
        yield* forkAfterCommit(
          "Could not send a frame to a session's runner",
          Effect.flatMap(connections.tell(runnerId, frame), (told) =>
            told ? Effect.void : Effect.logWarning(`${GONE}; the frame was not sent`),
          ),
        );
      }),
    );

  /**
   * Tells the session's runner to end the running turn, as the actor behind
   * the current request. Writes the `session.interrupted` audit entry and
   * withdraws the approval notification about the request the turn waits on,
   * if any, because the interrupt ends that wait. The runner is told once
   * those writes commit.
   * Fails with `InvalidState` when the runner is not connected.
   */
  const interruptTurn = (session: StoredSession): Effect.Effect<void, InvalidState | SqlError> =>
    Effect.gen(function* () {
      const actor = yield* currentStamp;
      yield* writeThenTellRunner(
        session.runnerId,
        sessions.interrupting(session.id),
        Effect.gen(function* () {
          yield* audit.append({
            kind: "session.interrupted",
            actor,
            payload: { sessionId: session.id, runnerId: session.runnerId },
            at: yield* nowIso,
          });
          yield* sessions.withdrawApprovalNotification(session.id, "interrupted");
        }),
      );
    });

  /**
   * Gets a waiting input into the turn a busy session is running. Steering is
   * a guarantee every session gives, whatever its provider:
   *
   * - a provider that steers natively is sent the input now, and the result
   *   comes from the runner;
   * - any other provider has its running turn interrupted, and the input
   *   stays waiting. The flush that follows the turn's end sends it as the
   *   next turn, and the result is `queued`.
   *
   * Fails with `InvalidState` when another caller sent the input first, or
   * the runner refused it or is not connected.
   */
  const steerInto = (
    session: StoredSession,
    row: StoredInput,
  ): Effect.Effect<
    SessionInputOutcome,
    InvalidState | NotFound | Validation | SqlError | Schema.SchemaError
  > =>
    Effect.gen(function* () {
      const { definition } = yield* resolved(session.instanceId);
      if (definition.declared.steering !== "native") {
        yield* interruptTurn(session);
        return { inputId: row.id, result: "queued" as const };
      }
      // The claim stops a second steer, or the flush, from sending the same
      // row: only one caller's conditional update still finds it waiting,
      // whatever the caller read before. The claimed row, not that earlier
      // read, is what gets sent, in case the input was edited in between.
      const claimed = yield* sessions.claimInput(row.id);
      if (Option.isNone(claimed)) return yield* Effect.fail(createInvalidStateError(NOT_WAITING));
      return yield* deliverClaimed(claimed.value);
    });

  /**
   * Delivers the owner's input that `queueConversationInput` stored, once it
   * is committed, by the session's status at that moment:
   *
   * - a busy session has it steered into the running turn;
   * - a session put back on the queue, by this input's resume or earlier, is
   *   dispatched;
   * - an idle or exited session gets `deliverQueuedInput`;
   * - a starting session is left alone: the input is sent when it becomes
   *   idle.
   *
   * A steer that fails leaves the input waiting, for the flush that follows
   * the turn's end, so its failure is logged, not returned. So is an input
   * the flush has already sent by the time the steer looks for it.
   */
  const deliverConversationInput = (
    sessionId: string,
    inputId: string,
  ): Effect.Effect<void, NotFound | Validation | SqlError | SettingError | Schema.SchemaError> =>
    Effect.gen(function* () {
      const session = yield* readSession(sessionId);
      switch (session.status) {
        case "busy":
          return yield* sessions.queuedInput(sessionId, inputId).pipe(
            Effect.flatMap((row) => steerInto(session, row)),
            Effect.asVoid,
            // Not found: the flush at the turn's end already sent the input.
            Effect.catchIf(
              (error): error is InvalidState | NotFound =>
                error instanceof InvalidState || error instanceof NotFound,
              (error) =>
                Effect.logInfo("An owner's message was not steered; it waits for the turn's end", {
                  sessionId,
                  reason: error.error.message,
                }),
            ),
          );
        case "queued":
          return yield* dispatch(session.runnerId);
        case "starting":
          // The runner's `session.started` makes the session idle, and the
          // flush on that change sends the oldest waiting input.
          return;
        case "idle":
        case "exited":
          return yield* deliverQueuedInput(sessionId);
      }
    });

  /**
   * Delivers the prompt of an agent step that `queueStepInput` stored, once
   * it is committed, by the session's status at that moment:
   *
   * - a session put back on the queue, by this prompt's resume or earlier,
   *   is dispatched;
   * - an idle or exited session gets `deliverQueuedInput`;
   * - a starting or busy session is left alone: the prompt is sent when the
   *   session is next idle.
   *
   * A step's prompt is never steered into a running turn. The runner takes
   * the next turn that completes after the prompt as the step's turn, so a
   * prompt folded into someone else's turn would end the step with that
   * turn's answer.
   */
  const deliverStepInput = (
    sessionId: string,
  ): Effect.Effect<void, NotFound | Validation | SqlError | SettingError | Schema.SchemaError> =>
    Effect.gen(function* () {
      const session = yield* readSession(sessionId);
      switch (session.status) {
        case "queued":
          return yield* dispatch(session.runnerId);
        case "starting":
        case "busy":
          return;
        case "idle":
        case "exited":
          return yield* deliverQueuedInput(sessionId);
      }
    });

  /**
   * Stops a session that has not exited, as the actor behind the current
   * request, and writes the `session.stopped` audit entry. Also withdraws the
   * approval notification about the request the session waits on, if any.
   * Returns what happened:
   *
   * - `ended`: the session was queued, so no runner held it, and it has
   *   exited now;
   * - `told`: the stop is written, the runner is told once the transaction
   *   commits, and the session exits when the runner reports the exit;
   * - `exited`: the session was read as queued, but something else ended it
   *   before this stop could, so nothing was sent and nothing was written;
   * - `unreachable`: the runner is not connected, so nothing was sent and
   *   nothing was written.
   *
   * A session read as queued may have been sent to its runner since. Only a
   * session still queued is ended directly; any other is stopped through its
   * runner.
   */
  const stopSession = (
    session: StoredSession,
  ): Effect.Effect<"ended" | "told" | "exited" | "unreachable", NotFound | SqlError> =>
    Effect.gen(function* () {
      const actor = yield* currentStamp;
      const payload = { sessionId: session.id, runnerId: session.runnerId };
      if (session.status === "queued") {
        const ended = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            if (yield* sessions.endQueued(session.id, at)) {
              yield* audit.append({ kind: "session.stopped", actor, payload, at });
              return "ended" as const;
            }
            // The session left `queued` after it was read. If it has exited,
            // this stop changes nothing and records nothing. Otherwise
            // dispatch sent it to its runner, which is told to stop it below.
            return (yield* readSession(session.id)).status === "exited"
              ? ("exited" as const)
              : undefined;
          }),
        );
        if (ended !== undefined) return ended;
      }
      return yield* writeThenTellRunner(
        session.runnerId,
        sessions.stopping(session.id),
        Effect.gen(function* () {
          yield* audit.append({ kind: "session.stopped", actor, payload, at: yield* nowIso });
          yield* sessions.withdrawApprovalNotification(session.id, "stopped");
        }),
      ).pipe(
        Effect.as("told" as const),
        Effect.catchIf(
          (error): error is InvalidState => error instanceof InvalidState,
          () => Effect.succeed("unreachable" as const),
        ),
      );
    });

  return {
    sendClaimed,

    deliverQueuedInput,

    /**
     * Queues `text` as the owner's input to a session that answers an
     * assistant's conversation, inside the caller's transaction. Returns the
     * delivery, which the caller runs after its commit
     * (`deliverConversationInput`):
     *
     * - a session that has exited but can be resumed goes back on the queue
     *   in place, with a resume spec, in the same transaction, whatever made
     *   it exit. It resumes under the assistant's current access mode and
     *   permission profile, and fails with `InvalidState` when the provider
     *   supports no access mode at or below the assistant's;
     * - a busy session has the input steered into its running turn;
     * - any other session gets the input when it is next idle.
     *
     * Returns `none`, and stores nothing, when the session has exited and
     * cannot be resumed. The check and the write share the caller's
     * transaction, so nothing can change the answer in between. It checks no
     * grant: the caller is an operation that has checked its own.
     */
    queueConversationInput: (
      sessionId: string,
      text: string,
    ): Effect.Effect<
      Option.Option<
        Effect.Effect<void, NotFound | Validation | SqlError | SettingError | Schema.SchemaError>
      >,
      InvalidState | Validation | NotFound | SqlError | SettingError | Schema.SchemaError
    > =>
      Effect.gen(function* () {
        const session = yield* readSession(sessionId);
        // `undefined` for a session that has not exited, and `null` for an
        // exited session that cannot be resumed.
        const nativeSessionId =
          session.status === "exited"
            ? yield* resumableNativeSession(session).pipe(
                Effect.catchIf(
                  (error): error is InvalidState => error instanceof InvalidState,
                  () => Effect.succeed(null),
                ),
              )
            : undefined;
        if (nativeSessionId === null) return Option.none();
        const stored = yield* sessions.takeInput({
          sessionId,
          modelSelection: session.modelSelection,
          buildResumeSpec:
            nativeSessionId === undefined
              ? undefined
              : (now: StoredSession) => buildConversationResumeSpec(now, nativeSessionId),
          text,
          at: yield* nowIso,
          claimed: false,
        });
        return Option.some(deliverConversationInput(sessionId, stored.id));
      }),

    /**
     * Queues `text` as the prompt of one iteration of an agent step, on the
     * session an earlier iteration of the step ran in, inside the caller's
     * transaction. Returns the delivery, which the caller runs after its
     * commit (`deliverStepInput`). The input is stamped with the current
     * actor, which is the step's run.
     *
     * - A session that has exited but can be resumed goes back on the queue
     *   in place, with a resume spec, in the same transaction.
     * - Any other session gets the prompt when it is next idle.
     *
     * Fails with `InvalidState`, and stores nothing, when the session has
     * exited and cannot be resumed. It checks no grant: the caller is the
     * run's execution, which the workflow already allows.
     */
    queueStepInput: (
      sessionId: string,
      text: string,
      iteration: number,
    ): Effect.Effect<
      Effect.Effect<void, NotFound | Validation | SqlError | SettingError | Schema.SchemaError>,
      InvalidState | NotFound | SqlError | SettingError | Schema.SchemaError
    > =>
      Effect.gen(function* () {
        const session = yield* readSession(sessionId);
        const nativeSessionId =
          session.status === "exited" ? yield* resumableNativeSession(session) : undefined;
        yield* sessions.takeInput({
          sessionId,
          modelSelection: session.modelSelection,
          buildResumeSpec:
            nativeSessionId === undefined
              ? undefined
              : (now: StoredSession) => buildResumeSpec(now, now.modelSelection, nativeSessionId),
          text,
          at: yield* nowIso,
          claimed: false,
          stepIteration: iteration,
        });
        return deliverStepInput(sessionId);
      }),

    /**
     * Changes the model selection the session uses from its next turn on.
     * Returns the updated session. Fails if the session has exited or an
     * option is not offered.
     *
     * The stored `spec` does not change: it is what the runner was started
     * with, and a resume or a fork reads the session's `modelSelection`
     * instead.
     */
    update: (input: UpdateInput): Effect.Effect<Session, InputError> =>
      Effect.gen(function* () {
        yield* requireGrant("session.update");
        const { id, ...given } = yield* Effect.mapError(
          decodeUpdate(input),
          createDecodeValidationError,
        );
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const session = yield* readSession(id);
            if (session.status === "exited")
              return yield* Effect.fail(createInvalidStateError(HAS_EXITED));
            const modelSelection = yield* resolveModelSelection(session, given);
            yield* sessions.setSelection(id, modelSelection);
            return (yield* recordComposer)({ ...session, modelSelection });
          }),
        );
      }),

    /**
     * Sends one turn's input to a session. The input is stored first
     * (`storeInput`), so the result holds an input id the caller can edit or
     * cancel. Then, after the commit:
     *
     * - an idle session is sent the input here;
     * - a session with any other status keeps the input queued. Steering it
     *   into a running turn is what `input.steer` does;
     * - an exited session that this input resumed is dispatched, which places
     *   it like a spawn. The input is sent when the runner's `session.started`
     *   makes the session idle, like a spawn's prompt.
     *
     * The result always comes from the runner, never from the status the
     * controller read: only the adapter knows whether the input started a turn
     * or was folded into a turn already running.
     */
    input: (input: InputInput): Effect.Effect<SessionInputOutcome, InputError> =>
      Effect.gen(function* () {
        const { session, row } = yield* storeInput(input);
        // Outside the transaction: dispatch may send a frame to the runner,
        // and a transaction never waits on anything outside the database.
        if (session.status === "exited") yield* dispatch(session.runnerId);
        if (session.status !== "idle") return { inputId: row.id, result: "queued" };
        return yield* deliverClaimed(row);
      }),

    /**
     * Stores one turn's input to a session, like `input`, and returns the
     * stored input without waiting for the runner. Checks the `session.input`
     * grant, like `input`. Runs in the caller's transaction, or in its own
     * when there is none, and sends nothing to the runner unless that
     * transaction commits.
     *
     * After the commit, a fiber of its own delivers the input as `input`
     * would:
     *
     * - an idle session is sent the input, which was stored already claimed;
     * - an exited session that this input resumed is dispatched, and the
     *   input is sent when the session becomes idle;
     * - a session with any other status keeps the input queued until it is
     *   next idle.
     *
     * A failed delivery is logged, not returned, because the caller has
     * already returned. The input stays queued for the next flush.
     */
    queueInput: (input: InputInput): Effect.Effect<StoredInput, InputError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const { session, row } = yield* storeInput(input);
          if (session.status === "exited") {
            yield* forkAfterCommit(
              "Could not dispatch a session resumed for its input",
              dispatch(session.runnerId),
            );
          } else if (session.status === "idle") {
            yield* forkAfterCommit("Could not deliver a session's input", sendClaimed(row));
          }
          return row;
        }),
      ),

    /**
     * Gets a queued input into the turn a busy session is running
     * (`steerInto`): sent now to a provider that steers natively, or, for any
     * other provider, the running turn is interrupted and the input is sent
     * as the next turn. Fails before anything is sent when:
     *
     * - the input belongs to another session, or is no longer queued;
     * - the session is not busy.
     */
    steer: (sessionId: Id, inputId: Id): Effect.Effect<SessionInputOutcome, InputError> =>
      Effect.gen(function* () {
        yield* requireGrant("input.steer");
        const session = yield* readSession(sessionId);
        // Look the row up before checking the session's status, so an input id
        // from another session fails with not_found, whatever this session's
        // status is.
        const row = yield* sessions.queuedInput(sessionId, inputId);
        if (session.status !== "busy") return yield* Effect.fail(createInvalidStateError(NOT_BUSY));
        return yield* steerInto(session, row);
      }),

    /**
     * Ends the turn the session is running. Returns the session. Fails if the
     * session has exited or its runner is not connected.
     *
     * An idle session is not rejected. The controller's status lags behind the
     * runner's stream, so "no turn is running" would be a guess about a moment
     * that has already passed. The adapter knows, and its interrupt does
     * nothing when there is no turn to end.
     */
    interrupt: (id: Id): Effect.Effect<Session, Exclude<InputError, Validation>> =>
      Effect.gen(function* () {
        yield* requireGrant("session.interrupt");
        const session = yield* readSession(id);
        if (session.status === "exited")
          return yield* Effect.fail(createInvalidStateError(HAS_EXITED));
        yield* interruptTurn(session);
        return (yield* recordComposer)(session);
      }),

    /**
     * Decides the approval the session's harness is waiting on. Returns the
     * session.
     *
     * Every check runs before anything is sent to the runner, because a
     * decision applied to the wrong request is the one mistake this operation
     * must never make. It fails when:
     *
     * - the session has exited;
     * - the session has no open request, or waits on a different request;
     * - the request is a question, or does not offer the decision (see
     *   `validateDecision`);
     * - the approval was already decided, or its wait already ended.
     *
     * The decision also resolves the approval notification about the request
     * as `decided`, in the same transaction, stamped with the caller. So the
     * notification shows the request as answered, whether the user answered
     * it here or from the notification.
     *
     * The runner is told the decision once the transaction commits, so a
     * decision the database does not hold never reaches the harness.
     */
    respondToApprovalRequest: (
      input: RespondToApprovalRequestInput,
    ): Effect.Effect<Session, InputError> =>
      Effect.gen(function* () {
        yield* requireGrant("session.respondToApprovalRequest");
        const { id, requestId, decision } = yield* Effect.mapError(
          decodeRespondToApprovalRequest(input),
          createDecodeValidationError,
        );
        const { session, open } = yield* readOpenRequest(id, requestId);
        yield* validateDecision(open, decision);
        const actor = yield* currentStamp;
        yield* writeThenTellRunner(
          session.runnerId,
          sessions.respondingToApprovalRequest(id, requestId, decision),
          Effect.gen(function* () {
            yield* audit.append({
              kind: "session.responded",
              actor,
              payload: { sessionId: id, runnerId: session.runnerId, requestId, decision },
              at: yield* nowIso,
            });
            // Resolving the notification in this transaction also refuses a
            // second decision on the same request, wherever the first one
            // came from.
            yield* sessions.resolveApprovalNotification(id, requestId, decision);
          }),
        );
        return (yield* recordComposer)(session);
      }),

    /**
     * Answers the question the session's harness is waiting on. Returns the
     * session.
     *
     * Every check runs before anything is sent to the runner. It fails when:
     *
     * - the session has exited;
     * - the session has no open request, or waits on a different request;
     * - the request is an approval, or the answers do not fit its questions
     *   (see `validateAnswers`).
     *
     * A question takes no decision. To turn it down, the user stops the turn
     * with `interrupt`, and the adapter resolves the question as cancelled.
     *
     * A question raises no notification, so a second answer is not refused
     * here: it is sent on, and the adapter ignores it because the harness's
     * wait has ended. The runner is told once the transaction commits.
     */
    respondToQuestion: (input: RespondToQuestionInput): Effect.Effect<Session, InputError> =>
      Effect.gen(function* () {
        yield* requireGrant("session.respondToQuestion");
        const { id, requestId, answers } = yield* Effect.mapError(
          decodeRespondToQuestion(input),
          createDecodeValidationError,
        );
        const { session, open } = yield* readOpenRequest(id, requestId);
        yield* validateAnswers(open, answers);
        const actor = yield* currentStamp;
        yield* writeThenTellRunner(
          session.runnerId,
          sessions.respondingToQuestion(id, requestId, answers),
          Effect.gen(function* () {
            yield* audit.append({
              kind: "session.answered",
              actor,
              // The answers stay out of the audit log: `event.read` reaches it
              // without `session.read`, and an answer can be one the agent
              // asked to keep secret. The transcript holds them.
              payload: { sessionId: id, runnerId: session.runnerId, requestId },
              at: yield* nowIso,
            });
          }),
        );
        return (yield* recordComposer)(session);
      }),

    /**
     * Stops the session's harness. Returns the session as it is after the
     * stop. The session moves to `exited` when the runner reports the exit,
     * not here: there is no way yet to end a session whose exit the runner
     * never confirms.
     *
     * A queued session has no harness yet, and its runner was never told
     * about it, so it is ended directly without sending anything, and the
     * returned session has exited.
     */
    stop: (id: Id): Effect.Effect<Session, Exclude<InputError, Validation>> =>
      Effect.gen(function* () {
        yield* requireGrant("session.stop");
        const session = yield* readSession(id);
        if (session.status === "exited")
          return yield* Effect.fail(createInvalidStateError(HAS_EXITED));
        const stopped = yield* stopSession(session);
        if (stopped === "unreachable") return yield* Effect.fail(createInvalidStateError(GONE));
        return (yield* recordComposer)(yield* readSession(id));
      }),

    stopSession,
  };
});

/**
 * The live session operations. The service has two kinds of method, and using
 * one where the other belongs is a mistake nothing else would catch:
 *
 * - `update`, `input`, `steer`, `interrupt`, `respondToApprovalRequest`,
 *   `respondToQuestion` and `stop` are operations. Each checks its own grant and decodes its own input, and a
 *   route handler calls it directly. `queueInput` checks its grant and
 *   decodes its input too, but it stores the input in the caller's
 *   transaction, so it is for a caller inside the controller, not a route.
 * - `sendClaimed`, `deliverQueuedInput`, `queueConversationInput`,
 *   `queueStepInput` and `stopSession` check no grant. The first two send a
 *   row that is already stored: `sendClaimed` the row claimed when a session
 *   goes idle, `deliverQueuedInput` when something else has just stored a
 *   row. The grant was checked when the row was stored. `queueStepInput` is
 *   called by a workflow run, which the workflow already allows. The other
 *   two are the shared work of an operation that checks its own grant.
 *   Putting any of them on a route would let anyone who can reach the API
 *   call it.
 */
export class Live extends Context.Service<Live, Effect.Success<typeof make>>()(
  "hercule/controller/daemon/Live",
) {}

export const LiveLayer: Layer.Layer<
  Live,
  never,
  | SqlClient.SqlClient
  | SessionService
  | RunnerConnections
  | WorkspaceService
  | PluginHost
  | Settings
  | AuditLog
  | Dispatch
> = Layer.effect(Live)(make);
