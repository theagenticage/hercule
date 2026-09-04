/**
 * The controller's own identity (spec 11 section 2).
 *
 * Spec 11 also lists update availability and the default runner here. Neither
 * exists yet - there is no update check and no runner - so neither is declared;
 * the tickets that build them add their fields.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Forbidden, Internal, Unauthenticated } from "../errors";
import { Id } from "../ids";
import { Authenticated } from "../security";

export const ControllerInfo = Schema.Struct({
  id: Id,
  /** The controller's Ed25519 public key, base64. Runners verify against it. */
  publicKey: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
});

export type ControllerInfo = Schema.Schema.Type<typeof ControllerInfo>;

export const controller = HttpApiGroup.make("controller")
  .add(
    HttpApiEndpoint.get("read", "/controller", {
      success: ControllerInfo,
      error: [Unauthenticated, Forbidden, Internal],
    }),
  )
  .middleware(Authenticated);
