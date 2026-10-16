/**
 * The repository for session rows and the append-only stream beside them.
 * Nothing here decides policy: placement, the access-mode fallback and status
 * changes are decided by the service and by the fold in `stream.ts`.
 *
 * `resumable` is computed in the SELECT rather than stored, because a stored
 * copy would be out of date as soon as a runner is retired.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Fragment } from "effect/unstable/sql/Statement";
import type {
  AccessMode,
  DisallowedTool,
  ModelSelection,
  ProviderEvent,
  SubagentId,
} from "@hercule/protocol";
import {
  createNotFoundError,
  type NotFound,
  type Passage,
  type PermissionRequest,
  type SessionRequest,
  type SessionStatus,
  type SortDirection,
  type ThreadDone,
} from "@hercule/contract";
import {
  decodeCursor,
  decodeIntegerKeyCursor,
  encodeCursor,
  encodeIntegerKeyCursor,
  buildKeyset,
  buildPage,
  uuidFromString,
  uuidToString,
  type CursorError,
  type CursorScope,
  type Page,
} from "../db";
import { buildOpenPermissionRequestsColumn, parseOpenPermissionRequests } from "../permissions";
import { buildReadyClause } from "../workspaces";
import type { SessionEndReason } from "./observer";
import { DEFAULT_ABSOLUTE_TIMEOUT_MS } from "./options";
import { buildUnfinishedClause } from "./unfinished";
import { attributeEvent, TOOL_CALL_KINDS, type StreamRow } from "./stream";
import { StoredTokenUsage, type StoredUsage } from "./usage";

/**
 * Builds a SQL expression, over a row of `sessions` under the given alias,
 * that is true when the session can be resumed. All of these must hold:
 *
 * - the session has exited
 * - its provider-native transcript is known
 * - its runner is not retired
 * - its workspace is ready (see `buildReadyClause`)
 * - it answers no assistant's conversation, or that conversation still
 *   exists. A session whose conversation was deleted takes no input, so
 *   nothing can ever resume it.
 * - it was not retired. A retired session's conversation goes on in a new
 *   session, so the old transcript is never resumed.
 */
export const buildResumableClause = (alias: string): string =>
  `${alias}.status = 'exited' AND ${alias}.native_session_id IS NOT NULL ` +
  `AND ${alias}.retired_at IS NULL ` +
  `AND EXISTS (SELECT 1 FROM runners WHERE runners.id = ${alias}.runner_id ` +
  `AND runners.lifecycle <> 'retired') ` +
  `AND ${buildReadyClause(alias)} ` +
  `AND (${alias}.conversation_id IS NULL OR EXISTS (SELECT 1 FROM conversations ` +
  `WHERE conversations.id = ${alias}.conversation_id))`;

/** The parts of a session, apart from its grants, that decide whether it can receive a Discussion Input. */
export interface DiscussionReceivability {
  readonly status: SessionStatus;
  /** Whether it is a Thread marked Done. */
  readonly done: boolean;
  /** Whether it answers an assistant's conversation. */
  readonly inConversation: boolean;
}

/** A session as it is stored. `resumable` is computed on read; see above. */
export interface StoredSession {
  readonly id: string;
  readonly title: string;
  readonly permissionProfileId: string;
  /** The Agent the session was spawned from; `null` for a Thread. */
  readonly agentId: string | null;
  /** The assistant's conversation the session answers; `null` for any other session. */
  readonly conversationId: string | null;
  /** The run whose agent step started the session; `null` for any other session. */
  readonly runId: string | null;
  /** The agent step's id in the run's plan; `null` when `runId` is. */
  readonly stepId: string | null;
  readonly instanceId: string;
  readonly runnerId: string;
  readonly workspaceId: string | null;
  readonly projectId: string | null;
  /** The GitHub account this session pushes as, chosen when it was spawned. */
  readonly githubConnectionId: string | null;
  readonly requestedAccessMode: AccessMode;
  readonly accessMode: AccessMode;
  readonly nativeSessionId: string | null;
  readonly modelSelection: ModelSelection;
  readonly parentSessionId: string | null;
  readonly status: SessionStatus;
  readonly resumable: boolean;
  /**
   * When a rotation retired the session: its conversation goes on in a new
   * session, and this one is given only its flush. `null` for a session that
   * was not retired, and for every session that answers no conversation.
   */
  readonly retiredAt: string | null;
  /**
   * When the controller first sent the retired session its flush, or `null`
   * before that. The runner ends the session when the flush turn ends, so
   * every turn the session has after this time is the flush turn.
   */
  readonly flushSentAt: string | null;
  /**
   * The Requests the session's agents are parked on, oldest first, as
   * stored: without `subagentName`, which is read into `subagentNames`.
   */
  readonly openRequests: ReadonlyArray<SessionRequest>;
  /**
   * The name of each subagent that asked one of `openRequests`, by its id:
   * its `description`, else its `agentType`. A subagent with neither is left
   * out. Computed on read, so a name the record gains after its Request
   * opened shows on the next read, and nothing stale is stored.
   */
  readonly subagentNames: ReadonlyMap<SubagentId, string>;
  /** The Permission Requests the session waits on the user's decision for, oldest first. */
  readonly openPermissionRequests: ReadonlyArray<PermissionRequest>;
  /** The session's Token Usage over its whole life; `undefined` until a harness reports some. */
  readonly usage: StoredTokenUsage | undefined;
  /** The current process's last usage snapshot; see `addUsageSnapshot`. Never shown by the API. */
  readonly usageProcess: StoredTokenUsage | undefined;
  /** How many tool calls the session's agents made; see `append`. */
  readonly toolCalls: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly exitedAt: string | null;
  /**
   * Why the session last exited, kept like `exitedAt` through a resume. It is
   * `null` until the session first exits, and for a session that exited
   * before the reason was stored (migration 0045).
   */
  readonly exitReason: SessionEndReason | null;
  readonly lastActivityAt: string;
  /**
   * Whether the crash-loop guard is armed: the session was resumed, and since
   * that resume its process has started no turn and no input has been stored
   * for it. `isResumeHeld` reads it. The service sets it.
   */
  readonly crashGuardArmed: boolean;
  /** When the Thread was marked Done and by whom; `null` while it is not Done. */
  readonly done: ThreadDone | null;
  /** The last time the Thread was reopened; `null` until it first is. */
  readonly reopenedAt: string | null;
  /** Whether an input still waits on the session, sent to the runner or not. Computed on read. */
  readonly inputWaiting: boolean;
  /**
   * Whether the session answered an assistant's conversation that has since
   * been deleted, with its assistant. Such a session is kept as history and
   * takes no input. Computed on read.
   */
  readonly conversationDeleted: boolean;
  /**
   * The provider behind the session's instance, and the tool families its
   * spec disallowed. Both are used to work out whether the provider enforces
   * the restriction. They are read on every read, not stored, because the
   * adapter in a later binary may enforce what this one ignores. `providerId`
   * is `null` once the instance is deleted.
   */
  readonly providerId: string | null;
  readonly disallowedTools: ReadonlyArray<DisallowedTool>;
}

export interface NewSession {
  /**
   * Created by the caller, not here. A spawn opens the workspace in the same
   * transaction, and a thread's own worktree is created on a branch named
   * after the thread, so the id has to exist before either row does.
   */
  readonly id: string;
  readonly title: string;
  readonly permissionProfileId: string;
  /** The Agent the session was spawned from; `undefined` for a Thread. */
  readonly agentId: string | undefined;
  /** The assistant's conversation the session answers; `undefined` for any other session. */
  readonly conversationId: string | undefined;
  /** The run and agent step that started the session; `undefined` for any other session. */
  readonly step: { readonly runId: string; readonly stepId: string } | undefined;
  readonly instanceId: string;
  readonly runnerId: string;
  readonly workspaceId: string | null;
  readonly projectId: string | undefined;
  /** The branch the main workspace is switched to before the harness starts. */
  readonly checkoutBranch: string | undefined;
  /** The GitHub account this session pushes as, chosen when it was spawned. */
  readonly githubConnectionId: string | undefined;
  readonly requestedAccessMode: AccessMode;
  readonly accessMode: AccessMode;
  /** The encoded `SessionSpec`, stored as the exact string that goes on the wire. */
  readonly spec: string;
  readonly modelSelection: ModelSelection;
  readonly parentSessionId: string | undefined;
  /** The actor stamp of the operation that created the session. */
  readonly createdBy: string;
  readonly at: string;
}

/**
 * What a session may do: the access mode it asked for, the one it runs under
 * after the provider's fallback, and the permission profile its token is
 * bound to.
 */
export interface SessionAccess {
  readonly requestedAccessMode: AccessMode;
  readonly accessMode: AccessMode;
  readonly permissionProfileId: string;
}

export interface SessionPageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: SortDirection;
  readonly status: SessionStatus | ReadonlyArray<SessionStatus> | undefined;
  readonly runnerId: string | undefined;
  readonly agentId: string | undefined;
  readonly permissionProfileId: string | undefined;
  /** Only the sessions of this conversation. */
  readonly conversationId: string | undefined;
  /** Only the sessions these runs' agent steps started. */
  readonly runId: string | ReadonlyArray<string> | undefined;
  /** `true` lists the sessions with no agent behind them; `false` lists the rest. */
  readonly thread: boolean | undefined;
  /** `true` lists only the Threads marked Done; `false` lists every session that is not. */
  readonly done: boolean | undefined;
}

interface SessionRow {
  readonly id: Uint8Array;
  readonly title: string;
  readonly permission_profile_id: Uint8Array;
  readonly agent_id: Uint8Array | null;
  readonly conversation_id: Uint8Array | null;
  readonly run_id: Uint8Array | null;
  readonly step_id: string | null;
  readonly provider_id: string | null;
  /** The spec's disallowed tool families as a JSON array, or null for none. */
  readonly disallowed_tools: string | null;
  readonly instance_id: Uint8Array;
  readonly runner_id: Uint8Array;
  readonly workspace_id: Uint8Array | null;
  readonly project_id: Uint8Array | null;
  readonly github_connection_id: Uint8Array | null;
  readonly requested_access_mode: string;
  readonly access_mode: string;
  readonly native_session_id: string | null;
  readonly model_selection: string;
  readonly parent_session_id: Uint8Array | null;
  readonly status: string;
  readonly resumable: number;
  readonly retired_at: string | null;
  readonly flush_sent_at: string | null;
  /** A JSON array of the open Requests, oldest first. */
  readonly open_requests: string;
  /**
   * A JSON object from the id of each subagent that asked an open Request to
   * its name, or `null` when it has none.
   */
  readonly subagent_names: string;
  /** A JSON array of the open Permission Requests; see `parseOpenPermissionRequests`. */
  readonly open_permission_requests: string;
  readonly usage: string | null;
  readonly usage_process: string | null;
  readonly tool_calls: number;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly exited_at: string | null;
  readonly exit_reason: string | null;
  readonly last_activity_at: string;
  readonly crash_guard_armed: number;
  readonly done_at: string | null;
  readonly done_by: string | null;
  readonly reopened_at: string | null;
  readonly input_waiting: number;
  readonly conversation_deleted: number;
}

/**
 * Builds the column list. It is called when the repository is built, never at
 * module load. Part of the list comes from a function the workspaces domain
 * exports. A constant that called it while this module loads could run before
 * the workspaces module has finished loading, and throw a `ReferenceError`
 * that depends only on which domain was imported first.
 */
const buildColumnList = (): string =>
  "id, title, permission_profile_id, agent_id, conversation_id, run_id, step_id, instance_id, runner_id, " +
  "workspace_id, project_id, " +
  "github_connection_id, requested_access_mode, " +
  // Both are read to compute `unenforced`: the provider behind the instance,
  // and the tool families this session's spec disallowed.
  "(SELECT provider_id FROM provider_instances WHERE id = sessions.instance_id) AS provider_id, " +
  "json_extract(spec, '$.disallowedTools') AS disallowed_tools, " +
  "access_mode, native_session_id, model_selection, parent_session_id, status, retired_at, " +
  "flush_sent_at, " +
  "open_requests, usage, usage_process, tool_calls, created_at, started_at, exited_at, exit_reason, " +
  "last_activity_at, crash_guard_armed, done_at, done_by, reopened_at, " +
  "EXISTS (SELECT 1 FROM session_inputs WHERE session_inputs.session_id = sessions.id " +
  "AND session_inputs.status = 'queued') AS input_waiting, " +
  "(conversation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM conversations " +
  "WHERE conversations.id = sessions.conversation_id)) AS conversation_deleted, " +
  `(${buildResumableClause("sessions")}) AS resumable, ` +
  // One primary-key lookup per open Request a subagent asked; nothing for a
  // session that waits on nothing.
  "(SELECT json_group_object(subagent_id, COALESCE(description, agent_type)) " +
  "FROM session_subagents WHERE session_subagents.session_id = sessions.id " +
  "AND subagent_id IN (SELECT json_extract(value, '$.subagentId') " +
  "FROM json_each(sessions.open_requests))) AS subagent_names, " +
  `${buildOpenPermissionRequestsColumn("sessions")} AS open_permission_requests`;

/**
 * Parses a nullable JSON column that holds Token Usage. Returns `undefined`
 * for `NULL`, which means no harness has reported usage yet. Shared by the
 * session and subagent repositories, which store usage the same way.
 */
export const parseUsage = (column: string | null): StoredTokenUsage | undefined =>
  column === null ? undefined : Schema.decodeUnknownSync(StoredTokenUsage)(JSON.parse(column));

const toSession = (row: SessionRow): StoredSession => ({
  id: uuidToString(row.id),
  title: row.title,
  permissionProfileId: uuidToString(row.permission_profile_id),
  agentId: row.agent_id === null ? null : uuidToString(row.agent_id),
  conversationId: row.conversation_id === null ? null : uuidToString(row.conversation_id),
  runId: row.run_id === null ? null : uuidToString(row.run_id),
  stepId: row.step_id,
  instanceId: uuidToString(row.instance_id),
  runnerId: uuidToString(row.runner_id),
  workspaceId: row.workspace_id === null ? null : uuidToString(row.workspace_id),
  projectId: row.project_id === null ? null : uuidToString(row.project_id),
  githubConnectionId:
    row.github_connection_id === null ? null : uuidToString(row.github_connection_id),
  requestedAccessMode: row.requested_access_mode as AccessMode,
  accessMode: row.access_mode as AccessMode,
  nativeSessionId: row.native_session_id,
  modelSelection: JSON.parse(row.model_selection) as ModelSelection,
  parentSessionId: row.parent_session_id === null ? null : uuidToString(row.parent_session_id),
  status: row.status as SessionStatus,
  resumable: row.resumable === 1,
  retiredAt: row.retired_at,
  flushSentAt: row.flush_sent_at,
  openRequests: JSON.parse(row.open_requests) as ReadonlyArray<SessionRequest>,
  subagentNames: new Map(
    Object.entries(JSON.parse(row.subagent_names) as Record<SubagentId, string | null>).flatMap(
      ([subagentId, name]): Array<[SubagentId, string]> =>
        name === null ? [] : [[subagentId, name]],
    ),
  ),
  openPermissionRequests: parseOpenPermissionRequests(row.open_permission_requests),
  usage: parseUsage(row.usage),
  usageProcess: parseUsage(row.usage_process),
  toolCalls: row.tool_calls,
  createdAt: row.created_at,
  startedAt: row.started_at,
  exitedAt: row.exited_at,
  exitReason: row.exit_reason as SessionEndReason | null,
  lastActivityAt: row.last_activity_at,
  crashGuardArmed: row.crash_guard_armed === 1,
  // The migration's check stores `done_by` exactly when `done_at` is set.
  done: row.done_at === null ? null : { at: row.done_at, by: row.done_by as string },
  reopenedAt: row.reopened_at,
  inputWaiting: row.input_waiting === 1,
  conversationDeleted: row.conversation_deleted === 1,
  providerId: row.provider_id,
  disallowedTools:
    row.disallowed_tools === null
      ? []
      : (JSON.parse(row.disallowed_tools) as ReadonlyArray<DisallowedTool>),
});

const buildCursorScope = (direction: SortDirection): CursorScope => ({
  op: "session.query",
  sort: [{ field: "createdAt", direction }],
});

/**
 * Builds the cursor scope for one agent's transcript. The cursor key is the
 * position, which is per session, and each agent of the session has its own
 * transcript, so the session id and the subagent id are both part of the
 * scope. Without them, a cursor from one transcript would silently skip rows
 * on another. The session's own agent has an empty subagent part. Neither id
 * can contain `:`, so two scopes cannot be spelled the same.
 */
const buildTranscriptScope = (
  sessionId: string,
  subagentId: SubagentId | undefined,
  direction: SortDirection,
): CursorScope => ({
  op: "transcript.read",
  sort: [{ field: `position:${sessionId}:${subagentId ?? ""}`, direction }],
});

/**
 * Builds the SQL condition that picks one agent's rows of a session's
 * stream: the subagent's, or the session's own agent's when `subagentId` is
 * `undefined`.
 */
export const buildAgentClause = (
  sql: SqlClient.SqlClient,
  subagentId: SubagentId | undefined,
): Fragment =>
  subagentId === undefined ? sql`subagent_id IS NULL` : sql`subagent_id = ${subagentId}`;

/**
 * The position of the last queued row a batch read. The next batch starts
 * after it, so a caller that skips rows never reads the same row twice.
 */
export interface QueuePosition {
  readonly createdAt: string;
  readonly id: string;
}

/**
 * One queued session, with everything needed to build its start frame except
 * the token and the GitHub account, which are read when the session is
 * claimed.
 */
export interface QueuedSession {
  readonly id: string;
  readonly createdAt: string;
  readonly spec: string;
  readonly checkoutBranch: string | null;
  readonly githubConnectionId: string | null;
  readonly providerId: string;
  readonly config: unknown;
  /** The Agent the session was spawned from; `null` for a Thread. */
  readonly agentId: string | null;
  /** The assistant's conversation the session answers; `null` for any other session. */
  readonly conversationId: string | null;
  /** The model selection the session runs under now, which goes with the input its start carries. */
  readonly modelSelection: ModelSelection;
  /** The run whose agent step started the session; `null` for any other session. */
  readonly runId: string | null;
  /** The agent step that started the session; `null` for any other session. */
  readonly stepId: string | null;
}

/** A session's ingest state; see `ingestState`. */
export interface IngestState {
  readonly lastSeq: number;
  /** Added to every sequence number the session's current process reports. */
  readonly base: number;
}

/** One row of a session's stream, as the transcript reads it. */
export interface StoredStreamRow {
  readonly position: number;
  readonly at: string;
  readonly event: ProviderEvent;
}

export interface TranscriptPageRequest {
  readonly sessionId: string;
  /** The subagent whose transcript is read; `undefined` for the session's own agent. */
  readonly subagentId: SubagentId | undefined;
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: SortDirection;
}

/**
 * A transcript search, with every `me` already resolved. Each field that is
 * `undefined` does not narrow the search.
 */
export interface PassageQueryRequest {
  /** The `MATCH` expression from `buildMatchExpression`. */
  readonly match: string;
  readonly sessionId: string | undefined;
  readonly agentId: string | undefined;
  /** The actor stamp the matching sessions were created by. */
  readonly createdBy: string | undefined;
  /** Keeps messages written at or after this instant. */
  readonly since: string | undefined;
  /** Keeps messages written before this instant. */
  readonly until: string | undefined;
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: SortDirection;
}

/**
 * The number of tokens in a passage's excerpt. It is enough for a sentence
 * or two around the hit, which is what a reader needs to decide whether to
 * open the transcript.
 */
const EXCERPT_TOKENS = 32;

/**
 * Builds the cursor scope of a transcript search. Passages are sorted by when
 * the message was written, then by session and position, which together are
 * unique.
 */
const buildPassageScope = (direction: SortDirection): CursorScope => ({
  op: "transcript.query",
  sort: [{ field: "at", direction }],
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const COLUMNS = buildColumnList();

  /**
   * Builds the status filter: `=` for one status, `IN` for several (the
   * runner page reads capacity that way). The contract requires at least one
   * element in the array, so an empty array cannot reach this.
   */
  const buildStatusClause = (status: SessionStatus | ReadonlyArray<SessionStatus>) =>
    Array.isArray(status) ? sql`status IN ${sql.in(status)}` : sql`status = ${status}`;

  /**
   * Moves every session that matches `condition` and has not exited to
   * `exited`, and returns those rows as they were just before, oldest first.
   * The caller needs the old rows, because what an end means depends on the
   * status the session ended from, and an UPDATE's RETURNING gives only the
   * new values. So the rows are read first and then updated by id, and the
   * caller runs both in one transaction, so no write can land between them.
   */
  const endMatching = (
    condition: Fragment,
    at: string,
  ): Effect.Effect<ReadonlyArray<StoredSession>, SqlError> =>
    Effect.gen(function* () {
      const rows = yield* sql<SessionRow>`
        SELECT ${sql.literal(COLUMNS)} FROM sessions
        WHERE status <> 'exited' AND ${condition}
        ORDER BY created_at, id
      `;
      if (rows.length === 0) return [];
      yield* sql`
        UPDATE sessions SET
          status = 'exited',
          open_requests = '[]',
          token_hash = NULL,
          exited_at = ${at}
        WHERE id IN ${sql.in(rows.map((row) => row.id))} AND status <> 'exited'
      `;
      return rows.map(toSession);
    });

  return {
    /**
     * Writes the session and returns nothing. The caller minted the id, so it
     * already knows it. The caller must read the row back after the write,
     * because dispatch may change the row, and the caller must pass on the
     * current row.
     */
    insert: (session: NewSession): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const id = uuidFromString(session.id);
        const parent =
          session.parentSessionId === undefined ? null : uuidFromString(session.parentSessionId);
        const workspace = session.workspaceId === null ? null : uuidFromString(session.workspaceId);
        const project = session.projectId === undefined ? null : uuidFromString(session.projectId);
        const connection =
          session.githubConnectionId === undefined
            ? null
            : uuidFromString(session.githubConnectionId);
        // A session with no Agent is a Thread, and a Thread on the controller's
        // local runner sees the user's own material (spec 06 section 9.1). A
        // new caller that writes a session for an Agent, an assistant or a
        // workflow step must set its Agent.
        const agent = session.agentId === undefined ? null : uuidFromString(session.agentId);
        const conversation =
          session.conversationId === undefined ? null : uuidFromString(session.conversationId);
        const run = session.step === undefined ? null : uuidFromString(session.step.runId);
        yield* sql`
          INSERT INTO sessions (id, title, permission_profile_id, agent_id, conversation_id,
                                run_id, step_id, instance_id, runner_id,
                                workspace_id, project_id, checkout_branch, github_connection_id,
                                requested_access_mode, access_mode, spec,
                                model_selection, parent_session_id, status,
                                created_by, created_at, last_activity_at)
          VALUES (${id}, ${session.title}, ${uuidFromString(session.permissionProfileId)}, ${agent},
                  ${conversation}, ${run}, ${session.step?.stepId ?? null},
                  ${uuidFromString(session.instanceId)}, ${uuidFromString(session.runnerId)},
                  ${workspace}, ${project}, ${session.checkoutBranch ?? null}, ${connection},
                  ${session.requestedAccessMode}, ${session.accessMode},
                  ${session.spec}, ${JSON.stringify(session.modelSelection)}, ${parent},
                  'queued', ${session.createdBy}, ${session.at}, ${session.at})
        `;
      }),

    one: (id: string): Effect.Effect<Option.Option<StoredSession>, SqlError> =>
      Effect.map(
        sql<SessionRow>`
          SELECT ${sql.literal(COLUMNS)} FROM sessions WHERE id = ${uuidFromString(id)}
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), toSession),
      ),

    /**
     * Returns every session of one conversation that has not exited, oldest
     * first. The newest answers the conversation; an older one that has not
     * exited yet is still running, for example while it is being stopped.
     */
    listLiveInConversation: (
      conversationId: string,
    ): Effect.Effect<ReadonlyArray<StoredSession>, SqlError> =>
      Effect.map(
        sql<SessionRow>`
          SELECT ${sql.literal(COLUMNS)} FROM sessions
          WHERE conversation_id = ${uuidFromString(conversationId)} AND status <> 'exited'
          ORDER BY created_at, id
        `,
        (rows) => rows.map(toSession),
      ),

    /** Returns every session of one workflow run's agent steps that has not exited, oldest first. */
    listLiveInRun: (runId: string): Effect.Effect<ReadonlyArray<StoredSession>, SqlError> =>
      Effect.map(
        sql<SessionRow>`
          SELECT ${sql.literal(COLUMNS)} FROM sessions
          WHERE run_id = ${uuidFromString(runId)} AND status <> 'exited'
          ORDER BY created_at, id
        `,
        (rows) => rows.map(toSession),
      ),

    /**
     * Checks whether the session was started by an agent step whose run has
     * ended: completed, failed or cancelled. Returns `false` for a session no
     * run started, and for one whose run is still pending or running.
     */
    belongsToEndedRun: (sessionId: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          SELECT sessions.id FROM sessions JOIN runs ON runs.id = sessions.run_id
          WHERE sessions.id = ${uuidFromString(sessionId)}
            AND runs.status NOT IN ('pending', 'running')
        `,
        (rows) => rows.length > 0,
      ),

    /** Returns the ids of the exited sessions of one conversation that have a workspace. */
    listExitedWithWorkspaceInConversation: (
      conversationId: string,
    ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          SELECT id FROM sessions
          WHERE conversation_id = ${uuidFromString(conversationId)} AND status = 'exited'
            AND workspace_id IS NOT NULL
        `,
        (rows) => rows.map((row) => uuidToString(row.id)),
      ),

    /**
     * Returns the newest session of one conversation, whatever its status, or
     * `none` when the conversation has no session yet. Sessions created in
     * the same millisecond are ordered by id, as the index is.
     */
    newestInConversation: (
      conversationId: string,
    ): Effect.Effect<Option.Option<StoredSession>, SqlError> =>
      Effect.map(
        sql<SessionRow>`
          SELECT ${sql.literal(COLUMNS)} FROM sessions
          WHERE conversation_id = ${uuidFromString(conversationId)}
          ORDER BY created_at DESC, id DESC LIMIT 1
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), toSession),
      ),

    /**
     * Returns the ids of the agent's conversations whose newest session is
     * due for its daily rotation: it was created before `createdBefore`, it
     * has had a turn, and it is not retired. A session that
     * has had no turn is left alone, because nothing happened in it. The
     * Scheduler asks every second, so the query starts from the agent's few
     * conversations and reads one session of each, by index.
     */
    listConversationsDueForDailyRotation: (
      agentId: string,
      createdBefore: string,
    ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(
        sql<{ readonly conversation_id: Uint8Array }>`
          SELECT newest.conversation_id FROM conversations
          JOIN sessions AS newest ON newest.id = (SELECT id FROM sessions
            WHERE sessions.conversation_id = conversations.id
            ORDER BY created_at DESC, id DESC LIMIT 1)
          WHERE conversations.assistant_id = ${uuidFromString(agentId)}
            AND newest.retired_at IS NULL
            AND newest.created_at < ${createdBefore}
            AND EXISTS (SELECT 1 FROM session_inputs
              WHERE session_inputs.session_id = newest.id AND status = 'delivered')
        `,
        (rows) => rows.map((row) => uuidToString(row.conversation_id)),
      ),

    /**
     * Returns the ids among `ids` of sessions that have ended for good: the
     * process has exited and the session cannot be resumed. Uses one query for
     * the whole list, because the caller asks about many sessions at once and
     * a query per id would grow with the list.
     *
     * A retired session that has exited counts as ended for good, because it
     * is never resumed. A conversation holds its own subscriptions, so none
     * of them waits on a session that has ended.
     */
    listEndedForGood: (
      ids: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      ids.length === 0
        ? Effect.succeed([])
        : Effect.map(
            sql<{ readonly id: Uint8Array }>`
              SELECT id FROM sessions
              WHERE id IN ${sql.in(ids.map(uuidFromString))}
                AND status = 'exited' AND NOT (${sql.literal(buildResumableClause("sessions"))})
            `,
            (rows) => rows.map((row) => uuidToString(row.id)),
          ),

    list: (
      request: SessionPageRequest,
    ): Effect.Effect<Page<StoredSession>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope = buildCursorScope(request.direction);
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(request.cursor, scope, ["string"]);
        const { keyset, order } = buildKeyset(
          sql,
          [{ column: "created_at", direction: request.direction }],
          ["id"],
          after === undefined ? undefined : [...after.values, uuidFromString(after.id)],
        );
        const clauses = [keyset];
        if (request.status !== undefined) clauses.push(buildStatusClause(request.status));
        if (request.runnerId !== undefined) {
          clauses.push(sql`runner_id = ${uuidFromString(request.runnerId)}`);
        }
        if (request.agentId !== undefined) {
          clauses.push(sql`agent_id = ${uuidFromString(request.agentId)}`);
        }
        if (request.permissionProfileId !== undefined) {
          clauses.push(sql`permission_profile_id = ${uuidFromString(request.permissionProfileId)}`);
        }
        if (request.conversationId !== undefined) {
          clauses.push(sql`conversation_id = ${uuidFromString(request.conversationId)}`);
        }
        if (request.runId !== undefined) {
          clauses.push(
            typeof request.runId === "string"
              ? sql`run_id = ${uuidFromString(request.runId)}`
              : sql`run_id IN ${sql.in(request.runId.map(uuidFromString))}`,
          );
        }
        if (request.thread !== undefined) {
          clauses.push(request.thread ? sql`agent_id IS NULL` : sql`agent_id IS NOT NULL`);
        }
        if (request.done !== undefined) {
          clauses.push(request.done ? sql`done_at IS NOT NULL` : sql`done_at IS NULL`);
        }
        const rows = yield* sql<SessionRow>`
          SELECT ${sql.literal(COLUMNS)} FROM sessions
          WHERE ${sql.and(clauses)} ${order} LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(
          rows,
          request.limit,
          (found) => Effect.succeed(found.map(toSession)),
          (last) => encodeCursor(scope, [last.createdAt], last.id),
        );
      }),

    /** Checks whether the session is unfinished (`buildUnfinishedClause`). A session that does not exist is not. */
    isUnfinished: (id: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly found: number }>`
          SELECT 1 AS found FROM sessions s
          WHERE s.id = ${uuidFromString(id)} AND ${sql.literal(buildUnfinishedClause("s"))}
        `,
        (rows) => rows.length > 0,
      ),

    /**
     * Returns what decides whether the session can receive a Discussion
     * Input, apart from its grants: its status, whether it is a Thread marked
     * Done, and whether it answers an assistant's conversation. Returns
     * `none` when there is no such session. It reads three columns, not the
     * whole row, because a draft checks every other session it names.
     */
    readDiscussionReceivability: (
      id: string,
    ): Effect.Effect<Option.Option<DiscussionReceivability>, SqlError> =>
      Effect.map(
        sql<{
          readonly status: string;
          readonly done_at: string | null;
          readonly conversation_id: Uint8Array | null;
        }>`
          SELECT status, done_at, conversation_id FROM sessions WHERE id = ${uuidFromString(id)}
        `,
        (rows) =>
          Option.map(Option.fromNullishOr(rows[0]), (row) => ({
            status: row.status as SessionStatus,
            done: row.done_at !== null,
            inConversation: row.conversation_id !== null,
          })),
      ),

    /**
     * Returns the exact spec sent to this session's runner, as the row stores
     * it, or `none` when there is no such session. It is read separately
     * rather than on every session read, because only a session that continues
     * another session's transcript needs it, and the column is large.
     */
    readSpecDocument: (id: string): Effect.Effect<Option.Option<string>, SqlError> =>
      Effect.map(
        sql<{ readonly spec: string }>`
          SELECT spec FROM sessions WHERE id = ${uuidFromString(id)}
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), (row) => row.spec),
      ),

    /**
     * Returns one page of one agent's transcript, in position order. The stored
     * `event` is parsed with `JSON.parse` rather than decoded with the schema:
     * the schema has no transformations, so the JSON is already the value.
     */
    transcript: (
      request: TranscriptPageRequest,
    ): Effect.Effect<Page<StoredStreamRow>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope = buildTranscriptScope(
          request.sessionId,
          request.subagentId,
          request.direction,
        );
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeIntegerKeyCursor(request.cursor, scope);
        const { keyset, order } = buildKeyset(
          sql,
          [{ column: "position", direction: request.direction }],
          [],
          after === undefined ? undefined : [after],
        );
        const rows = yield* sql<{
          readonly position: number;
          readonly at: string;
          readonly event: string;
        }>`
          SELECT position, at, event FROM session_stream
          WHERE session_id = ${uuidFromString(request.sessionId)}
            AND ${buildAgentClause(sql, request.subagentId)} AND ${keyset}
          ${order} LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(
          rows,
          request.limit,
          (found) =>
            Effect.succeed(
              found.map((row) => ({
                position: row.position,
                at: row.at,
                event: JSON.parse(row.event) as ProviderEvent,
              })),
            ),
          (last) => encodeIntegerKeyCursor(scope, last.position),
        );
      }),

    /**
     * Returns one page of the messages that match a full-text search, as
     * passages, sorted by when the message was written. Fails with
     * `CursorError` when the cursor was not issued by this search's order.
     *
     * A message is what the `transcript_messages` view says it is: a user
     * message, or a stored piece of an assistant message. A long assistant
     * message is stored in pieces, so it can match as more than one passage.
     */
    queryPassages: (
      request: PassageQueryRequest,
    ): Effect.Effect<Page<Passage>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope = buildPassageScope(request.direction);
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(request.cursor, scope, ["string", "number"]);
        const { keyset, order } = buildKeyset(
          sql,
          [{ column: "ss.at", direction: request.direction }],
          ["ss.session_id", "ss.position"],
          after === undefined
            ? undefined
            : [after.values[0], uuidFromString(after.id), after.values[1]],
        );
        const filters = [
          request.sessionId === undefined
            ? undefined
            : sql`ss.session_id = ${uuidFromString(request.sessionId)}`,
          request.agentId === undefined
            ? undefined
            : sql`s.agent_id = ${uuidFromString(request.agentId)}`,
          request.createdBy === undefined ? undefined : sql`s.created_by = ${request.createdBy}`,
          request.since === undefined ? undefined : sql`ss.at >= ${request.since}`,
          request.until === undefined ? undefined : sql`ss.at < ${request.until}`,
        ].filter((filter) => filter !== undefined);
        const rows = yield* sql<{
          readonly session_id: Uint8Array;
          readonly position: number;
          readonly at: string;
          readonly subagent_id: SubagentId | null;
          readonly turn_id: string;
          readonly excerpt: string;
        }>`
          SELECT ss.session_id, ss.position, ss.at, ss.subagent_id,
            json_extract(ss.event, '$.turnId') AS turn_id,
            snippet(transcript_fts, 0, '', '', '…', ${EXCERPT_TOKENS}) AS excerpt
          FROM transcript_fts
          JOIN session_stream ss ON ss.rowid = transcript_fts.rowid
          JOIN sessions s ON s.id = ss.session_id
          WHERE transcript_fts MATCH ${request.match}
            AND ${sql.and([...filters, keyset])}
          ${order} LIMIT ${request.limit + 1}
        `;
        const page = rows.slice(0, request.limit);
        const last = page[page.length - 1];
        return {
          items: page.map((row): Passage => ({
            sessionId: uuidToString(row.session_id),
            ...(row.subagent_id === null ? {} : { subagentId: row.subagent_id }),
            turnId: row.turn_id,
            at: row.at,
            excerpt: row.excerpt,
          })),
          // The cursor needs the row's position, which a passage does not
          // carry, so it is built from the row rather than with `buildPage`.
          nextCursor:
            rows.length > request.limit && last !== undefined
              ? encodeCursor(scope, [last.at, last.position], uuidToString(last.session_id))
              : undefined,
        };
      }),

    /**
     * Returns the session's ingest state: the highest sequence number already
     * written, and the offset added to the current process's sequence numbers.
     *
     * The highest sequence is a high-water mark, not proof that every lower
     * number was written. A merged delta row stores the sequence of its last
     * delta, so a plain event can be written with a higher sequence while
     * lower delta text is still only held in memory. Nothing replays today.
     * When the runner gets its disk-backed outbox, which replays every frame
     * after the last acknowledged one on reconnect, that replay will need
     * more than this mark. Spec 03 section 2.3 describes the outbox.
     */
    ingestState: (sessionId: string): Effect.Effect<IngestState, SqlError> =>
      Effect.map(
        sql<{ readonly last: number | null; readonly base: number }>`
          SELECT (SELECT MAX(runner_seq) FROM session_stream
                  WHERE session_id = sessions.id) AS last,
                 stream_base AS base
          FROM sessions WHERE id = ${uuidFromString(sessionId)}
        `,
        (rows) => ({ lastSeq: rows[0]?.last ?? 0, base: rows[0]?.base ?? 0 }),
      ),

    /**
     * Appends one row at the next position for this session, stored under the
     * agent `attributeEvent` names. A sequence number already written hits the
     * unique index and writes nothing, so a replayed frame is harmless.
     *
     * A row that starts a tool call (an `item.started` of a kind in
     * `TOOL_CALL_KINDS`, from any of the session's agents) also adds one to
     * the session's `tool_calls`. Only a row actually written counts, so a
     * replayed frame does not count twice. Every caller runs this inside its
     * own transaction, so the row and the count commit together. Returns
     * whether the row was written and counted as a tool call, so the caller
     * knows the session changed.
     */
    append: (sessionId: string, row: StreamRow): Effect.Effect<boolean, SqlError> =>
      Effect.gen(function* () {
        const id = uuidFromString(sessionId);
        const written = yield* sql<{ readonly position: number }>`
          INSERT INTO session_stream (session_id, position, runner_seq, at, event, subagent_id)
          SELECT ${id}, COALESCE(MAX(position), 0) + 1, ${row.seq}, ${row.at},
                 ${JSON.stringify(row.event)}, ${attributeEvent(row.event) ?? null}
          FROM session_stream WHERE session_id = ${id}
          ON CONFLICT (session_id, runner_seq) DO NOTHING
          RETURNING position
        `;
        const startsToolCall =
          row.event._tag === "item.started" && TOOL_CALL_KINDS.has(row.event.kind);
        if (written.length === 0 || !startsToolCall) return false;
        yield* sql`UPDATE sessions SET tool_calls = tool_calls + 1 WHERE id = ${id}`;
        return true;
      }),

    /**
     * Changes the session's status and updates its last activity time,
     * except for a move to `exited`: an exit is not activity, so the time
     * stays what the last real activity wrote, and `exitedAt` holds the exit.
     * A runner restart exits every live session at once, and stamping each
     * with that moment would make all of them look equally recent.
     *
     * - `startedAt` is written once, when the session first becomes `idle` or
     *   `busy`. A session resumed later keeps its first start time.
     * - `exitedAt` is the last exit, so every move to `exited` sets it again.
     * - A status with no process behind it clears the token hash in the same
     *   write. The table's constraint rejects the row otherwise (migration
     *   0023).
     *
     * The WHERE clause keeps an exited session exited. This row has two
     * writers, ingest and a spawn that could not reach its runner, so a status
     * read before the transaction proves nothing inside it. Only `resume`
     * below moves a session out of `exited`.
     */
    moved: (sessionId: string, status: SessionStatus, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE sessions SET
          status = ${status},
          last_activity_at = CASE WHEN ${status} = 'exited' THEN last_activity_at ELSE ${at} END,
          started_at = CASE WHEN started_at IS NULL AND ${status} IN ('idle', 'busy') THEN ${at}
                            ELSE started_at END,
          exited_at = CASE WHEN ${status} = 'exited' THEN ${at} ELSE exited_at END,
          token_hash = CASE WHEN ${status} IN ('starting', 'idle', 'busy') THEN token_hash
                            ELSE NULL END
        WHERE id = ${uuidFromString(sessionId)} AND status <> 'exited'
      `),

    /**
     * Moves a `queued` session to `exited`, and returns the row as it was
     * before. A session that dispatch moved to `starting` in the meantime is
     * left alone and returns `none`: its runner now holds it, so only the
     * runner can end it. The caller runs it in a transaction.
     */
    endQueued: (
      sessionId: string,
      at: string,
    ): Effect.Effect<Option.Option<StoredSession>, SqlError> =>
      Effect.map(
        endMatching(sql`id = ${uuidFromString(sessionId)} AND status = 'queued'`, at),
        (ended) => Option.fromNullishOr(ended[0]),
      ),

    /**
     * Moves the session to `starting` for dispatch, and stores the hash of the
     * token created for that start. It is one statement rather than a status
     * change plus a write, because the row may hold a token only while it is
     * starting or running, and the two must never be out of step. Like
     * `moved`, it never changes an exited session.
     */
    started: (sessionId: string, tokenHash: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE sessions SET
          status = 'starting',
          last_activity_at = ${at},
          token_hash = ${tokenHash}
        WHERE id = ${uuidFromString(sessionId)} AND status <> 'exited'
      `),

    /**
     * Moves an exited session back to `queued`, with the spec its resumed
     * harness starts with, for dispatch to place. This is the only way out of
     * `exited`, and the one exception to the rule in `moved`. `undoResume`
     * below is its inverse.
     *
     * It decides nothing: whether the session may be resumed is the service's
     * check, made in the same transaction just before this write.
     *
     * It leaves `last_activity_at` alone: queuing is not activity, and dispatch
     * stamps it when the resumed process starts (`started`).
     *
     * An exited row holds no token hash (migration 0023), so a token that
     * leaked before the exit stays invalid once the session is back on the
     * queue. Dispatch creates a new token for the resumed process.
     *
     * The sequence offset always moves up to the highest sequence in the
     * stored stream: the controller cannot tell whether the runner's process
     * restarted and began numbering from zero again. Moving it anyway is
     * harmless, because `runner_seq` is only used to drop duplicates and the
     * transcript is read in `position` order.
     */
    resume: (sessionId: string, spec: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE sessions SET
          status = 'queued',
          spec = ${spec},
          open_requests = '[]',
          stream_base = (SELECT COALESCE(MAX(runner_seq), 0) FROM session_stream
                         WHERE session_id = sessions.id)
        WHERE id = ${uuidFromString(sessionId)}
      `),

    /**
     * Stores why the session exited. It decides nothing: the service writes
     * it in the transaction that moves the session to `exited`.
     */
    setExitReason: (sessionId: string, reason: SessionEndReason): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE sessions SET exit_reason = ${reason}
        WHERE id = ${uuidFromString(sessionId)}
      `),

    /**
     * Moves a resumed session that is still `queued` back to `exited`, and
     * returns whether it did. The row keeps the exit time of the exit the
     * resume began from, so the session reads as that exit again, not as a
     * new one. It also undoes what the resume wrote:
     *
     * - the crash-loop guard is disarmed. The service resumes a session only
     *   while the guard does not hold it, and a resume arms it, so before the
     *   resume it was disarmed.
     *
     * The spec and the stream offset the resume wrote stay: the next resume
     * writes both again. A queued row holds no token hash and no open
     * request, so neither needs clearing.
     *
     * A row that never exited is left alone and returns `false`: it is a
     * first start, and there is no exit to go back to. Like `resume`, it
     * decides nothing; the service checks in the same transaction that no
     * input is waiting.
     */
    undoResume: (sessionId: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          UPDATE sessions SET
            status = 'exited',
            crash_guard_armed = 0
          WHERE id = ${uuidFromString(sessionId)} AND status = 'queued'
            AND exited_at IS NOT NULL
          RETURNING id
        `,
        (rows) => rows.length > 0,
      ),

    /**
     * Marks the session Done, at `at`, by `actor`. Returns whether it changed
     * the row: `false` when the session was already Done, or does not exist.
     * It checks nothing else; the service decides which sessions may be Done.
     */
    markDone: (sessionId: string, actor: string, at: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          UPDATE sessions SET done_at = ${at}, done_by = ${actor}
          WHERE id = ${uuidFromString(sessionId)} AND done_at IS NULL
          RETURNING id
        `,
        (rows) => rows.length > 0,
      ),

    /**
     * Takes the Done mark off the session and stores `at` as the time it was
     * reopened. Returns whether it changed the row: `false` when the session
     * was not Done, or does not exist. A session that was not Done keeps its
     * `reopened_at`, because a client sorts Threads on it.
     */
    reopen: (sessionId: string, at: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          UPDATE sessions SET done_at = NULL, done_by = NULL, reopened_at = ${at}
          WHERE id = ${uuidFromString(sessionId)} AND done_at IS NOT NULL
          RETURNING id
        `,
        (rows) => rows.length > 0,
      ),

    /**
     * Records that a rotation retired the session at `at`. From then on the
     * session is never resumed and is given only its flush: the conversation
     * goes on in a new session, which takes over the input that waits here
     * once this session has exited. Does nothing for a session already
     * retired.
     */
    retire: (sessionId: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE sessions SET retired_at = ${at}
        WHERE id = ${uuidFromString(sessionId)} AND retired_at IS NULL
      `),

    /**
     * Records that the controller claimed the retired session's flush for
     * sending at `at`, as an input's `sent_at` records its claim. Does nothing
     * when the time is already recorded, so the first claim is the one that
     * counts. The time stays set when the flush goes back to waiting.
     */
    markFlushSent: (sessionId: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE sessions SET flush_sent_at = ${at}
        WHERE id = ${uuidFromString(sessionId)} AND flush_sent_at IS NULL
      `),

    /**
     * Stores whether the session's crash-loop guard is armed. It decides
     * nothing: the service decides when the guard is armed and when it is
     * not.
     */
    setCrashGuardArmed: (sessionId: string, armed: boolean): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE sessions SET crash_guard_armed = ${armed ? 1 : 0}
        WHERE id = ${uuidFromString(sessionId)}
      `),

    /**
     * Sets the model and model options the session runs under from now on.
     * `spec` is not changed: it is the spec the runner received at start, and
     * only `resume` above rewrites it, for the next start.
     */
    setModelSelection: (
      sessionId: string,
      modelSelection: ModelSelection,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE sessions SET model_selection = ${JSON.stringify(modelSelection)}
        WHERE id = ${uuidFromString(sessionId)}
      `),

    /**
     * Replaces the session's title with a generated one, and stores whether
     * the model judged that title too vague (`needs_refinement`). The column
     * is never read back yet: it is the mark that a title was generated.
     */
    setGeneratedTitle: (
      sessionId: string,
      title: string,
      needsRefinement: boolean,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE sessions SET title = ${title}, needs_refinement = ${needsRefinement ? 1 : 0}
        WHERE id = ${uuidFromString(sessionId)}
      `),

    /**
     * Sets the access mode the session asked for, the one it runs under, and
     * the permission profile its token is bound to. Only a resume calls this,
     * before the session starts again, because a running harness keeps the
     * mode it was started with.
     */
    setAccess: (sessionId: string, access: SessionAccess): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE sessions SET
          requested_access_mode = ${access.requestedAccessMode},
          access_mode = ${access.accessMode},
          permission_profile_id = ${uuidFromString(access.permissionProfileId)}
        WHERE id = ${uuidFromString(sessionId)}
      `),

    /** Stores the Requests the session's agents are parked on, oldest first. */
    setOpenRequests: (
      sessionId: string,
      requests: ReadonlyArray<SessionRequest>,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE sessions SET open_requests = ${JSON.stringify(requests)}
        WHERE id = ${uuidFromString(sessionId)}
      `),

    /** Stores the session's Token Usage and its current process's last snapshot. */
    setUsage: (sessionId: string, usage: StoredUsage): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE sessions SET
          usage = ${usage.usage === undefined ? null : JSON.stringify(usage.usage)},
          usage_process = ${
            usage.usageProcess === undefined ? null : JSON.stringify(usage.usageProcess)
          }
        WHERE id = ${uuidFromString(sessionId)}
      `),

    /**
     * Sets the session's last activity time to `at`. An exited session is left
     * alone: an event that arrives after the exit is recorded in the stream,
     * but it is not activity.
     */
    touched: (sessionId: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        sql`UPDATE sessions SET last_activity_at = ${at}
            WHERE id = ${uuidFromString(sessionId)} AND status <> 'exited'`,
      ),

    /**
     * Stores the provider-native id a runner reported for one of its sessions.
     * The runner and the instance are both in the WHERE clause, because a
     * runner may report only on the sessions placed on it, and only for the
     * instance those sessions were opened against.
     */
    bind: (
      sessionId: string,
      runnerId: string,
      instanceId: string,
      nativeSessionId: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE sessions SET native_session_id = ${nativeSessionId}
        WHERE id = ${uuidFromString(sessionId)} AND runner_id = ${uuidFromString(runnerId)}
          AND instance_id = ${uuidFromString(instanceId)}
      `),

    /**
     * Returns up to `limit` of this runner's oldest queued sessions, with what
     * the start frame needs: the exact spec each was queued with, and its
     * provider. The provider is joined rather than read per row, so dispatch
     * needs one statement. `after` continues an earlier batch from where it
     * stopped, in queue order, so a caller that skips rows never reads them
     * again.
     */
    oldestQueued: (
      runnerId: string,
      limit: number,
      after?: QueuePosition,
    ): Effect.Effect<ReadonlyArray<QueuedSession>, SqlError> =>
      Effect.map(
        sql<{
          readonly id: Uint8Array;
          readonly created_at: string;
          readonly spec: string;
          readonly checkout_branch: string | null;
          readonly github_connection_id: Uint8Array | null;
          readonly provider_id: string;
          readonly config: string;
          readonly agent_id: Uint8Array | null;
          readonly conversation_id: Uint8Array | null;
          readonly model_selection: string;
          readonly run_id: Uint8Array | null;
          readonly step_id: string | null;
        }>`
          SELECT s.id, s.created_at, s.spec,
                 -- The branch is used only once: the runner switches the main
                 -- workspace to it before this thread first runs. A resume
                 -- continues where the thread left off, and switching again
                 -- would change the branch under whatever the user has done in
                 -- that checkout since.
                 CASE WHEN s.started_at IS NULL THEN s.checkout_branch END AS checkout_branch,
                 s.github_connection_id, pi.provider_id, pi.config, s.agent_id,
                 s.conversation_id, s.model_selection, s.run_id, s.step_id
          FROM sessions s JOIN provider_instances pi ON pi.id = s.instance_id
          WHERE s.runner_id = ${uuidFromString(runnerId)} AND s.status = 'queued'
            -- A session waits until its workspace is ready. Starting it
            -- earlier would give the harness a directory that does not exist
            -- yet.
            AND ${sql.literal(buildReadyClause("s"))}
            -- Continue after the previous batch's last row, on the same pair
            -- ORDER BY sorts by. The empty values a first batch passes sort
            -- before every real row.
            AND (s.created_at, s.id) > (${after?.createdAt ?? ""}, ${after === undefined ? new Uint8Array(0) : uuidFromString(after.id)})
          ORDER BY s.created_at ASC, s.id ASC
          LIMIT ${limit}
        `,
        (rows) =>
          rows.map((row) => ({
            id: uuidToString(row.id),
            createdAt: row.created_at,
            spec: row.spec,
            checkoutBranch: row.checkout_branch,
            githubConnectionId:
              row.github_connection_id === null ? null : uuidToString(row.github_connection_id),
            providerId: row.provider_id,
            config: JSON.parse(row.config) as unknown,
            agentId: row.agent_id === null ? null : uuidToString(row.agent_id),
            conversationId: row.conversation_id === null ? null : uuidToString(row.conversation_id),
            modelSelection: JSON.parse(row.model_selection) as ModelSelection,
            runId: row.run_id === null ? null : uuidToString(row.run_id),
            stepId: row.step_id,
          })),
      ),

    /**
     * Ends every session in a workspace that has not exited, and returns those
     * rows as they were before. The caller runs it in a transaction.
     */
    endInWorkspace: (
      workspaceId: string,
      at: string,
    ): Effect.Effect<ReadonlyArray<StoredSession>, SqlError> =>
      endMatching(sql`workspace_id = ${uuidFromString(workspaceId)}`, at),

    /**
     * Ends every session still open on this runner, queued ones included, and
     * returns those rows as they were before. A caller retiring the runner
     * still has to send a stop to each one that was `starting`, `idle` or
     * `busy`. The caller runs it in a transaction.
     */
    endOnRunner: (
      runnerId: string,
      at: string,
    ): Effect.Effect<ReadonlyArray<StoredSession>, SqlError> =>
      endMatching(sql`runner_id = ${uuidFromString(runnerId)}`, at),

    /**
     * Ends every session on this runner that is `starting`, `idle` or `busy`
     * and is not in `held`, the list from the runner's sessions report.
     * Returns those rows as they were before. Only those three statuses are
     * affected, so a session already `exited`, or `queued` and never sent to
     * this runner, is left alone. The caller runs it in a transaction.
     */
    reportedGone: (
      runnerId: string,
      held: ReadonlyArray<string>,
      at: string,
    ): Effect.Effect<ReadonlyArray<StoredSession>, SqlError> =>
      endMatching(
        sql`runner_id = ${uuidFromString(runnerId)}
            AND status IN ('starting', 'idle', 'busy')
            AND ${held.length === 0 ? sql`1 = 1` : sql`id NOT IN ${sql.in(held.map(uuidFromString))}`}`,
        at,
      ),

    /**
     * Ends every running session on a lost runner: the runner is not in
     * `connected`, and nothing was heard about the session for longer than the
     * session's own absolute timeout. Returns those rows as they were before.
     * The caller runs it in a transaction.
     *
     * The absolute timeout is the bound because a runner stops every session
     * process at most that long after the process started, and
     * `last_activity_at` is never earlier than the start. Past the bound the
     * process is gone, or the runner is gone and can never report it. Before
     * the bound, the session can still run on a runner that is only out of
     * reach, and its token must keep working. One exception: a runner whose
     * machine was suspended does not count the suspended time, so its process
     * can outlive the bound. That runner lists the process in its report when
     * it returns, and the controller then stops it (`listToStopAmong`).
     *
     * A spec stored before the timeouts were on it has no absolute timeout, so
     * the default the runner applied to it at that time is the bound.
     */
    endOnLostRunners: (
      connected: ReadonlyArray<string>,
      at: string,
    ): Effect.Effect<ReadonlyArray<StoredSession>, SqlError> =>
      endMatching(
        sql`status IN ('starting', 'idle', 'busy')
            AND ${connected.length === 0 ? sql`1 = 1` : sql`runner_id NOT IN ${sql.in(connected.map(uuidFromString))}`}
            AND (julianday(${at}) - julianday(last_activity_at)) * 86400000
                > COALESCE(json_extract(spec, '$.timeouts.absoluteMs'), ${DEFAULT_ABSOLUTE_TIMEOUT_MS})`,
        at,
      ),

    /**
     * Returns the sessions in `held` (the runner's report) that the runner
     * should stop. The caller tells the runner to stop each one. They are:
     *
     * - the sessions the controller has already marked `exited`;
     * - the retired sessions that are idle, were claimed their flush once,
     *   and have no flush waiting to be sent again. The flush turn has ended,
     *   or its frame was lost with the connection, so the runner did not end
     *   the session itself. A flush turn that started while the runner was
     *   disconnected is cut short this way, because its `turn.started` was
     *   lost; the flush is then lost too, but never runs twice. A flush that
     *   went back to waiting, because its frame never left the controller,
     *   keeps its session alive to run it.
     */
    listToStopAmong: (
      runnerId: string,
      held: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      held.length === 0
        ? Effect.succeed([])
        : Effect.map(
            sql<{ readonly id: Uint8Array }>`
              SELECT id FROM sessions
              WHERE runner_id = ${uuidFromString(runnerId)}
                AND (status = 'exited'
                  OR (status = 'idle' AND retired_at IS NOT NULL AND flush_sent_at IS NOT NULL
                      AND NOT EXISTS (
                        SELECT 1 FROM session_inputs
                        WHERE session_inputs.session_id = sessions.id AND source = 'rotation'
                          AND status = 'queued' AND sent_at IS NULL)))
                AND id IN ${sql.in(held.map(uuidFromString))}
            `,
            (rows) => rows.map((row) => uuidToString(row.id)),
          ),
  };
});

export const sessionRepository = make;

/** The session repository's methods. */
export type SessionRows = Effect.Success<typeof make>;

/** The error message every caller uses for a session id that matches no row. */
const NO_SUCH_SESSION = "no such session";

/**
 * Returns a function that reads one session by id from the given repository.
 * It fails with `NotFound` when there is no such session, with the same
 * message wherever it is used.
 */
export const readSessionOrFail =
  (rows: SessionRows) =>
  (id: string): Effect.Effect<StoredSession, NotFound | SqlError> =>
    Effect.flatMap(
      rows.one(id),
      Option.match({
        onNone: () => Effect.fail(createNotFoundError(NO_SUCH_SESSION)),
        onSome: Effect.succeed,
      }),
    );
