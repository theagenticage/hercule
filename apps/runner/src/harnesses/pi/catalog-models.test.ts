/**
 * Tests how the pi adapter declares the account's Model Catalog to pi, with a
 * fake pi so no vendor code runs: what each launch's private agent folder
 * holds, that the Harness Home's own files are never written, and what happens
 * when a launch fails. The same behaviour against a real pi is in
 * `catalog-models.integration.test.ts`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import type { ModelDeclaration, SessionSpec } from "@hercule/protocol";
import { makePiAdapter } from "./adapter";
import { SUBAGENT_DIALOG, SUBAGENT_TOOL } from "./extension";
import {
  agentFolderOf,
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

/** Returns the ids a `models.json` text declares for OpenRouter. */
const listDeclaredIds = (content: string | undefined): ReadonlyArray<string> =>
  content === undefined
    ? []
    : Schema.decodeUnknownSync(ModelsFile)(JSON.parse(content)).providers["openrouter"]!.models.map(
        (entry) => entry.id,
      );

/** What a pi found in its agent folder at the moment it was spawned. */
interface Loaded {
  readonly folder: string;
  readonly models: string | undefined;
  readonly store: string | undefined;
}

const readIfPresent = (path: string): string | undefined =>
  existsSync(path) ? readFileSync(path, "utf8") : undefined;

/**
 * Builds a fake pi that records the model files in the agent folder of each
 * agent's pi as it is spawned, as that pi would load them. A listing of the
 * models pi ships runs in a scratch directory of its own and is not recorded.
 */
const buildRecordingPi = (behaviour: FakePiBehaviour = {}) => {
  const loaded: Array<Loaded> = [];
  const fake = buildFakePiSeam({
    ...behaviour,
    atSpawn: (env) => {
      behaviour.atSpawn?.(env);
      const folder = env["PI_CODING_AGENT_DIR"];
      if (folder === undefined || !basename(folder).startsWith("hercule-pi-agent-")) return;
      loaded.push({
        folder,
        models: readIfPresent(join(folder, "models.json")),
        store: readIfPresent(join(folder, "models-store.json")),
      });
    },
  });
  return { ...fake, loaded, adapter: makePiAdapter(fake.seam) };
};

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
  it("writes the catalog models pi does not ship into the launch's private folder, before pi is spawned", async () => {
    const home = createPiHome();
    const { adapter, loaded, spawns } = buildRecordingPi({
      answers: answerShippedModels("openrouter", ["shipped/model"]),
    });
    const ctx = {
      ...buildContext(home),
      ...OPENROUTER,
      catalogModels: [buildDeclaration("shipped/model"), ONE, TWO],
    };

    await Effect.runPromise(adapter.startSession(SESSION, buildSpecOn(ONE.slug), ctx));

    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.folder).not.toBe(home);
    // Each entry holds what the catalog gave, with pi's names for it, and the
    // model pi ships is not declared.
    expect(JSON.parse(loaded[0]!.models!)).toEqual({
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

  it("never writes the Harness Home's models.json, and keeps its other keys in the copy", async () => {
    const home = createPiHome();
    const { adapter, loaded } = buildRecordingPi();
    const ctx = { ...buildContext(home), ...OPENROUTER, catalogModels: [ONE] };
    const original = JSON.stringify({
      providers: {
        openrouter: { baseUrl: "http://127.0.0.1:9", models: [{ id: "left/the-catalog" }] },
      },
    });
    writeFileSync(join(home, "models.json"), original);

    await Effect.runPromise(adapter.startSession(SESSION, buildSpecOn(ONE.slug), ctx));

    const copy = Schema.decodeUnknownSync(ModelsFile)(JSON.parse(loaded[0]!.models!));
    expect(copy.providers["openrouter"]!.baseUrl).toBe("http://127.0.0.1:9");
    expect(listDeclaredIds(loaded[0]!.models)).toEqual([ONE.slug]);
    expect(readFileSync(join(home, "models.json"), "utf8")).toBe(original);
  });

  it("leaves the home without a models.json when it had none", async () => {
    const home = createPiHome();
    const { adapter } = buildRecordingPi();
    const ctx = { ...buildContext(home), ...OPENROUTER, catalogModels: [ONE] };

    await Effect.runPromise(adapter.startSession(SESSION, buildSpecOn(ONE.slug), ctx));

    expect(existsSync(join(home, "models.json"))).toBe(false);
  });

  it("writes an empty list for the provider when the frame carries an empty catalog", async () => {
    const home = createPiHome();
    const { adapter, loaded } = buildRecordingPi();
    const ctx = { ...buildContext(home), ...OPENROUTER, catalogModels: [] };
    writeFileSync(
      join(home, "models.json"),
      JSON.stringify({ providers: { openrouter: { models: [{ id: "left/the-catalog" }] } } }),
    );

    await Effect.runPromise(adapter.startSession(SESSION, SPEC, ctx));

    expect(JSON.parse(loaded[0]!.models!)).toEqual({
      providers: { openrouter: { models: [] } },
    });
  });

  it("gives pi the home's models.json as it is, and lists nothing, when the frame carries no catalog", async () => {
    const home = createPiHome();
    const { adapter, loaded, spawns } = buildRecordingPi();
    const ctx = { ...buildContext(home), ...OPENROUTER };
    // Bytes pi accepts but a JSON parser does not: the copy must be the file itself.
    const content = '{\n  // my own models\n  "providers": { "openrouter": { "models": [] } }\n}';
    writeFileSync(join(home, "models.json"), content);

    await Effect.runPromise(adapter.startSession(SESSION, SPEC, ctx));

    expect(loaded[0]!.models).toBe(content);
    expect(spawns).toHaveLength(1);
  });

  it("gives pi no models.json when neither the home nor the frame has any", async () => {
    const { adapter, loaded } = buildRecordingPi();

    await Effect.runPromise(adapter.startSession(SESSION, SPEC, buildContext(createPiHome())));

    expect(loaded[0]!.models).toBeUndefined();
  });

  it("copies the home's model store into the folder", async () => {
    const home = createPiHome();
    writeFileSync(join(home, "models-store.json"), '{"refreshed":true}');
    const { adapter, loaded } = buildRecordingPi();

    await Effect.runPromise(adapter.startSession(SESSION, SPEC, buildContext(home)));

    expect(loaded[0]!.store).toBe('{"refreshed":true}');
  });

  it("reads a models file that starts with a byte-order mark", async () => {
    const home = createPiHome();
    const { adapter, loaded } = buildRecordingPi();
    const ctx = { ...buildContext(home), ...OPENROUTER, catalogModels: [ONE] };
    writeFileSync(
      join(home, "models.json"),
      `\uFEFF${JSON.stringify({ providers: { zai: { models: [{ id: "kept" }] } } })}`,
    );

    await Effect.runPromise(adapter.startSession(SESSION, buildSpecOn(ONE.slug), ctx));

    const copy = Schema.decodeUnknownSync(ModelsFile)(JSON.parse(loaded[0]!.models!));
    expect(copy.providers["zai"]!.models.map((entry) => entry.id)).toEqual(["kept"]);
    expect(listDeclaredIds(loaded[0]!.models)).toEqual([ONE.slug]);
  });

  it("refuses to start on a models file with comments when models must be added, names the file, and leaves it as it is", async () => {
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

  it("starts on a models file with comments when the catalog has nothing to add", async () => {
    const home = createPiHome();
    const { adapter, loaded } = buildRecordingPi();
    const ctx = { ...buildContext(home), ...OPENROUTER, catalogModels: [] };
    const content = '{\n  // my own models\n  "providers": {}\n}';
    writeFileSync(join(home, "models.json"), content);

    await Effect.runPromise(adapter.startSession(SESSION, SPEC, ctx));

    expect(loaded[0]!.models).toBe(content);
  });

  it("fails the start, and spawns no agent, when the home's models file cannot be read", async () => {
    const run = createDriving();
    const ctx = { ...run.ctx, ...OPENROUTER, catalogModels: [ONE] };
    // A directory where the file should be makes the read fail.
    mkdirSync(join(ctx.home, "models.json"));

    const failed = await Effect.runPromise(
      Effect.flip(run.adapter.startSession(SESSION, buildSpecOn(ONE.slug), ctx)),
    );

    expect(failed).toMatchObject({ _tag: "AdapterFailed" });
    expect(listAgentSpawns(run.spawns)).toEqual([]);
  });

  it("fails the start with pi's reason when pi cannot list the models it ships", async () => {
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
    const { adapter, loaded, spawns } = buildRecordingPi(HOLDS_THE_CHECK);
    const first = { ...buildContext(home), ...OPENROUTER, catalogModels: [ONE] };
    const second = { ...first, catalogModels: [TWO] };

    const firstStart = Effect.runPromise(
      adapter.startSession(SESSION, buildSpecOn(ONE.slug), first),
    );
    const secondStart = Effect.runPromise(
      adapter.startSession(OTHER_SESSION, buildSpecOn(TWO.slug), second),
    );
    // Neither start waits for the other: both pis run before either answers.
    await waitUntil("spawned both pis", () => listAgentSpawns(spawns).length === 2);
    answerStarted(listAgentSpawns(spawns)[0]!, ONE.slug);
    answerStarted(listAgentSpawns(spawns)[1]!, TWO.slug);
    await Promise.all([firstStart, secondStart]);

    expect(loaded.map((one) => listDeclaredIds(one.models))).toEqual([[ONE.slug], [TWO.slug]]);
    expect(new Set(loaded.map((one) => one.folder)).size).toBe(2);
  });

  it("keeps the model store a launch copied, while a refresh stores a new one in the home", async () => {
    const home = createPiHome();
    const storePath = join(home, "models-store.json");
    writeFileSync(storePath, "OLD");
    const { adapter, loaded, spawns } = buildRecordingPi({
      ...HOLDS_THE_CHECK,
      ran: (command, env) => {
        if (command[1] === "auth") {
          return { code: 0, stdout: JSON.stringify({ status: "ready" }), stderr: "" };
        }
        if (command[1] !== "update") return undefined;
        writeFileSync(join(env["PI_CODING_AGENT_DIR"]!, "models-store.json"), "NEW");
        return undefined;
      },
    });
    const ctx = { ...buildContext(home), ...OPENROUTER, catalogModels: [ONE] };

    const start = Effect.runPromise(adapter.startSession(SESSION, buildSpecOn(ONE.slug), ctx));
    await waitUntil("spawned the pi", () => listAgentSpawns(spawns).length === 1);
    await Effect.runPromise(adapter.probe(ctx, { readUsage: false }));

    // The refresh does not wait for the launch, and the launch's pi keeps the
    // store it was spawned with.
    expect(readFileSync(storePath, "utf8")).toBe("NEW");
    expect(readFileSync(join(loaded[0]!.folder, "models-store.json"), "utf8")).toBe("OLD");

    answerStarted(listAgentSpawns(spawns)[0]!, ONE.slug);
    await start;
  });

  it("keeps the folder of a session until its subagent's pi has exited too", async () => {
    const run = await startBusySession({ lingers: true });
    const folder = agentFolderOf(run.child);
    askForSubagent(run.child);
    await waitUntil("spawned the subagent", () => listAgentSpawns(run.spawns).length === 2);
    const subagent = listAgentSpawns(run.spawns)[1]!;

    run.child.crash();
    await waitUntil(
      "said the session ended",
      () => filterByTag(run.seen, "session.exited").length === 1,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(folder)).toBe(true);

    subagent.crash();
    await waitUntil("removed the folder", () => !existsSync(folder));
  });
});

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

describe("a subagent of a session that declares the catalog", () => {
  /** Starts a session declaring ONE, and records the model files each pi is spawned with. */
  const startParent = async (behaviour: FakePiBehaviour = {}) => {
    const loaded: Array<Loaded> = [];
    const run = await startBusySession(
      {
        ...behaviour,
        answers: { ...answerShippedModels("openrouter", ["shipped/model"]), ...behaviour.answers },
        atSpawn: (env) => {
          const folder = env["PI_CODING_AGENT_DIR"];
          if (folder === undefined || !basename(folder).startsWith("hercule-pi-agent-")) return;
          loaded.push({
            folder,
            models: readIfPresent(join(folder, "models.json")),
            store: readIfPresent(join(folder, "models-store.json")),
          });
        },
      },
      buildSpecOn(ONE.slug),
      {},
      { ...OPENROUTER, catalogModels: [ONE] },
    );
    return { run, loaded };
  };

  it("runs in its parent's folder, so it loads its parent's declarations, even after another start with another catalog", async () => {
    const { run, loaded } = await startParent();
    await Effect.runPromise(
      run.adapter.startSession(OTHER_SESSION, buildSpecOn(TWO.slug), {
        ...run.ctx,
        ...OPENROUTER,
        catalogModels: [TWO],
      }),
    );
    const spawnsBefore = run.spawns.length;

    askForSubagent(run.child);
    await waitUntil(
      "started the subagent",
      () => filterByTag(run.seen, "subagent.started").length === 1,
    );

    const subagentSpawn = loaded.find((one) => one.folder === agentFolderOf(run.child))!;
    expect(loaded.filter((one) => one.folder === agentFolderOf(run.child))).toHaveLength(2);
    expect(listDeclaredIds(subagentSpawn.models)).toEqual([ONE.slug]);
    // It declared and listed nothing again: its pi is the only new process.
    expect(run.spawns).toHaveLength(spawnsBefore + 1);
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

  describe("when the session ends while pi checks the subagent's model", () => {
    /** Starts a parent whose own check passes and whose subagent's check waits for the test. */
    const startWithHeldSubagentCheck = async () => {
      let asked = 0;
      const { run } = await startParent({
        answers: {
          get_state: () =>
            asked++ === 0
              ? { success: true, data: { model: { provider: "openrouter", id: ONE.slug } } }
              : undefined,
        },
      });
      askForSubagent(run.child);
      await waitUntil("spawned the subagent's pi", () => listAgentSpawns(run.spawns).length === 2);
      return { run, subagent: listAgentSpawns(run.spawns)[1]! };
    };

    it("sends no task to a subagent whose session is stopped", async () => {
      const { run, subagent } = await startWithHeldSubagentCheck();

      answerStarted(subagent, ONE.slug);
      await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(subagent.sent.some((one) => one.type === "prompt")).toBe(false);
      expect(subagent.stdinClosed()).toBe(true);
    });

    it("sends no task to a subagent whose parent's turn is interrupted", async () => {
      const { run, subagent } = await startWithHeldSubagentCheck();

      await Effect.runPromise(run.adapter.interrupt(SESSION));
      answerStarted(subagent, ONE.slug);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(subagent.sent.some((one) => one.type === "prompt")).toBe(false);
      expect(subagent.stdinClosed()).toBe(true);
    });
  });
});
