/**
 * Decides what the Sessions screen shows before any thread exists. It builds
 * the same provider rows as the runner page, so every sign-in offered here is
 * one the runner page offers too. It returns those rows, so the screen only
 * renders them and does not decide what to offer.
 */
import type { ProviderInstance, Runner } from "@hercule/contract";
import { buildProviderRows, type ProviderRow } from "./provider-rows";

/**
 * Before entering a credential, the user needs to know where it is stored,
 * and the two ways to sign in store it in different places:
 *
 * - a vendor's login stores it on the machine where the login runs;
 * - a key the user types in is stored by the controller for every machine.
 */
const buildLoginLead = (many: boolean): string =>
  `Log in to use ${many ? "them" : "it"} in Hercule. The login runs on this machine and its credential stays there.`;

const buildSecretLead = (many: boolean): string =>
  `Enter ${many ? "their keys" : "its key"} to use ${many ? "them" : "it"} in Hercule. The key is kept by the controller and used on whichever machine runs a thread.`;

/**
 * The lead when both a login and a key are offered, so it explains both.
 * That needs at least two harnesses, so the text is always plural.
 */
const MIXED_LEAD =
  "Sign in to use them in Hercule. A login runs on this machine and its credential stays there; " +
  "a key you enter is kept by the controller and used on whichever machine runs a thread.";

export type SessionsEmptyState =
  /** No runner is online on this machine, so there is nowhere to log in. */
  | { readonly kind: "no-runner" }
  /** This machine has no harness this build can use. */
  | { readonly kind: "no-harness" }
  /** At least one harness needs a credential; `offers` lists them. */
  | {
      readonly kind: "sign-in";
      readonly lead: string;
      readonly offers: ReadonlyArray<ProviderRow>;
    }
  /** Something on this machine is logged in and ready to run a thread. */
  | { readonly kind: "ready"; readonly name: string };

/** Returns the empty state for the Sessions screen, given the runner on this machine. */
export const decideSessionsEmptyState = (
  localRunner: Runner | null,
  instances: ReadonlyArray<ProviderInstance>,
): SessionsEmptyState => {
  // A login runs on the runner's machine, so an offline runner is as useless
  // for logging in as no runner at all.
  if (localRunner === null || localRunner.connectivity !== "online") return { kind: "no-runner" };

  const rows = buildProviderRows(localRunner, instances);
  // A logged-in harness takes priority: a "log in" headline when a harness
  // already works would look like something is broken.
  const ready = rows.find((row) => row.loggedIn);
  if (ready !== undefined) return { kind: "ready", name: ready.name };

  const offers = rows.filter((row) => row.logIn || row.secretFields.length > 0);
  if (offers.length === 0) return { kind: "no-harness" };
  const secrets = offers.filter((row) => row.secretFields.length > 0).length;
  // The lead refers back to the harnesses listed in the headline, so it
  // matches their number: one harness is "it", several are "them".
  const many = offers.length > 1;
  return {
    kind: "sign-in",
    lead:
      secrets === 0
        ? buildLoginLead(many)
        : secrets === offers.length
          ? buildSecretLead(many)
          : MIXED_LEAD,
    offers,
  };
};
