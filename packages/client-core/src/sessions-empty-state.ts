/**
 * What Sessions says before a thread exists. It reads the same join the fleet
 * rows use, so an offer made here is one the runner page would make too, and
 * the rows themselves are what it hands back: the screen renders an offer, it
 * does not work out what one is.
 */
import type { ProviderInstance, Runner } from "@hydra/contract";
import { providerRows, type ProviderRow } from "./provider-rows";

/**
 * Where the credential goes is what the reader needs to know before entering
 * one, and the two ways in answer that differently: a vendor's login writes on
 * the machine it runs on, and a typed-in value is kept by the controller for
 * every machine.
 */
const buildLoginLead = (many: boolean): string =>
  `Log in to use ${many ? "them" : "it"} in Hydra. The login runs on this machine and its credential stays there.`;

const buildSecretLead = (many: boolean): string =>
  `Enter ${many ? "their keys" : "its key"} to use ${many ? "them" : "it"} in Hydra. The key is kept by the controller and used on whichever machine runs a thread.`;

/**
 * Both are on offer, and the two answers differ, so both are said. Both being
 * on offer means two harnesses at least, so this one is always plural.
 */
const MIXED_LEAD =
  "Sign in to use them in Hydra. A login runs on this machine and its credential stays there; " +
  "a key you enter is kept by the controller and used on whichever machine runs a thread.";

export type SessionsEmptyState =
  /** No runner answered on this machine, so there is nothing to log in on. */
  | { readonly kind: "no-runner" }
  /** Nothing on this machine is a harness this build can use. */
  | { readonly kind: "no-harness" }
  /** A harness is here and waiting for a credential; these are the ones to offer. */
  | {
      readonly kind: "sign-in";
      readonly lead: string;
      readonly offers: ReadonlyArray<ProviderRow>;
    }
  /** Something on this machine is logged in and ready to run a thread. */
  | { readonly kind: "ready"; readonly name: string };

export const sessionsEmptyState = (
  localRunner: Runner | null,
  instances: ReadonlyArray<ProviderInstance>,
): SessionsEmptyState => {
  // A login runs on the machine, so a row that says `offline` can no more be
  // logged in to than one that is not there at all.
  if (localRunner === null || localRunner.connectivity !== "online") return { kind: "no-runner" };

  const rows = providerRows(localRunner, instances);
  // A logged-in harness wins: a "log in" headline over a working install would
  // read as broken.
  const ready = rows.find((row) => row.loggedIn);
  if (ready !== undefined) return { kind: "ready", name: ready.name };

  const offers = rows.filter((row) => row.logIn || row.secretFields.length > 0);
  if (offers.length === 0) return { kind: "no-harness" };
  const secrets = offers.filter((row) => row.secretFields.length > 0).length;
  // The lead points back at the headline's list, so it agrees with it in
  // number: one harness is "it", several are "them".
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
