import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { VERSION } from "@hercule/home/version";
import { CurrentActor, type Actor } from "../actor";
import { withTransaction } from "../db";
import { ControllerIdentity, controllerIdentityLayer } from "../identity";
import { PluginHost } from "../plugins";
import { buildPluginStack } from "../plugins/testing";
import { ProviderAccountRunnersLayer } from "../provider-accounts";
import { LocalRunnerId } from "../runners";
import { Secrets } from "../secrets";
import { Settings, SettingsLayer } from "../settings";
import {
  LastTextGenerationFailure,
  LastTextGenerationFailureLayer,
  TextGenerationModels,
  TextGenerationModelsLayer,
} from "../text-generation";
import { addFixtureAccount, buildTextGenerationPlugins } from "../text-generation/testing";
import { Controller, ControllerLayer } from "./service";

const USER: Actor = {
  _tag: "user",
  userId: "0199f0b7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199f0b7-0001-7000-8000-000000000000", tokenHash: "x" },
};

const buildStack = () =>
  ControllerLayer.pipe(
    Layer.provideMerge(Layer.mergeAll(TextGenerationModelsLayer, LastTextGenerationFailureLayer)),
    Layer.provideMerge(ProviderAccountRunnersLayer),
    Layer.provideMerge(Layer.mergeAll(controllerIdentityLayer, SettingsLayer)),
    Layer.provideMerge(buildPluginStack()),
  );

/**
 * Creates the identity, as the boot does, then runs `body` as `actor`. The
 * local runner's id is read through `localRunner`, which is provided where the
 * service is built, as `hercule serve` provides it.
 */
const withIdentity = <A, E>(
  body: Effect.Effect<
    A,
    E,
    | Controller
    | ControllerIdentity
    | Settings
    | LastTextGenerationFailure
    | TextGenerationModels
    | PluginHost
    | Secrets
    | SqlClient.SqlClient
  >,
  actor: Actor | null = USER,
  localRunner: { readonly read: () => string | undefined } = { read: () => undefined },
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const identity = yield* ControllerIdentity;
      const record = yield* identity.ensure;
      const result = yield* actor === null
        ? body
        : body.pipe(Effect.provideService(CurrentActor, actor));
      return { record, result };
    }).pipe(Effect.provide(buildStack()), Effect.provideService(LocalRunnerId, localRunner)),
  );

describe("controller.read", () => {
  it("returns the identity the runners verify against, and the built-in version", async () => {
    const { record, result } = await withIdentity(
      Effect.flatMap(Controller, (controller) => controller.read()),
    );

    expect(result.id).toBe(record.id);
    expect(result.publicKey).toBe(Buffer.from(record.publicKey).toString("base64"));
    expect(result.version).toBe(VERSION);
  });

  it("never returns the private key, which is stored in the secrets table", async () => {
    const { result } = await withIdentity(
      Effect.flatMap(Controller, (controller) => controller.read()),
    );

    expect(Object.keys(result).sort()).toEqual([
      "defaultRunnerId",
      "id",
      "localRunnerId",
      "publicKey",
      "textGeneration",
      "version",
    ]);
  });

  it("returns no local runner when the controller starts none", async () => {
    const { result } = await withIdentity(
      Effect.flatMap(Controller, (controller) => controller.read()),
    );

    expect(result.localRunnerId).toBeNull();
  });

  it("reads the local runner's id from the running child on every call", async () => {
    // The child reports its id only once it has joined, so the first read
    // comes before it and the second after it.
    let reported: string | undefined;
    const runnerId = "0199f0b7-0002-7000-8000-000000000000";
    const { result } = await withIdentity(
      Effect.gen(function* () {
        const controller = yield* Controller;
        const before = yield* controller.read();
        reported = runnerId;
        const after = yield* controller.read();
        return { before: before.localRunnerId, after: after.localRunnerId };
      }),
      USER,
      { read: () => reported },
    );

    expect(result).toEqual({ before: null, after: runnerId });
  });

  it("rejects a caller without the grant before it reads anything", async () => {
    const { result } = await withIdentity(
      Effect.flatMap(Controller, (controller) => Effect.flip(controller.read())),
      null,
    );

    expect(result).toMatchObject({
      error: { code: "forbidden", details: { grant: "infra.read" } },
    });
  });
});

describe("controller.read text generation", () => {
  it("shows no model and no failure, and why no call can run, when nothing is set up", async () => {
    const { result } = await withIdentity(
      Effect.flatMap(Controller, (controller) => controller.read()),
    );

    expect(result.textGeneration).toEqual({
      model: null,
      unavailableReason: expect.stringContaining("pick a model in Settings › System") as unknown,
      lastFailure: null,
    });
  });

  it("shows the chosen model, and the last failure while there is one", async () => {
    const { result } = await withIdentity(
      Effect.gen(function* () {
        const controller = yield* Controller;
        const settings = yield* Settings;
        const failures = yield* LastTextGenerationFailure;
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.flatMap(PluginHost, (host) => host.boot(buildTextGenerationPlugins()));
        const account = yield* addFixtureAccount("openai");
        yield* withTransaction(
          sql,
          settings.set("textGeneration.model", {
            providerAccountId: account.id,
            model: "mini",
          }),
        );
        const before = yield* controller.read();
        const target = yield* (yield* TextGenerationModels).resolve();
        yield* failures.record(target.failureKey, {
          reason: "timeout",
          message: "the text generation did not finish in time",
          at: "2026-10-11T10:00:00.000Z",
        });
        const failed = yield* controller.read();
        yield* failures.clear();
        const cleared = yield* controller.read();
        return { providerAccountId: account.id, before, failed, cleared };
      }),
    );

    expect(result.before.textGeneration).toEqual({
      model: {
        providerAccountId: result.providerAccountId,
        harnessId: "codex/codex",
        model: "mini",
      },
      // No runner has the account signed in, so the reason names it.
      unavailableReason: expect.stringContaining("OpenAI with the model mini") as unknown,
      lastFailure: null,
    });
    expect(result.failed.textGeneration.lastFailure).toEqual({
      reason: "timeout",
      message: "the text generation did not finish in time",
      at: "2026-10-11T10:00:00.000Z",
    });
    expect(result.cleared.textGeneration.lastFailure).toBeNull();
  });

  it("shows no model when text generation is off", async () => {
    const { result } = await withIdentity(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const settings = yield* Settings;
        yield* withTransaction(sql, settings.set("textGeneration.model", "off"));
        return yield* Effect.flatMap(Controller, (controller) => controller.read());
      }),
    );

    expect(result.textGeneration.model).toBeNull();
    expect(result.textGeneration.unavailableReason).toBe("text generation is off in Settings");
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
  it("rejects a caller without the grant before it writes anything", async () => {
    const { result } = await withIdentity(
      Effect.flatMap(Controller, (controller) => Effect.flip(controller.update({}))),
      null,
    );

    expect(result).toMatchObject({
      error: { code: "forbidden", details: { grant: "infra.write" } },
    });
  });
});
