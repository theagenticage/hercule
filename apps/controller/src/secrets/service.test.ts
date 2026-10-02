import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer, Option, Redacted } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Validation } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { readEventsOfKind } from "../events/testing";
import { buildHomePaths, HerculeHome } from "../config";
import { masterKeyLayer } from "./masterKey";
import { Secrets, secretsLayer } from "./repository";
import { Secret, SecretLayer } from "./service";

const RUNNER = { kind: "runner", id: "0198e4b0-0000-7000-8000-000000000001" } as const;
const CONNECTION_ID = "0198e4b0-0000-7000-8000-000000000002";

/** Returns an owner's kind and id as the two input fields an operation takes. */
const buildOwnerFields = (owner: { kind: "runner"; id: string }) => ({
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

/** Builds the real service over the real repository, a `:memory:` database and a key file. */
const buildStack = () => {
  const home = mkdtempSync(join(tmpdir(), "hercule-secret-service-"));
  homes.push(home);
  return SecretLayer.pipe(
    Layer.provideMerge(secretsLayer.pipe(Layer.provide(masterKeyLayer("file")))),
    Layer.provideMerge(AuditLogLayer),
    Layer.provideMerge(TestDatabase),
    Layer.provideMerge(Layer.succeed(HerculeHome, buildHomePaths(home, join(home, "data")))),
  );
};

type Services = Secret | Secrets | SqlClient.SqlClient;

/** Runs a call as the user actor, which is the actor of a request through the API. */
const run = <A, E>(body: (secret: Secret["Service"]) => Effect.Effect<A, E, Services>) =>
  Effect.runPromise(
    Effect.flatMap(Secret, body).pipe(
      Effect.provide(buildStack()),
      Effect.provideService(CurrentActor, USER),
    ),
  );

describe("secret.set", () => {
  it("stores a value and returns the reference, never the value", async () => {
    const ref = await run((secret) =>
      secret.set({ ...buildOwnerFields(RUNNER), name: "token", value: VALUE }),
    );

    expect(Object.keys(ref).sort()).toEqual(["createdAt", "name", "ownerId", "ownerKind"]);
    expect(ref).toMatchObject({
      ownerKind: "runner",
      ownerId: RUNNER.id,
      name: "token",
    });
    expect(ref.createdAt).toMatch(/^\d{4}-/);
    expect(JSON.stringify(ref)).not.toContain(VALUE);
  });

  it("rotates on the second write, keeping createdAt and stamping rotatedAt", async () => {
    const [first, second] = await run((secret) =>
      Effect.gen(function* () {
        const one = yield* secret.set({
          ...buildOwnerFields(RUNNER),
          name: "token",
          value: VALUE,
        });
        const two = yield* secret.set({
          ...buildOwnerFields(RUNNER),
          name: "token",
          value: "rotated",
        });
        return [one, two] as const;
      }),
    );

    expect(second?.createdAt).toBe(first?.createdAt);
    expect(second?.rotatedAt).toBeDefined();
    expect(first?.rotatedAt).toBeUndefined();
  });

  it("stores the value so the repository can read it back in this process", async () => {
    const value = await run((secret) =>
      Effect.gen(function* () {
        yield* secret.set({ ...buildOwnerFields(RUNNER), name: "token", value: VALUE });
        const secrets = yield* Secrets;
        return yield* secrets.get(RUNNER, "token");
      }),
    );

    expect(Option.isSome(value) && Redacted.value(value.value)).toBe(VALUE);
  });

  it("audits the first write as created and the second as rotated, without the value", async () => {
    const rows = await run((secret) =>
      Effect.gen(function* () {
        yield* secret.set({ ...buildOwnerFields(RUNNER), name: "token", value: VALUE });
        yield* secret.set({ ...buildOwnerFields(RUNNER), name: "token", value: "rotated" });
        return {
          created: yield* readEventsOfKind("secret.created"),
          rotated: yield* readEventsOfKind("secret.rotated"),
        };
      }),
    );

    expect(rows.created).toHaveLength(1);
    expect(rows.created[0]?.actor).toBe("user");
    expect(rows.created[0]?.payload).toEqual({
      ownerKind: "runner",
      ownerId: RUNNER.id,
      name: "token",
    });
    expect(rows.rotated).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(VALUE);
  });

  it("rejects the core owner, which holds the controller's own key material", async () => {
    const failure = await run((secret) =>
      Effect.flip(
        secret.set({ ownerKind: "core", ownerId: "controller", name: "signing", value: VALUE }),
      ),
    );

    expect(failure).toMatchObject({ error: { code: "validation" } });
    expect(JSON.stringify(failure)).toContain("ownerKind");
  });

  it("rejects the connection owner, whose credentials are replaced only with the account check", async () => {
    const failure = await run((secret) =>
      Effect.flip(
        secret.set({ ownerKind: "connection", ownerId: CONNECTION_ID, name: "pat", value: VALUE }),
      ),
    );

    expect(failure).toBeInstanceOf(Validation);
    expect(failure).toMatchObject({
      error: {
        code: "validation",
        message: expect.stringContaining("same account") as unknown,
        details: { issues: [{ path: ["ownerKind"] }] },
      },
    });
    expect(JSON.stringify(failure)).toContain("`connection.setCredentials`");
  });

  it("rejects an owner id containing the | separator used in the encryption's associated data", async () => {
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
        yield* secret.set({ ...buildOwnerFields(RUNNER), name: "b", value: VALUE });
        yield* secret.set({ ...buildOwnerFields(RUNNER), name: "a", value: VALUE });
        return yield* secret.query({});
      }),
    );

    expect(page.items.map((item) => item.name)).toEqual(["a", "b"]);
    expect(page.nextCursor).toBeUndefined();
    expect(JSON.stringify(page)).not.toContain(VALUE);
    expect(JSON.stringify(page)).not.toContain("value");
  });

  it("filters by owner, so one owner never sees another's names", async () => {
    const page = await run((secret) =>
      Effect.gen(function* () {
        yield* secret.set({ ...buildOwnerFields(RUNNER), name: "mine", value: VALUE });
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
          yield* secret.set({ ...buildOwnerFields(RUNNER), name, value: VALUE });
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
          yield* secret.set({ ...buildOwnerFields(RUNNER), name, value: VALUE });
        }
        return yield* secret.query({ sort: [{ field: "name", direction: "desc" }] });
      }),
    );

    expect(page.items.map((item) => item.name)).toEqual(["b", "a"]);
  });

  it("rejects a cursor it did not issue, rather than silently starting from the first page", async () => {
    const failure = await run((secret) => Effect.flip(secret.query({ cursor: "not-a-cursor" })));

    expect(failure).toMatchObject({
      error: { code: "validation", details: { issues: [{ path: ["cursor"] }] } },
    });
  });

  it("refuses a sort that names a field twice, and names the field", async () => {
    const failure = await run((secret) =>
      Effect.flip(
        secret.query({ sort: [{ field: "name" }, { field: "name", direction: "desc" }] }),
      ),
    );

    expect(failure).toMatchObject({ error: { code: "validation" } });
    expect(JSON.stringify(failure)).toMatch(/name appears more than once/);
  });
});

describe("secret.delete", () => {
  it("removes the value and audits the removal", async () => {
    const result = await run((secret) =>
      Effect.gen(function* () {
        yield* secret.set({ ...buildOwnerFields(RUNNER), name: "token", value: VALUE });
        yield* secret.delete({ ...buildOwnerFields(RUNNER), name: "token" });
        const secrets = yield* Secrets;
        return {
          stored: yield* secrets.get(RUNNER, "token"),
          deleted: yield* readEventsOfKind("secret.deleted"),
        };
      }),
    );

    expect(Option.isNone(result.stored)).toBe(true);
    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0]?.actor).toBe("user");
  });

  it("returns not_found for a name that is not stored", async () => {
    const failure = await run((secret) =>
      Effect.flip(secret.delete({ ...buildOwnerFields(RUNNER), name: "absent" })),
    );

    expect(failure).toMatchObject({ error: { code: "not_found" } });
  });

  it("rejects the core owner here too", async () => {
    const failure = await run((secret) =>
      Effect.flip(secret.delete({ ownerKind: "core", ownerId: "controller", name: "signing" })),
    );

    expect(failure).toMatchObject({ error: { code: "validation" } });
  });

  it("rejects the connection owner here too, pointing at deleting the Connection instead", async () => {
    const failure = await run((secret) =>
      Effect.flip(secret.delete({ ownerKind: "connection", ownerId: CONNECTION_ID, name: "pat" })),
    );

    expect(failure).toBeInstanceOf(Validation);
    expect(failure).toMatchObject({
      error: {
        code: "validation",
        message: expect.stringContaining("deleting the Connection") as unknown,
        details: { issues: [{ path: ["ownerKind"] }] },
      },
    });
  });
});

describe("the grant check", () => {
  it("runs first, for an in-process caller that never went through the HTTP transport", async () => {
    const failure = await Effect.runPromise(
      Effect.flatMap(Secret, (secret) => Effect.flip(secret.query({}))).pipe(
        Effect.provide(buildStack()),
      ),
    );

    expect(failure).toMatchObject({
      error: { code: "forbidden", details: { grant: "secret.read" } },
    });
  });
});
