/**
 * Join tokens: creating one, and spending it.
 *
 * Creation lives in the repository because its two callers differ: one has a
 * user behind it, and the first boot has nobody at all. Neither caller should
 * be the only place that knows how a token is made.
 *
 * Spending is one statement on purpose. Single use is the whole security
 * guarantee, and a read followed by a write would let two runners presenting
 * the same token both pass the read.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { JoinTokenRef } from "@hercule/contract";
import { hashToken, mintToken } from "../credentials";
import { mintUuid, uuidFromString, uuidToString } from "../db";

/**
 * How long a join token is valid. Long enough to walk to the other machine and
 * type the command, short enough that a token left in a chat window is useless
 * by the time anyone reads it.
 */
export const JOIN_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

export interface JoinToken {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: string;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /**
     * Creates a join token and returns it with its id and expiry time. It also
     * deletes expired tokens: an expired token can never be spent, and a table
     * nothing cleans up would grow for the life of the controller.
     */
    create: (at: string): Effect.Effect<JoinToken, SqlError> =>
      Effect.gen(function* () {
        const token = mintToken();
        const id = mintUuid();
        const expiresAt = new Date(Date.parse(at) + JOIN_TOKEN_LIFETIME_MS).toISOString();
        yield* sql`DELETE FROM runner_join_tokens WHERE expires_at <= ${at}`;
        yield* sql`
          INSERT INTO runner_join_tokens (id, token_hash, created_at, expires_at, used_at)
          VALUES (${id}, ${hashToken(token)}, ${at}, ${expiresAt}, NULL)
        `;
        return { id: uuidToString(id), token, expiresAt };
      }),

    /**
     * Returns the join tokens that can still be spent, newest first. A spent or
     * expired token is useless to whoever holds it, so neither is listed or can
     * be revoked.
     */
    outstanding: (at: string): Effect.Effect<ReadonlyArray<JoinTokenRef>, SqlError> =>
      Effect.map(
        sql<{
          readonly id: Uint8Array;
          readonly created_at: string;
          readonly expires_at: string;
        }>`
          SELECT id, created_at, expires_at FROM runner_join_tokens
          WHERE used_at IS NULL AND expires_at > ${at}
          ORDER BY created_at DESC, id DESC
        `,
        (rows) =>
          rows.map((row) => ({
            id: uuidToString(row.id),
            createdAt: row.created_at,
            expiresAt: row.expires_at,
          })),
      ),

    /**
     * Revokes a join token by deleting it. Returns `false` for a token that was
     * never created, already revoked, already spent, or already expired: none
     * of these can be spent, and the caller does the same thing in every case.
     */
    revoke: (id: string, at: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          DELETE FROM runner_join_tokens
          WHERE id = ${uuidFromString(id)} AND used_at IS NULL AND expires_at > ${at}
          RETURNING id
        `,
        (deleted) => deleted.length > 0,
      ),

    /**
     * Marks a join token as used and returns its id. Returns `None` for a token
     * that was never created, revoked, already used, or expired: the caller
     * learns nothing from the difference, and does the same thing in every case.
     */
    spend: (token: string, at: string): Effect.Effect<Option.Option<string>, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          UPDATE runner_join_tokens SET used_at = ${at}
          WHERE token_hash = ${hashToken(token)} AND used_at IS NULL AND expires_at > ${at}
          RETURNING id
        `,
        (spent) => Option.fromNullishOr(spent[0]).pipe(Option.map((row) => uuidToString(row.id))),
      ),
  };
});

export class JoinTokens extends Context.Service<JoinTokens, Effect.Success<typeof make>>()(
  "hercule/controller/runners/JoinTokens",
) {}

export const JoinTokensLayer: Layer.Layer<JoinTokens, never, SqlClient.SqlClient> =
  Layer.effect(JoinTokens)(make);
