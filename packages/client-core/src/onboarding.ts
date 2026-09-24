/**
 * Which onboarding step comes next.
 *
 * Progress is a list of step ids in the user settings store, so a refresh
 * resumes where it left off. The step list lives in the client: adding a step
 * is client-side work, and the settings store keeps ids it does not interpret.
 *
 * So the list is read leniently: an id this client does not know is ignored,
 * because a newer or older client wrote it. Onboarding is done when every step
 * this client knows is in the list.
 */

/** The steps after the setup gate, in the order they are offered. */
export const ONBOARDING_STEPS = ["timezone"] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** Returns the first step not yet completed, or `null` when every step is done. */
export const findNextOnboardingStep = (completedSteps: readonly string[]): OnboardingStep | null =>
  ONBOARDING_STEPS.find((step) => !completedSteps.includes(step)) ?? null;
