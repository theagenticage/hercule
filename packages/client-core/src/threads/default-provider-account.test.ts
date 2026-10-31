/**
 * Tests `findDefaultProviderAccountId(accounts)`, which picks the account the
 * composer and Settings > Threads both prefill from: the first account signed
 * in on some runner in its default harness, else the first account, else none.
 */
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_IDENTITY,
  OPENAI_IDENTITY,
  buildProviderAccount,
  buildSnapshot,
} from "../providers.testing";
import { findDefaultProviderAccountId } from "./default-provider-account";

describe("findDefaultProviderAccountId", () => {
  it("picks the first account with a signed-in snapshot, not necessarily the first account", () => {
    const accounts = [
      buildProviderAccount({ ...ANTHROPIC_IDENTITY, label: "First" }, [
        buildSnapshot({ auth: { status: "unauthenticated" } }),
      ]),
      buildProviderAccount({ ...OPENAI_IDENTITY, label: "Second" }, [buildSnapshot()]),
    ];

    expect(findDefaultProviderAccountId(accounts)).toBe(accounts[1]!.id);
  });

  it("ignores a signed-in snapshot of a harness that is not the account's default", () => {
    const first = buildProviderAccount(ANTHROPIC_IDENTITY);
    const second = buildProviderAccount(OPENAI_IDENTITY, [buildSnapshot()]);
    const accounts = [
      {
        ...first,
        snapshots: [buildSnapshot({ harnessId: "pi/pi", auth: { status: "ok" } })],
      },
      second,
    ];

    expect(findDefaultProviderAccountId(accounts)).toBe(second.id);
  });

  it("falls back to the first account when none is signed in", () => {
    const accounts = [
      buildProviderAccount({ ...ANTHROPIC_IDENTITY, label: "First" }, [
        buildSnapshot({ auth: { status: "unauthenticated" } }),
      ]),
      buildProviderAccount({ ...OPENAI_IDENTITY, label: "Second" }, []),
    ];

    expect(findDefaultProviderAccountId(accounts)).toBe(accounts[0]!.id);
  });

  it("is null when there are no accounts", () => {
    expect(findDefaultProviderAccountId([])).toBeNull();
  });
});
