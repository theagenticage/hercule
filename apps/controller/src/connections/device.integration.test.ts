/**
 * Tests the core's device flow (RFC 8628) end to end, through the HTTP API:
 *
 * - the start, which asks the provider for a device code;
 * - the poll, which asks the provider whether the user has approved, and
 *   writes the connection when the user has.
 *
 * The provider is an in-test `Bun.serve`, as in the redirect-flow tests,
 * because these tests are about what the controller sends to the provider and
 * how it reads each answer. The answers mimic GitHub, which returns its errors
 * with status 200.
 *
 * These tests take two steps outside the API:
 *
 * - A poll before the provider's interval has passed never reaches the
 *   provider. A test cannot wait out the interval, so `allowPoll` moves the
 *   setup's next poll time into the past.
 * - No operation removes a connection's last credential, so the tests of a
 *   connection that holds none delete its secrets in the database.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  ConnectionValidationFailed,
  HOST_API,
  registerConnectionType,
  type ActivationContext,
  type Plugin,
} from "@hercule/plugin-host";
import { completeSetup, del, post, withServer, type ServerHarness } from "../http/testing";
import {
  buildAccount,
  buildAccountName,
  buildJsonResponse,
  createDeviceProvider,
  DEVICE_CODE,
  listConnections,
  readConnectionsSurface,
  type ConnectionRecord,
  type DeviceProvider,
  type TestPlugin,
} from "./testing";

/** The start's response body. */
interface DeviceStart {
  readonly setupId: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: string;
  readonly interval: number;
}

/** The client id the test type declares. A device flow sends no client secret. */
const CLIENT_ID = "device-client-1";

/** The type accepts access tokens that start with `good-` and rejects the others. */
const GOOD_TOKEN = "good-device";

/** The message the type's `validate` fails with when it rejects an account. */
const REJECTED = "that account is not one this type can act as";

/** The qualified name of the test type. */
const DEVICE_TYPE = "devicey/device-type";

/**
 * Builds a plugin that owns one connection type. The device type offers a
 * device flow and, like the GitHub type, a pasted `pat` as well, so a test can
 * reconnect a pasted connection through the device flow. The pasted type has
 * no device flow.
 */
const buildConnectionTypePlugin = (options: {
  readonly id: string;
  readonly type: string;
  readonly device?: DeviceProvider;
}): TestPlugin => {
  const contexts: Array<ActivationContext> = [];
  const provider = options.device;
  const plugin: Plugin = {
    manifest: {
      id: options.id,
      displayName: `Plugin ${options.id}`,
      hostApi: HOST_API,
      capabilities: ["connections"],
      configSchema: Schema.Struct({}),
    },
    register: (host) =>
      registerConnectionType(host, {
        type: options.type,
        displayName: `Type ${options.type}`,
        setup:
          provider === undefined
            ? [{ kind: "credentials", fields: [{ name: "pat", label: "Token" }] }]
            : [
                { kind: "device" },
                { kind: "credentials", fields: [{ name: "pat", label: "Token" }] },
              ],
        ...(provider === undefined
          ? {}
          : {
              device: {
                clientId: CLIENT_ID,
                deviceCodeUrl: `${provider.base}/device/code`,
                tokenUrl: `${provider.base}/token`,
                scopes: ["repo", "read:org"],
              },
            }),
        validate: (credentials: Record<string, string>) => {
          const value = credentials["pat"] ?? credentials["accessToken"] ?? "";
          return value.startsWith("good-")
            ? Effect.succeed(buildAccount(value))
            : Effect.fail(new ConnectionValidationFailed({ message: REJECTED }));
        },
      }),
    activate: (ctx) =>
      Effect.sync(() => {
        contexts.push(ctx);
        return Effect.void;
      }),
  };
  return { plugin, contexts };
};

/** Builds new plugins for each test, so no activation context outlives its test. */
const buildPlugins = (provider: DeviceProvider) => ({
  device: buildConnectionTypePlugin({ id: "devicey", type: "device-type", device: provider }),
  pasted: buildConnectionTypePlugin({ id: "pasted", type: "pasted-type" }),
});

type Registry = ReturnType<typeof buildPlugins>;

const withDevice = async (
  body: (
    harness: ServerHarness,
    registry: Registry,
    token: string,
    provider: DeviceProvider,
  ) => Promise<void>,
): Promise<void> => {
  const provider = createDeviceProvider();
  const registry = buildPlugins(provider);
  try {
    await withServer(
      async (harness) => {
        const token = await completeSetup(harness.base);
        await body(harness, registry, token, provider);
      },
      { plugins: Object.values(registry).map((one) => one.plugin) },
    );
  } finally {
    await provider.stop();
  }
};

const startDeviceFlow = (
  base: string,
  token: string,
  body: Record<string, unknown> = {},
): Promise<Response> =>
  post(base, "/api/v1/oauth/device/start", { type: DEVICE_TYPE, ...body }, token);

/** Starts a device flow and returns the start's response body. */
const startDeviceOrFail = async (
  base: string,
  token: string,
  body: Record<string, unknown> = {},
): Promise<DeviceStart> => {
  const response = await startDeviceFlow(base, token, body);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as DeviceStart;
};

/** Polls a device flow and returns the poll's response body. */
const pollDeviceFlow = async (
  base: string,
  token: string,
  setupId: string,
): Promise<Record<string, unknown>> => {
  const response = await post(base, "/api/v1/oauth/device/poll", { setupId }, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Record<string, unknown>;
};

/** Moves a setup's next poll time into the past, so the next poll asks the provider. */
const allowPoll = (sql: SqlClient.SqlClient, setupId: string): Promise<void> =>
  Effect.runPromise(
    Effect.asVoid(
      Effect.orDie(
        sql`UPDATE device_setups SET next_poll_at = '2020-01-01T00:00:00.000Z'
            WHERE setup_id = ${setupId}`,
      ),
    ),
  );

/** Makes the token endpoint issue a token, as it does once the user approves. */
const approve = (provider: DeviceProvider, accessToken = GOOD_TOKEN): void => {
  provider.answers.token = () =>
    buildJsonResponse({ access_token: accessToken, token_type: "bearer", scope: "repo" });
};

describe("POST /oauth/device/start", () => {
  it("asks the provider for a device code, returns the user's code, and creates no connection", async () => {
    await withDevice(async ({ base }, _registry, token, provider) => {
      const started = await startDeviceOrFail(base, token);

      expect(started).toMatchObject({
        userCode: "WDJB-MJHT",
        verificationUri: "https://provider.test/device",
        interval: 5,
      });
      expect(Date.parse(started.expiresAt) - Date.now()).toBeGreaterThan(890_000);
      // The client id and the scopes, and no client secret: a device flow has
      // none.
      expect(provider.codeRequests).toEqual([{ client_id: CLIENT_ID, scope: "repo read:org" }]);
      // The provider's device code stays on the controller.
      expect(JSON.stringify(started)).not.toContain(DEVICE_CODE);
      expect(await listConnections(base, token)).toEqual([]);
    });
  });

  it("rejects a type that has no device flow", async () => {
    await withDevice(async ({ base }, _registry, token, provider) => {
      const response = await startDeviceFlow(base, token, { type: "pasted/pasted-type" });

      expect(response.status).toBe(400);
      const { error } = (await response.json()) as { error: { message: string } };
      // The refusal names the operation that does set up this type.
      expect(error.message).toBe(
        "the type pasted/pasted-type has no device flow, because its setup has no device step: " +
          "set it up with connection.create instead",
      );
      expect(provider.codeRequests).toEqual([]);
    });
  });

  it("refuses a reconnect given a label, topics or config, before it asks the provider", async () => {
    await withDevice(async ({ base, sql }, _registry, token, provider) => {
      const created = await post(
        base,
        "/api/v1/connections",
        { type: DEVICE_TYPE, credentials: { pat: "good-pasted" } },
        token,
      );
      expect(created.status, await created.clone().text()).toBe(201);
      const { id } = (await created.json()) as ConnectionRecord;

      const response = await startDeviceFlow(base, token, {
        connectionId: id,
        label: "renamed",
        labels: ["Inbox"],
        config: {},
      });

      expect(response.status).toBe(400);
      const { error } = (await response.json()) as {
        error: {
          code: string;
          message: string;
          details: { issues: ReadonlyArray<{ path: ReadonlyArray<string> }> };
        };
      };
      expect(error.code).toBe("validation");
      expect(error.message).toContain("connection.update");
      expect(error.details.issues.map((issue) => issue.path)).toEqual([
        ["label"],
        ["labels"],
        ["config"],
      ]);
      expect(provider.codeRequests).toEqual([]);
      const rows = await Effect.runPromise(Effect.orDie(sql`SELECT setup_id FROM device_setups`));
      expect(rows).toEqual([]);
    });
  });

  it("fails with invalid_state, and points to a pasted token, when device flow is turned off", async () => {
    await withDevice(async ({ base }, _registry, token, provider) => {
      provider.answers.code = () => buildJsonResponse({ error: "device_flow_disabled" });

      const response = await startDeviceFlow(base, token);

      expect(response.status).toBe(409);
      const { error } = (await response.json()) as { error: { code: string; message: string } };
      expect(error.code).toBe("invalid_state");
      expect(error.message).toContain("device flow is turned off");
      expect(error.message).toContain("paste a token instead");
    });
  });

  it("fails with invalid_state, naming the provider's error, when the provider refuses for another reason", async () => {
    await withDevice(async ({ base }, _registry, token, provider) => {
      provider.answers.code = () => buildJsonResponse({ error: "unauthorized_client" }, 400);

      const response = await startDeviceFlow(base, token);

      expect(response.status).toBe(409);
      const { error } = (await response.json()) as { error: { code: string; message: string } };
      expect(error.message).toContain("unauthorized_client");
    });
  });

  it("caps the flow's lifetime at 30 minutes", async () => {
    await withDevice(async ({ base }, _registry, token, provider) => {
      provider.answers.code = () =>
        buildJsonResponse({
          device_code: DEVICE_CODE,
          user_code: "WDJB-MJHT",
          verification_uri: "https://provider.test/device",
          expires_in: 365 * 24 * 60 * 60,
          interval: 600,
        });

      const before = Date.now();
      const started = await startDeviceOrFail(base, token);

      // The interval is the provider's own: polling sooner is not allowed.
      expect(started.interval).toBe(600);
      const lifetime = Date.parse(started.expiresAt) - before;
      expect(lifetime).toBeGreaterThan(29 * 60 * 1000);
      expect(lifetime).toBeLessThanOrEqual(30 * 60 * 1000 + 1000);
    });
  });

  it("fails with invalid_state when the first poll would come after the code expires", async () => {
    await withDevice(async ({ base }, _registry, token, provider) => {
      provider.answers.code = () =>
        buildJsonResponse({
          device_code: DEVICE_CODE,
          user_code: "WDJB-MJHT",
          verification_uri: "https://provider.test/device",
          expires_in: 365 * 24 * 60 * 60,
          interval: 3600,
        });

      const response = await startDeviceFlow(base, token);

      expect(response.status).toBe(409);
      const { error } = (await response.json()) as { error: { code: string; message: string } };
      expect(error.code).toBe("invalid_state");
      expect(error.message).toContain("wait 3600 seconds");
    });
  });

  it("fails with invalid_state when the provider is rate limiting requests", async () => {
    await withDevice(async ({ base }, _registry, token, provider) => {
      provider.answers.code = () => buildJsonResponse({ message: "API rate limit exceeded" }, 429);

      const response = await startDeviceFlow(base, token);

      expect(response.status).toBe(409);
      const { error } = (await response.json()) as { error: { code: string; message: string } };
      expect(error.code).toBe("invalid_state");
      expect(error.message).toContain("rate limiting");
    });
  });

  it("fails with invalid_state when the provider cannot be reached", async () => {
    await withDevice(async ({ base }, _registry, token, provider) => {
      await provider.stop();

      const response = await startDeviceFlow(base, token);

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_state" } });
    });
  });
});

describe("POST /oauth/device/poll", () => {
  it("answers pending without asking the provider when the interval has not passed", async () => {
    await withDevice(async ({ base }, _registry, token, provider) => {
      const { setupId } = await startDeviceOrFail(base, token);

      expect(await pollDeviceFlow(base, token, setupId)).toEqual({
        status: "pending",
        interval: 5,
      });
      expect(provider.tokenRequests).toEqual([]);
    });
  });

  it("answers pending while the user has not approved, with a standard device token request", async () => {
    await withDevice(async ({ base, sql }, _registry, token, provider) => {
      const { setupId } = await startDeviceOrFail(base, token);
      await allowPoll(sql, setupId);

      expect(await pollDeviceFlow(base, token, setupId)).toEqual({
        status: "pending",
        interval: 5,
      });
      expect(provider.tokenRequests).toEqual([
        {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: DEVICE_CODE,
          client_id: CLIENT_ID,
        },
      ]);
      // The claim pushed the next poll back by one interval.
      expect(await pollDeviceFlow(base, token, setupId)).toEqual({
        status: "pending",
        interval: 5,
      });
      expect(provider.tokenRequests).toHaveLength(1);
    });
  });

  it("stores the longer interval the provider asks for, and waits it out", async () => {
    await withDevice(async ({ base, sql }, _registry, token, provider) => {
      const { setupId } = await startDeviceOrFail(base, token);
      await allowPoll(sql, setupId);
      provider.answers.token = () => buildJsonResponse({ error: "slow_down", interval: 10 });

      expect(await pollDeviceFlow(base, token, setupId)).toEqual({
        status: "slow-down",
        interval: 10,
      });
      // The next poll comes too early for the new interval, and is answered
      // from the stored one without asking the provider.
      expect(await pollDeviceFlow(base, token, setupId)).toEqual({
        status: "pending",
        interval: 10,
      });
      expect(provider.tokenRequests).toHaveLength(1);
    });
  });

  it("adds at least five seconds, even when the provider names a shorter interval", async () => {
    await withDevice(async ({ base, sql }, _registry, token, provider) => {
      const { setupId } = await startDeviceOrFail(base, token);
      await allowPoll(sql, setupId);
      provider.answers.token = () => buildJsonResponse({ error: "slow_down", interval: 6 });

      expect(await pollDeviceFlow(base, token, setupId)).toEqual({
        status: "slow-down",
        interval: 10,
      });
    });
  });

  it("ends the flow as failed when the longer interval would outlast the code", async () => {
    await withDevice(async ({ base, sql }, _registry, token, provider) => {
      const { setupId } = await startDeviceOrFail(base, token);
      await allowPoll(sql, setupId);
      provider.answers.token = () => buildJsonResponse({ error: "slow_down", interval: 3600 });

      const ended = await pollDeviceFlow(base, token, setupId);
      expect(ended.status).toBe("failed");
      expect(ended["message"]).toContain("wait 3600 seconds");
      // The flow ended, so the next poll finds no setup.
      expect(await pollDeviceFlow(base, token, setupId)).toMatchObject({ status: "expired" });
      expect(provider.tokenRequests).toHaveLength(1);
    });
  });

  it("adds five seconds to the interval when the provider asks to slow down without naming one", async () => {
    await withDevice(async ({ base, sql }, _registry, token, provider) => {
      const { setupId } = await startDeviceOrFail(base, token);
      await allowPoll(sql, setupId);
      provider.answers.token = () => buildJsonResponse({ error: "slow_down" });

      expect(await pollDeviceFlow(base, token, setupId)).toEqual({
        status: "slow-down",
        interval: 10,
      });
    });
  });

  it.each([
    ["expired_token", "expired"],
    ["access_denied", "denied"],
    ["unsupported_grant_type", "failed"],
  ])(
    "ends the flow when the provider answers %s, and answers %s",
    async (providerError, status) => {
      await withDevice(async ({ base, sql }, _registry, token, provider) => {
        const { setupId } = await startDeviceOrFail(base, token);
        await allowPoll(sql, setupId);
        provider.answers.token = () => buildJsonResponse({ error: providerError });

        const answer = await pollDeviceFlow(base, token, setupId);

        expect(answer).toMatchObject({ status });
        expect(typeof answer["message"]).toBe("string");
        // The flow has ended, so polling again answers expired without asking
        // the provider.
        await allowPoll(sql, setupId);
        expect(await pollDeviceFlow(base, token, setupId)).toMatchObject({ status: "expired" });
        expect(provider.tokenRequests).toHaveLength(1);
        expect(await listConnections(base, token)).toEqual([]);
      });
    },
  );

  it("ends the flow and points to a pasted token when device flow has been turned off", async () => {
    await withDevice(async ({ base, sql }, _registry, token, provider) => {
      const { setupId } = await startDeviceOrFail(base, token);
      await allowPoll(sql, setupId);
      provider.answers.token = () => buildJsonResponse({ error: "device_flow_disabled" });

      const answer = await pollDeviceFlow(base, token, setupId);

      expect(answer).toMatchObject({ status: "failed" });
      expect(answer["message"]).toContain("paste a token instead");
    });
  });

  it.each([403, 429])(
    "answers unreachable and keeps the flow open when the provider answers HTTP %i with no OAuth error",
    async (status) => {
      await withDevice(async ({ base, sql }, _registry, token, provider) => {
        const { setupId } = await startDeviceOrFail(base, token);
        await allowPoll(sql, setupId);
        // GitHub's rate limit answer: a JSON body with a message, but no
        // OAuth error code.
        provider.answers.token = () =>
          buildJsonResponse({ message: "API rate limit exceeded" }, status);

        expect(await pollDeviceFlow(base, token, setupId)).toEqual({
          status: "unreachable",
          interval: 5,
        });
        // A rate limit says nothing about the approval, so a later poll may
        // still collect the token.
        await allowPoll(sql, setupId);
        approve(provider);
        expect(await pollDeviceFlow(base, token, setupId)).toMatchObject({ status: "done" });
      });
    },
  );

  it("answers unreachable and keeps the flow open when the provider cannot be reached", async () => {
    await withDevice(async ({ base, sql }, _registry, token, provider) => {
      const { setupId } = await startDeviceOrFail(base, token);
      await allowPoll(sql, setupId);
      await provider.stop();

      expect(await pollDeviceFlow(base, token, setupId)).toEqual({
        status: "unreachable",
        interval: 5,
      });
      // A failure to reach the provider is not an answer from it, so the
      // flow is still open and a later poll may succeed.
      const rows = await Effect.runPromise(
        Effect.orDie(sql`SELECT setup_id FROM device_setups WHERE setup_id = ${setupId}`),
      );
      expect(rows).toHaveLength(1);
    });
  });

  it("answers expired for a flow that does not exist, or whose code has expired", async () => {
    await withDevice(async ({ base, sql }, _registry, token, provider) => {
      const { setupId } = await startDeviceOrFail(base, token);
      await Effect.runPromise(
        Effect.orDie(
          sql`UPDATE device_setups SET expires_at = '2020-01-01T00:00:00.000Z'
              WHERE setup_id = ${setupId}`,
        ),
      );

      expect(await pollDeviceFlow(base, token, "no-such-setup")).toMatchObject({
        status: "expired",
      });
      expect(await pollDeviceFlow(base, token, setupId)).toMatchObject({ status: "expired" });
      expect(provider.tokenRequests).toEqual([]);
    });
  });

  it("creates the connection the start described once the user approves", async () => {
    await withDevice(async ({ base, sql }, registry, token, provider) => {
      const { setupId } = await startDeviceOrFail(base, token, {
        label: "work",
        labels: ["Code"],
      });
      await allowPoll(sql, setupId);
      approve(provider);

      const answer = await pollDeviceFlow(base, token, setupId);

      expect(answer).toMatchObject({
        status: "done",
        connection: {
          type: DEVICE_TYPE,
          label: "work",
          labels: ["Code"],
          displayName: buildAccountName(GOOD_TOKEN),
          status: "connected",
          credentials: [{ name: "oauth.tokens" }],
        },
      });
      // The answer names the credential, never its value.
      expect(JSON.stringify(answer)).not.toContain(GOOD_TOKEN);
      const [one] = await listConnections(base, token);
      if (one === undefined) throw new Error("the poll created no connection");
      // A token with no expiry and no refresh token is used as it is.
      expect(
        await Effect.runPromise(readConnectionsSurface(registry.device).credentials(one.id)),
      ).toEqual({ accessToken: GOOD_TOKEN });
    });
  });

  it("names a connection the start gave no label after its account, and gives it no topic", async () => {
    await withDevice(async ({ base, sql }, _registry, token, provider) => {
      const { setupId } = await startDeviceOrFail(base, token);
      await allowPoll(sql, setupId);
      approve(provider);

      expect(await pollDeviceFlow(base, token, setupId)).toMatchObject({
        status: "done",
        connection: {
          label: buildAccountName(GOOD_TOKEN),
          displayName: buildAccountName(GOOD_TOKEN),
          labels: [],
          config: {},
        },
      });
    });
  });

  it("reconnects the connection the start named, keeps its id, label and topics, takes the new name of the same account, and drops its pasted token", async () => {
    await withDevice(async ({ base, sql }, registry, token, provider) => {
      const created = await post(
        base,
        "/api/v1/connections",
        {
          type: DEVICE_TYPE,
          label: "work",
          labels: ["Code"],
          credentials: { pat: "good-pasted" },
        },
        token,
      );
      expect(created.status, await created.clone().text()).toBe(201);
      const before = (await created.json()) as ConnectionRecord;

      const { setupId } = await startDeviceOrFail(base, token, { connectionId: before.id });
      await allowPoll(sql, setupId);
      approve(provider);
      const answer = await pollDeviceFlow(base, token, setupId);

      expect(answer).toMatchObject({
        status: "done",
        connection: {
          id: before.id,
          label: "work",
          labels: ["Code"],
          displayName: buildAccountName(GOOD_TOKEN),
          credentials: [{ name: "oauth.tokens" }],
        },
      });
      expect(await listConnections(base, token)).toHaveLength(1);
      // Had the pasted token stayed, it would sit beside the new token, unused
      // but still stored.
      expect(
        await Effect.runPromise(readConnectionsSurface(registry.device).credentials(before.id)),
      ).toEqual({ accessToken: GOOD_TOKEN });
    });
  });

  it("answers expired, and creates nothing, when the connection it reconnects was deleted meanwhile", async () => {
    await withDevice(async ({ base, sql }, _registry, token, provider) => {
      const created = await post(
        base,
        "/api/v1/connections",
        { type: DEVICE_TYPE, label: "work", labels: ["Code"], credentials: { pat: "good-pasted" } },
        token,
      );
      expect(created.status, await created.clone().text()).toBe(201);
      const { id } = (await created.json()) as ConnectionRecord;
      const { setupId } = await startDeviceOrFail(base, token, { connectionId: id });
      const deleted = await del(base, `/api/v1/connections/${id}`, token);
      expect(deleted.status, await deleted.clone().text()).toBe(200);

      await allowPoll(sql, setupId);
      approve(provider);

      expect(await pollDeviceFlow(base, token, setupId)).toEqual({
        status: "expired",
        message: "the connection this flow was reconnecting has been deleted",
      });
      // The flow does not bring the deleted connection back as a new one.
      expect(await listConnections(base, token)).toEqual([]);
    });
  });

  it("answers failed for a reconnect that signs in to another account, names both accounts, and leaves the connection unchanged", async () => {
    await withDevice(async ({ base, sql }, registry, token, provider) => {
      const created = await startDeviceOrFail(base, token);
      await allowPoll(sql, created.setupId);
      approve(provider);
      const before = (await pollDeviceFlow(base, token, created.setupId))[
        "connection"
      ] as ConnectionRecord;
      const surface = readConnectionsSurface(registry.device);
      await Effect.runPromise(surface.report(before.id, { status: "needs-reauth" }));
      // A token the type accepts, for another account than the first sign-in.
      const otherAccountToken = "good-other@account-2";

      const reconnect = await startDeviceOrFail(base, token, { connectionId: before.id });
      await allowPoll(sql, reconnect.setupId);
      approve(provider, otherAccountToken);
      const answer = await pollDeviceFlow(base, token, reconnect.setupId);

      expect(answer).toEqual({
        status: "failed",
        message:
          `the account ${buildAccountName(otherAccountToken)} is not the account this ` +
          `connection belongs to (last signed in as ${buildAccountName(GOOD_TOKEN)}). A ` +
          "reconnect must stay with the same account, because the connection's triggers and " +
          "resources are tied to it. Reconnect with that account, or create a new connection " +
          `for ${buildAccountName(otherAccountToken)}`,
      });
      expect(await listConnections(base, token)).toEqual([
        expect.objectContaining({
          id: before.id,
          status: "needs-reauth",
          displayName: buildAccountName(GOOD_TOKEN),
        }),
      ]);
      expect(await Effect.runPromise(surface.credentials(before.id))).toEqual({
        accessToken: GOOD_TOKEN,
      });
    });
  });

  it("writes the connection once when two polls collect the same approval", async () => {
    await withDevice(async ({ base, sql }, _registry, token, provider) => {
      const { setupId } = await startDeviceOrFail(base, token);
      // Both token requests wait until the test releases them, so both polls
      // are past their claim before either one ends the flow.
      let release = (): void => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      provider.answers.token = async () => {
        await released;
        return buildJsonResponse({ access_token: GOOD_TOKEN, token_type: "bearer" });
      };

      await allowPoll(sql, setupId);
      const first = pollDeviceFlow(base, token, setupId);
      await waitFor(() => provider.tokenRequests.length === 1);
      // The first claim pushed the next poll back, so the second poll could
      // not reach the provider without this.
      await allowPoll(sql, setupId);
      const second = pollDeviceFlow(base, token, setupId);
      await waitFor(() => provider.tokenRequests.length === 2);
      release();

      const statuses = (await Promise.all([first, second])).map((answer) => answer["status"]);
      expect(statuses.toSorted()).toEqual(["done", "expired"]);
      expect(await listConnections(base, token)).toHaveLength(1);
    });
  });
});

describe("ConnectionsRuntime.credentials", () => {
  /** Creates a connection with a pasted token, then deletes its secrets behind the API's back. */
  const createConnectionWithoutSecrets = async (
    base: string,
    sql: SqlClient.SqlClient,
    token: string,
    type: string,
  ): Promise<string> => {
    const created = await post(
      base,
      "/api/v1/connections",
      { type, label: "work", labels: ["Code"], credentials: { pat: "good-pasted" } },
      token,
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const { id } = (await created.json()) as ConnectionRecord;
    await Effect.runPromise(
      Effect.orDie(sql`DELETE FROM secrets WHERE owner_kind = 'connection' AND owner_id = ${id}`),
    );
    return id;
  };

  it("marks a connection that holds no credentials needs-reauth when its type can sign in again", async () => {
    await withDevice(async ({ base, sql }, registry, token) => {
      const id = await createConnectionWithoutSecrets(base, sql, token, DEVICE_TYPE);

      const read = await Effect.runPromise(
        Effect.flip(readConnectionsSurface(registry.device).credentials(id)),
      );

      expect(read.message).toBe(`the connection ${id} holds no credentials`);
      expect(await listConnections(base, token)).toMatchObject([
        { id, status: "needs-reauth", statusDetail: `the connection ${id} holds no credentials` },
      ]);
    });
  });

  it("leaves a connection that holds no credentials alone when its type has no sign-in flow", async () => {
    await withDevice(async ({ base, sql }, registry, token) => {
      const id = await createConnectionWithoutSecrets(base, sql, token, "pasted/pasted-type");

      const read = await Effect.runPromise(
        Effect.flip(readConnectionsSurface(registry.pasted).credentials(id)),
      );

      expect(read.message).toBe(`the connection ${id} holds no credentials`);
      // No flow could sign this type in again, so its status stays as it is.
      expect(await listConnections(base, token)).toMatchObject([{ id, status: "connected" }]);
    });
  });
});

/** Waits until a condition holds, checking every few milliseconds, for at most two seconds. */
const waitFor = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("the condition never held");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
