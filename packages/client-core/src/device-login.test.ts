import { describe, expect, it } from "vitest";
import { createApiStub } from "./api-stub";
import { createClient } from "./client";
import {
  decideDeviceLoginStep,
  describeDeviceLoginWait,
  startProviderLogin,
  type DeviceLogin,
} from "./device-login";
import { BARE, buildInstance, buildSnapshot } from "./providers.testing";

const STARTED_AT = "2026-09-05T09:10:00.000Z";
const LATER = "2026-09-05T09:12:00.000Z";
const EXPIRES_AT = "2026-09-05T09:25:00.000Z";

const LOGIN: DeviceLogin = {
  instanceId: "instance-codex",
  runnerId: BARE.id,
  userCode: "ABCD-1234",
  probedAtStart: STARTED_AT,
  loggedInAtStart: false,
  expiresAt: EXPIRES_AT,
};

const LOGGED_OUT = buildSnapshot({ probedAt: STARTED_AT, auth: { status: "unauthenticated" } });

describe("startProviderLogin", () => {
  // The client checks the ids in a request and in a reply, so these are real ids.
  const INSTANCE_ID = "0199c0ff-aaaa-7000-8000-0000000000c1";
  const LOGIN_PATH = `POST /api/v1/providers/${INSTANCE_ID}/login`;
  const QUERY_PATH = "GET /api/v1/providers";
  const STARTED = { url: "https://vendor.example", userCode: "ABCD-1234" };
  const buildCodex = (snapshots: Parameters<typeof buildInstance>[2]) => ({
    ...buildInstance("codex", "Codex", snapshots),
    id: INSTANCE_ID,
  });
  const connect = (handlers: Parameters<typeof createApiStub>[0]) => {
    const api = createApiStub(handlers);
    return { api, client: createClient({ baseUrl: "http://127.0.0.1:4937", fetch: api.fetch }) };
  };

  it("returns a paste-back login without reading the instances", async () => {
    const { api, client } = connect({ [LOGIN_PATH]: { body: { url: STARTED.url } } });
    expect(await startProviderLogin(client, INSTANCE_ID, BARE.id)).toEqual({
      url: STARTED.url,
      deviceLogin: null,
    });
    expect(api.calls.map((call) => `${call.method} ${call.path}`)).toEqual([LOGIN_PATH]);
  });

  it("notes when the instance was last probed, and that it was logged out", async () => {
    const { api, client } = connect({
      [LOGIN_PATH]: { body: { ...STARTED, expiresAt: EXPIRES_AT } },
      [QUERY_PATH]: { body: [buildCodex([LOGGED_OUT])] },
    });
    expect(await startProviderLogin(client, INSTANCE_ID, BARE.id)).toEqual({
      url: STARTED.url,
      deviceLogin: { ...LOGIN, instanceId: INSTANCE_ID },
    });
    expect(api.calls[0]?.body).toEqual({ runnerId: BARE.id });
  });

  it("notes a harness that was logged in already, as when the user logs in again", async () => {
    const { client } = connect({
      [LOGIN_PATH]: { body: STARTED },
      [QUERY_PATH]: { body: [buildCodex([buildSnapshot()])] },
    });
    const started = await startProviderLogin(client, INSTANCE_ID, BARE.id);
    expect(started.deviceLogin).toMatchObject({ probedAtStart: STARTED_AT, loggedInAtStart: true });
  });

  it("notes an instance that was never probed on the runner", async () => {
    const { client } = connect({
      [LOGIN_PATH]: { body: STARTED },
      [QUERY_PATH]: { body: [buildCodex([])] },
    });
    const started = await startProviderLogin(client, INSTANCE_ID, BARE.id);
    expect(started.deviceLogin).toMatchObject({
      probedAtStart: null,
      loggedInAtStart: false,
      expiresAt: undefined,
    });
  });
});

describe("decideDeviceLoginStep", () => {
  it("waits while the only snapshot is the one from before the login", () => {
    const stale = buildSnapshot({ probedAt: STARTED_AT });
    const instances = [buildInstance("codex", "Codex", [stale])];
    expect(decideDeviceLoginStep(LOGIN, instances, 5)).toEqual({
      kind: "waiting",
      minutesLeft: 5,
      endsByItself: true,
    });
  });

  it("waits while a fresh snapshot still shows the harness logged out", () => {
    const fresh = buildSnapshot({ probedAt: LATER, auth: { status: "unauthenticated" } });
    const instances = [buildInstance("codex", "Codex", [fresh])];
    expect(decideDeviceLoginStep(LOGIN, instances, 5)).toMatchObject({ kind: "waiting" });
  });

  it("is done once a fresh snapshot shows the harness logged in", () => {
    const instances = [buildInstance("codex", "Codex", [buildSnapshot({ probedAt: LATER })])];
    expect(decideDeviceLoginStep(LOGIN, instances, 5)).toEqual({ kind: "done" });
  });

  it("is done for an instance that had no snapshot when the login started", () => {
    const instances = [buildInstance("codex", "Codex", [buildSnapshot({ probedAt: LATER })])];
    const login = { ...LOGIN, probedAtStart: null };
    expect(decideDeviceLoginStep(login, instances, 5)).toEqual({ kind: "done" });
  });

  it("never ends by itself for a harness that was logged in when the login started", () => {
    // The controller also probes when a runner connects, and the old
    // credential still checks as logged in, so a fresh logged-in snapshot
    // does not prove that this login ended.
    const instances = [buildInstance("codex", "Codex", [buildSnapshot({ probedAt: LATER })])];
    const login = { ...LOGIN, loggedInAtStart: true };
    expect(decideDeviceLoginStep(login, instances, 5)).toEqual({
      kind: "waiting",
      minutesLeft: 5,
      endsByItself: false,
    });
  });

  it("ignores a fresh snapshot from another runner", () => {
    const elsewhere = buildSnapshot({ probedAt: LATER, runnerId: "another-runner" });
    const instances = [buildInstance("codex", "Codex", [LOGGED_OUT, elsewhere])];
    expect(decideDeviceLoginStep(LOGIN, instances, 5)).toMatchObject({ kind: "waiting" });
  });

  it("has expired once no minute is left", () => {
    const instances = [buildInstance("codex", "Codex", [LOGGED_OUT])];
    expect(decideDeviceLoginStep(LOGIN, instances, 0)).toEqual({ kind: "expired" });
  });

  it("is done rather than expired when the logged-in snapshot arrives late", () => {
    const instances = [buildInstance("codex", "Codex", [buildSnapshot({ probedAt: LATER })])];
    expect(decideDeviceLoginStep(LOGIN, instances, 0)).toEqual({ kind: "done" });
  });

  it("keeps waiting when the runner's build gave no expiry", () => {
    const instances = [buildInstance("codex", "Codex", [LOGGED_OUT])];
    expect(decideDeviceLoginStep(LOGIN, instances, null)).toEqual({
      kind: "waiting",
      minutesLeft: null,
      endsByItself: true,
    });
  });
});

describe("describeDeviceLoginWait", () => {
  it("names how many minutes the code still works, in the singular for one", () => {
    expect(describeDeviceLoginWait({ kind: "waiting", minutesLeft: 12, endsByItself: true })).toBe(
      "Waiting for you to finish signing in. The code expires in 12 minutes.",
    );
    expect(describeDeviceLoginWait({ kind: "waiting", minutesLeft: 1, endsByItself: true })).toBe(
      "Waiting for you to finish signing in. The code expires in 1 minute.",
    );
  });

  it("names no time when the runner did not say when the code expires", () => {
    expect(
      describeDeviceLoginWait({ kind: "waiting", minutesLeft: null, endsByItself: true }),
    ).toBe("Waiting for you to finish signing in.");
  });

  it("explains why a login that started logged in cannot end by itself", () => {
    expect(
      describeDeviceLoginWait({ kind: "waiting", minutesLeft: null, endsByItself: false }),
    ).toBe(
      "Waiting for you to finish signing in. You were logged in already, so Hercule cannot tell when you finish.",
    );
  });
});
