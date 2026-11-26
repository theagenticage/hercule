/** Tests the registry that keeps a sign-in and running processes apart on one Harness Home. */
import { describe, expect, it } from "vitest";
import { makeHarnessHomeLeases, VERIFYING_BOUND_MS, type LeaseResult } from "./harness-home-leases";

const HOME = "/runner/providers/homes/account-one/antigravity";
const OTHER_HOME = "/runner/providers/homes/account-two/antigravity";

const expectHeld = (result: LeaseResult): (() => void) => {
  if (!result.acquired) throw new Error(`refused: ${result.message}`);
  return result.release;
};

const expectRefused = (result: LeaseResult): string => {
  if (result.acquired) throw new Error("expected a refusal");
  return result.message;
};

describe("read leases", () => {
  it("can be held by many sessions and probes at once", () => {
    const leases = makeHarnessHomeLeases();

    expectHeld(leases.acquireRead(HOME, "session"));
    expectHeld(leases.acquireRead(HOME, "session"));
    expectHeld(leases.acquireRead(HOME, "probe"));
  });

  it("are refused while a sign-in holds the home, and the message names the sign-in", () => {
    const leases = makeHarnessHomeLeases();
    expectHeld(leases.acquireExclusive(HOME));

    expect(expectRefused(leases.acquireRead(HOME, "session"))).toContain("sign-in");
    expect(expectRefused(leases.acquireRead(HOME, "probe"))).toContain("sign-in");
  });

  it("are granted again once the sign-in is released", () => {
    const leases = makeHarnessHomeLeases();
    const release = expectHeld(leases.acquireExclusive(HOME));

    release();

    expectHeld(leases.acquireRead(HOME, "session"));
  });
});

describe("the exclusive lease", () => {
  it("is refused while sessions or a probe run, and the message counts them", () => {
    const leases = makeHarnessHomeLeases();
    expectHeld(leases.acquireRead(HOME, "session"));
    expectHeld(leases.acquireRead(HOME, "session"));
    expectHeld(leases.acquireRead(HOME, "probe"));

    const message = expectRefused(leases.acquireExclusive(HOME));

    expect(message).toBe(
      "Cannot sign in now: 2 sessions and a check of this account run on this runner. Stop the sessions, wait for the check to end, and try again.",
    );
  });

  it("names only the sessions when only sessions run", () => {
    const leases = makeHarnessHomeLeases();
    expectHeld(leases.acquireRead(HOME, "session"));

    expect(expectRefused(leases.acquireExclusive(HOME))).toBe(
      "Cannot sign in now: 1 session of this account runs on this runner. Stop the session and try again.",
    );
  });

  it("names only the check when only a probe runs", () => {
    const leases = makeHarnessHomeLeases();
    expectHeld(leases.acquireRead(HOME, "probe"));

    expect(expectRefused(leases.acquireExclusive(HOME))).toBe(
      "Cannot sign in now: a check of this account runs on this runner. Wait for the check to end and try again.",
    );
  });

  it("is granted once every read lease is released, and a repeated release changes nothing", () => {
    const leases = makeHarnessHomeLeases();
    const releaseFirst = expectHeld(leases.acquireRead(HOME, "session"));
    const releaseSecond = expectHeld(leases.acquireRead(HOME, "session"));

    releaseFirst();
    releaseFirst();
    expectRefused(leases.acquireExclusive(HOME));
    releaseSecond();

    expectHeld(leases.acquireExclusive(HOME));
  });

  it("is held by one sign-in at a time", () => {
    const leases = makeHarnessHomeLeases();
    const release = expectHeld(leases.acquireExclusive(HOME));

    expect(expectRefused(leases.acquireExclusive(HOME))).toContain("in progress");
    release();
    expectHeld(leases.acquireExclusive(HOME));
  });

  it("cannot be released twice into someone else's lease", () => {
    const leases = makeHarnessHomeLeases();
    const releaseOld = expectHeld(leases.acquireExclusive(HOME));
    releaseOld();
    expectHeld(leases.acquireExclusive(HOME));

    releaseOld();

    expectRefused(leases.acquireRead(HOME, "session"));
  });
});

describe("two homes", () => {
  it("do not affect each other, and a path is the same home however it is written", () => {
    const leases = makeHarnessHomeLeases();
    expectHeld(leases.acquireRead(HOME, "session"));

    expectHeld(leases.acquireExclusive(OTHER_HOME));
    expectRefused(leases.acquireExclusive(`${HOME}/../antigravity`));
  });
});

const verifyAfterSignIn = (leases: ReturnType<typeof makeHarnessHomeLeases>): void => {
  const lease = leases.acquireExclusive(HOME);
  if (!lease.acquired) throw new Error("refused");
  lease.startVerifying?.();
};

describe("a home whose sign-in succeeded", () => {
  it("refuses a session but allows a probe, and the first probe's end frees the home", () => {
    const leases = makeHarnessHomeLeases();
    verifyAfterSignIn(leases);

    expect(expectRefused(leases.acquireRead(HOME, "session"))).toContain("being checked");
    const endProbe = expectHeld(leases.acquireRead(HOME, "probe"));
    expectRefused(leases.acquireRead(HOME, "session"));
    endProbe();

    expectHeld(leases.acquireRead(HOME, "session"));
  });

  it("frees itself after the bound, and not before", () => {
    let now = 1_000;
    const leases = makeHarnessHomeLeases(() => now);
    verifyAfterSignIn(leases);

    now += VERIFYING_BOUND_MS - 1;
    expectRefused(leases.acquireRead(HOME, "session"));
    now += 1;

    expectHeld(leases.acquireRead(HOME, "session"));
  });

  it("is replaced by a new sign-in", () => {
    const leases = makeHarnessHomeLeases();
    verifyAfterSignIn(leases);

    const second = expectHeld(leases.acquireExclusive(HOME));
    second();

    expectHeld(leases.acquireRead(HOME, "session"));
  });

  it("is not entered by a sign-in that is released instead of verified", () => {
    const leases = makeHarnessHomeLeases();
    expectHeld(leases.acquireExclusive(HOME))();

    expectHeld(leases.acquireRead(HOME, "session"));
  });
});
