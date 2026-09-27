/**
 * The entry guard: decides where a page load actually lands.
 *
 * The checks run in this order:
 *
 * - an installation that has not been set up goes to the setup screen;
 * - a visitor with no token goes to the login screen;
 * - a user with an onboarding step left goes to that step;
 * - everyone else gets the route they asked for.
 *
 * This module only puts the checks in order. `client-core` decides what the
 * onboarding steps are, when onboarding is finished and when a rejected token
 * is dropped. Nothing here interprets a settings value or an error beyond
 * choosing a route from it.
 */
import { ApiError, findNextOnboardingStep, type OnboardingStep } from "@hercule/client-core";
import type { SettingsState } from "@hercule/contract";
import type { RouterContext } from "./context";
import { setupQuery, settingsQuery } from "./queries";

export const HOME_PATH = "/";
export const LOGIN_PATH = "/login";
export const SETUP_PATH = "/setup";

/** The path of each onboarding step's screen. */
const ONBOARDING_PATH = {
  timezone: "/onboarding/timezone",
  assistant: "/onboarding/assistant",
} as const satisfies Record<OnboardingStep, string>;

/** Every path the guard can send a request to. */
export type EntryPath =
  | typeof HOME_PATH
  | typeof LOGIN_PATH
  | typeof SETUP_PATH
  | (typeof ONBOARDING_PATH)[OnboardingStep];

/** The screens that are only shown before the user can reach the app itself. */
const BEFORE_THE_APP = new Set<string>([LOGIN_PATH, SETUP_PATH, ...Object.values(ONBOARDING_PATH)]);

/** The three reads the guard depends on, so a test can replace them. */
export interface EntryDeps {
  readonly hasToken: () => boolean;
  readonly readSetup: () => Promise<{ readonly complete: boolean }>;
  readonly readSettings: () => Promise<SettingsState>;
}

export const buildEntryDeps = ({ client, queryClient }: RouterContext): EntryDeps => ({
  hasToken: () => client.getToken() !== null,
  readSetup: () => queryClient.ensureQueryData(setupQuery(client)),
  readSettings: () => queryClient.ensureQueryData(settingsQuery(client)),
});

/** Returns the path to redirect `pathname` to, or `null` to let it through. */
export const resolveEntry = async (
  deps: EntryDeps,
  pathname: string,
): Promise<EntryPath | null> => {
  const { complete } = await deps.readSetup();
  if (!complete) return pathname === SETUP_PATH ? null : SETUP_PATH;
  if (!deps.hasToken()) return pathname === LOGIN_PATH ? null : LOGIN_PATH;

  let completedSteps: readonly string[];
  try {
    completedSteps = (await deps.readSettings()).user["onboarding.completedSteps"] ?? [];
  } catch (error) {
    // The token was rejected. `client-core` has already dropped it, so the
    // login screen is the only place left to go.
    if (error instanceof ApiError && error.code === "unauthenticated") return LOGIN_PATH;
    throw error;
  }

  const step = findNextOnboardingStep(completedSteps);
  if (step === null) return BEFORE_THE_APP.has(pathname) ? HOME_PATH : null;
  return pathname === ONBOARDING_PATH[step] ? null : ONBOARDING_PATH[step];
};
