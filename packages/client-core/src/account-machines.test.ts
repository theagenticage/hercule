/**
 * Tests `listAccountMachines`: which runners an account lists, whether it is
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
  buildProviderAccount,
  buildSnapshot,
} from "./providers.testing";
import { listAccountMachines } from "./account-machines";

const ATLAS = { ...WITH_CLAUDE, id: "runner-atlas", name: "atlas" };
const MOSS_SIGNED_IN = buildProviderAccount(ANTHROPIC_IDENTITY, [buildSnapshot()]);

const list = (account: ProviderAccount, runners: ReadonlyArray<Runner>) =>
  listAccountMachines(account, runners, PROVIDERS, HARNESSES);

describe("listAccountMachines", () => {
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

    expect(machine).toMatchObject({ canSignIn: true, install: "none" });
  });

  it("offers the install, and no sign-in, where the harness is missing", () => {
    const [machine] = list(buildProviderAccount(ANTHROPIC_IDENTITY, []), [BARE]);

    expect(machine).toMatchObject({ canSignIn: false, install: "offered" });
  });

  it("offers nothing on an offline runner", () => {
    const [machine] = list(buildProviderAccount(ANTHROPIC_IDENTITY, []), [
      { ...WITH_CLAUDE, connectivity: "offline" },
    ]);

    expect(machine).toMatchObject({ online: false, canSignIn: false, install: "none" });
  });

  it("offers nothing for an account whose default harness no plugin registers", () => {
    const account = {
      ...buildProviderAccount(ANTHROPIC_IDENTITY, []),
      defaultHarnessId: "gone/gone",
    };

    expect(list(account, [WITH_CLAUDE])[0]).toMatchObject({ canSignIn: false, install: "none" });
  });
});
