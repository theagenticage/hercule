/**
 * One machine's provider instances, as its page reads them.
 *
 * A row is a join of three things that arrive separately: the instance, what
 * this machine last reported about it, and what the machine says its own build
 * can drive. Which moves the row offers follows from those, so it is worked out
 * here rather than in the markup, where it could only be checked by rendering.
 */
import type { ProviderInstance, Runner } from "@hydra/contract";

/** What an install can be on a row: offered, dimmed with its reason, or absent. */
type Install = "offered" | "blocked" | "none";

export interface ProviderRow {
  readonly id: string;
  readonly providerId: string;
  readonly name: string;
  /** What the harness said it is, or that it has not said. */
  readonly version: string;
  /** How that version stands against the one this build was tested with. */
  readonly verdict: string | null;
  /** Whose login the harness is holding, or why it is holding none. */
  readonly account: string;
  readonly models: string;
  /** Whether this machine is holding a usable login for the instance. */
  readonly loggedIn: boolean;
  readonly install: Install;
  readonly logIn: boolean;
  readonly logInLabel: string;
  readonly probe: boolean;
}

const NO_ADAPTER = "no adapter in this runner build";

const VERDICTS: Readonly<Record<string, string>> = {
  "below-floor": "below the version this build was tested with",
  "above-tested-max": "above the version this build was tested with",
};

const accountIn = (snapshot: ProviderInstance["snapshots"][number] | undefined): string => {
  if (snapshot === undefined) return "not probed yet";
  const { auth } = snapshot;
  if (auth.status === "unauthenticated") return "not logged in";
  if (auth.status === "error") return auth.message ?? "the probe failed";
  return [auth.identity, auth.planLabel].filter((part) => part !== undefined).join(" · ");
};

const modelsIn = (snapshot: ProviderInstance["snapshots"][number] | undefined): string => {
  const count = snapshot?.models.length ?? 0;
  if (count === 0) return "no models";
  return count === 1 ? "1 model" : `${String(count)} models`;
};

export const providerRows = (
  runner: Runner,
  instances: ReadonlyArray<ProviderInstance>,
): ReadonlyArray<ProviderRow> =>
  instances.map((instance) => {
    const snapshot = instance.snapshots.find((each) => each.runnerId === runner.id);
    const adapter = (runner.facts?.adapters ?? []).includes(instance.providerId);
    // The machine reports what is on its `PATH` by the binary's own name, and
    // the instance carries the name its provider drives, so the join needs no
    // table of its own here.
    const present = (runner.facts?.providers ?? []).some(
      (binary) => binary.name === instance.binaryName && binary.present,
    );
    // Every move runs on the machine, so a machine holding no connection
    // offers none of them.
    const reachable = runner.connectivity === "online";
    return {
      id: instance.id,
      providerId: instance.providerId,
      name: instance.displayName,
      version: snapshot?.harnessVersion ?? "not reported",
      verdict: snapshot === undefined ? null : (VERDICTS[snapshot.versionVerdict] ?? null),
      // What the machine cannot drive at all is said once, in place of whatever
      // a stale snapshot claimed, so the row reads as one fact rather than two.
      account: adapter ? accountIn(snapshot) : NO_ADAPTER,
      models: modelsIn(snapshot),
      loggedIn: snapshot?.auth.status === "ok",
      install: !reachable || present ? "none" : adapter ? "offered" : "blocked",
      logIn: reachable && present && adapter,
      logInLabel: snapshot?.auth.status === "ok" ? "Log in again" : "Log in",
      probe: reachable,
    };
  });
