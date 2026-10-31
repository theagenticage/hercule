/**
 * The content of pi's `models.json`, the file where a user declares models pi
 * does not ship. pi reads it from its agent directory when it builds its model
 * list. This module only computes the file's new text; reading and writing it
 * is the adapter's job.
 *
 * pi is strict about the file. One entry that breaks its schema makes pi
 * ignore the whole file, and an entry with a number it cannot use (such as a
 * context window of 0) makes pi drop the whole provider. So an entry carries
 * only values that are valid, and a value that is missing or invalid is left
 * out, which gives the model pi's own default for it.
 */
import type { CatalogModel } from "@hercule/protocol";

/** What setting the models of a provider asks the caller to do. */
export type ModelsFileUpdate =
  | { readonly _tag: "unchanged" }
  | {
      readonly _tag: "write";
      /** The complete new text of the file. */
      readonly text: string;
      /** True when the existing text was not a JSON object, so none of it was kept. */
      readonly replacedUnreadableFile: boolean;
    };

type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPositiveInteger = (value: number | undefined): value is number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0;

/**
 * Builds the `models.json` entry for one catalog model. The entry holds the
 * id, the name, the kinds of input, and each of the context window, the output
 * limit and the reasoning flag that the catalog gave and pi accepts.
 */
const buildEntry = (model: CatalogModel): JsonObject => ({
  id: model.slug,
  name: model.name,
  ...(isPositiveInteger(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
  ...(isPositiveInteger(model.outputLimit) ? { maxTokens: model.outputLimit } : {}),
  input: model.imageInput === null ? ["text"] : ["text", "image"],
  ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
});

/**
 * Sets the models of `provider` in the text of a `models.json` to exactly
 * `models`, and returns what to write.
 *
 * - The provider's `models` array is replaced as a whole. Hercule owns that
 *   array in its Harness Home. An entry kept from an earlier start would
 *   override pi's own definition of a model that pi ships (its thinking
 *   levels, compatibility settings and cost), and pi's own list is what the
 *   controller compares the catalog with, so every model it sends is one pi
 *   lacks. A model listed twice takes its last details.
 * - Every other key of the file, every other key of the provider (such as
 *   `baseUrl`) and every other provider stay as they are.
 *
 * `existingText` is the file's current text, or undefined when there is no
 * file. Returns `unchanged` when `models` is empty or the new content equals
 * the existing content, so the caller does not rewrite a file for nothing.
 * An empty list does not clear the array: the controller sends no models for a
 * harness that lists everything itself, and a start that carries none must
 * leave the file alone. Text that does not parse as a JSON object is replaced
 * by a file holding only `models`: pi would ignore such a file anyway, and
 * `replacedUnreadableFile` lets the caller say so.
 */
export const replaceProviderModels = (
  existingText: string | undefined,
  provider: string,
  models: ReadonlyArray<CatalogModel>,
): ModelsFileUpdate => {
  if (models.length === 0) return { _tag: "unchanged" };

  let existing: JsonObject = {};
  let replacedUnreadableFile = false;
  if (existingText !== undefined) {
    try {
      const parsed: unknown = JSON.parse(existingText);
      if (isJsonObject(parsed)) existing = parsed;
      else replacedUnreadableFile = true;
    } catch {
      replacedUnreadableFile = true;
    }
  }

  const entries = new Map(models.map((model) => [model.slug, buildEntry(model)]));
  const providers = isJsonObject(existing["providers"]) ? existing["providers"] : {};
  const current = isJsonObject(providers[provider]) ? providers[provider] : {};

  const result: JsonObject = {
    ...existing,
    providers: { ...providers, [provider]: { ...current, models: [...entries.values()] } },
  };
  // Compared as parsed content, not as text, so a file formatted by hand is
  // not rewritten when nothing in it changes.
  if (!replacedUnreadableFile && JSON.stringify(result) === JSON.stringify(existing)) {
    return { _tag: "unchanged" };
  }
  return { _tag: "write", text: `${JSON.stringify(result, null, 2)}\n`, replacedUnreadableFile };
};
