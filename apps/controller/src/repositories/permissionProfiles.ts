/**
 * Permission profiles: the named grant bundles an Agent carries and every
 * Session copies at spawn (spec 13 section 6, CONTEXT.md "Permission Profile").
 *
 * A grant is written family-dot-verb (`task.delete`, `infra.write`). Grants are
 * coarse and unscoped in v1: `session.read` reads any session. They are stored
 * as a JSON array of grant strings on the profile row, which keeps a profile
 * one row and one read - the enforcement path resolves token to session to
 * agent to profile on every call (spec 13 section 6.3).
 *
 * The three shipped profiles are seeded at first run with `shipped = 1`: the
 * user may edit them, never delete them.
 */
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { mintUuid, uuidToString } from "../db/id";

/**
 * The grant families and their verbs (spec 13 section 6.1). Families are
 * singular and coarser than the operations they cover; finer grants can land
 * inside a family later without invalidating a stored profile.
 */
export const GRANT_FAMILIES = {
  task: ["read", "create", "update", "delete"],
  workflow: ["read", "write", "run", "submit"],
  run: ["read", "write"],
  session: ["read", "spawn", "steer"],
  subscription: ["read", "write"],
  notification: ["read", "write"],
  settings: ["read", "write"],
  event: ["read", "emit"],
  connection: ["read", "manage", "use"],
  infra: ["read", "write"],
  workspace: ["read", "write"],
  agent: ["read", "write"],
  memory: ["read", "write"],
  permission: ["read", "write"],
  project: ["read", "write"],
  resource: ["read", "write"],
  secret: ["read", "write"],
  credential: ["read", "write"],
} as const satisfies Record<string, ReadonlyArray<string>>;

/** One grant family: the coarse operation area a grant names. */
export type GrantFamily = keyof typeof GRANT_FAMILIES;

/** One grant, family-dot-verb: what a 403 names and an escalation asks for. */
export type Grant = {
  [F in GrantFamily]: `${F}.${(typeof GRANT_FAMILIES)[F][number]}`;
}[GrantFamily];

/** Every grant in the vocabulary, family order then verb order (spec 13 section 6.1). */
export const ALL_GRANTS: ReadonlyArray<Grant> = Object.entries(GRANT_FAMILIES).flatMap(
  ([family, verbs]) => verbs.map((verb) => `${family}.${verb}` as Grant),
);

/** A grant string, validated against the closed vocabulary. */
export const GrantSchema = Schema.Literals(ALL_GRANTS);

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
     * its grants: seeding never overwrites (spec 15 section 7).
     */
    ensureShipped: (
      name: string,
      grants: ReadonlyArray<Grant>,
    ): Effect.Effect<void, GrantsError | SqlError> =>
      Effect.gen(function* () {
        const json = yield* encodeGrants(name, grants);
        const at = new Date(yield* Clock.currentTimeMillis).toISOString();
        yield* sql`
          INSERT OR IGNORE INTO permission_profiles
            (id, name, grants, shipped, created_at, updated_at)
          VALUES (${mintUuid()}, ${name}, ${json}, 1, ${at}, ${at})
        `;
      }),
  };
});

/** The permission profile repository (ADR 0031: every operation is a service method). */
export class PermissionProfiles extends Context.Service<
  PermissionProfiles,
  Effect.Success<typeof make>
>()("hydra/controller/repositories/PermissionProfiles") {}

export const PermissionProfilesLayer: Layer.Layer<PermissionProfiles, never, SqlClient.SqlClient> =
  Layer.effect(PermissionProfiles, make);
