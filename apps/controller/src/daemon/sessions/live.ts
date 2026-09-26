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
import { SessionSpec, type ModelSelection, type SessionInputResult } from "@hercule/protocol";
import {
  createDecodeValidationError,
  createInvalidStateError,
  createValidationError,
  findNearestSupportedAccessMode,
  Id,
  InvalidState,
  NotFound,
  SESSION_INPUT_FIELDS,
  SESSION_RESPOND_FIELDS,
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
  inputRepository,
  isResumeHeld,
  readSessionOrFail,
  sessionRecordComposer,
  SessionService,
  sessionRepository,
  validateOptions,
  type StoredInput,
  type StoredSession,
} from "../../sessions";
import { Settings, type SettingError } from "../../settings";
import type { WorkspaceService } from "../../workspaces";
import { Dispatch } from "./dispatch";
import { resumable } from "./resuming";

const InputInput = Schema.Struct({ id: Id, ...SESSION_INPUT_FIELDS });

type InputInput = Schema.Schema.Type<typeof InputInput>;

const UpdateInput = Schema.Struct({ id: Id, ...SESSION_UPDATE_FIELDS });

type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const RespondInput = Schema.Struct({ id: Id, ...SESSION_RESPOND_FIELDS });

type RespondInput = Schema.Schema.Type<typeof RespondInput>;

const decodeInput = Schema.decodeUnknownEffect(InputInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);
const decodeRespond = Schema.decodeUnknownEffect(RespondInput);
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

const NO_OPEN_REQUEST = "that session is not waiting on a decision";

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
  const inputs = yield* inputRepository;
  const recordComposer = yield* sessionRecordComposer;
  const instances = yield* providerRepository;
  const resolved = yield* resolvedInstance;
  const resumableNativeSession = yield* resumable;
  const connections = yield* RunnerConnections;
  const settings = yield* Settings;
  const audit = yield* AuditLog;
  const { dispatch } = yield* Dispatch;
  const agents = yield* agentRepository;

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
        sessions.inputFrame(row, session.modelSelection),
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
        yield* sessions.delivered(row, delivery);
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
   * Sends the session's oldest waiting input, after the session goes idle.
   *
   * The row is claimed as soon as it is found, so a second change to idle
   * that arrives before the runner replies cannot also send it. If the runner
   * rejects the input or does not reply, `deliverClaimed` puts the row back to
   * waiting, and the next change to idle sends it.
   */
  const flush = (sessionId: string): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const claimed = yield* sessions.claimOldest(sessionId);
      if (Option.isNone(claimed)) return;
      yield* Effect.catchIf(
        deliverClaimed(claimed.value),
        (error): error is InvalidState | NotFound =>
          error instanceof InvalidState || error instanceof NotFound,
        () => Effect.void,
      );
    });

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
        // The runner takes one input per turn. An input is already sent and
        // unanswered, so its turn has not started yet, and a second input
        // sent now would have to be held by the runner. The next pass sends
        // it, once the runner has reported what it did with the first.
        if (yield* inputs.holdsInputOnTheWire(sessionId)) return;
        // A runner that is not connected cannot be sent anything. Claiming a
        // row only to put it straight back would rewrite the row, and notify
        // every client watching the session, on every pass while the runner
        // is away. With a connection, the flush sends the session's oldest
        // queued row, whoever wrote it. So a typed input whose delivery
        // failed is retried first, and a matched input waits behind it, as
        // in any queue.
        if (!(yield* connections.holdsConnection(session.runnerId))) return;
        return yield* flush(sessionId);
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
   * Tells the session's runner to end the running turn, as the actor behind
   * the current request, and writes the `session.interrupted` audit entry.
   * Fails with `InvalidState` when the runner is not connected.
   */
  const interruptTurn = (session: StoredSession): Effect.Effect<void, InvalidState | SqlError> =>
    Effect.gen(function* () {
      if (!(yield* connections.tell(session.runnerId, sessions.interrupting(session.id)))) {
        return yield* Effect.fail(createInvalidStateError(GONE));
      }
      const actor = yield* currentStamp;
      yield* withTransaction(
        sql,
        Effect.flatMap(nowIso, (at) =>
          audit.append({
            kind: "session.interrupted",
            actor,
            payload: { sessionId: session.id, runnerId: session.runnerId },
            at,
          }),
        ),
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
   * Stops a session that has not exited, as the actor behind the current
   * request, and writes the `session.stopped` audit entry. Returns what
   * happened:
   *
   * - `ended`: the session was queued, so no runner held it, and it has
   *   exited now;
   * - `told`: the runner was told to stop the session, and the session exits
   *   when the runner reports the exit;
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
      if (!(yield* connections.tell(session.runnerId, sessions.stopping(session.id)))) {
        return "unreachable";
      }
      yield* withTransaction(
        sql,
        Effect.flatMap(nowIso, (at) =>
          audit.append({ kind: "session.stopped", actor, payload, at }),
        ),
      );
      return "told";
    });

  return {
    flush,

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
     * Sends one turn's input to a session. The input is stored first, so the
     * result holds an input id the caller can edit or cancel.
     *
     * - An idle session will not change to idle again, so no flush would send
     *   its input. The row is inserted already claimed, so a cancel or a flush
     *   never sees it as waiting, and it is delivered here.
     * - A session with any other status gets the input queued. Steering it
     *   into a running turn is what `input.steer` does.
     * - An exited session whose transcript can be resumed is resumed by this
     *   call. The row is stored as waiting, the session goes back on the queue
     *   with a spec that holds its provider-native session id, and dispatch
     *   places it like a spawn. The input is sent when the runner's
     *   `session.started` makes the session idle, like a spawn's prompt.
     *
     * The result always comes from the runner, never from the status the
     * controller read: only the adapter knows whether the input started a turn
     * or was folded into a turn already running.
     */
    input: (input: InputInput): Effect.Effect<SessionInputOutcome, InputError> =>
      Effect.gen(function* () {
        yield* requireGrant("session.input");
        const { id, text, ...picks } = yield* Effect.mapError(
          decodeInput(input),
          createDecodeValidationError,
        );
        // Reading the session, validating the options and both writes happen
        // in one transaction. So two inputs sent at the same time run one after
        // the other instead of merging their options over the same stale row,
        // and an option the model does not offer rolls everything back,
        // leaving neither a changed selection nor an input row.
        const { session, row } = yield* withTransaction(
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
            const created = yield* sessions.takeInput({
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
            return { session, row: created };
          }),
        );
        // Outside the transaction: dispatch may send a frame to the runner,
        // and a transaction never waits on anything outside the database.
        if (session.status === "exited") yield* dispatch(session.runnerId);
        if (session.status !== "idle") return { inputId: row.id, result: "queued" };
        return yield* deliverClaimed(row);
      }),

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
     * Answers the request the session's harness is waiting on. Returns the
     * session.
     *
     * Every check runs before anything is sent to the runner, because an
     * answer applied to the wrong request is the one mistake this operation
     * must never make. It fails when the session has exited, has no open
     * request, is waiting on a different request, or the decision is not one
     * the request accepts.
     */
    respond: (input: RespondInput): Effect.Effect<Session, InputError> =>
      Effect.gen(function* () {
        yield* requireGrant("session.respond");
        const { id, requestId, decision } = yield* Effect.mapError(
          decodeRespond(input),
          createDecodeValidationError,
        );
        const session = yield* readSession(id);
        if (session.status === "exited")
          return yield* Effect.fail(createInvalidStateError(HAS_EXITED));
        const open = session.openRequest;
        if (open === null) return yield* Effect.fail(createInvalidStateError(NO_OPEN_REQUEST));
        if (open.requestId !== requestId)
          return yield* Effect.fail(createInvalidStateError(STALE_REQUEST));
        if (!open.decisions.includes(decision)) {
          return yield* Effect.fail(
            createValidationError([
              {
                path: ["decision"],
                message: `that request accepts only ${open.decisions.join(", ")}`,
              },
            ]),
          );
        }
        if (
          !(yield* connections.tell(session.runnerId, sessions.responding(id, requestId, decision)))
        ) {
          return yield* Effect.fail(createInvalidStateError(GONE));
        }
        const actor = yield* currentStamp;
        yield* withTransaction(
          sql,
          Effect.flatMap(nowIso, (at) =>
            audit.append({
              kind: "session.responded",
              actor,
              payload: { sessionId: id, runnerId: session.runnerId, requestId, decision },
              at,
            }),
          ),
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
 * - `update`, `input`, `steer`, `interrupt`, `respond` and `stop` are
 *   operations. Each checks its own grant and decodes its own input, and a
 *   route handler calls it directly.
 * - `flush`, `deliverQueuedInput`, `queueConversationInput` and
 *   `stopSession` check no grant. The first two send a row that is already
 *   stored: `flush` when a session goes idle, `deliverQueuedInput` when
 *   something else has just stored a row. The grant was checked when the row
 *   was stored. The other two are the shared work of an operation that
 *   checks its own grant. Putting any of them on a route would let anyone who
 *   can reach the API call it.
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
