/**
 * Tests `findDefaultProviderAccountId(accounts)`, which picks the account the
 * composer and Settings > Threads both prefill from: the first account that
 * is ready on some runner in its default harness, else the first account, else
 * none.
 */
import { describe, expect, it } from "vitest";
import { ANTHROPIC_IDENTITY, OPENAI_IDENTITY, buildProviderAccount } from "../providers.testing";
import { findDefaultProviderAccountId } from "./default-provider-account";

describe("findDefaultProviderAccountId", () => {
  it("picks the first account that is ready somewhere, not necessarily the first account", () => {
    const accounts = [
      buildProviderAccount(
        { ...ANTHROPIC_IDENTITY, label: "First" },
        [],
        [{ runnerId: "moss", state: "not-signed-in" }],
      ),
      buildProviderAccount({ ...OPENAI_IDENTITY, label: "Second" }, [], [{ runnerId: "moss" }]),
    ];

    expect(findDefaultProviderAccountId(accounts)).toBe(accounts[1]!.id);
  });

  it("ignores readiness in a harness that is not the account's default", () => {
    const accounts = [
      buildProviderAccount(ANTHROPIC_IDENTITY, [], [{ runnerId: "moss", harnessId: "pi/pi" }]),
      buildProviderAccount(OPENAI_IDENTITY, [], [{ runnerId: "moss" }]),
    ];

    expect(findDefaultProviderAccountId(accounts)).toBe(accounts[1]!.id);
  });

  it("falls back to the first account when none is ready", () => {
    const accounts = [
      buildProviderAccount(
        { ...ANTHROPIC_IDENTITY, label: "First" },
        [],
        [{ runnerId: "moss", state: "credential-missing" }],
      ),
      buildProviderAccount({ ...OPENAI_IDENTITY, label: "Second" }),
    ];

    expect(findDefaultProviderAccountId(accounts)).toBe(accounts[0]!.id);
  });

  it("is null when there are no accounts", () => {
    expect(findDefaultProviderAccountId([])).toBeNull();
  });
});
