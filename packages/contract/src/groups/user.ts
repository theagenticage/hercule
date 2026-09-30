/**
 * The user's own credentials.
 *
 * One user in v1. `user.read` returns the user's name, so a client that keeps
 * only a token, such as the desktop app after a relaunch, can still show who
 * is signed in. Changing the password verifies the current one, so a stolen
 * bearer token alone cannot take the account over.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Forbidden, Internal, Unauthenticated, Validation } from "../errors";
import { Authenticated } from "../security";
import { NewPassword, PresentedPassword, Username } from "../strings";

/** What `user.read` returns: the user the credential belongs to. */
export const SignedInUser = Schema.Struct({
  /** The name the user signs in with. */
  username: Username,
});

export type SignedInUser = Schema.Schema.Type<typeof SignedInUser>;

export const user = HttpApiGroup.make("user")
  .add(
    HttpApiEndpoint.get("read", "/user", {
      success: SignedInUser,
      error: [Unauthenticated, Forbidden, Internal],
    }),
    HttpApiEndpoint.post("setPassword", "/user/password", {
      payload: Schema.Struct({
        current: PresentedPassword,
        next: NewPassword,
      }),
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
  )
  .middleware(Authenticated);
