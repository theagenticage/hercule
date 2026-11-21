/**
 * Tests how a server's access is resolved from the view of the server: for a
 * plugin server, the cases where it cannot be reached and what its
 * credentials do with the failures of the Connection behind them; for a
 * server added by URL, the request it builds and what its credentials say.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import {
  ConnectionCannotRefresh,
  ConnectionCredentialsUnavailable,
  type ConnectionTypes,
} from "../connections";
import {
  resolveServerAccess,
  ServerCredentialsCannotRefresh,
  ServerCredentialsUnavailable,
  type ServerAccess,
  type UsableAccess,
} from "./access";
import { McpServerSignInReplaced, type McpServerSignIns } from "./sign-ins";
import { buildMcpServerView, type ViewFacts } from "./testing";

/** What the Connection's runtime does for the one Connection the view names. */
interface FakeConnections {
  readonly readCredentialsForUse?: Effect.Effect<never, unknown>;
  readonly refreshAfterRejection?: Effect.Effect<never, unknown>;
}

/** What the sign-ins of a server added by URL do for the one server the view names. */
interface FakeSignIns {
  readonly token?: string;
  readonly replaced?: boolean;
}

const resolve = (
  facts: ViewFacts,
  connections: FakeConnections = {},
  signIns: FakeSignIns = {},
): ServerAccess =>
  resolveServerAccess(
    buildMcpServerView(facts),
    {
      // A guard runs first, as the real runtime runs it before a refresh.
      readCredentialsForUse: (_id: string, guard?: Effect.Effect<void, unknown>) =>
        Effect.andThen(
          guard ?? Effect.void,
          connections.readCredentialsForUse ?? Effect.die("not read"),
        ),
      refreshAfterRejection: () => connections.refreshAfterRejection ?? Effect.die("not read"),
      readCredentialsWithoutRefresh: () => Effect.die("not read"),
      readCredentialsVersion: () => Effect.succeed("version"),
    } as unknown as ConnectionTypes["Service"],
    {
      readToken: () => Effect.succeed(signIns.token),
      readTokenWhileRevisionIs: () =>
        signIns.replaced === true
          ? Effect.fail(new McpServerSignInReplaced())
          : Effect.succeed(signIns.token),
      readVersion: () => Effect.succeed("version"),
    } as unknown as McpServerSignIns,
  );

const resolveUsable = (
  connections: FakeConnections,
  facts: ViewFacts = {},
  signIns: FakeSignIns = {},
): UsableAccess => {
  const access = resolve(facts, connections, signIns);
  if (access._tag !== "usable") throw new Error("the view is meant to be usable");
  return access;
};

describe("resolving the access of a plugin server", () => {
  it.each([
    [
      "a plugin that is switched off",
      { plugin: "switched-off" },
      { status: "error", detail: "The Desk plugin is switched off", cause: "plugin" },
    ],
    [
      "a Connection that needs sign-in",
      { connection: "needs-reauth" },
      {
        status: "needs-sign-in",
        detail: "Reconnect work in Settings > Connections",
        cause: "connection",
      },
    ],
    [
      "a Connection of another type than the contribution needs",
      { connectionType: "other/type" },
      {
        status: "error",
        detail: "This server needs a acme/desk Connection, and work is another type",
        cause: null,
      },
    ],
  ] as const)("is unusable for %s, with what the server shows", (_name, facts, expected) => {
    expect(resolve(facts)).toEqual({ _tag: "unusable", ...expected });
  });

  it("is usable with the contribution's origin and name, and the Connection's generation and id", () => {
    const access = resolveUsable({});

    expect(access.endpoint).toMatchObject({ origin: "https://desk.example", displayName: "Desk" });
    expect(access.credentials).toMatchObject({
      generation: 0,
      credentialsRecordId: "connection-1",
    });
    expect(access.credentials.describeRejected(true)).toEqual({
      status: "error",
      detail: "Desk's MCP server refused the Connection's token",
      signInOffered: null,
    });
  });

  it("gives the status and the words of a Connection that needs sign-in when credentials are read", async () => {
    const access = resolveUsable({
      readCredentialsForUse: Effect.fail(
        new ConnectionCredentialsUnavailable({ reason: "needs-sign-in", message: "provider text" }),
      ),
    });

    const failure = await Effect.runPromise(Effect.flip(access.credentials.readForUse()));

    expect(failure).toBeInstanceOf(ServerCredentialsUnavailable);
    expect(failure).toMatchObject({
      status: "needs-sign-in",
      detail: "Reconnect work in Settings > Connections",
      cause: "connection",
    });
    expect(JSON.stringify(failure)).not.toContain("provider text");
  });

  it("passes the caller's guard to the Connection's read, and its failure through unchanged", async () => {
    const guardFailure = { _tag: "Superseded" } as const;
    const access = resolveUsable({});

    const failure = await Effect.runPromise(
      Effect.flip(access.credentials.readForUse(Effect.fail(guardFailure))),
    );

    expect(failure).toBe(guardFailure);
  });

  it("says there is nothing to refresh when the Connection cannot refresh the rejected credentials", async () => {
    const access = resolveUsable({
      refreshAfterRejection: Effect.fail(new ConnectionCannotRefresh({ message: "pasted" })),
    });

    const failure = await Effect.runPromise(
      Effect.flip(access.credentials.refreshAfterRejection("identity-1")),
    );

    expect(failure).toBeInstanceOf(ServerCredentialsCannotRefresh);
  });
});

describe("resolving the access of a server added by URL", () => {
  const url = { url: { signIn: "token" } } as const;

  it("is usable with no plugin or Connection, at the origin of its address and under its own name", () => {
    const access = resolveUsable({}, url);

    expect(access.endpoint).toMatchObject({ origin: "https://desk.example", displayName: "desk" });
    expect(access.credentials).toMatchObject({ generation: 0, credentialsRecordId: "server-1" });
  });

  it("builds the request to the address as it is stored, with its token as a bearer token", () => {
    const access = resolveUsable({}, url);

    expect(
      access.endpoint.buildRequest({
        credentials: { token: "t0ken" },
        secretNames: ["token"],
        config: {},
        identity: "any",
      }),
    ).toEqual({
      url: "https://desk.example/mcp",
      headers: { Authorization: "Bearer t0ken" },
    });
  });

  it("builds a request with no header when the server holds no token", async () => {
    const access = resolveUsable({}, url);

    const credentials = await Effect.runPromise(access.credentials.readForUse());

    expect(credentials).toMatchObject({ credentials: {}, secretNames: ["token"], config: {} });
    expect(access.endpoint.buildRequest(credentials)).toEqual({
      url: "https://desk.example/mcp",
      headers: {},
    });
  });

  it("reads its token as a credential that is marked secret, with an identity that never holds the token", async () => {
    const access = resolveUsable({}, url, { token: "t0ken" });

    const credentials = await Effect.runPromise(access.credentials.readForUse());

    expect(credentials).toMatchObject({ credentials: { token: "t0ken" }, secretNames: ["token"] });
    expect(credentials.identity).toMatch(/^[0-9a-f]{64}$/);
    const other = await Effect.runPromise(
      resolveUsable({}, url, { token: "other" }).credentials.readForUse(),
    );
    expect(other.identity).not.toBe(credentials.identity);
  });

  it("has nothing to refresh after the server refused its token", async () => {
    const access = resolveUsable({}, url, { token: "t0ken" });

    const failure = await Effect.runPromise(
      Effect.flip(access.credentials.refreshAfterRejection("identity-1")),
    );

    expect(failure).toBeInstanceOf(ServerCredentialsCannotRefresh);
  });

  it("says in words the user can act on that the server needs sign-in, whether it holds a token or not", () => {
    expect(
      resolveUsable({}, { url: { signIn: "none" } }).credentials.describeRejected(true),
    ).toEqual({
      status: "needs-sign-in",
      detail: "desk asks for sign-in: paste a token or sign in in Settings > MCP servers",
      signInOffered: "oauth",
    });
    expect(resolveUsable({}, url).credentials.describeRejected(false)).toEqual({
      status: "needs-sign-in",
      detail: "desk refused its sign-in: paste a token or sign in in Settings > MCP servers",
      signInOffered: "token",
    });
  });

  it("refuses to read the sign-in for a request that only continues an exchange once the sign-in was replaced", async () => {
    const access = resolveUsable({}, url, { token: "t0ken", replaced: true });

    const failure = await Effect.runPromise(Effect.flip(access.credentials.readWithoutRefresh));

    expect(failure).toBeInstanceOf(ServerCredentialsUnavailable);
    expect(failure).toMatchObject({
      status: "error",
      detail: "The sign-in of desk was replaced",
    });
  });
});
