/**
 * Tests the agent listing. It pages with a keyset over `(created_at, id)`, and
 * the permission profile is its only filter. Deleting a profile uses that
 * filter, so it must return the agents that name that profile and no others.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mintUuid, uuidToString } from "../db";
import { TestDatabase } from "../db/testing";
import { agentRepository } from "./repository";

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);

/** Returns a new canonical v7 id, the only id format the store accepts. */
const mintId = () => uuidToString(mintUuid());

/** Inserts one agent under a profile, created at the given time so the listing has an order. */
const insertAgent = (name: string, permissionProfileId: string, at: string) =>
  Effect.flatMap(agentRepository, (agents) =>
    agents.insert({
      kind: "agent",
      providerId: "claude-provider",
      name,
      systemPrompt: "do the work",
      instanceId: mintId(),
      permissionProfileId,
      accessMode: "full-access",
      model: null,
      disallowedTools: [],
      at,
    }),
  );

describe("listing the agents under one profile", () => {
  it("returns them oldest first and leaves out every other agent", async () => {
    const { listed, profileId } = await run(
      Effect.gen(function* () {
        const agents = yield* agentRepository;
        const profileId = mintId();
        yield* insertAgent("the-younger", profileId, "2026-09-15T11:00:00.000Z");
        yield* insertAgent("the-elder", profileId, "2026-09-15T10:00:00.000Z");
        // Another profile's agent, which the filter must leave out.
        yield* insertAgent("the-stranger", mintId(), "2026-09-15T09:00:00.000Z");
        const page = yield* agents.list({
          limit: 10,
          cursor: undefined,
          direction: "asc",
          permissionProfileId: profileId,
          kind: undefined,
        });
        return { listed: page.items, profileId };
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(listed.map((one) => one.name)).toEqual(["the-elder", "the-younger"]);
    expect(listed.every((one) => one.permissionProfileId === profileId)).toBe(true);
  });

  it("returns every agent when no profile is given", async () => {
    const listed = await run(
      Effect.gen(function* () {
        const agents = yield* agentRepository;
        yield* insertAgent("the-elder", mintId(), "2026-09-15T10:00:00.000Z");
        yield* insertAgent("the-younger", mintId(), "2026-09-15T11:00:00.000Z");
        const page = yield* agents.list({
          limit: 10,
          cursor: undefined,
          direction: "asc",
          permissionProfileId: undefined,
          kind: undefined,
        });
        return page.items;
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(listed.map((one) => one.name)).toEqual(["the-elder", "the-younger"]);
  });
});
