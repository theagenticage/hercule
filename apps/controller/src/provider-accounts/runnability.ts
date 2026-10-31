/**
 * The rule for whether a Provider Account can run in a harness on a runner
 * (spec 03 section 5.1, spec 06 section 15.5), as pure functions. Listing
 * where an account can run, choosing the pairs to probe, building a frame's
 * credential and creating an account all ask these functions, so a change to
 * the rule is made here and nowhere else.
 *
 * The rule has two halves:
 *
 * - The harness can run on the runner: its binary is present, the runner's
 *   build has an adapter for it, and its version is not below the floor
 *   (`decideHarnessOnRunner`).
 * - The account works: a key or token account has its secret stored and a
 *   token has not expired (`findCredentialProblem`); a per-machine account
 *   has a signed-in snapshot of the same person on that runner
 *   (`isIdentityCompatible`).
 */
import type { RunnerFacts } from "@hercule/protocol";
import { computeVersionVerdict, findVersionFloor } from "../harnesses";
import type { RegisteredHarness, RegisteredProvider } from "../plugins";
import type { StoredProviderAccount } from "./repository";

/**
 * Names an account the way a user reads it: its provider, then its label if it
 * has one ("Anthropic · work").
 */
export const describeProviderAccount = (
  account: Pick<StoredProviderAccount, "providerId" | "label">,
  providers: ReadonlyArray<RegisteredProvider>,
): string => {
  const name = providers.find((provider) => provider.id === account.providerId)?.displayName;
  return `${name ?? account.providerId}${account.label === null ? "" : ` · ${account.label}`}`;
};

/**
 * Whether a harness can run on one runner:
 *
 * - `runnable`: its binary is present, the runner's build has an adapter for
 *   it, and its version is not below this build's floor.
 * - `missing`: the binary is absent, the runner has not reported yet, or the
 *   runner's build has no adapter for the harness.
 * - `below-floor`: it is present but older than this build supports.
 */
export type HarnessOnRunner = "runnable" | "missing" | "below-floor";

/**
 * Decides whether the harness can run on a runner, from the runner's facts
 * (`null` before its first report) and the version the runner reported for
 * the harness (`null` when it reported none; an unknown version passes).
 */
export const decideHarnessOnRunner = (
  facts: RunnerFacts | null,
  harness: RegisteredHarness,
  reportedVersion: string | null,
): HarnessOnRunner => {
  const present =
    facts !== null &&
    facts.adapters.includes(harness.id) &&
    facts.harnesses.some((binary) => binary.name === harness.binaryName && binary.present);
  if (!present) return "missing";
  return computeVersionVerdict(reportedVersion, findVersionFloor(harness.id)) === "below-floor"
    ? "below-floor"
    : "runnable";
};

/**
 * Returns why the harness can run on none of the runners, in words a user can
 * act on, or `null` when at least one verdict is `runnable`. `verdicts` holds
 * one `decideHarnessOnRunner` result per runner.
 */
export const findHarnessProblem = (
  harness: RegisteredHarness,
  verdicts: ReadonlyArray<HarnessOnRunner>,
): string | null => {
  if (verdicts.includes("runnable")) return null;
  return verdicts.includes("below-floor")
    ? `${harness.displayName} is older than this version of Hercule supports on every machine that has it; update it`
    : `${harness.displayName} is not installed on any connected machine; install it on a machine first`;
};

/**
 * Returns whether the account's credential is a token that a sign-in makes
 * (its kind has a `harness-login` step), as opposed to a key the user types
 * in. Messages use it to say which to do.
 */
export const holdsMadeToken = (
  account: Pick<StoredProviderAccount, "providerId" | "kind">,
  providers: ReadonlyArray<RegisteredProvider>,
): boolean =>
  providers
    .find((provider) => provider.id === account.providerId)
    ?.kinds.find((kind) => kind.id === account.kind)
    ?.setup.some((step) => step.kind === "harness-login") === true;

/**
 * Returns why the account's key or token cannot be used, in words a user can
 * act on, or `null` when it can: the secret is stored and, for a token, has
 * not expired. Call it only for an account whose kind holds a credential.
 *
 * `secretStored` says whether the account's credential secret exists.
 * `nowMillis` is the current time, so every caller judges expiry against the
 * same kind of clock reading.
 */
export const findCredentialProblem = (
  account: Pick<StoredProviderAccount, "providerId" | "kind" | "label" | "credentialExpiresAt">,
  providers: ReadonlyArray<RegisteredProvider>,
  secretStored: boolean,
  nowMillis: number,
): string | null => {
  const name = describeProviderAccount(account, providers);
  if (!secretStored) {
    // A token is made by a sign-in, a key is typed in; the message says which to do.
    return holdsMadeToken(account, providers)
      ? `${name} has no token. Make one in Settings › Providers.`
      : `${name} has no key. Add one in Settings › Providers.`;
  }
  if (
    account.credentialExpiresAt !== null &&
    Date.parse(account.credentialExpiresAt) <= nowMillis
  ) {
    return `${name}'s token expired on ${account.credentialExpiresAt.slice(0, 10)}. Make a new one in Settings › Providers.`;
  }
  return null;
};

/**
 * Checks that a snapshot's identity may count for an account: either side
 * does not know who it is, or they are the same person. Emails differ only in
 * case when the same person signs in twice, so the comparison ignores case.
 */
export const isIdentityCompatible = (
  accountIdentity: string | null,
  snapshotIdentity: string | null,
): boolean =>
  accountIdentity === null ||
  snapshotIdentity === null ||
  accountIdentity.toLowerCase() === snapshotIdentity.toLowerCase();
