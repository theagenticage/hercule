/**
 * Tests which models the picker of a profile's section lists for a search:
 * every word must match, older models come last, and a long match list is cut.
 */
import { describe, expect, it } from "vitest";
import type { ModelCatalogItem } from "@hercule/contract";
import { MAX_PICKER_MODELS, searchPickerModels } from "./catalog-search";

const buildItem = (slug: string, name: string, isLegacy?: boolean): ModelCatalogItem => ({
  slug,
  name,
  imageInput: null,
  options: [],
  ...(isLegacy === undefined ? {} : { isLegacy }),
  firstSeenAt: "2026-09-05T09:00:00.000Z",
});

const CATALOG = [
  buildItem("opus-4-8", "Opus 4.8", true),
  buildItem("opus-5-5", "Opus 5.5"),
  buildItem("sonnet-5-5", "Sonnet 5.5"),
  buildItem("haiku-5-5", "Haiku 5.5"),
];

const slugs = (models: readonly ModelCatalogItem[]): string[] => models.map(({ slug }) => slug);

describe("searchPickerModels", () => {
  it("lists every model for a blank search, the older ones after the current ones", () => {
    expect(slugs(searchPickerModels(CATALOG, "  ").models)).toEqual([
      "opus-5-5",
      "sonnet-5-5",
      "haiku-5-5",
      "opus-4-8",
    ]);
  });

  it("matches the name or the slug, ignoring case, and needs every word", () => {
    expect(slugs(searchPickerModels(CATALOG, "SONNET").models)).toEqual(["sonnet-5-5"]);
    expect(slugs(searchPickerModels(CATALOG, "opus 5").models)).toEqual(["opus-5-5"]);
    expect(slugs(searchPickerModels(CATALOG, "5-5 haiku").models)).toEqual(["haiku-5-5"]);
    expect(searchPickerModels(CATALOG, "gpt").models).toEqual([]);
  });

  it("cuts a long list and counts what it left out", () => {
    const many = Array.from({ length: MAX_PICKER_MODELS + 5 }, (_, index) =>
      buildItem(`m-${index}`, `Model ${index}`),
    );

    const result = searchPickerModels(many, "");

    expect(result.models).toHaveLength(MAX_PICKER_MODELS);
    expect(result.hiddenCount).toBe(5);
  });
});
