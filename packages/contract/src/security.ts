/**
 * The two credential gates the API declares.
 *
 * Both read a bearer token from the `Authorization` header. The controller
 * implements them: `Authenticated` resolves the credential to an actor and
 * runs the static grant check for the operation from the table in
 * `operations.ts`, before any payload is decoded; `SetupToken` accepts only the
 * one-time setup token and only while setup is incomplete. A sealed
 * controller is an `Authenticated` error: every signed-in operation can
 * return it after a promotion.
 *
 * A frozen controller is the same for mutating operations: they return
 * `promotion_in_progress` until the switch or until the token expires.
 * The controller's promotion gate decides by HTTP method: it refuses every
 * operation that is not a `GET` or `HEAD`. `GET` operations still list the
 * error, because an error declared here applies to every operation behind
 * `Authenticated`, and one declaration is simpler than one on each
 * non-`GET` operation.
 *
 * Neither declares a provided service. Making the actor request-scoped is the
 * controller's business, and a `Context.Reference` keeps it out of every
 * handler's requirements.
 */
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity";
import { ControllerSealed, Forbidden, PromotionInProgress, Unauthenticated } from "./errors";

/** Any credential: a login bearer token, an API key or a session token. */
export class Authenticated extends HttpApiMiddleware.Service<Authenticated>()(
  "hercule/contract/Authenticated",
  {
    security: { bearer: HttpApiSecurity.bearer },
    error: [Unauthenticated, Forbidden, ControllerSealed, PromotionInProgress],
  },
) {}

/** The one-time setup token, and nothing else. */
export class SetupToken extends HttpApiMiddleware.Service<SetupToken>()(
  "hercule/contract/SetupToken",
  { security: { bearer: HttpApiSecurity.bearer }, error: [Unauthenticated] },
) {}
