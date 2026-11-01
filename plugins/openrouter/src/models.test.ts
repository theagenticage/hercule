/**
 * Tests how the answer of OpenRouter's model list becomes catalog models, with
 * the whole list of 452 models recorded from OpenRouter.
 *
 * The recording is one unauthenticated `GET /api/v1/models` made on
 * 2026-10-31. The user list (`/api/v1/models/user`, which the plugin reads with
 * a key) has the same item shape. `recorded-models.json.gz` holds all 452 items,
 * each reduced to the fields the parser reads (id, name, created,
 * context_length, architecture.input_modalities, pricing.prompt and
 * pricing.completion, top_provider.max_completion_tokens, supported_parameters)
 * and gzipped, so the repository does not carry 800 KB of descriptions and
 * benchmarks that no test looks at. Most tests parse eight of its items,
 * chosen by id for the cases the mapping has to handle.
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { CatalogModel } from "@hercule/plugin-host";
import { parseModelsBody } from "./models";

/** The whole recorded answer, as OpenRouter sent it (reduced to the fields the parser reads). */
const RECORDED: unknown = JSON.parse(
  gunzipSync(readFileSync(new URL("./recorded-models.json.gz", import.meta.url))).toString(),
);

/** The ids of eight recorded items, in the order the tests expect them: a free model, two routers with a varying price, models with and without a maker, image input, no output limit, tools and reasoning. */
const SAMPLE_IDS = [
  "recursive/flint-v1.0:free",
  "openrouter/auto",
  "openrouter/fusion",
  "nvidia/nemotron-3.5-super-vl:free",
  "unbiased/pareto-26.10",
  "moonshotai/kimi-k3.1-pro",
  "particle-ai/particle-1",
  "rekaai/reka-edge",
];

/** The recorded answer cut down to the raw items with `SAMPLE_IDS`, in that order. The items are picked on their raw id, never on parsed output. */
const SAMPLE: unknown = {
  data: SAMPLE_IDS.map((id) => {
    const item = (RECORDED as { data: ReadonlyArray<{ id: string }> }).data.find(
      (one) => one.id === id,
    );
    if (item === undefined) throw new Error(`the recording has no model ${id}`);
    return item;
  }),
};

/** Parses the sample and returns the model with `slug`. */
const parseSampleModel = (slug: string) => {
  const model = parseModelsBody(SAMPLE).find((one) => one.slug === slug);
  if (model === undefined) throw new Error(`the sample has no model ${slug}`);
  return model;
};

describe("parseModelsBody", () => {
  it("keeps the order of the list and the count of the items", () => {
    expect(parseModelsBody(SAMPLE).map((model) => model.slug)).toEqual(SAMPLE_IDS);
  });

  it("maps a free model with tools and reasoning, and takes the maker out of its name", () => {
    expect(parseSampleModel("recursive/flint-v1.0:free")).toEqual({
      slug: "recursive/flint-v1.0:free",
      name: "Flint (free)",
      maker: "Recursive",
      contextWindow: 262144,
      outputLimit: 235929,
      inputPrice: 0,
      outputPrice: 0,
      releasedAt: "2026-10-21T22:46:05.000Z",
      tools: true,
      reasoning: true,
      imageInput: null,
      options: [],
    });
  });

  it("maps image input, with no size limit", () => {
    expect(parseSampleModel("nvidia/nemotron-3.5-super-vl:free").imageInput).toEqual({
      maxBytes: null,
    });
    expect(parseSampleModel("recursive/flint-v1.0:free").imageInput).toBeNull();
  });

  it("leaves the prices out of a model whose price varies, and the output limit out of a model with none", () => {
    const auto = parseSampleModel("openrouter/auto");

    expect(auto).not.toHaveProperty("inputPrice");
    expect(auto).not.toHaveProperty("outputPrice");
    expect(auto).not.toHaveProperty("outputLimit");
    expect(auto.contextWindow).toBe(2000000);
  });

  it("gives no maker to a name without a 'Maker: ' prefix, and does not guess one from the id", () => {
    const auto = parseSampleModel("openrouter/auto");

    expect(auto.name).toBe("Auto Router");
    expect(auto).not.toHaveProperty("maker");
    expect(parseSampleModel("unbiased/pareto-26.10")).toMatchObject({
      name: "Pareto 26.10",
    });
    expect(parseSampleModel("unbiased/pareto-26.10")).not.toHaveProperty("maker");
  });

  it("reads tools and reasoning from the supported parameters, each on its own", () => {
    expect(parseSampleModel("unbiased/pareto-26.10")).toMatchObject({
      tools: true,
      reasoning: false,
    });
    expect(parseSampleModel("openrouter/fusion")).toMatchObject({
      tools: false,
      reasoning: false,
    });
  });

  it("converts prices to dollars per million tokens without floating point noise", () => {
    // 0.0000008 * 1_000_000 is 0.7999999999999999 in floating point.
    expect(parseSampleModel("unbiased/pareto-26.10")).toMatchObject({
      inputPrice: 0.8,
      outputPrice: 3.2,
    });
    expect(parseSampleModel("particle-ai/particle-1")).toMatchObject({
      inputPrice: 0.05,
      outputPrice: 0.5,
    });
    expect(parseSampleModel("moonshotai/kimi-k3.1-pro")).toMatchObject({
      inputPrice: 2,
      outputPrice: 10,
    });
  });

  it("parses the whole recorded list into models that the controller accepts", () => {
    const models = parseModelsBody(RECORDED);

    expect(models).toHaveLength(452);
    const decode = Schema.decodeUnknownSync(CatalogModel);
    for (const model of models) {
      expect(() => decode(model), model.slug).not.toThrow();
    }
    expect(new Set(models.map((model) => model.slug)).size).toBe(452);
  });

  it("leaves out an item that has no string id, and keeps the others", () => {
    const body = {
      data: [{ name: "No id", context_length: 8192 }, { id: 7 }, { id: "a/b", name: "A: B" }],
    };

    expect(parseModelsBody(body)).toEqual([
      { slug: "a/b", name: "B", maker: "A", imageInput: null, options: [] },
    ]);
  });

  it("shows a model with no name by its id", () => {
    expect(parseModelsBody({ data: [{ id: "a/b", name: null }] })).toEqual([
      { slug: "a/b", name: "a/b", imageInput: null, options: [] },
    ]);
  });

  it("shows a model whose name is too long by its id", () => {
    expect(parseModelsBody({ data: [{ id: "a/long", name: "x".repeat(513) }] })).toEqual([
      { slug: "a/long", name: "a/long", imageInput: null, options: [] },
    ]);
  });

  it("leaves out the fields that are out of range, and keeps the model", () => {
    const body = {
      data: [
        {
          id: "a/odd",
          name: "Odd",
          context_length: 0,
          created: -5,
          pricing: { prompt: "-1", completion: "free" },
          top_provider: { max_completion_tokens: 1.5 },
        },
      ],
    };

    expect(parseModelsBody(body)).toEqual([
      { slug: "a/odd", name: "Odd", imageInput: null, options: [] },
    ]);
  });

  it("keeps a model whose creation time is sent in milliseconds, without its release date", () => {
    // Read as seconds, this is the year 33658, which no timestamp can hold.
    const models = parseModelsBody({ data: [{ id: "a/b", name: "B", created: 1761000000000 }] });

    expect(models).toEqual([{ slug: "a/b", name: "B", imageInput: null, options: [] }]);
  });

  it("reads a price sent as a number or as a numeric string", () => {
    const models = parseModelsBody({
      data: [{ id: "a/b", pricing: { prompt: 0.0000008, completion: "0.0000032" } }],
    });

    expect(models[0]).toMatchObject({ inputPrice: 0.8, outputPrice: 3.2 });
  });

  it("drops only a field of the wrong type, and keeps the model and its other fields", () => {
    const models = parseModelsBody({
      data: [
        {
          id: "a/b",
          name: "A: B",
          context_length: "8192",
          created: "yesterday",
          architecture: "text",
          pricing: { prompt: { usd: 1 }, completion: "0.000002" },
          top_provider: null,
          supported_parameters: ["tools", 7],
        },
      ],
    });

    expect(models).toEqual([
      {
        slug: "a/b",
        name: "B",
        maker: "A",
        imageInput: null,
        options: [],
        outputPrice: 2,
        tools: true,
        reasoning: false,
      },
    ]);
  });

  it("throws, naming the count, when the list has items and none could be read", () => {
    expect(() => parseModelsBody({ data: [{ name: "No id" }, { id: 7 }, null] })).toThrow(
      "OpenRouter listed 3 models and none could be read",
    );
  });

  it("returns no models for an empty list", () => {
    expect(parseModelsBody({ data: [] })).toEqual([]);
  });

  it.each([null, [], "models", {}, { data: "models" }, { data: null }])(
    "throws on a body that is not an object with a data array: %j",
    (body) => {
      expect(() => parseModelsBody(body)).toThrow();
    },
  );
});
