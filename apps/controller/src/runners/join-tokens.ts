/**
 * Join tokens: minting one, and spending it.
 *
 * A join token is the same kind of thing as every other credential Hydra
 * issues - 32 random bytes, stored as a SHA-256 hash - so it is minted and
 * hashed by `../credentials/token.ts` rather than by a second implementation.
 * The plaintext exists only in the answer that returns it.
 *
 * Minting lives here, at the repository, because the two callers are not alike:
 * `runner.createJoinToken` has a user behind it, and the controller's first
 * boot has nobody at all - it mints a token for the local runner it is about to
 * spawn. Neither may be the only place that knows how a token is made.
 *
 * Spending is one statement on purpose. Single use is the whole security
 * property of a join token, and a read followed by a write would let two
 * machines that presented the same token both pass the read.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { hashToken, mintToken } from "../credentials";
import { mintUuid, uuidToString } from "../db";

/**
 * How long a join token is good for. Long enough to walk to the other machine
 * and type the command, short enough that a token left in a chat window is
 * worthless by the time anyone else reads it.
 */
export const JOIN_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

/** A minted token, the invitation it belongs to, and when it stops being one. */
export interface JoinToken {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: string;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /**
     * Mints a token good for an hour and records its hash.
     *
     * The rows that have already expired go with it. Nothing lists or revokes
     * an outstanding token, so this sweep is the only thing that bounds the
     * table; a token past its hour can never be spent again, so nothing is lost
     * with it.
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
     * Spends a presented token, and answers which invitation it was. A token
     * that was never minted, one already used and one past its hour all answer
     * `None`: the presenter learns nothing from the difference, and there is
     * nothing different for it to do.
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

/** The join-token repository. */
export class JoinTokens extends Context.Service<JoinTokens, Effect.Success<typeof make>>()(
  "hydra/controller/runners/JoinTokens",
) {}

export const JoinTokensLayer: Layer.Layer<JoinTokens, never, SqlClient.SqlClient> =
  Layer.effect(JoinTokens)(make);
