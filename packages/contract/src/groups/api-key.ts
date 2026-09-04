/**
 * User API keys (spec 11 section 2, spec 13 section 4.3).
 *
 * The token is returned once, by `apiKey.create`, and never again: `apiKey.query`
 * lists references only.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Forbidden, Internal, NotFound, Unauthenticated, Validation } from "../errors";
import { Id, Timestamp } from "../ids";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";

/** An API key as it is listed: everything about it except the token. */
export const ApiKey = Schema.Struct({
  id: Id,
  name: Schema.NonEmptyString,
  createdAt: Timestamp,
  lastUsedAt: Schema.optionalKey(Timestamp),
  revokedAt: Schema.optionalKey(Timestamp),
});

export type ApiKey = Schema.Schema.Type<typeof ApiKey>;

/** What minting answers with. `token` is shown here and nowhere else. */
export const MintedApiKey = Schema.Struct({
  id: Id,
  name: Schema.NonEmptyString,
  token: Schema.NonEmptyString,
  createdAt: Timestamp,
});

export const apiKey = HttpApiGroup.make("apiKey")
  .add(
    HttpApiEndpoint.get("query", "/api-keys", {
      query: pageParams(["createdAt"]),
      success: page(ApiKey),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.post("create", "/api-keys", {
      payload: Schema.Struct({ name: Schema.NonEmptyString }),
      success: MintedApiKey,
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.delete("revoke", "/api-keys/:id", {
      params: { id: Id },
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
  )
  .middleware(Authenticated);
