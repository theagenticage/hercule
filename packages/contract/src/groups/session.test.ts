/**
 * Tests the open Request a session record carries: the request as the harness
 * opened it, and the subagent that asked it, by id and by name.
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SessionRequest, SessionSpawnInput } from "./session";

const request = {
  requestId: "r-1",
  itemId: "item-1",
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "git push" },
} as const;

const decode = Schema.decodeUnknownSync(SessionRequest);

describe("SessionRequest", () => {
  it("accepts a Request of the session's own agent, which names no subagent", () => {
    expect(decode(request)).toEqual(request);
  });

  it("carries the id and the name of the subagent that asked", () => {
    const asked = { ...request, subagentId: "agent-a1", subagentName: "Read the docs" };
    expect(decode(asked)).toEqual(asked);
  });

  it("accepts a subagent's Request whose subagent has no name yet", () => {
    const asked = { ...request, subagentId: "agent-a1" };
    expect(decode(asked)).toEqual(asked);
  });
});

describe("starting revisions in session.spawn", () => {
  const resourceId = "0199e0e7-1111-7000-8000-000000000002";
  const spawn = (checkout: object) => ({
    prompt: "Continue work",
    workspace: { kind: "ephemeral", checkouts: [{ resourceId, ...checkout }] },
  });

  it("preserves current, named local, named remote and remote-default choices", () => {
    for (const startingRevision of [
      { kind: "current" },
      { kind: "local", branch: "feature/local-only" },
      { kind: "remote", branch: "release/2.1" },
      { kind: "remote" },
    ]) {
      const input = spawn({ startingRevision });
      expect(Schema.decodeUnknownSync(SessionSpawnInput)(input)).toEqual(input);
    }
  });

  it("keeps omitted and deprecated revision inputs valid", () => {
    for (const checkout of [{}, { baseBranch: "release/2.1" }]) {
      const input = spawn(checkout);
      expect(Schema.decodeUnknownSync(SessionSpawnInput)(input)).toEqual(input);
    }
  });

  it("refuses branch options, control characters and invalid Git ref syntax before work starts", () => {
    for (const kind of ["local", "remote"]) {
      for (const branch of [
        "",
        "--upload-pack=id",
        "feature..other",
        "feature\nother",
        "feature\u0000other",
        "feature@{1}",
        "feature.lock",
      ]) {
        expect(
          Schema.decodeUnknownExit(SessionSpawnInput)(spawn({ startingRevision: { kind, branch } }))
            ._tag,
          `${kind}: ${JSON.stringify(branch)}`,
        ).toBe("Failure");
      }
    }
  });

  it("refuses simultaneous deprecated and explicit revision choices", () => {
    for (const startingRevision of [
      { kind: "current" },
      { kind: "local", branch: "main" },
      { kind: "remote", branch: "main" },
      { kind: "remote" },
    ]) {
      expect(
        Schema.decodeUnknownExit(SessionSpawnInput)(spawn({ baseBranch: "main", startingRevision }))
          ._tag,
      ).toBe("Failure");
    }
  });
});
