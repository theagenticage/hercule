/**
 * Tests how the `textGeneration.model` setting resolves to an instance and a
 * model, on a real database with stored snapshots and no runner connected.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { ProviderDefinition } from "@hercule/plugin-host";
import { TEXT_GENERATION_CAPABILITY, type ProbeResult } from "@hercule/protocol";
import { nowIso, uuidFromString, withTransaction } from "../db";
import { buildPluginStack, buildProviderDefinition, createPluginFixture } from "../plugins/testing";
import { PluginHost } from "../plugins";
import { providerRepository } from "../providers";
import { runnerRepository } from "../runners";
import { hashToken } from "../credentials";
import { Settings, SettingsLayer } from "../settings";
import { TextGenerationModels, TextGenerationModelsLayer } from "./models";
import { inTransaction } from "../db/testing";

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

/** What a runner added by `addRunner` is like. Without traits it can take the call. */
interface RunnerTraits {
  readonly reserved?: boolean;
  readonly online?: boolean;
  /** Whether the runner negotiated the text generation capability at hello. */
  readonly capable?: boolean;
}

/** A fleet of one instance per automatic provider, arranged by `arrange`. */
const run = <A>(
  arrange: (fleet: {
    readonly instances: Readonly<Record<string, string>>;
    readonly addRunner: (traits?: RunnerTraits) => Effect.Effect<string>;
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
      const sql = yield* SqlClient.SqlClient;
      const at = yield* nowIso;
      const ids: Record<string, string> = {};
      for (const providerId of ["codex", "pi", "claude-code"]) {
        ids[providerId] = (yield* withTransaction(
          sql,
          instances.insert({
            providerId,
            name: providerId,
            config: { token: "t" },
            at,
          }),
        )).id;
      }
      return yield* arrange({
        instances: ids,
        addRunner: (traits = {}) =>
          withTransaction(
            sql,
            Effect.gen(function* () {
              const runner = yield* runners.insert({
                name: `runner-${crypto.randomUUID().slice(0, 4)}`,
                connectivity: traits.online === false ? "offline" : "online",
                lifecycle: "active",
                reserved: traits.reserved ?? false,
                labels: [],
                credentialHash: hashToken(crypto.randomUUID()),
                at,
              });
              const capabilities = traits.capable === false ? [] : [TEXT_GENERATION_CAPABILITY];
              yield* sql`UPDATE runners SET negotiated_capabilities = ${JSON.stringify(capabilities)}
                WHERE id = ${uuidFromString(runner.id)}`;
              return runner.id;
            }),
          ).pipe(Effect.orDie),
        snapshot: (instance, runner, result) =>
          withTransaction(sql, instances.recordSnapshot(instance, runner, result, at)).pipe(
            Effect.orDie,
          ),
      });
    }).pipe(Effect.orDie, Effect.provide(layer)),
  );

const resolve = Effect.flatMap(TextGenerationModels, (models) => models.resolve());

describe("automatic", () => {
  it("picks the first provider whose suggested model a logged-in runner offers", async () => {
    const target = await run(({ instances, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const runner = yield* addRunner();
        yield* snapshot(instances["codex"]!, runner, probed("ok", "something-else"));
        yield* snapshot(instances["pi"]!, runner, probed("ok", "pi-small"));
        yield* snapshot(instances["claude-code"]!, runner, probed("ok", "haiku"));
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(target).toMatchObject({
      _tag: "resolved",
      instance: { providerId: "pi" },
      model: "pi-small",
      runnerIds: [expect.any(String) as unknown],
    });
  });

  it("skips a login that expired and a snapshot on a reserved runner", async () => {
    const target = await run(({ instances, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const open = yield* addRunner();
        const reserved = yield* addRunner({ reserved: true });
        yield* snapshot(instances["codex"]!, open, probed("unauthenticated", "codex-mini"));
        yield* snapshot(instances["pi"]!, reserved, probed("ok", "pi-small"));
        yield* snapshot(instances["claude-code"]!, open, probed("ok", "haiku"));
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(target).toMatchObject({
      _tag: "resolved",
      instance: { providerId: "claude-code" },
      model: "haiku",
    });
  });

  it("skips an instance that is logged in only on an offline runner", async () => {
    const target = await run(({ instances, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const offline = yield* addRunner({ online: false });
        const online = yield* addRunner();
        yield* snapshot(instances["codex"]!, offline, probed("ok", "codex-mini"));
        yield* snapshot(instances["pi"]!, online, probed("ok", "pi-small"));
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(target).toMatchObject({ _tag: "resolved", instance: { providerId: "pi" } });
  });

  it("skips an instance that is logged in only on a runner without the text generation capability", async () => {
    const target = await run(({ instances, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const old = yield* addRunner({ capable: false });
        const current = yield* addRunner();
        yield* snapshot(instances["codex"]!, old, probed("ok", "codex-mini"));
        yield* snapshot(instances["pi"]!, current, probed("ok", "pi-small"));
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(target).toMatchObject({ _tag: "resolved", instance: { providerId: "pi" } });
  });

  it("lists every runner that could take the call", async () => {
    const [target, expected] = await run(({ instances, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const first = yield* addRunner();
        const second = yield* addRunner();
        const offline = yield* addRunner({ online: false });
        for (const runner of [first, second, offline]) {
          yield* snapshot(instances["codex"]!, runner, probed("ok", "codex-mini"));
        }
        return [yield* resolve.pipe(Effect.orDie), [first, second]] as const;
      }),
    );

    expect(target._tag === "resolved" ? [...target.runnerIds].sort() : []).toEqual(
      [...expected].sort(),
    );
  });

  it("has another failure key once it resolves to another model", async () => {
    const keys = await run(({ instances, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const runner = yield* addRunner();
        yield* snapshot(instances["codex"]!, runner, probed("ok", "codex-mini"));
        yield* snapshot(instances["pi"]!, runner, probed("ok", "pi-small"));
        const withCodex = yield* resolve.pipe(Effect.orDie);
        yield* snapshot(instances["codex"]!, runner, probed("unauthenticated", "codex-mini"));
        const withPi = yield* resolve.pipe(Effect.orDie);
        yield* snapshot(instances["pi"]!, runner, probed("unauthenticated", "pi-small"));
        const withNothing = yield* resolve.pipe(Effect.orDie);
        const again = yield* resolve.pipe(Effect.orDie);
        return {
          codex: withCodex.failureKey,
          pi: withPi.failureKey,
          nothing: withNothing.failureKey,
          nothingAgain: again.failureKey,
        };
      }),
    );

    expect(new Set([keys.codex, keys.pi, keys.nothing]).size).toBe(3);
    expect(keys.nothingAgain).toBe(keys.nothing);
  });

  it("is unresolved, with a message that says why, when nothing matches", async () => {
    const target = await run(({ instances, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const runner = yield* addRunner();
        yield* snapshot(instances["codex"]!, runner, probed("ok", "other"));
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(target).toMatchObject({
      _tag: "unresolved",
      message: expect.stringContaining("logged in to a suggested model") as unknown,
    });
  });

  it("is what an unset setting means", async () => {
    const target = await run(({ instances, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const settings = yield* Settings;
        yield* inTransaction(settings.set("textGeneration.model", "automatic"));
        const runner = yield* addRunner();
        yield* snapshot(instances["codex"]!, runner, probed("ok", "codex-mini"));
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(target).toMatchObject({ _tag: "resolved", instance: { providerId: "codex" } });
  });
});

describe("off", () => {
  it("resolves to off", async () => {
    const target = await run(() =>
      Effect.gen(function* () {
        const settings = yield* Settings;
        yield* inTransaction(settings.set("textGeneration.model", "off"));
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(target).toEqual({
      _tag: "off",
      failureKey: JSON.stringify({ setting: "off", ran: null }),
    });
  });
});

describe("a chosen instance and model", () => {
  it("is returned as it is, with no runner, when no runner offers the model", async () => {
    const target = await run(({ instances, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const settings = yield* Settings;
        const runner = yield* addRunner();
        yield* snapshot(instances["pi"]!, runner, probed("ok", "pi-small"));
        yield* inTransaction(
          settings.set("textGeneration.model", {
            instanceId: instances["pi"]!,
            model: "not-in-any-catalog",
          }),
        );
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(target).toMatchObject({
      _tag: "resolved",
      instance: { providerId: "pi" },
      model: "not-in-any-catalog",
      runnerIds: [],
    });
  });

  it("lists only the runners that can take the call and list the model", async () => {
    const [target, expected] = await run(({ instances, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const settings = yield* Settings;
        const offers = yield* addRunner();
        const lacksModel = yield* addRunner();
        const offline = yield* addRunner({ online: false });
        const old = yield* addRunner({ capable: false });
        yield* snapshot(instances["pi"]!, offers, probed("ok", "pi-small"));
        yield* snapshot(instances["pi"]!, lacksModel, probed("ok", "pi-large"));
        yield* snapshot(instances["pi"]!, offline, probed("ok", "pi-small"));
        yield* snapshot(instances["pi"]!, old, probed("ok", "pi-small"));
        yield* inTransaction(
          settings.set("textGeneration.model", {
            instanceId: instances["pi"]!,
            model: "pi-small",
          }),
        );
        return [yield* resolve.pipe(Effect.orDie), [offers]] as const;
      }),
    );

    expect(target).toMatchObject({ _tag: "resolved", runnerIds: expected });
  });

  it("is unresolved once the instance is gone, and never replaced by automatic", async () => {
    const target = await run(({ instances, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const settings = yield* Settings;
        const repository = yield* providerRepository;
        const runner = yield* addRunner();
        yield* snapshot(instances["codex"]!, runner, probed("ok", "codex-mini"));
        yield* inTransaction(
          settings.set("textGeneration.model", {
            instanceId: instances["pi"]!,
            model: "pi-small",
          }),
        );
        yield* inTransaction(repository.delete(instances["pi"]!)).pipe(Effect.orDie);
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(target).toMatchObject({
      _tag: "unresolved",
      message: expect.stringContaining("no longer exists") as unknown,
    });
  });
});
