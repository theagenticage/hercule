import { describe, expect, it } from "vitest";
import type { ProviderAccount, Runner } from "@hercule/contract";
import { buildProviderRows } from "./provider-rows";
import {
  HARNESSES,
  PROVIDERS,
  buildProviderAccount,
  buildSnapshot,
  ANTHROPIC_IDENTITY,
  OPENAI_IDENTITY,
  ZAI_IDENTITY,
  WITH_CLAUDE,
} from "./providers.testing";

const buildProviderRow = (runner: Runner, one: ProviderAccount) =>
  buildProviderRows(runner, [one], PROVIDERS, HARNESSES)[0]!;

describe("buildProviderRows", () => {
  it("shows a signed-in account and what it offers", () => {
    const row = buildProviderRow(
      WITH_CLAUDE,
      buildProviderAccount(ANTHROPIC_IDENTITY, [buildSnapshot()]),
    );

    expect(row).toMatchObject({
      id: ANTHROPIC_IDENTITY.id,
      harnessId: "claude-code/claude-code",
      name: "Anthropic",
      harnessName: "Claude Code",
      version: "2.1.263",
      verdict: null,
      signedInAs: "rogier@example.com · Claude Max",
      models: "1 model",
      install: "none",
      signIn: true,
      signInLabel: "Sign in again",
      probe: true,
    });
  });

  it("offers the token flow, not a typed credential, to a kind that makes a token", () => {
    const providers = PROVIDERS.map((provider) =>
      provider.id === "anthropic/anthropic"
        ? {
            ...provider,
            kinds: [
              {
                id: "subscription-token",
                title: "Claude subscription, every machine",
                description: "Sign in once.",
                setup: [{ kind: "harness-login" as const, method: "create-token" as const }],
                harnesses: ["claude-code/claude-code"],
              },
            ],
          }
        : provider,
    );
    const account = buildProviderAccount({ ...ANTHROPIC_IDENTITY, kind: "subscription-token" }, []);

    const row = buildProviderRows(WITH_CLAUDE, [account], providers, HARNESSES)[0]!;

    expect(row).toMatchObject({
      signIn: true,
      signInLabel: "Make the token",
      credentialFields: [],
    });
  });

  describe("a token account whose probe found it signed in", () => {
    const tokenProviders = PROVIDERS.map((provider) =>
      provider.id === "anthropic/anthropic"
        ? {
            ...provider,
            kinds: [
              {
                id: "subscription-token",
                title: "Claude subscription, every machine",
                description: "Sign in once.",
                setup: [{ kind: "harness-login" as const, method: "create-token" as const }],
                harnesses: ["claude-code/claude-code"],
              },
            ],
          }
        : provider,
    );
    const buildTokenRow = (expiresAt: string | null) =>
      buildProviderRows(
        WITH_CLAUDE,
        [
          {
            ...buildProviderAccount(ANTHROPIC_IDENTITY, [buildSnapshot()]),
            kind: "subscription-token",
            expiresAt,
          },
        ],
        tokenProviders,
        HARNESSES,
      )[0]!;

    it("is signed in while the token lasts", () => {
      expect(buildTokenRow("2999-01-01T00:00:00.000Z")).toMatchObject({
        signedIn: true,
        signInLabel: "Make a new token",
      });
    });

    it("is not signed in once the token expired, so the row offers to make a new one", () => {
      expect(buildTokenRow("2020-01-01T00:00:00.000Z")).toMatchObject({
        signedIn: false,
        signIn: true,
        signInLabel: "Make the token",
      });
    });

    it("is not signed in while no token was made", () => {
      expect(buildTokenRow(null).signedIn).toBe(false);
    });
  });

  it("names a labelled account by its provider and label", () => {
    const row = buildProviderRow(
      WITH_CLAUDE,
      buildProviderAccount({ ...ANTHROPIC_IDENTITY, label: "work" }, []),
    );

    expect(row.name).toBe("Anthropic · work");
  });

  it("shows signed in when the harness reports neither an identity nor a plan", () => {
    // A harness that gets its credential from the environment: the sign-in
    // works, but there is no identity, and an empty line looks like a fault.
    const row = buildProviderRow(
      WITH_CLAUDE,
      buildProviderAccount(ANTHROPIC_IDENTITY, [buildSnapshot({ auth: { status: "ok" } })]),
    );

    expect(row.signedInAs).toBe("signed in");
  });

  it("shows the token source when the harness reports one", () => {
    const row = buildProviderRow(
      WITH_CLAUDE,
      buildProviderAccount(ANTHROPIC_IDENTITY, [
        buildSnapshot({ auth: { status: "ok", backend: "ANTHROPIC_API_KEY" } }),
      ]),
    );

    expect(row.signedInAs).toBe("ANTHROPIC_API_KEY");
  });

  it("flags a version this build was not tested with", () => {
    const row = buildProviderRow(
      WITH_CLAUDE,
      buildProviderAccount(ANTHROPIC_IDENTITY, [
        buildSnapshot({ harnessVersion: "2.0.9", versionVerdict: "below-floor" }),
      ]),
    );

    expect(row.verdict).toMatch(/below/);
  });

  it("offers the install, and no sign-in, for a harness that is not installed on the runner", () => {
    const row = buildProviderRow(WITH_CLAUDE, buildProviderAccount(OPENAI_IDENTITY, []));

    expect(row).toMatchObject({ install: "blocked", signIn: false, version: "not reported" });
    expect(row.signedInAs).toBe("no adapter in this runner build");
  });

  it("reads the snapshot of the account's default harness only", () => {
    const account = buildProviderAccount(ANTHROPIC_IDENTITY, []);
    const row = buildProviderRow(WITH_CLAUDE, {
      ...account,
      snapshots: [buildSnapshot({ harnessId: "pi/pi", harnessVersion: "9.9.9" })],
    });

    expect(row).toMatchObject({ version: "not reported", signedIn: false });
  });

  it("has no row for an account whose default harness no plugin registers", () => {
    const account = buildProviderAccount(ANTHROPIC_IDENTITY, []);

    expect(
      buildProviderRows(
        WITH_CLAUDE,
        [{ ...account, defaultHarnessId: "gone/gone" }],
        PROVIDERS,
        HARNESSES,
      ),
    ).toEqual([]);
  });

  it("offers no action on an offline runner", () => {
    const row = buildProviderRow(
      { ...WITH_CLAUDE, connectivity: "offline" },
      buildProviderAccount(ANTHROPIC_IDENTITY, [buildSnapshot()]),
    );

    expect(row).toMatchObject({ install: "none", signIn: false, probe: false });
  });
});

/**
 * An account whose kind has a credentials step: the user types the key in.
 * The action's label is decided here, so the fleet row and the Sessions
 * screen cannot word the same action differently.
 */
describe("buildProviderRows for an account with a credentials step", () => {
  const FIELD = { name: "apiKey", title: "API key", description: "" };

  const buildKeyedProviderAccount = (signedIn: boolean): ProviderAccount =>
    buildProviderAccount(ZAI_IDENTITY, [
      buildSnapshot(signedIn ? {} : { auth: { status: "unauthenticated" } }),
    ]);

  const WITH_PI: Runner = {
    ...WITH_CLAUDE,
    facts: {
      ...WITH_CLAUDE.facts!,
      harnesses: [{ name: "pi", present: true, path: "/usr/local/bin/pi" }],
      adapters: ["pi/pi"],
    },
  };

  it("labels the key with the kind's field label, and offers to replace a key that works", () => {
    expect(buildProviderRow(WITH_PI, buildKeyedProviderAccount(false)).credentialFields).toEqual([
      { ...FIELD, set: false, label: "Enter API key" },
    ]);
    expect(buildProviderRow(WITH_PI, buildKeyedProviderAccount(true)).credentialFields).toEqual([
      { ...FIELD, set: true, label: "Replace API key" },
    ]);
  });

  it("offers the key instead of a sign-in, because there is no vendor sign-in page", () => {
    expect(buildProviderRow(WITH_PI, buildKeyedProviderAccount(false)).signIn).toBe(false);
  });

  it("gives where the runner found the harness, and no path where it is not installed", () => {
    expect(buildProviderRow(WITH_PI, buildKeyedProviderAccount(false))).toMatchObject({
      path: "/usr/local/bin/pi",
      location: "/usr/local/bin/pi",
    });
    expect(buildProviderRow(WITH_CLAUDE, buildKeyedProviderAccount(false))).toMatchObject({
      path: null,
      location: "no adapter in this runner build",
    });
    const withPiAdapter: Runner = {
      ...WITH_CLAUDE,
      facts: { ...WITH_CLAUDE.facts!, adapters: ["claude-code/claude-code", "pi/pi"] },
    };
    expect(buildProviderRow(withPiAdapter, buildKeyedProviderAccount(false)).location).toBe(
      "not installed",
    );
  });

  it("says installed when the runner found the harness but did not say where", () => {
    const pathless: Runner = {
      ...WITH_PI,
      facts: { ...WITH_PI.facts!, harnesses: [{ name: "pi", present: true }] },
    };
    expect(buildProviderRow(pathless, buildKeyedProviderAccount(false))).toMatchObject({
      path: null,
      location: "installed",
    });
  });

  it("offers neither on a runner where the harness is not installed", () => {
    expect(buildProviderRow(WITH_CLAUDE, buildKeyedProviderAccount(false))).toMatchObject({
      credentialFields: [],
      signIn: false,
    });
  });
});
