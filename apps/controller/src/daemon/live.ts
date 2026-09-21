/**
 * The live channel to a session's machine: the operations whose effect reaches
 * the harness holding that session, and the delivery every one of them goes out
 * through. `session.update` is here too - it sends nothing itself, but the
 * selection it settles rides the next frame, and what it may be set to is the
 * machine's own catalog to say.
 *
 * A row is stored or claimed first and sent afterwards, never the other way
 * round: what the machine is told about has to be something a caller can read
 * back, edit or call off, and what the machine says it did is written where the
 * caller reads it. No transaction spans the wait for that answer.
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
  Id,
  InvalidState,
  invalidState,
  NotFound,
  SESSION_INPUT_FIELDS,
  SESSION_RESPOND_FIELDS,
  SESSION_UPDATE_FIELDS,
  validation,
  validationOf,
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
  requireSession,
  sessionRecordComposer,
  SessionService,
  sessionRepository,
  validatedOptions,
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
 * How long the controller waits for a runner to say what it did with an input.
 * Long enough for a harness to take a message, short enough that a caller
 * blocked on the answer is not left there.
 */
const SESSION_INPUT_DEADLINE: Duration.Duration = Duration.seconds(10);

/** Tests hand over a deadline they can wait out. */
export const SessionInputDeadline = Context.Reference<Duration.Duration>(
  "hercule/controller/daemon/SessionInputDeadline",
  { defaultValue: (): Duration.Duration => SESSION_INPUT_DEADLINE },
);

const HAS_EXITED = "that session has exited";

const GONE = "that session's runner is no longer connected";

const NOT_WAITING =
  "that input is no longer waiting: it was sent, delivered or cancelled in the meantime";

const REFUSED = "that session's runner would not take the input";

const NOT_BUSY = "only a busy session can be steered";

const STEERING_UNSUPPORTED =
  "that session's provider does not support steering into a running turn";

const NO_OPEN_REQUEST = "that session is not waiting on a decision";

/**
 * The harness has moved on: the request this answer names is not the one it is
 * parked on, so applying it would answer a question nobody asked.
 */
const STALE_REQUEST = "that request is not the one this session is waiting on";

/**
 * Both ways an input can fail to reach the harness - no connection, and no
 * answer in time - read the same to a caller, and put the row back to
 * waiting for the next transition to idle, or a hand steer, to try again.
 */
const NOT_DELIVERED =
  "that session's runner did not take the input; it stays queued for the next turn";

type ReadError = Unauthenticated | Forbidden | Validation | SqlError;

type InputError = ReadError | NotFound | InvalidState | SettingError | Schema.SchemaError;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* SessionService;
  const one = requireSession(yield* sessionRepository);
  const recordComposer = yield* sessionRecordComposer;
  const instances = yield* providerRepository;
  const resolved = yield* resolvedInstance;
  const resumableNativeSession = yield* resumable;
  const connections = yield* RunnerConnections;
  const settings = yield* Settings;
  const audit = yield* AuditLog;
  const { dispatch } = yield* Dispatch;

  /**
   * The machine's catalog is read only where there are picks to judge against
   * it: with none there is nothing validation could refuse, and a plain turn
   * should not be held to a lookup it never needed. The read is the snapshot
   * row alone, so this stays inside the transaction that writes what it decides.
   */
  const selectionFor = (
    session: StoredSession,
    given: SessionSelection,
  ): Effect.Effect<ModelSelection, Validation | SqlError | Schema.SchemaError> =>
    Effect.gen(function* () {
      const model = given.model ?? session.modelSelection.model;
      const picks = given.options ?? {};
      if (Object.keys(picks).length > 0) {
        const snapshots = yield* instances.snapshotsOf(session.instanceId);
        const snapshot = snapshots.find((one) => one.runnerId === session.runnerId);
        yield* validatedOptions(snapshot?.models ?? [], model, picks);
      }
      const carried = model === session.modelSelection.model ? session.modelSelection.options : {};
      return { model, options: { ...carried, ...picks } };
    });

  /**
   * Sends one stored input to the machine holding the session and waits for the
   * machine to say what it did with it. `none` where there is no connection or
   * nothing came back in time; the wait is outside any transaction. The caller
   * has already claimed the row before this runs.
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
   * Sends a row that is already claimed - on the wire, `sent_at` set - and
   * settles what became of it: a delivery the machine reports is recorded and
   * handed back; a refusal or silence is left where the session service puts
   * it, and fails with the same reason. The idle path, a steer and the flush
   * all reach the machine through this and nothing else does.
   *
   * The model is read here, after the row is claimed, rather than earlier by
   * the caller: a `session.update` landing between the caller's own read and
   * the claim would otherwise ride a frame it never applied to.
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
      return yield* Effect.fail(invalidState(reason));
    });

  /**
   * The document a session picking its own transcript up goes back on the
   * queue with. Read back rather than built again, so the continuation runs
   * under exactly what the session ran under before its harness went.
   */
  const buildResumeDocument = (
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

  /** Sends the oldest row still waiting on a session, where there is one. */
  const flushOldest = (sessionId: string): Effect.Effect<void, SqlError> =>
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
    /**
     * Sends what one transition to idle releases: the oldest row still waiting,
     * claimed the instant it is found, so a second transition landing before
     * the machine answers cannot also take it - the claim is what a row's turn
     * actually was for, so there is no boundary to count and nothing to catch
     * up on. A refusal or silence is left where `deliverClaimed` puts it: back
     * to waiting, for the next transition to send.
     */
    flush: flushOldest,

    /**
     * Gets a row somebody else stored to the session it was stored for.
     *
     * The row is already durable when this runs, so nothing here can be sent
     * for a write that rolls back. What happens next is the session's status,
     * and it is the same three outcomes an input a person types gets: an idle
     * session is sent the oldest row it holds; a session on a running turn is
     * left alone, because its rows leave at the turn's boundary; a session
     * whose harness has gone but whose transcript has not goes back on the
     * queue under the document that picks that transcript up, and what it
     * holds leaves at the transition to idle its restart makes.
     *
     * A session that has ended for good takes nothing and is not an error
     * here: the row stays where a reader can see it never went through, and
     * the caller's own sweep is what ends the claim behind it.
     */
    deliverQueuedInput: (
      sessionId: string,
    ): Effect.Effect<void, NotFound | SqlError | SettingError | Schema.SchemaError> =>
      Effect.gen(function* () {
        const session = yield* one(sessionId);
        if (session.status === "idle") return yield* flushOldest(sessionId);
        if (session.status !== "exited") return;
        const nativeSessionId = yield* Effect.catchIf(
          Effect.asSome(resumableNativeSession(session)),
          (error): error is InvalidState => error instanceof InvalidState,
          () => Effect.succeedNone,
        );
        if (Option.isNone(nativeSessionId)) return;
        const document = yield* buildResumeDocument(
          sessionId,
          session.modelSelection,
          nativeSessionId.value,
        );
        yield* withTransaction(
          sql,
          Effect.flatMap(nowIso, (at) => sessions.resumeInPlace(sessionId, document, at)),
        );
        // After the commit: dispatch tells a machine, and a transaction never
        // spans a wait on anything outside the database.
        yield* dispatch(session.runnerId);
      }),

    /**
     * What the session runs under from here on. The stored `spec` is left
     * alone: it is the document the runner was started with, and a resume or
     * a fork reads the session's own `modelSelection` instead.
     */
    update: (input: UpdateInput): Effect.Effect<Session, InputError> =>
      Effect.gen(function* () {
        yield* requireGrant("session.update");
        const { id, ...given } = yield* Effect.mapError(decodeUpdate(input), validationOf);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const session = yield* one(id);
            if (session.status === "exited") return yield* Effect.fail(invalidState(HAS_EXITED));
            const modelSelection = yield* selectionFor(session, given);
            yield* sessions.setSelection(id, modelSelection);
            return (yield* recordComposer)({ ...session, modelSelection });
          }),
        );
      }),

    /**
     * One turn's input. Stored first, so the answer names a row the caller can
     * edit or cancel. An idle session has no transition to idle coming, so its
     * row is inserted already claimed - on the wire the instant it exists,
     * never visible to a cancel or a flush as merely waiting - and delivered
     * here rather than left for a flush that will never run; every other
     * status queues, and steering one is `input.steer`'s to do.
     *
     * A session whose harness is gone but whose transcript is not is resumed by
     * this call: the row is stored waiting, the session goes back on the queue
     * under a spec that names its provider-native session, and dispatch
     * places it exactly as it places a spawn. What the user typed leaves at the
     * transition to idle the machine's `session.started` makes, like a spawn's
     * own prompt.
     *
     * What it did is always the machine's own word for it, never the status the
     * controller read: an input that opened a turn and one that was folded into
     * a turn already running are told apart by the adapter alone.
     */
    input: (input: InputInput): Effect.Effect<SessionInputOutcome, InputError> =>
      Effect.gen(function* () {
        yield* requireGrant("session.input");
        const { id, text, ...picks } = yield* Effect.mapError(decodeInput(input), validationOf);
        // The row is read, the picks are judged and both writes happen in one
        // transaction: two submissions landing together are serialised rather
        // than merging their picks over the same stale row, and a pick the
        // model does not offer rolls the whole thing back, leaving neither a
        // rewritten selection nor an input row behind.
        const { session, row } = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const session = yield* one(id);
            const nativeSessionId =
              session.status === "exited" ? yield* resumableNativeSession(session) : undefined;
            const modelSelection = yield* selectionFor(session, picks);
            const at = yield* nowIso;
            const created = yield* sessions.takeInput({
              sessionId: id,
              modelSelection,
              resumeSpec:
                nativeSessionId === undefined
                  ? undefined
                  : yield* buildResumeDocument(id, modelSelection, nativeSessionId),
              text,
              at,
              claimed: session.status === "idle",
            });
            return { session, row: created };
          }),
        );
        // Outside the transaction: dispatch may tell the machine, and a
        // transaction never spans a wait on anything outside the database.
        if (session.status === "exited") yield* dispatch(session.runnerId);
        if (session.status !== "idle") return { inputId: row.id, result: "queued" };
        return yield* deliverClaimed(row);
      }),

    /**
     * Folds a still-queued row into the turn a busy session is already
     * running, reusing the same delivery `session.input`'s idle path uses. A
     * row that is not there to steer - on another session, already left, on
     * the wire, or behind a provider that cannot fold a turn open - is refused
     * before anything is sent.
     */
    steer: (input: InputIdentified): Effect.Effect<SessionInputOutcome, InputError> =>
      Effect.gen(function* () {
        yield* requireGrant("input.steer");
        const { id, inputId } = yield* Effect.mapError(decodeInputIdentified(input), validationOf);
        const session = yield* one(id);
        // The row is looked up before the session's own status is judged, so an
        // id belonging to another session reads not_found rather than whatever
        // this session's status happens to be.
        const row = yield* sessions.queuedInput(id, inputId);
        if (session.status !== "busy") return yield* Effect.fail(invalidState(NOT_BUSY));
        const { definition } = yield* resolved(session.instanceId);
        if (definition.declared.steering !== "native") {
          return yield* Effect.fail(invalidState(STEERING_UNSUPPORTED));
        }
        // The claim is the guard against a second steer, or the flush, taking
        // the same row: only one caller's conditional update finds it still
        // waiting, whatever the read a moment ago said - and its own answer,
        // not that stale read, is what gets sent, in case a rewrite landed in
        // between.
        const claimed = yield* sessions.claimInput(row.id);
        if (Option.isNone(claimed)) return yield* Effect.fail(invalidState(NOT_WAITING));
        return yield* deliverClaimed(claimed.value);
      }),

    /**
     * Ends the turn the session is running.
     *
     * Only a session whose harness is gone refuses. The status the controller
     * holds lags the machine's own stream, so "no turn is running" here is a
     * guess about a moment that has already passed; the adapter knows, and its
     * interrupt is a no-op where there is nothing to end.
     */
    interrupt: (input: Identified): Effect.Effect<Session, InputError> =>
      Effect.gen(function* () {
        yield* requireGrant("session.interrupt");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        const session = yield* one(id);
        if (session.status === "exited") return yield* Effect.fail(invalidState(HAS_EXITED));
        if (!(yield* connections.tell(session.runnerId, sessions.interrupting(id)))) {
          return yield* Effect.fail(invalidState(GONE));
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
     * Answers the request the session's harness is parked on.
     *
     * Everything is refused before anything crosses the wire, because an answer
     * that lands on the wrong question is the one mistake this operation must
     * never make.
     */
    respond: (input: RespondInput): Effect.Effect<Session, InputError> =>
      Effect.gen(function* () {
        yield* requireGrant("session.respond");
        const { id, requestId, decision } = yield* Effect.mapError(
          decodeRespond(input),
          validationOf,
        );
        const session = yield* one(id);
        if (session.status === "exited") return yield* Effect.fail(invalidState(HAS_EXITED));
        const open = session.openRequest;
        if (open === null) return yield* Effect.fail(invalidState(NO_OPEN_REQUEST));
        if (open.requestId !== requestId) return yield* Effect.fail(invalidState(STALE_REQUEST));
        if (!open.decisions.includes(decision)) {
          return yield* Effect.fail(
            validation([
              {
                path: ["decision"],
                message: `that request takes ${open.decisions.join(", ")}`,
              },
            ]),
          );
        }
        if (
          !(yield* connections.tell(session.runnerId, sessions.responding(id, requestId, decision)))
        ) {
          return yield* Effect.fail(invalidState(GONE));
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
     * Ends the harness. The session moves to `exited` when the machine reports
     * the exit, not here: this build has no way to end a session the machine
     * never confirms is gone.
     *
     * A queued session has no harness to tell: it is ended directly, with
     * nothing sent to the runner, since it was never told about it either.
     */
    stop: (input: Identified): Effect.Effect<Session, InputError> =>
      Effect.gen(function* () {
        yield* requireGrant("session.stop");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        const session = yield* one(id);
        if (session.status === "exited") return yield* Effect.fail(invalidState(HAS_EXITED));
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
          return yield* Effect.fail(invalidState(GONE));
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
 * Two kinds of method, and wiring one where the other belongs is a mistake
 * nothing else would catch.
 *
 * `update`, `input`, `steer`, `interrupt`, `respond` and `stop` are operations:
 * each checks its own grant and decodes its own input, and a route handler
 * calls it directly. `flush` and `deliverQueuedInput` check none: both send a
 * row that is already stored - the first when a session goes idle, the second
 * when something else has just stored one - so the grant was checked when the
 * row was stored, and putting either on a route would serve it to anyone who
 * can reach the API.
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
