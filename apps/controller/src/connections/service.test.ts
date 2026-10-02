/**
 * Tests the grant check the connection service runs inside its own methods.
 *
 * The HTTP transport checks the grant before it decodes the payload, but an
 * in-process caller never goes through the transport. So the test calls the
 * real service over a real database directly, with no current actor provided.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { buildHomePaths, HerculeHome } from "../config";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { NotifierLayer } from "../notifications";
import { PluginConfigsLayer, PluginHostLayer } from "../plugins";
import { masterKeyLayer, SecretLayer, secretsLayer } from "../secrets";
import { ConnectionReferences } from "./references";
import { ConnectionTypesLayer } from "./runtime";
import { ConnectionService, ConnectionServiceLayer } from "./service";

let homes: Array<string> = [];

afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes = [];
});

/**
 * Builds the real service over the real repositories, a `:memory:` database and
 * a key file. This test builds no other domain, so no record names a
 * Connection.
 */
const buildStack = () => {
  const home = mkdtempSync(join(tmpdir(), "hercule-connection-service-"));
  homes.push(home);
  return ConnectionServiceLayer.pipe(
    Layer.provide(Layer.succeed(ConnectionReferences)({ list: () => Effect.succeed([]) })),
    Layer.provideMerge(PluginHostLayer),
    Layer.provideMerge(ConnectionTypesLayer),
    Layer.provideMerge(PluginConfigsLayer),
    Layer.provideMerge(SecretLayer),
    Layer.provideMerge(secretsLayer.pipe(Layer.provide(masterKeyLayer("file")))),
    Layer.provideMerge(NotifierLayer),
    Layer.provideMerge(AuditLogLayer),
    Layer.provideMerge(TestDatabase),
    Layer.provideMerge(Layer.succeed(HerculeHome, buildHomePaths(home, join(home, "data")))),
  );
};

describe("the grant check", () => {
  it("runs first, for an in-process caller that never went through the HTTP transport", async () => {
    const failure = await Effect.runPromise(
      Effect.flatMap(ConnectionService, (connection) => Effect.flip(connection.query({}))).pipe(
        Effect.provide(buildStack()),
      ),
    );

    expect(failure).toMatchObject({
      error: { code: "forbidden", details: { grant: "connection.read" } },
    });
  });

  // Each device-flow method checks the grant before it decodes its input or
  // calls the provider, so even input that would fail to decode is refused
  // as forbidden.
  it("refuses to start a device flow", async () => {
    const failure = await Effect.runPromise(
      Effect.flatMap(ConnectionService, (connection) =>
        Effect.flip(connection.startDevice({ type: "no/such-type" })),
      ).pipe(Effect.provide(buildStack())),
    );

    expect(failure).toMatchObject({
      error: { code: "forbidden", details: { grant: "connection.manage" } },
    });
  });

  it("refuses to poll a device flow", async () => {
    const failure = await Effect.runPromise(
      Effect.flatMap(ConnectionService, (connection) =>
        Effect.flip(connection.pollDevice({ setupId: "no-such-setup" })),
      ).pipe(Effect.provide(buildStack())),
    );

    expect(failure).toMatchObject({
      error: { code: "forbidden", details: { grant: "connection.manage" } },
    });
  });
});
