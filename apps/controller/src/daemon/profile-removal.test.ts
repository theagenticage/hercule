/**
 * Deleting a permission profile: what the other domains still hold decides
 * whether the row may go.
 *
 * The rows a session and an agent would be spawned from are written straight to
 * their tables: what the delete reads is the row, and spawning a session for
 * real would take the whole fleet.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Grant } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { agentRepository } from "../agents";
import { mintUuid, uuidFromString, uuidToString } from "../db";
import { TestDatabase } from "../db/testing";
import { AuditLog, AuditLogLayer } from "../events";
import {
  PermissionProfiles,
  PermissionProfilesLayer,
  Profiles,
  ProfilesLayer,
  SessionTokensLayer,
} from "../permissions";
import { ProfileRemoval, ProfileRemovalLayer } from "./profile-removal";

type Deps = ProfileRemoval | Profiles | PermissionProfiles | AuditLog | SqlClient.SqlClient;

const layer = ProfileRemovalLayer.pipe(
  Layer.provideMerge(ProfilesLayer),
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

/** Runs a call that is expected to fail, and hands the test its error. */
const runError = <A, E>(effect: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(
    effect.pipe(Effect.flip, Effect.provideService(CurrentActor, USER), Effect.provide(layer)),
  );

const READER: ReadonlyArray<Grant> = ["task.read", "run.read"];

/** The message a refusal carried, as the test reads it. */
const messageOf = (error: unknown): string =>
  (error as { readonly error: { readonly message: string } }).error.message;

/** A session carrying this profile, in the status given. */
const placeSessionOn = (profileId: string, status: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => {
    const id = mintUuid();
    const owner = uuidFromString(profileId);
    return sql`
      INSERT INTO sessions (id, permission_profile_id, instance_id, runner_id,
                            requested_access_mode, access_mode, spec, title, status,
                            created_at, last_activity_at)
      VALUES (${id}, ${owner}, ${owner}, ${owner}, 'auto', 'auto', '{}', 'a session',
              ${status}, '2026-09-15T10:00:00.000Z', '2026-09-15T10:00:00.000Z')
    `;
  });

/** An agent that spawns its sessions under this profile. */
const agentUnder = (profileId: string, name: string, at: string) =>
  Effect.flatMap(agentRepository, (agents) =>
    agents.insert({
      providerId: "claude-provider",
      name,
      systemPrompt: "do the work",
      instanceId: uuidToString(mintUuid()),
      permissionProfileId: profileId,
      accessMode: "full-access",
      model: null,
      disallowedTools: [],
      at,
    }),
  );

describe("profile.delete", () => {
  it("deletes one the user made, and stamps it", async () => {
    const { remaining, entries } = await run(
      Effect.gen(function* () {
        const profiles = yield* Profiles;
        const removal = yield* ProfileRemoval;
        const audit = yield* AuditLog;
        const created = yield* profiles.create({ name: "reviewer", grants: READER });
        yield* removal.deleteProfile({ id: created.id });
        return {
          remaining: (yield* profiles.query({})).items,
          entries: yield* audit.listByKind("profile.deleted"),
        };
      }),
    );
    expect(remaining).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.payload).toMatchObject({ name: "reviewer" });
  });

  it("refuses to delete a shipped profile", async () => {
    const error = await runError(
      Effect.gen(function* () {
        const store = yield* PermissionProfiles;
        const removal = yield* ProfileRemoval;
        yield* store.ensureShipped("assistant", ["task.read"]);
        const shipped = Option.getOrThrow(yield* store.getByName("assistant"));
        return yield* removal.deleteProfile({ id: shipped.id });
      }),
    );
    expect(error).toMatchObject({ error: { code: "invalid_state" } });
    expect(messageOf(error)).toContain("Hercule ships");
  });

  it("answers not_found for an id nobody has", async () => {
    const error = await runError(
      Effect.flatMap(ProfileRemoval, (removal) =>
        removal.deleteProfile({ id: "0199e0e7-9999-7000-8000-000000000000" }),
      ),
    );
    expect(error).toMatchObject({ error: { code: "not_found" } });
  });

  it("refuses one a session that has not exited is still bounded by", async () => {
    const error = await runError(
      Effect.gen(function* () {
        const profiles = yield* Profiles;
        const removal = yield* ProfileRemoval;
        const created = yield* profiles.create({ name: "reviewer", grants: READER });
        yield* placeSessionOn(created.id, "idle");
        return yield* removal.deleteProfile({ id: created.id });
      }),
    );

    // The session copied these grants at spawn and is held to them while it
    // runs; deleting the row would end its credential without a word.
    expect(error).toMatchObject({ error: { code: "invalid_state" } });
    expect(messageOf(error)).toContain("session");
  });

  it("deletes one whose only session has exited", async () => {
    const remaining = await run(
      Effect.gen(function* () {
        const profiles = yield* Profiles;
        const removal = yield* ProfileRemoval;
        const created = yield* profiles.create({ name: "reviewer", grants: READER });
        yield* placeSessionOn(created.id, "exited");
        yield* removal.deleteProfile({ id: created.id });
        return (yield* profiles.query({})).items;
      }),
    );

    expect(remaining).toEqual([]);
  });

  it("refuses one an agent still spawns under, naming the oldest such agent", async () => {
    const error = await runError(
      Effect.gen(function* () {
        const profiles = yield* Profiles;
        const removal = yield* ProfileRemoval;
        const created = yield* profiles.create({ name: "reviewer", grants: READER });
        yield* agentUnder(created.id, "the-elder", "2026-09-15T10:00:00.000Z");
        yield* agentUnder(created.id, "the-younger", "2026-09-15T11:00:00.000Z");
        return yield* removal.deleteProfile({ id: created.id });
      }),
    );

    expect(error).toMatchObject({ error: { code: "invalid_state" } });
    expect(messageOf(error)).toContain("the-elder");
  });

  /**
   * A profile carried by a live session and named by an agent gets the session
   * refusal: the session is the one the user has to act on first.
   */
  it("names the session before the agent when both hold the profile", async () => {
    const error = await runError(
      Effect.gen(function* () {
        const profiles = yield* Profiles;
        const removal = yield* ProfileRemoval;
        const created = yield* profiles.create({ name: "reviewer", grants: READER });
        yield* placeSessionOn(created.id, "busy");
        yield* agentUnder(created.id, "the-elder", "2026-09-15T10:00:00.000Z");
        return yield* removal.deleteProfile({ id: created.id });
      }),
    );

    expect(messageOf(error)).toContain("session");
    expect(messageOf(error)).not.toContain("the-elder");
  });
});
