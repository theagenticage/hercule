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
import type { UnlistedModel } from "@hercule/protocol";

/** What setting the models of a provider asks the caller to do. */
export type ModelsFileUpdate =
  | { readonly _tag: "unchanged" }
  | {
      readonly _tag: "write";
      /** The complete new text of the file. */
      readonly text: string;
    }
  /**
   * The existing text is not a plain JSON object (pi also accepts comments,
   * for one), so this module cannot add models to it without dropping what it
   * holds. The caller must leave the file alone.
   */
  | { readonly _tag: "unreadable" };

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
const buildEntry = (model: UnlistedModel): JsonObject => ({
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
 * file. A leading byte-order mark is ignored, and so is a text of only white
 * space. Returns:
 *
 * - `unchanged` when `models` is empty or the new content equals the existing
 *   content, so the caller does not rewrite a file for nothing. An empty list
 *   does not clear the array: the controller sends no models for a harness
 *   that lists everything itself, and a start that carries none must leave the
 *   file alone.
 * - `unreadable` when the text is not a JSON object. pi accepts comments in
 *   the file and `JSON.parse` does not, so such a file may be fine for pi. The
 *   caller refuses it instead of replacing it, because other providers'
 *   overrides in it would be lost.
 * - `write` with the new text otherwise.
 */
export const replaceProviderModels = (
  existingText: string | undefined,
  provider: string,
  models: ReadonlyArray<UnlistedModel>,
): ModelsFileUpdate => {
  if (models.length === 0) return { _tag: "unchanged" };

  let existing: JsonObject = {};
  const content = existingText?.replace(/^\uFEFF/, "");
  if (content !== undefined && content.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(content);
      if (!isJsonObject(parsed)) return { _tag: "unreadable" };
      existing = parsed;
    } catch {
      return { _tag: "unreadable" };
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
  if (JSON.stringify(result) === JSON.stringify(existing)) return { _tag: "unchanged" };
  return { _tag: "write", text: `${JSON.stringify(result, null, 2)}\n` };
};
