/**
 * Builds the provider rows of a runner. A row combines the provider instance,
 * the runner's last snapshot of it, and the adapters in the runner's build.
 * The actions a row offers follow from those, so they are decided here rather
 * than in the markup.
 */
import type { ProviderInstance, ProviderSecretField, Runner } from "@hercule/contract";

/** A row's install action: offered, blocked (shown dimmed with its reason), or not shown. */
type Install = "offered" | "blocked" | "none";

/**
 * A provider's secret field, with the label of the action that asks for it. A
 * provider that uses such a field has no vendor login in the browser: the
 * user types the value in.
 */
export interface SecretFieldOffer extends ProviderSecretField {
  readonly label: string;
}

/**
 * Adds the action label. A field that is already set says "Replace", because
 * the stored value cannot be read, only overwritten.
 */
const buildOffer = (field: ProviderSecretField): SecretFieldOffer => ({
  ...field,
  label: field.set ? `Replace ${field.title}` : `Enter ${field.title}`,
});

export interface ProviderRow {
  readonly id: string;
  readonly providerId: string;
  readonly name: string;
  /** The harness version it reported, or `not reported`. */
  readonly version: string;
  /** How that version compares with the versions this build was tested with. */
  readonly verdict: string | null;
  /** The account the harness is logged in with, or why it is not logged in. */
  readonly account: string;
  readonly models: string;
  readonly loggedIn: boolean;
  readonly install: Install;
  readonly logIn: boolean;
  readonly logInLabel: string;
  /** The secret fields this provider signs in with instead of a browser login. */
  readonly secretFields: ReadonlyArray<SecretFieldOffer>;
  readonly probe: boolean;
}

const NO_ADAPTER = "no adapter in this runner build";

const VERDICTS: Readonly<Record<string, string>> = {
  "below-floor": "below the version this build was tested with",
  "above-tested-max": "above the version this build was tested with",
};

const describeAccount = (snapshot: ProviderInstance["snapshots"][number] | undefined): string => {
  if (snapshot === undefined) return "not probed yet";
  const { auth } = snapshot;
  if (auth.status === "unauthenticated") return "not logged in";
  if (auth.status === "error") return auth.message ?? "the probe failed";
  // A harness that gets its credential from the environment reports neither
  // an identity nor a plan. Rather than leave the line empty, show where the
  // token came from if the harness reported it, and otherwise "signed in".
  const named = [auth.identity, auth.planLabel].filter(
    (part): part is string => part !== undefined && part !== "",
  );
  return named.length === 0 ? (auth.backend ?? "signed in") : named.join(" · ");
};

const describeModelCount = (
  snapshot: ProviderInstance["snapshots"][number] | undefined,
): string => {
  const count = snapshot?.models.length ?? 0;
  if (count === 0) return "no models";
  return count === 1 ? "1 model" : `${String(count)} models`;
};

/** Returns one row per provider instance, as seen on `runner`. */
export const buildProviderRows = (
  runner: Runner,
  instances: ReadonlyArray<ProviderInstance>,
): ReadonlyArray<ProviderRow> =>
  instances.map((instance) => {
    const snapshot = instance.snapshots.find((each) => each.runnerId === runner.id);
    const adapter = (runner.facts?.adapters ?? []).includes(instance.providerId);
    // The binary name the runner reports from its `PATH` is the instance's
    // `binaryName`, so no lookup table is needed.
    const present = (runner.facts?.providers ?? []).some(
      (binary) => binary.name === instance.binaryName && binary.present,
    );
    // Every action runs on the runner, so an offline runner offers none.
    const reachable = runner.connectivity === "online";
    // A credential can only be entered for a harness installed on this runner,
    // because the controller probes the runner for the instance as soon as the
    // credential is saved.
    const usable = reachable && present && adapter;
    return {
      id: instance.id,
      providerId: instance.providerId,
      name: instance.displayName,
      version: snapshot?.harnessVersion ?? "not reported",
      verdict: snapshot === undefined ? null : (VERDICTS[snapshot.versionVerdict] ?? null),
      // Without an adapter, show that instead of what a stale snapshot reported.
      account: adapter ? describeAccount(snapshot) : NO_ADAPTER,
      models: describeModelCount(snapshot),
      loggedIn: snapshot?.auth.status === "ok",
      install: !reachable || present ? "none" : adapter ? "offered" : "blocked",
      // A provider whose credential is typed in has no vendor login page, so
      // it offers the key fields instead of a login.
      logIn: usable && instance.secretFields.length === 0,
      logInLabel: snapshot?.auth.status === "ok" ? "Log in again" : "Log in",
      secretFields: usable ? instance.secretFields.map(buildOffer) : [],
      probe: reachable,
    };
  });
