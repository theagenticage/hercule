import { assert, describe, it } from "vitest";
import { nextOnboardingStep, ONBOARDING_STEPS } from "./onboarding";

describe("onboarding", () => {
  it("starts at the first step with nothing completed", () => {
    assert.strictEqual(nextOnboardingStep([]), ONBOARDING_STEPS[0]);
  });

  it("is complete once every known step is present", () => {
    assert.strictEqual(nextOnboardingStep([...ONBOARDING_STEPS]), null);
  });

  it("ignores step ids it does not know", () => {
    assert.strictEqual(nextOnboardingStep(["assistant-name"]), ONBOARDING_STEPS[0]);
    assert.strictEqual(nextOnboardingStep([...ONBOARDING_STEPS, "assistant-name"]), null);
  });
});
