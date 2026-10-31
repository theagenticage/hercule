/**
 * Tests how the answer of OpenRouter's model list becomes catalog models, with
 * answers recorded from OpenRouter: eight items chosen for the cases the
 * mapping has to handle, and the whole list of 452 models.
 *
 * Both fixtures come from one unauthenticated `GET /api/v1/models` recorded on
 * 2026-10-31. The user list (`/api/v1/models/user`, which the plugin reads with
 * a key) has the same item shape.
 *
 * - `recorded-models-sample.json` holds the eight items verbatim, long
 *   descriptions included (OpenRouter already cuts them to about 200 characters).
 * - `recorded-models.json.gz` holds all 452 items, each reduced to the fields
 *   the parser reads, and gzipped, so the repository does not carry 800 KB of
 *   descriptions and benchmarks that no test looks at (215 KB reduced, 15 KB
 *   gzipped).
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { CatalogModel } from "@hercule/plugin-host";
import { parseModelsBody } from "./models";

const readFixture = (name: string): Buffer => readFileSync(new URL(name, import.meta.url));

/** Eight recorded items: a free model, two routers with a varying price, models with and without a maker, image input, no output limit, tools and reasoning. */
const SAMPLE: unknown = JSON.parse(readFixture("./recorded-models-sample.json").toString());

/** Parses the sample and returns the model with `slug`. */
const parseSampleModel = (slug: string) => {
  const model = parseModelsBody(SAMPLE).find((one) => one.slug === slug);
  if (model === undefined) throw new Error(`the sample has no model ${slug}`);
  return model;
};

describe("parseModelsBody", () => {
  it("keeps the order of the list and the count of the items", () => {
    expect(parseModelsBody(SAMPLE).map((model) => model.slug)).toEqual([
      "recursive/flint-v1.0:free",
      "openrouter/auto",
      "openrouter/fusion",
      "nvidia/nemotron-3.5-super-vl:free",
      "unbiased/pareto-26.10",
      "moonshotai/kimi-k3.1-pro",
      "particle-ai/particle-1",
      "rekaai/reka-edge",
    ]);
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
    const body: unknown = JSON.parse(
      gunzipSync(readFixture("./recorded-models.json.gz")).toString(),
    );

    const models = parseModelsBody(body);

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

  it("leaves out an item whose name is too long, and drops fields that are out of range", () => {
    const body = {
      data: [
        { id: "a/long", name: "x".repeat(513) },
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

  it.each([null, [], "models", {}, { data: "models" }, { data: null }])(
    "throws on a body that is not an object with a data array: %j",
    (body) => {
      expect(() => parseModelsBody(body)).toThrow();
    },
  );
});
