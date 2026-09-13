/**
 * The provider's redirect. Outside the derived operation table and outside both
 * credential gates, because the caller is a browser coming back from somewhere
 * else: it carries a `state` and nothing to authenticate with.
 *
 * Everything it can be told is a word in the redirect it answers with, so the
 * Connections screen is what reports the outcome.
 */
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { CALLBACK_PATH } from "./oauth";
import { ConnectionService } from "./service";

export const OAuthCallbackRouteLayer = HttpRouter.add("GET", CALLBACK_PATH, () =>
  Effect.gen(function* () {
    const connections = yield* ConnectionService;
    const query = yield* HttpServerRequest.ParsedSearchParams;
    return HttpServerResponse.redirect(yield* connections.completeOAuth(query));
    // The derived routes get their span from the router middleware, which this
    // route sits outside of.
  }).pipe(Effect.withSpan("connection.completeOAuth")),
);
