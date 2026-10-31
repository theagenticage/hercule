/**
 * Searches models by name and slug. The picker of a Model Profile's section
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

/**
 * Checks that the model's name or slug contains every word of `query`,
 * ignoring case. A blank query matches every model.
 */
export const matchesModelSearch = (
  model: { readonly name: string; readonly slug: string },
  query: string,
): boolean => {
  const text = `${model.name} ${model.slug}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word));
};

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
