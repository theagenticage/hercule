/**
 * Password login, logout, and the live socket's ticket.
 *
 * `auth.login` mints the 30-day rolling bearer token the web app holds and
 * `hydra login` trades for an API key. `auth.logout` revokes the login bearer
 * token it was called with; an API key or a session token is `validation`,
 * because revoking those is `apiKey.revoke` and ending the session.
 *
 * `auth.wsTicket` is the one credential that is not a token: a short-lived
 * single-use string the caller trades for an authenticated WebSocket. It exists
 * because a browser cannot set a header on a WebSocket handshake, and putting
 * the 30-day bearer in the URL would leak it into every log the request passes.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Internal, Unauthenticated, Validation } from "../errors";
import { Timestamp } from "../ids";
import { PresentedPassword, Username } from "../strings";
import { Authenticated } from "../security";

/** What the login screen sends. */
export const LoginPayload = Schema.Struct({
  username: Username,
  password: PresentedPassword,
});

export const LoginResult = Schema.Struct({
  token: Schema.NonEmptyString,
  expiresAt: Timestamp,
});

/** What the live socket presents at `hello`. Good once, and not for long. */
export const WsTicket = Schema.Struct({
  ticket: Schema.NonEmptyString,
});

export const auth = HttpApiGroup.make("auth").add(
  HttpApiEndpoint.post("login", "/auth/login", {
    payload: LoginPayload,
    success: LoginResult,
    error: [Unauthenticated, Validation, Internal],
  }),
  HttpApiEndpoint.post("logout", "/auth/logout", {
    success: Schema.Struct({}),
    error: [Unauthenticated, Validation, Internal],
  }).middleware(Authenticated),
  HttpApiEndpoint.post("wsTicket", "/auth/ws-ticket", {
    success: WsTicket,
    error: [Unauthenticated, Internal],
  }).middleware(Authenticated),
);
