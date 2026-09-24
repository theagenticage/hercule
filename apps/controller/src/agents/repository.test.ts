/**
 * The agent listing: the walk itself is one keyset over `(created_at, id)`, and
 * the permission profile is the one thing that narrows it. The profile filter
 * is what the delete of a profile reads, so it has to answer the agents that
 * name one profile and nothing else.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mintUuid, uuidToString } from "../db";
import { TestDatabase } from "../db/testing";
import { agentRepository } from "./repository";

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);

/** A canonical v7 id, which is the only shape the store takes. */
const mintId = () => uuidToString(mintUuid());

/** One agent under a profile, written at the instant given so the walk has an order. */
const insertAgent = (name: string, permissionProfileId: string, at: string) =>
  Effect.flatMap(agentRepository, (agents) =>
    agents.insert({
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
  it("answers them oldest first and leaves every other agent out", async () => {
    const { listed, profileId } = await run(
      Effect.gen(function* () {
        const agents = yield* agentRepository;
        const profileId = mintId();
        yield* insertAgent("the-younger", profileId, "2026-09-15T11:00:00.000Z");
        yield* insertAgent("the-elder", profileId, "2026-09-15T10:00:00.000Z");
        // Another profile's agent, which the filter must not answer.
        yield* insertAgent("the-stranger", mintId(), "2026-09-15T09:00:00.000Z");
        const page = yield* agents.list({
          limit: 10,
          cursor: undefined,
          direction: "asc",
          permissionProfileId: profileId,
        });
        return { listed: page.items, profileId };
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(listed.map((one) => one.name)).toEqual(["the-elder", "the-younger"]);
    expect(listed.every((one) => one.permissionProfileId === profileId)).toBe(true);
  });

  it("answers every agent when no profile narrows the walk", async () => {
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
        });
        return page.items;
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(listed.map((one) => one.name)).toEqual(["the-elder", "the-younger"]);
  });
});
