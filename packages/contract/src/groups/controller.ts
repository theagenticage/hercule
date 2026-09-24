/**
 * The controller's own identity, and the one thing a caller may set about it.
 *
 * `defaultRunnerId` is the runner that placement falls back to when no runner
 * is chosen. It is null rather than absent when there is none, so a client
 * reads one shape either way. Update availability belongs here too, but there
 * is no update check yet, so it has no field; the field is added once the
 * check is built.
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
 * The payload of `controller.update`. An empty patch is accepted and changes
 * nothing. Any other key is rejected rather than ignored, because the
 * controller itself sets everything else that `controller.read` returns.
 */
export const ControllerUpdateInput = closedStruct({
  /** `null` removes the default, leaving placement with no fallback. */
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
