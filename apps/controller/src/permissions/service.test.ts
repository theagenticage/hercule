import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import type { Grant } from "@hercule/contract";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CurrentActor, type Actor } from "../actor";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { readEventsOfKind } from "../events/testing";
import { PermissionProfiles, PermissionProfilesLayer } from "./profiles";
import { Profiles, ProfilesLayer, requireMayAssignAgentProfile } from "./service";
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
    expect(error).toMatchObject({
      error: { code: "validation", details: { issues: [{ path: ["cursor"] }] } },
    });
  });

  it("refuses a sort that names a field twice, and names the field", async () => {
    const error = await runError(
      Effect.flatMap(Profiles, (profiles) =>
        profiles.query({ sort: [{ field: "name" }, { field: "name", direction: "desc" }] }),
      ),
    );
    expect(error).toMatchObject({ error: { code: "validation" } });
    expect(JSON.stringify(error)).toMatch(/name appears more than once/);
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

/**
 * A session on a profile that holds `permission.write`, as the shipped
 * `unrestricted` profile does. Its profile id names no row: the guard reads
 * only the profile being changed.
 */
const SESSION: Actor = {
  _tag: "session",
  sessionId: "0199e0e7-0002-7000-8000-000000000000",
  profileId: "0199e0e7-0003-7000-8000-000000000000",
  grants: ["permission.write", "skill.write", "skill.apply"],
  profileGrants: ["permission.write", "skill.write", "skill.apply"],
  assistantId: null,
  agentId: null,
};

/**
 * Checks that `error` is the refusal of a skill grant to a session: a 403
 * naming `permission.write`, whose message says only the user gives it.
 */
const expectSkillGrantRefusal = (error: unknown) =>
  expect(error).toMatchObject({
    error: {
      code: "forbidden",
      details: { grant: "permission.write" },
      message: expect.stringMatching(
        /^Only the user gives a profile `skill\.write` or `skill\.apply`/,
      ) as unknown,
    },
  });

/** Runs `effect` as the session, from inside a test that runs as the user. */
const asSession = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(CurrentActor, SESSION));

describe("giving a profile skill.write or skill.apply", () => {
  it("refuses a session's profile.create holding either, naming permission.write", async () => {
    const errors = await run(
      Effect.gen(function* () {
        const profiles = yield* Profiles;
        return [
          yield* Effect.flip(
            asSession(profiles.create({ name: "a", grants: ["task.read", "skill.write"] })),
          ),
          yield* Effect.flip(asSession(profiles.create({ name: "b", grants: ["skill.apply"] }))),
        ];
      }),
    );
    for (const error of errors) {
      expectSkillGrantRefusal(error);
    }
  });

  it("lets a session create a profile without them", async () => {
    const created = await run(
      Profiles.pipe(
        Effect.flatMap((profiles) =>
          asSession(profiles.create({ name: "reader", grants: ["task.read", "skill.read"] })),
        ),
      ),
    );
    expect(created.grants).toEqual(["task.read", "skill.read"]);
  });

  it("refuses a session's profile.update that adds either, and leaves the profile as it was", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const profiles = yield* Profiles;
        const created = yield* profiles.create({ name: "reviewer", grants: READER });
        const errors = [
          yield* Effect.flip(
            asSession(profiles.update({ id: created.id, grants: [...READER, "skill.write"] })),
          ),
          yield* Effect.flip(
            asSession(profiles.update({ id: created.id, grants: [...READER, "skill.apply"] })),
          ),
        ];
        return { errors, after: yield* profiles.read({ id: created.id }) };
      }),
    );
    for (const error of outcome.errors) {
      expectSkillGrantRefusal(error);
    }
    expect(outcome.after.grants).toEqual(READER);
  });

  it("lets a session keep or remove them on a profile that already holds them", async () => {
    const [kept, removed] = await run(
      Effect.gen(function* () {
        const profiles = yield* Profiles;
        const created = yield* profiles.create({
          name: "applier",
          grants: ["skill.write", "skill.apply"],
        });
        const kept = yield* asSession(
          profiles.update({ id: created.id, grants: ["task.read", "skill.write", "skill.apply"] }),
        );
        const removed = yield* asSession(
          profiles.update({ id: created.id, grants: ["task.read"] }),
        );
        return [kept, removed] as const;
      }),
    );
    expect(kept.grants).toEqual(["task.read", "skill.write", "skill.apply"]);
    expect(removed.grants).toEqual(["task.read"]);
  });

  it("lets the user create and update profiles with them", async () => {
    const [created, updated] = await run(
      Effect.gen(function* () {
        const profiles = yield* Profiles;
        const created = yield* profiles.create({ name: "applier", grants: ["skill.apply"] });
        const other = yield* profiles.create({ name: "proposer", grants: READER });
        const updated = yield* profiles.update({
          id: other.id,
          grants: [...READER, "skill.write"],
        });
        return [created, updated] as const;
      }),
    );
    expect(created.grants).toEqual(["skill.apply"]);
    expect(updated.grants).toEqual([...READER, "skill.write"]);
  });

  it("answers not_found, not forbidden, for a session's update of an unknown profile", async () => {
    const error = await runError(
      Profiles.pipe(
        Effect.flatMap((profiles) =>
          asSession(
            profiles.update({
              id: "0199e0e7-9999-7000-8000-000000000000",
              grants: ["skill.apply"],
            }),
          ),
        ),
      ),
    );
    expect(error).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("putting an Agent on a profile that holds skill.write or skill.apply", () => {
  it("refuses a session, naming agent.write, and says to ask the user", async () => {
    const errors = await Effect.runPromise(
      Effect.all(
        [
          Effect.flip(requireMayAssignAgentProfile(SESSION, ["task.read", "skill.write"])),
          Effect.flip(requireMayAssignAgentProfile(SESSION, ["skill.apply"])),
        ],
        { concurrency: 1 },
      ),
    );
    for (const error of errors) {
      expect(error).toMatchObject({
        error: {
          code: "forbidden",
          details: { grant: "agent.write" },
          message: expect.stringMatching(
            /^Only the user puts an Agent or an assistant on a profile that holds `skill\.write` or `skill\.apply`.*ask the user/,
          ) as unknown,
        },
      });
    }
  });

  it("lets a session name a profile without them, and lets the user and a run name any", async () => {
    const runActor: Actor = { _tag: "run", runId: "r", stepId: "s", workflowId: null };
    await Effect.runPromise(
      Effect.all([
        requireMayAssignAgentProfile(SESSION, ["task.read", "skill.read"]),
        requireMayAssignAgentProfile(USER, ["skill.write", "skill.apply"]),
        requireMayAssignAgentProfile(runActor, ["skill.write", "skill.apply"]),
      ]),
    );
  });
});
