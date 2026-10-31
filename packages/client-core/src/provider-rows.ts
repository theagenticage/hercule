/**
 * Builds the account rows of a runner. A row combines a Provider Account, the
 * runner's last snapshot of it in the account's default harness, and the
 * adapters in the runner's build. The actions a row offers follow from those,
 * so they are decided here rather than in the markup.
 */
import type { Harness, Provider, ProviderAccount, Runner } from "@hercule/contract";
import { describeModelCount } from "./model-count";
import {
  buildProviderAccountName,
  listAccountCredentialFields,
  requiresSignInPerMachine,
} from "./provider-accounts";
import type { CredentialField } from "./connection-types";

/** A row's install action: offered, blocked (shown dimmed with its reason), or not shown. */
type Install = "offered" | "blocked" | "none";

/**
 * A credential field of the account's kind, with the label of the action that
 * asks for it. An account of such a kind has no sign-in in the browser: the
 * user types the value in.
 */
export interface CredentialFieldOffer {
  readonly name: string;
  /** The field's label, such as "API key". */
  readonly title: string;
  /** The field's help text, or "" when the kind gives none. */
  readonly description: string;
  /** Whether the account is already signed in on this runner, so the field replaces a credential. */
  readonly set: boolean;
  readonly label: string;
}

/**
 * Adds the action label. A field of an account that already works is labelled
 * "Replace", because a stored value cannot be read, only overwritten.
 */
const buildOffer = (field: CredentialField, signedIn: boolean): CredentialFieldOffer => ({
  name: field.name,
  title: field.label,
  description: field.help ?? "",
  set: signedIn,
  label: signedIn ? `Replace ${field.label}` : `Enter ${field.label}`,
});

export interface ProviderRow {
  /** The id of the Provider Account. */
  readonly id: string;
  /** The account's default harness, which the row describes. */
  readonly harnessId: string;
  /** The account's name, such as "Anthropic · work". */
  readonly name: string;
  /** The display name of the account's default harness, such as "Claude Code". */
  readonly harnessName: string;
  /**
   * Where the runner found the harness's binary, such as
   * `/opt/homebrew/bin/claude`, or `null` when the binary is not there or the
   * runner did not say where.
   */
  readonly path: string | null;
  /**
   * Where the harness is on the runner, in words for the row's second line:
   * the path of its binary, `installed` when the runner found it but did not
   * say where, `not installed`, or that the runner's build has no adapter
   * for it.
   */
  readonly location: string;
  /** The harness version it reported, or `not reported`. */
  readonly version: string;
  /** How that version compares with the versions this build was tested with. */
  readonly verdict: string | null;
  /** Who the account is signed in as, or why it is not signed in. */
  readonly signedInAs: string;
  readonly models: string;
  readonly signedIn: boolean;
  readonly install: Install;
  /** Whether the row offers `providerAccount.signIn` on this runner. */
  readonly signIn: boolean;
  readonly signInLabel: string;
  /** The credential fields this account is set up with instead of a sign-in on each machine. */
  readonly credentialFields: ReadonlyArray<CredentialFieldOffer>;
  readonly probe: boolean;
}

const NO_ADAPTER = "no adapter in this runner build";

const VERDICTS: Readonly<Record<string, string>> = {
  "below-floor": "below the version this build was tested with",
  "above-tested-max": "above the version this build was tested with",
};

const describeSignedInAs = (snapshot: ProviderAccount["snapshots"][number] | undefined): string => {
  if (snapshot === undefined) return "not probed yet";
  const { auth } = snapshot;
  if (auth.status === "unauthenticated") return "not signed in";
  if (auth.status === "error") return auth.message ?? "the probe failed";
  // A harness that gets its credential from the environment reports neither
  // an identity nor a plan. Rather than leave the line empty, show where the
  // token came from if the harness reported it, and otherwise "signed in".
  const named = [auth.identity, auth.planLabel].filter(
    (part): part is string => part !== undefined && part !== "",
  );
  return named.length === 0 ? (auth.backend ?? "signed in") : named.join(" · ");
};

/**
 * Returns one row per Provider Account, as seen on `runner`. An account whose
 * default harness no registered harness matches has no row, because there is
 * nothing to say about a harness nobody can name.
 */
export const buildProviderRows = (
  runner: Runner,
  accounts: ReadonlyArray<ProviderAccount>,
  providers: ReadonlyArray<Provider>,
  harnesses: ReadonlyArray<Harness>,
): ReadonlyArray<ProviderRow> =>
  accounts.flatMap((account) => {
    const harness = harnesses.find((each) => each.id === account.defaultHarnessId);
    if (harness === undefined) return [];
    const snapshot = account.snapshots.find(
      (each) => each.harnessId === harness.id && each.runnerId === runner.id,
    );
    const adapter = (runner.facts?.adapters ?? []).includes(harness.id);
    // The binary name the runner reports from its `PATH` is the harness's
    // `binaryName`, so no lookup table is needed.
    const binary = (runner.facts?.harnesses ?? []).find(
      (each) => each.name === harness.binaryName && each.present,
    );
    const present = binary !== undefined;
    // Every action runs on the runner, so an offline runner offers none.
    const reachable = runner.connectivity === "online";
    // A credential can only be entered for a harness installed on this runner,
    // because the controller probes the runner for the account as soon as the
    // credential is saved.
    const usable = reachable && present && adapter;
    const signedIn = snapshot?.auth.status === "ok";
    // An account that signs in on each machine has no credential to type. Any
    // other has no sign-in in the browser, so it offers its fields instead.
    const perMachine = requiresSignInPerMachine(providers, account);
    return [
      {
        id: account.id,
        harnessId: harness.id,
        name: buildProviderAccountName(providers, account),
        harnessName: harness.displayName,
        path: binary?.path ?? null,
        location: binary?.path ?? (present ? "installed" : adapter ? "not installed" : NO_ADAPTER),
        version: snapshot?.harnessVersion ?? "not reported",
        verdict: snapshot === undefined ? null : (VERDICTS[snapshot.versionVerdict] ?? null),
        // Without an adapter, show that instead of what a stale snapshot reported.
        signedInAs: adapter ? describeSignedInAs(snapshot) : NO_ADAPTER,
        models: describeModelCount(snapshot?.models.length ?? 0),
        signedIn,
        install: !reachable || present ? "none" : adapter ? "offered" : "blocked",
        signIn: usable && perMachine,
        signInLabel: signedIn ? "Sign in again" : "Sign in",
        credentialFields:
          usable && !perMachine
            ? listAccountCredentialFields(providers, account).map((field) =>
                buildOffer(field, signedIn),
              )
            : [],
        probe: reachable,
      },
    ];
  });
