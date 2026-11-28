/**
 * Test helpers shared by the connection tests that run the controller over
 * HTTP or call the service directly: the connection record the API returns,
 * and the test plugins that contribute connection types.
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
  readonly feedIntervals: Readonly<Record<string, number>>;
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

/** Reads one connection through the API, and fails the test unless the request succeeds. */
export const readConnection = async (
  base: string,
  token: string,
  id: string,
): Promise<ConnectionRecord> => {
  const response = await get(base, `/api/v1/connections/${id}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ConnectionRecord;
};

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
