/** Tests the crash-loop guard's rule for when an exited session is held back from a resume. */
import { describe, expect, it } from "vitest";
import { isResumeHeld } from "./resume-hold";

/** A resumed session that exited before starting a turn, with input waiting for it. */
const crashedBeforeWork = {
  status: "exited",
  crashGuardArmed: true,
  inputWaiting: true,
  resumable: true,
} as const;

describe("holding a session back from a resume", () => {
  it("holds a resumed session that exited before starting a turn, for input from before the exit", () => {
    expect(isResumeHeld(crashedBeforeWork)).toBe(true);
  });

  it("does not hold a session whose guard is not armed", () => {
    expect(isResumeHeld({ ...crashedBeforeWork, crashGuardArmed: false })).toBe(false);
  });

  it("does not hold a session with no input waiting", () => {
    expect(isResumeHeld({ ...crashedBeforeWork, inputWaiting: false })).toBe(false);
  });

  it("does not hold a session that could not be resumed anyway", () => {
    expect(isResumeHeld({ ...crashedBeforeWork, resumable: false })).toBe(false);
  });

  it("does not hold a session that has not exited", () => {
    expect(isResumeHeld({ ...crashedBeforeWork, status: "idle" })).toBe(false);
  });
});
