/**
 * The user: username, password hash, timestamps.
 *
 * v1 has exactly one user, created by `setup.complete` and never removed. The
 * table is keyed all the same, and nothing here assumes there is only one, so
 * the second user is a row rather than a migration.
 *
 * The hash this stores is opaque to the repository. Producing and checking it
 * is `./password.ts`, so the cost parameters live in one place and no caller
 * can store a password by accident.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { mintUuid, uuidFromString, uuidToString } from "../db";

/** A user row. The password hash comes with it: verifying is one read. */
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

  const now = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis).toISOString());

  return {
    /**
     * Creates a user. `username` is unique in the schema, so a name already
     * taken is a constraint failure; the caller decides what to do about it,
     * inside the transaction that read the name (there is one writer, so a
     * check and an insert in one transaction cannot race).
     */
    create: (username: string, passwordHash: string): Effect.Effect<UserRecord, SqlError> =>
      Effect.gen(function* () {
        const at = yield* now;
        const id = mintUuid();
        yield* sql`
          INSERT INTO users (id, username, password_hash, created_at, updated_at)
          VALUES (${id}, ${username}, ${passwordHash}, ${at}, ${at})
        `;
        return { id: uuidToString(id), username, passwordHash, createdAt: at, updatedAt: at };
      }),

    /** The user with this username, if there is one. What login reads. */
    findByUsername: (username: string): Effect.Effect<Option.Option<UserRecord>, SqlError> =>
      sql<UserRow>`
        SELECT id, username, password_hash, created_at, updated_at
        FROM users WHERE username = ${username}
      `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0]).pipe(Option.map(toUser)))),

    /** The user this id names, if there is one. What a presented credential resolves through. */
    findById: (id: string): Effect.Effect<Option.Option<UserRecord>, SqlError> =>
      sql<UserRow>`
        SELECT id, username, password_hash, created_at, updated_at
        FROM users WHERE id = ${uuidFromString(id)}
      `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0]).pipe(Option.map(toUser)))),

    /**
     * Replaces a user's password hash. Revoking the credentials issued under
     * the old password is the caller's call, not this one's.
     */
    setPasswordHash: (id: string, passwordHash: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const at = yield* now;
        yield* sql`
          UPDATE users SET password_hash = ${passwordHash}, updated_at = ${at}
          WHERE id = ${uuidFromString(id)}
        `;
      }),
  };
});

/** The users repository. */
export class Users extends Context.Service<Users, Effect.Success<typeof make>>()(
  "hydra/controller/users/Users",
) {}

export const UsersLayer: Layer.Layer<Users, never, SqlClient.SqlClient> = Layer.effect(Users, make);
