import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import { CurrentActor, type Actor } from "../actor";
import { TestDatabase } from "../db/testing";
import { AuditLog, AuditLogLayer } from "../events";
import { Users, UsersLayer } from "../users";
import { Credentials, CredentialsLayer } from "./repository";
import { ApiKeys, ApiKeysLayer } from "./service";
import { hashToken } from "./token";

type Deps = ApiKeys | Credentials | Users | AuditLog;

const layer = ApiKeysLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(CredentialsLayer, UsersLayer, AuditLogLayer)),
  Layer.provideMerge(TestDatabase),
);

const run = <A, E>(effect: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)));

/**
 * The one user, and a call made as it: the actor is what the transport puts in
 * `CurrentActor` for a request under that user's login bearer.
 */
const asUser = <A, E>(body: Effect.Effect<A, E, Deps>) =>
  run(
    Effect.gen(function* () {
      const users = yield* Users;
      const user = yield* users.create("rogier", "not-a-real-hash");
      const actor: Actor = {
        _tag: "user",
        userId: user.id,
        credential: { kind: "login", id: user.id, tokenHash: "irrelevant" },
      };
      return yield* body.pipe(Effect.provideService(CurrentActor, actor));
    }),
  );

describe("apiKey.create", () => {
  it("returns a token that resolves, and stores only its hash", async () => {
    const result = await asUser(
      Effect.gen(function* () {
        const apiKeys = yield* ApiKeys;
        const credentials = yield* Credentials;
        const minted = yield* apiKeys.create({ name: "laptop" });
        return { minted, found: yield* credentials.findApiKey(hashToken(minted.token)) };
      }),
    );

    expect(result.minted.name).toBe("laptop");
    expect(result.minted.token.length).toBeGreaterThan(0);
    expect(Option.isSome(result.found)).toBe(true);
    expect(Option.getOrThrow(result.found).id).toBe(result.minted.id);
  });

  it("stamps the mint in the audit log, with the key's id and name", async () => {
    const result = await asUser(
      Effect.gen(function* () {
        const apiKeys = yield* ApiKeys;
        const audit = yield* AuditLog;
        const minted = yield* apiKeys.create({ name: "laptop" });
        return { minted, entries: yield* audit.listByKind("auth.apiKey.minted") };
      }),
    );

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.actor).toBe("user");
    expect(result.entries[0]?.payload).toEqual({ id: result.minted.id, name: "laptop" });
  });

  it("refuses a caller with no credential: the key would belong to nobody", async () => {
    const failure = await run(
      Effect.flip(Effect.flatMap(ApiKeys, (apiKeys) => apiKeys.create({ name: "laptop" }))),
    );

    expect(failure).toMatchObject({
      error: { code: "forbidden", details: { grant: "credential.write" } },
    });
  });
});

describe("apiKey.query", () => {
  it("lists the caller's keys newest first, revoked ones included, tokens never", async () => {
    const items = await asUser(
      Effect.gen(function* () {
        const apiKeys = yield* ApiKeys;
        const first = yield* apiKeys.create({ name: "laptop" });
        yield* apiKeys.create({ name: "ci" });
        yield* apiKeys.revoke({ id: first.id });
        return (yield* apiKeys.query({})).items;
      }),
    );

    expect(items.map((item) => item.name)).toEqual(["ci", "laptop"]);
    expect(items.some((item) => "token" in item)).toBe(false);
    expect(items.find((item) => item.name === "laptop")?.revokedAt).toBeDefined();
    expect(items.find((item) => item.name === "ci")?.revokedAt).toBeUndefined();
  });

  it("pages by keyset, and refuses a cursor it did not issue", async () => {
    const result = await asUser(
      Effect.gen(function* () {
        const apiKeys = yield* ApiKeys;
        yield* apiKeys.create({ name: "one" });
        yield* apiKeys.create({ name: "two" });
        const first = yield* apiKeys.query({ limit: 1 });
        const second = yield* apiKeys.query({ limit: 1, cursor: first.nextCursor ?? "" });
        const bad = yield* Effect.flip(apiKeys.query({ cursor: "not-a-cursor" }));
        return { first, second, bad };
      }),
    );

    expect(result.first.items).toHaveLength(1);
    expect(result.first.nextCursor).toBeDefined();
    expect(result.second.items).toHaveLength(1);
    expect(result.second.items[0]?.id).not.toBe(result.first.items[0]?.id);
    expect(result.second.nextCursor).toBeUndefined();
    expect(result.bad).toMatchObject({
      error: { code: "validation", details: { issues: [{ path: ["cursor"] }] } },
    });
  });
});

describe("apiKey.revoke", () => {
  it("revokes the key, stamps it, and says not_found the second time", async () => {
    const result = await asUser(
      Effect.gen(function* () {
        const apiKeys = yield* ApiKeys;
        const audit = yield* AuditLog;
        const minted = yield* apiKeys.create({ name: "laptop" });
        const first = yield* apiKeys.revoke({ id: minted.id });
        const second = yield* Effect.flip(apiKeys.revoke({ id: minted.id }));
        return { minted, first, second, entries: yield* audit.listByKind("auth.apiKey.revoked") };
      }),
    );

    expect(result.first).toEqual({});
    expect(result.second).toMatchObject({ error: { code: "not_found" } });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.payload).toEqual({ id: result.minted.id });
  });

  it("logs nothing when there was nothing to revoke: the transaction rolls back", async () => {
    const entries = await asUser(
      Effect.gen(function* () {
        const apiKeys = yield* ApiKeys;
        const audit = yield* AuditLog;
        yield* Effect.flip(apiKeys.revoke({ id: "0199f0b7-0000-7000-8000-000000000000" }));
        return yield* audit.listByKind("auth.apiKey.revoked");
      }),
    );

    expect(entries).toEqual([]);
  });
});
