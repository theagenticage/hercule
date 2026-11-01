/**
 * Tests how the runner finds the models pi ships for a provider, and when it
 * lists them again, with a fake pi so no vendor code runs.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { makeNativeModelLister } from "./native-models";
import {
  answerShippedModels,
  buildFakePiSeam,
  buildRefusal,
  cleanupHomes,
  createPiHome,
  type Answers,
} from "./testing";

afterAll(cleanupHomes);

const BINARY = "/usr/local/bin/pi";
const ENV = { PATH: "/usr/local/bin:/usr/bin" };

/** Builds a lister on a fake pi whose answer to the listing the test can change. */
const buildLister = (initial: Answers) => {
  let answers = initial;
  const fake = buildFakePiSeam({
    answers: {
      get_available_models: (command) => answers["get_available_models"]?.(command),
    },
  });
  return {
    spawns: fake.spawns,
    answerWith: (next: Answers) => {
      answers = next;
    },
    list: makeNativeModelLister(fake.seam.spawn),
  };
};

describe("listing the models pi ships for a provider", () => {
  it("returns the ids of the provider's models, and none of another provider's", async () => {
    const { list } = buildLister({
      get_available_models: () => ({
        success: true,
        data: {
          models: [
            { id: "vendor/a", name: "A", provider: "openrouter", input: ["text"] },
            { id: "vendor/b", name: "B", provider: "openrouter", input: ["text"] },
            { id: "glm-5.3", name: "GLM", provider: "zai", input: ["text"] },
          ],
        },
      }),
    });

    const ids = await Effect.runPromise(list(BINARY, createPiHome(), ENV, "openrouter"));

    expect([...ids]).toEqual(["vendor/a", "vendor/b"]);
  });

  it("lists once for a home while nothing changed, and once for starts that arrive together", async () => {
    const { list, spawns } = buildLister(answerShippedModels("openrouter", ["vendor/a"]));
    const home = createPiHome();

    const together = await Effect.runPromise(
      Effect.all([list(BINARY, home, ENV, "openrouter"), list(BINARY, home, ENV, "openrouter")], {
        concurrency: "unbounded",
      }),
    );
    await Effect.runPromise(list(BINARY, home, ENV, "openrouter"));

    expect(together.map((ids) => [...ids])).toEqual([["vendor/a"], ["vendor/a"]]);
    expect(spawns).toHaveLength(1);
  });

  it("keeps a separate list for each home", async () => {
    const { list, spawns } = buildLister(answerShippedModels("openrouter", ["vendor/a"]));

    await Effect.runPromise(list(BINARY, createPiHome(), ENV, "openrouter"));
    await Effect.runPromise(list(BINARY, createPiHome(), ENV, "openrouter"));

    expect(spawns).toHaveLength(2);
  });

  it("lists again when the home's model store changes, and not before", async () => {
    const { list, spawns, answerWith } = buildLister(
      answerShippedModels("openrouter", ["vendor/a"]),
    );
    const home = createPiHome();
    const store = join(home, "models-store.json");

    await Effect.runPromise(list(BINARY, home, ENV, "openrouter"));
    writeFileSync(store, "{}");
    const afterStoreAppeared = await Effect.runPromise(list(BINARY, home, ENV, "openrouter"));
    expect(spawns).toHaveLength(2);

    answerWith(answerShippedModels("openrouter", ["vendor/a", "vendor/new"]));
    await Effect.runPromise(list(BINARY, home, ENV, "openrouter"));
    expect(spawns).toHaveLength(2);

    writeFileSync(store, '{"refreshed":true}');
    const afterRefresh = await Effect.runPromise(list(BINARY, home, ENV, "openrouter"));

    expect(spawns).toHaveLength(3);
    expect([...afterStoreAppeared]).toEqual(["vendor/a"]);
    expect([...afterRefresh]).toEqual(["vendor/a", "vendor/new"]);
  });

  it("lists again when the pi binary changes", async () => {
    const { list, spawns } = buildLister(answerShippedModels("openrouter", ["vendor/a"]));
    const home = createPiHome();
    const binary = join(home, "pi");
    writeFileSync(binary, "version 1");

    await Effect.runPromise(list(binary, home, ENV, "openrouter"));
    writeFileSync(binary, "a longer version 2");
    await Effect.runPromise(list(binary, home, ENV, "openrouter"));

    expect(spawns).toHaveLength(2);
  });

  it("fails with pi's message, and tries again at the next call", async () => {
    const { list, spawns, answerWith } = buildLister({
      get_available_models: () => buildRefusal("pi is broken"),
    });
    const home = createPiHome();

    const failure = await Effect.runPromise(Effect.flip(list(BINARY, home, ENV, "openrouter")));
    answerWith(answerShippedModels("openrouter", ["vendor/a"]));
    const ids = await Effect.runPromise(list(BINARY, home, ENV, "openrouter"));

    expect(failure).toContain("pi is broken");
    expect([...ids]).toEqual(["vendor/a"]);
    expect(spawns).toHaveLength(2);
  });

  it("does not keep an empty list, which pi gives for a provider it has no key for", async () => {
    const { list, spawns, answerWith } = buildLister(answerShippedModels("openrouter", []));
    const home = createPiHome();

    await Effect.runPromise(list(BINARY, home, ENV, "openrouter"));
    answerWith(answerShippedModels("openrouter", ["vendor/a"]));
    const ids = await Effect.runPromise(list(BINARY, home, ENV, "openrouter"));

    expect([...ids]).toEqual(["vendor/a"]);
    expect(spawns).toHaveLength(2);
  });
});
