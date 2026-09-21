import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { VERSION } from "@hercule/home/version";
import { CurrentActor, type Actor } from "../actor";
import { homePaths, HerculeHome } from "../config";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { ControllerIdentity, controllerIdentityLayer } from "../identity";
import { masterKeyLayer, secretsLayer } from "../secrets";
import { SettingsLayer } from "../settings";
import { Controller, ControllerLayer } from "./service";

const USER: Actor = {
  _tag: "user",
  userId: "0199f0b7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199f0b7-0001-7000-8000-000000000000", tokenHash: "x" },
};

let homes: Array<string> = [];

afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes = [];
});

const stack = () => {
  const home = mkdtempSync(join(tmpdir(), "hercule-controller-read-"));
  homes.push(home);
  return ControllerLayer.pipe(
    Layer.provideMerge(Layer.mergeAll(controllerIdentityLayer, SettingsLayer, AuditLogLayer)),
    Layer.provideMerge(secretsLayer.pipe(Layer.provide(masterKeyLayer("file")))),
    Layer.provideMerge(TestDatabase),
    Layer.provideMerge(Layer.succeed(HerculeHome, homePaths(home, join(home, "data")))),
  );
};

/** The boot creates the identity before anything binds; so does this. */
const withIdentity = <A, E>(
  body: Effect.Effect<A, E, Controller | ControllerIdentity>,
  actor: Actor | null = USER,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const identity = yield* ControllerIdentity;
      const record = yield* identity.ensure;
      const result = yield* actor === null
        ? body
        : body.pipe(Effect.provideService(CurrentActor, actor));
      return { record, result };
    }).pipe(Effect.provide(stack())),
  );

describe("controller.read", () => {
  it("answers with the identity the runners verify against, and the baked-in version", async () => {
    const { record, result } = await withIdentity(
      Effect.flatMap(Controller, (controller) => controller.read()),
    );

    expect(result.id).toBe(record.id);
    expect(result.publicKey).toBe(Buffer.from(record.publicKey).toString("base64"));
    expect(result.version).toBe(VERSION);
  });

  it("never answers with the private key, which lives in the secrets table", async () => {
    const { result } = await withIdentity(
      Effect.flatMap(Controller, (controller) => controller.read()),
    );

    expect(Object.keys(result).sort()).toEqual(["defaultRunnerId", "id", "publicKey", "version"]);
  });

  it("refuses a caller without the grant before it reads anything", async () => {
    const { result } = await withIdentity(
      Effect.flatMap(Controller, (controller) => Effect.flip(controller.read())),
      null,
    );

    expect(result).toMatchObject({
      error: { code: "forbidden", details: { grant: "infra.read" } },
    });
  });
});

/**
 * `controller.update`'s grant refusal, asserted where it lives.
 *
 * Over HTTP it is unreachable: v1 authenticates one population, the user, and
 * the user passes every grant, so no request can present a credential missing
 * `infra.write`. An in-process call with nobody in `CurrentActor` is what
 * reaches the check.
 */
describe("controller.update", () => {
  it("refuses a caller without the grant before it writes anything", async () => {
    const { result } = await withIdentity(
      Effect.flatMap(Controller, (controller) => Effect.flip(controller.update({}))),
      null,
    );

    expect(result).toMatchObject({
      error: { code: "forbidden", details: { grant: "infra.write" } },
    });
  });
});
