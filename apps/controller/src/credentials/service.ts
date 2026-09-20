/**
 * The user's API keys: mint, list, revoke.
 *
 * A key's token exists in exactly one place: the response to the call that
 * minted it. Nothing stores it and no later operation can show it again, which
 * is why `query` lists references only. Losing a key means minting another.
 *
 * Revoking the key the caller is holding is allowed. It takes effect on the
 * next request, so the call that revokes it still answers; the alternative -
 * refusing - would leave a leaked key alive because it happens to be the one in
 * the hand that noticed.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  DEFAULT_PAGE_LIMIT,
  notFound,
  validation,
  type ApiKey,
  type Forbidden,
  type NotFound,
  type SortDirection,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { currentUser, USER_ACTOR } from "../actor";
import { withTransaction } from "../db";
import { AuditLog } from "../events";
import { Credentials, type ApiKeyRecord } from "./repository";
import { hashToken, mintToken } from "./token";

/** What listing takes. Absent fields are the defaults, not "no page". */
export interface QueryInput {
  readonly limit?: number;
  readonly cursor?: string;
  readonly sort?: { readonly field: "createdAt"; readonly direction?: SortDirection };
}

/** One page of keys, in the contract's shape. */
export interface ApiKeyPage {
  readonly items: ReadonlyArray<ApiKey>;
  readonly nextCursor?: string;
}

/**
 * Newest first: a listing of credentials is read to find the one just minted or
 * the one to revoke, and both are recent.
 */
const DEFAULT_DIRECTION: SortDirection = "desc";

/**
 * A key as the API shows it. `lastUsedAt` and `revokedAt` are absent rather
 * than null when they have not happened: the contract declares them optional,
 * and a key that has never been used says nothing instead of saying `null`.
 */
const toApiKey = (record: ApiKeyRecord): ApiKey => ({
  id: record.id,
  name: record.name,
  createdAt: record.createdAt,
  ...(record.lastUsedAt === null ? {} : { lastUsedAt: record.lastUsedAt }),
  ...(record.revokedAt === null ? {} : { revokedAt: record.revokedAt }),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const credentials = yield* Credentials;
  const audit = yield* AuditLog;

  return {
    /**
     * Mints a key and returns its token, once. The token is minted outside the
     * transaction and only its hash goes in, so nothing durable ever holds it.
     */
    create: (input: {
      readonly name: string;
    }): Effect.Effect<
      {
        readonly id: string;
        readonly name: string;
        readonly token: string;
        readonly createdAt: string;
      },
      Unauthenticated | Forbidden | SqlError
    > =>
      Effect.gen(function* () {
        const actor = yield* currentUser("apiKey.create");
        const token = mintToken();
        const record = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const created = yield* credentials.createApiKey(
              actor.userId,
              input.name,
              hashToken(token),
            );
            yield* audit.append({
              kind: "auth.apiKey.minted",
              actor: USER_ACTOR,
              payload: { id: created.id, name: created.name },
            });
            return created;
          }),
        );
        return { id: record.id, name: record.name, token, createdAt: record.createdAt };
      }),

    /**
     * The caller's own keys, revoked ones included: a key that was revoked
     * should read as revoked rather than disappear.
     */
    query: (
      input: QueryInput,
    ): Effect.Effect<ApiKeyPage, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        const actor = yield* currentUser("apiKey.query");
        const page = yield* credentials
          .listApiKeys(actor.userId, {
            limit: input.limit ?? DEFAULT_PAGE_LIMIT,
            cursor: input.cursor,
            direction: input.sort?.direction ?? DEFAULT_DIRECTION,
          })
          .pipe(
            Effect.catchTag("CursorError", (error) =>
              Effect.fail(validation([{ path: ["cursor"], message: error.message }])),
            ),
          );
        return {
          items: page.items.map(toApiKey),
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        };
      }),

    /**
     * Revokes one of the caller's keys. A key that is not theirs and a key that
     * was already revoked are both `not_found`: neither leaves anything for the
     * caller to do differently, and the first must not confirm that an id
     * exists.
     */
    revoke: (input: {
      readonly id: string;
    }): Effect.Effect<Record<string, never>, Unauthenticated | Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        const actor = yield* currentUser("apiKey.revoke");
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const revoked = yield* credentials.revokeApiKey(actor.userId, input.id);
            if (!revoked) return yield* Effect.fail(notFound("no such API key"));
            yield* audit.append({
              kind: "auth.apiKey.revoked",
              actor: USER_ACTOR,
              payload: { id: input.id },
            });
            return {};
          }),
        );
      }),
  };
});

/** The API key service. */
export class ApiKeys extends Context.Service<ApiKeys, Effect.Success<typeof make>>()(
  "hydra/controller/credentials/ApiKeys",
) {}

export const ApiKeysLayer: Layer.Layer<
  ApiKeys,
  never,
  SqlClient.SqlClient | Credentials | AuditLog
> = Layer.effect(ApiKeys)(make);
