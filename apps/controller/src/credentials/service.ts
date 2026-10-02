/**
 * The user's API keys: mint, list, revoke.
 *
 * A key's token exists in exactly one place: the response to the call that
 * minted it. Nothing stores it and no later operation can show it again, which
 * is why `query` lists references only. Losing a key means minting another.
 *
 * Revoking the key the caller is using is allowed. It takes effect on the next
 * request, so the call that revokes it still succeeds. Rejecting that call
 * instead would keep a leaked key alive just because the caller who noticed
 * the leak was using that key.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  DEFAULT_PAGE_LIMIT,
  createNotFoundError,
  createValidationError,
  type ApiKey,
  type Forbidden,
  type NotFound,
  type SortDirection,
  type SortKey,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { requireUserActor, USER_ACTOR } from "../actor";
import { resolveSortDirection, withTransaction } from "../db";
import { AuditLog } from "../events";
import { Credentials, type ApiKeyRecord } from "./repository";
import { hashToken, mintToken } from "./token";

/** The input of `apiKey.query`. An absent field takes its default. */
export interface QueryInput {
  readonly limit?: number;
  readonly cursor?: string;
  readonly sort?: ReadonlyArray<SortKey<"createdAt">>;
}

/** One page of keys, in the contract's shape. */
export interface ApiKeyPage {
  readonly items: ReadonlyArray<ApiKey>;
  readonly nextCursor?: string;
}

/**
 * Newest first: the user usually looks for the key just minted or the one to
 * revoke, and both are usually recent.
 */
const DEFAULT_DIRECTION: SortDirection = "desc";

/**
 * Converts a key record to the shape the API returns. `lastUsedAt` and
 * `revokedAt` are left out, not set to `null`, when the key has not been used
 * or revoked, because the contract declares them optional.
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
     * Mints a key and returns its token. This is the only time the token is
     * returned: only its hash is stored, so nothing durable ever holds it.
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
        const actor = yield* requireUserActor("apiKey.create");
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
     * Returns one page of the caller's own keys, revoked ones included, so a
     * revoked key shows as revoked rather than disappearing.
     */
    query: (
      input: QueryInput,
    ): Effect.Effect<ApiKeyPage, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        const actor = yield* requireUserActor("apiKey.query");
        const page = yield* credentials
          .listApiKeys(actor.userId, {
            limit: input.limit ?? DEFAULT_PAGE_LIMIT,
            cursor: input.cursor,
            direction: resolveSortDirection(input.sort, DEFAULT_DIRECTION),
          })
          .pipe(
            Effect.catchTag("CursorError", (error) =>
              Effect.fail(createValidationError([{ path: ["cursor"], message: error.message }])),
            ),
          );
        return {
          items: page.items.map(toApiKey),
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        };
      }),

    /**
     * Revokes one of the caller's keys. Fails with `not_found` both for a key
     * that is not the caller's and for a key already revoked: in neither case
     * can the caller do anything differently, and the first must not confirm
     * that the id exists.
     */
    revoke: (input: {
      readonly id: string;
    }): Effect.Effect<Record<string, never>, Unauthenticated | Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        const actor = yield* requireUserActor("apiKey.revoke");
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const revoked = yield* credentials.revokeApiKey(actor.userId, input.id);
            if (!revoked) return yield* Effect.fail(createNotFoundError("no such API key"));
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
  "hercule/controller/credentials/ApiKeys",
) {}

export const ApiKeysLayer: Layer.Layer<
  ApiKeys,
  never,
  SqlClient.SqlClient | Credentials | AuditLog
> = Layer.effect(ApiKeys)(make);
