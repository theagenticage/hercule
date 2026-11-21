/**
 * Tests how a plugin server's access is resolved from the view of the server:
 * the cases where the server cannot be reached, and what the credentials of a
 * reachable one do with the failures of the Connection behind them.
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
import { buildMcpServerView, type ViewFacts } from "./testing";

/** What the Connection's runtime does for the one Connection the view names. */
interface FakeConnections {
  readonly readCredentialsForUse?: Effect.Effect<never, unknown>;
  readonly refreshAfterRejection?: Effect.Effect<never, unknown>;
}

const resolve = (facts: ViewFacts, connections: FakeConnections = {}): ServerAccess =>
  resolveServerAccess(buildMcpServerView(facts), {
    readCredentialsForUse: () => connections.readCredentialsForUse ?? Effect.die("not read"),
    refreshAfterRejection: () => connections.refreshAfterRejection ?? Effect.die("not read"),
    readCredentialsWithoutRefresh: () => Effect.die("not read"),
    readCredentialsVersion: () => Effect.succeed("version"),
  } as unknown as ConnectionTypes["Service"]);

const resolveUsable = (connections: FakeConnections): UsableAccess => {
  const access = resolve({}, connections);
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
    expect(access.credentials.describeRejected()).toEqual({
      status: "error",
      detail: "Desk's MCP server refused the Connection's token",
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

  it("passes a failure of the caller's guard through unchanged", async () => {
    const guardFailure = { _tag: "Superseded" } as const;
    const access = resolveUsable({ readCredentialsForUse: Effect.fail(guardFailure) });

    const failure = await Effect.runPromise(Effect.flip(access.credentials.readForUse()));

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
