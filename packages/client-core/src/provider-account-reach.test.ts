/**
 * Tests `describeProviderAccountReach`: which form a card shows for each way an
 * account reaches machines, where pips give way to a count, and the text read
 * out for it.
 */
import { describe, expect, it } from "vitest";
import type { ProviderAccountMachine, ProviderAccountReach } from "./provider-account-machines";
import { describeProviderAccountReach } from "./provider-account-reach";

const buildMachine = (name: string, signedIn: boolean): ProviderAccountMachine => ({
  runnerId: `r-${name}`,
  runnerName: name,
  signedIn,
  identity: null,
  action: null,
});

const buildPerMachineReach = (...ready: ReadonlyArray<boolean>): ProviderAccountReach => ({
  kind: "per-machine",
  machines: ready.map((signedIn, index) => buildMachine(`m${index + 1}`, signedIn)),
});

describe("describeProviderAccountReach", () => {
  it("shows nothing when it is not known where the account works", () => {
    expect(describeProviderAccountReach({ kind: "unknown" })).toBeNull();
  });

  it("shows All for a credential every machine uses", () => {
    expect(describeProviderAccountReach({ kind: "shared" })).toEqual({
      form: "shared",
      description: "Shared credential: works on every machine",
    });
  });

  it("shows No machines for a per-machine account with no machine", () => {
    expect(describeProviderAccountReach(buildPerMachineReach())).toEqual({
      form: "none",
      description: "No machines",
    });
  });

  it("draws one pip per machine, filled where the account is ready, for three machines, the most it draws as pips", () => {
    expect(describeProviderAccountReach(buildPerMachineReach(true, false, true))).toEqual({
      form: "pips",
      pips: [
        { runnerId: "r-m1", ready: true },
        { runnerId: "r-m2", ready: false },
        { runnerId: "r-m3", ready: true },
      ],
      description: "Ready on 2 of 3 machines. m1: ready · m2: not ready · m3: ready",
    });
  });

  it("says machine, not machines, for one machine", () => {
    expect(describeProviderAccountReach(buildPerMachineReach(false))?.description).toBe(
      "Ready on 0 of 1 machine. m1: not ready",
    );
  });

  it("counts the ready machines out of all of them, and flags a machine that is not ready", () => {
    expect(
      describeProviderAccountReach(buildPerMachineReach(true, true, false, true, false)),
    ).toEqual({
      form: "count",
      count: "3/5",
      needsAttention: true,
      description:
        "Ready on 3 of 5 machines. m1: ready · m2: ready · m3: not ready · m4: ready · m5: not ready",
    });
  });

  it("switches to a count at four machines, and does not flag it when every machine is ready", () => {
    expect(
      describeProviderAccountReach(buildPerMachineReach(true, true, true, true)),
    ).toMatchObject({
      form: "count",
      count: "4/4",
      needsAttention: false,
    });
  });
});
