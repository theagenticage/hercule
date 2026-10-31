/**
 * Tests `listProviderAccountMachines`: which runners an account lists, whether it is
 * signed in on each and as whom, and the action each machine offers.
 */
import { describe, expect, it } from "vitest";
import type { ProviderAccount, Runner } from "@hercule/contract";
import {
  ANTHROPIC_IDENTITY,
  BARE,
  HARNESSES,
  PROVIDERS,
  WITH_CLAUDE,
  ZAI_IDENTITY,
  buildProviderAccount,
  buildSnapshot,
} from "./providers.testing";
import { listProviderAccountMachines } from "./provider-account-machines";

const ATLAS = { ...WITH_CLAUDE, id: "runner-atlas", name: "atlas" };
const MOSS_SIGNED_IN = buildProviderAccount(ANTHROPIC_IDENTITY, [buildSnapshot()]);

const list = (account: ProviderAccount, runners: ReadonlyArray<Runner>) => {
  const machines = listProviderAccountMachines(account, runners, PROVIDERS, HARNESSES);
  if (machines === null) throw new Error("the account does not sign in on each machine");
  return machines;
};

describe("listProviderAccountMachines", () => {
  it("lists every runner that is not retired, in the order given", () => {
    const retired = { ...ATLAS, id: "runner-gone", name: "gone", lifecycle: "retired" as const };

    expect(
      list(MOSS_SIGNED_IN, [WITH_CLAUDE, retired, ATLAS]).map((machine) => machine.runnerName),
    ).toEqual(["moss", "atlas"]);
  });

  it("says who the account is signed in as on a runner whose probe found it signed in", () => {
    const [moss, atlas] = list(MOSS_SIGNED_IN, [{ ...WITH_CLAUDE, id: BARE.id }, ATLAS]);

    expect(moss).toMatchObject({ signedIn: true, identity: "rogier@example.com" });
    expect(atlas).toMatchObject({ signedIn: false, identity: null });
  });

  it("is signed in without an identity when the harness named nobody", () => {
    const account = buildProviderAccount(ANTHROPIC_IDENTITY, [
      buildSnapshot({ auth: { status: "ok", backend: "CLAUDE_CODE_OAUTH_TOKEN" } }),
    ]);

    expect(list(account, [WITH_CLAUDE])[0]).toMatchObject({ signedIn: true, identity: null });
  });

  it("is not signed in on a runner that last found the account signed out or failed", () => {
    for (const status of ["unauthenticated", "error"] as const) {
      const account = buildProviderAccount(ANTHROPIC_IDENTITY, [
        buildSnapshot({ auth: { status } }),
      ]);

      expect(list(account, [WITH_CLAUDE])[0]).toMatchObject({ signedIn: false, identity: null });
    }
  });

  it("reads only the snapshot in the account's default harness", () => {
    const account = {
      ...buildProviderAccount(ANTHROPIC_IDENTITY, []),
      snapshots: [buildSnapshot({ harnessId: "pi/pi" })],
    };

    expect(list(account, [WITH_CLAUDE])[0]?.signedIn).toBe(false);
  });

  it("offers a sign-in where the harness is installed", () => {
    const [machine] = list(buildProviderAccount(ANTHROPIC_IDENTITY, []), [WITH_CLAUDE]);

    expect(machine?.action).toEqual({ kind: "sign-in", reason: null });
  });

  it("offers the install, and no sign-in, where the harness is missing", () => {
    const [machine] = list(buildProviderAccount(ANTHROPIC_IDENTITY, []), [BARE]);

    expect(machine?.action).toEqual({ kind: "install", reason: null });
  });

  it("offers no action where the account is signed in", () => {
    expect(list(MOSS_SIGNED_IN, [WITH_CLAUDE])[0]?.action).toBeNull();
  });

  it("gives an offline runner the offline action with its reason", () => {
    const [machine] = list(buildProviderAccount(ANTHROPIC_IDENTITY, []), [
      { ...WITH_CLAUDE, connectivity: "offline" },
    ]);

    expect(machine?.action).toEqual({ kind: "offline", reason: "moss is offline." });
  });

  it("gives a runner whose build has no adapter for the harness the unavailable action", () => {
    const binary = { ...WITH_CLAUDE.facts!, adapters: [] };
    const reason = "moss runs a Hercule build that cannot run Claude Code.";

    // The binary is there but nothing in the build can drive it.
    expect(
      list(buildProviderAccount(ANTHROPIC_IDENTITY, []), [{ ...WITH_CLAUDE, facts: binary }])[0]
        ?.action,
    ).toEqual({ kind: "unavailable", reason });
    // The binary is missing, so Install would not help either.
    expect(
      list(buildProviderAccount(ANTHROPIC_IDENTITY, []), [
        { ...BARE, facts: { ...BARE.facts!, adapters: [] } },
      ])[0]?.action,
    ).toMatchObject({ kind: "unavailable" });
  });

  it("gives the unavailable action for an account whose default harness no plugin registers", () => {
    const account = {
      ...buildProviderAccount(ANTHROPIC_IDENTITY, []),
      defaultHarnessId: "gone/gone",
    };

    expect(list(account, [WITH_CLAUDE])[0]?.action).toEqual({
      kind: "unavailable",
      reason: "moss runs a Hercule build that cannot run gone/gone.",
    });
  });

  it("returns null for an account that does not sign in on each machine", () => {
    const keyed = buildProviderAccount(ZAI_IDENTITY, []);

    expect(listProviderAccountMachines(keyed, [WITH_CLAUDE], PROVIDERS, HARNESSES)).toBeNull();
  });
});
