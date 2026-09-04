/**
 * Which onboarding step comes next.
 *
 * Progress is a list of step ids in the user settings store, so a refresh
 * resumes where it left off. The step list lives in the client: adding a step
 * is client-side work, and the settings store keeps ids it does not interpret.
 *
 * Reading the list is therefore forgiving in one direction only. An id this
 * client does not know is ignored - a newer client wrote it, or an older one
 * did. Onboarding is done when every id this client does know is present.
 */

/** The steps after the setup gate, in the order they are offered. */
export const ONBOARDING_STEPS = ["timezone"] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** The first step not yet completed, or `null` when there is none left. */
export const nextOnboardingStep = (completedSteps: readonly string[]): OnboardingStep | null =>
  ONBOARDING_STEPS.find((step) => !completedSteps.includes(step)) ?? null;

export const isOnboardingComplete = (completedSteps: readonly string[]): boolean =>
  nextOnboardingStep(completedSteps) === null;
