/**
 * Agent rows. This module only reads and writes them. It decides no policy: who
 * may write, what a value means and whether a delete is allowed are the
 * service's questions.
 *
 * A listing is one walk: a keyset over `created_at` and the id, which the index
 * on `agents` serves. The permission profile narrows that walk; there is no
 * search, so a second walk is not necessary.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { SortDirection } from "@hercule/contract";
import type { AccessMode, DisallowedTool, ModelSelection } from "@hercule/protocol";
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

/**
 * Everything a new agent row holds. Derived from the stored agent so the two
 * cannot drift: the id and the two timestamps are written here rather than
 * given, and the provider is known because the instance was just read.
 */
export interface NewAgent extends Omit<
  StoredAgent,
  "id" | "providerId" | "createdAt" | "updatedAt"
> {
  readonly providerId: string;
  /** The instant the row is created; it is its `createdAt` and its `updatedAt`. */
  readonly at: string;
}

/**
 * The columns an edit may set. An absent column is left as it was. Derived from
 * the stored agent for the same reason: a column added there is a column an
 * edit may set, unless it is the id, the provider or a timestamp.
 */
export type AgentEdit = Partial<Omit<StoredAgent, "id" | "providerId" | "createdAt" | "updatedAt">>;

export interface AgentPageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: SortDirection;
  /** Only the agents that spawn their sessions under this profile. */
  readonly permissionProfileId: string | undefined;
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

const buildCursorScope = (direction: SortDirection): CursorScope => ({
  op: "agent.query",
  field: "createdAt",
  direction,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    read: (id: string): Effect.Effect<Option.Option<StoredAgent>, SqlError> =>
      Effect.map(
        sql<AgentRow>`SELECT ${sql.literal(COLUMNS)} FROM agents WHERE id = ${uuidFromString(id)}`,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), toAgent),
      ),

    /** Returns the subset of `ids` that belong to an existing Agent, using one query. */
    readExistingIds: (ids: ReadonlyArray<string>): Effect.Effect<ReadonlySet<string>, SqlError> =>
      ids.length === 0
        ? Effect.succeed(new Set())
        : Effect.map(
            sql<{ readonly id: Uint8Array }>`
              SELECT id FROM agents WHERE id IN ${sql.in(ids.map(uuidFromString))}
            `,
            (rows) => new Set(rows.map((row) => uuidToString(row.id))),
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
      const assignments = [sql`updated_at = ${at}`];
      if (edit.name !== undefined) assignments.push(sql`name = ${edit.name}`);
      if (edit.systemPrompt !== undefined)
        assignments.push(sql`system_prompt = ${edit.systemPrompt}`);
      if (edit.instanceId !== undefined) {
        assignments.push(sql`instance_id = ${uuidFromString(edit.instanceId)}`);
      }
      if (edit.permissionProfileId !== undefined) {
        assignments.push(sql`permission_profile_id = ${uuidFromString(edit.permissionProfileId)}`);
      }
      if (edit.accessMode !== undefined) assignments.push(sql`access_mode = ${edit.accessMode}`);
      if (edit.model !== undefined) {
        assignments.push(
          sql`model_selection = ${edit.model === null ? null : JSON.stringify(edit.model)}`,
        );
      }
      if (edit.disallowedTools !== undefined) {
        assignments.push(sql`disallowed_tools = ${JSON.stringify(edit.disallowedTools)}`);
      }
      return Effect.asVoid(
        sql`UPDATE agents SET ${sql.csv(assignments)} WHERE id = ${uuidFromString(id)}`,
      );
    },

    /** Removes the agent. The sessions it spawned keep its id as their lineage. */
    delete: (id: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`DELETE FROM agents WHERE id = ${uuidFromString(id)}`),

    list: (request: AgentPageRequest): Effect.Effect<Page<StoredAgent>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope = buildCursorScope(request.direction);
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
        const clauses = [keyset];
        if (request.permissionProfileId !== undefined) {
          clauses.push(sql`permission_profile_id = ${uuidFromString(request.permissionProfileId)}`);
        }
        const rows = yield* sql<AgentRow>`
          SELECT ${sql.literal(COLUMNS)} FROM agents WHERE ${sql.and(clauses)} ${order}
          LIMIT ${request.limit + 1}
        `;
        return yield* pageOf(
          rows,
          request.limit,
          (page) => Effect.succeed(page.map(toAgent)),
          (last) => encodeCursor(scope, last.createdAt, last.id),
        );
      }),
  };
});

/** Everything the agent service reads and writes. */
export const agentRepository = make;
