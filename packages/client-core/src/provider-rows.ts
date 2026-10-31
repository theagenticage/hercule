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
  decideStoredCredentialState,
  findDefaultHarnessSnapshot,
  findHarnessLoginMethod,
  listProviderAccountCredentialFields,
  type HarnessLoginMethod,
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

/** Returns the label of the button that starts the login of a kind with `loginMethod`. */
const describeSignInLabel = (loginMethod: HarnessLoginMethod | null, signedIn: boolean): string =>
  loginMethod === "create-token"
    ? signedIn
      ? "Make a new token"
      : "Make the token"
    : signedIn
      ? "Sign in again"
      : "Sign in";

/** What a runner has of a harness. */
export interface HarnessOnRunner {
  /** Whether the runner's build has an adapter that can drive the harness. */
  readonly adapter: boolean;
  /** The harness's binary as the runner found it on its `PATH`, or `undefined` when it is not there. */
  readonly binary: NonNullable<Runner["facts"]>["harnesses"][number] | undefined;
  /** Whether the runner found the harness's binary. */
  readonly present: boolean;
  /** Whether the runner is connected. Every action runs on the runner, so an offline one offers none. */
  readonly reachable: boolean;
}

/** Returns what `runner` has of `harness`, from the runner's facts. */
export const describeHarnessOnRunner = (runner: Runner, harness: Harness): HarnessOnRunner => {
  // The binary name the runner reports from its `PATH` is the harness's
  // `binaryName`, so no lookup table is needed.
  const binary = (runner.facts?.harnesses ?? []).find(
    (each) => each.name === harness.binaryName && each.present,
  );
  return {
    adapter: (runner.facts?.adapters ?? []).includes(harness.id),
    binary,
    present: binary !== undefined,
    reachable: runner.connectivity === "online",
  };
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
    const snapshot = findDefaultHarnessSnapshot(account, runner.id);
    const { adapter, binary, present, reachable } = describeHarnessOnRunner(runner, harness);
    // A credential can only be entered for a harness installed on this runner,
    // because the controller probes the runner for the account as soon as the
    // credential is saved.
    const usable = reachable && present && adapter;
    // A token that is missing or expired signs nothing in, whatever the last
    // probe found, so the row offers to make a new one.
    const credential = decideStoredCredentialState(providers, account);
    const signedIn =
      snapshot?.auth.status === "ok" &&
      credential !== "token-missing" &&
      credential !== "token-expired";
    // An account whose kind has a harness login gets its credential from that
    // login. Any other has nothing to sign in to, so it offers its fields.
    const loginMethod = findHarnessLoginMethod(providers, account);
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
        signIn: usable && loginMethod !== null,
        signInLabel: describeSignInLabel(loginMethod, signedIn),
        credentialFields:
          usable && loginMethod === null
            ? listProviderAccountCredentialFields(providers, account).map((field) =>
                buildOffer(field, signedIn),
              )
            : [],
        probe: reachable,
      },
    ];
  });
