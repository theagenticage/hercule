/**
 * Permission profiles: the named grant bundles an Agent carries and every
 * Session copies at spawn.
 *
 * A grant is written family-dot-verb (`task.delete`, `infra.write`). Grants are
 * coarse and unscoped in v1: `session.read` reads any session. The vocabulary
 * itself lives in `@hercule/contract` - a 403 names the missing grant on the wire
 * and `profile.create` takes a list of them - and is re-exported here so the
 * controller reads it from the domain that enforces it. They are stored
 * as a JSON array of grant strings on the profile row, which keeps a profile
 * one row and one read - the enforcement path resolves token to session to
 * agent to profile on every call.
 *
 * The three shipped profiles are seeded at first run with `shipped = 1`: the
 * user may edit them, never delete them.
 */
import { Context, Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { GrantSchema, type Grant } from "@hercule/contract";
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

/** The stored form of a profile's grants: a JSON array of grant strings. */
const GrantsJson = Schema.fromJsonString(Schema.Array(GrantSchema));

/** A profile as the rest of the controller sees it. */
export interface PermissionProfile {
  readonly id: string;
  readonly name: string;
  readonly grants: ReadonlyArray<Grant>;
  /** A shipped profile is seeded at first run and cannot be deleted. */
  readonly shipped: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What editing a profile did, or why it did nothing. */
export type UpdateOutcome =
  | { readonly _tag: "updated"; readonly profile: PermissionProfile }
  | { readonly _tag: "absent" }
  | { readonly _tag: "nameTaken" };

/** A profile row holds something that is not a list of known grants. */
export class GrantsError extends Schema.TaggedError<GrantsError>()("GrantsError", {
  name: Schema.String,
  message: Schema.String,
}) {}

interface Row {
  readonly id: Uint8Array;
  readonly name: string;
  readonly grants: string;
  readonly shipped: number;
  readonly created_at: string;
  readonly updated_at: string;
}

const decodeGrants = Schema.decodeUnknownEffect(GrantsJson);

const toProfile = (row: Row): Effect.Effect<PermissionProfile, GrantsError> =>
  decodeGrants(row.grants).pipe(
    Effect.mapError((error) => new GrantsError({ name: row.name, message: error.message })),
    Effect.map((grants) => ({
      id: uuidToString(row.id),
      name: row.name,
      grants,
      shipped: row.shipped === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  );

const encodeGrants = (name: string, grants: ReadonlyArray<Grant>) =>
  Schema.encodeEffect(GrantsJson)(grants).pipe(
    Effect.mapError((error) => new GrantsError({ name, message: error.message })),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const byId = (id: string): Effect.Effect<Option.Option<Row>, SqlError> =>
    sql<Row>`SELECT id, name, grants, shipped, created_at, updated_at
             FROM permission_profiles WHERE id = ${uuidFromString(id)}`.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
    );

  return {
    /** The profile with that name, if one exists. Names are the user-facing key. */
    getByName: (
      name: string,
    ): Effect.Effect<Option.Option<PermissionProfile>, GrantsError | SqlError> =>
      sql<Row>`SELECT id, name, grants, shipped, created_at, updated_at
               FROM permission_profiles WHERE name = ${name}`.pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.succeedNone
            : toProfile(rows[0]).pipe(Effect.map(Option.some)),
        ),
      ),

    /**
     * Seeds one shipped profile. A profile the user has already edited keeps
     * its grants: seeding never overwrites.
     */
    ensureShipped: (
      name: string,
      grants: ReadonlyArray<Grant>,
    ): Effect.Effect<void, GrantsError | SqlError> =>
      Effect.gen(function* () {
        const json = yield* encodeGrants(name, grants);
        const at = yield* nowIso;
        yield* sql`
          INSERT OR IGNORE INTO permission_profiles
            (id, name, grants, shipped, created_at, updated_at)
          VALUES (${mintUuid()}, ${name}, ${json}, 1, ${at}, ${at})
        `;
      }),

    /** The profile with that id, if one exists. */
    getById: (
      id: string,
    ): Effect.Effect<Option.Option<PermissionProfile>, GrantsError | SqlError> =>
      byId(id).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeedNone,
            onSome: (row) => Effect.map(toProfile(row), Option.some),
          }),
        ),
      ),

    /**
     * One page of profiles, keyset-paged on `(name, id)`. Name is the only sort
     * field the contract offers, and it is what the user reads.
     */
    list: (
      page: PageRequest,
    ): Effect.Effect<Page<PermissionProfile>, GrantsError | CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope: CursorScope = {
          op: "profile.query",
          field: "name",
          direction: page.direction,
        };
        const after =
          page.cursor === undefined ? undefined : yield* decodeCursor(page.cursor, scope, "string");
        const { keyset, order } = keysetOver(
          sql,
          ["name", "id"],
          after === undefined ? undefined : [after[0], uuidFromString(after[1])],
          page.direction,
        );
        const rows = yield* sql<Row>`
          SELECT id, name, grants, shipped, created_at, updated_at
          FROM permission_profiles WHERE ${keyset} ${order} LIMIT ${page.limit + 1}
        `;
        return yield* pageOf(
          rows,
          page.limit,
          (read) => Effect.forEach(read, toProfile),
          (last) => encodeCursor(scope, last.name, last.id),
        );
      }),

    /**
     * Creates a profile, or answers `None` when the name is taken. Names are
     * unique and are what the user names a profile by, so a duplicate is the
     * caller's to resolve rather than something to disambiguate silently.
     */
    create: (
      name: string,
      grants: ReadonlyArray<Grant>,
    ): Effect.Effect<Option.Option<PermissionProfile>, GrantsError | SqlError> =>
      Effect.gen(function* () {
        const json = yield* encodeGrants(name, grants);
        const at = yield* nowIso;
        const id = mintUuid();
        const inserted = yield* sql<{ readonly id: Uint8Array }>`
          INSERT OR IGNORE INTO permission_profiles
            (id, name, grants, shipped, created_at, updated_at)
          VALUES (${id}, ${name}, ${json}, 0, ${at}, ${at})
          RETURNING id
        `;
        return inserted.length === 0
          ? Option.none()
          : Option.some<PermissionProfile>({
              id: uuidToString(id),
              name,
              grants,
              shipped: false,
              createdAt: at,
              updatedAt: at,
            });
      }),

    /**
     * Edits a profile, including a shipped one: the three shipped profiles are
     * editable. `None` means no such profile; a name another profile already
     * holds is a `NameTaken`.
     */
    update: (
      id: string,
      changes: { readonly name?: string; readonly grants?: ReadonlyArray<Grant> },
    ): Effect.Effect<UpdateOutcome, GrantsError | SqlError> =>
      Effect.gen(function* () {
        const existing = yield* byId(id);
        if (Option.isNone(existing)) return { _tag: "absent" };
        const current = yield* toProfile(existing.value);

        const name = changes.name ?? current.name;
        const grants = changes.grants ?? current.grants;
        const json = yield* encodeGrants(name, grants);
        const at = yield* nowIso;
        const updated = yield* sql<{ readonly id: Uint8Array }>`
          UPDATE OR IGNORE permission_profiles
          SET name = ${name}, grants = ${json}, updated_at = ${at}
          WHERE id = ${uuidFromString(id)}
          RETURNING id
        `;
        return updated.length === 0
          ? { _tag: "nameTaken" }
          : { _tag: "updated", profile: { ...current, name, grants, updatedAt: at } };
      }),

    /**
     * Deletes a profile. Whether this profile may be deleted at all is the
     * service's rule, not the store's: a shipped profile is not deletable and
     * never reaches here.
     */
    delete: (id: string): Effect.Effect<void, SqlError> =>
      sql`DELETE FROM permission_profiles WHERE id = ${uuidFromString(id)}`.pipe(Effect.asVoid),
  };
});

/** The permission profile repository. */
export class PermissionProfiles extends Context.Service<
  PermissionProfiles,
  Effect.Success<typeof make>
>()("hercule/controller/permissions/PermissionProfiles") {}

export const PermissionProfilesLayer: Layer.Layer<PermissionProfiles, never, SqlClient.SqlClient> =
  Layer.effect(PermissionProfiles, make);
