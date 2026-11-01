/**
 * Whether an account's Model Catalog opens the model browser or the picker.
 * It is a module of its own because the Providers page asks it, and must not
 * load the browser's logic (`model-browser.ts`) with it.
 */

/** An account whose catalog holds more models than this opens the browser, not the picker. */
const MAX_PICKER_CATALOG_MODELS = 40;

/**
 * Checks whether an account's catalog is large enough for the model browser.
 * An account with `modelCount` models above 40 opens the browser; a smaller
 * one opens the quick picker.
 */
export const opensModelBrowser = (modelCount: number): boolean =>
  modelCount > MAX_PICKER_CATALOG_MODELS;
