/**
 * Reads and writes the `oauth_setups` table: OAuth flows where the browser has
 * gone to the provider and not come back yet.
 *
 * A row is looked up by `state` alone, because that is the only value the
 * provider sends back. A row is deleted when it is used, not marked as used, so
 * a `state` presented a second time finds nothing.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  buildSetupTargetRow,
  parseSetupTargetRow,
  type SetupTargetRow,
  type StoredSetupTarget,
} from "./setup-target";

/** A pending setup, with its JSON columns read. */
export type StoredSetup = StoredSetupTarget & {
  readonly state: string;
  /**
   * The browser's origin, when the browser comes back to the controller. For
   * a flow that comes back to the user's own machine, the origin of
   * `redirectUri`.
   */
  readonly origin: string;
  /**
   * The exact redirect URI of a flow whose browser comes back to the user's
   * own machine, and `undefined` for a flow that comes back to the controller
   * (and for every flow started before this column existed). Its presence is
   * what tells the two kinds of flow apart.
   */
  readonly redirectUri: string | undefined;
  /** The id of the OAuth client the type's plugin created for this flow, or reused from the Connection. */
  readonly clientId: string | undefined;
  /** Who started the flow: `user` or `session:<id>`. `undefined` for a flow that started before this column existed, which the user started. */
  readonly actor: string | undefined;
  /** The Connection's credentials generation when a reconnect started. `undefined` for a new Connection. */
  readonly credentialsGeneration: number | undefined;
  readonly codeVerifier: string;
};

/** Everything a new flow stores. */
export type NewSetup = StoredSetup & {
  readonly expiresAt: string;
  readonly createdAt: string;
};

/**
 * What `consume` found.
 *
 * - `claimed`: the flow is live and `check` accepted it. The row is deleted.
 * - `refused`: the flow is live and `check` refused it with `reason`. The row
 *   stays, so the caller that does own the flow can still finish it.
 * - `none`: no flow has this `state`, or it has expired. An expired row is
 *   deleted.
 */
export type SetupClaim<Reason> =
  | { readonly _tag: "claimed"; readonly setup: StoredSetup }
  | { readonly _tag: "refused"; readonly reason: Reason }
  | { readonly _tag: "none" };

interface SetupRow extends SetupTargetRow {
  readonly state: string;
  readonly origin: string;
  readonly redirect_uri: string | null;
  readonly client_id: string | null;
  readonly actor: string | null;
  readonly credentials_generation: number | null;
  readonly code_verifier: string;
  readonly expires_at: string;
}

const COLUMNS =
  "state, type, connection_id, label, labels, config, origin, redirect_uri, client_id, actor, " +
  "credentials_generation, code_verifier, expires_at";

const parseSetupRow = (row: SetupRow): StoredSetup => ({
  ...parseSetupTargetRow(row),
  state: row.state,
  origin: row.origin,
  redirectUri: row.redirect_uri ?? undefined,
  clientId: row.client_id ?? undefined,
  actor: row.actor ?? undefined,
  credentialsGeneration: row.credentials_generation ?? undefined,
  codeVerifier: row.code_verifier,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    insert: (setup: NewSetup): Effect.Effect<void, SqlError> => {
      const target = buildSetupTargetRow(setup);
      return Effect.asVoid(sql`
        INSERT INTO oauth_setups
          (state, type, connection_id, label, labels, config, origin, redirect_uri, client_id,
           actor, credentials_generation, code_verifier, expires_at, created_at)
        VALUES
          (${setup.state}, ${target.type}, ${target.connection_id}, ${target.label},
           ${target.labels}, ${target.config}, ${setup.origin}, ${setup.redirectUri ?? null},
           ${setup.clientId ?? null}, ${setup.actor ?? null},
           ${setup.credentialsGeneration ?? null}, ${setup.codeVerifier},
           ${setup.expiresAt}, ${setup.createdAt})
      `);
    },

    /**
     * Claims the setup for this `state`, so a `state` can be used only once.
     *
     * An expired row is deleted and found as `none`. A live row is passed to
     * `check`, which returns the reason the caller may not have it, or
     * `undefined` to accept it. Only an accepted row is deleted: a caller that
     * does not own the flow must not be able to end it.
     */
    consume: <Reason>(
      state: string,
      now: string,
      check: (setup: StoredSetup) => Reason | undefined,
    ): Effect.Effect<SetupClaim<Reason>, SqlError> =>
      Effect.gen(function* () {
        const rows = yield* sql<SetupRow>`
          SELECT ${sql.literal(COLUMNS)} FROM oauth_setups WHERE state = ${state}
        `;
        const row = rows[0];
        if (row === undefined) return { _tag: "none" } as const;
        if (row.expires_at <= now) {
          yield* sql`DELETE FROM oauth_setups WHERE state = ${state}`;
          return { _tag: "none" } as const;
        }
        const setup = parseSetupRow(row);
        const reason = check(setup);
        if (reason !== undefined) return { _tag: "refused", reason } as const;
        yield* sql`DELETE FROM oauth_setups WHERE state = ${state}`;
        return { _tag: "claimed", setup } as const;
      }),

    /**
     * Deletes the setup for this `state`, whether or not it has expired.
     * Succeeds when there is no such row. The controller ends a sign-in with
     * it, so that a finish that comes later finds nothing, whatever the clock
     * says then.
     */
    remove: (state: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`DELETE FROM oauth_setups WHERE state = ${state}`),

    /**
     * Deletes the expired rows: flows the user never came back from. Called on
     * each new start rather than on a timer.
     */
    deleteExpired: (now: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`DELETE FROM oauth_setups WHERE expires_at <= ${now}`),
  };
});

export const oauthSetupRepository = make;
