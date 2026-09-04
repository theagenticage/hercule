/**
 * The user's own credentials.
 *
 * One user in v1. Changing the password verifies the current one, so a stolen
 * bearer token alone cannot take the account over.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Forbidden, Internal, Unauthenticated, Validation } from "../errors";
import { Authenticated } from "../security";
import { NewPassword, PresentedPassword } from "../strings";

export const user = HttpApiGroup.make("user")
  .add(
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
