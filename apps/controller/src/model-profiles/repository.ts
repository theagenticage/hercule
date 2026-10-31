/**
 * Model Profile rows. Nothing here decides policy: the service checks who may
 * write and what a write means, and this file stores and reads rows.
 *
 * A profile is a row with its name, its revision and a JSON `body` holding the
 * sections, the default entry and the dismissed models (`profile-body.ts`). An
 * install has a handful of profiles, so listings read the whole table.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { mintUuid, uuidFromString, uuidToString } from "../db";
import { StoredProfileBody } from "./profile-body";

/** A profile as it is stored. */
export interface StoredModelProfile {
  readonly id: string;
  readonly name: string;
  /** Counts the writes to the profile, starting at 1. */
  readonly revision: number;
  readonly body: StoredProfileBody;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ModelProfileRow {
  readonly id: Uint8Array;
  readonly name: string;
  readonly revision: number;
  readonly body: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const decodeBody = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredProfileBody));

const encodeBody = Schema.encodeEffect(Schema.fromJsonString(StoredProfileBody));

const toStoredProfile = (
  row: ModelProfileRow,
): Effect.Effect<StoredModelProfile, Schema.SchemaError> =>
  Effect.map(decodeBody(row.body), (body) => ({
    id: uuidToString(row.id),
    name: row.name,
    revision: row.revision,
    body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /** Returns every profile, in the order they were created. */
    list: (): Effect.Effect<ReadonlyArray<StoredModelProfile>, SqlError | Schema.SchemaError> =>
      Effect.flatMap(
        sql<ModelProfileRow>`
          SELECT id, name, revision, body, created_at, updated_at FROM model_profiles
          ORDER BY created_at, id
        `,
        (rows) => Effect.forEach(rows, toStoredProfile),
      ),

    /** Returns the profile with that id, or `None` when there is none. */
    one: (
      id: string,
    ): Effect.Effect<Option.Option<StoredModelProfile>, SqlError | Schema.SchemaError> =>
      Effect.flatMap(
        sql<ModelProfileRow>`
          SELECT id, name, revision, body, created_at, updated_at FROM model_profiles
          WHERE id = ${uuidFromString(id)}
        `,
        (rows) =>
          rows[0] === undefined
            ? Effect.succeed(Option.none())
            : Effect.map(toStoredProfile(rows[0]), Option.some),
      ),

    /** Returns whether a profile with this id exists. */
    exists: (id: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly one: number }>`
          SELECT 1 AS one FROM model_profiles WHERE id = ${uuidFromString(id)} LIMIT 1
        `,
        (rows) => rows.length > 0,
      ),

    /** Returns how many profiles there are. */
    count: (): Effect.Effect<number, SqlError> =>
      Effect.map(
        sql<{ readonly total: number }>`SELECT COUNT(*) AS total FROM model_profiles`,
        (rows) => rows[0]?.total ?? 0,
      ),

    /**
     * Returns whether a profile other than `exceptId` already has this name.
     * With no `exceptId`, any profile counts.
     */
    isNameTaken: (name: string, exceptId?: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        exceptId === undefined
          ? sql<{
              readonly one: number;
            }>`SELECT 1 AS one FROM model_profiles WHERE name = ${name} LIMIT 1`
          : sql<{ readonly one: number }>`
              SELECT 1 AS one FROM model_profiles WHERE name = ${name} AND id <> ${uuidFromString(exceptId)} LIMIT 1
            `,
        (rows) => rows.length > 0,
      ),

    /** Inserts a new profile at revision 1 and returns its id. */
    insert: (profile: {
      readonly name: string;
      readonly body: StoredProfileBody;
      readonly at: string;
    }): Effect.Effect<string, SqlError | Schema.SchemaError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        const body = yield* encodeBody(profile.body);
        yield* sql`
          INSERT INTO model_profiles (id, name, revision, body, created_at, updated_at)
          VALUES (${id}, ${profile.name}, 1, ${body}, ${profile.at}, ${profile.at})
        `;
        return uuidToString(id);
      }),

    /** Deletes the profile. The caller has already cleared it from the projects that name it. */
    delete: (id: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`DELETE FROM model_profiles WHERE id = ${uuidFromString(id)}`),

    /**
     * Replaces the name and the body of a profile and raises its revision by
     * one. Call it inside the transaction that read the revision it is
     * replacing, so no other write lands in between.
     */
    save: (
      id: string,
      change: { readonly name: string; readonly body: StoredProfileBody; readonly at: string },
    ): Effect.Effect<void, SqlError | Schema.SchemaError> =>
      Effect.gen(function* () {
        const body = yield* encodeBody(change.body);
        yield* sql`
          UPDATE model_profiles
          SET name = ${change.name}, body = ${body}, revision = revision + 1,
              updated_at = ${change.at}
          WHERE id = ${uuidFromString(id)}
        `;
      }),
  };
});

export const modelProfileRepository = make;
