/**
 * Searches models by name, slug and maker. The picker of a Model Profile's section
 * and the composer's model menu use the same search, so a text finds the same
 * models in both.
 */
import type { ModelCatalogItem } from "@hercule/contract";

/** The most models the picker lists at once; a catalog can hold hundreds. */
export const MAX_PICKER_MODELS = 60;

/** The models the picker lists for a search, and how many more match but are not listed. */
export interface PickerModels {
  readonly models: readonly ModelCatalogItem[];
  readonly hiddenCount: number;
}

/** The words of a search text, lowercased. A blank text has none. */
export const splitSearchWords = (query: string): string[] =>
  query.toLowerCase().split(/\s+/).filter(Boolean);

/**
 * Builds the lowercased text that a search looks in: the model's name, slug
 * and maker. A caller that searches the same models many times builds it once
 * per model and checks it with `containsEveryWord`.
 */
export const buildModelSearchText = (model: {
  readonly name: string;
  readonly slug: string;
  readonly maker?: string | undefined;
}): string => `${model.name} ${model.slug} ${model.maker ?? ""}`.toLowerCase();

/** Checks that `text`, already lowercased, contains every one of `words`. */
export const containsEveryWord = (text: string, words: readonly string[]): boolean =>
  words.every((word) => text.includes(word));

/**
 * Checks that the model's name, slug or maker contains every word of `query`,
 * ignoring case. A blank query matches every model.
 */
export const matchesModelSearch = (
  model: {
    readonly name: string;
    readonly slug: string;
    readonly maker?: string | undefined;
  },
  query: string,
): boolean => containsEveryWord(buildModelSearchText(model), splitSearchWords(query));

/**
 * Returns the models of `catalog` that match `query` (`matchesModelSearch`), at most `MAX_PICKER_MODELS` of them, with the count
 * of those left out. A blank query matches every model. The catalog's order
 * is kept, except that the models the harness no longer lists (`isLegacy`)
 * come after the current ones.
 */
export const searchPickerModels = (
  catalog: readonly ModelCatalogItem[],
  query: string,
): PickerModels => {
  const matches = catalog.filter((model) => matchesModelSearch(model, query));
  const ordered = [
    ...matches.filter((model) => model.isLegacy !== true),
    ...matches.filter((model) => model.isLegacy === true),
  ];
  return {
    models: ordered.slice(0, MAX_PICKER_MODELS),
    hiddenCount: Math.max(0, ordered.length - MAX_PICKER_MODELS),
  };
};
