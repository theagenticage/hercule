/**
 * The two credential gates the API declares.
 *
 * Both read a bearer token from the `Authorization` header. The controller
 * implements them: `Authenticated` resolves the credential to an actor and
 * runs the static grant check for the operation from the table in
 * `operations.ts`, before any payload is decoded; `SetupToken` accepts only the
 * one-time setup token and only while setup is incomplete.
 *
 * Neither declares a provided service. Making the actor request-scoped is the
 * controller's business, and a `Context.Reference` keeps it out of every
 * handler's requirements.
 */
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity";
import { Forbidden, Unauthenticated } from "./errors";

/** Any credential: a login bearer token, an API key or a session token. */
export class Authenticated extends HttpApiMiddleware.Service<Authenticated>()(
  "hercule/contract/Authenticated",
  { security: { bearer: HttpApiSecurity.bearer }, error: [Unauthenticated, Forbidden] },
) {}

/** The one-time setup token, and nothing else. */
export class SetupToken extends HttpApiMiddleware.Service<SetupToken>()(
  "hercule/contract/SetupToken",
  { security: { bearer: HttpApiSecurity.bearer }, error: [Unauthenticated] },
) {}
