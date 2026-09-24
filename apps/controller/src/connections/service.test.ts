/**
 * The grant check the connection service runs inside its own methods.
 *
 * The transport gates a request before the payload is decoded, but an
 * in-process caller never passes it, so the check is asserted where it is
 * enforced: the real service over a real database, with nobody provided as the
 * current actor.
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

/** The real service over the real repositories, a `:memory:` database and a key file. */
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
  it("runs before anything else, for the in-process caller the transport never gated", async () => {
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
