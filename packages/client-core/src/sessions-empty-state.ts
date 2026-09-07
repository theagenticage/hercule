/**
 * What the Sessions screen has to say on a fresh install.
 *
 * The screen is the rest of onboarding: it is the one place that says what
 * stands between the user and a thread. Which of the four things that is comes
 * from two answers - which machine this browser is on, and what that machine
 * last reported about the harnesses on it - so it is decided here rather than
 * in the component, where it could only be read by rendering it.
 *
 * It reads those answers through the same join the fleet's own rows use, so a
 * login this screen offers is one the runner page would also offer, and one it
 * cannot drive is never put in front of the user.
 */
import type { ProviderInstance, Runner } from "@hydra/contract";
import { providerRows } from "./provider-rows";

export type SessionsEmptyState =
  /** No runner answered on this machine, so there is nothing to log in on. */
  | { readonly kind: "no-runner" }
  /** Nothing on this machine is a harness this build can use. */
  | { readonly kind: "no-harness" }
  /** A harness is here and waiting for a login; these are the ones to offer. */
  | { readonly kind: "log-in"; readonly instances: ReadonlyArray<ProviderInstance> }
  /** Something on this machine is logged in and ready to run a thread. */
  | { readonly kind: "ready" };

export const sessionsEmptyState = (
  localRunner: Runner | null,
  instances: ReadonlyArray<ProviderInstance>,
): SessionsEmptyState => {
  // A login runs on the machine, so a row that says `offline` can no more be
  // logged in to than one that is not there at all.
  if (localRunner === null || localRunner.connectivity !== "online") return { kind: "no-runner" };

  const rows = providerRows(localRunner, instances);
  // One usable harness is what this screen is about; anything else still
  // waiting is Fleet's business, and a "log in" headline over a working install
  // would read as broken.
  if (rows.some((row) => row.loggedIn)) return { kind: "ready" };

  const offered = new Set(rows.filter((row) => row.logIn).map((row) => row.id));
  const waiting = instances.filter((instance) => offered.has(instance.id));
  return waiting.length === 0 ? { kind: "no-harness" } : { kind: "log-in", instances: waiting };
};
