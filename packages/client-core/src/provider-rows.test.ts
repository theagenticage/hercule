import { describe, expect, it } from "vitest";
import type { ProviderInstance, Runner } from "@hydra/contract";
import { providerRows } from "./provider-rows";
import { instance, snapshot, WITH_CLAUDE } from "./providers.fixture";

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
