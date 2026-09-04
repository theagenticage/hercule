/**
 * The two user credentials: login bearer tokens and API keys (spec 13 section
 * 4).
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
 * A login bearer's lifetime is **30 days rolling** (spec 13 section 4.2). Every
 * authenticated use calls `renewLoginToken`, which pushes `expires_at` out by
 * another 30 days, so the token dies 30 days after its last use rather than 30
 * days after login.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { mintUuid, uuidFromString, uuidToString } from "../db";

/** The rolling window a login bearer lives in, in milliseconds (spec 13 section 4.2). */
export const LOGIN_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

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

/** One page of a keyset listing. `nextCursor` is `undefined` on the last page. */
export interface Page<A> {
  readonly items: ReadonlyArray<A>;
  readonly nextCursor: string | undefined;
}

/** What a listing needs: how many, where from, which way (spec 11 section 1.6). */
export interface PageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: "asc" | "desc";
}

/** A cursor that did not come from this listing, or was edited on its way back. */
export class CursorError extends Schema.TaggedError<CursorError>()("CursorError", {
  message: Schema.String,
}) {}

/**
 * The keyset cursor: the sort key of the page's last row, opaque on the wire.
 * `(created_at, id)` is unique because the id alone already is, so a page
 * boundary never repeats or skips a row - which is why the API needs no page
 * numbers and no totals (spec 11 section 1.6).
 *
 * A timestamp holds no `|`, so the separator has exactly one reading.
 */
const encodeCursor = (createdAt: string, id: string): string =>
  Buffer.from(`${createdAt}|${id}`, "utf8").toString("base64url");

const decodeCursor = (cursor: string): Effect.Effect<readonly [string, string], CursorError> => {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = decoded.indexOf("|");
  const id = decoded.slice(separator + 1);
  if (separator === -1 || !/^[0-9a-f-]{36}$/.test(id)) {
    return Effect.fail(new CursorError({ message: "The cursor is not one this listing issued." }));
  }
  return Effect.succeed([decoded.slice(0, separator), id] as const);
};

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

  const now = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis).toISOString());

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

    /**
     * The live login bearer behind a presented token, if there is one. A
     * revoked or expired token is simply not found: the caller has nothing to
     * do with the difference, and the response says the same either way.
     */
    findLoginToken: (tokenHash: string): Effect.Effect<Option.Option<LoginTokenRecord>, SqlError> =>
      Effect.gen(function* () {
        const at = yield* now;
        const rows = yield* sql<LoginTokenRow>`
          SELECT id, user_id, issued_at, expires_at, last_used_at
          FROM login_tokens
          WHERE token_hash = ${tokenHash} AND revoked_at IS NULL AND expires_at > ${at}
        `;
        return Option.fromNullishOr(rows[0]).pipe(Option.map(toLoginToken));
      }),

    /**
     * Extends a login bearer by another 30 days and stamps its use. This is
     * what makes the lifetime rolling, and it runs on every authenticated
     * request that presented one.
     */
    renewLoginToken: (id: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const millis = yield* Clock.currentTimeMillis;
        const at = new Date(millis).toISOString();
        const expiresAt = new Date(millis + LOGIN_TOKEN_LIFETIME_MS).toISOString();
        yield* sql`
          UPDATE login_tokens
          SET last_used_at = ${at}, expires_at = ${expiresAt}
          WHERE id = ${uuidFromString(id)} AND revoked_at IS NULL
        `;
      }),

    /**
     * Revokes the login bearer behind a presented token. Logging out with a
     * token that is already revoked is a no-op, not an error: the caller asked
     * for a state that already holds.
     */
    revokeLoginToken: (tokenHash: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const at = yield* now;
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
        const at = yield* now;
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

    /** The live API key behind a presented token, if there is one. A revoked key is not found. */
    findApiKey: (tokenHash: string): Effect.Effect<Option.Option<ApiKeyRecord>, SqlError> =>
      sql<ApiKeyRow>`
        SELECT id, user_id, name, created_at, last_used_at, revoked_at
        FROM api_keys
        WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
      `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0]).pipe(Option.map(toApiKey)))),

    /** Stamps an API key's use, so a key nobody uses is visible as unused. */
    touchApiKey: (id: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const at = yield* now;
        yield* sql`UPDATE api_keys SET last_used_at = ${at} WHERE id = ${uuidFromString(id)}`;
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
        const ascending = page.direction === "asc";
        const after = page.cursor === undefined ? undefined : yield* decodeCursor(page.cursor);
        const keyset =
          after === undefined
            ? sql``
            : ascending
              ? sql`AND (created_at, id) > (${after[0]}, ${uuidFromString(after[1])})`
              : sql`AND (created_at, id) < (${after[0]}, ${uuidFromString(after[1])})`;
        const order = ascending
          ? sql`ORDER BY created_at ASC, id ASC`
          : sql`ORDER BY created_at DESC, id DESC`;
        // One row more than asked for: whether it came back is whether there is
        // a next page, which is why no count query is needed to know.
        const rows = yield* sql<ApiKeyRow>`
          SELECT id, user_id, name, created_at, last_used_at, revoked_at
          FROM api_keys
          WHERE user_id = ${uuidFromString(userId)} ${keyset}
          ${order} LIMIT ${page.limit + 1}
        `;

        const items = rows.slice(0, page.limit).map(toApiKey);
        const last = items[items.length - 1];
        return {
          items,
          nextCursor:
            rows.length > page.limit && last !== undefined
              ? encodeCursor(last.createdAt, last.id)
              : undefined,
        };
      }),

    /**
     * Revokes one of a user's API keys, and answers whether it did. A key that
     * is not this user's and a key that was already revoked both answer false,
     * so the caller needs no second read to tell either from success.
     */
    revokeApiKey: (userId: string, id: string): Effect.Effect<boolean, SqlError> =>
      Effect.gen(function* () {
        const at = yield* now;
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

/** The credentials repository (ADR 0031: every operation is a service method). */
export class Credentials extends Context.Service<Credentials, Effect.Success<typeof make>>()(
  "hydra/controller/credentials/Credentials",
) {}

export const CredentialsLayer: Layer.Layer<Credentials, never, SqlClient.SqlClient> = Layer.effect(
  Credentials,
  make,
);
