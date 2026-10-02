/**
 * Reads and writes the `oauth_setups` table: OAuth flows where the browser has
 * gone to the provider and not come back yet.
 *
 * A row is looked up by `state` alone, because that is the only value the
 * provider sends back. A row is deleted when it is used, not marked as used, so
 * a `state` presented a second time finds nothing.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { uuidFromString } from "../db";
import { parseSetupTargetRow, type SetupTargetRow, type StoredSetupTarget } from "./setup-target";

/** A pending setup, with its JSON columns read. */
export interface StoredSetup extends StoredSetupTarget {
  readonly state: string;
  readonly origin: string;
  readonly codeVerifier: string;
}

/** Everything a new flow stores. */
export interface NewSetup extends StoredSetup {
  readonly expiresAt: string;
  readonly createdAt: string;
}

interface SetupRow extends SetupTargetRow {
  readonly state: string;
  readonly origin: string;
  readonly code_verifier: string;
}

const COLUMNS = "state, type, connection_id, label, labels, config, origin, code_verifier";

const parseSetupRow = (row: SetupRow): StoredSetup => ({
  ...parseSetupTargetRow(row),
  state: row.state,
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
           ${setup.origin}, ${setup.codeVerifier}, ${setup.expiresAt}, ${setup.createdAt})
      `),

    /**
     * Returns the setup for this `state` if it has not expired, and deletes the
     * row either way, so a `state` can be used only once.
     */
    consume: (state: string, now: string): Effect.Effect<Option.Option<StoredSetup>, SqlError> =>
      Effect.gen(function* () {
        const rows = yield* sql<SetupRow>`
          SELECT ${sql.literal(COLUMNS)} FROM oauth_setups
          WHERE state = ${state} AND expires_at > ${now}
        `;
        yield* sql`DELETE FROM oauth_setups WHERE state = ${state}`;
        return Option.fromNullishOr(rows[0]).pipe(Option.map(parseSetupRow));
      }),

    /**
     * Deletes the expired rows: flows the user never came back from. Called on
     * each new start rather than on a timer.
     */
    deleteExpired: (now: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`DELETE FROM oauth_setups WHERE expires_at <= ${now}`),
  };
});

export const oauthSetupRepository = make;
