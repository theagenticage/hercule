/**
 * Agent rows. Nothing here decides policy - who may write, what a value means,
 * whether a delete is allowed - it only reads and writes.
 *
 * One walk answers a listing: a keyset over `created_at` plus the id, which the
 * index on `agents` serves. There is no filter and no search, so there is no
 * second walk.
 *
 * The last read below is over the sessions table rather than this one. It is
 * the one question a delete has to ask - is anything this agent spawned still
 * running - and the agents domain may not import the sessions domain, so it
 * asks the database directly, as the session listing asks after the provider
 * instance behind a session.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { SortDirection } from "@hydra/contract";
import type { AccessMode, DisallowedTool, ModelSelection } from "@hydra/protocol";
import {
  decodeCursor,
  encodeCursor,
  keysetOver,
  mintUuid,
  pageOf,
  uuidFromString,
  uuidToString,
  type CursorError,
  type CursorScope,
  type Page,
} from "../db";

/** An agent as it is stored; `unenforced` is derived at read and is not here. */
export interface StoredAgent {
  readonly id: string;
  /** The provider behind its instance, read for what that provider will not enforce; `null` once the instance is gone. */
  readonly providerId: string | null;
  readonly name: string;
  readonly systemPrompt: string;
  readonly instanceId: string;
  readonly permissionProfileId: string;
  readonly accessMode: AccessMode;
  readonly model: ModelSelection | null;
  readonly disallowedTools: ReadonlyArray<DisallowedTool>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Everything a new agent row holds, plus the provider its instance runs. */
export interface NewAgent {
  readonly providerId: string;
  readonly name: string;
  readonly systemPrompt: string;
  readonly instanceId: string;
  readonly permissionProfileId: string;
  readonly accessMode: AccessMode;
  readonly model: ModelSelection | null;
  readonly disallowedTools: ReadonlyArray<DisallowedTool>;
  readonly at: string;
}

/** The columns an edit may set. An absent one is left as it was. */
export interface AgentEdit {
  readonly name?: string;
  readonly systemPrompt?: string;
  readonly instanceId?: string;
  readonly permissionProfileId?: string;
  readonly accessMode?: AccessMode;
  readonly model?: ModelSelection | null;
  readonly disallowedTools?: ReadonlyArray<DisallowedTool>;
}

export interface AgentPageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: SortDirection;
}

interface AgentRow {
  readonly id: Uint8Array;
  readonly provider_id: string | null;
  readonly name: string;
  readonly system_prompt: string;
  readonly instance_id: Uint8Array;
  readonly permission_profile_id: Uint8Array;
  readonly access_mode: string;
  readonly model_selection: string | null;
  readonly disallowed_tools: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const COLUMNS =
  "id, name, system_prompt, instance_id, permission_profile_id, access_mode, " +
  "model_selection, disallowed_tools, created_at, updated_at, " +
  // Which provider is behind the instance, which is what says whether that
  // provider will act on the tool families below.
  "(SELECT provider_id FROM provider_instances WHERE id = agents.instance_id) AS provider_id";

const toAgent = (row: AgentRow): StoredAgent => ({
  id: uuidToString(row.id),
  providerId: row.provider_id,
  name: row.name,
  systemPrompt: row.system_prompt,
  instanceId: uuidToString(row.instance_id),
  permissionProfileId: uuidToString(row.permission_profile_id),
  accessMode: row.access_mode as AccessMode,
  model: row.model_selection === null ? null : (JSON.parse(row.model_selection) as ModelSelection),
  disallowedTools: JSON.parse(row.disallowed_tools) as ReadonlyArray<DisallowedTool>,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const scopeOf = (direction: SortDirection): CursorScope => ({
  op: "agent.query",
  field: "createdAt",
  direction,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    one: (id: string): Effect.Effect<Option.Option<StoredAgent>, SqlError> =>
      Effect.map(
        sql<AgentRow>`SELECT ${sql.literal(COLUMNS)} FROM agents WHERE id = ${uuidFromString(id)}`,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), toAgent),
      ),

    insert: (agent: NewAgent): Effect.Effect<StoredAgent, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        yield* sql`
          INSERT INTO agents (id, name, system_prompt, instance_id, permission_profile_id,
                              access_mode, model_selection, disallowed_tools,
                              created_at, updated_at)
          VALUES (${id}, ${agent.name}, ${agent.systemPrompt},
                  ${uuidFromString(agent.instanceId)},
                  ${uuidFromString(agent.permissionProfileId)}, ${agent.accessMode},
                  ${agent.model === null ? null : JSON.stringify(agent.model)},
                  ${JSON.stringify(agent.disallowedTools)}, ${agent.at}, ${agent.at})
        `;
        return {
          id: uuidToString(id),
          providerId: agent.providerId,
          name: agent.name,
          systemPrompt: agent.systemPrompt,
          instanceId: agent.instanceId,
          permissionProfileId: agent.permissionProfileId,
          accessMode: agent.accessMode,
          model: agent.model,
          disallowedTools: agent.disallowedTools,
          createdAt: agent.at,
          updatedAt: agent.at,
        };
      }),

    /** Applies an edit. Only the columns the edit names are written. */
    update: (id: string, edit: AgentEdit, at: string): Effect.Effect<void, SqlError> => {
      const sets = [sql`updated_at = ${at}`];
      if (edit.name !== undefined) sets.push(sql`name = ${edit.name}`);
      if (edit.systemPrompt !== undefined) sets.push(sql`system_prompt = ${edit.systemPrompt}`);
      if (edit.instanceId !== undefined) {
        sets.push(sql`instance_id = ${uuidFromString(edit.instanceId)}`);
      }
      if (edit.permissionProfileId !== undefined) {
        sets.push(sql`permission_profile_id = ${uuidFromString(edit.permissionProfileId)}`);
      }
      if (edit.accessMode !== undefined) sets.push(sql`access_mode = ${edit.accessMode}`);
      if (edit.model !== undefined) {
        sets.push(
          sql`model_selection = ${edit.model === null ? null : JSON.stringify(edit.model)}`,
        );
      }
      if (edit.disallowedTools !== undefined) {
        sets.push(sql`disallowed_tools = ${JSON.stringify(edit.disallowedTools)}`);
      }
      return Effect.asVoid(
        sql`UPDATE agents SET ${sql.csv(sets)} WHERE id = ${uuidFromString(id)}`,
      );
    },

    /** Removes the agent. The sessions it spawned keep its id as their lineage. */
    delete: (id: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`DELETE FROM agents WHERE id = ${uuidFromString(id)}`),

    list: (request: AgentPageRequest): Effect.Effect<Page<StoredAgent>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope = scopeOf(request.direction);
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(request.cursor, scope, "string");
        const { keyset, order } = keysetOver(
          sql,
          ["created_at", "id"],
          after === undefined ? undefined : [after[0], uuidFromString(after[1])],
          request.direction,
        );
        const rows = yield* sql<AgentRow>`
          SELECT ${sql.literal(COLUMNS)} FROM agents WHERE ${keyset} ${order}
          LIMIT ${request.limit + 1}
        `;
        return yield* pageOf(
          rows,
          request.limit,
          (page) => Effect.succeed(page.map(toAgent)),
          (last) => encodeCursor(scope, last.createdAt, last.id),
        );
      }),

    /**
     * The oldest session this agent spawned that has not exited, if there is
     * one: what a delete is refused for, named so the caller knows what to end
     * first.
     */
    oldestRunningSessionOf: (agentId: string): Effect.Effect<Option.Option<string>, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          SELECT id FROM sessions
          WHERE agent_id = ${uuidFromString(agentId)} AND status <> 'exited'
          ORDER BY created_at, id LIMIT 1
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), (row) => uuidToString(row.id)),
      ),
  };
});

/** Everything the agent service reads and writes. */
export const agentRepository = make;
