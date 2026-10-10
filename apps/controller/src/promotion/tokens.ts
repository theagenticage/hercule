/**
 * Promotion tokens: creating one, spending it, and looking it up.
 *
 * A promotion token lets another machine pull this controller's data with
 * `hercule promote`. It can be spent once, like a join token. Creating a new
 * one invalidates any earlier one that has not been spent. Only the token's
 * hash is stored.
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
 * How long a promotion token is valid. Long enough to walk to the other
 * machine and run the command, short enough that a token left visible is
 * useless soon after.
 */
export const PROMOTION_TOKEN_LIFETIME_MS = 15 * 60 * 1000;

/** A promotion token just created: the token text is shown to the user once. */
export interface PromotionToken {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: string;
}

/** A promotion token that was just spent on a transfer. */
export interface SpentToken {
  readonly id: string;
  readonly expiresAt: string;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /**
     * Creates a promotion token and returns it with its id and expiry time.
     * Any earlier unused token is invalidated: only the most recently created
     * token can be spent. Expired tokens are deleted.
     */
    create: (at: string): Effect.Effect<PromotionToken, SqlError> =>
      Effect.gen(function* () {
        const token = mintToken();
        const id = mintUuid();
        const expiresAt = new Date(Date.parse(at) + PROMOTION_TOKEN_LIFETIME_MS).toISOString();

        yield* sql`DELETE FROM promotion_tokens WHERE expires_at <= ${at}`;
        yield* sql`DELETE FROM promotion_tokens WHERE used_at IS NULL`;

        yield* sql`
          INSERT INTO promotion_tokens (id, token_hash, created_at, expires_at, used_at)
          VALUES (${id}, ${hashToken(token)}, ${at}, ${expiresAt}, NULL)
        `;
        return { id: uuidToString(id), token, expiresAt };
      }),

    /**
     * Marks a promotion token as used and returns its id and expiry. Returns
     * `None` for a token that was never created, invalidated, already used, or
     * expired.
     */
    spend: (token: string, at: string): Effect.Effect<Option.Option<SpentToken>, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array; readonly expires_at: string }>`
          UPDATE promotion_tokens SET used_at = ${at}
          WHERE token_hash = ${hashToken(token)} AND used_at IS NULL AND expires_at > ${at}
          RETURNING id, expires_at
        `,
        (spent) =>
          Option.fromNullishOr(spent[0]).pipe(
            Option.map((row) => ({ id: uuidToString(row.id), expiresAt: row.expires_at })),
          ),
      ),

    /**
     * Returns the id of a live unused token. Returns `None` when the token was
     * never created, was invalidated, was already spent, or has expired.
     */
    lookupLive: (token: string, at: string): Effect.Effect<Option.Option<string>, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          SELECT id FROM promotion_tokens
          WHERE token_hash = ${hashToken(token)} AND used_at IS NULL AND expires_at > ${at}
        `,
        (rows) => Option.fromNullishOr(rows[0]).pipe(Option.map((row) => uuidToString(row.id))),
      ),

    /**
     * Returns the id of a spent token, expired or not. Returns `None` when the
     * token was never created, was invalidated, or has not been spent.
     *
     * The lifetime is not checked here, because the freeze enforces it: a
     * freeze ends at the token's expiry, and a switch or cancel for a freeze
     * that ended changes nothing. A switch repeated after its answer was lost
     * must find the token even once it has expired, to get the same answer.
     */
    lookupSpent: (token: string): Effect.Effect<Option.Option<string>, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          SELECT id FROM promotion_tokens
          WHERE token_hash = ${hashToken(token)} AND used_at IS NOT NULL
        `,
        (rows) => Option.fromNullishOr(rows[0]).pipe(Option.map((row) => uuidToString(row.id))),
      ),
  };
});

export class PromotionTokens extends Context.Service<
  PromotionTokens,
  Effect.Success<typeof make>
>()("hercule/controller/promotion/PromotionTokens") {}

export const PromotionTokensLayer: Layer.Layer<PromotionTokens, never, SqlClient.SqlClient> =
  Layer.effect(PromotionTokens)(make);
