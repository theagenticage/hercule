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
import { bounded } from "../strings";

/** The longest profile name. */
export const MAX_PROFILE_NAME_LENGTH = 128;

/** What a user may call a profile. */
const ProfileName = bounded(1, MAX_PROFILE_NAME_LENGTH);

/**
 * The longest grant list a profile may carry: the size of the grant
 * vocabulary. A profile either has a grant or not, so a longer list could only
 * hold repeats. The bound grows on its own with the vocabulary.
 */
export const MAX_PROFILE_GRANTS = ALL_GRANTS.length;

/**
 * The grants of a profile, in a request and in a response. A profile either
 * has a grant or not, so the list holds each grant once, and a client can
 * count the grants by the list's length. The repeat check runs first, so a
 * list longer than the bound fails with the message that says why.
 */
export const ProfileGrants = Schema.Array(GrantSchema).check(
  Schema.isUnique({ message: "A profile holds each grant once; remove the repeated grant." }),
  Schema.isMaxLength(MAX_PROFILE_GRANTS),
);

export const Profile = Schema.Struct({
  id: Id,
  name: ProfileName,
  grants: ProfileGrants,
  /** A shipped profile is seeded at first run and cannot be deleted. */
  shipped: Schema.Boolean,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export type Profile = Schema.Schema.Type<typeof Profile>;

/** The payload of `profile.update`. A field left out is not changed. */
export const ProfileUpdateInput = Schema.Struct({
  name: Schema.optionalKey(ProfileName),
  grants: Schema.optionalKey(ProfileGrants),
});

export type ProfileUpdateInput = Schema.Schema.Type<typeof ProfileUpdateInput>;

/** What a profile listing may be sorted by. People look for a profile by its name. */
export const PROFILE_SORT_FIELDS = ["name"] as const;

export const profile = HttpApiGroup.make("profile")
  .add(
    HttpApiEndpoint.get("query", "/profiles", {
      query: pageParams(PROFILE_SORT_FIELDS),
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
        grants: ProfileGrants,
      }),
      success: Profile,
      error: [Unauthenticated, Forbidden, Validation, Conflict, Internal],
    }),
    HttpApiEndpoint.patch("update", "/profiles/:id", {
      params: { id: Id },
      payload: ProfileUpdateInput,
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
