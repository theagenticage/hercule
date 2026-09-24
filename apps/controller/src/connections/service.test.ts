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
import { PluginConfigsLayer, PluginHostLayer } from "../plugins";
import { masterKeyLayer, SecretLayer, secretsLayer } from "../secrets";
import { ConnectionTypesLayer } from "./runtime";
import { ConnectionService, ConnectionServiceLayer } from "./service";

let homes: Array<string> = [];

afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes = [];
});

/** Builds the real service over the real repositories, a `:memory:` database and a key file. */
const buildStack = () => {
  const home = mkdtempSync(join(tmpdir(), "hercule-connection-service-"));
  homes.push(home);
  return ConnectionServiceLayer.pipe(
    Layer.provideMerge(PluginHostLayer),
    Layer.provideMerge(ConnectionTypesLayer),
    Layer.provideMerge(PluginConfigsLayer),
    Layer.provideMerge(SecretLayer),
    Layer.provideMerge(secretsLayer.pipe(Layer.provide(masterKeyLayer("file")))),
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
});
