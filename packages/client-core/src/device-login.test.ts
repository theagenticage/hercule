import { describe, expect, it } from "vitest";
import {
  decideDeviceLoginStep,
  describeDeviceLoginWait,
  readProbedAt,
  type DeviceLogin,
} from "./device-login";
import { BARE, buildInstance, buildSnapshot } from "./providers.testing";

const STARTED_AT = "2026-09-05T09:10:00.000Z";
const LATER = "2026-09-05T09:12:00.000Z";
const EXPIRES_AT = "2026-09-05T09:25:00.000Z";

const LOGIN: DeviceLogin = {
  instanceId: "instance-codex",
  runnerId: BARE.id,
  probedAtStart: STARTED_AT,
  expiresAt: EXPIRES_AT,
};

const BEFORE_EXPIRY = Date.parse("2026-09-05T09:20:00.000Z");
const AFTER_EXPIRY = Date.parse("2026-09-05T09:30:00.000Z");

const LOGGED_OUT = buildSnapshot({ probedAt: STARTED_AT, auth: { status: "unauthenticated" } });

describe("readProbedAt", () => {
  it("returns when the instance was last probed on the runner", () => {
    const instances = [buildInstance("codex", "Codex", [LOGGED_OUT])];
    expect(readProbedAt(instances, "instance-codex", BARE.id)).toBe(STARTED_AT);
  });

  it("returns null when the instance was never probed on the runner", () => {
    const instances = [buildInstance("codex", "Codex", [])];
    expect(readProbedAt(instances, "instance-codex", BARE.id)).toBeNull();
  });
});

describe("decideDeviceLoginStep", () => {
  it("rounds the time left up, so a code with seconds to go still shows a minute", () => {
    const instances = [buildInstance("codex", "Codex", [LOGGED_OUT])];
    const now = Date.parse(EXPIRES_AT) - 1_000;
    expect(decideDeviceLoginStep(LOGIN, instances, now)).toEqual({
      kind: "waiting",
      minutesLeft: 1,
    });
  });

  it("waits while the only snapshot is the one from before the login", () => {
    // Logged in before the login started is not proof the login worked.
    const stale = buildSnapshot({ probedAt: STARTED_AT });
    const instances = [buildInstance("codex", "Codex", [stale])];
    expect(decideDeviceLoginStep(LOGIN, instances, BEFORE_EXPIRY)).toEqual({
      kind: "waiting",
      minutesLeft: 5,
    });
  });

  it("waits while a fresh snapshot still says the harness is logged out", () => {
    const fresh = buildSnapshot({ probedAt: LATER, auth: { status: "unauthenticated" } });
    const instances = [buildInstance("codex", "Codex", [fresh])];
    expect(decideDeviceLoginStep(LOGIN, instances, BEFORE_EXPIRY)).toEqual({
      kind: "waiting",
      minutesLeft: 5,
    });
  });

  it("is done once a fresh snapshot says the harness is logged in", () => {
    const instances = [buildInstance("codex", "Codex", [buildSnapshot({ probedAt: LATER })])];
    expect(decideDeviceLoginStep(LOGIN, instances, BEFORE_EXPIRY)).toEqual({ kind: "done" });
  });

  it("is done for an instance that had no snapshot when the login started", () => {
    const instances = [buildInstance("codex", "Codex", [buildSnapshot({ probedAt: LATER })])];
    const login = { ...LOGIN, probedAtStart: null };
    expect(decideDeviceLoginStep(login, instances, BEFORE_EXPIRY)).toEqual({ kind: "done" });
  });

  it("ignores a fresh snapshot from another runner", () => {
    const elsewhere = buildSnapshot({ probedAt: LATER, runnerId: "another-runner" });
    const instances = [buildInstance("codex", "Codex", [LOGGED_OUT, elsewhere])];
    expect(decideDeviceLoginStep(LOGIN, instances, BEFORE_EXPIRY)).toEqual({
      kind: "waiting",
      minutesLeft: 5,
    });
  });

  it("has expired once the code's expiry has passed", () => {
    const instances = [buildInstance("codex", "Codex", [LOGGED_OUT])];
    expect(decideDeviceLoginStep(LOGIN, instances, AFTER_EXPIRY)).toEqual({ kind: "expired" });
  });

  it("is done rather than expired when the logged-in snapshot arrives late", () => {
    const instances = [buildInstance("codex", "Codex", [buildSnapshot({ probedAt: LATER })])];
    expect(decideDeviceLoginStep(LOGIN, instances, AFTER_EXPIRY)).toEqual({ kind: "done" });
  });

  it("keeps waiting when the runner's build gave no expiry", () => {
    const instances = [buildInstance("codex", "Codex", [LOGGED_OUT])];
    const login = { ...LOGIN, expiresAt: undefined };
    expect(decideDeviceLoginStep(login, instances, AFTER_EXPIRY)).toEqual({
      kind: "waiting",
      minutesLeft: null,
    });
  });
});

describe("describeDeviceLoginWait", () => {
  it("says how many minutes the code still works, in the singular for one", () => {
    expect(describeDeviceLoginWait(12)).toBe(
      "Waiting for you to finish signing in. The code expires in 12 minutes.",
    );
    expect(describeDeviceLoginWait(1)).toBe(
      "Waiting for you to finish signing in. The code expires in 1 minute.",
    );
  });

  it("names no time when the runner did not say when the code expires", () => {
    expect(describeDeviceLoginWait(null)).toBe("Waiting for you to finish signing in.");
  });
});
