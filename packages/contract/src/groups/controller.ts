/**
 * The controller's own identity, and the one thing a caller may set about it.
 *
 * `defaultRunnerId` is where a placement lands when nothing names a runner. It
 * is nullable rather than absent: a controller with no fleet has no default,
 * and a client reads one shape either way. Update availability belongs here
 * too, but there is no update check yet, so it is not declared; it gains its
 * field once it is built.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { closedStruct } from "../closed";
import { Conflict, Forbidden, Internal, Unauthenticated, Validation } from "../errors";
import { Id } from "../ids";
import { Authenticated } from "../security";

export const ControllerInfo = Schema.Struct({
  id: Id,
  /** The controller's Ed25519 public key, base64. Runners verify against it. */
  publicKey: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  /** The runner a placement falls back to, or null while none is chosen. */
  defaultRunnerId: Schema.NullOr(Id),
});

export type ControllerInfo = Schema.Schema.Type<typeof ControllerInfo>;

/**
 * What editing the controller takes. A patch that names nothing is accepted
 * and changes nothing; every other key is refused rather than dropped, because
 * the rest of what `controller.read` answers is the controller's own to say.
 */
export const ControllerUpdateInput = closedStruct({
  /** `null` takes the default off again, leaving placement with no fallback. */
  defaultRunnerId: Schema.optionalKey(Schema.NullOr(Id)),
});

export type ControllerUpdateInput = Schema.Schema.Type<typeof ControllerUpdateInput>;

export const controller = HttpApiGroup.make("controller")
  .add(
    HttpApiEndpoint.get("read", "/controller", {
      success: ControllerInfo,
      error: [Unauthenticated, Forbidden, Internal],
    }),
    HttpApiEndpoint.patch("update", "/controller", {
      payload: ControllerUpdateInput,
      success: ControllerInfo,
      error: [Unauthenticated, Forbidden, Validation, Conflict, Internal],
    }),
  )
  .middleware(Authenticated);
