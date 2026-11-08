/**
 * Reads and writes Initiative rows. Nothing here decides policy - who may
 * write, which hue a new Initiative takes, what a change means, what gets
 * announced.
 *
 * A list is one keyset query in creation order. The open list and the closed
 * list each write the exact `WHERE` condition of their partial index
 * (`initiatives_open`, `initiatives_closed`); SQLite only uses a partial index
 * when the query repeats its condition.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { Initiative, InitiativeHue } from "@hercule/contract";
import {
  mintUuid,
  buildPage,
  prepareKeysetListing,
  uuidFromString,
  uuidToString,
  type CursorError,
  type Page,
  type SortColumn,
} from "../db";

/**
 * The page size and cursor of an Initiative list, and which list it is: the
 * open Initiatives or the closed ones, optionally in one project's lane.
 */
export interface InitiativePageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly closed: boolean;
  readonly projectId: string | undefined;
}

/** Everything a new Initiative row holds. */
export interface NewInitiative {
  readonly name: string;
  readonly intent: string;
  readonly target: string | undefined;
  readonly targetDate: string | undefined;
  readonly hue: InitiativeHue;
  readonly projectId: string | undefined;
  readonly at: string;
  /** The actor stamp of the creator. */
  readonly by: string;
}

/** The columns an edit may set. A column that is absent is left unchanged; `null` clears it. */
export interface InitiativeEdit {
  readonly name?: string;
  readonly intent?: string;
  readonly target?: string | null;
  readonly targetDate?: string | null;
  readonly projectId?: string | null;
  readonly hue?: InitiativeHue;
}

interface InitiativeRow {
  readonly id: Uint8Array;
  readonly name: string;
  readonly intent: string;
  readonly target: string | null;
  readonly target_date: string | null;
  readonly hue: number;
  readonly project_id: Uint8Array | null;
  readonly closed_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const COLUMNS =
  "id, name, intent, target, target_date, hue, project_id, closed_at, created_at, updated_at";

/** Initiatives are listed in creation order only. */
const CREATED_AT_ASCENDING = [{ field: "createdAt", direction: "asc" }] as const;

const SORT_COLUMNS: Record<"createdAt", SortColumn<Initiative>> = {
  createdAt: {
    column: "created_at",
    valueType: "string",
    readValue: (initiative) => initiative.createdAt,
  },
};

// The cast is safe because only the service writes `hue`, and it writes a
// value its contract schema has checked against `INITIATIVE_HUES`.
const toInitiative = (row: InitiativeRow): Initiative => ({
  id: uuidToString(row.id),
  name: row.name,
  intent: row.intent,
  ...(row.target === null ? {} : { target: row.target }),
  ...(row.target_date === null ? {} : { targetDate: row.target_date }),
  hue: row.hue as InitiativeHue,
  ...(row.project_id === null ? {} : { projectId: uuidToString(row.project_id) }),
  ...(row.closed_at === null ? {} : { closedAt: row.closed_at }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /** Returns the Initiative with that id, or `None` if there is none or it has been deleted. */
    live: (id: string): Effect.Effect<Option.Option<Initiative>, SqlError> =>
      Effect.map(
        sql<InitiativeRow>`SELECT ${sql.literal(COLUMNS)} FROM initiatives
                           WHERE id = ${uuidFromString(id)} AND deleted_at IS NULL`,
        (rows) => Option.fromNullishOr(rows[0]).pipe(Option.map(toInitiative)),
      ),

    /** Inserts a new, open Initiative and returns it. */
    insert: (initiative: NewInitiative): Effect.Effect<Initiative, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        yield* sql`
          INSERT INTO initiatives (id, name, intent, target, target_date, hue, project_id,
                                   created_at, updated_at, created_by, updated_by)
          VALUES (${id}, ${initiative.name}, ${initiative.intent}, ${initiative.target ?? null},
                  ${initiative.targetDate ?? null}, ${initiative.hue},
                  ${initiative.projectId === undefined ? null : uuidFromString(initiative.projectId)},
                  ${initiative.at}, ${initiative.at}, ${initiative.by}, ${initiative.by})
        `;
        return {
          id: uuidToString(id),
          name: initiative.name,
          intent: initiative.intent,
          ...(initiative.target === undefined ? {} : { target: initiative.target }),
          ...(initiative.targetDate === undefined ? {} : { targetDate: initiative.targetDate }),
          hue: initiative.hue,
          ...(initiative.projectId === undefined ? {} : { projectId: initiative.projectId }),
          createdAt: initiative.at,
          updatedAt: initiative.at,
        };
      }),

    /** Applies an edit. Only the columns set in the edit are written, plus `updated_at` and `updated_by`. */
    update: (
      id: string,
      edit: InitiativeEdit,
      at: string,
      by: string,
    ): Effect.Effect<void, SqlError> => {
      const sets = [sql`updated_at = ${at}`, sql`updated_by = ${by}`];
      if (edit.name !== undefined) sets.push(sql`name = ${edit.name}`);
      if (edit.intent !== undefined) sets.push(sql`intent = ${edit.intent}`);
      if (edit.target !== undefined) sets.push(sql`target = ${edit.target}`);
      if (edit.targetDate !== undefined) sets.push(sql`target_date = ${edit.targetDate}`);
      if (edit.hue !== undefined) sets.push(sql`hue = ${edit.hue}`);
      if (edit.projectId !== undefined) {
        sets.push(
          sql`project_id = ${edit.projectId === null ? null : uuidFromString(edit.projectId)}`,
        );
      }
      return Effect.asVoid(
        sql`UPDATE initiatives SET ${sql.csv(sets)} WHERE id = ${uuidFromString(id)}`,
      );
    },

    /** Sets `closed_at` to `closedAt`, or clears it when `closedAt` is `null`. */
    setClosedAt: (
      id: string,
      closedAt: string | null,
      at: string,
      by: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        sql`UPDATE initiatives
            SET closed_at = ${closedAt}, updated_at = ${at}, updated_by = ${by}
            WHERE id = ${uuidFromString(id)}`,
      ),

    /** Marks the Initiative deleted. The row stays. */
    softDelete: (id: string, at: string, by: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        sql`UPDATE initiatives
            SET deleted_at = ${at}, updated_at = ${at}, updated_by = ${by}
            WHERE id = ${uuidFromString(id)}`,
      ),

    /**
     * Returns how many open Initiatives (not closed, not deleted) use each hue.
     * A hue no open Initiative uses is absent.
     */
    countOpenByHue: (): Effect.Effect<ReadonlyMap<number, number>, SqlError> =>
      Effect.map(
        sql<{ readonly hue: number; readonly uses: number }>`
          SELECT hue, COUNT(*) AS uses FROM initiatives
          WHERE deleted_at IS NULL AND closed_at IS NULL
          GROUP BY hue
        `,
        (rows) => new Map(rows.map((row) => [row.hue, row.uses])),
      ),

    /**
     * Returns one page of the open Initiatives, or of the closed ones, in
     * creation order. Fails with a `CursorError` if the cursor is invalid.
     */
    list: (
      request: InitiativePageRequest,
    ): Effect.Effect<Page<Initiative>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const { keyset, order, encodeNextCursor } = yield* prepareKeysetListing(
          sql,
          "initiative.query",
          CREATED_AT_ASCENDING,
          SORT_COLUMNS,
          "id",
          request.cursor,
        );
        const inLane =
          request.projectId === undefined
            ? sql`1 = 1`
            : sql`project_id = ${uuidFromString(request.projectId)}`;
        // The two conditions repeat the partial indexes' conditions exactly.
        const state = request.closed
          ? sql`deleted_at IS NULL AND closed_at IS NOT NULL`
          : sql`deleted_at IS NULL AND closed_at IS NULL`;
        const rows = yield* sql<InitiativeRow>`
          SELECT ${sql.literal(COLUMNS)} FROM initiatives
          WHERE ${state} AND ${inLane} AND ${keyset} ${order} LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(
          rows,
          request.limit,
          (page) => Effect.succeed(page.map(toInitiative)),
          encodeNextCursor,
        );
      }),
  };
});

/** The repository for Initiative rows, used by the Initiative service. */
export const initiativeRepository = make;
