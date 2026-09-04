import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { VERSION } from "@hydra/home/version";
import { CurrentActor, type Actor } from "../actor";
import { homePaths, HydraHome } from "../config";
import { TestDatabase } from "../db/testing";
import { masterKeyLayer, secretsLayer } from "../secrets";
import { ControllerIdentity, controllerIdentityLayer } from "./repository";
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
  const home = mkdtempSync(join(tmpdir(), "hydra-controller-read-"));
  homes.push(home);
  return ControllerLayer.pipe(
    Layer.provideMerge(controllerIdentityLayer),
    Layer.provideMerge(secretsLayer.pipe(Layer.provide(masterKeyLayer("file")))),
    Layer.provideMerge(TestDatabase),
    Layer.provideMerge(Layer.succeed(HydraHome, homePaths(home, join(home, "data")))),
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

    expect(Object.keys(result).sort()).toEqual(["id", "publicKey", "version"]);
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
