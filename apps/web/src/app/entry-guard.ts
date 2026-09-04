/**
 * Where a page load actually lands.
 *
 * Four things stand between a URL and the screen behind it, and they are
 * ordered: an installation that has not been set up has nothing but the setup
 * screen, a visitor with no token has nothing but the login screen, a user with
 * onboarding left has that step, and everyone else gets the route they asked
 * for.
 *
 * This module only sequences. What the steps are, when onboarding is finished
 * and what clears a rejected token are all decided in `client-core`; nothing
 * here interprets a settings value or an error beyond routing on it.
 */
import { ApiError, nextOnboardingStep, type OnboardingStep } from "@hydra/client-core";
import type { SettingsState } from "@hydra/contract";
import type { RouterContext } from "./context";
import { setupQuery, settingsQuery } from "./queries";

export const HOME_PATH = "/";
export const LOGIN_PATH = "/login";
export const SETUP_PATH = "/setup";

/** Where each onboarding step is answered. */
const ONBOARDING_PATH = {
  timezone: "/onboarding/timezone",
} as const satisfies Record<OnboardingStep, string>;

/** Every path the guard can send a request to. */
export type EntryPath =
  | typeof HOME_PATH
  | typeof LOGIN_PATH
  | typeof SETUP_PATH
  | (typeof ONBOARDING_PATH)[OnboardingStep];

/** The screens that exist only before the app itself is reachable. */
const BEFORE_THE_APP = new Set<string>([LOGIN_PATH, SETUP_PATH, ...Object.values(ONBOARDING_PATH)]);

/** What the guard needs to know, as three questions. */
export interface EntryDeps {
  readonly hasToken: () => boolean;
  readonly readSetup: () => Promise<{ readonly complete: boolean }>;
  readonly readSettings: () => Promise<SettingsState>;
}

export const entryDeps = ({ client, queryClient }: RouterContext): EntryDeps => ({
  hasToken: () => client.getToken() !== null,
  readSetup: () => queryClient.ensureQueryData(setupQuery(client)),
  readSettings: () => queryClient.ensureQueryData(settingsQuery(client)),
});

/** Where `pathname` must go instead, or `null` to let it through. */
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

  const step = nextOnboardingStep(completedSteps);
  if (step === null) return BEFORE_THE_APP.has(pathname) ? HOME_PATH : null;
  return pathname === ONBOARDING_PATH[step] ? null : ONBOARDING_PATH[step];
};
