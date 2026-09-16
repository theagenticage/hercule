/**
 * A row joins the instance, this machine's last snapshot, and the adapters its
 * runner build carries. Which moves a row offers follows from those, so it is
 * decided here rather than in the markup.
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
  // A harness credentialled from the environment reports neither an identity
  // nor a plan, so the line says what the login is instead of standing empty:
  // where the token came from if the harness named it, else that there is one.
  const named = [auth.identity, auth.planLabel].filter(
    (part): part is string => part !== undefined && part !== "",
  );
  return named.length === 0 ? (auth.backend ?? "signed in") : named.join(" · ");
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
    // The name the machine reports on its `PATH` is the name the instance
    // carries, so the join needs no table of its own.
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
      // Said once, in place of whatever a stale snapshot claimed.
      account: adapter ? accountIn(snapshot) : NO_ADAPTER,
      models: modelsIn(snapshot),
      loggedIn: snapshot?.auth.status === "ok",
      install: !reachable || present ? "none" : adapter ? "offered" : "blocked",
      logIn: reachable && present && adapter,
      logInLabel: snapshot?.auth.status === "ok" ? "Log in again" : "Log in",
      probe: reachable,
    };
  });
