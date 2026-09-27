import { assert, describe, it } from "vitest";
import { addCompletedStep, findNextOnboardingStep, ONBOARDING_STEPS } from "./onboarding";

describe("onboarding", () => {
  it("offers the timezone step, then the assistant step", () => {
    assert.deepStrictEqual([...ONBOARDING_STEPS], ["timezone", "assistant"]);
  });

  it("starts at the timezone step with nothing completed", () => {
    assert.strictEqual(findNextOnboardingStep([]), "timezone");
  });

  it("offers the assistant step once the timezone step is done", () => {
    assert.strictEqual(findNextOnboardingStep(["timezone"]), "assistant");
  });

  it("is complete once the timezone and assistant steps are done", () => {
    assert.strictEqual(findNextOnboardingStep(["timezone", "assistant"]), null);
  });

  it("ignores step ids it does not know", () => {
    assert.strictEqual(findNextOnboardingStep(["assistant-name"]), ONBOARDING_STEPS[0]);
    assert.strictEqual(findNextOnboardingStep([...ONBOARDING_STEPS, "assistant-name"]), null);
  });

  it("adds a completed step at the end of the list", () => {
    assert.deepStrictEqual(addCompletedStep(["timezone"], "assistant"), ["timezone", "assistant"]);
  });

  it("records a step that is already completed only once", () => {
    assert.deepStrictEqual(addCompletedStep(["timezone"], "timezone"), ["timezone"]);
  });
});
