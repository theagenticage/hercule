/**
 * User API keys.
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
import { bounded } from "../strings";

/** What a user may call a key. */
const KeyName = bounded(1, 128);

/** An API key as it is listed: everything about it except the token. */
export const ApiKey = Schema.Struct({
  id: Id,
  name: KeyName,
  createdAt: Timestamp,
  lastUsedAt: Schema.optionalKey(Timestamp),
  revokedAt: Schema.optionalKey(Timestamp),
});

export type ApiKey = Schema.Schema.Type<typeof ApiKey>;

/** What `apiKey.create` returns. `token` is shown here and nowhere else. */
export const MintedApiKey = Schema.Struct({
  id: Id,
  name: KeyName,
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
      payload: Schema.Struct({ name: KeyName }),
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
