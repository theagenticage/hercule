/**
 * Password login and logout.
 *
 * `auth.login` mints the 30-day rolling bearer token the web app holds and
 * `hydra login` trades for an API key. `auth.logout` revokes the login bearer
 * token it was called with; an API key or a session token is `validation`,
 * because revoking those is `apiKey.revoke` and ending the session.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Internal, Unauthenticated, Validation } from "../errors";
import { Timestamp } from "../ids";
import { PresentedPassword, Username } from "../strings";
import { Authenticated } from "../security";

export const LoginResult = Schema.Struct({
  token: Schema.NonEmptyString,
  expiresAt: Timestamp,
});

export const auth = HttpApiGroup.make("auth").add(
  HttpApiEndpoint.post("login", "/auth/login", {
    payload: Schema.Struct({
      username: Username,
      password: PresentedPassword,
    }),
    success: LoginResult,
    error: [Unauthenticated, Validation, Internal],
  }),
  HttpApiEndpoint.post("logout", "/auth/logout", {
    success: Schema.Struct({}),
    error: [Unauthenticated, Validation, Internal],
  }).middleware(Authenticated),
);
