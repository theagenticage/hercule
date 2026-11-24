/**
 * Handles the OAuth provider's redirect back to the controller. The route is
 * not in the derived operation table and needs no credential, because the
 * caller is a browser returning from the provider: it carries a `state` and
 * nothing to authenticate with.
 *
 * The route responds with a redirect to the Connections screen, with the
 * outcome as one word in the query string, and that screen shows the outcome
 * to the user.
 */
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { CALLBACK_PATH } from "./oauth";
import { ConnectionService } from "./service";

export const OAuthCallbackRouteLayer = HttpRouter.add("GET", CALLBACK_PATH, () =>
  Effect.gen(function* () {
    const connections = yield* ConnectionService;
    const request = yield* HttpServerRequest.HttpServerRequest;
    // The raw query, so the service reads it with the parser `finishOAuth` uses.
    // Everything after the first `?`: a later `?` belongs to a value.
    const delimiter = request.url.indexOf("?");
    const rawQuery = delimiter === -1 ? "" : request.url.slice(delimiter + 1);
    return HttpServerResponse.redirect(yield* connections.completeOAuth(rawQuery));
    // The derived routes get their span from the router middleware, and this
    // route is not behind that middleware.
  }).pipe(Effect.withSpan("connection.completeOAuth")),
);
