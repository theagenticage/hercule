import { describe, expect, it } from "vitest";
import type { CatalogModel } from "@hercule/protocol";
import { replaceProviderModels, type ModelsFileUpdate } from "./models-file";

const buildModel = (slug: string, details: Partial<CatalogModel> = {}): CatalogModel => ({
  slug,
  name: `Name of ${slug}`,
  imageInput: null,
  options: [],
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

/** Replaces the models and parses the written text, failing the test when nothing is written. */
const replaceAndParse = (
  existing: string | undefined,
  models: ReadonlyArray<CatalogModel>,
  provider = "openrouter",
): WrittenFile => {
  const update = replaceProviderModels(existing, provider, models);
  if (update._tag !== "write") throw new Error("expected the file to be written");
  return JSON.parse(update.text) as WrittenFile;
};

describe("setting the models of a provider in pi's models.json", () => {
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

  it("writes nothing for an empty list, and does not clear the models already there", () => {
    const existing = JSON.stringify({ providers: { openrouter: { models: [{ id: "a/b" }] } } });
    expect(replaceProviderModels(undefined, "openrouter", [])).toEqual<ModelsFileUpdate>({
      _tag: "unchanged",
    });
    expect(replaceProviderModels(existing, "openrouter", [])).toEqual<ModelsFileUpdate>({
      _tag: "unchanged",
    });
  });

  it("writes nothing when the new content equals the file, whatever its formatting", () => {
    const models = [buildModel("a/b", { contextWindow: 5000 })];
    const first = replaceProviderModels(undefined, "openrouter", models);
    if (first._tag !== "write") throw new Error("expected a write");
    const compact = JSON.stringify(JSON.parse(first.text));
    expect(replaceProviderModels(first.text, "openrouter", models)._tag).toBe("unchanged");
    expect(replaceProviderModels(compact, "openrouter", models)._tag).toBe("unchanged");
  });

  it("replaces a file that does not parse, and says it did", () => {
    for (const unreadable of ["{ not json", "[1, 2]", "42", "null", ""]) {
      const update = replaceProviderModels(unreadable, "openrouter", [buildModel("a/b")]);
      expect(update, unreadable).toMatchObject({ _tag: "write", replacedUnreadableFile: true });
    }
    expect(replaceAndParse("{ not json", [buildModel("a/b")])).toEqual({
      providers: { openrouter: { models: [expect.objectContaining({ id: "a/b" })] } },
    });
  });

  it("does not report a replaced file when the file was missing or readable", () => {
    expect(replaceProviderModels(undefined, "openrouter", [buildModel("a/b")])).toMatchObject({
      replacedUnreadableFile: false,
    });
    expect(replaceProviderModels("{}", "openrouter", [buildModel("a/b")])).toMatchObject({
      replacedUnreadableFile: false,
    });
  });
});
