/**
 * Secrets.
 *
 * References only, never values: nothing in the API reads a secret back. An
 * owner is a pair, so the route carries both halves as their own path segments
 * (`/secrets/{ownerKind}/{ownerId}/{name}`); neither may contain the `|` the
 * encryption's associated data is built with.
 *
 * The service layer rejects a set or delete for two owner kinds:
 *
 * - `core`, the controller's own key material, where its signing key lives.
 * - `connection`, a Connection's credentials. New credentials must be checked
 *   to belong to the same account, and only the Connection operations do that.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Forbidden, Internal, NotFound, Unauthenticated, Validation } from "../errors";
import { Timestamp } from "../ids";
import { page, pageParams } from "../pagination";
import { bounded, SecretValue } from "../strings";
import { Authenticated } from "../security";

/** Who a secret belongs to. */
export const OwnerKind = Schema.Literals([
  "connection",
  "plugin",
  "runner",
  "core",
  "provider-instance",
]);

export type OwnerKind = Schema.Schema.Type<typeof OwnerKind>;

/** An owner id or a secret name: any non-empty string without `|`. */
const OwnerSegment = bounded(1, 256).check(
  Schema.isPattern(/^[^|]+$/, { description: "no `|`, which separates the associated data" }),
);

/** What a secret looks like from outside: everything but the value. */
export const SecretRef = Schema.Struct({
  ownerKind: OwnerKind,
  ownerId: OwnerSegment,
  name: OwnerSegment,
  createdAt: Timestamp,
  rotatedAt: Schema.optionalKey(Timestamp),
});

export type SecretRef = Schema.Schema.Type<typeof SecretRef>;

const SecretPath = {
  ownerKind: OwnerKind,
  ownerId: OwnerSegment,
  name: OwnerSegment,
};

export const secret = HttpApiGroup.make("secret")
  .add(
    HttpApiEndpoint.get("query", "/secrets", {
      query: Schema.Struct({
        ownerKind: Schema.optionalKey(OwnerKind),
        ownerId: Schema.optionalKey(OwnerSegment),
        ...pageParams(["name"]).fields,
      }),
      success: page(SecretRef),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.put("set", "/secrets/:ownerKind/:ownerId/:name", {
      params: SecretPath,
      payload: Schema.Struct({ value: SecretValue }),
      success: SecretRef,
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.delete("delete", "/secrets/:ownerKind/:ownerId/:name", {
      params: SecretPath,
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
  )
  .middleware(Authenticated);
