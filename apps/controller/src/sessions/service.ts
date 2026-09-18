/**
 * Sessions as the API sees them: the row, its lifecycle, the inputs waiting on
 * it and the stream it leaves behind.
 *
 * A session is written here from a spec that is already settled, and what a
 * machine reports about one is turned into rows here. Nothing here reaches a
 * machine: what a thread runs, where it runs, what it is told and what is done
 * about what it says are the controller daemon's, a layer up. The methods this
 * service holds for it are row moves, and they say what is left to do rather
 * than doing it.
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
  type Delivery,
  type ModelSelection,
  type OpenRequest,
  type ProviderEvent,
  type SessionBinding,
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
  TRANSCRIPT_SORT_FIELDS,
  validationOf,
  type Forbidden,
  type Input,
  type Session,
  type SessionStatus,
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
import { inputRepository, type StoredInput } from "./inputs";
import {
  requireSession,
  sessionRepository,
  type QueuedSession,
  type StoredSession,
} from "./repository";
import { fold, openRequestAfter, track, type Folded, type Tracked } from "./stream";

const QueryInput = Schema.Struct({
  ...SessionFilter.fields,
  ...pageInput(SESSION_SORT_FIELDS),
});

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

const Identified = Schema.Struct({ id: Id });

export type Identified = Schema.Schema.Type<typeof Identified>;

const TranscriptInput = Schema.Struct({ id: Id, ...pageInput(TRANSCRIPT_SORT_FIELDS) });

export type TranscriptInput = Schema.Schema.Type<typeof TranscriptInput>;

const InputQueryInput = Schema.Struct({ id: Id, ...pageInput(INPUT_SORT_FIELDS) });

export type InputQueryInput = Schema.Schema.Type<typeof InputQueryInput>;

const InputUpdate = Schema.Struct({ id: Id, inputId: Id, ...INPUT_UPDATE_FIELDS });

export type InputUpdate = Schema.Schema.Type<typeof InputUpdate>;

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

/** A session claimed for a start, and the token the frame that starts it carries. */
export interface Starting extends QueuedSession {
  readonly token: string;
}

/** One input as it is stored, and what the session it lands on runs under. */
export interface Taking {
  readonly sessionId: string;
  /** What the session runs under from this input on. */
  readonly modelSelection: ModelSelection;
  /**
   * The encoded spec a session picking its own transcript up goes back on the
   * queue with; absent for an input to a session that is still live.
   */
  readonly resumeSpec: string | undefined;
  readonly text: string;
  readonly at: string;
  /**
   * Claims the row inside the insert, for an input reaching an idle session:
   * it goes on the wire the instant it exists, so nothing else may take it.
   */
  readonly claimed: boolean;
}

/**
 * One report, read against the session it names and folded against the stream
 * already stored: everything the write set needs, settled before a transaction
 * opens. It goes straight back into `applyReport` and is read by nobody else.
 */
export interface FoldedReport {
  /** The session as it read before the write set, which is what the fold judged. */
  readonly session: StoredSession;
  readonly folded: Folded;
  /** The open request this event leaves behind, or `undefined` to leave it alone. */
  readonly park: OpenRequest | null | undefined;
}

/**
 * What one session report leaves for the controller daemon to do once the rows
 * it caused are durable. Each of them reaches past the session's own rows -
 * to the working area it runs in, or to the machine hosting it - so none of
 * them is this domain's to do.
 */
export interface Applied {
  /** The session's working area saw work at this instant. */
  readonly worked?: { readonly workspaceId: string; readonly at: string };
  /** The status the row moved to, or `undefined` where this report moved it nowhere. */
  readonly moved: SessionStatus | undefined;
}

/** A listing as the contract hands it out: the cursor is a key, not a null. */
const pageOut = <A>(listing: Page<A>): { items: ReadonlyArray<A>; nextCursor?: string } => ({
  items: listing.items,
  ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
});

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeIdentified = Schema.decodeUnknownEffect(Identified);
const decodeTranscript = Schema.decodeUnknownEffect(TranscriptInput);
const decodeInputQuery = Schema.decodeUnknownEffect(InputQueryInput);
const decodeInputUpdate = Schema.decodeUnknownEffect(InputUpdate);
const decodeInputIdentified = Schema.decodeUnknownEffect(InputIdentified);
const encodeSpec = Schema.encodeUnknownSync(SessionSpec);

/** Newest first: a session list is read as a history. */
const DEFAULT_DIRECTION: SortDirection = "desc";

/** Oldest first: a transcript is read forwards, the way it happened. */
const TRANSCRIPT_DIRECTION: SortDirection = "asc";

/** Oldest first: the order the caller sent them in is the order they leave in. */
const INPUT_DIRECTION: SortDirection = "asc";

const NO_SUCH_INPUT = "no such input on that session";

const ALREADY_SENT = "that input has already gone to the machine";

/** Why a queued input never left, written on the row when its session ends. */
const exitedWith = (reason: string): string =>
  `that session's harness exited (${reason}) before this input was sent`;

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

type InputError = ReadError | NotFound | InvalidState | Schema.SchemaError;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* sessionRepository;
  const inputs = yield* inputRepository;
  const one = requireSession(sessions);
  const tokens = yield* SessionTokens;
  const audit = yield* AuditLog;

  /**
   * One session's ingest state: where its sequence stands and what delta text
   * is held for it. Process memory - a restart re-reads the sequence from the
   * rows and holds nothing. An entry is dropped when the session exits, so a
   * session whose machine vanished holds one until the restart reconciliation
   * of spec 06 section 4.1, which this build does not have.
   */
  const tracking = new Map<string, Tracked>();

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
     * Moves this runner's oldest queued sessions to `starting`, as many as the
     * caller found room for, and hands back what it takes to tell the machine
     * to start each. Joins the caller's transaction: a row is claimed here for
     * a frame that only goes out once that transaction has committed.
     */
    starting: (runnerId: string, room: number): Effect.Effect<ReadonlyArray<Starting>, SqlError> =>
      Effect.gen(function* () {
        const queued = yield* sessions.oldestQueued(runnerId, room);
        const at = yield* nowIso;
        const claimed: Array<Starting> = [];
        for (const row of queued) {
          // The session's own credential on the public API, minted for this
          // start and stored as its hash with the move that licenses it: a
          // session is reachable exactly while the row says it is running.
          // A resume comes back through here, so the token it starts under
          // replaces the one the previous process held.
          const token = mintToken();
          yield* sessions.started(row.id, hashToken(token), at);
          yield* announce({ _tag: "record", topic: "session", id: row.id, kind: "updated" });
          claimed.push({ ...row, token });
        }
        return claimed;
      }),

    /**
     * Puts back a session whose start no machine took. Its own transaction: the
     * one that claimed the row committed before the frame went out.
     */
    requeue: (sessionId: string): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          yield* sessions.moved(sessionId, "queued", yield* nowIso);
          // The token went out on a frame nobody took, so nothing holds it:
          // a queued session is one nothing may call the API as. Forgotten
          // after the commit, like any other drop, so a call in flight
          // cannot cache the old row again before the write is visible.
          yield* sessions.setTokenHash(sessionId, null);
          yield* afterCommit(() => {
            tokens.forgetSessions([sessionId]);
          });
          yield* announce({ _tag: "record", topic: "session", id: sessionId, kind: "updated" });
        }),
      ),

    /**
     * Ends a session that never reached a machine: nothing is told about it,
     * because it was never told about the session either. Joins the caller's
     * transaction, which is where the entry recording it is written too.
     */
    endQueued: (sessionId: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* sessions.moved(sessionId, "exited", at);
        yield* ending([sessionId]);
      }),

    /**
     * Ends every session a runner still holds open, the same way any other
     * move to `exited` does: queued inputs cancelled, one announce per session.
     * Runs in the caller's transaction, joining it as a savepoint. The ids of
     * what was `starting`, `idle` or `busy` come back too, so a caller ending
     * the runner itself can still tell the machine to stop each before it lets
     * go of the connection.
     */
    endOnRunner: (runnerId: string): Effect.Effect<ReadonlyArray<string>, SqlError> =>
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
      ),

    endForWorkspace,

    /**
     * What the session runs under from here on, joining the caller's
     * transaction. The stored `spec` is left alone: it is the document the
     * runner was started with, and a resume or a fork reads the session's own
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
     * Stores one turn's input, with what the session runs under from it on and,
     * for a session picking its own transcript up, the spec it goes back on the
     * queue with. Joins the caller's transaction, so a pick the model does not
     * offer rolls the whole thing back and leaves neither a rewritten selection
     * nor an input row behind.
     */
    takeInput: (taking: Taking): Effect.Effect<StoredInput, SqlError> =>
      Effect.gen(function* () {
        yield* sessions.setModelSelection(taking.sessionId, taking.modelSelection);
        if (taking.resumeSpec !== undefined) {
          yield* sessions.resume(taking.sessionId, taking.resumeSpec, taking.at);
          // The resumed process numbers its events from the start, so what the
          // stored stream reached is not what they are judged against. Dropped
          // once the resume is durable, like any other invalidation.
          yield* afterCommit(() => {
            tracking.delete(taking.sessionId);
          });
        }
        const created = yield* inputs.insert({
          sessionId: taking.sessionId,
          source: "user",
          actor: yield* currentStamp,
          text: taking.text,
          at: taking.at,
          ...(taking.claimed ? { sentAt: taking.at } : {}),
        });
        yield* announce({
          _tag: "record",
          topic: "session",
          id: taking.sessionId,
          kind: "updated",
        });
        return created;
      }),

    queuedInput,

    /**
     * Marks a row on the wire and hands back the row as the claim found it.
     * `none` where another caller - a second steer, a flush - took it first.
     */
    claimInput: (inputId: string): Effect.Effect<Option.Option<StoredInput>, SqlError> =>
      Effect.flatMap(nowIso, (at) => inputs.claim(inputId, at)),

    /**
     * Claims the oldest row still waiting on a session, the instant it is
     * found: what a row's turn was for is the claim, so a second caller
     * arriving before the machine answers cannot also take it.
     */
    claimOldest: (sessionId: string): Effect.Effect<Option.Option<StoredInput>, SqlError> =>
      Effect.gen(function* () {
        const next = yield* inputs.oldestWaiting(sessionId);
        if (Option.isNone(next)) return Option.none();
        return yield* inputs.claim(next.value.id, yield* nowIso);
      }),

    /** Records what the machine said it did with a row that reached it. */
    delivered: (row: StoredInput, delivery: Delivery): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          yield* inputs.delivered(row.id, delivery, yield* nowIso);
          yield* announce({ _tag: "record", topic: "session", id: row.sessionId, kind: "updated" });
        }),
      ),

    /**
     * Settles a row a delivery could not finish: back to waiting with the
     * reason, or cancelled if the session exited meanwhile. Read inside this
     * transaction so it serializes with the exit's own write.
     */
    undelivered: (row: StoredInput, reason: string): Effect.Effect<void, SqlError> =>
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
      ),

    /**
     * Applies a runner's report of what it holds: records the native id each
     * binding gives, then ends whatever this runner is still believed to run
     * that the report leaves out - a restart's report is the only place that
     * gap shows, since an unannounced disconnect tells the controller nothing.
     * One transaction, so a caller's dispatch outside it always sees the
     * settled result.
     */
    bound: (
      runnerId: string,
      bindings: ReadonlyArray<SessionBinding>,
    ): Effect.Effect<void, SqlError> =>
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
      ),

    /**
     * Reads one event a machine reported against the session it names and folds
     * it against the stream already stored. Nothing is written: what the write
     * set will do is settled here, before any transaction opens, and
     * `undefined` comes back where there is nothing to write.
     *
     * A delta's tap goes out from here, ahead of that transaction and never
     * inside one: a delta is not written until it flushes, but a watched
     * session's tap has to see it the instant it is reported, coalesced row or
     * not - and it is reported whether or not the write that follows lands.
     */
    foldReport: (
      runnerId: string,
      seq: number,
      event: ProviderEvent,
    ): Effect.Effect<FoldedReport | undefined, SqlError> =>
      Effect.gen(function* () {
        const id = event.sessionId;
        const found = yield* sessions.one(id);
        // A machine speaks only for the sessions placed on it; anything else is a
        // runner reporting about a session that is not its to report.
        if (Option.isNone(found) || found.value.runnerId !== runnerId) return undefined;
        const before = found.value.status;
        const held = tracking.get(id) ?? track(yield* sessions.ingestState(id));
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
        return {
          session: found.value,
          folded,
          // What this event does to the open request, or `undefined` for
          // nothing. An event reaching a session that has already exited never
          // parks it again.
          park: before === "exited" ? undefined : openRequestAfter(event, found.value.openRequest),
        };
      }),

    /**
     * The write set one folded report causes: its stream rows and the status
     * change they make commit together (spec 04 Truth model). It joins the
     * caller's transaction, so what the report means beyond this session's own
     * rows commits with it; what is left to do afterwards is handed back rather
     * than done here, because it reaches past those rows.
     */
    applyReport: (
      runnerId: string,
      event: ProviderEvent,
      report: FoldedReport,
    ): Effect.Effect<Applied, SqlError> =>
      Effect.gen(function* () {
        const { session, folded, park } = report;
        const id = session.id;
        const before = session.status;
        const at = yield* nowIso;
        for (const row of folded.rows) yield* sessions.append(id, row);
        if (folded.rows.length > 0) {
          yield* announce({ _tag: "transcript", sessionId: id });
        }
        // Written with the move the same event causes: a session that reads
        // `idle` has the provider-native id that made it so.
        const native = nativeIdIn(event);
        if (native !== undefined) {
          yield* sessions.bind(id, runnerId, session.instanceId, native);
        }
        if (park !== undefined) yield* sessions.setOpenRequest(id, park);
        // `exited` is final (spec 06 section 4.1), so a stray event after it
        // is still recorded but never brings the session back to life.
        const moved =
          folded.status === undefined || folded.status === before || before === "exited"
            ? undefined
            : folded.status;
        if (moved !== undefined) {
          yield* sessions.moved(id, moved, at);
          if (event._tag === "session.exited") {
            // Nothing waits on a harness that is gone, so the queue goes with it.
            yield* ending([id], exitedWith(event.reason));
          } else {
            yield* announce({ _tag: "record", topic: "session", id, kind: "updated" });
          }
        } else {
          // No announce: an event that moves nothing is most of the traffic,
          // and a refetch per delta would be a firehose. A request opening or
          // closing is the exception - it moves no status and the user has to
          // see the card.
          yield* sessions.touched(id, at);
          if (park !== undefined) {
            yield* announce({ _tag: "record", topic: "session", id, kind: "updated" });
          }
        }
        // Only once it is durable: a transaction that fails leaves the held
        // text and the sequence where they were, and nothing resends the frame,
        // because there is no outbox yet (spec 03 section 2.3).
        //
        // Dropped on the transition and on anything after it: an event reaching
        // an already-exited session would otherwise put its entry back for good.
        yield* afterCommit(() => {
          if (folded.status === "exited" || before === "exited") {
            tracking.delete(id);
          } else {
            tracking.set(id, folded.next);
          }
        });
        return {
          // A session starting or ending is work in its workspace, which is
          // what keeps that workspace from expiring under it.
          ...(session.workspaceId !== null &&
          (event._tag === "session.started" || event._tag === "session.exited")
            ? { worked: { workspaceId: session.workspaceId, at } }
            : {}),
          moved,
        };
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
  };
});

/**
 * Two kinds of method, and wiring one where the other belongs is a mistake
 * nothing else would catch.
 *
 * `query`, `read`, `transcript`, `queryInputs`, `updateInput` and `cancelInput`
 * are operations: each checks its own grant and decodes its own input, and a
 * route handler calls it directly. Everything else is a row move with no grant
 * of its own, reached only by the controller daemon, which has checked the
 * grant for the operation it is carrying out - putting one of those on a route
 * would serve it to anyone who can reach the API.
 */
export class SessionService extends Context.Service<SessionService, Effect.Success<typeof make>>()(
  "hydra/controller/sessions/SessionService",
) {}

export const SessionServiceLayer: Layer.Layer<
  SessionService,
  never,
  SqlClient.SqlClient | AuditLog | SessionTokens
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
