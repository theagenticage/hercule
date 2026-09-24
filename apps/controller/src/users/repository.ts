/**
 * Reads and writes the user row: username, password hash and timestamps.
 *
 * v1 has exactly one user, created by `setup.complete` and never removed. The
 * table still has an id key, and nothing here assumes there is only one user,
 * so a second user needs a new row rather than a migration.
 *
 * The repository treats the password hash as an opaque string. `./password.ts`
 * produces and checks it, so the cost parameters live in one place and no
 * caller can store a plaintext password by accident.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { mintUuid, nowIso, uuidFromString, uuidToString } from "../db";

/** A user row. It includes the password hash, so verifying a password takes one read. */
export interface UserRecord {
  readonly id: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface UserRow {
  readonly id: Uint8Array;
  readonly username: string;
  readonly password_hash: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const toUser = (row: UserRow): UserRecord => ({
  id: uuidToString(row.id),
  username: row.username,
  passwordHash: row.password_hash,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /**
     * Creates a user and returns it. `username` is unique in the schema, so a
     * taken name fails with a constraint error. The caller should check the
     * name first, inside the same transaction as the insert. SQLite has one
     * writer, so the check and the insert cannot race.
     */
    create: (username: string, passwordHash: string): Effect.Effect<UserRecord, SqlError> =>
      Effect.gen(function* () {
        const at = yield* nowIso;
        const id = mintUuid();
        yield* sql`
          INSERT INTO users (id, username, password_hash, created_at, updated_at)
          VALUES (${id}, ${username}, ${passwordHash}, ${at}, ${at})
        `;
        return { id: uuidToString(id), username, passwordHash, createdAt: at, updatedAt: at };
      }),

    /** Returns the user with this username, if there is one. Login uses this. */
    findByUsername: (username: string): Effect.Effect<Option.Option<UserRecord>, SqlError> =>
      sql<UserRow>`
        SELECT id, username, password_hash, created_at, updated_at
        FROM users WHERE username = ${username}
      `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0]).pipe(Option.map(toUser)))),

    /** Returns the user with this id, if there is one. Credential checks use this. */
    findById: (id: string): Effect.Effect<Option.Option<UserRecord>, SqlError> =>
      sql<UserRow>`
        SELECT id, username, password_hash, created_at, updated_at
        FROM users WHERE id = ${uuidFromString(id)}
      `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0]).pipe(Option.map(toUser)))),

    /**
     * Replaces a user's password hash. It does not revoke the credentials
     * issued under the old password; that is the caller's decision.
     */
    setPasswordHash: (id: string, passwordHash: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const at = yield* nowIso;
        yield* sql`
          UPDATE users SET password_hash = ${passwordHash}, updated_at = ${at}
          WHERE id = ${uuidFromString(id)}
        `;
      }),
  };
});

/** The users repository. */
export class Users extends Context.Service<Users, Effect.Success<typeof make>>()(
  "hercule/controller/users/Users",
) {}

export const UsersLayer: Layer.Layer<Users, never, SqlClient.SqlClient> = Layer.effect(Users, make);
