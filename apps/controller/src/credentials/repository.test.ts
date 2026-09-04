import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Page } from "../db";
import { TestDatabase } from "../db/testing";
import { Users, UsersLayer } from "../users";
import {
  Credentials,
  CredentialsLayer,
  LOGIN_TOKEN_LIFETIME_MS,
  type ApiKeyRecord,
} from "./repository";
import { hashToken, mintToken } from "./token";

const layer = Layer.mergeAll(CredentialsLayer, UsersLayer).pipe(Layer.provideMerge(TestDatabase));

type Deps = Credentials | Users | SqlClient.SqlClient;

/**
 * Every test runs on a `TestClock`, so expiry and renewal are asserted by
 * moving time rather than by waiting for it.
 */
const run = <A, E>(effect: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(TestClock.layer())));

const runError = <A, E>(effect: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(
    effect.pipe(Effect.flip, Effect.provide(layer), Effect.provide(TestClock.layer())),
  );

/** Every credential belongs to a user, so every test starts with one. */
const withUser = Effect.gen(function* () {
  const users = yield* Users;
  const credentials = yield* Credentials;
  const user = yield* users.create("rogier", "hash");
  return { user, credentials };
});

const page = (over: Partial<{ limit: number; cursor: string | undefined }> = {}) => ({
  limit: over.limit ?? 50,
  cursor: over.cursor,
  direction: "desc" as const,
});

describe("login tokens", () => {
  it("resolves a presented token to its record, and an unknown one to nothing", async () => {
    const [found, unknown, issued] = await run(
      Effect.gen(function* () {
        const { user, credentials } = yield* withUser;
        const token = mintToken();
        const issued = yield* credentials.issueLoginToken(user.id, hashToken(token));
        return [
          yield* credentials.findLoginToken(hashToken(token)),
          yield* credentials.findLoginToken(hashToken(mintToken())),
          issued,
        ] as const;
      }),
    );
    expect(Option.getOrThrow(found)).toEqual(issued);
    expect(Option.isNone(unknown)).toBe(true);
    expect(Date.parse(issued.expiresAt) - Date.parse(issued.issuedAt)).toBe(
      LOGIN_TOKEN_LIFETIME_MS,
    );
  });

  it("stops resolving once the token has expired", async () => {
    const found = await run(
      Effect.gen(function* () {
        const { user, credentials } = yield* withUser;
        const token = mintToken();
        yield* credentials.issueLoginToken(user.id, hashToken(token));
        yield* TestClock.adjust(LOGIN_TOKEN_LIFETIME_MS + 1);
        return yield* credentials.findLoginToken(hashToken(token));
      }),
    );
    expect(Option.isNone(found)).toBe(true);
  });

  it("rolls the lifetime forward on use, so the window runs from the last use", async () => {
    const [issued, renewed] = await run(
      Effect.gen(function* () {
        const { user, credentials } = yield* withUser;
        const token = mintToken();
        const issued = yield* credentials.issueLoginToken(user.id, hashToken(token));
        yield* TestClock.adjust(LOGIN_TOKEN_LIFETIME_MS / 2);
        yield* credentials.renewLoginToken(issued);
        return [
          issued,
          Option.getOrThrow(yield* credentials.findLoginToken(hashToken(token))),
        ] as const;
      }),
    );
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(issued.expiresAt));
    expect(Date.parse(renewed.lastUsedAt) - Date.parse(issued.issuedAt)).toBe(
      LOGIN_TOKEN_LIFETIME_MS / 2,
    );
  });

  it("stops resolving once revoked, and revoking twice is a no-op", async () => {
    const found = await run(
      Effect.gen(function* () {
        const { user, credentials } = yield* withUser;
        const token = mintToken();
        yield* credentials.issueLoginToken(user.id, hashToken(token));
        yield* credentials.revokeLoginToken(hashToken(token));
        yield* credentials.revokeLoginToken(hashToken(token));
        return yield* credentials.findLoginToken(hashToken(token));
      }),
    );
    expect(Option.isNone(found)).toBe(true);
  });
});

describe("api keys", () => {
  it("resolves a presented key and stamps its use", async () => {
    const [created, found, touched] = await run(
      Effect.gen(function* () {
        const { user, credentials } = yield* withUser;
        const token = mintToken();
        const created = yield* credentials.createApiKey(user.id, "laptop", hashToken(token));
        const found = Option.getOrThrow(yield* credentials.findApiKey(hashToken(token)));
        yield* TestClock.adjust(1000);
        yield* credentials.touchApiKey(created);
        return [
          created,
          found,
          Option.getOrThrow(yield* credentials.findApiKey(hashToken(token))),
        ] as const;
      }),
    );
    expect(created.name).toBe("laptop");
    expect(created.lastUsedAt).toBeNull();
    expect(found).toEqual(created);
    expect(touched.lastUsedAt).not.toBeNull();
  });

  it("stops resolving a revoked key, but keeps it in the listing", async () => {
    const [revoked, again, found, listed] = await run(
      Effect.gen(function* () {
        const { user, credentials } = yield* withUser;
        const token = mintToken();
        const key = yield* credentials.createApiKey(user.id, "laptop", hashToken(token));
        return [
          yield* credentials.revokeApiKey(user.id, key.id),
          yield* credentials.revokeApiKey(user.id, key.id),
          yield* credentials.findApiKey(hashToken(token)),
          yield* credentials.listApiKeys(user.id, page()),
        ] as const;
      }),
    );
    expect(revoked).toBe(true);
    expect(again).toBe(false);
    expect(Option.isNone(found)).toBe(true);
    expect(listed.items[0]?.revokedAt).not.toBeNull();
  });

  it("will not revoke another user's key", async () => {
    const [revoked, stillLive] = await run(
      Effect.gen(function* () {
        const users = yield* Users;
        const credentials = yield* Credentials;
        const mine = yield* users.create("rogier", "hash");
        const theirs = yield* users.create("someone", "hash");
        const token = mintToken();
        const key = yield* credentials.createApiKey(mine.id, "laptop", hashToken(token));
        return [
          yield* credentials.revokeApiKey(theirs.id, key.id),
          yield* credentials.findApiKey(hashToken(token)),
        ] as const;
      }),
    );
    expect(revoked).toBe(false);
    expect(Option.isSome(stillLive)).toBe(true);
  });

  it("pages a user's keys by keyset, newest first, without repeating or skipping one", async () => {
    const [names, onlyMine] = await run(
      Effect.gen(function* () {
        const users = yield* Users;
        const credentials = yield* Credentials;
        const user = yield* users.create("rogier", "hash");
        const other = yield* users.create("someone", "hash");
        yield* credentials.createApiKey(other.id, "not-mine", hashToken(mintToken()));
        for (const name of ["one", "two", "three", "four", "five"]) {
          yield* credentials.createApiKey(user.id, name, hashToken(mintToken()));
          // Distinct timestamps on some rows and shared ones on others: the id
          // is the tiebreaker either way.
          yield* TestClock.adjust(name === "two" ? 0 : 1000);
        }

        const names: Array<string> = [];
        let cursor: string | undefined = undefined;
        for (;;) {
          const result: Page<ApiKeyRecord> = yield* credentials.listApiKeys(
            user.id,
            page({ limit: 2, cursor }),
          );
          expect(result.items.length).toBeLessThanOrEqual(2);
          names.push(...result.items.map((item) => item.name));
          cursor = result.nextCursor;
          if (cursor === undefined) break;
        }

        const all = yield* credentials.listApiKeys(user.id, page());
        return [names, all.items.map((item) => item.name)] as const;
      }),
    );
    expect(names).toEqual(["five", "four", "three", "two", "one"]);
    expect(onlyMine).toEqual(names);
  });

  it("pages oldest first when asked", async () => {
    const names = await run(
      Effect.gen(function* () {
        const { user, credentials } = yield* withUser;
        for (const name of ["one", "two", "three"]) {
          yield* credentials.createApiKey(user.id, name, hashToken(mintToken()));
          yield* TestClock.adjust(1000);
        }
        const first = yield* credentials.listApiKeys(user.id, {
          limit: 2,
          cursor: undefined,
          direction: "asc",
        });
        const rest = yield* credentials.listApiKeys(user.id, {
          limit: 2,
          cursor: first.nextCursor,
          direction: "asc",
        });
        return [...first.items, ...rest.items].map((item) => item.name);
      }),
    );
    expect(names).toEqual(["one", "two", "three"]);
  });

  it("refuses a cursor it did not issue", async () => {
    const error = await runError(
      Effect.gen(function* () {
        const { user, credentials } = yield* withUser;
        return yield* credentials.listApiKeys(user.id, page({ cursor: "bm90LWEtY3Vyc29y" }));
      }),
    );
    expect(error._tag).toBe("CursorError");
  });
});
