/**
 * The `oauth_setups` table: redirect flows that have left for the provider and
 * not come back yet.
 *
 * Rows are resolved by `state` alone, because that is the only thing the
 * provider hands back, and consumed rather than marked: a state that has been
 * presented once is gone, so the second presentation cannot buy anything.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { uuidFromString, uuidToString } from "../db";

/** A pending setup, with its JSON columns read. */
export interface StoredSetup {
  readonly state: string;
  /** The qualified type, which names the plugin that owns the flow as well. */
  readonly type: string;
  /** Set when the flow reconnects a connection that already exists. */
  readonly connectionId: string | undefined;
  readonly label: string;
  readonly labels: ReadonlyArray<string>;
  readonly config: Record<string, Schema.Json>;
  readonly origin: string;
  readonly codeVerifier: string;
}

/** Everything a started flow writes down. */
export interface NewSetup extends StoredSetup {
  readonly expiresAt: string;
  readonly at: string;
}

interface SetupRow {
  readonly state: string;
  readonly type: string;
  readonly connection_id: Uint8Array | null;
  readonly label: string;
  readonly labels: string;
  readonly config: string;
  readonly origin: string;
  readonly code_verifier: string;
}

const COLUMNS = "state, type, connection_id, label, labels, config, origin, code_verifier";

/** Written by this repository alone, so a column that does not parse is a broken database. */
const parseJson = <A>(text: string): A => JSON.parse(text) as A;

const toSetup = (row: SetupRow): StoredSetup => ({
  state: row.state,
  type: row.type,
  connectionId: row.connection_id === null ? undefined : uuidToString(row.connection_id),
  label: row.label,
  labels: parseJson<ReadonlyArray<string>>(row.labels),
  config: parseJson<Record<string, Schema.Json>>(row.config),
  origin: row.origin,
  codeVerifier: row.code_verifier,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    insert: (setup: NewSetup): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        INSERT INTO oauth_setups
          (state, type, connection_id, label, labels, config, origin, code_verifier,
           expires_at, created_at)
        VALUES
          (${setup.state}, ${setup.type},
           ${setup.connectionId === undefined ? null : uuidFromString(setup.connectionId)},
           ${setup.label}, ${JSON.stringify(setup.labels)}, ${JSON.stringify(setup.config)},
           ${setup.origin}, ${setup.codeVerifier}, ${setup.expiresAt}, ${setup.at})
      `),

    /**
     * Takes the row this state names, if it is still good for one. The delete
     * runs whether or not the row had run out of time: either way it is spent.
     */
    consume: (state: string, at: string): Effect.Effect<Option.Option<StoredSetup>, SqlError> =>
      Effect.gen(function* () {
        const rows = yield* sql<SetupRow>`
          SELECT ${sql.literal(COLUMNS)} FROM oauth_setups
          WHERE state = ${state} AND expires_at > ${at}
        `;
        yield* sql`DELETE FROM oauth_setups WHERE state = ${state}`;
        return Option.fromNullishOr(rows[0]).pipe(Option.map(toSetup));
      }),

    /** Rows nobody came back for. Swept on each start rather than on a timer. */
    sweep: (at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`DELETE FROM oauth_setups WHERE expires_at <= ${at}`),
  };
});

export const oauthSetupRepository = make;
