/** Tests the crash-loop guard's rule for when an exited session is held back from a resume. */
import { describe, expect, it } from "vitest";
import { isResumeHeld } from "./resume-hold";

/** An exited session whose last process started no turn, with input from before the exit. */
const crashedBeforeWork = {
  status: "exited",
  awaitingNewInput: true,
  inputWaiting: true,
} as const;

describe("holding a session back from a resume", () => {
  it("holds a session that exited before starting a turn, for input from before the exit", () => {
    expect(isResumeHeld(crashedBeforeWork)).toBe(true);
  });

  it("does not hold a session whose last process started a turn, or that got new input", () => {
    expect(isResumeHeld({ ...crashedBeforeWork, awaitingNewInput: false })).toBe(false);
  });

  it("does not hold a session with no input waiting", () => {
    expect(isResumeHeld({ ...crashedBeforeWork, inputWaiting: false })).toBe(false);
  });

  it("does not hold a session that has not exited", () => {
    expect(isResumeHeld({ ...crashedBeforeWork, status: "idle" })).toBe(false);
  });
});
