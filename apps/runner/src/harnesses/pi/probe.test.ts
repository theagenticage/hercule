/**
 * Tests what the pi adapter's probe reports about a machine, using a fake pi,
 * so no vendor code runs. The tests call the probe through the adapter,
 * because that is how the runner calls it.
 *
 * The one-shot commands and their output match pi 0.85.1: `pi --version`
 * prints the bare version, and `pi auth check --provider zai --json` prints a
 * status object and exits with code 1 when no key is configured.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Deferred, Duration, Effect, Fiber, Logger } from "effect";
import { TestClock } from "effect/testing";
import type { HarnessCredential, ProbeResult } from "@hercule/protocol";
import { makePiAdapter } from "./adapter";
import {
  buildFakePiSeam,
  cleanupHomes,
  buildContext,
  FAKE_PI_VERSION,
  MODEL_STORE_REFRESHED,
  type FakePiBehaviour,
  createPiHome,
  TEST_CREDENTIAL,
  TEST_ZAI_KEY,
} from "./testing";

afterAll(cleanupHomes);

const runProbe = (
  behaviour: FakePiBehaviour = {},
  credential: HarnessCredential | null = TEST_CREDENTIAL,
  // A rest parameter, not a default: a default would replace the explicit
  // `undefined` that the no-pi test passes, and give that test a pi anyway.
  ...binary: ReadonlyArray<string | undefined>
): {
  readonly result: Promise<ProbeResult>;
  readonly runs: ReturnType<typeof buildFakePiSeam>["runs"];
  readonly spawns: ReturnType<typeof buildFakePiSeam>["spawns"];
} => {
  const { seam, runs, spawns } = buildFakePiSeam(behaviour);
  const ctx = {
    ...buildContext(createPiHome(), null, credential),
    ...(binary.length === 0 ? {} : { binary: binary[0] }),
  };
  return {
    result: Effect.runPromise(makePiAdapter(seam).probe(ctx, { readUsage: false })),
    runs,
    spawns,
  };
};

const findModelOption = (
  models: ProbeResult["models"],
  slug: string,
  id: string,
): Record<string, unknown> | undefined =>
  models.find((model) => model.slug === slug)?.options.find((option) => option.id === id);

const listChoiceValues = (option: Record<string, unknown> | undefined): ReadonlyArray<string> =>
  ((option?.["choices"] ?? []) as ReadonlyArray<{ readonly value: string }>).map(
    (choice) => choice.value,
  );

describe("the pi adapter's probe", () => {
  it("reports the version the binary prints", async () => {
    const { result, runs } = runProbe();

    const probed = await result;
    expect(probed.harnessVersion).toBe(FAKE_PI_VERSION);
    expect(runs.map((run) => run.command.slice(1))).toContainEqual(["--version"]);
  });

  it("reports a ready auth check as logged in, with no identity", async () => {
    const { result, runs } = runProbe();

    const probed = await result;
    expect(probed.auth.status).toBe("ok");
    // Z.ai uses an API key, so there is no account name to report, and a
    // made-up identity would show a name the user never entered.
    expect(probed.auth.identity).toBeUndefined();
    expect(probed.auth.message).toBeUndefined();
    expect(runs.map((run) => run.command.slice(1))).toContainEqual([
      "auth",
      "check",
      "--provider",
      "zai",
      "--json",
    ]);
  });

  it("passes the account's Z.ai key in the environment variable pi reads", async () => {
    const { result, runs } = runProbe();

    await result;
    const checked = runs.find((run) => run.command.includes("check"));
    expect(checked?.env["ZAI_API_KEY"]).toBe(TEST_ZAI_KEY);
  });

  it("checks the provider the account's model argument names, and lists only its models", async () => {
    const { seam, runs } = buildFakePiSeam({});
    const ctx = { ...buildContext(createPiHome()), modelArgument: "openrouter/{model}" };

    const probed = await Effect.runPromise(makePiAdapter(seam).probe(ctx, { readUsage: false }));

    expect(runs.map((run) => run.command.slice(1))).toContainEqual([
      "auth",
      "check",
      "--provider",
      "openrouter",
      "--json",
    ]);
    // The fake pi lists Z.ai models and one from another provider, none from openrouter.
    expect(probed.models).toEqual([]);
  });

  it("fails the probe with a message when the model argument names no provider", async () => {
    const { seam, runs } = buildFakePiSeam({});
    const ctx = { ...buildContext(createPiHome()), modelArgument: "{model}" };

    const probed = await Effect.runPromise(makePiAdapter(seam).probe(ctx, { readUsage: false }));

    expect(probed.auth.status).toBe("error");
    expect(probed.auth.message).toContain("<provider>/{model}");
    expect(runs).toEqual([]);
  });

  it("reports a machine with no key as unauthenticated, not as broken", async () => {
    const { result } = runProbe({}, null);

    const probed = await result;
    // Not `error`: nobody has entered a key yet. The Fleet row must tell that
    // apart from a broken pi.
    expect(probed.auth.status).toBe("unauthenticated");
    expect(probed.auth.identity).toBeUndefined();
  });

  it("reports an error with a message when pi is not installed", async () => {
    const { result } = runProbe({}, TEST_CREDENTIAL, undefined);

    const probed = await result;
    expect(probed.auth.status).toBe("error");
    expect(probed.auth.message ?? "").not.toBe("");
  });

  it("reports a failing command's own error output", async () => {
    const { result } = runProbe({
      ran: () => ({ code: 127, stdout: "", stderr: "pi: command not found" }),
    });

    const probed = await result;
    expect(probed.auth.status).toBe("error");
    expect(probed.auth.message).toContain("command not found");
  });

  it("offers the Z.ai models pi lists, and no other provider's", async () => {
    const { result } = runProbe();

    const probed = await result;
    expect(probed.models.map((model) => model.slug)).toEqual([
      "glm-4.7",
      "glm-5-turbo",
      "glm-5.2",
      "glm-5.2-highspeed",
      "glm-5.3",
      "glm-5.3-flash",
      "glm-5.3-highspeed",
    ]);
    expect(probed.models.map((model) => model.name)).toEqual([
      "GLM-4.7",
      "GLM-5-Turbo",
      "GLM-5.2",
      "GLM-5.2 Highspeed",
      "GLM-5.3",
      "GLM-5.3-Flash",
      "GLM-5.3 Highspeed",
    ]);
  });

  it("declares pi's image size limit on the models that take images, and no images on the rest", async () => {
    const { result } = runProbe();

    const probed = await result;
    const imageInputs = Object.fromEntries(
      probed.models.map((model) => [model.slug, model.imageInput]),
    );
    // 3,538,944 bytes is 3.375 MiB, the most that fits in pi's 4.5 MiB of base64.
    expect(imageInputs["glm-5.3-flash"]).toEqual({ maxBytes: 3_538_944 });
    expect(imageInputs["glm-5.3"]).toBeNull();
  });

  it("offers only the thinking levels each model supports", async () => {
    const { result } = runProbe();

    const probed = await result;
    // GLM 5.3 maps `off`, `minimal`, `medium` and `xhigh` to null: it does not
    // support them, and Z.ai would reject a turn at one of those levels.
    expect(listChoiceValues(findModelOption(probed.models, "glm-5.3", "thinking"))).toEqual([
      "low",
      "high",
      "max",
    ]);
    expect(listChoiceValues(findModelOption(probed.models, "glm-5.3-flash", "thinking"))).toEqual([
      "low",
      "high",
      "max",
    ]);
    // The 5.2 models support `off` and the 5.3 models do not. The two models
    // with no thinking map offer no thinking option, not an empty one.
    expect(listChoiceValues(findModelOption(probed.models, "glm-5.2", "thinking"))).toEqual([
      "off",
      "high",
      "max",
    ]);
    expect(findModelOption(probed.models, "glm-4.7", "thinking")).toBeUndefined();
  });

  describe("listing the models in a scratch agent directory", () => {
    /** What the scratch agent directory held when pi was spawned. */
    interface SeenAtSpawn {
      readonly directory: string | undefined;
      readonly files: ReadonlyArray<string>;
      readonly store: string | undefined;
    }

    const probeWithHome = async (prepareHome: (home: string) => void) => {
      const home = createPiHome();
      prepareHome(home);
      let seen: SeenAtSpawn = { directory: undefined, files: [], store: undefined };
      const { seam, spawns, runs } = buildFakePiSeam({
        atSpawn: (env) => {
          const directory = env["PI_CODING_AGENT_DIR"];
          seen = {
            directory,
            files: directory === undefined ? [] : readdirSync(directory).sort(),
            store:
              directory !== undefined && existsSync(join(directory, "models-store.json"))
                ? readFileSync(join(directory, "models-store.json"), "utf8")
                : undefined,
          };
        },
      });
      const probed = await Effect.runPromise(
        makePiAdapter(seam).probe(buildContext(home), { readUsage: false }),
      );
      return { home, seen, probed, spawns, runs };
    };

    it("lists from a copy of the home's model store and never from its models.json", async () => {
      const store = '{"models":["a-model-newer-than-pi"]}';
      const { home, seen, probed } = await probeWithHome((prepared) => {
        writeFileSync(join(prepared, "models-store.json"), store);
        writeFileSync(
          join(prepared, "models.json"),
          JSON.stringify({ providers: { zai: { models: [{ id: "declared-by-hercule" }] } } }),
        );
      });

      expect(seen.directory).not.toBe(home);
      expect(seen.files).toEqual(["models-store.json"]);
      expect(seen.store).toBe(store);
      expect(probed.models.length).toBeGreaterThan(0);
    });

    it("deletes the scratch directory when the probe is over, and leaves the home as it was", async () => {
      const { home, seen } = await probeWithHome((prepared) => {
        writeFileSync(join(prepared, "models.json"), "{}");
      });

      expect(existsSync(seen.directory!)).toBe(false);
      expect(readdirSync(home)).toEqual(["models.json"]);
    });

    it("lists from an empty scratch directory when the home was never refreshed", async () => {
      const { seen } = await probeWithHome(() => undefined);

      expect(seen.files).toEqual([]);
    });

    it("keeps the refresh and the key check in the home", async () => {
      const { home, runs } = await probeWithHome(() => undefined);

      const inHome = runs.map((run) => run.env["PI_CODING_AGENT_DIR"]);
      expect(inHome.length).toBeGreaterThan(0);
      for (const directory of inHome) expect(directory).toBe(home);
    });

    it("reports every model pi lists, as pi 0.85.1 lists 366 for OpenRouter", async () => {
      const models = Array.from({ length: 366 }, (_, index) => ({
        id: `vendor/model-${String(index)}`,
        name: `Model ${String(index)}`,
        provider: "zai",
        input: ["text"],
      }));
      const { seam } = buildFakePiSeam({
        answers: { get_available_models: () => ({ success: true, data: { models } }) },
      });

      const probed = await Effect.runPromise(
        makePiAdapter(seam).probe(buildContext(createPiHome()), { readUsage: false }),
      );

      expect(probed.models).toHaveLength(366);
    });
  });

  describe("refreshing the model list", () => {
    const FAILED = { code: 1, stdout: "", stderr: "Error: could not reach pi.dev" };

    /**
     * Runs an effect on a test clock and collects the warnings written while it
     * runs. A detached refresh keeps the logger it was started with, so its
     * late warnings are collected too. A test that reads the warnings while the
     * effect runs passes a function, which receives the list.
     */
    const runOnClock = <A>(
      build: Effect.Effect<A> | ((warnings: ReadonlyArray<string>) => Effect.Effect<A>),
    ) => {
      const warnings: Array<string> = [];
      const collecting = Logger.make<unknown, void>(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(String(message));
      });
      const effect = typeof build === "function" ? build(warnings) : build;
      const result = Effect.runPromise(
        effect.pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([collecting]))),
      );
      return { result, warnings };
    };

    /** Returns a `refresh` behaviour that ends only when the test lets it end. */
    const buildControlledRefresh = (ending: typeof MODEL_STORE_REFRESHED) => {
      const gate = Deferred.makeUnsafe<void>();
      let interrupted = false;
      return {
        refresh: Deferred.await(gate).pipe(
          Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true))),
          Effect.as(ending),
        ),
        finish: Deferred.succeed(gate, undefined),
        wasInterrupted: () => interrupted,
      };
    };

    const countRefreshes = (runs: ReadonlyArray<{ readonly command: ReadonlyArray<string> }>) =>
      runs.filter((run) => run.command[1] === "update").length;

    // Past the refresh's wait of 8 seconds, short of the probe's own deadline of 15.
    const PAST_WAIT = Duration.seconds(10);

    it("refreshes online with only the variables pi needs, before the offline read", async () => {
      const { seam, runs, spawns } = buildFakePiSeam({
        refresh: Effect.sleep(Duration.millis(20)).pipe(Effect.as(MODEL_STORE_REFRESHED)),
      });
      const home = createPiHome();
      const ctx = {
        ...buildContext(home),
        env: {
          PATH: "/usr/bin",
          HTTPS_PROXY: "http://proxy.example:3128",
          PI_OFFLINE: "1",
          OPENROUTER_API_KEY: "another-providers-key",
          AWS_ACCESS_KEY_ID: "another-providers-key-id",
        },
      };

      const { result } = runOnClock(
        Effect.gen(function* () {
          const probing = yield* Effect.forkChild(
            makePiAdapter(seam).probe(ctx, { readUsage: false }),
          );
          yield* TestClock.adjust(0);
          // The refresh has started and is not over, so the read has not started.
          expect(countRefreshes(runs)).toBe(1);
          expect(spawns).toHaveLength(0);
          yield* TestClock.adjust(Duration.millis(20));
          return yield* Fiber.join(probing);
        }),
      );

      const probed = await result;
      const refresh = runs.find((run) => run.command[1] === "update");
      expect(refresh?.command).toEqual(["/usr/local/bin/pi", "update", "--models"]);
      // Another provider's credentials would send them to that provider, and
      // `PI_OFFLINE` set to any value turns the network off.
      expect(Object.keys(refresh?.env ?? {}).sort()).toEqual([
        "HTTPS_PROXY",
        "PATH",
        "PI_CODING_AGENT_DIR",
        "PI_SKIP_VERSION_CHECK",
        "ZAI_API_KEY",
      ]);
      expect(refresh?.env["PI_CODING_AGENT_DIR"]).toBe(home);
      expect(refresh?.env["ZAI_API_KEY"]).toBe(TEST_ZAI_KEY);
      expect(spawns).toHaveLength(1);
      expect(spawns[0]?.command).toContain("--offline");
      expect(probed.models.length).toBeGreaterThan(0);
    });

    it("still reports the catalog when the refresh fails, and warns with pi's error", async () => {
      const { seam } = buildFakePiSeam({ refresh: Effect.succeed(FAILED) });
      const ctx = buildContext(createPiHome());

      const { result, warnings } = runOnClock(makePiAdapter(seam).probe(ctx, { readUsage: false }));

      const probed = await result;
      expect(probed.auth.status).toBe("ok");
      expect(probed.models.map((model) => model.slug)).toContain("glm-5.3");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(ctx.home);
      expect(warnings[0]).toContain("Error: could not reach pi.dev");
    });

    it("goes on without waiting past the budget, and reports a late failure after the probe returned", async () => {
      const controlled = buildControlledRefresh(FAILED);
      const { seam } = buildFakePiSeam({ refresh: controlled.refresh });
      const ctx = buildContext(createPiHome());

      const { result, warnings } = runOnClock((collected) =>
        Effect.gen(function* () {
          const probing = yield* Effect.forkChild(
            makePiAdapter(seam).probe(ctx, { readUsage: false }),
          );
          yield* TestClock.adjust(0);
          yield* TestClock.adjust(PAST_WAIT);
          const probed = yield* Fiber.join(probing);
          const warningsAtReturn = [...collected];
          yield* controlled.finish;
          yield* TestClock.adjust(0);
          return { probed, warningsAtReturn };
        }),
      );

      const { probed, warningsAtReturn } = await result;
      expect(probed.auth.status).toBe("ok");
      expect(probed.models.map((model) => model.slug)).toContain("glm-5.3");
      expect(controlled.wasInterrupted()).toBe(false);
      expect(warningsAtReturn).toHaveLength(1);
      expect(warningsAtReturn[0]).toContain(ctx.home);
      expect(warningsAtReturn[0]).toContain("has not refreshed");
      expect(warnings).toHaveLength(2);
      expect(warnings[1]).toContain(ctx.home);
      expect(warnings[1]).toContain("Error: could not reach pi.dev");
    });

    it("lets a probe start its own refresh while another of the same home is still running", async () => {
      const controlled = buildControlledRefresh(MODEL_STORE_REFRESHED);
      const { seam, runs } = buildFakePiSeam({ refresh: controlled.refresh });
      const adapter = makePiAdapter(seam);
      const ctx = buildContext(createPiHome());

      const { result } = runOnClock(
        Effect.gen(function* () {
          const probings = yield* Effect.forEach([1, 2], () =>
            Effect.forkChild(adapter.probe(ctx, { readUsage: false })),
          );
          yield* TestClock.adjust(0);
          yield* TestClock.adjust(PAST_WAIT);
          yield* Effect.forEach(probings, Fiber.join);
          yield* controlled.finish;
        }),
      );

      await result;
      // pi's lock makes the two refreshes' writes take turns, so overlap is safe.
      expect(countRefreshes(runs)).toBe(2);
    });

    it("signals a refresh that outlasts Hercule's own limit, and frees its home", async () => {
      const { seam, runs } = buildFakePiSeam({ refresh: Effect.never });
      const adapter = makePiAdapter(seam);
      const ctx = buildContext(createPiHome());

      const { result, warnings } = runOnClock(
        Effect.gen(function* () {
          const probing = yield* Effect.forkChild(adapter.probe(ctx, { readUsage: false }));
          yield* TestClock.adjust(0);
          yield* TestClock.adjust(PAST_WAIT);
          yield* Fiber.join(probing);
          yield* TestClock.adjust(Duration.seconds(25));
          const second = yield* Effect.forkChild(adapter.probe(ctx, { readUsage: false }));
          yield* TestClock.adjust(0);
          yield* TestClock.adjust(PAST_WAIT);
          yield* Fiber.join(second);
        }),
      );

      await result;
      expect(countRefreshes(runs)).toBe(2);
      expect(warnings.some((line) => line.includes("sent it a stop signal"))).toBe(true);
    });

    it("runs no refresh when no key is set", async () => {
      const { result, runs } = runProbe({}, null);

      await result;
      expect(countRefreshes(runs)).toBe(0);
    });
  });
});
