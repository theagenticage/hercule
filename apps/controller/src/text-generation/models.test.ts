/**
 * Tests how the `textGeneration.model` setting resolves to an instance and a
 * model, on a real database with stored snapshots and no runner connected.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ProviderDefinition } from "@hercule/plugin-host";
import type { ProbeResult } from "@hercule/protocol";
import { nowIso } from "../db";
import { buildPluginStack, buildProviderDefinition, createPluginFixture } from "../plugins/testing";
import { PluginHost } from "../plugins";
import { providerRepository } from "../providers";
import { runnerRepository } from "../runners";
import { hashToken } from "../credentials";
import { Settings, SettingsLayer } from "../settings";
import {
  AUTOMATIC_PROVIDER_ORDER,
  TextGenerationModels,
  TextGenerationModelsLayer,
} from "./models";

const withSuggestion = (id: string, model: string): ProviderDefinition => ({
  ...buildProviderDefinition(id, { token: "t" }),
  suggestedTextGenerationModel: model,
});

const layer = TextGenerationModelsLayer.pipe(
  Layer.provideMerge(SettingsLayer),
  Layer.provideMerge(buildPluginStack()),
);

const probed = (
  status: "ok" | "unauthenticated",
  ...slugs: ReadonlyArray<string>
): ProbeResult => ({
  harnessVersion: "1.0.0",
  auth: { status },
  models: slugs.map((slug, index) => ({
    slug,
    name: slug,
    imageInput: { maxBytes: null },
    isDefault: index === 0,
    options: [],
  })),
});

/** A fleet of two codex-like providers and three runners, arranged by `arrange`. */
const run = <A>(
  arrange: (fleet: {
    readonly instances: Readonly<Record<string, string>>;
    readonly addRunner: (reserved: boolean) => Effect.Effect<string, never, never>;
    readonly snapshot: (
      instance: string,
      runner: string,
      result: ProbeResult,
    ) => Effect.Effect<void>;
  }) => Effect.Effect<A, unknown, Settings | TextGenerationModels | SqlClient.SqlClient>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.flatMap(PluginHost, (host) =>
        host.boot([
          createPluginFixture({
            id: "titles",
            definitions: [
              withSuggestion("codex", "codex-mini"),
              withSuggestion("pi", "pi-small"),
              withSuggestion("claude-code", "haiku"),
            ],
          }).plugin,
        ]),
      );
      const instances = yield* providerRepository;
      const runners = yield* runnerRepository;
      const at = yield* nowIso;
      const ids: Record<string, string> = {};
      for (const providerId of ["codex", "pi", "claude-code"]) {
        ids[providerId] = (yield* instances.insert({
          providerId,
          name: providerId,
          config: { token: "t" },
          at,
        })).id;
      }
      return yield* arrange({
        instances: ids,
        addRunner: (reserved) =>
          Effect.map(
            runners.insert({
              name: `runner-${crypto.randomUUID().slice(0, 4)}`,
              connectivity: "online",
              lifecycle: "active",
              reserved,
              labels: [],
              credentialHash: hashToken(crypto.randomUUID()),
              at,
            }),
            (runner) => runner.id,
          ).pipe(Effect.orDie),
        snapshot: (instance, runner, result) =>
          instances.recordSnapshot(instance, runner, result, at).pipe(Effect.orDie),
      });
    }).pipe(Effect.orDie, Effect.provide(layer)),
  );

const resolve = Effect.flatMap(TextGenerationModels, (models) => models.resolve());

describe("automatic", () => {
  it("tries codex, then pi, then claude-code", () => {
    expect(AUTOMATIC_PROVIDER_ORDER).toEqual(["codex", "pi", "claude-code"]);
  });

  it("picks the first provider whose suggested model a logged-in runner offers", async () => {
    const choice = await run(({ instances, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const runner = yield* addRunner(false);
        yield* snapshot(instances["codex"]!, runner, probed("ok", "something-else"));
        yield* snapshot(instances["pi"]!, runner, probed("ok", "pi-small"));
        yield* snapshot(instances["claude-code"]!, runner, probed("ok", "haiku"));
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(choice).toEqual({
      _tag: "resolved",
      instanceId: expect.any(String) as unknown,
      providerId: "pi",
      model: "pi-small",
    });
  });

  it("skips a login that expired and a snapshot on a reserved runner", async () => {
    const choice = await run(({ instances, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const open = yield* addRunner(false);
        const reserved = yield* addRunner(true);
        yield* snapshot(instances["codex"]!, open, probed("unauthenticated", "codex-mini"));
        yield* snapshot(instances["pi"]!, reserved, probed("ok", "pi-small"));
        yield* snapshot(instances["claude-code"]!, open, probed("ok", "haiku"));
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(choice).toMatchObject({ _tag: "resolved", providerId: "claude-code", model: "haiku" });
  });

  it("is unresolved, with a message to act on, when nothing matches", async () => {
    const choice = await run(({ instances, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const runner = yield* addRunner(false);
        yield* snapshot(instances["codex"]!, runner, probed("ok", "other"));
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(choice).toMatchObject({
      _tag: "unresolved",
      message: expect.stringContaining("choose a model in Settings") as unknown,
    });
  });

  it("is what an unset setting means", async () => {
    const choice = await run(({ instances, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const settings = yield* Settings;
        yield* settings.set("textGeneration.model", "automatic");
        const runner = yield* addRunner(false);
        yield* snapshot(instances["codex"]!, runner, probed("ok", "codex-mini"));
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(choice).toMatchObject({ _tag: "resolved", providerId: "codex" });
  });
});

describe("off", () => {
  it("resolves to off", async () => {
    const choice = await run(() =>
      Effect.gen(function* () {
        const settings = yield* Settings;
        yield* settings.set("textGeneration.model", "off");
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(choice).toEqual({ _tag: "off" });
  });
});

describe("a chosen instance and model", () => {
  it("is returned as it is, even when no runner offers the model", async () => {
    const choice = await run(({ instances }) =>
      Effect.gen(function* () {
        const settings = yield* Settings;
        yield* settings.set("textGeneration.model", {
          instanceId: instances["pi"]!,
          model: "not-in-any-catalog",
        });
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(choice).toEqual({
      _tag: "resolved",
      instanceId: expect.any(String) as unknown,
      providerId: "pi",
      model: "not-in-any-catalog",
    });
  });

  it("is unresolved once the instance is gone, and never replaced by automatic", async () => {
    const choice = await run(({ instances, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const settings = yield* Settings;
        const repository = yield* providerRepository;
        const runner = yield* addRunner(false);
        yield* snapshot(instances["codex"]!, runner, probed("ok", "codex-mini"));
        yield* settings.set("textGeneration.model", {
          instanceId: instances["pi"]!,
          model: "pi-small",
        });
        yield* repository.delete(instances["pi"]!).pipe(Effect.orDie);
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(choice).toMatchObject({
      _tag: "unresolved",
      message: expect.stringContaining("no longer exists") as unknown,
    });
  });
});
