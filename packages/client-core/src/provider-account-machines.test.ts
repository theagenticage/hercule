/**
 * Tests `listProviderAccountMachines` and `decideProviderAccountReach`: which
 * runners an account lists, whether it is signed in on each and as whom, the
 * action each machine offers, and the three ways an account can reach machines.
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
import {
  decideProviderAccountReach,
  listProviderAccountMachines,
} from "./provider-account-machines";

const ATLAS = { ...WITH_CLAUDE, id: "runner-atlas", name: "atlas" };

/** Signed in on moss only: the controller's readiness row for moss is `ready`, and atlas has none. */
const SIGNED_IN_ON_MOSS = buildProviderAccount(
  ANTHROPIC_IDENTITY,
  [buildSnapshot({ runnerId: WITH_CLAUDE.id })],
  [{ runnerId: WITH_CLAUDE.id }, { runnerId: ATLAS.id, state: "not-signed-in" }],
);

const list = (account: ProviderAccount, runners: ReadonlyArray<Runner>) => {
  const machines = listProviderAccountMachines(account, runners, PROVIDERS, HARNESSES);
  if (machines === null) throw new Error("the account does not sign in on each machine");
  return machines;
};

describe("listProviderAccountMachines", () => {
  it("lists every runner that is not retired, in the order given", () => {
    const retired = { ...ATLAS, id: "runner-gone", name: "gone", lifecycle: "retired" as const };

    expect(
      list(SIGNED_IN_ON_MOSS, [WITH_CLAUDE, retired, ATLAS]).map((machine) => machine.runnerName),
    ).toEqual(["moss", "atlas"]);
  });

  it("is signed in where the readiness row is ready, and says who as", () => {
    const [moss, atlas] = list(SIGNED_IN_ON_MOSS, [WITH_CLAUDE, ATLAS]);

    expect(moss).toMatchObject({ signedIn: true, identity: "rogier@example.com" });
    expect(atlas).toMatchObject({ signedIn: false, identity: null });
  });

  it("is signed in without an identity when the harness named nobody", () => {
    const account = buildProviderAccount(
      ANTHROPIC_IDENTITY,
      [
        buildSnapshot({
          runnerId: WITH_CLAUDE.id,
          auth: { status: "ok", backend: "CLAUDE_CODE_OAUTH_TOKEN" },
        }),
      ],
      [{ runnerId: WITH_CLAUDE.id }],
    );

    expect(list(account, [WITH_CLAUDE])[0]).toMatchObject({ signedIn: true, identity: null });
  });

  it("is not signed in where the readiness row says anything but ready, whatever the last probe found", () => {
    for (const state of [
      "not-signed-in",
      "credential-missing",
      "token-expired",
      "harness-missing",
    ] as const) {
      const account = buildProviderAccount(
        ANTHROPIC_IDENTITY,
        [buildSnapshot({ runnerId: WITH_CLAUDE.id })],
        [{ runnerId: WITH_CLAUDE.id, state }],
      );

      expect(list(account, [WITH_CLAUDE])[0]).toMatchObject({ signedIn: false, identity: null });
    }
  });

  it("is not signed in on a runner with no readiness row", () => {
    const account = buildProviderAccount(ANTHROPIC_IDENTITY, [
      buildSnapshot({ runnerId: WITH_CLAUDE.id }),
    ]);

    expect(list(account, [WITH_CLAUDE])[0]?.signedIn).toBe(false);
  });

  it("reads only the readiness row of the account's default harness", () => {
    const account = buildProviderAccount(
      ANTHROPIC_IDENTITY,
      [],
      [{ runnerId: WITH_CLAUDE.id, harnessId: "pi/pi" }],
    );

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
    expect(list(SIGNED_IN_ON_MOSS, [WITH_CLAUDE])[0]?.action).toBeNull();
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

  it("returns null for an account whose default harness no plugin registers, because nothing says where its login lives", () => {
    const account = {
      ...buildProviderAccount(ANTHROPIC_IDENTITY, []),
      defaultHarnessId: "gone/gone",
    };

    expect(listProviderAccountMachines(account, [WITH_CLAUDE], PROVIDERS, HARNESSES)).toBeNull();
  });

  it("returns null for an account that does not sign in on each machine", () => {
    const keyed = buildProviderAccount(ZAI_IDENTITY, []);

    expect(listProviderAccountMachines(keyed, [WITH_CLAUDE], PROVIDERS, HARNESSES)).toBeNull();
  });
});

describe("decideProviderAccountReach", () => {
  const decideReachForAccount = (
    account: ProviderAccount,
    providers = PROVIDERS,
    harnesses = HARNESSES,
  ) => decideProviderAccountReach(account, [WITH_CLAUDE, ATLAS], providers, harnesses);

  it("is per-machine, with the machines, for an account that signs in on each machine", () => {
    const result = decideReachForAccount(SIGNED_IN_ON_MOSS);

    expect(result.kind).toBe("per-machine");
    expect(result.kind === "per-machine" && result.machines.map((each) => each.runnerName)).toEqual(
      ["moss", "atlas"],
    );
  });

  it("is per-machine with no machines when every runner is retired", () => {
    const retired = { ...ATLAS, lifecycle: "retired" as const };

    expect(decideProviderAccountReach(SIGNED_IN_ON_MOSS, [retired], PROVIDERS, HARNESSES)).toEqual({
      kind: "per-machine",
      machines: [],
    });
  });

  it("is shared for an account whose key or token every machine uses", () => {
    expect(decideReachForAccount(buildProviderAccount(ZAI_IDENTITY, []))).toEqual({
      kind: "shared",
    });
  });

  it("is unknown when the default harness is not registered, which says nothing about where the login lives", () => {
    const account = {
      ...buildProviderAccount(ANTHROPIC_IDENTITY, []),
      defaultHarnessId: "gone/gone",
    };
    const keyed = { ...buildProviderAccount(ZAI_IDENTITY, []), defaultHarnessId: "gone/gone" };

    expect(decideReachForAccount(account)).toEqual({ kind: "unknown" });
    expect(decideReachForAccount(keyed)).toEqual({ kind: "unknown" });
  });

  it("is unknown when the provider no longer declares the account's kind", () => {
    expect(decideReachForAccount(buildProviderAccount(ANTHROPIC_IDENTITY, []), [])).toEqual({
      kind: "unknown",
    });
  });
});
