/**
 * Tests `SubagentFace` and its seed: a subagent's look follows its session
 * and its id, and its face never moves.
 */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Subagent } from "@hercule/contract";
import { buildLook } from "../../faces";
import { SubagentFace, buildSubagentFaceSeed, buildSubagentLook } from "./subagent-face";

const SUBAGENT: Subagent = {
  sessionId: "ses_1",
  id: "toolu_a",
  status: "running",
  startedAt: "2026-10-05T09:00:00.000Z",
  toolCalls: 0,
};

describe("buildSubagentFaceSeed", () => {
  it("joins the session id and the subagent id", () => {
    expect(buildSubagentFaceSeed("ses_1", "toolu_a")).toBe("ses_1:toolu_a");
  });
});

describe("buildSubagentLook", () => {
  it("is the look of the joined seed, so the same subagent always looks the same", () => {
    expect(buildSubagentLook(SUBAGENT)).toEqual(buildLook("ses_1:toolu_a"));
  });
});

describe("SubagentFace", () => {
  it("draws a running subagent working, and still", () => {
    const { container } = render(<SubagentFace subagent={SUBAGENT} waiting={false} size={24} />);
    expect(container.querySelector("svg")?.getAttribute("class")).toBe("cr cr--working");
  });

  it("draws a subagent that waits on the user waiting", () => {
    const { container } = render(<SubagentFace subagent={SUBAGENT} waiting size={24} />);
    expect(container.querySelector("svg")?.getAttribute("class")).toBe("cr cr--waiting");
  });
});
