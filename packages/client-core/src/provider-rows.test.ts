import { describe, expect, it } from "vitest";
import type { ProviderInstance, Runner } from "@hercule/contract";
import { buildProviderRows, describeModelCount } from "./provider-rows";
import { buildInstance, buildSnapshot, WITH_CLAUDE } from "./providers.testing";

const buildProviderRow = (runner: Runner, one: ProviderInstance) =>
  buildProviderRows(runner, [one])[0]!;

describe("buildProviderRows", () => {
  it("shows a logged-in harness's account and what it offers", () => {
    const row = buildProviderRow(
      WITH_CLAUDE,
      buildInstance("claude-code", "Claude Code", [buildSnapshot()]),
    );

    expect(row).toMatchObject({
      name: "Claude Code",
      version: "2.1.263",
      verdict: null,
      account: "rogier@example.com · Claude Max",
      models: "1 model",
      install: "none",
      logIn: true,
      logInLabel: "Log in again",
      probe: true,
    });
  });

  it("shows signed in when the harness reports neither an identity nor a plan", () => {
    // A harness that gets its credential from the environment: the login
    // works, but there is no account name, and an empty line looks like a fault.
    const row = buildProviderRow(
      WITH_CLAUDE,
      buildInstance("claude-code", "Claude Code", [buildSnapshot({ auth: { status: "ok" } })]),
    );

    expect(row.account).toBe("signed in");
  });

  it("shows the token source when the harness reports one", () => {
    const row = buildProviderRow(
      WITH_CLAUDE,
      buildInstance("claude-code", "Claude Code", [
        buildSnapshot({ auth: { status: "ok", backend: "ANTHROPIC_API_KEY" } }),
      ]),
    );

    expect(row.account).toBe("ANTHROPIC_API_KEY");
  });

  it("flags a version this build was not tested with", () => {
    const row = buildProviderRow(
      WITH_CLAUDE,
      buildInstance("claude-code", "Claude Code", [
        buildSnapshot({ harnessVersion: "2.0.9", versionVerdict: "below-floor" }),
      ]),
    );

    expect(row.verdict).toMatch(/below/);
  });

  it("offers the install, and no login, for a harness that is not installed on the runner", () => {
    const row = buildProviderRow(WITH_CLAUDE, buildInstance("codex", "Codex", []));

    expect(row).toMatchObject({ install: "blocked", logIn: false, version: "not reported" });
    expect(row.account).toBe("no adapter in this runner build");
  });

  it("offers no action on an offline runner", () => {
    const row = buildProviderRow(
      { ...WITH_CLAUDE, connectivity: "offline" },
      buildInstance("claude-code", "Claude Code", [buildSnapshot()]),
    );

    expect(row).toMatchObject({ install: "none", logIn: false, probe: false });
  });
});

/**
 * A provider that signs in with a credential the user types in. The action's
 * label is decided here, so the fleet row and the Sessions screen cannot word
 * the same action differently.
 */
describe("buildProviderRows for a provider with a secret field", () => {
  const FIELD = {
    name: "zaiApiKey",
    title: "Z.ai API key",
    description: "From your Z.ai Coding Plan subscription.",
  };

  const buildKeyedInstance = (set: boolean): ProviderInstance => ({
    ...buildInstance("pi", "pi", [buildSnapshot({ auth: { status: "unauthenticated" } })]),
    binaryName: "pi",
    secretFields: [{ ...FIELD, set }],
  });

  const WITH_PI: Runner = {
    ...WITH_CLAUDE,
    facts: {
      ...WITH_CLAUDE.facts!,
      providers: [{ name: "pi", present: true, path: "/usr/local/bin/pi" }],
      adapters: ["pi"],
    },
  };

  it("labels the key with the plugin's title, and offers to replace a key that is set", () => {
    expect(buildProviderRow(WITH_PI, buildKeyedInstance(false)).secretFields).toEqual([
      { ...FIELD, set: false, label: `Enter ${FIELD.title}` },
    ]);
    expect(buildProviderRow(WITH_PI, buildKeyedInstance(true)).secretFields).toEqual([
      { ...FIELD, set: true, label: `Replace ${FIELD.title}` },
    ]);
  });

  it("offers the key instead of a login, because there is no vendor login page", () => {
    expect(buildProviderRow(WITH_PI, buildKeyedInstance(false)).logIn).toBe(false);
  });

  it("offers neither on a runner where the harness is not installed", () => {
    expect(buildProviderRow(WITH_CLAUDE, buildKeyedInstance(false))).toMatchObject({
      secretFields: [],
      logIn: false,
    });
  });
});

describe("describeModelCount", () => {
  it("says no models, one model, or how many", () => {
    expect([0, 1, 3].map(describeModelCount)).toEqual(["no models", "1 model", "3 models"]);
  });
});
