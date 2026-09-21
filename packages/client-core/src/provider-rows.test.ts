import { describe, expect, it } from "vitest";
import type { ProviderInstance, Runner } from "@hercule/contract";
import { providerRows } from "./provider-rows";
import { instance, snapshot, WITH_CLAUDE } from "./providers.testing";

const only = (runner: Runner, one: ProviderInstance) => providerRows(runner, [one])[0]!;

describe("providerRows", () => {
  it("reads a logged-in harness as what it is holding and what it offers", () => {
    const row = only(WITH_CLAUDE, instance("claude-code", "Claude Code", [snapshot()]));

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

  it("says the harness is signed in when it reports neither an identity nor a plan", () => {
    // A harness credentialled from the environment: the login works, but there
    // is no account name behind it, and an empty sub-line reads as a fault.
    const row = only(
      WITH_CLAUDE,
      instance("claude-code", "Claude Code", [snapshot({ auth: { status: "ok" } })]),
    );

    expect(row.account).toBe("signed in");
  });

  it("names the token source the harness reported, where it named one", () => {
    const row = only(
      WITH_CLAUDE,
      instance("claude-code", "Claude Code", [
        snapshot({ auth: { status: "ok", backend: "ANTHROPIC_API_KEY" } }),
      ]),
    );

    expect(row.account).toBe("ANTHROPIC_API_KEY");
  });

  it("names a version this build was not tested against", () => {
    const row = only(
      WITH_CLAUDE,
      instance("claude-code", "Claude Code", [
        snapshot({ harnessVersion: "2.0.9", versionVerdict: "below-floor" }),
      ]),
    );

    expect(row.verdict).toMatch(/below/);
  });

  it("offers the install, and no login, for a harness that is not on the machine", () => {
    const row = only(WITH_CLAUDE, instance("codex", "Codex", []));

    expect(row).toMatchObject({ install: "blocked", logIn: false, version: "not reported" });
    expect(row.account).toBe("no adapter in this runner build");
  });

  it("offers nothing on a machine that is not holding a connection", () => {
    const row = only(
      { ...WITH_CLAUDE, connectivity: "offline" },
      instance("claude-code", "Claude Code", [snapshot()]),
    );

    expect(row).toMatchObject({ install: "none", logIn: false, probe: false });
  });
});

/**
 * A provider logged in with a credential the user types in. What the action
 * offering it reads is decided here, so the fleet row and the Sessions screen
 * cannot word the same offer differently.
 */
describe("a provider with a secret-valued field", () => {
  const FIELD = {
    name: "zaiApiKey",
    title: "Z.ai API key",
    description: "From your Z.ai Coding Plan subscription.",
  };

  const keyed = (set: boolean): ProviderInstance => ({
    ...instance("pi", "pi", [snapshot({ auth: { status: "unauthenticated" } })]),
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

  it("asks for the key in the plugin's words, and offers to replace one that is there", () => {
    expect(only(WITH_PI, keyed(false)).secretFields).toEqual([
      { ...FIELD, set: false, label: `Enter ${FIELD.title}` },
    ]);
    expect(only(WITH_PI, keyed(true)).secretFields).toEqual([
      { ...FIELD, set: true, label: `Replace ${FIELD.title}` },
    ]);
  });

  it("offers the key in place of a login: there is no vendor to send the user to", () => {
    expect(only(WITH_PI, keyed(false)).logIn).toBe(false);
  });

  it("offers neither on a machine this harness is not on", () => {
    expect(only(WITH_CLAUDE, keyed(false))).toMatchObject({ secretFields: [], logIn: false });
  });
});
