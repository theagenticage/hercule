/**
 * Tests how a server's access is resolved from the view of the server: for a
 * plugin server, the cases where it cannot be reached and what its
 * credentials do with the failures of the Connection behind them; for a
 * server added by URL, the request it builds and what its credentials say.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ProviderRefused, ProviderUnreachable } from "../oauth";
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
import { CannotRenew, SignInReplaced, type McpServerSignIns } from "./sign-ins";
import { buildMcpServerView, type ViewFacts } from "./testing";

/** What the Connection's runtime does for the one Connection the view names. */
interface FakeConnections {
  readonly readCredentialsForUse?: Effect.Effect<never, unknown>;
  readonly refreshAfterRejection?: Effect.Effect<never, unknown>;
}

/** What the sign-ins of a server added by URL do for the one server the view names. */
interface FakeSignIns {
  readonly token?: string;
  /** What reading the OAuth tokens for use does: the tokens, or the failure of a renewal. */
  readonly oauthForUse?: Effect.Effect<{ readonly accessToken: string }, unknown>;
  /** What renewing the OAuth tokens after the server refused them does. */
  readonly oauthAfterRejection?: Effect.Effect<{ readonly accessToken: string }, unknown>;
  /** The access token of the stored OAuth sign-in, when it holds one. */
  readonly oauthAccessToken?: string;
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
      readVersion: () => Effect.succeed("version"),
      // A guard runs first, as the real sign-ins run it before a refresh.
      readOAuthForUse: (_id: string, guard: Effect.Effect<void, unknown>) =>
        Effect.andThen(guard, signIns.oauthForUse ?? Effect.die("not read")),
      renewOAuthAfterRejection: (
        _id: string,
        isRejected: (accessToken: string) => boolean,
        guard: Effect.Effect<void, unknown>,
      ) =>
        Effect.andThen(
          guard,
          Effect.suspend(() => {
            const renewed = signIns.oauthAfterRejection ?? Effect.die("not read");
            // The identity the caller names must be the one of the stored token.
            return isRejected(signIns.oauthAccessToken ?? "")
              ? renewed
              : Effect.succeed({ accessToken: signIns.oauthAccessToken ?? "" });
          }),
        ),
      readOAuth: () =>
        Effect.succeed(
          signIns.oauthAccessToken === undefined
            ? Option.none()
            : Option.some({ tokens: { accessToken: signIns.oauthAccessToken } }),
        ),
    } as unknown as McpServerSignIns["Service"],
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
    expect(access.credentials).toMatchObject({ credentialsRecordId: "server-1" });
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
});

describe("resolving the access of a server signed in through the browser", () => {
  const oauth = { url: { signIn: "oauth" } } as const;
  const expired = {
    status: "needs-sign-in",
    detail: "desk's sign-in has expired: paste a token or sign in in Settings > MCP servers",
  };

  it("reads the access token as a credential that is marked secret", async () => {
    const access = resolveUsable({}, oauth, {
      oauthForUse: Effect.succeed({ accessToken: "access-1" }),
    });

    const credentials = await Effect.runPromise(access.credentials.readForUse());

    expect(credentials).toMatchObject({
      credentials: { token: "access-1" },
      secretNames: ["token"],
    });
    expect(access.endpoint.buildRequest(credentials).headers).toEqual({
      Authorization: "Bearer access-1",
    });
  });

  it.each([
    [
      "the provider refuses the refresh",
      new ProviderRefused({ message: "provider text" }),
      expired,
    ],
    ["there is no refresh token", new CannotRenew({ message: "no refresh token" }), expired],
    [
      "the token endpoint cannot be reached",
      new ProviderUnreachable({ message: "provider text" }),
      { status: "unreachable", detail: "desk could not be reached to refresh the sign-in" },
    ],
    [
      "the sign-in changed during the refresh",
      new SignInReplaced({ message: "replaced" }),
      {
        status: "unreachable",
        detail: "The sign-in of desk was replaced while it was being refreshed",
      },
    ],
  ])("gives fixed words for a read when %s", async (_name, failure, expected) => {
    const access = resolveUsable({}, oauth, { oauthForUse: Effect.fail(failure) });

    const unavailable = await Effect.runPromise(Effect.flip(access.credentials.readForUse()));

    expect(unavailable).toBeInstanceOf(ServerCredentialsUnavailable);
    expect(unavailable).toMatchObject(expected);
    expect(JSON.stringify(unavailable)).not.toContain("provider text");
  });

  it("passes the caller's guard to a read, and its failure through unchanged", async () => {
    const guardFailure = { _tag: "Superseded" } as const;
    const access = resolveUsable({}, oauth, { oauthForUse: Effect.succeed({ accessToken: "a" }) });

    const failure = await Effect.runPromise(
      Effect.flip(access.credentials.readForUse(Effect.fail(guardFailure))),
    );

    expect(failure).toBe(guardFailure);
  });

  it("renews the token the server refused, and says there is nothing to renew with when it has no refresh token", async () => {
    const access = resolveUsable({}, oauth, {
      oauthAccessToken: "old-token",
      oauthAfterRejection: Effect.succeed({ accessToken: "new-token" }),
    });
    const rejected = (
      await Effect.runPromise(
        resolveUsable({}, oauth, {
          oauthForUse: Effect.succeed({ accessToken: "old-token" }),
        }).credentials.readForUse(),
      )
    ).identity;

    const renewed = await Effect.runPromise(access.credentials.refreshAfterRejection(rejected));
    expect(renewed.credentials).toEqual({ token: "new-token" });

    const stuck = resolveUsable({}, oauth, {
      oauthAccessToken: "old-token",
      oauthAfterRejection: Effect.fail(new CannotRenew({ message: "no refresh token" })),
    });
    expect(
      await Effect.runPromise(Effect.flip(stuck.credentials.refreshAfterRejection(rejected))),
    ).toBeInstanceOf(ServerCredentialsCannotRefresh);
  });

  it("returns the stored token when it is not the one the server refused", async () => {
    const access = resolveUsable({}, oauth, {
      oauthAccessToken: "newer-token",
      oauthAfterRejection: Effect.die("must not renew"),
    });

    const credentials = await Effect.runPromise(
      access.credentials.refreshAfterRejection("another-identity"),
    );

    expect(credentials.credentials).toEqual({ token: "newer-token" });
  });

  it("continues an exchange only with the token the session opened with", async () => {
    const access = resolveUsable({}, oauth, { oauthAccessToken: "access-1" });
    const { identity } = await Effect.runPromise(
      resolveUsable({}, oauth, {
        oauthForUse: Effect.succeed({ accessToken: "access-1" }),
      }).credentials.readForUse(),
    );

    expect(
      (await Effect.runPromise(access.credentials.readWithoutRefresh(identity))).credentials,
    ).toEqual({
      token: "access-1",
    });
    expect(
      await Effect.runPromise(
        Effect.flip(access.credentials.readWithoutRefresh("another-identity")),
      ),
    ).toMatchObject({ status: "error", detail: "The sign-in of desk was replaced" });
    expect(
      await Effect.runPromise(
        Effect.flip(resolveUsable({}, oauth).credentials.readWithoutRefresh(identity)),
      ),
    ).toMatchObject({ detail: "The sign-in of desk was replaced" });
  });

  it("says the server refused its sign-in, and offers the browser sign-in again", () => {
    expect(resolveUsable({}, oauth).credentials.describeRejected(true)).toEqual({
      status: "needs-sign-in",
      detail: "desk refused its sign-in: paste a token or sign in in Settings > MCP servers",
      signInOffered: "oauth",
    });
  });
});
