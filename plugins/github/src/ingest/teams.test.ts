/**
 * Tests how the user's teams are read and kept: what is stored after a read
 * that succeeds, one GitHub refuses, and one that fails.
 */
import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { TEST_TOKEN } from "../actions/testing";
import { buildIngestHarness, runAgainstStub, stubAnswer } from "../testing";
import { readUserTeams } from "./teams";

/** A stored list read long ago, so it is due to be read again. */
const STALE_TEAMS = { fetchedAt: "2020-01-01T00:00:00.000Z", teams: ["acme/web"] };

/** Reads the teams once against a stub that answers every request with `status` and `body`. */
const readTeams = async (status: number, body: unknown) => {
  const harness = buildIngestHarness();
  harness.state.set("teams", STALE_TEAMS);
  const result = await runAgainstStub(
    readUserTeams(TEST_TOKEN, harness.context.state),
    stubAnswer(status, body),
  );
  return { teams: [...Result.getOrThrow(result)], stored: harness.state.get("teams") };
};

describe("readUserTeams", () => {
  it("stores the list GitHub returns, with the time it was read", async () => {
    const { teams, stored } = await readTeams(200, [
      { slug: "Platform", organization: { login: "Acme" } },
    ]);

    expect(teams).toEqual(["acme/platform"]);
    expect(stored).toMatchObject({ teams: ["acme/platform"] });
    expect(stored).not.toEqual(STALE_TEAMS);
  });

  it("keeps the last list for an hour when the token may not read teams", async () => {
    const { teams, stored } = await readTeams(403, { message: "Resource not accessible" });

    expect(teams).toEqual(["acme/web"]);
    expect(stored).toMatchObject({ teams: ["acme/web"] });
    // Stored as read now, so the next try is in an hour.
    expect((stored as { fetchedAt: string }).fetchedAt).not.toBe(STALE_TEAMS.fetchedAt);
  });

  it("uses the last list and writes nothing when GitHub fails, so the next poll tries again", async () => {
    const { teams, stored } = await readTeams(500, { message: "Server Error" });

    expect(teams).toEqual(["acme/web"]);
    expect(stored).toEqual(STALE_TEAMS);
  });
});
