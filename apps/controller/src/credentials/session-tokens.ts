/**
 * Session tokens: the credential one session proves itself with.
 *
 * Minted when a session is dispatched, carried to the machine on the frame that
 * starts it, and dead the moment that session exits. Only the hash is stored,
 * like every other credential Hydra issues, so a copy of the database hands
 * nobody a working one; a resume mints a fresh token rather than reviving the
 * one the previous process held.
 *
 * What it authorizes today is the git credential exchange and nothing else, and
 * the one place a presented token is looked up is that exchange's own query, so
 * nothing here hands a session id back. The permission profile it is meant to
 * carry is the session-token ticket's.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { uuidFromString } from "../db";
import { hashToken, mintToken } from "./token";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /**
     * A fresh token for this session, and the end of whatever it held before:
     * a session has one live token, the one its running process was given.
     */
    mint: (sessionId: string, at: string): Effect.Effect<string, SqlError> =>
      Effect.gen(function* () {
        const key = uuidFromString(sessionId);
        yield* sql`
          UPDATE session_tokens SET revoked_at = ${at}
          WHERE session_id = ${key} AND revoked_at IS NULL
        `;
        const token = mintToken();
        yield* sql`
          INSERT INTO session_tokens (token_hash, session_id, created_at)
          VALUES (${hashToken(token)}, ${key}, ${at})
        `;
        return token;
      }),

    /** Nothing this session was given works after this. */
    revoke: (sessionId: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE session_tokens SET revoked_at = ${at}
        WHERE session_id = ${uuidFromString(sessionId)} AND revoked_at IS NULL
      `),
  };
});

/** Where a session's own credential is minted, revoked and looked up. */
export const sessionTokenRepository = make;
