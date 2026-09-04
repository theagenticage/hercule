import { assert, describe, it } from "vitest";
import { isOnboardingComplete, nextOnboardingStep, ONBOARDING_STEPS } from "./onboarding";

describe("onboarding", () => {
  it("starts at the first step with nothing completed", () => {
    assert.strictEqual(nextOnboardingStep([]), ONBOARDING_STEPS[0]);
    assert.strictEqual(isOnboardingComplete([]), false);
  });

  it("is complete once every known step is present", () => {
    assert.strictEqual(isOnboardingComplete([...ONBOARDING_STEPS]), true);
    assert.strictEqual(nextOnboardingStep([...ONBOARDING_STEPS]), null);
  });

  it("ignores step ids it does not know", () => {
    assert.strictEqual(isOnboardingComplete(["assistant-name"]), false);
    assert.strictEqual(nextOnboardingStep(["assistant-name"]), ONBOARDING_STEPS[0]);
    assert.strictEqual(isOnboardingComplete([...ONBOARDING_STEPS, "assistant-name"]), true);
    assert.strictEqual(nextOnboardingStep([...ONBOARDING_STEPS, "assistant-name"]), null);
  });

  it("ignores the order the steps were completed in", () => {
    const reversed = [...ONBOARDING_STEPS].reverse();
    assert.strictEqual(nextOnboardingStep(reversed), null);
    assert.strictEqual(isOnboardingComplete(reversed), true);
  });
});
