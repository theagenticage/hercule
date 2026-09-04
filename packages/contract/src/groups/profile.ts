/**
 * Permission profiles.
 *
 * The three shipped profiles can be edited but never deleted: deleting one is
 * `invalid_state`.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import {
  Conflict,
  Forbidden,
  Internal,
  InvalidState,
  NotFound,
  Unauthenticated,
  Validation,
} from "../errors";
import { ALL_GRANTS, GrantSchema } from "../grants";
import { Id, Timestamp } from "../ids";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { atMost, bounded } from "../strings";

/** What a user may call a profile. */
const ProfileName = bounded(1, 128);

/**
 * The longest grant list a profile may carry: the grant vocabulary itself. A
 * profile names a grant or it does not, so a longer list is repeats, and the
 * bound moves on its own as the vocabulary grows.
 */
export const MAX_PROFILE_GRANTS = ALL_GRANTS.length;

/** The grants of a profile, as it is written and as it reads back. */
const Grants = atMost(GrantSchema, MAX_PROFILE_GRANTS);

export const Profile = Schema.Struct({
  id: Id,
  name: ProfileName,
  grants: Grants,
  /** A shipped profile is seeded at first run and cannot be deleted. */
  shipped: Schema.Boolean,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export type Profile = Schema.Schema.Type<typeof Profile>;

export const profile = HttpApiGroup.make("profile")
  .add(
    HttpApiEndpoint.get("query", "/profiles", {
      query: pageParams(["name"]),
      success: page(Profile),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.get("read", "/profiles/:id", {
      params: { id: Id },
      success: Profile,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("create", "/profiles", {
      payload: Schema.Struct({
        name: ProfileName,
        grants: Grants,
      }),
      success: Profile,
      error: [Unauthenticated, Forbidden, Validation, Conflict, Internal],
    }),
    HttpApiEndpoint.patch("update", "/profiles/:id", {
      params: { id: Id },
      payload: Schema.Struct({
        name: Schema.optionalKey(ProfileName),
        grants: Schema.optionalKey(Grants),
      }),
      success: Profile,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Conflict, Internal],
    }),
    HttpApiEndpoint.delete("delete", "/profiles/:id", {
      params: { id: Id },
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
  )
  .middleware(Authenticated);
