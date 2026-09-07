/**
 * What Sessions says before a thread exists. It reads the same join the fleet
 * rows use, so a login offered here is one the runner page would offer too.
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

  const offered = new Set(rows.filter((row) => row.logIn).map((row) => row.id));
  const waiting = instances.filter((instance) => offered.has(instance.id));
  return waiting.length === 0 ? { kind: "no-harness" } : { kind: "log-in", instances: waiting };
};
