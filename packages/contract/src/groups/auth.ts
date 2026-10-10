/**
 * Password login, logout, and the live socket's ticket.
 *
 * `auth.login` creates the 30-day rolling bearer token that the web app holds
 * and that `hercule login` exchanges for an API key. `auth.logout` revokes the
 * login bearer token it was called with. Calling it with an API key or a
 * session token fails with `validation`, because those are revoked with
 * `apiKey.revoke` and by ending the session.
 *
 * `auth.wsTicket` is the one credential that is not a token: a short-lived
 * single-use string the caller exchanges for an authenticated WebSocket. It exists
 * because a browser cannot set a header on a WebSocket handshake, and putting
 * the 30-day bearer in the URL would leak it into every log the request passes.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import {
  ControllerSealed,
  Internal,
  PromotionInProgress,
  Unauthenticated,
  Validation,
} from "../errors";
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

/** What the live socket presents at `hello`. Valid once, and only for a short time. */
export const WsTicket = Schema.Struct({
  ticket: Schema.NonEmptyString,
});

export const auth = HttpApiGroup.make("auth").add(
  HttpApiEndpoint.post("login", "/auth/login", {
    payload: LoginPayload,
    success: LoginResult,
    error: [Unauthenticated, Validation, Internal, ControllerSealed, PromotionInProgress],
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
