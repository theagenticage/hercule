/**
 * Tests, against the real pi binary, that an OpenRouter model pi does not ship
 * runs once the adapter has declared it in the launch's private `models.json`,
 * that a model pi does ship keeps pi's own definition because the adapter leaves
 * it out, that the Harness Home's own `models.json` is only read, and that pi
 * never starts on a model other than the one asked for.
 *
 * No paid key and no real model: the account's key is a dummy and the
 * `openrouter` provider is redirected to a local fake server, which records the
 * model id each request names. The developer's own `~/.pi` is never touched.
 *
 * Skips without `pi` on PATH, like the other integration tests here.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import type { ModelDeclaration, HarnessEvent, SessionSpec } from "@hercule/protocol";
import { makePiAdapter } from "./adapter";
import { killProcessesHolding, runProcess, spawnPi } from "../process";
import { buildContext, cleanupHomes, filterByTag, SPEC, waitUntil } from "./testing";
import { createScratchHome } from "../testing";
import {
  redirectProviderToFakeServer,
  startScriptedModelServer,
  type FakeModelServer,
} from "./upstream";

const binary = Bun.which("pi") ?? undefined;

const MODELS_FILE = "models.json";

const upstreams: Array<FakeModelServer> = [];

afterAll(() => {
  cleanupHomes();
  for (const upstream of upstreams.splice(0)) upstream.stop();
});

const BUDGET_MS = 60_000;

/** Ids with a slash and a colon, which pi does not ship and OpenRouter-style ids may hold. */
const FIRST_ID = "fake-vendor/fake-model:free";
const SECOND_ID = "fake-vendor/second-model:free";

/** A model pi ships for OpenRouter, in every pi release the tests have run with. */
const SHIPPED_ID = "openai/gpt-4o-mini";

const buildDeclaration = (slug: string): ModelDeclaration => ({
  slug,
  name: `Fake: ${slug}`,
  imageInput: null,
  contextWindow: 32_768,
  outputLimit: 4_096,
});

const buildSpec = (model: string): SessionSpec => ({
  ...SPEC,
  modelSelection: { model, options: { thinking: "low" } },
  accessMode: "full-access",
});

/**
 * Starts the fake upstream and builds an adapter on the real pi, with the
 * context of an OpenRouter account in a scratch home whose `openrouter`
 * provider points at it. The adapter records the private agent folder of each
 * pi it starts, so a test can read the `models.json` that pi loaded while its
 * session runs.
 */
const buildOpenRouterContext = (catalogModels: ReadonlyArray<ModelDeclaration>) => {
  const folders: Array<string> = [];
  const pi = makePiAdapter({
    spawn: (command, env, cwd) => {
      const folder = env["PI_CODING_AGENT_DIR"];
      if (folder !== undefined && basename(folder).startsWith("hercule-pi-agent-")) {
        folders.push(folder);
      }
      return spawnPi(command, env, cwd);
    },
    run: runProcess,
    killProcessesHolding,
  });
  const upstream = startScriptedModelServer(() => ({ text: "OK" }));
  upstreams.push(upstream);
  const home = createScratchHome("pi-catalog");
  redirectProviderToFakeServer(home, "openrouter", upstream.baseUrl);
  const ctx = {
    ...buildContext(home, createScratchHome("pi-catalog-work"), {
      variable: "OPENROUTER_API_KEY",
      value: "dummy-key-for-a-test-only",
    }),
    binary: binary!,
    env: { PATH: process.env["PATH"] ?? "" },
    modelArgument: "openrouter/{model}",
    credentialVariables: ["OPENROUTER_API_KEY"],
    catalogModels,
  };
  return { upstream, ctx, pi, folders };
};

/** Returns the model id each request to the fake upstream named, in order. */
const listRequestedModels = (upstream: FakeModelServer): ReadonlyArray<string> =>
  upstream.requests().map((body) => (JSON.parse(body) as { model: string }).model);

describe.skipIf(binary === undefined)("a real pi on OpenRouter models it does not ship", () => {
  it(
    "sends the declared model's exact id upstream, and again after a switch to another declared model",
    async () => {
      const { upstream, ctx, pi } = buildOpenRouterContext([
        buildDeclaration(FIRST_ID),
        buildDeclaration(SECOND_ID),
      ]);
      const sessionId = crypto.randomUUID();
      const seen: Array<HarnessEvent> = [];
      Effect.runFork(
        Stream.runForEach(pi.events, (event) =>
          Effect.sync(() => {
            if (event.sessionId === sessionId) seen.push(event);
          }),
        ),
      );
      const completedTurns = () => filterByTag(seen, "turn.completed").length;

      await Effect.runPromise(pi.startSession(sessionId, buildSpec(FIRST_ID), ctx));
      await Effect.runPromise(pi.sendInput(sessionId, { text: "Reply with OK" }));
      await waitUntil("finished the first turn", () => completedTurns() === 1, BUDGET_MS / 2);
      expect(listRequestedModels(upstream)).toEqual([FIRST_ID]);

      await Effect.runPromise(
        pi.sendInput(sessionId, {
          text: "Reply with OK again",
          modelSelection: { model: SECOND_ID, options: { thinking: "low" } },
        }),
      );
      await waitUntil("finished the second turn", () => completedTurns() === 2, BUDGET_MS / 2);
      expect(listRequestedModels(upstream)).toEqual([FIRST_ID, SECOND_ID]);

      await Effect.runPromise(pi.stopSession(sessionId, "stopped"));
    },
    BUDGET_MS,
  );

  it(
    "keeps pi's own definition of a model it ships, on a start before any probe, and still runs a declared one",
    async () => {
      const { upstream, ctx, pi, folders } = buildOpenRouterContext([
        buildDeclaration(SHIPPED_ID),
        buildDeclaration(FIRST_ID),
      ]);
      const sessionId = crypto.randomUUID();
      const seen: Array<HarnessEvent> = [];
      Effect.runFork(
        Stream.runForEach(pi.events, (event) =>
          Effect.sync(() => {
            if (event.sessionId === sessionId) seen.push(event);
          }),
        ),
      );
      const completedTurns = () => filterByTag(seen, "turn.completed").length;

      await Effect.runPromise(pi.startSession(sessionId, buildSpec(SHIPPED_ID), ctx));
      await Effect.runPromise(pi.sendInput(sessionId, { text: "Reply with OK" }));
      await waitUntil("finished the first turn", () => completedTurns() === 1, BUDGET_MS / 2);

      // The shipped model is not in the file, so pi keeps its own definition
      // of it, with the thinking levels and compatibility settings. The home's
      // own file is the one the test wrote, with the provider's `baseUrl` only.
      const file = readFileSync(join(folders[0]!, MODELS_FILE), "utf8");
      expect(file).not.toContain(SHIPPED_ID);
      expect(file).toContain(FIRST_ID);
      expect(readFileSync(join(ctx.home, MODELS_FILE), "utf8")).not.toContain(FIRST_ID);

      await Effect.runPromise(
        pi.sendInput(sessionId, {
          text: "Reply with OK again",
          modelSelection: { model: FIRST_ID, options: { thinking: "low" } },
        }),
      );
      await waitUntil("finished the second turn", () => completedTurns() === 2, BUDGET_MS / 2);
      expect(listRequestedModels(upstream)).toEqual([SHIPPED_ID, FIRST_ID]);

      await Effect.runPromise(pi.stopSession(sessionId, "stopped"));
    },
    BUDGET_MS,
  );

  it(
    "declares only its own frame's models: a start with an empty catalog after one that declared a model",
    async () => {
      const { upstream, ctx, pi, folders } = buildOpenRouterContext([buildDeclaration(FIRST_ID)]);
      const first = crypto.randomUUID();
      await Effect.runPromise(pi.startSession(first, buildSpec(FIRST_ID), ctx));
      expect(readFileSync(join(folders[0]!, MODELS_FILE), "utf8")).toContain(FIRST_ID);
      await Effect.runPromise(pi.stopSession(first, "stopped"));
      // The session's private folder goes with its pi.
      await waitUntil("removed the first folder", () => !existsSync(folders[0]!));

      const second = crypto.randomUUID();
      await Effect.runPromise(
        pi.startSession(second, buildSpec(SHIPPED_ID), { ...ctx, catalogModels: [] }),
      );
      expect(readFileSync(join(folders[1]!, MODELS_FILE), "utf8")).not.toContain(FIRST_ID);
      await Effect.runPromise(pi.stopSession(second, "stopped"));

      expect(upstream.asked()).toBe(0);
    },
    BUDGET_MS,
  );

  it(
    "does not list a model a session declared, so the controller keeps sending it",
    async () => {
      const { ctx, pi } = buildOpenRouterContext([buildDeclaration(FIRST_ID)]);
      const sessionId = crypto.randomUUID();
      await Effect.runPromise(pi.startSession(sessionId, buildSpec(FIRST_ID), ctx));
      await Effect.runPromise(pi.stopSession(sessionId, "stopped"));

      // The model list refresh would call pi.dev, so the probe's stand-in for it
      // does nothing. Everything else is the real pi.
      const probing = makePiAdapter({
        spawn: spawnPi,
        run: (command, env) =>
          command[1] === "update"
            ? Effect.succeed({ code: 0, stdout: "", stderr: "" })
            : runProcess(command, env),
        killProcessesHolding,
      });
      const probed = await Effect.runPromise(probing.probe(ctx, { readUsage: false }));

      expect(probed.auth.status).toBe("ok");
      // pi's own OpenRouter models: more than a probe result used to hold.
      expect(probed.models.length).toBeGreaterThan(256);
      expect(probed.models.map((model) => model.slug)).not.toContain(FIRST_ID);
    },
    BUDGET_MS,
  );

  it(
    "refuses to start when pi would run a similar model instead of the one asked for",
    async () => {
      // A prefix of a model id pi ships: pi matches it to that model.
      const asked = "openai/gpt-4o-min";
      const { upstream, ctx, pi } = buildOpenRouterContext([]);

      const failed = await Effect.runPromise(
        Effect.flip(pi.startSession(crypto.randomUUID(), buildSpec(asked), ctx)),
      );

      expect(failed.message).toContain(`instead of openrouter/${asked}`);
      expect(await Effect.runPromise(pi.listSessions)).toEqual([]);
      expect(upstream.asked()).toBe(0);
    },
    BUDGET_MS,
  );
});
