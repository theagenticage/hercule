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
import { homePaths, HydraHome } from "../config";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { PluginHostLayer } from "../plugins";
import { masterKeyLayer, SecretLayer, secretsLayer } from "../secrets";
import { ConnectionTypesLayer } from "./runtime";
import { ConnectionService, ConnectionServiceLayer } from "./service";

let homes: Array<string> = [];

afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes = [];
});

/** The real service over the real repositories, a `:memory:` database and a key file. */
const stack = () => {
  const home = mkdtempSync(join(tmpdir(), "hydra-connection-service-"));
  homes.push(home);
  return ConnectionServiceLayer.pipe(
    Layer.provideMerge(PluginHostLayer),
    Layer.provideMerge(ConnectionTypesLayer),
    Layer.provideMerge(SecretLayer),
    Layer.provideMerge(secretsLayer.pipe(Layer.provide(masterKeyLayer("file")))),
    Layer.provideMerge(AuditLogLayer),
    Layer.provideMerge(TestDatabase),
    Layer.provideMerge(Layer.succeed(HydraHome, homePaths(home, join(home, "data")))),
  );
};

describe("the grant check", () => {
  it("runs before anything else, for the in-process caller the transport never gated", async () => {
    const failure = await Effect.runPromise(
      Effect.flatMap(ConnectionService, (connection) => Effect.flip(connection.query({}))).pipe(
        Effect.provide(stack()),
      ),
    );

    expect(failure).toMatchObject({
      error: { code: "forbidden", details: { grant: "connection.read" } },
    });
  });
});
