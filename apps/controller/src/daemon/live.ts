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
import { currentStamp, requireGrant } from "../actor";
import { nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import type { PluginHost } from "../plugins";
import { providerRepository, resolvedInstance } from "../providers";
import { RunnerConnections } from "../runners";
import {
  buildContinuingSpec,
  readSessionOrFail,
  sessionRecordComposer,
  SessionService,
  sessionRepository,
  validateOptions,
  type StoredInput,
  type StoredSession,
} from "../sessions";
import { Settings, type SettingError } from "../settings";
import type { WorkspaceService } from "../workspaces";
import { Dispatch } from "./dispatch";
import { resumable } from "./resuming";

const Identified = Schema.Struct({ id: Id });

type Identified = Schema.Schema.Type<typeof Identified>;

const InputInput = Schema.Struct({ id: Id, ...SESSION_INPUT_FIELDS });

type InputInput = Schema.Schema.Type<typeof InputInput>;

const UpdateInput = Schema.Struct({ id: Id, ...SESSION_UPDATE_FIELDS });

type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const RespondInput = Schema.Struct({ id: Id, ...SESSION_RESPOND_FIELDS });

type RespondInput = Schema.Schema.Type<typeof RespondInput>;

const InputIdentified = Schema.Struct({ id: Id, inputId: Id });

type InputIdentified = Schema.Schema.Type<typeof InputIdentified>;

const decodeIdentified = Schema.decodeUnknownEffect(Identified);
const decodeInput = Schema.decodeUnknownEffect(InputInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);
const decodeInputIdentified = Schema.decodeUnknownEffect(InputIdentified);
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

const STEERING_UNSUPPORTED =
  "that session's provider does not support steering into a running turn";

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
  const one = readSessionOrFail(yield* sessionRepository);
  const recordComposer = yield* sessionRecordComposer;
  const instances = yield* providerRepository;
  const resolved = yield* resolvedInstance;
  const resumableNativeSession = yield* resumable;
  const connections = yield* RunnerConnections;
  const settings = yield* Settings;
  const audit = yield* AuditLog;
  const { dispatch } = yield* Dispatch;

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
      const session = yield* one(row.sessionId);
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
    sessionId: string,
    modelSelection: ModelSelection,
    nativeSessionId: string,
  ): Effect.Effect<string, NotFound | SqlError | SettingError | Schema.SchemaError> =>
    Effect.gen(function* () {
      const spec = buildContinuingSpec(
        yield* sessions.readSpec(sessionId),
        yield* settings.all(),
        modelSelection,
        nativeSessionId,
        "resume",
      );
      return JSON.stringify(encodeSpec(spec));
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

  return {
    flush,

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
     *   idle after the restart;
     * - a session with any other status, such as busy, is left alone, because
     *   its inputs are sent when it next becomes idle.
     *
     * A session whose runner is not connected gets nothing, and neither does a
     * session that has ended for good. The row stays queued, where a reader can
     * see it was not delivered, and the next caller tries again. For a session
     * that has ended for good, the session routing table's sweep ends the
     * subscription that wrote the input.
     *
     * Inputs from a subscription match are not the only ones that get here. An
     * input a person typed that the runner rejected, or whose session went
     * idle without the controller seeing it, is retried on every tick for as
     * long as the session can take it. The check for an input already sent and
     * unanswered keeps those retries to one row at a time.
     */
    deliverQueuedInput: (
      sessionId: string,
    ): Effect.Effect<void, NotFound | SqlError | SettingError | Schema.SchemaError> =>
      Effect.gen(function* () {
        const session = yield* one(sessionId);
        if (session.status === "idle") {
          // The runner takes one input per turn. An input is already sent and
          // unanswered, so its turn has not started yet, and a second input
          // sent now would have to be held by the runner. The next pass sends
          // it, once the runner has reported what it did with the first.
          if (yield* sessions.holdsInputOnTheWire(sessionId)) return;
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
        const nativeSessionId = yield* Effect.catchIf(
          Effect.asSome(resumableNativeSession(session)),
          (error): error is InvalidState => error instanceof InvalidState,
          () => Effect.succeedNone,
        );
        if (Option.isNone(nativeSessionId)) return;
        const resumeSpec = yield* buildResumeSpec(
          sessionId,
          session.modelSelection,
          nativeSessionId.value,
        );
        const moved = yield* withTransaction(
          sql,
          Effect.flatMap(nowIso, (at) => sessions.resume(sessionId, resumeSpec, at, true)),
        );
        // Another caller already resumed the session. Dispatching again would
        // place it twice.
        if (!moved) return;
        // After the commit: dispatch sends a frame to the runner, and a
        // transaction never waits on anything outside the database.
        yield* dispatch(session.runnerId);
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
            const session = yield* one(id);
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
            const session = yield* one(id);
            const nativeSessionId =
              session.status === "exited" ? yield* resumableNativeSession(session) : undefined;
            const modelSelection = yield* resolveModelSelection(session, picks);
            const at = yield* nowIso;
            const created = yield* sessions.takeInput({
              sessionId: id,
              modelSelection,
              resumeSpec:
                nativeSessionId === undefined
                  ? undefined
                  : yield* buildResumeSpec(id, modelSelection, nativeSessionId),
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
     * Sends a queued input into the turn a busy session is running, through
     * the same delivery as `session.input` uses for an idle session. Fails
     * before anything is sent when:
     *
     * - the input belongs to another session, or is no longer queued;
     * - the session is not busy;
     * - the session's provider does not support steering.
     */
    steer: (input: InputIdentified): Effect.Effect<SessionInputOutcome, InputError> =>
      Effect.gen(function* () {
        yield* requireGrant("input.steer");
        const { id, inputId } = yield* Effect.mapError(
          decodeInputIdentified(input),
          createDecodeValidationError,
        );
        const session = yield* one(id);
        // Look the row up before checking the session's status, so an input id
        // from another session fails with not_found, whatever this session's
        // status is.
        const row = yield* sessions.queuedInput(id, inputId);
        if (session.status !== "busy") return yield* Effect.fail(createInvalidStateError(NOT_BUSY));
        const { definition } = yield* resolved(session.instanceId);
        if (definition.declared.steering !== "native") {
          return yield* Effect.fail(createInvalidStateError(STEERING_UNSUPPORTED));
        }
        // The claim stops a second steer, or the flush, from sending the same
        // row: only one caller's conditional update still finds it waiting,
        // whatever the read above returned. The claimed row, not that earlier
        // read, is what gets sent, in case the input was edited in between.
        const claimed = yield* sessions.claimInput(row.id);
        if (Option.isNone(claimed)) return yield* Effect.fail(createInvalidStateError(NOT_WAITING));
        return yield* deliverClaimed(claimed.value);
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
    interrupt: (input: Identified): Effect.Effect<Session, InputError> =>
      Effect.gen(function* () {
        yield* requireGrant("session.interrupt");
        const { id } = yield* Effect.mapError(decodeIdentified(input), createDecodeValidationError);
        const session = yield* one(id);
        if (session.status === "exited")
          return yield* Effect.fail(createInvalidStateError(HAS_EXITED));
        if (!(yield* connections.tell(session.runnerId, sessions.interrupting(id)))) {
          return yield* Effect.fail(createInvalidStateError(GONE));
        }
        const actor = yield* currentStamp;
        yield* withTransaction(
          sql,
          Effect.flatMap(nowIso, (at) =>
            audit.append({
              kind: "session.interrupted",
              actor,
              payload: { sessionId: id, runnerId: session.runnerId },
              at,
            }),
          ),
        );
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
        const session = yield* one(id);
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
     * Stops the session's harness. Returns the session. The session moves to
     * `exited` when the runner reports the exit, not here: there is no way yet
     * to end a session whose exit the runner never confirms.
     *
     * A queued session has no harness yet, and its runner was never told
     * about it, so it is ended directly without sending anything.
     */
    stop: (input: Identified): Effect.Effect<Session, InputError> =>
      Effect.gen(function* () {
        yield* requireGrant("session.stop");
        const { id } = yield* Effect.mapError(decodeIdentified(input), createDecodeValidationError);
        const session = yield* one(id);
        if (session.status === "exited")
          return yield* Effect.fail(createInvalidStateError(HAS_EXITED));
        if (session.status === "queued") {
          return yield* withTransaction(
            sql,
            Effect.gen(function* () {
              const at = yield* nowIso;
              yield* sessions.endQueued(id, at);
              yield* audit.append({
                kind: "session.stopped",
                actor: yield* currentStamp,
                payload: { sessionId: id, runnerId: session.runnerId },
                at,
              });
              return (yield* recordComposer)({
                ...session,
                status: "exited" as const,
                exitedAt: at,
              });
            }),
          );
        }
        if (!(yield* connections.tell(session.runnerId, sessions.stopping(id)))) {
          return yield* Effect.fail(createInvalidStateError(GONE));
        }
        const actor = yield* currentStamp;
        yield* withTransaction(
          sql,
          Effect.flatMap(nowIso, (at) =>
            audit.append({
              kind: "session.stopped",
              actor,
              payload: { sessionId: id, runnerId: session.runnerId },
              at,
            }),
          ),
        );
        return (yield* recordComposer)(session);
      }),
  };
});

/**
 * The live session operations. The service has two kinds of method, and using
 * one where the other belongs is a mistake nothing else would catch:
 *
 * - `update`, `input`, `steer`, `interrupt`, `respond` and `stop` are
 *   operations. Each checks its own grant and decodes its own input, and a
 *   route handler calls it directly.
 * - `flush` and `deliverQueuedInput` check no grant. Both send a row that is
 *   already stored: `flush` when a session goes idle, `deliverQueuedInput`
 *   when something else has just stored a row. The grant was checked when the
 *   row was stored, so putting either on a route would let anyone who can
 *   reach the API call it.
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
