/**
 * Tests `describeStatusCard`, the card a subagent's page shows in the
 * composer's place.
 */
import { describe, expect, it } from "vitest";
import { buildSession } from "../threads/workspaces.testing";
import { describeStatusCard } from "./status-card";
import { buildRequest, buildSubagent } from "./subagents.testing";

const NOW = new Date("2026-10-05T09:16:02.000Z");
const SESSION = buildSession({ id: "s-1", status: "busy" });

const PARENT = buildSubagent({
  id: "a",
  description: "Check the iDEAL redirect",
  usage: { inputTokens: 6000, outputTokens: 200 },
});
const CHILD = buildSubagent({ id: "a1", parentSubagentId: "a", description: "Read the docs" });
const GRANDCHILD = buildSubagent({ id: "a1x", parentSubagentId: "a1" });
const SUBAGENTS = [PARENT, CHILD, GRANDCHILD];

describe("describeStatusCard", () => {
  it("describes a running subagent the main agent started, with Stop for it and the ones below", () => {
    expect(describeStatusCard(PARENT, SUBAGENTS, SESSION, NOW)).toEqual({
      headline: "Working for 16m 2s",
      hue: "live",
      detail: "Subagent of the main agent · 6.2k tokens · takes no messages",
      stop: { label: "Stop with 2 below", title: "Also stops the 2 subagents below it" },
      parentSubagentId: undefined,
    });
  });

  it("names its parent, leaves unreported tokens out, and says one below in the singular", () => {
    expect(describeStatusCard(CHILD, SUBAGENTS, SESSION, NOW)).toMatchObject({
      detail: "Subagent of Check the iDEAL redirect · takes no messages",
      stop: { label: "Stop with 1 below", title: "Also stops the subagent below it" },
      parentSubagentId: "a",
    });
  });

  it("offers a plain Stop for a running subagent with none below", () => {
    expect(describeStatusCard(GRANDCHILD, SUBAGENTS, SESSION, NOW).stop).toEqual({
      label: "Stop",
      title: undefined,
    });
  });

  it("reads Waiting on you while one of its Requests is open", () => {
    const waiting = { ...SESSION, openRequests: [buildRequest("r-1", "a1x")] };
    expect(describeStatusCard(GRANDCHILD, SUBAGENTS, waiting, NOW)).toMatchObject({
      headline: "Waiting on you",
      hue: "attn",
    });
  });

  it.each([
    ["completed", "Done in 2m 20s", "muted"],
    ["failed", "Failed after 2m 20s", "fail"],
    ["stopped", "Stopped after 2m 20s", "muted"],
  ] as const)("reads a %s subagent as %s, with no Stop", (status, headline, hue) => {
    const ended = { ...GRANDCHILD, status, endedAt: "2026-10-05T09:02:20.000Z" };
    expect(describeStatusCard(ended, SUBAGENTS, SESSION, NOW)).toMatchObject({
      headline,
      hue,
      stop: null,
    });
  });
});
