/**
 * Tests the model browser's logic through its interface: which catalogs open
 * it, which models its search and facets keep, in what order, and how a row's
 * context and price read.
 */
import { describe, expect, it } from "vitest";
import type { ModelCatalogItem } from "@hercule/contract";
import { buildModelCatalogItem } from "../providers.testing";
import {
  NO_MODEL_FACETS,
  browseModels,
  describeContextWindow,
  describeModelPrice,
  hasActiveFacets,
  indexModelCatalog,
  type ModelBrowserQuery,
  type ModelFacets,
} from "./model-browser";

const IMAGES = { maxBytes: null };

// An OpenRouter-shaped catalog. "mystery" has no details at all, as a model
// the source describes only by its id would.
const CATALOG: readonly ModelCatalogItem[] = [
  buildModelCatalogItem("anthropic/claude-sonnet-5-5", {
    name: "Claude Sonnet 5.5",
    maker: "Anthropic",
    contextWindow: 1_000_000,
    inputPrice: 3,
    outputPrice: 15,
    releasedAt: "2026-10-01T00:00:00.000Z",
    tools: true,
    reasoning: true,
    imageInput: IMAGES,
  }),
  buildModelCatalogItem("google/gemini-3-flash", {
    name: "Gemini 3 Flash",
    maker: "Google",
    contextWindow: 1_048_576,
    inputPrice: 0.075,
    outputPrice: 0.3,
    releasedAt: "2026-10-20T00:00:00.000Z",
    tools: true,
    reasoning: false,
    imageInput: IMAGES,
  }),
  buildModelCatalogItem("moonshotai/kimi-k3.1-pro", {
    name: "Kimi K3.1 Pro",
    maker: "Moonshot",
    contextWindow: 262_144,
    inputPrice: 2,
    outputPrice: 10,
    releasedAt: "2026-10-23T00:00:00.000Z",
    tools: true,
    reasoning: true,
  }),
  buildModelCatalogItem("meta-llama/llama-4-free:free", {
    name: "Llama 4 (free)",
    maker: "Meta",
    contextWindow: 131_072,
    inputPrice: 0,
    outputPrice: 0,
    releasedAt: "2026-06-01T00:00:00.000Z",
    tools: false,
    reasoning: false,
  }),
  buildModelCatalogItem("meta-llama/llama-4-scout", {
    name: "Llama 4 Scout",
    maker: "Meta",
    contextWindow: 200_000,
    inputPrice: 0.1,
    outputPrice: 0.4,
    releasedAt: "2026-06-01T00:00:00.000Z",
    imageInput: IMAGES,
  }),
  buildModelCatalogItem("mystery/model", {
    name: "Mystery",
    firstSeenAt: "2026-10-25T00:00:00.000Z",
  }),
];

const INDEX = indexModelCatalog(CATALOG);

const browse = (
  query: Partial<Omit<ModelBrowserQuery, "facets">> & { facets?: Partial<ModelFacets> } = {},
): string[] =>
  browseModels(INDEX, {
    search: "",
    sort: "newest",
    ...query,
    facets: { ...NO_MODEL_FACETS, ...query.facets },
  }).map(({ slug }) => slug);

describe("browseModels", () => {
  it("lists every model, the newest first, for an empty query", () => {
    expect(browse()).toEqual([
      "mystery/model",
      "moonshotai/kimi-k3.1-pro",
      "google/gemini-3-flash",
      "anthropic/claude-sonnet-5-5",
      "meta-llama/llama-4-free:free",
      "meta-llama/llama-4-scout",
    ]);
  });

  it("dates a model by its first sighting when the catalog gives no release", () => {
    expect(browse()[0]).toBe("mystery/model");
  });

  it("searches name, slug and maker, needing every word, ignoring case", () => {
    expect(browse({ search: "KIMI" })).toEqual(["moonshotai/kimi-k3.1-pro"]);
    expect(browse({ search: "llama free" })).toEqual(["meta-llama/llama-4-free:free"]);
    expect(browse({ search: "google" })).toEqual(["google/gemini-3-flash"]);
    expect(browse({ search: "  meta   scout " })).toEqual(["meta-llama/llama-4-scout"]);
    expect(browse({ search: "nothing like it" })).toEqual([]);
  });

  it("keeps the models of the chosen makers, and never one without a maker", () => {
    expect(browse({ facets: { makers: ["Meta", "Google"] }, sort: "name" })).toEqual([
      "google/gemini-3-flash",
      "meta-llama/llama-4-free:free",
      "meta-llama/llama-4-scout",
    ]);
  });

  it("requires every ability that is turned on, and an unknown one fails", () => {
    expect(browse({ facets: { tools: true } })).toEqual([
      "moonshotai/kimi-k3.1-pro",
      "google/gemini-3-flash",
      "anthropic/claude-sonnet-5-5",
    ]);
    expect(browse({ facets: { images: true } })).toEqual([
      "google/gemini-3-flash",
      "anthropic/claude-sonnet-5-5",
      "meta-llama/llama-4-scout",
    ]);
    expect(browse({ facets: { tools: true, images: true, reasoning: true } })).toEqual([
      "anthropic/claude-sonnet-5-5",
    ]);
  });

  it("keeps models whose context window reaches the minimum", () => {
    expect(browse({ facets: { minContextWindow: 200_000 }, sort: "name" })).toEqual([
      "anthropic/claude-sonnet-5-5",
      "google/gemini-3-flash",
      "moonshotai/kimi-k3.1-pro",
      "meta-llama/llama-4-scout",
    ]);
    expect(browse({ facets: { minContextWindow: 1_000_000 }, sort: "name" })).toEqual([
      "anthropic/claude-sonnet-5-5",
      "google/gemini-3-flash",
    ]);
  });

  it("keeps models with an input price under the ceiling, free ones included, unknown ones never", () => {
    expect(browse({ facets: { maxInputPrice: 1 }, sort: "price" })).toEqual([
      "meta-llama/llama-4-free:free",
      "google/gemini-3-flash",
      "meta-llama/llama-4-scout",
    ]);
    // Kimi costs exactly $2 and the ceiling is strict; Sonnet costs $3.
    expect(browse({ facets: { maxInputPrice: 5 }, sort: "price" })).toHaveLength(5);
    expect(browse({ facets: { maxInputPrice: 2 }, sort: "price" })).not.toContain(
      "moonshotai/kimi-k3.1-pro",
    );
  });

  it("combines the search with the facets", () => {
    expect(browse({ search: "llama", facets: { images: true } })).toEqual([
      "meta-llama/llama-4-scout",
    ]);
  });

  it("sorts by input price, cheapest first, unknown last", () => {
    expect(browse({ sort: "price" })).toEqual([
      "meta-llama/llama-4-free:free",
      "google/gemini-3-flash",
      "meta-llama/llama-4-scout",
      "moonshotai/kimi-k3.1-pro",
      "anthropic/claude-sonnet-5-5",
      "mystery/model",
    ]);
  });

  it("sorts by context window, longest first, unknown last", () => {
    expect(browse({ sort: "context" })).toEqual([
      "google/gemini-3-flash",
      "anthropic/claude-sonnet-5-5",
      "moonshotai/kimi-k3.1-pro",
      "meta-llama/llama-4-scout",
      "meta-llama/llama-4-free:free",
      "mystery/model",
    ]);
  });

  it("sorts by name, and breaks a tie by slug", () => {
    const twins = indexModelCatalog([
      buildModelCatalogItem("b/twin", { name: "Twin" }),
      buildModelCatalogItem("a/twin", { name: "Twin" }),
      buildModelCatalogItem("c/alpha", { name: "alpha" }),
    ]);
    const query: ModelBrowserQuery = { search: "", facets: NO_MODEL_FACETS, sort: "name" };
    expect(browseModels(twins, query).map(({ slug }) => slug)).toEqual([
      "c/alpha",
      "a/twin",
      "b/twin",
    ]);
  });

  it("breaks a tie in price by name", () => {
    expect(browse({ sort: "price", facets: { makers: ["Meta"] } })).toEqual([
      "meta-llama/llama-4-free:free",
      "meta-llama/llama-4-scout",
    ]);
    const tied = indexModelCatalog([
      buildModelCatalogItem("z", { name: "Zed", inputPrice: 1 }),
      buildModelCatalogItem("a", { name: "Ada", inputPrice: 1 }),
    ]);
    const query: ModelBrowserQuery = { search: "", facets: NO_MODEL_FACETS, sort: "price" };
    expect(browseModels(tied, query).map(({ slug }) => slug)).toEqual(["a", "z"]);
  });
});

describe("indexModelCatalog", () => {
  it("lists every maker with its count, the biggest first, equal counts by name", () => {
    const index = indexModelCatalog([
      buildModelCatalogItem("1", { maker: "Zeta" }),
      buildModelCatalogItem("2", { maker: "Acme" }),
      buildModelCatalogItem("3", { maker: "Big" }),
      buildModelCatalogItem("4", { maker: "Big" }),
      buildModelCatalogItem("5"),
    ]);
    expect(index.makers).toEqual([
      { name: "Big", count: 2 },
      { name: "Acme", count: 1 },
      { name: "Zeta", count: 1 },
    ]);
    expect(index.modelCount).toBe(5);
  });
});

describe("hasActiveFacets", () => {
  it("is false until something is chosen", () => {
    expect(hasActiveFacets(NO_MODEL_FACETS)).toBe(false);
    expect(hasActiveFacets({ ...NO_MODEL_FACETS, makers: ["Meta"] })).toBe(true);
    expect(hasActiveFacets({ ...NO_MODEL_FACETS, reasoning: true })).toBe(true);
    expect(hasActiveFacets({ ...NO_MODEL_FACETS, minContextWindow: 200_000 })).toBe(true);
    expect(hasActiveFacets({ ...NO_MODEL_FACETS, maxInputPrice: 1 })).toBe(true);
  });
});

describe("describeContextWindow", () => {
  const describeTokens = (contextWindow: number): string =>
    describeContextWindow(buildModelCatalogItem("m", { contextWindow }));

  it("reads the window the way its maker states it", () => {
    expect(describeTokens(200_000)).toBe("200K");
    expect(describeTokens(128_000)).toBe("128K");
    expect(describeTokens(131_072)).toBe("128K");
    expect(describeTokens(262_144)).toBe("256K");
    expect(describeTokens(1_000_000)).toBe("1M");
    expect(describeTokens(1_048_576)).toBe("1M");
    expect(describeTokens(1_572_864)).toBe("1.5M");
    expect(describeTokens(2_000_000)).toBe("2M");
  });

  it("shows a dash when the catalog does not say", () => {
    expect(describeContextWindow(buildModelCatalogItem("m"))).toBe("-");
  });
});

describe("describeModelPrice", () => {
  const describePrices = (inputPrice?: number, outputPrice?: number): string =>
    describeModelPrice(
      buildModelCatalogItem("m", {
        ...(inputPrice === undefined ? {} : { inputPrice }),
        ...(outputPrice === undefined ? {} : { outputPrice }),
      }),
    );

  it("shows input and output per million tokens", () => {
    expect(describePrices(3, 15)).toBe("$3 / $15");
    expect(describePrices(1.25, 10)).toBe("$1.25 / $10");
    expect(describePrices(0.1, 0.4)).toBe("$0.10 / $0.40");
    expect(describePrices(0.075, 0.3)).toBe("$0.075 / $0.30");
  });

  it("says free only when both sides are free", () => {
    expect(describePrices(0, 0)).toBe("free");
    expect(describePrices(0, 2)).toBe("free / $2");
  });

  it("shows a dash for a side the catalog does not price", () => {
    expect(describePrices()).toBe("- / -");
    expect(describePrices(3)).toBe("$3 / -");
  });
});
