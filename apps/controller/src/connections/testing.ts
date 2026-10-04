/**
 * Test helpers shared by the connection tests that run the controller over
 * HTTP or call the service directly: the connection record the API returns,
 * the test plugins that contribute connection types, and an in-test provider
 * with a device flow.
 */
import { expect } from "vitest";
import type {
  ActivationContext,
  ConnectionsRuntime,
  ExternalAccount,
  Plugin,
} from "@hercule/plugin-host";
import { get } from "../http/testing";

/** A connection as the API returns it. */
export interface ConnectionRecord {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly displayName: string;
  readonly status: string;
  readonly statusDetail?: string;
  readonly labels: ReadonlyArray<string>;
  readonly config: Record<string, unknown>;
  readonly credentials: ReadonlyArray<{ readonly name: string; readonly rotatedAt?: string }>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A plugin and the activation contexts the host passed to it. */
export interface TestPlugin {
  readonly plugin: Plugin;
  readonly contexts: Array<ActivationContext>;
}

/**
 * Builds the display name a test type's `validate` returns for a token: the
 * token reversed. The name still shows which token was checked, but it never
 * contains the token, so a test can search a whole response body for the
 * token and fail on any leak.
 */
export const buildAccountName = (token: string): string => `acct:${[...token].reverse().join("")}`;

/** The account id of every test token that names no account of its own. */
const DEFAULT_ACCOUNT_ID = "account-1";

/**
 * Builds the account a test type's `validate` returns for a token. The name
 * comes from `buildAccountName`. The id is the text after `@` in the token, or
 * `DEFAULT_ACCOUNT_ID` when the token has no `@`. So tokens without `@` all
 * belong to one account under different names, as after a rename, and a test
 * signs in to another account with a token such as `good-1@account-2`.
 */
export const buildAccount = (token: string): ExternalAccount => ({
  displayName: buildAccountName(token),
  accountId: token.split("@")[1] ?? DEFAULT_ACCOUNT_ID,
});

/** Builds a JSON response, as a provider's OAuth endpoints send. */
export const buildJsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Lists the connections through the API, and fails the test unless the request succeeds. */
export const listConnections = async (
  base: string,
  token: string,
): Promise<ReadonlyArray<ConnectionRecord>> => {
  const response = await get(base, "/api/v1/connections", token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<ConnectionRecord> }).items;
};

/**
 * Returns the `ConnectionsRuntime` the host passed to a plugin at its last
 * activation. Throws when the plugin was never activated, or was activated
 * without one.
 */
export const readConnectionsSurface = (stub: TestPlugin): ConnectionsRuntime => {
  const ctx = stub.contexts.at(-1);
  if (ctx === undefined) throw new Error("the plugin was never activated");
  if (ctx.connections === undefined) throw new Error("the plugin was given no connections surface");
  return ctx.connections;
};

/** The provider's device code, which only the controller sends back. */
export const DEVICE_CODE = "the-device-code";

/** A response to the token endpoint, which a test may make wait. */
export type TokenAnswer = () => Response | Promise<Response>;

/** An in-test provider that runs the provider's side of a device flow (RFC 8628). */
export interface DeviceProvider {
  /** The origin the type's `deviceCodeUrl` and `tokenUrl` are built from. */
  readonly base: string;
  /** Every form body posted to the device code endpoint, in order. */
  readonly codeRequests: ReadonlyArray<Record<string, string>>;
  /** Every form body posted to the token endpoint, in order. */
  readonly tokenRequests: ReadonlyArray<Record<string, string>>;
  /** The next responses of the two endpoints, which a test can replace. */
  readonly answers: { code: () => Response; token: TokenAnswer };
  readonly stop: () => Promise<void>;
}

/**
 * Starts a provider with a device code endpoint and a token endpoint. By
 * default the device code endpoint issues a code with a five-second interval,
 * and the token endpoint answers that the user has not approved yet.
 */
export const createDeviceProvider = (): DeviceProvider => {
  const codeRequests: Array<Record<string, string>> = [];
  const tokenRequests: Array<Record<string, string>> = [];
  const answers: DeviceProvider["answers"] = {
    code: () =>
      buildJsonResponse({
        device_code: DEVICE_CODE,
        user_code: "WDJB-MJHT",
        verification_uri: "https://provider.test/device",
        expires_in: 900,
        interval: 5,
      }),
    token: () => buildJsonResponse({ error: "authorization_pending" }),
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url);
      const form = Object.fromEntries(new URLSearchParams(await request.text()));
      if (url.pathname === "/device/code") {
        codeRequests.push(form);
        return answers.code();
      }
      if (url.pathname === "/token") {
        tokenRequests.push(form);
        return answers.token();
      }
      return new Response("not here", { status: 404 });
    },
  });

  let stopped = false;
  return {
    base: `http://127.0.0.1:${server.port}`,
    codeRequests,
    tokenRequests,
    answers,
    // A test may stop the provider to simulate an unreachable one, and the
    // harness stops it again afterwards, so a second call does nothing.
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await server.stop(true);
    },
  };
};
