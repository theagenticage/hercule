import { describe, expect, it } from "vitest";
import { createApiStub } from "./api-stub";
import { createClient } from "./client";
import {
  decideDeviceLoginStep,
  describeDeviceLoginWait,
  startProviderLogin,
  type DeviceLogin,
} from "./device-login";
import { BARE, buildProviderAccount, buildSnapshot, OPENAI_IDENTITY } from "./providers.testing";

const STARTED_AT = "2026-09-05T09:10:00.000Z";
const LATER = "2026-09-05T09:12:00.000Z";
const EXPIRES_AT = "2026-09-05T09:25:00.000Z";

const LOGIN: DeviceLogin = {
  providerAccountId: "account-openai",
  runnerId: BARE.id,
  userCode: "ABCD-1234",
  probedAtStart: STARTED_AT,
  loggedInAtStart: false,
  expiresAt: EXPIRES_AT,
};

const SIGNED_OUT = buildSnapshot({ probedAt: STARTED_AT, auth: { status: "unauthenticated" } });

describe("startProviderLogin", () => {
  // The client checks the ids in a request and in a reply, so these are real ids.
  const ACCOUNT_ID = "0199c0ff-aaaa-7000-8000-0000000000c1";
  const LOGIN_PATH = `POST /api/v1/provider-accounts/${ACCOUNT_ID}/sign-in`;
  const QUERY_PATH = "GET /api/v1/provider-accounts";
  const STARTED = { url: "https://vendor.example", userCode: "ABCD-1234" };
  const buildCodex = (snapshots: Parameters<typeof buildProviderAccount>[1]) =>
    buildProviderAccount({ ...OPENAI_IDENTITY, id: ACCOUNT_ID }, snapshots);
  const connect = (handlers: Parameters<typeof createApiStub>[0]) => {
    const api = createApiStub(handlers);
    return { api, client: createClient({ baseUrl: "http://127.0.0.1:4937", fetch: api.fetch }) };
  };

  it("returns a paste-back login without reading the accounts", async () => {
    const { api, client } = connect({ [LOGIN_PATH]: { body: { url: STARTED.url } } });
    expect(await startProviderLogin(client, ACCOUNT_ID, BARE.id)).toEqual({
      url: STARTED.url,
      deviceLogin: null,
    });
    expect(api.calls.map((call) => `${call.method} ${call.path}`)).toEqual([LOGIN_PATH]);
  });

  it("notes when the account was last probed, and that it was signed out", async () => {
    const { api, client } = connect({
      [LOGIN_PATH]: { body: { ...STARTED, expiresAt: EXPIRES_AT } },
      [QUERY_PATH]: { body: [buildCodex([SIGNED_OUT])] },
    });
    expect(await startProviderLogin(client, ACCOUNT_ID, BARE.id)).toEqual({
      url: STARTED.url,
      deviceLogin: { ...LOGIN, providerAccountId: ACCOUNT_ID },
    });
    expect(api.calls[0]?.body).toEqual({ runnerId: BARE.id });
  });

  it("notes a harness that was signed in already, as when the user logs in again", async () => {
    const { client } = connect({
      [LOGIN_PATH]: { body: STARTED },
      [QUERY_PATH]: { body: [buildCodex([buildSnapshot()])] },
    });
    const started = await startProviderLogin(client, ACCOUNT_ID, BARE.id);
    expect(started.deviceLogin).toMatchObject({ probedAtStart: STARTED_AT, loggedInAtStart: true });
  });

  it("notes an account that was never probed on the runner", async () => {
    const { client } = connect({
      [LOGIN_PATH]: { body: STARTED },
      [QUERY_PATH]: { body: [buildCodex([])] },
    });
    const started = await startProviderLogin(client, ACCOUNT_ID, BARE.id);
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
    const accounts = [buildProviderAccount(OPENAI_IDENTITY, [stale])];
    expect(decideDeviceLoginStep(LOGIN, accounts, 5)).toEqual({
      kind: "waiting",
      minutesLeft: 5,
      endsByItself: true,
    });
  });

  it("waits while a fresh snapshot still shows the harness signed out", () => {
    const fresh = buildSnapshot({ probedAt: LATER, auth: { status: "unauthenticated" } });
    const accounts = [buildProviderAccount(OPENAI_IDENTITY, [fresh])];
    expect(decideDeviceLoginStep(LOGIN, accounts, 5)).toMatchObject({ kind: "waiting" });
  });

  it("is done once a fresh snapshot shows the harness signed in", () => {
    const accounts = [buildProviderAccount(OPENAI_IDENTITY, [buildSnapshot({ probedAt: LATER })])];
    expect(decideDeviceLoginStep(LOGIN, accounts, 5)).toEqual({ kind: "done" });
  });

  it("is done for an account that had no snapshot when the login started", () => {
    const accounts = [buildProviderAccount(OPENAI_IDENTITY, [buildSnapshot({ probedAt: LATER })])];
    const login = { ...LOGIN, probedAtStart: null };
    expect(decideDeviceLoginStep(login, accounts, 5)).toEqual({ kind: "done" });
  });

  it("never ends by itself for a harness that was signed in when the login started", () => {
    // The controller also probes when a runner connects, and the old
    // credential still checks as signed in, so a fresh signed-in snapshot
    // does not prove that this login ended.
    const accounts = [buildProviderAccount(OPENAI_IDENTITY, [buildSnapshot({ probedAt: LATER })])];
    const login = { ...LOGIN, loggedInAtStart: true };
    expect(decideDeviceLoginStep(login, accounts, 5)).toEqual({
      kind: "waiting",
      minutesLeft: 5,
      endsByItself: false,
    });
  });

  it("ignores a fresh snapshot from another runner", () => {
    const elsewhere = buildSnapshot({ probedAt: LATER, runnerId: "another-runner" });
    const accounts = [buildProviderAccount(OPENAI_IDENTITY, [SIGNED_OUT, elsewhere])];
    expect(decideDeviceLoginStep(LOGIN, accounts, 5)).toMatchObject({ kind: "waiting" });
  });

  it("has expired once no minute is left", () => {
    const accounts = [buildProviderAccount(OPENAI_IDENTITY, [SIGNED_OUT])];
    expect(decideDeviceLoginStep(LOGIN, accounts, 0)).toEqual({ kind: "expired" });
  });

  it("is done rather than expired when the signed-in snapshot arrives late", () => {
    const accounts = [buildProviderAccount(OPENAI_IDENTITY, [buildSnapshot({ probedAt: LATER })])];
    expect(decideDeviceLoginStep(LOGIN, accounts, 0)).toEqual({ kind: "done" });
  });

  it("keeps waiting when the runner's build gave no expiry", () => {
    const accounts = [buildProviderAccount(OPENAI_IDENTITY, [SIGNED_OUT])];
    expect(decideDeviceLoginStep(LOGIN, accounts, null)).toEqual({
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

  it("explains why a login that started signed in cannot end by itself", () => {
    expect(
      describeDeviceLoginWait({ kind: "waiting", minutesLeft: null, endsByItself: false }),
    ).toBe(
      "Waiting for you to finish signing in. You were signed in already, so Hercule cannot tell when you finish.",
    );
  });
});
