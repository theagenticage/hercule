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
  type SessionBinding,
  type SessionInput,
  type SessionInterrupt,
  type SessionRespond,
  type SessionStart,
  type SessionStop,
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
  withTransaction,
  type Page,
} from "../db";
import { mintToken, hashToken } from "../credentials";
import { AuditLog } from "../events";
import { SessionTokens } from "../permissions";
import type { SecretDecryptError } from "../secrets";
import { buildGitIdentity, type GitCredential } from "../workspaces";
import { inputRepository, type LostWakeUp, type NewMatchedInput, type StoredInput } from "./inputs";
import { sessionRecordComposer } from "./records";
import {
  readSessionOrFail,
  sessionRepository,
  type QueuePosition,
  type StoredSession,
} from "./repository";
import { fold, computeOpenRequestAfter, startTracking, type Folded, type Tracked } from "./stream";

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
export interface Opening {
  /**
   * Created by the caller, not by the insert. The workspace is opened in the
   * same transaction, and a thread's own worktree is created on a branch named
   * after the thread, so the id has to exist before either row does.
   */
  readonly id: string;
  readonly permissionProfileId: string;
  /** The Agent the session was spawned from; `undefined` for a Thread. */
  readonly agentId: string | undefined;
  readonly runnerId: string;
  readonly requestedAccessMode: AccessMode;
  readonly parentSessionId: string | undefined;
  /** The spec sent to the runner. The row's stored fields are taken from it. */
  readonly spec: SessionSpec;
  readonly prompt: string;
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
export interface Starting {
  readonly sessionId: string;
  readonly frame: SessionStart;
}

/**
 * The readers a start frame needs from outside this domain, passed in by the
 * caller. The controller daemon passes its own credential readers, so this
 * domain never reads a secret itself.
 */
export interface StartNeeds {
  readonly accountOf: (connectionId: string) => Effect.Effect<GitCredential | undefined>;
  /**
   * Returns the provider instance's credentials, decrypted for this frame and
   * stored nowhere. Fails when they cannot be decrypted, which skips the
   * session: a session started without its key would report that it is not
   * logged in.
   */
  readonly secretsOf: (
    instanceId: string,
    providerId: string,
  ) => Effect.Effect<Record<string, string>, SqlError | SecretDecryptError>;
}

/** One user input to store, and the model selection the session runs under from then on. */
export interface Taking {
  readonly sessionId: string;
  /** The model selection the session runs under from this input on. */
  readonly modelSelection: ModelSelection;
  /**
   * The encoded spec a resumed session goes back on the queue with, when the
   * input resumes an exited session; `undefined` for a session that is still
   * live.
   */
  readonly resumeSpec: string | undefined;
  readonly text: string;
  readonly at: string;
  /**
   * Claims the row in the insert, for an input sent to an idle session. The
   * input is sent as soon as it exists, so nothing else may claim it.
   */
  readonly claimed: boolean;
}

/**
 * One event reported by a runner, checked against its session and folded into
 * the stored stream. It holds everything the write needs, worked out before a
 * transaction opens. `foldReport` returns it and only `applyReport` reads it.
 */
export interface FoldedReport {
  /** The session as it was read before the write. The fold used this state. */
  readonly session: StoredSession;
  readonly folded: Folded;
  /** The open request after this event, or `undefined` to leave it unchanged. */
  readonly park: OpenRequest | null | undefined;
}

/**
 * What the controller daemon still has to do after a report's rows are
 * committed. Each item affects something outside the session's own rows, such
 * as its workspace or its runner, so this domain does not do it itself.
 */
export interface Applied {
  /** The session's workspace was used at this time. */
  readonly worked?: { readonly workspaceId: string; readonly at: string };
  /** The session's new status, or `undefined` when this report did not change it. */
  readonly moved: SessionStatus | undefined;
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

/** Why an input was cancelled on a session that `endOnLostRunners` ended. */
const RUNNER_LOST =
  "that session's runner was not heard from for longer than the session's absolute timeout, " +
  "so the session was ended before this input was sent";

/** Returns why a queued input was never sent. It is stored on the input when its session exits. */
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
 * Builds a short title for a session from its first prompt: the first
 * non-blank line, trimmed and cut to `MAX_TITLE_LENGTH`. That way a sidebar
 * row has something to show without reading the transcript.
 */
const buildTitle = (prompt: string): string => {
  const line = prompt.split("\n").find((one) => one.trim().length > 0) ?? "";
  return line.trim().slice(0, MAX_TITLE_LENGTH);
};

type ReadError = Unauthenticated | Forbidden | Validation | SqlError;

type InputError = ReadError | NotFound | InvalidState | Schema.SchemaError;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* sessionRepository;
  const recordComposer = yield* sessionRecordComposer;
  const inputs = yield* inputRepository;
  const one = readSessionOrFail(sessions);
  const tokens = yield* SessionTokens;
  const audit = yield* AuditLog;

  /**
   * Each session's ingest state: its last sequence number and the delta text
   * held for it. This lives in memory only. After a restart the sequence is
   * read again from the rows, and no text is held. An entry is removed when
   * the session exits, whatever ends it.
   */
  const tracking = new Map<string, Tracked>();

  /**
   * Puts an exited session back on the queue, with the spec that resumes its
   * own transcript. Joins the caller's transaction. Returns whether the
   * session was moved: `false` means another caller already put it back, and
   * there is nothing left to do.
   *
   * A caller that writes more than this one change passes
   * `announceTheMove: false` and announces once for everything it wrote. A
   * caller that writes only this change passes `true`.
   */
  const resume = (
    sessionId: string,
    spec: string,
    at: string,
    announceTheMove: boolean,
  ): Effect.Effect<boolean, SqlError> =>
    Effect.gen(function* () {
      const moved = yield* sessions.resume(sessionId, spec, at);
      if (!moved) return false;
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
    });

  /**
   * Returns an input that a caller can still edit or cancel. Fails when:
   *
   * - the session has no input with that id (`NotFound`);
   * - the input was already delivered or cancelled (`InvalidState`);
   * - the input was already sent to the runner (`InvalidState`). The runner
   *   already has its text and it cannot be taken back, so reporting it as
   *   edited or cancelled would be wrong.
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
      return found.value;
    });

  /**
   * Does the cleanup after any session moves to `exited`: cancels its waiting
   * inputs, forgets its token and ingest state, and announces each session
   * once. When a reason is given, it is stored on the cancelled inputs.
   */
  const endSessions = (
    ids: ReadonlyArray<string>,
    reason?: string,
  ): Effect.Effect<void, SqlError> =>
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
          // The exit is a row on this session's stream, so clients watching
          // the session's transcript must be notified.
          yield* announce({ _tag: "transcript", sessionId: id });
        }
        yield* endSessions(waiting, message ?? undefined);
      }),
    );

  return {
    query: (input: QueryInput): Effect.Effect<SessionPage, ReadError> =>
      Effect.gen(function* () {
        yield* requireGrant("session.query");
        const { limit, cursor, sort, status, runnerId, agentId, permissionProfileId, thread } =
          yield* Effect.mapError(decodeQuery(input), createDecodeValidationError);
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
            direction: sort?.direction ?? DEFAULT_DIRECTION,
            status,
            runnerId,
            agentId,
            permissionProfileId,
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
        return (yield* recordComposer)(yield* one(id));
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
        yield* one(id);
        const listing = yield* refuseCursor(
          sessions.transcript({
            sessionId: id,
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: sort?.direction ?? TRANSCRIPT_DIRECTION,
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
    create: (open: Opening): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const actor = yield* currentStamp;
        yield* sessions.insert({
          id: open.id,
          title: buildTitle(open.prompt),
          permissionProfileId: open.permissionProfileId,
          agentId: open.agentId,
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
     * the spec, and the GitHub account it pushes as, when a Connection is set.
     * Joins the caller's transaction and reads what the frames need inside it,
     * which is fine because a database read and a decrypt do not wait on a
     * runner. The daemon sends the frames only after that transaction commits.
     */
    starting: (
      runnerId: string,
      room: number,
      needs: StartNeeds,
    ): Effect.Effect<ReadonlyArray<Starting>, SqlError> =>
      Effect.gen(function* () {
        const at = yield* nowIso;
        const claimed: Array<Starting> = [];
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
              needs.secretsOf(spec.value.instanceId, row.providerId),
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
                : yield* needs.accountOf(row.githubConnectionId);
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
                  : { ghToken: account.token, gitIdentity: buildGitIdentity(account.login) }),
                ...(row.checkoutBranch === null ? {} : { checkoutBranch: row.checkoutBranch }),
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
     */
    inputFrame: (row: StoredInput, modelSelection: ModelSelection): SessionInput => ({
      _tag: "sessionInput",
      requestId: row.id,
      sessionId: row.sessionId,
      input: { text: row.text, modelSelection },
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
     * Builds the frame that answers the request a session's harness is
     * waiting on. The result arrives in the session's stream as
     * `request.resolved`, so the daemon sends this frame without waiting for a
     * reply.
     */
    responding: (
      sessionId: string,
      requestId: string,
      decision: ApprovalDecision,
    ): SessionRespond => ({ _tag: "sessionRespond", sessionId, requestId, decision }),

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
     * Ends a session that was never sent to a runner, so no runner needs to
     * be told. Joins the caller's transaction, which also writes the audit
     * entry.
     */
    endQueued: (sessionId: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* sessions.moved(sessionId, "exited", at);
        yield* endSessions([sessionId]);
      }),

    /**
     * Ends every session still open on a runner, with the same cleanup as any
     * other move to `exited`: waiting inputs are cancelled, and each session
     * is announced once. Joins the caller's transaction as a savepoint.
     * Returns the ids of the sessions that were `starting`, `idle` or `busy`,
     * so a caller retiring the runner can tell it to stop each one before
     * closing the connection.
     */
    endOnRunner: (runnerId: string): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const at = yield* nowIso;
          const { ended, toStop } = yield* sessions.endOnRunner(runnerId, at);
          yield* endSessions(ended);
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
     * Ends every running session on a lost runner: the runner is not in
     * `connected`, and nothing was heard about the session for longer than the
     * session's absolute timeout (the repository method explains that limit).
     * Without this, a session on a runner that never comes back would keep a
     * valid token forever. Joins the caller's transaction, which is where
     * `connected` was read. Nothing is sent to a runner, because none of these
     * runners is connected.
     */
    endOnLostRunners: (connected: ReadonlyArray<string>): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const at = yield* nowIso;
        const ended = yield* sessions.endOnLostRunners(connected, at);
        yield* endSessions(
          ended.map((one) => one.sessionId),
          RUNNER_LOST,
        );
        yield* Effect.forEach(
          ended,
          ({ sessionId, runnerId }) =>
            audit.append({
              kind: "session.reconciled",
              actor: SYSTEM_ACTOR,
              record: { topic: "session" as const, id: sessionId },
              payload: { sessionId, runnerId, reason: "runner_lost" },
              at,
            }),
          { discard: true },
        );
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
     * Stores one user input and the model selection the session runs under
     * from then on. For an exited session, it also puts the session back on
     * the queue with its resume spec. Joins the caller's transaction, so when
     * the caller fails, for example on an invalid model option, neither the
     * new selection nor the input is stored.
     */
    takeInput: (taking: Taking): Effect.Effect<StoredInput, SqlError> =>
      Effect.gen(function* () {
        yield* sessions.setModelSelection(taking.sessionId, taking.modelSelection);
        if (taking.resumeSpec !== undefined) {
          yield* resume(taking.sessionId, taking.resumeSpec, taking.at, false);
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

    /** Returns the ids of the sessions that have a queued input not yet sent. */
    listSessionsAwaitingInput: (): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      inputs.listSessionsAwaitingInput(),

    /** Checks whether this session has an input that was sent and not yet answered. */
    holdsInputOnTheWire: (sessionId: string): Effect.Effect<boolean, SqlError> =>
      inputs.holdsInputOnTheWire(sessionId),

    queuedInput,

    /**
     * Marks an input as sent and returns the row as the update found it.
     * Returns `none` when another caller, such as a second steer or a flush,
     * claimed it first.
     */
    claimInput: (inputId: string): Effect.Effect<Option.Option<StoredInput>, SqlError> =>
      Effect.flatMap(nowIso, (at) => inputs.claim(inputId, at)),

    /**
     * Claims the oldest input still waiting on a session as soon as it is
     * found, so a second caller arriving before the runner answers cannot
     * claim it too. Returns `none` when no input is waiting or another caller
     * claimed it first.
     */
    claimOldest: (sessionId: string): Effect.Effect<Option.Option<StoredInput>, SqlError> =>
      Effect.gen(function* () {
        const next = yield* inputs.oldestWaiting(sessionId);
        if (Option.isNone(next)) return Option.none();
        return yield* inputs.claim(next.value.id, yield* nowIso);
      }),

    /** Records the delivery the runner reported for an input it received. */
    delivered: (row: StoredInput, delivery: Delivery): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          yield* inputs.delivered(row.id, delivery, yield* nowIso);
          yield* announce({ _tag: "record", topic: "session", id: row.sessionId, kind: "updated" });
        }),
      ),

    /**
     * Handles an input whose delivery failed. It goes back to waiting with the
     * reason, or is cancelled if the session exited in the meantime. The
     * session is read inside this transaction, so the check cannot race the
     * write that exits the session.
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
          yield* endSessions(gone);
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
          return yield* sessions.listExitedAmong(
            runnerId,
            bindings.map((binding) => binding.sessionId),
          );
        }),
      ),

    /**
     * Checks one event a runner reported against the session it names, and
     * folds it into the stored stream. Writes nothing: it works out the write
     * before any transaction opens. Returns `undefined` when there is nothing
     * to write: the session does not exist, is not on this runner, or has
     * already seen the event.
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
    ): Effect.Effect<FoldedReport | undefined, SqlError> =>
      Effect.gen(function* () {
        const id = event.sessionId;
        const found = yield* sessions.one(id);
        // A runner may report only on sessions placed on it. An event for any
        // other session is ignored.
        if (Option.isNone(found) || found.value.runnerId !== runnerId) return undefined;
        const before = found.value.status;
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
        return {
          session: found.value,
          folded,
          // The open request after this event, or `undefined` for no change. An
          // event for a session that has already exited never opens a request
          // again.
          park:
            before === "exited"
              ? undefined
              : computeOpenRequestAfter(event, found.value.openRequest),
        };
      }),

    /**
     * Writes one folded report: its stream rows and the status change they
     * cause commit together (spec 04, Truth model). Joins the caller's
     * transaction, so the caller's other writes for the report commit with it.
     * Returns what is left to do after the commit, because that affects more
     * than this session's rows.
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
        // Written together with the status change from the same event, so a
        // session that reads `idle` already has its provider-native id.
        const native = findNativeId(event);
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
            // Nothing waits on a harness that has exited, so its queue is cancelled too.
            yield* endSessions([id], describeExited(event.reason));
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
          // A session starting or exiting counts as use of its workspace,
          // which keeps the workspace from expiring while it is in use.
          ...(session.workspaceId !== null &&
          (event._tag === "session.started" || event._tag === "session.exited")
            ? { worked: { workspaceId: session.workspaceId, at } }
            : {}),
          moved,
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
        yield* one(id);
        const listing = yield* refuseCursor(
          inputs.list({
            sessionId: id,
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: sort?.direction ?? INPUT_DIRECTION,
          }),
        );
        return toPageOutput(listing);
      }),

    updateInput: (input: InputUpdate): Effect.Effect<Input, InputError> =>
      Effect.gen(function* () {
        yield* requireGrant("input.update");
        const { id, inputId, text } = yield* Effect.mapError(
          decodeInputUpdate(input),
          createDecodeValidationError,
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

    cancelInput: (
      sessionId: Id,
      inputId: Id,
    ): Effect.Effect<Input, Exclude<InputError, Validation>> =>
      Effect.gen(function* () {
        yield* requireGrant("input.cancel");
        yield* one(sessionId);
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
  SqlClient.SqlClient | AuditLog | SessionTokens | PluginHost
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
