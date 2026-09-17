/**
 * Sessions as the API sees them, and the one place the fleet's session traffic
 * is turned into rows.
 *
 * A session is written here from a spec that is already settled: what a thread
 * runs, where it runs and in which working area are decided a layer up, by the
 * controller daemon.
 *
 * `ingesting` is the driver: one fiber, reading what the fleet reported in the
 * order it arrived. Each event's stream rows and the status change they cause
 * commit together (spec 04 Truth model).
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  SessionSpec,
  type AccessMode,
  type Delivery,
  type ModelSelection,
  type ProviderEvent,
  type SessionBinding,
  type SessionInputResult,
  type SessionStart,
} from "@hydra/protocol";
import {
  DEFAULT_PAGE_LIMIT,
  Id,
  INPUT_SORT_FIELDS,
  INPUT_UPDATE_FIELDS,
  InvalidState,
  invalidState,
  NotFound,
  notFound,
  SESSION_SORT_FIELDS,
  SessionFilter,
  SESSION_INPUT_FIELDS,
  SESSION_RESPOND_FIELDS,
  SESSION_UPDATE_FIELDS,
  type SessionSelection,
  TRANSCRIPT_SORT_FIELDS,
  validation,
  validationOf,
  type Forbidden,
  type Input,
  type Session,
  type SessionInputOutcome,
  type SortDirection,
  type TranscriptRow,
  type Unauthenticated,
  type Validation,
} from "@hydra/contract";
import { currentStamp, requireGrant, SYSTEM_ACTOR } from "../actor";
import {
  afterCommit,
  announce,
  nowIso,
  pageInput,
  refuseCursor,
  withTransaction,
  type Page,
} from "../db";
import { mintToken, hashToken } from "../credentials";
import { AuditLog } from "../events";
import { SessionTokens } from "../permissions";
import type { PluginHost } from "../plugins";
import { loggedIn, NO_PLACEMENT, providerRepository, resolvedInstance } from "../providers";
import {
  DRAINING,
  RETIRED,
  RunnerPresence,
  runnerRepository,
  type Connection,
  type SessionTraffic,
} from "../runners";
import type { Secrets } from "../secrets";
import { Settings, type SettingError } from "../settings";
import { gitCredentials, gitIdentityOf, WorkspaceService, type GitCredential } from "../workspaces";
import { inputRepository, type StoredInput } from "./inputs";
import { continuingSpecOf, validatedOptions } from "./options";
import { sessionRepository, type StoredSession } from "./repository";
import { fold, openRequestAfter, track, type Tracked } from "./stream";

const QueryInput = Schema.Struct({
  ...SessionFilter.fields,
  ...pageInput(SESSION_SORT_FIELDS),
});

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

const Identified = Schema.Struct({ id: Id });

export type Identified = Schema.Schema.Type<typeof Identified>;

const InputInput = Schema.Struct({ id: Id, ...SESSION_INPUT_FIELDS });

export type InputInput = Schema.Schema.Type<typeof InputInput>;

const UpdateInput = Schema.Struct({ id: Id, ...SESSION_UPDATE_FIELDS });

export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const TranscriptInput = Schema.Struct({ id: Id, ...pageInput(TRANSCRIPT_SORT_FIELDS) });

export type TranscriptInput = Schema.Schema.Type<typeof TranscriptInput>;

const InputQueryInput = Schema.Struct({ id: Id, ...pageInput(INPUT_SORT_FIELDS) });

export type InputQueryInput = Schema.Schema.Type<typeof InputQueryInput>;

const InputUpdate = Schema.Struct({ id: Id, inputId: Id, ...INPUT_UPDATE_FIELDS });

export type InputUpdate = Schema.Schema.Type<typeof InputUpdate>;

const RespondInput = Schema.Struct({ id: Id, ...SESSION_RESPOND_FIELDS });

export type RespondInput = Schema.Schema.Type<typeof RespondInput>;

const InputIdentified = Schema.Struct({ id: Id, inputId: Id });

export type InputIdentified = Schema.Schema.Type<typeof InputIdentified>;

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
 * What it takes to write one session on a machine, whether it is the first of a
 * conversation or a branch off another one's. Everything in it is settled: the
 * controller daemon decided what runs where and opened the working area before
 * this row exists.
 */
export interface Opening {
  /**
   * Minted by the caller, not by the insert: the working area is opened in the
   * same transaction, and a thread's own worktree is made on a branch named
   * after the thread, so the id has to exist before either row does.
   */
  readonly id: string;
  readonly permissionProfileId: string;
  readonly runnerId: string;
  readonly requestedAccessMode: AccessMode;
  readonly parentSessionId: string | undefined;
  /** Everything the machine is told, and the source of what the row stores. */
  readonly spec: SessionSpec;
  readonly prompt: string;
  readonly kind: "session.spawned" | "session.continued";
  /** What the audit entry records beyond the new session's own id. */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly projectId: string | undefined;
  /** The branch the main workspace is switched to before the harness starts. */
  readonly checkoutBranch: string | undefined;
  /** The GitHub account this session pushes as. */
  readonly githubConnectionId: string | undefined;
  /**
   * Timed by the caller: the working area it opened and this row are one write
   * set, and they carry one instant between them. Who is writing is ambient, so
   * it is not passed.
   */
  readonly at: string;
}

/** A listing as the contract hands it out: the cursor is a key, not a null. */
const pageOut = <A>(listing: Page<A>): { items: ReadonlyArray<A>; nextCursor?: string } => ({
  items: listing.items,
  ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
});

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeIdentified = Schema.decodeUnknownEffect(Identified);
const decodeInput = Schema.decodeUnknownEffect(InputInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);
const decodeTranscript = Schema.decodeUnknownEffect(TranscriptInput);
const decodeInputQuery = Schema.decodeUnknownEffect(InputQueryInput);
const decodeInputUpdate = Schema.decodeUnknownEffect(InputUpdate);
const decodeInputIdentified = Schema.decodeUnknownEffect(InputIdentified);
const decodeRespond = Schema.decodeUnknownEffect(RespondInput);
const encodeSpec = Schema.encodeUnknownSync(SessionSpec);
const decodeSpec = Schema.decodeUnknownEffect(SessionSpec);

/** Newest first: a session list is read as a history. */
const DEFAULT_DIRECTION: SortDirection = "desc";

/** Oldest first: a transcript is read forwards, the way it happened. */
const TRANSCRIPT_DIRECTION: SortDirection = "asc";

/** Oldest first: the order the caller sent them in is the order they leave in. */
const INPUT_DIRECTION: SortDirection = "asc";

/**
 * How long the controller waits for a runner to say what it did with an input.
 * Long enough for a harness to take a message, short enough that a caller
 * blocked on the answer is not left there.
 */
const SESSION_INPUT_DEADLINE: Duration.Duration = Duration.seconds(10);

/** Tests hand over a deadline they can wait out. */
export const SessionInputDeadline = Context.Reference<Duration.Duration>(
  "hydra/controller/sessions/SessionInputDeadline",
  { defaultValue: (): Duration.Duration => SESSION_INPUT_DEADLINE },
);

const NO_SUCH_SESSION = "no such session";

const HAS_EXITED = "that session has exited";

const GONE = "that session's runner is no longer connected";

const NO_SUCH_INPUT = "no such input on that session";

const ALREADY_SENT = "that input has already gone to the machine";

const NOT_WAITING =
  "that input is no longer waiting: it was sent, delivered or cancelled in the meantime";

const REFUSED = "that session's runner would not take the input";

const NOT_BUSY = "only a busy session can be steered";

const STEERING_UNSUPPORTED =
  "that session's provider does not support steering into a running turn";

const STILL_LIVE = "that session is still live; stop it first";

const NO_OPEN_REQUEST = "that session is not waiting on a decision";

/**
 * The harness has moved on: the request this answer names is not the one it is
 * parked on, so applying it would answer a question nobody asked.
 */
const STALE_REQUEST = "that request is not the one this session is waiting on";

/**
 * The one way an exited session can be past resuming that is not about its
 * machine: it never reported a provider-native session, so there is no
 * transcript left anywhere to pick up.
 */
const NO_TRANSCRIPT =
  "that session left no provider-native session, so its transcript is gone and there is " +
  "nothing to resume";

/** Why a queued input never left, written on the row when its session ends. */
const exitedWith = (reason: string): string =>
  `that session's harness exited (${reason}) before this input was sent`;

/**
 * Both ways an input can fail to reach the harness - no connection, and no
 * answer in time - read the same to a caller, and put the row back to
 * waiting for the next transition to idle, or a hand steer, to try again.
 */
const NOT_DELIVERED =
  "that session's runner did not take the input; it stays queued for the next turn";

/** Why a thread cannot be picked up again: the files it worked in are gone. */
const workspaceGone = (status: string): string =>
  `that session's workspace is ${status}, so there is nothing left to resume it in`;

/**
 * Where the provider-native id rides on the event that announces the harness.
 * The key is `SessionBinding`'s own field name, because it is the same fact.
 * An event that carries none leaves the id null until the next sessions report.
 */
const nativeIdIn = (event: ProviderEvent): string | undefined =>
  event._tag === "session.started" ? event.providerRefs?.nativeSessionId : undefined;

/** How long a sidebar row's title may run before it is cut. */
const MAX_TITLE_LENGTH = 80;

/**
 * A short label for a session, read off its opening prompt rather than typed
 * separately: the first line that is not blank, trimmed and capped, so a
 * sidebar row has something to show without reading the transcript.
 */
const titleOf = (prompt: string): string => {
  const line = prompt.split("\n").find((one) => one.trim().length > 0) ?? "";
  return line.trim().slice(0, MAX_TITLE_LENGTH);
};

type ReadError = Unauthenticated | Forbidden | Validation | SqlError;

type InputError = ReadError | NotFound | InvalidState | SettingError | Schema.SchemaError;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* sessionRepository;
  const inputs = yield* inputRepository;
  const workspaces = yield* WorkspaceService;
  const credentials = yield* gitCredentials;
  const instances = yield* providerRepository;
  const runners = yield* runnerRepository;
  const presence = yield* RunnerPresence;
  const tokens = yield* SessionTokens;
  const settings = yield* Settings;
  const resolved = yield* resolvedInstance;
  const audit = yield* AuditLog;

  /**
   * One session's ingest state: where its sequence stands and what delta text
   * is held for it. Process memory - a restart re-reads the sequence from the
   * rows and holds nothing. An entry is dropped when the session exits, so a
   * session whose machine vanished holds one until the restart reconciliation
   * of spec 06 section 4.1, which this build does not have.
   */
  const tracking = new Map<string, Tracked>();

  const one = (id: string): Effect.Effect<StoredSession, NotFound | SqlError> =>
    Effect.flatMap(
      sessions.one(id),
      Option.match({
        onNone: () => Effect.fail(notFound(NO_SUCH_SESSION)),
        onSome: Effect.succeed,
      }),
    );

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
   * The input a caller may still act on: one this session holds, one that has
   * not left or been called off already, and one that is not on the wire this
   * moment - a row the machine already has cannot be taken back, and saying it
   * was would be the worst thing this operation could tell anyone.
   */
  const queuedInput = (
    sessionId: string,
    inputId: string,
  ): Effect.Effect<StoredInput, NotFound | InvalidState | SqlError> =>
    Effect.gen(function* () {
      const found = yield* inputs.one(sessionId, inputId);
      if (Option.isNone(found)) return yield* Effect.fail(notFound(NO_SUCH_INPUT));
      if (found.value.status !== "queued") {
        return yield* Effect.fail(invalidState(`that input was already ${found.value.status}`));
      }
      if (found.value.sentAt !== null) return yield* Effect.fail(invalidState(ALREADY_SENT));
      return found.value;
    });

  /**
   * Whether the one machine holding a session's native state can still run its
   * instance: the stored snapshot's word, asked of that machine rather than of
   * the fleet, because the transcript is only where it already is.
   */
  const requireLoggedInOn = (
    instanceId: string,
    runnerId: string,
  ): Effect.Effect<void, InvalidState | SqlError | Schema.SchemaError> =>
    Effect.gen(function* () {
      const snapshots = yield* instances.snapshotsOf(instanceId);
      if (!snapshots.some((one) => loggedIn(one) && one.runnerId === runnerId)) {
        return yield* Effect.fail(invalidState(NO_PLACEMENT));
      }
    });

  /**
   * The one gate onto a session's transcript - resuming it in place, or forking
   * off it - and the provider-native session that comes out of it. Each refusal
   * names its own reason (spec 06 section 5): the session is still live, the
   * transcript is gone, or the machine is - retired, on its way out and taking
   * no new placement even though the transcript is still there, or no longer
   * logged in to the instance the session runs against.
   */
  const resumableNativeSession = (
    session: StoredSession,
  ): Effect.Effect<string, InvalidState | SqlError | Schema.SchemaError> =>
    Effect.gen(function* () {
      if (session.status !== "exited") return yield* Effect.fail(invalidState(STILL_LIVE));
      if (session.nativeSessionId === null) return yield* Effect.fail(invalidState(NO_TRANSCRIPT));
      if (!session.resumable) {
        // A thread's transcript is keyed to the working area it ran in, so a
        // workspace that is gone is a session that cannot be picked up - and
        // the user needs to read which one it was, not a word about machines.
        const status =
          session.workspaceId === null
            ? undefined
            : yield* workspaces.statusOf(session.workspaceId);
        if (status !== undefined && status !== "ready") {
          return yield* Effect.fail(invalidState(workspaceGone(status)));
        }
        return yield* Effect.fail(invalidState(RETIRED));
      }
      // `resumable` says the transcript is still there; this says the machine
      // will not open it. Whether it can be reached right now is dispatch's to
      // decide: unreachable queues the session rather than refusing it.
      const machine = yield* runners.read(session.runnerId);
      if (Option.isSome(machine) && machine.value.lifecycle !== "active") {
        return yield* Effect.fail(invalidState(DRAINING));
      }
      yield* requireLoggedInOn(session.instanceId, session.runnerId);
      return session.nativeSessionId;
    });

  /**
   * Sends one stored input to the machine holding the session and waits for the
   * machine to say what it did with it. `none` where there is no connection or
   * nothing came back in time; the wait is outside any transaction. The caller
   * has already claimed the row before this runs.
   *
   * The session's current model rides every frame: only the adapter knows
   * whether the input about to be sent opens a turn, which is the only moment
   * a harness will take a model change.
   */
  const deliverTo = (
    runnerId: string,
    row: StoredInput,
    modelSelection: ModelSelection,
  ): Effect.Effect<Option.Option<SessionInputResult>> =>
    Effect.gen(function* () {
      const deadline = yield* SessionInputDeadline;
      const answer = yield* presence.asked(
        runnerId,
        {
          _tag: "sessionInput",
          requestId: row.id,
          sessionId: row.sessionId,
          input: { text: row.text, modelSelection },
        },
        deadline,
      );
      return Option.filter(
        answer,
        (one): one is SessionInputResult => one._tag === "sessionInputResult",
      );
    });

  const recordDelivery = (row: StoredInput, delivery: Delivery): Effect.Effect<void, SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        yield* inputs.delivered(row.id, delivery, yield* nowIso);
        yield* announce({ _tag: "record", topic: "session", id: row.sessionId, kind: "updated" });
      }),
    );

  /**
   * Settles a row a delivery could not finish: back to waiting with the
   * reason, or cancelled if the session exited meanwhile. Read inside this
   * transaction so it serializes with `session.exited`'s own write.
   */
  const settleFailure = (row: StoredInput, reason: string): Effect.Effect<void, SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const now = yield* sessions.one(row.sessionId);
        if (Option.isSome(now) && now.value.status === "exited") {
          yield* inputs.cancelWithReason(row.id, reason);
        } else {
          yield* inputs.requeue(row.id, reason);
        }
        yield* announce({ _tag: "record", topic: "session", id: row.sessionId, kind: "updated" });
      }),
    );

  /**
   * Sends a row that is already claimed - on the wire, `sent_at` set - and
   * settles what became of it: a delivery the machine reports is recorded and
   * handed back; a refusal or silence is left where `settleFailure` puts it,
   * and fails with the same reason. The idle path, a steer and the flush all
   * reach the machine through this and nothing else does.
   *
   * The model is read here, after the row is claimed, rather than earlier by
   * the caller: a `session.update` landing between the caller's own read and
   * the claim would otherwise ride a frame it never applied to.
   */
  const deliverClaimed = (
    runnerId: string,
    row: StoredInput,
  ): Effect.Effect<SessionInputOutcome, InvalidState | NotFound | SqlError> =>
    Effect.gen(function* () {
      const session = yield* one(row.sessionId);
      const answer = yield* deliverTo(runnerId, row, session.modelSelection);
      const delivery = Option.isSome(answer) && answer.value.ok ? answer.value.delivery : undefined;
      if (delivery !== undefined) {
        yield* recordDelivery(row, delivery);
        return { inputId: row.id, result: delivery };
      }
      const reason = Option.isSome(answer) ? (answer.value.message ?? REFUSED) : NOT_DELIVERED;
      yield* settleFailure(row, reason);
      return yield* Effect.fail(invalidState(reason));
    });

  /**
   * Sends what one transition to idle releases: the oldest row still waiting,
   * claimed the instant this finds it, so a second transition landing before
   * the machine answers cannot also take it - the claim is what a row's turn
   * actually was for, so there is no boundary to count and nothing to catch
   * up on. A refusal or silence is left where `deliverClaimed` puts it: back
   * to waiting, for the next transition to send.
   */
  const flush = (sessionId: string, runnerId: string): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const next = yield* inputs.oldestWaiting(sessionId);
      if (Option.isNone(next)) return;
      const claimed = yield* inputs.claim(next.value.id, yield* nowIso);
      if (Option.isNone(claimed)) return;
      yield* Effect.catchIf(
        deliverClaimed(runnerId, claimed.value),
        (error): error is InvalidState | NotFound =>
          error instanceof InvalidState || error instanceof NotFound,
        () => Effect.void,
      );
    });

  /**
   * A driver must not stop on one item, so the cause is logged and dropped - a
   * defect as much as a failure, because a bug applying one report would
   * otherwise take the driver down for the life of the process, silently and for
   * the whole fleet. An interruption is the driver being stopped, and is passed
   * on.
   */
  const absorbing = (
    what: string,
    effect: Effect.Effect<void, SqlError>,
  ): Effect.Effect<void, SqlError> =>
    Effect.catchCause(effect, (cause) =>
      Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.logError(what, cause),
    );

  /**
   * The tail of any move to `exited`: queued inputs cancelled, the session's
   * token forgotten, one announce per session. A reason is written on the rows
   * where the machine gave one.
   */
  const ending = (ids: ReadonlyArray<string>, reason?: string): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        ids,
        (id) =>
          Effect.gen(function* () {
            yield* inputs.cancelQueued(id, reason);
            yield* announce({ _tag: "record", topic: "session", id, kind: "updated" });
          }),
        { discard: true },
      );
      // The row's status is what refuses the token from here on; this drops
      // only what was resolved from it while the session was still running.
      // After the commit, so a call in flight cannot cache the old row again
      // between the drop and the write becoming visible.
      yield* afterCommit(() => {
        tokens.forgetSessions(ids);
      });
    });

  /**
   * Applies a runner's report of what it holds: records the native id each
   * binding gives, then ends whatever this runner is still believed to run
   * that the report leaves out - a restart's report is the only place that
   * gap shows, since an unannounced disconnect tells the controller nothing.
   * One transaction, so a caller's dispatch outside it always sees the
   * settled result.
   *
   * Marks the connection caught up once that transaction commits, after
   * everything else: a `Map` does not roll back, so a runner is not
   * dispatchable on a report that never landed, and the mark has to be the
   * report's own last word rather than something a later step could still
   * undo.
   */
  const bound = (
    runnerId: string,
    connection: Connection,
    bindings: ReadonlyArray<SessionBinding>,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      yield* withTransaction(
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
          // `ending` is the whole revocation: the rows moved to `exited`, which
          // is what refuses their tokens, and what was cached from them while
          // they ran is dropped after the commit.
          yield* ending(gone);
          yield* Effect.forEach(
            gone,
            (id) =>
              audit.append({
                kind: "session.reconciled",
                actor: SYSTEM_ACTOR,
                record: { topic: "session" as const, id },
                payload: { sessionId: id, runnerId, reason: "runner_restart" },
                at,
              }),
            { discard: true },
          );
        }),
      );
      yield* presence.markSessionsReported(runnerId, connection);
    });

  /**
   * The GitHub account a session starts with: the token it pushes with and the
   * identity it commits as. A connection that will not answer is logged and
   * left out - a session starting without `GH_TOKEN` is better than one that
   * does not start.
   */
  const githubAccountOf = (connectionId: string): Effect.Effect<GitCredential | undefined> =>
    Effect.map(
      Effect.catchCause(
        credentials.credentialOf(connectionId),
        (cause): Effect.Effect<Option.Option<GitCredential>> =>
          Effect.as(
            Effect.logError("A session's GitHub connection could not be read", cause),
            Option.none(),
          ),
      ),
      Option.getOrUndefined,
    );

  /**
   * Moves this runner's oldest queued sessions to `starting`, as many as its
   * cap and its disk watermark allow, and tells the machine to start each. A
   * start the machine does not take goes back to the queue in its own
   * transaction, for the next thing that changes this runner's capacity to
   * try again.
   */
  const dispatch = (runnerId: string): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const ready = yield* withTransaction(
        sql,
        Effect.gen(function* () {
          const found = yield* runners.read(runnerId);
          if (Option.isNone(found)) return [];
          const runner = found.value;
          if (runner.connectivity !== "online" || runner.lifecycle !== "active") return [];
          // Online says the socket is up, not that this connection has said
          // what it holds yet: a start sent before its report lands would be
          // one this report itself then reads as exited.
          if (!(yield* presence.hasReportedSessions(runnerId))) return [];
          const watermark = runner.watermark;
          // A watermark nobody has reported yet is not a machine that said no.
          if (watermark !== null && watermark.diskFreeBytes < runner.diskWatermarkBytes) return [];
          const room = runner.maxConcurrentSessions - (yield* runners.runningSessions(runnerId));
          if (room <= 0) return [];
          const queued = yield* sessions.oldestQueued(runnerId, room);
          const at = yield* nowIso;
          const starting: Array<(typeof queued)[number] & { readonly token: string }> = [];
          for (const row of queued) {
            // The session's own credential on the public API, minted for this
            // start and stored as its hash with the move that licenses it: a
            // session is reachable exactly while the row says it is running.
            // A resume comes back through here, so the token it starts under
            // replaces the one the previous process held.
            const token = mintToken();
            yield* sessions.started(row.id, hashToken(token), at);
            yield* announce({ _tag: "record", topic: "session", id: row.id, kind: "updated" });
            starting.push({ ...row, token });
          }
          return starting;
        }),
      );
      for (const row of ready) {
        // Read now rather than stored: a token is never written down anywhere
        // but the frame that carries it to the machine.
        const account =
          row.githubConnectionId === null
            ? undefined
            : yield* githubAccountOf(row.githubConnectionId);
        const start: SessionStart = {
          _tag: "sessionStart",
          sessionId: row.id,
          providerId: row.providerId,
          config: row.config as Schema.Json,
          // A defect, not a typed failure: the document was encoded by this
          // same codec at insert, so a decode failure means a spec field's
          // codec changed underneath a row already queued with the old one.
          spec: yield* Effect.orDie(decodeSpec(JSON.parse(row.spec))),
          token: row.token,
          ...(account === undefined
            ? {}
            : { ghToken: account.token, gitIdentity: gitIdentityOf(account.login) }),
          ...(row.checkoutBranch === null ? {} : { checkoutBranch: row.checkoutBranch }),
        };
        if (!(yield* presence.tell(runnerId, start))) {
          yield* withTransaction(
            sql,
            Effect.gen(function* () {
              yield* sessions.moved(row.id, "queued", yield* nowIso);
              // The token went out on a frame nobody took, so nothing holds it:
              // a queued session is one nothing may call the API as. Forgotten
              // after the commit, like any other drop, so a call in flight
              // cannot cache the old row again before the write is visible.
              yield* sessions.setTokenHash(row.id, null);
              yield* afterCommit(() => {
                tokens.forgetSessions([row.id]);
              });
              yield* announce({ _tag: "record", topic: "session", id: row.id, kind: "updated" });
            }),
          );
        }
      }
    });

  /**
   * Ends every session a runner still holds open, the same way any other
   * move to `exited` does: queued inputs cancelled, one announce per session.
   * Runs in the caller's transaction, joining it as a savepoint. The ids of
   * what was `starting`, `idle` or `busy` come back too, so a caller ending
   * the runner itself can still tell the machine to stop each before it lets
   * go of the connection.
   */
  const endOnRunner = (runnerId: string): Effect.Effect<ReadonlyArray<string>, SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const at = yield* nowIso;
        const { ended, toStop } = yield* sessions.endOnRunner(runnerId, at);
        yield* ending(ended);
        yield* Effect.forEach(
          ended,
          (id) =>
            audit.append({
              kind: "session.stopped",
              actor: SYSTEM_ACTOR,
              payload: { sessionId: id, runnerId, reason: "runner_retired" },
              at,
            }),
          { discard: true },
        );
        return toStop;
      }),
    );

  /**
   * Ends every session waiting on a workspace that could not be made. They
   * never started, so there is no harness to stop and nothing to tell the
   * machine; what the user needs is the reason, which is the machine's own
   * words, recorded on the session's own stream where the exit is read.
   */
  const endForWorkspace = (
    workspaceId: string,
    message: string | null,
  ): Effect.Effect<void, SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const at = yield* nowIso;
        const waiting = yield* sessions.liveInWorkspace(workspaceId);
        for (const id of waiting) {
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
          yield* sessions.moved(id, "exited", at);
          yield* audit.append({
            kind: "session.stopped",
            actor: SYSTEM_ACTOR,
            payload: { sessionId: id, workspaceId, reason: "workspace_failed" },
            at,
          });
          // The exit is a row on this session's own stream, so whoever is
          // watching that session has to be told about that session.
          yield* announce({ _tag: "transcript", sessionId: id });
        }
        yield* ending(waiting, message ?? undefined);
      }),
    );

  const reported = (
    runnerId: string,
    seq: number,
    event: ProviderEvent,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const id = event.sessionId;
      const found = yield* sessions.one(id);
      // A machine speaks only for the sessions placed on it; anything else is a
      // runner reporting about a session that is not its to report.
      if (Option.isNone(found) || found.value.runnerId !== runnerId) return;
      const before = found.value.status;
      const held = tracking.get(id) ?? track(yield* sessions.ingestState(id));
      const folded = fold(held, seq, event);
      if (folded === undefined) return;
      // What this event does to the open request, or `undefined` for nothing.
      // An event reaching a session that has already exited never parks it
      // again.
      const open = found.value.openRequest;
      const park = before === "exited" ? undefined : openRequestAfter(event, open);
      // Ahead of the transaction that may or may not follow, and never inside
      // one: a delta is not written until it flushes, but a watched session's
      // tap has to see it the instant it is reported, coalesced row or not.
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
      const moved = yield* withTransaction(
        sql,
        Effect.gen(function* () {
          const at = yield* nowIso;
          for (const row of folded.rows) yield* sessions.append(id, row);
          if (folded.rows.length > 0) {
            yield* announce({ _tag: "transcript", sessionId: id });
          }
          // A session starting or ending is work in its workspace, which is
          // what keeps that workspace from expiring under it.
          if (
            found.value.workspaceId !== null &&
            (event._tag === "session.started" || event._tag === "session.exited")
          ) {
            yield* workspaces.touched(found.value.workspaceId, at);
          }
          // Written with the move the same event causes: a session that reads
          // `idle` has the provider-native id that made it so.
          const native = nativeIdIn(event);
          if (native !== undefined) {
            yield* sessions.bind(id, runnerId, found.value.instanceId, native);
          }
          if (park !== undefined) yield* sessions.setOpenRequest(id, park);
          // `exited` is final (spec 06 section 4.1), so a stray event after it
          // is still recorded but never brings the session back to life.
          if (folded.status === undefined || folded.status === before || before === "exited") {
            // No announce: an event that moves nothing is most of the traffic,
            // and a refetch per delta would be a firehose. A request opening or
            // closing is the exception - it moves no status and the user has to
            // see the card.
            yield* sessions.touched(id, at);
            if (park !== undefined) {
              yield* announce({ _tag: "record", topic: "session", id, kind: "updated" });
            }
            return undefined;
          }
          yield* sessions.moved(id, folded.status, at);
          if (event._tag === "session.exited") {
            // Nothing waits on a harness that is gone, so the queue goes with it.
            yield* ending([id], exitedWith(event.reason));
          } else {
            yield* announce({ _tag: "record", topic: "session", id, kind: "updated" });
          }
          return folded.status;
        }),
      );
      // Only once it is durable: a failed transaction leaves the held text and
      // the sequence where they were, and nothing resends the frame, because
      // there is no outbox yet (spec 03 section 2.3).
      //
      // Dropped on the transition and on anything after it: an event reaching
      // an already-exited session would otherwise put its entry back for good.
      if (folded.status === "exited" || before === "exited") {
        tracking.delete(id);
      } else {
        tracking.set(id, folded.next);
      }
      // Forked, because a flush waits on the runner and the ingest is one fiber
      // for the whole fleet: waiting inline would stall every other session's
      // events for the deadline.
      if (moved === "idle") {
        yield* Effect.forkChild(
          absorbing("A session's queued input could not be sent", flush(id, runnerId)),
        );
      }
      // Forked for the same reason: dispatch writes to the runner's socket,
      // and the ingest is one fiber for the whole fleet.
      if (moved === "exited") {
        yield* Effect.forkChild(
          absorbing("A freed slot could not be dispatched", dispatch(runnerId)),
        );
      }
    });

  const applying = (traffic: SessionTraffic): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      if (traffic.frame._tag !== "sessionsReport") {
        yield* reported(traffic.runnerId, traffic.frame.seq, traffic.frame.event);
        return;
      }
      yield* bound(traffic.runnerId, traffic.connection, traffic.frame.sessions);
      // Forked for the same reason a freed slot's dispatch is: it writes to
      // the runner's socket, and the ingest is one fiber for the whole fleet.
      yield* Effect.forkChild(
        absorbing("A runner's report could not be dispatched", dispatch(traffic.runnerId)),
      );
    });

  return {
    query: (input: QueryInput): Effect.Effect<SessionPage, ReadError> =>
      Effect.gen(function* () {
        yield* requireGrant("session.query");
        const { limit, cursor, sort, status, runnerId } = yield* Effect.mapError(
          decodeQuery(input),
          validationOf,
        );
        const listing = yield* refuseCursor(
          sessions.list({
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: sort?.direction ?? DEFAULT_DIRECTION,
            status,
            runnerId,
          }),
        );
        return pageOut(listing);
      }),

    read: (input: Identified): Effect.Effect<Session, ReadError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("session.read");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        return yield* one(id);
      }),

    /**
     * The session's normalized stream, in position order (spec 11 section 2).
     * The session is read first so a just-placed session with no rows yet is
     * told apart from one that does not exist.
     */
    transcript: (input: TranscriptInput): Effect.Effect<TranscriptPage, ReadError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("transcript.read");
        const { id, limit, cursor, sort } = yield* Effect.mapError(
          decodeTranscript(input),
          validationOf,
        );
        yield* one(id);
        const listing = yield* refuseCursor(
          sessions.transcript({
            sessionId: id,
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: sort?.direction ?? TRANSCRIPT_DIRECTION,
          }),
        );
        return pageOut(listing);
      }),

    /**
     * The row, its first input and the entry that records it, joining the
     * caller's transaction: what the controller daemon settled is written down
     * here and nowhere else. It always lands `queued` - whether this runner has
     * room for it right now is dispatch's decision, and it is the same decision
     * either way, so a fresh row takes it rather than a copy of it.
     */
    create: (open: Opening): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const actor = yield* currentStamp;
        const row = yield* sessions.insert({
          id: open.id,
          title: titleOf(open.prompt),
          permissionProfileId: open.permissionProfileId,
          instanceId: open.spec.instanceId,
          runnerId: open.runnerId,
          workspaceId: open.spec.workspaceId,
          projectId: open.projectId,
          checkoutBranch: open.checkoutBranch,
          githubConnectionId: open.githubConnectionId,
          requestedAccessMode: open.requestedAccessMode,
          accessMode: open.spec.accessMode,
          // Byte for byte: the row holds the exact document the runner is
          // told, not a re-encode of an object that resembles it.
          spec: JSON.stringify(encodeSpec(open.spec)),
          modelSelection: open.spec.modelSelection,
          parentSessionId: open.parentSessionId,
          at: open.at,
        });
        // The prompt is an ordinary input, waiting with the session: it
        // leaves when the harness comes up, and a controller restarted in
        // that window still has it.
        yield* inputs.insert({
          sessionId: row.id,
          source: "user",
          actor,
          text: open.prompt,
          at: open.at,
        });
        yield* audit.append({
          kind: open.kind,
          actor,
          record: { topic: "session", id: row.id },
          payload: {
            ...open.payload,
            sessionId: row.id,
            ...(open.spec.workspaceId === null ? {} : { workspaceId: open.spec.workspaceId }),
          },
          at: open.at,
        });
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
            yield* sessions.setModelSelection(id, modelSelection);
            yield* announce({ _tag: "record", topic: "session", id, kind: "updated" });
            return { ...session, modelSelection };
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
            yield* sessions.setModelSelection(id, modelSelection);
            if (nativeSessionId !== undefined) {
              const spec = continuingSpecOf(
                session,
                yield* settings.all(),
                modelSelection,
                nativeSessionId,
                "resume",
              );
              yield* sessions.resume(id, JSON.stringify(encodeSpec(spec)), at);
            }
            const created = yield* inputs.insert({
              sessionId: id,
              source: "user",
              actor: yield* currentStamp,
              text,
              at,
              ...(session.status === "idle" ? { sentAt: at } : {}),
            });
            yield* announce({ _tag: "record", topic: "session", id, kind: "updated" });
            return { session, row: created };
          }),
        );
        if (session.status === "exited") {
          // The resumed process numbers its events from the start, so what the
          // stored stream reached is not what they are judged against.
          tracking.delete(id);
          // Outside the transaction: dispatch may tell the machine, and a
          // transaction never spans a wait on anything outside the database.
          yield* dispatch(session.runnerId);
        }
        if (session.status !== "idle") return { inputId: row.id, result: "queued" };
        return yield* deliverClaimed(session.runnerId, row);
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
        const row = yield* queuedInput(id, inputId);
        if (session.status !== "busy") return yield* Effect.fail(invalidState(NOT_BUSY));
        const { definition } = yield* resolved(session.instanceId);
        if (definition.declared.steering !== "native") {
          return yield* Effect.fail(invalidState(STEERING_UNSUPPORTED));
        }
        // The claim is the guard against a second steer, or the flush, taking
        // the same row: only one caller's conditional update finds it still
        // waiting, whatever `queuedInput` read a moment ago - and its own
        // answer, not that stale read, is what gets sent, in case a rewrite
        // landed in between.
        const claimed = yield* inputs.claim(row.id, yield* nowIso);
        if (Option.isNone(claimed)) return yield* Effect.fail(invalidState(NOT_WAITING));
        return yield* deliverClaimed(session.runnerId, claimed.value);
      }),

    /**
     * Ends the turn the session is running. Fire and forget: what became of the
     * turn arrives in the session's own stream as `turn.completed`, so there is
     * nothing to wait for here.
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
        if (
          !(yield* presence.tell(session.runnerId, { _tag: "sessionInterrupt", sessionId: id }))
        ) {
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
        return session;
      }),

    /**
     * Answers the request the session's harness is parked on. Fire and forget
     * like the interrupt above.
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
          !(yield* presence.tell(session.runnerId, {
            _tag: "sessionRespond",
            sessionId: id,
            requestId,
            decision,
          }))
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
        return session;
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
              yield* sessions.moved(id, "exited", at);
              yield* ending([id]);
              yield* audit.append({
                kind: "session.stopped",
                actor: yield* currentStamp,
                payload: { sessionId: id, runnerId: session.runnerId },
                at,
              });
              return { ...session, status: "exited" as const, exitedAt: at };
            }),
          );
        }
        if (!(yield* presence.tell(session.runnerId, { _tag: "sessionStop", sessionId: id }))) {
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
        return session;
      }),

    /** Every input this session was ever given, oldest first, whatever became of each. */
    queryInputs: (input: InputQueryInput): Effect.Effect<InputPage, ReadError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("input.query");
        const { id, limit, cursor, sort } = yield* Effect.mapError(
          decodeInputQuery(input),
          validationOf,
        );
        yield* one(id);
        const listing = yield* refuseCursor(
          inputs.list({
            sessionId: id,
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: sort?.direction ?? INPUT_DIRECTION,
          }),
        );
        return pageOut(listing);
      }),

    updateInput: (input: InputUpdate): Effect.Effect<Input, InputError> =>
      Effect.gen(function* () {
        yield* requireGrant("input.update");
        const { id, inputId, text } = yield* Effect.mapError(
          decodeInputUpdate(input),
          validationOf,
        );
        yield* one(id);
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

    cancelInput: (input: InputIdentified): Effect.Effect<Input, InputError> =>
      Effect.gen(function* () {
        yield* requireGrant("input.cancel");
        const { id, inputId } = yield* Effect.mapError(decodeInputIdentified(input), validationOf);
        yield* one(id);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const row = yield* queuedInput(id, inputId);
            yield* inputs.cancel(inputId);
            yield* announce({ _tag: "record", topic: "session", id, kind: "updated" });
            return { ...row, status: "cancelled" as const };
          }),
        );
      }),

    /**
     * The ingest driver. One fiber, so a session's events are applied in the
     * order the machine numbered them; each absorbs its own failure, because
     * one report that will not write must not stop the fleet's traffic.
     */
    ingesting: Stream.runForEach(presence.sessionTraffic, (traffic) =>
      absorbing("A session report could not be recorded", applying(traffic)),
    ),

    /**
     * Whether this row's transcript can be picked up again, and the
     * provider-native session to pick up: the gate the controller daemon puts a
     * fork through, and `session.input` a resume.
     */
    resumableNativeSession,

    /**
     * Starts what this runner now has room for. What gave it that room - a
     * watermark crossed, a cap raised, a drain lifted - is the fleet's to
     * report and the controller daemon's to act on.
     */
    dispatch,

    /** Reached when a machine is retired, which ends the sessions it was hosting. */
    endOnRunner,

    /**
     * What a machine's report about a workspace means for the sessions waiting
     * on it: one that came up releases them, and one that could not be made ends
     * them with the machine's own words for why. Called by the controller
     * daemon - so neither domain has to reach into the other.
     */
    workspaceSettled: (
      runnerId: string,
      settled: { readonly workspaceId: string; readonly moved: "ready" | "failed" | "deleted" },
      message: string | null,
    ): Effect.Effect<void, SqlError> =>
      settled.moved === "ready"
        ? dispatch(runnerId)
        : settled.moved === "failed"
          ? endForWorkspace(settled.workspaceId, message)
          : Effect.void,
  };
});

export class SessionService extends Context.Service<SessionService, Effect.Success<typeof make>>()(
  "hydra/controller/sessions/SessionService",
) {}

export const SessionServiceLayer: Layer.Layer<
  SessionService,
  never,
  | SqlClient.SqlClient
  | RunnerPresence
  | PluginHost
  | AuditLog
  | Settings
  | SessionTokens
  | Secrets
  | WorkspaceService
> = Layer.effect(SessionService)(make);

/**
 * `inputRepository.cancelStranded`, run once at boot rather than folded into
 * `SessionServiceLayer`'s own construction: the boot builds every service's
 * layer before it runs a migration, so a query against a column a fresh
 * database does not have yet would fail there. Called explicitly, after
 * migrations and before anything is placed on a runner.
 */
export const cancelStrandedInputs: Effect.Effect<void, SqlError, SqlClient.SqlClient> =
  Effect.flatMap(inputRepository, (inputs) =>
    inputs.cancelStranded(
      "the controller restarted while this input was on its way to the runner; " +
        "whether the harness took it is unknown",
    ),
  );
