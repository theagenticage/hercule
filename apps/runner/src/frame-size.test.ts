/** Tests how the runner keeps a skills answer inside the largest frame the controller accepts. */
import { describe, expect, it } from "vitest";
import { MAX_FRAME_BYTES, type RepositorySkillsInspection } from "@hercule/protocol";
import { fitRepositorySkillsInspection, measureFrameBytes } from "./frame-size";

const inspectionWith = (
  outcome: RepositorySkillsInspection["outcome"],
): RepositorySkillsInspection => ({
  _tag: "repositorySkillsInspection",
  requestId: "request-1",
  outcome,
});

describe("fitRepositorySkillsInspection", () => {
  it("returns an answer that fits as it is", () => {
    const inspection = inspectionWith({
      status: "listed",
      skills: [],
      skipped: [],
      truncated: false,
    });

    expect(fitRepositorySkillsInspection(inspection)).toBe(inspection);
  });

  it("answers failed, with the size, when the list does not fit in a frame", () => {
    const skills = Array.from({ length: 256 }, () => ({
      checkoutName: "app",
      name: "release",
      // The schema allows 1024 characters, and a lone surrogate takes six bytes in JSON.
      description: "\ud800".repeat(1024),
      path: "x".repeat(2000),
    }));
    // The frame is built without the schema on purpose: the check must hold whatever the list holds.
    const inspection = inspectionWith({ status: "listed", skills, skipped: [], truncated: false });
    expect(measureFrameBytes(inspection)).toBeGreaterThan(MAX_FRAME_BYTES);

    const fitted = fitRepositorySkillsInspection(inspection);

    expect(fitted.requestId).toBe("request-1");
    expect(fitted.outcome.status).toBe("failed");
    expect(fitted.outcome).toHaveProperty("message", expect.stringMatching(/too large to send/));
    expect(measureFrameBytes(fitted)).toBeLessThan(MAX_FRAME_BYTES);
  });
});
