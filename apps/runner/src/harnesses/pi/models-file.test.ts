import { describe, expect, it } from "vitest";
import type { ModelDeclaration } from "@hercule/protocol";
import { setProviderModels, type ModelsFileUpdate } from "./models-file";

const buildModel = (slug: string, details: Partial<ModelDeclaration> = {}): ModelDeclaration => ({
  slug,
  name: `Name of ${slug}`,
  imageInput: null,
  ...details,
});

/** The parts of a written file that the tests read. */
interface WrittenFile {
  readonly other?: boolean;
  readonly providers: Record<
    string,
    { readonly baseUrl?: string; readonly models?: ReadonlyArray<Record<string, unknown>> }
  >;
}

const NO_NATIVE_MODELS: ReadonlySet<string> = new Set();

/** Sets the models and parses the written text, failing the test when nothing is written. */
const replaceAndParse = (
  existing: string | undefined,
  models: ReadonlyArray<ModelDeclaration>,
  nativeIds: ReadonlySet<string> = NO_NATIVE_MODELS,
): WrittenFile => {
  const update = setProviderModels(existing, "openrouter", models, nativeIds);
  if (update._tag !== "write") throw new Error("expected the file to be written");
  return JSON.parse(update.text) as WrittenFile;
};

describe("declaring the models of a provider in pi's models.json", () => {
  it("builds a new file with the entry of a model whose details are all known", () => {
    const written = replaceAndParse(undefined, [
      buildModel("fake-vendor/fake-model:free", {
        name: "Fake: Model",
        contextWindow: 262_144,
        outputLimit: 65_536,
        imageInput: { maxBytes: null },
        reasoning: true,
      }),
    ]);
    expect(written).toEqual({
      providers: {
        openrouter: {
          models: [
            {
              id: "fake-vendor/fake-model:free",
              name: "Fake: Model",
              contextWindow: 262_144,
              maxTokens: 65_536,
              input: ["text", "image"],
              reasoning: true,
            },
          ],
        },
      },
    });
  });

  it("leaves out a detail the catalog did not give, so pi uses its default", () => {
    const written = replaceAndParse(undefined, [buildModel("a/b")]);
    expect(written.providers.openrouter!.models).toEqual([
      { id: "a/b", name: "Name of a/b", input: ["text"] },
    ]);
  });

  it("leaves out a number that pi would reject", () => {
    const written = replaceAndParse(undefined, [
      buildModel("zero", { contextWindow: 0, outputLimit: 1.5 }),
      buildModel("negative", { contextWindow: -4 }),
      buildModel("not-finite", { outputLimit: Number.POSITIVE_INFINITY }),
    ]);
    for (const entry of written.providers.openrouter!.models!) {
      expect(entry).not.toHaveProperty("contextWindow");
      expect(entry).not.toHaveProperty("maxTokens");
    }
  });

  it("keeps every other key of the file and of the provider", () => {
    const existing = JSON.stringify({
      providers: {
        openrouter: { baseUrl: "http://127.0.0.1:9", models: [] },
        zai: { baseUrl: "http://127.0.0.1:8" },
      },
      other: true,
    });
    const written = replaceAndParse(existing, [buildModel("a/b")]);
    expect(written.other).toBe(true);
    expect(written.providers.zai).toEqual({ baseUrl: "http://127.0.0.1:8" });
    expect(written.providers.openrouter!.baseUrl).toBe("http://127.0.0.1:9");
    expect(written.providers.openrouter!.models).toHaveLength(1);
  });

  it("replaces the provider's whole list, so an entry of an earlier start does not stay", () => {
    const existing = JSON.stringify({
      providers: {
        openrouter: {
          models: [
            { id: "old/one", name: "Old", contextWindow: 1000, input: ["text"] },
            { id: "dropped/two", name: "Dropped", input: ["text"] },
          ],
        },
      },
    });
    const written = replaceAndParse(existing, [
      buildModel("old/one", { name: "Fresh", outputLimit: 4096 }),
      buildModel("new/three"),
    ]);
    expect(written.providers.openrouter!.models).toEqual([
      { id: "old/one", name: "Fresh", maxTokens: 4096, input: ["text"] },
      { id: "new/three", name: "Name of new/three", input: ["text"] },
    ]);
  });

  it("takes the last details of a model listed twice", () => {
    const written = replaceAndParse(undefined, [
      buildModel("a/b", { name: "First" }),
      buildModel("a/b", { name: "Second" }),
    ]);
    expect(written.providers.openrouter!.models).toEqual([
      { id: "a/b", name: "Second", input: ["text"] },
    ]);
  });

  it("leaves out the models pi ships, so pi keeps its own definition of them", () => {
    const written = replaceAndParse(
      undefined,
      [buildModel("shipped/one"), buildModel("new/two"), buildModel("shipped/three")],
      new Set(["shipped/one", "shipped/three"]),
    );
    expect(written.providers.openrouter!.models!.map((entry) => entry["id"])).toEqual(["new/two"]);
  });

  it("empties the provider's list when nothing is left to declare, removing an earlier start's entries", () => {
    const existing = JSON.stringify({
      providers: { openrouter: { baseUrl: "http://127.0.0.1:9", models: [{ id: "old/one" }] } },
    });
    const written = replaceAndParse(
      existing,
      [buildModel("shipped/one")],
      new Set(["shipped/one"]),
    );
    expect(written.providers.openrouter).toEqual({ baseUrl: "http://127.0.0.1:9", models: [] });
    expect(replaceAndParse(existing, [])).toEqual(written);
  });

  it("creates no file and no entry when there is nothing to declare and nothing declared", () => {
    const noKey = JSON.stringify({ providers: { zai: { baseUrl: "http://x" } } });
    expect(
      setProviderModels(undefined, "openrouter", [], NO_NATIVE_MODELS),
    ).toEqual<ModelsFileUpdate>({
      _tag: "unchanged",
    });
    expect(setProviderModels(noKey, "openrouter", [], NO_NATIVE_MODELS)).toEqual<ModelsFileUpdate>({
      _tag: "unchanged",
    });
    expect(
      setProviderModels(
        JSON.stringify({ providers: { openrouter: { models: [] } } }),
        "openrouter",
        [],
        NO_NATIVE_MODELS,
      ),
    ).toEqual<ModelsFileUpdate>({ _tag: "unchanged" });
  });

  it("leaves a file with comments alone when there is nothing to declare", () => {
    expect(
      setProviderModels('{ // mine\n "providers": {} }', "openrouter", [], NO_NATIVE_MODELS),
    ).toEqual<ModelsFileUpdate>({ _tag: "unchanged" });
  });

  it("writes nothing when the new content equals the file, whatever its formatting", () => {
    const models = [buildModel("a/b", { contextWindow: 5000 })];
    const first = setProviderModels(undefined, "openrouter", models, NO_NATIVE_MODELS);
    if (first._tag !== "write") throw new Error("expected a write");
    const compact = JSON.stringify(JSON.parse(first.text));
    expect(setProviderModels(first.text, "openrouter", models, NO_NATIVE_MODELS)._tag).toBe(
      "unchanged",
    );
    expect(setProviderModels(compact, "openrouter", models, NO_NATIVE_MODELS)._tag).toBe(
      "unchanged",
    );
  });

  it("refuses a file that is not a plain JSON object, so what it holds is not lost", () => {
    // pi accepts comments, so a file that fails here may be a good one for pi.
    const withComment =
      '{\n  // my own models\n  "providers": { "zai": { "baseUrl": "http://x" } }\n}';
    for (const unreadable of ["{ not json", "[1, 2]", "42", "null", withComment]) {
      expect(
        setProviderModels(unreadable, "openrouter", [buildModel("a/b")], NO_NATIVE_MODELS),
        unreadable,
      ).toEqual<ModelsFileUpdate>({
        _tag: "unreadable",
      });
    }
  });

  it("reads a file that starts with a byte-order mark", () => {
    const existing = `\uFEFF${JSON.stringify({ other: true, providers: { zai: { baseUrl: "http://x" } } })}`;
    const written = replaceAndParse(existing, [buildModel("a/b")]);
    expect(written.other).toBe(true);
    expect(written.providers.zai).toEqual({ baseUrl: "http://x" });
    expect(written.providers.openrouter!.models).toHaveLength(1);
  });

  it("builds a new file when the existing one holds nothing but white space", () => {
    expect(replaceAndParse("  \n", [buildModel("a/b")]).providers.openrouter!.models).toHaveLength(
      1,
    );
  });
});
