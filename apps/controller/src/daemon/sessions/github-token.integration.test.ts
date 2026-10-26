/**
 * Tests how a session gets its GitHub token, over the real API and runner
 * socket against a fake runner:
 *
 * - the start frame carries the token, its expiry, the Connection it belongs
 *   to and the git identity, as the claim reads them. The controller never
 *   refreshes at start: the runner asks for a fresh token while it prepares
 *   the session;
 * - a session whose Connection cannot give a token still starts, with the
 *   Connection's id but without the token, its expiry and the identity;
 * - the controller answers a runner's `githubTokenRequest` for a session
 *   running on that runner, and refuses every other request with a reason.
 *
 * The provider is an in-test server standing in for GitHub's device flow, so
 * a token can expire soon and a refresh can be held back.
 */
import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HOST_API, registerConnectionType, type Plugin } from "@hercule/plugin-host";
import type { GithubTokenAnswer, SessionStart } from "@hercule/protocol";
import {
  buildJsonResponse,
  createDeviceProvider,
  listConnections,
  type DeviceProvider,
} from "../../connections/testing";
import { withTransaction } from "../../db";
import { post, send } from "../../http/testing";
import {
  at,
  readProfileNamed,
  readSessionToken,
  reportEvent,
  spawnSessionOrFail,
  waitForSession,
  waitForStartFrames,
  waitUntil,
  WAIT_DEADLINE_MS,
  withAgentFleet,
  type Arranged,
  type Wire,
} from "../../sessions/testing";
import { disableConnection } from "../../workspaces/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

const LOGIN = "octocat";
const FIRST_TOKEN = "gho_first";
const REFRESHED_TOKEN = "gho_refreshed";
const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;

/**
 * The GitHub Connection type with a device flow against the test provider,
 * and a pasted token as the other way to connect.
 */
const buildGithubPlugin = (provider: DeviceProvider): Plugin => ({
  manifest: {
    id: "github",
    displayName: "GitHub",
    hostApi: HOST_API,
    capabilities: ["connections"],
    configSchema: Schema.Struct({}),
  },
  register: (host) =>
    registerConnectionType(host, {
      type: "github",
      displayName: "GitHub",
      setup: [
        { kind: "device" },
        { kind: "credentials", fields: [{ name: "pat", label: "Token" }] },
      ],
      device: {
        clientId: "device-client-1",
        deviceCodeUrl: `${provider.base}/device/code`,
        tokenUrl: `${provider.base}/token`,
        scopes: ["repo"],
      },
      validate: () => Effect.succeed({ displayName: LOGIN, accountId: "583231" }),
    }),
  activate: () => Effect.succeed(Effect.void),
});

/** Runs `body` against a fleet whose controller has the GitHub type and a provider to refresh against. */
const withGithubFleet = async (
  body: (arranged: Arranged, provider: DeviceProvider) => Promise<void>,
): Promise<void> => {
  const provider = createDeviceProvider();
  try {
    await withAgentFleet((arranged) => body(arranged, provider), {
      plugins: [buildGithubPlugin(provider)],
    });
  } finally {
    await provider.stop();
  }
};

/**
 * Makes the token endpoint issue `FIRST_TOKEN` expiring in `expiresIn`
 * seconds. It answers every refresh with `REFRESHED_TOKEN`, valid for
 * `refreshedExpiresIn` seconds, once `beforeRefresh` is done.
 */
const answerTokens = (
  provider: DeviceProvider,
  expiresIn: number,
  { refreshedExpiresIn = 8 * HOUR_SECONDS, beforeRefresh = () => Promise.resolve() } = {},
): void => {
  provider.answers.token = async () => {
    if (provider.tokenRequests.at(-1)?.["grant_type"] !== "refresh_token") {
      return buildJsonResponse({
        access_token: FIRST_TOKEN,
        refresh_token: "refresh-1",
        token_type: "bearer",
        expires_in: expiresIn,
      });
    }
    await beforeRefresh();
    return buildJsonResponse({
      access_token: REFRESHED_TOKEN,
      refresh_token: "refresh-2",
      token_type: "bearer",
      expires_in: refreshedExpiresIn,
    });
  };
};

const refreshesAsked = (provider: DeviceProvider): number =>
  provider.tokenRequests.filter((form) => form["grant_type"] === "refresh_token").length;

/** Signs in to GitHub through the device flow, and returns the new Connection's id. */
const signIn = async (arranged: Arranged): Promise<string> => {
  const { base } = arranged.harness;
  const started = await post(
    base,
    "/api/v1/oauth/device/start",
    { type: "github/github" },
    arranged.token,
  );
  const { setupId } = (await started.json()) as { setupId: string };
  // The poll interval cannot be waited out in a test, so the next poll time is moved into the past.
  const { sql } = arranged.harness;
  await Effect.runPromise(
    Effect.orDie(
      withTransaction(
        sql,
        sql`UPDATE device_setups SET next_poll_at = '2020-01-01T00:00:00.000Z' WHERE setup_id = ${setupId}`,
      ),
    ),
  );
  const polled = await post(base, "/api/v1/oauth/device/poll", { setupId }, arranged.token);
  expect(await polled.json()).toMatchObject({ status: "done" });
  const [connection] = await listConnections(base, arranged.token);
  return connection!.id;
};

/** Connects a Connection with a pasted token, and returns its id. */
const connectWithPastedToken = async (arranged: Arranged, pat: string): Promise<string> => {
  const response = await post(
    arranged.harness.base,
    "/api/v1/connections",
    { type: "github/github", label: "pasted", credentials: { pat } },
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
};

/** Makes Threads that start from now on push as this Connection. */
const setDefaultConnection = async (arranged: Arranged, connectionId: string): Promise<void> => {
  const response = await send("PATCH", arranged.harness.base, "/api/v1/settings", {
    body: { user: { "github.defaultConnectionId": connectionId } },
    token: arranged.token,
  });
  expect(response.status, await response.clone().text()).toBe(200);
};

/** Spawns a Thread and returns its id. */
const spawnThread = async (arranged: Arranged): Promise<string> =>
  (
    await spawnSessionOrFail(arranged, {
      prompt: "hello",
      permissionProfileId: (await readProfileNamed(arranged, "worker")).id,
    })
  ).id;

/** Spawns a Thread and returns the frame that started it. */
const spawnAndAwaitStart = async (arranged: Arranged): Promise<SessionStart> =>
  (await waitForStartFrames(arranged, await spawnThread(arranged), 1))[0]!;

/** Sends a `githubTokenRequest` from this runner and waits for the answer. */
const requestToken = async (wire: Wire, sessionToken: string): Promise<GithubTokenAnswer> => {
  const requestId = crypto.randomUUID();
  wire.send({ _tag: "githubTokenRequest", requestId, sessionToken });
  return await waitUntil("answered the GitHub token request", () =>
    wire.frames.find(
      (frame): frame is GithubTokenAnswer =>
        frame._tag === "githubTokenAnswer" && frame.requestId === requestId,
    ),
  );
};

describe("the start frame of a session with a GitHub Connection", () => {
  it("carries a pasted token, its Connection and the git identity, and no expiry", async () => {
    await withGithubFleet(async (arranged) => {
      const connectionId = await connectWithPastedToken(arranged, "ghp_pasted");
      await setDefaultConnection(arranged, connectionId);

      const start = await spawnAndAwaitStart(arranged);

      expect(start).toMatchObject({
        ghToken: "ghp_pasted",
        githubConnectionId: connectionId,
        gitIdentity: { name: LOGIN, email: `${LOGIN}@users.noreply.github.com` },
      });
      expect(start).not.toHaveProperty("ghTokenExpiresAt");
    });
  });

  it("carries a token that is outside the refresh margin as it is, with its expiry", async () => {
    await withGithubFleet(async (arranged, provider) => {
      answerTokens(provider, HOUR_SECONDS);
      const connectionId = await signIn(arranged);
      await setDefaultConnection(arranged, connectionId);

      const start = await spawnAndAwaitStart(arranged);

      expect(start.ghToken).toBe(FIRST_TOKEN);
      expect(start.githubConnectionId).toBe(connectionId);
      expect(Date.parse(start.ghTokenExpiresAt!) - Date.now()).toBeGreaterThan(50 * 60_000);
      expect(refreshesAsked(provider)).toBe(0);
    });
  });

  it("carries a token inside the refresh margin as it is, with its expiry, and does not refresh it", async () => {
    await withGithubFleet(async (arranged, provider) => {
      answerTokens(provider, 5 * MINUTE_SECONDS);
      const connectionId = await signIn(arranged);
      await setDefaultConnection(arranged, connectionId);

      const start = await spawnAndAwaitStart(arranged);

      expect(start.ghToken).toBe(FIRST_TOKEN);
      expect(start.githubConnectionId).toBe(connectionId);
      const remaining = Date.parse(start.ghTokenExpiresAt!) - Date.now();
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(5 * 60_000);
      expect(refreshesAsked(provider)).toBe(0);
    });
  });

  it("carries the Connection and the git identity but no token or expiry when the token has expired", async () => {
    await withGithubFleet(async (arranged, provider) => {
      answerTokens(provider, -MINUTE_SECONDS);
      const connectionId = await signIn(arranged);
      await setDefaultConnection(arranged, connectionId);

      const start = await spawnAndAwaitStart(arranged);

      expect(start.githubConnectionId).toBe(connectionId);
      expect(start.gitIdentity).toEqual({
        name: LOGIN,
        email: `${LOGIN}@users.noreply.github.com`,
      });
      for (const key of ["ghToken", "ghTokenExpiresAt"]) {
        expect(start).not.toHaveProperty(key);
      }
      expect(refreshesAsked(provider)).toBe(0);
    });
  });

  it("carries the Connection and the git identity but no token or expiry when the Connection is disabled", async () => {
    await withGithubFleet(async (arranged) => {
      const connectionId = await connectWithPastedToken(arranged, "ghp_pasted");
      await setDefaultConnection(arranged, connectionId);
      await disableConnection(arranged, connectionId);

      const start = await spawnAndAwaitStart(arranged);

      expect(start.githubConnectionId).toBe(connectionId);
      expect(start.gitIdentity).toEqual({
        name: LOGIN,
        email: `${LOGIN}@users.noreply.github.com`,
      });
      for (const key of ["ghToken", "ghTokenExpiresAt"]) {
        expect(start).not.toHaveProperty(key);
      }
    });
  });
});

describe("a runner's request for a session's GitHub token", () => {
  it("is granted, with the token and its expiry, to the runner the session runs on", async () => {
    await withGithubFleet(async (arranged, provider) => {
      answerTokens(provider, HOUR_SECONDS);
      await setDefaultConnection(arranged, await signIn(arranged));
      const start = await spawnAndAwaitStart(arranged);

      const answer = await requestToken(arranged.wire, readSessionToken(start));

      expect(answer).toEqual({
        _tag: "githubTokenAnswer",
        requestId: expect.any(String) as unknown,
        token: FIRST_TOKEN,
        expiresAt: start.ghTokenExpiresAt,
      });
    });
  });

  it("is granted a pasted token with no expiry", async () => {
    await withGithubFleet(async (arranged) => {
      await setDefaultConnection(arranged, await connectWithPastedToken(arranged, "ghp_pasted"));
      const start = await spawnAndAwaitStart(arranged);

      const answer = await requestToken(arranged.wire, readSessionToken(start));

      expect(answer).toMatchObject({ token: "ghp_pasted" });
      expect(answer).not.toHaveProperty("expiresAt");
    });
  });

  it("is refused when it comes from another runner", async () => {
    await withGithubFleet(async (arranged) => {
      await setDefaultConnection(arranged, await connectWithPastedToken(arranged, "ghp_pasted"));
      const start = await spawnAndAwaitStart(arranged);
      const other = await arranged.enlist();

      const answer = await requestToken(other.wire, readSessionToken(start));

      expect(answer).toMatchObject({ reason: "this session is not running on this runner" });
      expect(answer).not.toHaveProperty("token");
    });
  });

  it("is refused for a token no session holds", async () => {
    await withGithubFleet(async (arranged) => {
      const answer = await requestToken(arranged.wire, "not-a-session-token");

      expect(answer).toMatchObject({ reason: "this session is not running on this runner" });
    });
  });

  it("is refused once the session has exited", async () => {
    await withGithubFleet(async (arranged) => {
      await setDefaultConnection(arranged, await connectWithPastedToken(arranged, "ghp_pasted"));
      const sessionId = await spawnThread(arranged);
      const [start] = await waitForStartFrames(arranged, sessionId, 1);
      reportEvent(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId,
        at,
        _tag: "session.exited",
        reason: "stopped",
      });
      await waitForSession(arranged, sessionId, (one) => one.status === "exited");

      const answer = await requestToken(arranged.wire, readSessionToken(start!));

      expect(answer).toMatchObject({ reason: "this session is not running on this runner" });
    });
  });

  it("is refused for a session with no GitHub Connection", async () => {
    await withGithubFleet(async (arranged) => {
      const start = await spawnAndAwaitStart(arranged);

      const answer = await requestToken(arranged.wire, readSessionToken(start));

      expect(answer).toMatchObject({ reason: "this session has no GitHub Connection" });
    });
  });

  it("is refused, naming the Connection, when the Connection was disabled after the session started", async () => {
    await withGithubFleet(async (arranged) => {
      const connectionId = await connectWithPastedToken(arranged, "ghp_pasted");
      await setDefaultConnection(arranged, connectionId);
      const start = await spawnAndAwaitStart(arranged);
      await disableConnection(arranged, connectionId);

      const answer = await requestToken(arranged.wire, readSessionToken(start));

      expect(answer).toMatchObject({
        reason: `the Connection '${LOGIN}' is disabled in Settings → Connections`,
      });
    });
  });

  it("does not hold up the runner's other requests while the token is being refreshed", async () => {
    await withGithubFleet(async (arranged, provider) => {
      let finishRefresh = (): void => {};
      let gate: Promise<void> = Promise.resolve();
      // The token is inside the refresh margin, so a request refreshes it, and
      // that refresh waits for `gate`.
      answerTokens(provider, 5 * MINUTE_SECONDS, { beforeRefresh: () => gate });
      await setDefaultConnection(arranged, await signIn(arranged));
      const start = await spawnAndAwaitStart(arranged);
      gate = new Promise<void>((resolve) => {
        finishRefresh = resolve;
      });

      const slow = requestToken(arranged.wire, readSessionToken(start));
      await waitUntil("asked GitHub to refresh", () =>
        refreshesAsked(provider) > 0 ? true : undefined,
      );
      const quick = await requestToken(arranged.wire, "not-a-session-token");
      finishRefresh();

      expect(quick).toMatchObject({ reason: "this session is not running on this runner" });
      expect(await slow).toMatchObject({ token: REFRESHED_TOKEN });
    });
  });
});
