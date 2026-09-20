/**
 * The two user credentials: login bearer tokens and API keys.
 *
 * Both are opaque random tokens, both are stored only as a SHA-256 hash
 * (`./token.ts`), and both are resolved by one indexed lookup on that hash.
 * Neither is ever deleted: revoking sets `revoked_at`, so a revoked credential
 * stays visible to the audit trail and its hash is never handed out again by
 * chance.
 *
 * The plaintext token is minted by the caller, which is the only code that ever
 * holds it: it goes into exactly one response and is not recoverable
 * afterwards. This module sees hashes.
 *
 * A login bearer's lifetime is **30 days rolling**. Every authenticated use
 * calls `renewLoginToken`, which pushes `expires_at` out by another 30 days, so
 * the token dies 30 days after its last use rather than 30 days after login. The push itself is written at most once every
 * {@link USE_STAMP_INTERVAL_MS}: a rolling window does not need per-request
 * resolution, and the writes it saves are the whole API's.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  decodeCursor,
  encodeCursor,
  keysetOver,
  mintUuid,
  nowIso,
  pageOf,
  uuidFromString,
  uuidToString,
  type CursorError,
  type Page,
  type CursorScope,
  type PageRequest,
} from "../db";
import type { PresentedCredential } from "../actor";

/** The rolling window a login bearer lives in, in milliseconds. */
export const LOGIN_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How stale a credential's `last_used_at` has to be before a use writes it
 * again.
 *
 * Stamping every request turns every read of the API into a write, and SQLite
 * has one writer, so the whole controller serializes on it and the write-ahead
 * log grows on traffic that changes nothing. Five minutes of drift is invisible
 * against a 30-day rolling window and against "when was this key last used",
 * which is what the two stamps are for.
 */
export const USE_STAMP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Whether a use is worth writing down. A credential that has never been stamped
 * always is; an unparseable stamp is treated as stale rather than trusted.
 */
const worthStamping = (lastUsedAt: string | null, nowMillis: number): boolean => {
  if (lastUsedAt === null) return true;
  const stamped = Date.parse(lastUsedAt);
  return Number.isNaN(stamped) || nowMillis - stamped >= USE_STAMP_INTERVAL_MS;
};

/** A login bearer token, without the token: only its hash was ever stored. */
export interface LoginTokenRecord {
  readonly id: string;
  readonly userId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string;
}

/** What the user and the audit trail may know about an API key. Never the token. */
export interface ApiKeyRecord {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

interface LoginTokenRow {
  readonly id: Uint8Array;
  readonly user_id: Uint8Array;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly last_used_at: string;
}

const toLoginToken = (row: LoginTokenRow): LoginTokenRecord => ({
  id: uuidToString(row.id),
  userId: uuidToString(row.user_id),
  issuedAt: row.issued_at,
  expiresAt: row.expires_at,
  lastUsedAt: row.last_used_at,
});

interface ApiKeyRow {
  readonly id: Uint8Array;
  readonly user_id: Uint8Array;
  readonly name: string;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
}

const toApiKey = (row: ApiKeyRow): ApiKeyRecord => ({
  id: uuidToString(row.id),
  userId: uuidToString(row.user_id),
  name: row.name,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  revokedAt: row.revoked_at,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /**
   * The live login bearer behind a presented token, if there is one. A revoked
   * or expired token is simply not found: the caller has nothing to do with the
   * difference, and the response says the same either way.
   */
  const findLoginToken = (
    tokenHash: string,
  ): Effect.Effect<Option.Option<LoginTokenRecord>, SqlError> =>
    Effect.gen(function* () {
      const at = yield* nowIso;
      const rows = yield* sql<LoginTokenRow>`
        SELECT id, user_id, issued_at, expires_at, last_used_at
        FROM login_tokens
        WHERE token_hash = ${tokenHash} AND revoked_at IS NULL AND expires_at > ${at}
      `;
      return Option.fromNullishOr(rows[0]).pipe(Option.map(toLoginToken));
    });

  /** The live API key behind a presented token, if there is one. A revoked key is not found. */
  const findApiKey = (tokenHash: string): Effect.Effect<Option.Option<ApiKeyRecord>, SqlError> =>
    sql<ApiKeyRow>`
      SELECT id, user_id, name, created_at, last_used_at, revoked_at
      FROM api_keys
      WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
    `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0]).pipe(Option.map(toApiKey))));

  return {
    /**
     * Records a freshly minted login bearer, expiring 30 days from now. The
     * caller mints the token and keeps the plaintext; this stores its hash.
     */
    issueLoginToken: (
      userId: string,
      tokenHash: string,
    ): Effect.Effect<LoginTokenRecord, SqlError> =>
      Effect.gen(function* () {
        const millis = yield* Clock.currentTimeMillis;
        const at = new Date(millis).toISOString();
        const expiresAt = new Date(millis + LOGIN_TOKEN_LIFETIME_MS).toISOString();
        const id = mintUuid();
        yield* sql`
          INSERT INTO login_tokens
            (id, user_id, token_hash, issued_at, expires_at, last_used_at, revoked_at)
          VALUES
            (${id}, ${uuidFromString(userId)}, ${tokenHash}, ${at}, ${expiresAt}, ${at}, NULL)
        `;
        return { id: uuidToString(id), userId, issuedAt: at, expiresAt, lastUsedAt: at };
      }),

    findLoginToken,

    /**
     * Extends a login bearer by another 30 days and stamps its use. This is
     * what makes the lifetime rolling, and it runs on every authenticated
     * request that presented one - but it writes at most once per
     * {@link USE_STAMP_INTERVAL_MS}.
     */
    renewLoginToken: (token: LoginTokenRecord): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const millis = yield* Clock.currentTimeMillis;
        if (!worthStamping(token.lastUsedAt, millis)) return;
        const at = new Date(millis).toISOString();
        const expiresAt = new Date(millis + LOGIN_TOKEN_LIFETIME_MS).toISOString();
        yield* sql`
          UPDATE login_tokens
          SET last_used_at = ${at}, expires_at = ${expiresAt}
          WHERE id = ${uuidFromString(token.id)} AND revoked_at IS NULL
        `;
      }),

    /**
     * Revokes the login bearer behind a presented token. Logging out with a
     * token that is already revoked is a no-op, not an error: the caller asked
     * for a state that already holds.
     */
    revokeLoginToken: (tokenHash: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const at = yield* nowIso;
        yield* sql`
          UPDATE login_tokens SET revoked_at = ${at}
          WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
        `;
      }),

    /** Records a freshly minted API key. Its token is shown once, by the caller. */
    createApiKey: (
      userId: string,
      name: string,
      tokenHash: string,
    ): Effect.Effect<ApiKeyRecord, SqlError> =>
      Effect.gen(function* () {
        const at = yield* nowIso;
        const id = mintUuid();
        yield* sql`
          INSERT INTO api_keys (id, user_id, name, token_hash, created_at, last_used_at, revoked_at)
          VALUES (${id}, ${uuidFromString(userId)}, ${name}, ${tokenHash}, ${at}, NULL, NULL)
        `;
        return {
          id: uuidToString(id),
          userId,
          name,
          createdAt: at,
          lastUsedAt: null,
          revokedAt: null,
        };
      }),

    findApiKey,

    /**
     * Whether a credential that resolved earlier still resolves to the same
     * row. A request never has to ask - resolving the token it presents
     * answers it - but a connection held open for hours presents nothing a
     * second time, only the hash its first frame resolved through.
     */
    stillLive: (credential: PresentedCredential): Effect.Effect<boolean, SqlError> => {
      const found =
        credential.kind === "login"
          ? Effect.map(
              findLoginToken(credential.tokenHash),
              Option.map((token) => token.id),
            )
          : Effect.map(
              findApiKey(credential.tokenHash),
              Option.map((key) => key.id),
            );
      return Effect.map(
        found,
        (resolved) => Option.isSome(resolved) && resolved.value === credential.id,
      );
    },

    /**
     * Stamps an API key's use, so a key nobody uses is visible as unused. Like
     * a login bearer's renewal, at most once per {@link USE_STAMP_INTERVAL_MS}.
     */
    touchApiKey: (key: ApiKeyRecord): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const millis = yield* Clock.currentTimeMillis;
        if (!worthStamping(key.lastUsedAt, millis)) return;
        const at = new Date(millis).toISOString();
        yield* sql`UPDATE api_keys SET last_used_at = ${at} WHERE id = ${uuidFromString(key.id)}`;
      }),

    /**
     * One user's API keys, paged by keyset on `(created_at, id)`. Revoked keys
     * stay in the listing: a key the user revoked should read as revoked rather
     * than silently vanish.
     */
    listApiKeys: (
      userId: string,
      page: PageRequest,
    ): Effect.Effect<Page<ApiKeyRecord>, SqlError | CursorError> =>
      Effect.gen(function* () {
        const scope: CursorScope = {
          op: "apiKey.query",
          field: "createdAt",
          direction: page.direction,
        };
        const after =
          page.cursor === undefined ? undefined : yield* decodeCursor(page.cursor, scope, "string");
        const { keyset, order } = keysetOver(
          sql,
          ["created_at", "id"],
          after === undefined ? undefined : [after[0], uuidFromString(after[1])],
          page.direction,
        );
        const rows = yield* sql<ApiKeyRow>`
          SELECT id, user_id, name, created_at, last_used_at, revoked_at
          FROM api_keys
          WHERE user_id = ${uuidFromString(userId)} AND ${keyset}
          ${order} LIMIT ${page.limit + 1}
        `;
        return yield* pageOf(
          rows,
          page.limit,
          (read) => Effect.succeed(read.map(toApiKey)),
          (last) => encodeCursor(scope, last.createdAt, last.id),
        );
      }),

    /**
     * Revokes one of a user's API keys, and answers whether it did. A key that
     * is not this user's and a key that was already revoked both answer false,
     * so the caller needs no second read to tell either from success.
     */
    revokeApiKey: (userId: string, id: string): Effect.Effect<boolean, SqlError> =>
      Effect.gen(function* () {
        const at = yield* nowIso;
        const revoked = yield* sql<{ readonly id: Uint8Array }>`
          UPDATE api_keys SET revoked_at = ${at}
          WHERE id = ${uuidFromString(id)}
            AND user_id = ${uuidFromString(userId)}
            AND revoked_at IS NULL
          RETURNING id
        `;
        return revoked.length > 0;
      }),
  };
});

/** The credentials repository. */
export class Credentials extends Context.Service<Credentials, Effect.Success<typeof make>>()(
  "hercule/controller/credentials/Credentials",
) {}

export const CredentialsLayer: Layer.Layer<Credentials, never, SqlClient.SqlClient> = Layer.effect(
  Credentials,
  make,
);
