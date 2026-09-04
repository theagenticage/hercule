import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer, Option, Redacted } from "effect";
import { CurrentActor, type Actor } from "../actor";
import { TestDatabase } from "../db/testing";
import { AuditLog, AuditLogLayer } from "../events";
import { homePaths, HydraHome } from "../config";
import { masterKeyLayer } from "./masterKey";
import { Secrets, secretsLayer } from "./repository";
import { Secret, SecretLayer } from "./service";

const CONNECTION = { kind: "connection", id: "0198e4b0-0000-7000-8000-000000000001" } as const;

/** The two halves of an owner, as an operation's input carries them. */
const ownerOf = (owner: { kind: "connection"; id: string }) => ({
  ownerKind: owner.kind,
  ownerId: owner.id,
});

const VALUE = "ghp_a-real-looking-token";

const USER: Actor = {
  _tag: "user",
  userId: "0199f0b7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199f0b7-0001-7000-8000-000000000000", tokenHash: "x" },
};

let homes: Array<string> = [];

afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes = [];
});

/** The real service over the real repository, a `:memory:` database and a key file. */
const stack = () => {
  const home = mkdtempSync(join(tmpdir(), "hydra-secret-service-"));
  homes.push(home);
  return SecretLayer.pipe(
    Layer.provideMerge(secretsLayer.pipe(Layer.provide(masterKeyLayer("file")))),
    Layer.provideMerge(AuditLogLayer),
    Layer.provideMerge(TestDatabase),
    Layer.provideMerge(Layer.succeed(HydraHome, homePaths(home, join(home, "data")))),
  );
};

type Services = Secret | Secrets | AuditLog;

/** Every call runs as the user actor, which is what a request through the API is. */
const run = <A, E>(body: (secret: Secret["Service"]) => Effect.Effect<A, E, Services>) =>
  Effect.runPromise(
    Effect.flatMap(Secret, body).pipe(
      Effect.provide(stack()),
      Effect.provideService(CurrentActor, USER),
    ),
  );

describe("secret.set", () => {
  it("stores a value and answers with the reference, never the value", async () => {
    const ref = await run((secret) =>
      secret.set({ ...ownerOf(CONNECTION), name: "token", value: VALUE }),
    );

    expect(Object.keys(ref).sort()).toEqual(["createdAt", "name", "ownerId", "ownerKind"]);
    expect(ref).toMatchObject({
      ownerKind: "connection",
      ownerId: CONNECTION.id,
      name: "token",
    });
    expect(ref.createdAt).toMatch(/^\d{4}-/);
    expect(JSON.stringify(ref)).not.toContain(VALUE);
  });

  it("rotates on the second write, keeping createdAt and stamping rotatedAt", async () => {
    const [first, second] = await run((secret) =>
      Effect.gen(function* () {
        const one = yield* secret.set({ ...ownerOf(CONNECTION), name: "token", value: VALUE });
        const two = yield* secret.set({ ...ownerOf(CONNECTION), name: "token", value: "rotated" });
        return [one, two] as const;
      }),
    );

    expect(second?.createdAt).toBe(first?.createdAt);
    expect(second?.rotatedAt).toBeDefined();
    expect(first?.rotatedAt).toBeUndefined();
  });

  it("stores what was written, so the value is readable in this process only", async () => {
    const value = await run((secret) =>
      Effect.gen(function* () {
        yield* secret.set({ ...ownerOf(CONNECTION), name: "token", value: VALUE });
        const secrets = yield* Secrets;
        return yield* secrets.get(CONNECTION, "token");
      }),
    );

    expect(Option.isSome(value) && Redacted.value(value.value)).toBe(VALUE);
  });

  it("audits the write as created and then as rotated, naming no value", async () => {
    const rows = await run((secret) =>
      Effect.gen(function* () {
        yield* secret.set({ ...ownerOf(CONNECTION), name: "token", value: VALUE });
        yield* secret.set({ ...ownerOf(CONNECTION), name: "token", value: "rotated" });
        const log = yield* AuditLog;
        return {
          created: yield* log.listByKind("secret.created"),
          rotated: yield* log.listByKind("secret.rotated"),
        };
      }),
    );

    expect(rows.created).toHaveLength(1);
    expect(rows.created[0]?.actor).toBe("user");
    expect(rows.created[0]?.payload).toEqual({
      ownerKind: "connection",
      ownerId: CONNECTION.id,
      name: "token",
    });
    expect(rows.rotated).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(VALUE);
  });

  it("refuses the core owner: it holds the controller's own key material", async () => {
    const failure = await run((secret) =>
      Effect.flip(
        secret.set({ ownerKind: "core", ownerId: "controller", name: "signing", value: VALUE }),
      ),
    );

    expect(failure).toMatchObject({ error: { code: "validation" } });
    expect(JSON.stringify(failure)).toContain("ownerKind");
  });

  it("refuses an owner id holding the separator the encryption is bound with", async () => {
    const failure = await run((secret) =>
      Effect.flip(secret.set({ ownerKind: "plugin", ownerId: "a|b", name: "k", value: VALUE })),
    );

    expect(failure).toMatchObject({ error: { code: "validation" } });
  });
});

describe("secret.query", () => {
  it("lists references by name, with no value field anywhere", async () => {
    const page = await run((secret) =>
      Effect.gen(function* () {
        yield* secret.set({ ...ownerOf(CONNECTION), name: "b", value: VALUE });
        yield* secret.set({ ...ownerOf(CONNECTION), name: "a", value: VALUE });
        return yield* secret.query({});
      }),
    );

    expect(page.items.map((item) => item.name)).toEqual(["a", "b"]);
    expect(page.nextCursor).toBeUndefined();
    expect(JSON.stringify(page)).not.toContain(VALUE);
    expect(JSON.stringify(page)).not.toContain("value");
  });

  it("filters by owner, so one connection never sees another's names", async () => {
    const page = await run((secret) =>
      Effect.gen(function* () {
        yield* secret.set({ ...ownerOf(CONNECTION), name: "mine", value: VALUE });
        yield* secret.set({ ownerKind: "plugin", ownerId: "slack", name: "theirs", value: VALUE });
        return yield* secret.query({ ownerKind: "plugin", ownerId: "slack" });
      }),
    );

    expect(page.items.map((item) => item.name)).toEqual(["theirs"]);
  });

  it("pages by keyset, so the second page starts where the first stopped", async () => {
    const pages = await run((secret) =>
      Effect.gen(function* () {
        for (const name of ["a", "b", "c"]) {
          yield* secret.set({ ...ownerOf(CONNECTION), name, value: VALUE });
        }
        const first = yield* secret.query({ limit: 2 });
        const cursor = first.nextCursor;
        if (cursor === undefined) throw new Error("expected a next page");
        const second = yield* secret.query({ limit: 2, cursor });
        return { first, second };
      }),
    );

    expect(pages.first.items.map((item) => item.name)).toEqual(["a", "b"]);
    expect(pages.first.nextCursor).toBeDefined();
    expect(pages.second.items.map((item) => item.name)).toEqual(["c"]);
    expect(pages.second.nextCursor).toBeUndefined();
  });

  it("sorts the other way when asked", async () => {
    const page = await run((secret) =>
      Effect.gen(function* () {
        for (const name of ["a", "b"]) {
          yield* secret.set({ ...ownerOf(CONNECTION), name, value: VALUE });
        }
        return yield* secret.query({ sort: { field: "name", direction: "desc" } });
      }),
    );

    expect(page.items.map((item) => item.name)).toEqual(["b", "a"]);
  });

  it("refuses a cursor it did not issue rather than quietly starting over", async () => {
    const failure = await run((secret) => Effect.flip(secret.query({ cursor: "not-a-cursor" })));

    expect(failure).toMatchObject({ error: { code: "validation" } });
  });
});

describe("secret.delete", () => {
  it("removes the value and audits the removal", async () => {
    const result = await run((secret) =>
      Effect.gen(function* () {
        yield* secret.set({ ...ownerOf(CONNECTION), name: "token", value: VALUE });
        yield* secret.delete({ ...ownerOf(CONNECTION), name: "token" });
        const secrets = yield* Secrets;
        const log = yield* AuditLog;
        return {
          stored: yield* secrets.get(CONNECTION, "token"),
          deleted: yield* log.listByKind("secret.deleted"),
        };
      }),
    );

    expect(Option.isNone(result.stored)).toBe(true);
    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0]?.actor).toBe("user");
  });

  it("answers not_found for a name nobody stored", async () => {
    const failure = await run((secret) =>
      Effect.flip(secret.delete({ ...ownerOf(CONNECTION), name: "absent" })),
    );

    expect(failure).toMatchObject({ error: { code: "not_found" } });
  });

  it("refuses the core owner here too", async () => {
    const failure = await run((secret) =>
      Effect.flip(secret.delete({ ownerKind: "core", ownerId: "controller", name: "signing" })),
    );

    expect(failure).toMatchObject({ error: { code: "validation" } });
  });
});

describe("the grant check", () => {
  it("runs before anything else, for the in-process caller the transport never gated", async () => {
    const failure = await Effect.runPromise(
      Effect.flatMap(Secret, (secret) => Effect.flip(secret.query({}))).pipe(
        Effect.provide(stack()),
      ),
    );

    expect(failure).toMatchObject({
      error: { code: "forbidden", details: { grant: "secret.read" } },
    });
  });
});
