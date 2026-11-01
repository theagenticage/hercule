/**
 * Tests how the pi adapter declares the account's Model Catalog to pi in the
 * Harness Home's `models.json`, with a fake pi so no vendor code runs: what is
 * written, which launches share the file safely, and what happens when a launch
 * fails. The same behaviour against a real pi is in
 * `catalog-models.integration.test.ts`.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import type { ModelDeclaration, SessionSpec } from "@hercule/protocol";
import { makePiAdapter } from "./adapter";
import { SUBAGENT_DIALOG, SUBAGENT_TOOL } from "./extension";
import {
  answerShippedModels,
  buildContext,
  buildFakePiSeam,
  buildRefusal,
  cleanupHomes,
  createDriving,
  createPiHome,
  filterByTag,
  listAgentSpawns,
  SESSION,
  SPEC,
  startBusySession,
  waitUntil,
  type FakePiBehaviour,
  type Spawn,
} from "./testing";

afterAll(cleanupHomes);

const OPENROUTER = { modelArgument: "openrouter/{model}" };
const OTHER_SESSION = "0199e0e7-0000-7000-8000-0000000000fe";

const buildDeclaration = (
  slug: string,
  details: Partial<ModelDeclaration> = {},
): ModelDeclaration => ({
  slug,
  name: `Fake: ${slug}`,
  imageInput: null,
  ...details,
});

const ONE = buildDeclaration("fake-vendor/one:free", { contextWindow: 65_536, reasoning: true });
const TWO = buildDeclaration("fake-vendor/two:free");

const buildSpecOn = (model: string): SessionSpec => ({
  ...SPEC,
  modelSelection: { model, options: { thinking: "high" } },
});

const ModelsFile = Schema.Struct({
  providers: Schema.Record(
    Schema.String,
    Schema.Struct({
      baseUrl: Schema.optionalKey(Schema.String),
      models: Schema.Array(Schema.Struct({ id: Schema.String })),
    }),
  ),
});

const readModelsFile = (home: string) =>
  Schema.decodeUnknownSync(ModelsFile)(JSON.parse(readFileSync(join(home, "models.json"), "utf8")));

/** Returns the ids declared for OpenRouter in the home's `models.json`. */
const readDeclaredIds = (home: string): ReadonlyArray<string> =>
  readModelsFile(home).providers["openrouter"]!.models.map((entry) => entry.id);

/**
 * Builds a fake pi that records the content of the home's `models.json` each
 * time an agent's pi is spawned in it, as that pi would load it. A listing of
 * the models pi ships runs in a scratch directory and is not recorded.
 */
const buildRecordingPi = (home: string, behaviour: FakePiBehaviour = {}) => {
  const loaded: Array<string | undefined> = [];
  const fake = buildFakePiSeam({
    ...behaviour,
    atSpawn: (env) => {
      if (env["PI_CODING_AGENT_DIR"] !== home) return;
      behaviour.atSpawn?.(env);
      const path = join(home, "models.json");
      loaded.push(existsSync(path) ? readFileSync(path, "utf8") : undefined);
    },
  });
  return { ...fake, loaded, adapter: makePiAdapter(fake.seam) };
};

/** Returns the OpenRouter ids a recorded `models.json` declared. */
const listLoadedIds = (content: string | undefined): ReadonlyArray<string> =>
  content === undefined
    ? []
    : Schema.decodeUnknownSync(ModelsFile)(JSON.parse(content)).providers["openrouter"]!.models.map(
        (entry) => entry.id,
      );

/** Answers pi's `get_state` the way a pi does that started on `model`. */
const answerStarted = (child: Spawn, model: string): void => {
  const asked = child.sent.find((one) => one.type === "get_state");
  child.push({
    type: "response",
    command: "get_state",
    id: asked!.command["id"],
    success: true,
    data: { model: { provider: "openrouter", id: model } },
  });
};

/** A fake pi that never answers `get_state`, so a test decides when a launch passes its check. */
const HOLDS_THE_CHECK: FakePiBehaviour = { answers: { get_state: () => undefined } };

describe("declaring the account's catalog to pi", () => {
  it("writes the catalog models pi does not ship into the Harness Home before pi is spawned", async () => {
    const home = createPiHome();
    const { adapter, loaded, spawns } = buildRecordingPi(home, {
      answers: answerShippedModels("openrouter", ["shipped/model"]),
    });
    const ctx = {
      ...buildContext(home),
      ...OPENROUTER,
      catalogModels: [buildDeclaration("shipped/model"), ONE, TWO],
    };

    await Effect.runPromise(adapter.startSession(SESSION, buildSpecOn(ONE.slug), ctx));

    expect(listLoadedIds(loaded[0])).toEqual([ONE.slug, TWO.slug]);
    // Each entry holds what the catalog gave, with pi's names for it.
    expect(JSON.parse(loaded[0]!)).toEqual({
      providers: {
        openrouter: {
          models: [
            {
              id: ONE.slug,
              name: "Fake: fake-vendor/one:free",
              contextWindow: 65_536,
              input: ["text"],
              reasoning: true,
            },
            { id: TWO.slug, name: "Fake: fake-vendor/two:free", input: ["text"] },
          ],
        },
      },
    });
    expect(listAgentSpawns(spawns)).toHaveLength(1);
  });

  it("replaces the provider's models in a file that is already there, keeping its other keys", async () => {
    const run = createDriving();
    const ctx = { ...run.ctx, ...OPENROUTER, catalogModels: [ONE] };
    writeFileSync(
      join(ctx.home, "models.json"),
      JSON.stringify({
        providers: {
          openrouter: { baseUrl: "http://127.0.0.1:9", models: [{ id: "left/the-catalog" }] },
        },
      }),
    );

    await Effect.runPromise(run.adapter.startSession(SESSION, buildSpecOn(ONE.slug), ctx));

    const written = readModelsFile(ctx.home);
    expect(written.providers["openrouter"]!.baseUrl).toBe("http://127.0.0.1:9");
    expect(readDeclaredIds(ctx.home)).toEqual([ONE.slug]);
  });

  it("clears the declarations of an earlier start when the frame carries an empty catalog", async () => {
    const run = createDriving();
    const ctx = { ...run.ctx, ...OPENROUTER, catalogModels: [] };
    writeFileSync(
      join(ctx.home, "models.json"),
      JSON.stringify({ providers: { openrouter: { models: [{ id: "left/the-catalog" }] } } }),
    );

    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, ctx));

    expect(readDeclaredIds(ctx.home)).toEqual([]);
  });

  it("leaves the file alone, and lists nothing, when the frame carries no catalog", async () => {
    const run = createDriving();
    const content = JSON.stringify({ providers: { openrouter: { models: [{ id: "kept" }] } } });
    writeFileSync(join(run.ctx.home, "models.json"), content);

    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, run.ctx));

    expect(readFileSync(join(run.ctx.home, "models.json"), "utf8")).toBe(content);
    expect(listAgentSpawns(run.spawns)).toHaveLength(1);
    expect(run.spawns).toHaveLength(1);
  });

  it("writes no file for an empty catalog when none was declared", async () => {
    const run = createDriving();
    const ctx = { ...run.ctx, ...OPENROUTER, catalogModels: [] };

    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, ctx));

    expect(existsSync(join(ctx.home, "models.json"))).toBe(false);
  });

  it("does not rewrite a file that already holds the declarations", async () => {
    const run = createDriving();
    const ctx = { ...run.ctx, ...OPENROUTER, catalogModels: [ONE] };
    await Effect.runPromise(run.adapter.startSession(SESSION, buildSpecOn(ONE.slug), ctx));
    const path = join(ctx.home, "models.json");
    const before = statSync(path).mtimeMs;
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));

    await new Promise((resolve) => setTimeout(resolve, 15));
    await Effect.runPromise(run.adapter.startSession(SESSION, buildSpecOn(ONE.slug), ctx));

    expect(statSync(path).mtimeMs).toBe(before);
  });

  it("reads a models file that starts with a byte-order mark", async () => {
    const run = createDriving();
    const ctx = { ...run.ctx, ...OPENROUTER, catalogModels: [ONE] };
    writeFileSync(
      join(ctx.home, "models.json"),
      `\uFEFF${JSON.stringify({ providers: { zai: { models: [{ id: "kept" }] } } })}`,
    );

    await Effect.runPromise(run.adapter.startSession(SESSION, buildSpecOn(ONE.slug), ctx));

    const written = readModelsFile(ctx.home);
    expect(written.providers["zai"]!.models.map((entry) => entry.id)).toEqual(["kept"]);
    expect(readDeclaredIds(ctx.home)).toEqual([ONE.slug]);
  });

  it("refuses to start on a models file with comments, names the file, and leaves it as it is", async () => {
    const run = createDriving();
    const ctx = { ...run.ctx, ...OPENROUTER, catalogModels: [ONE] };
    const path = join(ctx.home, "models.json");
    const content = '{\n  // secret-looking-comment\n  "providers": {}\n}';
    writeFileSync(path, content);

    const failed = await Effect.runPromise(
      Effect.flip(run.adapter.startSession(SESSION, buildSpecOn(ONE.slug), ctx)),
    );

    expect(failed._tag).toBe("AdapterFailed");
    expect(failed.message).toContain(path);
    expect(failed.message).toContain("openrouter");
    expect(failed.message).toContain("Remove its comments, or delete the file");
    expect(failed.message).not.toContain("secret-looking-comment");
    expect(readFileSync(path, "utf8")).toBe(content);
    expect(listAgentSpawns(run.spawns)).toEqual([]);
  });

  it("fails the start, and spawns no agent, when the models file cannot be written", async () => {
    const run = createDriving();
    const ctx = { ...run.ctx, ...OPENROUTER, catalogModels: [ONE] };
    // A directory where the file should be makes the rename fail.
    mkdirSync(join(ctx.home, "models.json"));

    const failed = await Effect.runPromise(
      Effect.flip(run.adapter.startSession(SESSION, buildSpecOn(ONE.slug), ctx)),
    );

    expect(failed).toMatchObject({ _tag: "AdapterFailed" });
    expect(listAgentSpawns(run.spawns)).toEqual([]);
  });

  it("fails the start with pi's reason, and writes nothing, when pi cannot list the models it ships", async () => {
    const run = createDriving({
      answers: { get_available_models: () => buildRefusal("pi broke") },
    });
    const ctx = { ...run.ctx, ...OPENROUTER, catalogModels: [ONE] };

    const failed = await Effect.runPromise(
      Effect.flip(run.adapter.startSession(SESSION, buildSpecOn(ONE.slug), ctx)),
    );

    expect(failed._tag).toBe("AdapterFailed");
    expect(failed.message).toContain("could not list the models it ships for openrouter");
    expect(failed.message).toContain("pi broke");
    expect(existsSync(join(ctx.home, "models.json"))).toBe(false);
    expect(listAgentSpawns(run.spawns)).toEqual([]);
  });

  it("lists the models pi ships once for starts that follow each other in one home", async () => {
    const run = createDriving({ answers: answerShippedModels("openrouter", ["shipped/model"]) });
    const ctx = { ...run.ctx, ...OPENROUTER, catalogModels: [ONE] };

    await Effect.runPromise(run.adapter.startSession(SESSION, buildSpecOn(ONE.slug), ctx));
    await Effect.runPromise(run.adapter.startSession(OTHER_SESSION, buildSpecOn(ONE.slug), ctx));

    expect(run.spawns.filter((one) => !one.command.includes("-e"))).toHaveLength(1);
  });
});

describe("launches that share one Harness Home", () => {
  it("lets each pi load the declarations of its own frame when two starts overlap", async () => {
    const home = createPiHome();
    const { adapter, loaded, spawns } = buildRecordingPi(home, HOLDS_THE_CHECK);
    const first = { ...buildContext(home), ...OPENROUTER, catalogModels: [ONE] };
    const second = { ...first, catalogModels: [TWO] };

    const firstStart = Effect.runPromise(
      adapter.startSession(SESSION, buildSpecOn(ONE.slug), first),
    );
    await waitUntil("spawned the first pi", () => listAgentSpawns(spawns).length === 1);
    const secondStart = Effect.runPromise(
      adapter.startSession(OTHER_SESSION, buildSpecOn(TWO.slug), second),
    );
    // The second start must wait: writing now would change what the first pi
    // is about to load.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listAgentSpawns(spawns)).toHaveLength(1);
    expect(readDeclaredIds(home)).toEqual([ONE.slug]);

    answerStarted(listAgentSpawns(spawns)[0]!, ONE.slug);
    await firstStart;
    await waitUntil("spawned the second pi", () => listAgentSpawns(spawns).length === 2);
    answerStarted(listAgentSpawns(spawns)[1]!, TWO.slug);
    await secondStart;

    expect(loaded.map(listLoadedIds)).toEqual([[ONE.slug], [TWO.slug]]);
  });

  it("does not make starts wait for each other when they manage no declarations", async () => {
    const home = createPiHome();
    const { adapter, spawns } = buildRecordingPi(home, HOLDS_THE_CHECK);
    const context = buildContext(home);

    const starts = [SESSION, OTHER_SESSION].map((id) =>
      Effect.runPromise(adapter.startSession(id, SPEC, context)),
    );
    await waitUntil("spawned both pis", () => listAgentSpawns(spawns).length === 2);
    for (const child of listAgentSpawns(spawns)) {
      child.push({
        type: "response",
        command: "get_state",
        id: child.sent.find((one) => one.type === "get_state")!.command["id"],
        success: true,
        data: { model: { provider: "zai", id: "glm-5.3" } },
      });
    }
    await Promise.all(starts);
  });

  it("makes a refresh of the model list wait for a launch that holds the home, then stores it", async () => {
    const home = createPiHome();
    const storePath = join(home, "models-store.json");
    writeFileSync(storePath, "OLD");
    let refreshed = false;
    const { adapter, spawns } = buildRecordingPi(home, {
      ...HOLDS_THE_CHECK,
      ran: (command, env) => {
        if (command[1] === "auth") {
          return { code: 0, stdout: JSON.stringify({ status: "ready" }), stderr: "" };
        }
        if (command[1] !== "update") return undefined;
        writeFileSync(join(env["PI_CODING_AGENT_DIR"]!, "models-store.json"), "NEW");
        refreshed = true;
        return undefined;
      },
    });
    const ctx = { ...buildContext(home), ...OPENROUTER, catalogModels: [ONE] };

    const start = Effect.runPromise(adapter.startSession(SESSION, buildSpecOn(ONE.slug), ctx));
    await waitUntil("spawned the pi", () => listAgentSpawns(spawns).length === 1);
    const probing = Effect.runPromise(adapter.probe(ctx, { readUsage: false }));
    await waitUntil("finished the refresh command", () => refreshed);
    // The refreshed store must not reach the home while the launch's pi loads.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readFileSync(storePath, "utf8")).toBe("OLD");

    answerStarted(listAgentSpawns(spawns)[0]!, ONE.slug);
    await start;
    await probing;

    expect(readFileSync(storePath, "utf8")).toBe("NEW");
  });

  const SECOND_START = async (
    adapter: ReturnType<typeof makePiAdapter>,
    home: string,
  ): Promise<void> => {
    // Completes only if the failed start gave the lock back.
    const ctx = { ...buildContext(home), ...OPENROUTER, catalogModels: [TWO] };
    await Effect.runPromise(adapter.startSession(OTHER_SESSION, buildSpecOn(TWO.slug), ctx));
  };

  it("gives the lock back when pi cannot be spawned", async () => {
    const home = createPiHome();
    let failing = true;
    const { adapter } = buildRecordingPi(home, {
      atSpawn: () => {
        if (failing) throw new Error("spawn failed");
      },
    });
    const ctx = { ...buildContext(home), ...OPENROUTER, catalogModels: [ONE] };

    const failed = await Effect.runPromise(
      Effect.flip(adapter.startSession(SESSION, buildSpecOn(ONE.slug), ctx)),
    );
    failing = false;

    expect(failed.message).toContain("could not be run");
    await SECOND_START(adapter, home);
  });

  it("gives the lock back when pi starts on another model than the one asked for", async () => {
    const home = createPiHome();
    let wrong = true;
    const { adapter } = buildRecordingPi(home, {
      answers: {
        get_state: () => ({
          success: true,
          data: { model: { provider: "openrouter", id: wrong ? "other/model" : TWO.slug } },
        }),
      },
    });
    const ctx = { ...buildContext(home), ...OPENROUTER, catalogModels: [ONE] };

    const failed = await Effect.runPromise(
      Effect.flip(adapter.startSession(SESSION, buildSpecOn(ONE.slug), ctx)),
    );
    wrong = false;

    expect(failed.message).toContain("instead of openrouter/fake-vendor/one:free");
    await SECOND_START(adapter, home);
  });

  it("gives the lock back when pi exits before it answers", async () => {
    const home = createPiHome();
    const { adapter, spawns } = buildRecordingPi(home, HOLDS_THE_CHECK);
    const ctx = { ...buildContext(home), ...OPENROUTER, catalogModels: [ONE] };

    const start = Effect.runPromise(
      Effect.flip(adapter.startSession(SESSION, buildSpecOn(ONE.slug), ctx)),
    );
    await waitUntil("spawned the pi", () => listAgentSpawns(spawns).length === 1);
    listAgentSpawns(spawns)[0]!.crash("pi: killed");
    await start;

    const second = SECOND_START(adapter, home);
    await waitUntil("spawned the second pi", () => listAgentSpawns(spawns).length === 2);
    answerStarted(listAgentSpawns(spawns)[1]!, TWO.slug);
    await second;
  });
});

describe("a subagent of a session that declares the catalog", () => {
  /** Pushes a `subagent` call and its dialog to the parent, as pi does when the model calls the tool. */
  const askForSubagent = (parent: Spawn): void => {
    const toolCallId = `call_${crypto.randomUUID()}`;
    parent.push({
      type: "tool_execution_start",
      toolCallId,
      toolName: SUBAGENT_TOOL,
      args: { description: "Look", prompt: "Look around" },
    });
    parent.push({
      type: "extension_ui_request",
      id: crypto.randomUUID(),
      method: "input",
      title: SUBAGENT_DIALOG,
      placeholder: JSON.stringify({ toolCallId, description: "Look", prompt: "Look around" }),
    });
  };

  /** Starts a session declaring ONE, and records the `models.json` each pi is spawned with. */
  const startParent = async (behaviour: FakePiBehaviour = {}) => {
    const spawnedWith: Array<{
      readonly directory: string | undefined;
      readonly content: string | undefined;
    }> = [];
    const run = await startBusySession(
      {
        ...behaviour,
        answers: { ...answerShippedModels("openrouter", ["shipped/model"]), ...behaviour.answers },
        atSpawn: (env) => {
          const directory = env["PI_CODING_AGENT_DIR"];
          const path = directory === undefined ? "" : join(directory, "models.json");
          spawnedWith.push({
            directory,
            content: existsSync(path) ? readFileSync(path, "utf8") : undefined,
          });
        },
      },
      buildSpecOn(ONE.slug),
      {},
      { ...OPENROUTER, catalogModels: [ONE] },
    );
    return { run, spawnedWith };
  };

  it("loads the declarations of its parent's frame, even after another start rewrote the file", async () => {
    const { run, spawnedWith } = await startParent();
    await Effect.runPromise(
      run.adapter.startSession(OTHER_SESSION, buildSpecOn(TWO.slug), {
        ...run.ctx,
        ...OPENROUTER,
        catalogModels: [TWO],
      }),
    );
    expect(readDeclaredIds(run.ctx.home)).toEqual([TWO.slug]);
    const spawnsBefore = spawnedWith.length;

    askForSubagent(run.child);
    await waitUntil(
      "started the subagent",
      () => filterByTag(run.seen, "subagent.started").length === 1,
    );

    const subagentSpawn = spawnedWith[spawnsBefore]!;
    expect(subagentSpawn.directory).toBe(run.ctx.home);
    expect(listLoadedIds(subagentSpawn.content)).toEqual([ONE.slug]);
    // The subagent's pi passed the exact-model check, so it was prompted.
    await waitUntil("prompted the subagent", () =>
      listAgentSpawns(run.spawns).some(
        (one) => one !== run.child && one.sent.some((sent) => sent.type === "prompt"),
      ),
    );
  });

  it("fails the subagent call loudly when its pi started on another model", async () => {
    let asked = 0;
    const { run } = await startParent({
      answers: {
        get_state: () => ({
          success: true,
          data: {
            model: { provider: "openrouter", id: asked++ === 0 ? ONE.slug : "other/similar-model" },
          },
        }),
      },
    });

    askForSubagent(run.child);
    await waitUntil("answered the call", () =>
      run.child.sent.some((one) => one.type === "extension_ui_response"),
    );

    const reply = run.child.sent.find((one) => one.type === "extension_ui_response")!;
    expect(String(reply.command["value"])).toContain("instead of openrouter/fake-vendor/one:free");
    const subagents = listAgentSpawns(run.spawns).filter((one) => one !== run.child);
    expect(subagents).toHaveLength(1);
    expect(subagents[0]!.sent.some((one) => one.type === "prompt")).toBe(false);
    expect(subagents[0]!.stdinClosed()).toBe(true);
  });

  describe("when the session ends while the launch waits", () => {
    /** Starts a parent whose next listing of shipped models (a changed model store) is held. */
    const startParentWithHeldListing = async (behaviour: FakePiBehaviour = {}) => {
      const state = { holding: false };
      const shipped = answerShippedModels("openrouter", ["shipped/model"])["get_available_models"]!;
      const started = await startParent({
        ...behaviour,
        answers: {
          get_available_models: (command) => (state.holding ? undefined : shipped(command)),
          ...behaviour.answers,
        },
      });
      return { ...started, state };
    };

    /** Holds the next listing, asks for a subagent, and returns the held listing's pi. */
    const askWhileListingIsHeld = async (
      run: Awaited<ReturnType<typeof startParentWithHeldListing>>,
    ): Promise<Spawn> => {
      run.state.holding = true;
      // A new store content makes the subagent's launch list again.
      writeFileSync(join(run.run.ctx.home, "models-store.json"), '{"changed":true}');
      const listingsBefore = run.run.spawns.filter((one) => !one.command.includes("-e")).length;
      askForSubagent(run.run.child);
      await waitUntil(
        "started the held listing",
        () => run.run.spawns.filter((one) => !one.command.includes("-e")).length > listingsBefore,
      );
      return run.run.spawns.filter((one) => !one.command.includes("-e")).at(-1)!;
    };

    /** Answers the held listing of shipped models, as pi does when it finally lists. */
    const releaseListing = (listing: Spawn): void => {
      const asked = listing.sent.find((one) => one.type === "get_available_models")!;
      listing.push({
        type: "response",
        command: "get_available_models",
        id: asked.command["id"],
        success: true,
        data: { models: [{ id: "shipped/model", name: "S", provider: "openrouter" }] },
      });
    };

    const expectNoSubagentStarted = async (
      run: Awaited<ReturnType<typeof startParentWithHeldListing>>,
    ): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(listAgentSpawns(run.run.spawns)).toEqual([run.run.child]);
      expect(filterByTag(run.run.seen, "subagent.started")).toEqual([]);
      // The launch gave the lock back: a later start in the home completes.
      await Effect.runPromise(
        run.run.adapter.startSession(OTHER_SESSION, buildSpecOn(TWO.slug), {
          ...run.run.ctx,
          ...OPENROUTER,
          catalogModels: [TWO],
        }),
      );
    };

    it("starts no pi when the session is stopped during the listing of shipped models", async () => {
      const run = await startParentWithHeldListing();
      const listing = await askWhileListingIsHeld(run);

      await Effect.runPromise(run.run.adapter.stopSession(SESSION, "stopped"));
      run.state.holding = false;
      releaseListing(listing);

      await expectNoSubagentStarted(run);
    });

    it("starts no pi when the parent's turn is interrupted during the listing", async () => {
      const run = await startParentWithHeldListing();
      const listing = await askWhileListingIsHeld(run);

      await Effect.runPromise(run.run.adapter.interrupt(SESSION));
      run.state.holding = false;
      releaseListing(listing);

      await expectNoSubagentStarted(run);
    });

    it("sends no task to a subagent whose session is stopped while pi checks its model", async () => {
      let asked = 0;
      const run = await startParentWithHeldListing({
        answers: {
          // The parent's own check passes. The subagent's waits for the test.
          get_state: () =>
            asked++ === 0
              ? { success: true, data: { model: { provider: "openrouter", id: ONE.slug } } }
              : undefined,
        },
      });
      askForSubagent(run.run.child);
      await waitUntil(
        "spawned the subagent's pi",
        () => listAgentSpawns(run.run.spawns).length === 2,
      );
      const subagent = listAgentSpawns(run.run.spawns)[1]!;

      answerStarted(subagent, ONE.slug);
      await Effect.runPromise(run.run.adapter.stopSession(SESSION, "stopped"));
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(subagent.sent.some((one) => one.type === "prompt")).toBe(false);
      expect(subagent.stdinClosed()).toBe(true);
    });
  });
});
