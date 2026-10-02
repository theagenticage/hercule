import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import type { Grant } from "@hercule/contract";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CurrentActor, type Actor } from "../actor";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { readEventsOfKind } from "../events/testing";
import { PermissionProfiles, PermissionProfilesLayer } from "./profiles";
import { Profiles, ProfilesLayer } from "./service";
import { SessionTokensLayer } from "./tokens";

type Deps = Profiles | PermissionProfiles | SqlClient.SqlClient;

const layer = ProfilesLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(PermissionProfilesLayer, AuditLogLayer, SessionTokensLayer)),
  Layer.provideMerge(TestDatabase),
);

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

const run = <A, E>(effect: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(effect.pipe(Effect.provideService(CurrentActor, USER), Effect.provide(layer)));

/** Runs a call that is expected to fail, and returns its error. */
const runError = <A, E>(effect: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(
    effect.pipe(Effect.flip, Effect.provideService(CurrentActor, USER), Effect.provide(layer)),
  );

const READER: ReadonlyArray<Grant> = ["task.read", "run.read"];

describe("profile.create", () => {
  it("creates a user profile and records a profile.created event", async () => {
    const { profile, entries } = await run(
      Effect.gen(function* () {
        const profiles = yield* Profiles;
        const created = yield* profiles.create({ name: "reviewer", grants: READER });
        return { profile: created, entries: yield* readEventsOfKind("profile.created") };
      }),
    );
    expect(profile).toMatchObject({ name: "reviewer", grants: READER, shipped: false });
    expect(profile.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(profile.createdAt).toBe(profile.updatedAt);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actor).toBe("user");
    expect(entries[0]?.payload).toEqual({ id: profile.id, name: "reviewer" });
  });

  it("rejects a patch with no field, and records no event", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const profiles = yield* Profiles;
        const created = yield* profiles.create({ name: "reviewer", grants: READER });
        const error = yield* Effect.flip(profiles.update({ id: created.id }));
        return { error, entries: yield* readEventsOfKind("profile.updated") };
      }),
    );
    expect(outcome.error).toMatchObject({ error: { code: "validation" } });
    expect(outcome.entries).toEqual([]);
  });

  it("rejects a name that another profile already has", async () => {
    const error = await runError(
      Effect.gen(function* () {
        const profiles = yield* Profiles;
        yield* profiles.create({ name: "reviewer", grants: READER });
        return yield* profiles.create({ name: "reviewer", grants: [] });
      }),
    );
    expect(error).toMatchObject({ error: { code: "conflict" } });
  });

  it("records no event when it fails", async () => {
    const entries = await run(
      Effect.gen(function* () {
        const profiles = yield* Profiles;
        yield* profiles.create({ name: "reviewer", grants: READER });
        yield* Effect.ignore(profiles.create({ name: "reviewer", grants: [] }));
        return yield* readEventsOfKind("profile.created");
      }),
    );
    expect(entries).toHaveLength(1);
  });
});

describe("profile.query", () => {
  it("pages by name, and the cursor continues where the page ended", async () => {
    const { first, second } = await run(
      Effect.gen(function* () {
        const profiles = yield* Profiles;
        for (const name of ["charlie", "alpha", "bravo"]) {
          yield* profiles.create({ name, grants: [] });
        }
        const page = yield* profiles.query({ limit: 2 });
        const cursor = page.nextCursor;
        if (cursor === undefined) throw new Error("expected a page to follow");
        return { first: page, second: yield* profiles.query({ limit: 2, cursor }) };
      }),
    );
    expect(first.items.map((profile) => profile.name)).toEqual(["alpha", "bravo"]);
    expect(first.nextCursor).toBeDefined();
    expect(second.items.map((profile) => profile.name)).toEqual(["charlie"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("sorts in descending order when asked", async () => {
    const names = await run(
      Effect.gen(function* () {
        const profiles = yield* Profiles;
        for (const name of ["alpha", "bravo"]) yield* profiles.create({ name, grants: [] });
        const page = yield* profiles.query({ sort: [{ field: "name", direction: "desc" }] });
        return page.items.map((profile) => profile.name);
      }),
    );
    expect(names).toEqual(["bravo", "alpha"]);
  });

  it("rejects a cursor it did not issue", async () => {
    const error = await runError(
      Effect.flatMap(Profiles, (profiles) => profiles.query({ cursor: "not-a-cursor" })),
    );
    expect(error).toMatchObject({ error: { code: "validation" } });
  });
});

describe("profile.read", () => {
  it("fails with not_found for an unknown id", async () => {
    const error = await runError(
      Effect.flatMap(Profiles, (profiles) =>
        profiles.read({ id: "0199e0e7-9999-7000-8000-000000000000" }),
      ),
    );
    expect(error).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("profile.update", () => {
  it("edits a shipped profile, because shipped profiles are editable", async () => {
    const { updated, entries } = await run(
      Effect.gen(function* () {
        const store = yield* PermissionProfiles;
        const profiles = yield* Profiles;
        yield* store.ensureShipped("worker", ["task.read"]);
        const shipped = Option.getOrThrow(yield* store.getByName("worker"));
        const changed = yield* profiles.update({ id: shipped.id, grants: READER });
        return { updated: changed, entries: yield* readEventsOfKind("profile.updated") };
      }),
    );
    expect(updated).toMatchObject({ name: "worker", grants: READER, shipped: true });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.payload).toEqual({ id: updated.id, name: "worker" });
  });

  it("keeps the fields the patch does not set", async () => {
    const updated = await run(
      Effect.gen(function* () {
        const profiles = yield* Profiles;
        const created = yield* profiles.create({ name: "reviewer", grants: READER });
        return yield* profiles.update({ id: created.id, name: "auditor" });
      }),
    );
    expect(updated).toMatchObject({ name: "auditor", grants: READER });
  });

  it("rejects a patch with no field, and records no event", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const profiles = yield* Profiles;
        const created = yield* profiles.create({ name: "reviewer", grants: READER });
        const error = yield* Effect.flip(profiles.update({ id: created.id }));
        return { error, entries: yield* readEventsOfKind("profile.updated") };
      }),
    );
    expect(outcome.error).toMatchObject({ error: { code: "validation" } });
    expect(outcome.entries).toEqual([]);
  });

  it("rejects a name that another profile already has", async () => {
    const error = await runError(
      Effect.gen(function* () {
        const profiles = yield* Profiles;
        yield* profiles.create({ name: "reviewer", grants: [] });
        const other = yield* profiles.create({ name: "auditor", grants: [] });
        return yield* profiles.update({ id: other.id, name: "reviewer" });
      }),
    );
    expect(error).toMatchObject({ error: { code: "conflict" } });
  });

  it("fails with not_found for an unknown id", async () => {
    const error = await runError(
      Effect.flatMap(Profiles, (profiles) =>
        profiles.update({ id: "0199e0e7-9999-7000-8000-000000000000", name: "x" }),
      ),
    );
    expect(error).toMatchObject({ error: { code: "not_found" } });
  });
});
