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
import type { ModelDeclaration } from "@hercule/protocol";

/** What setting the models of a provider asks the caller to do. */
export type ModelsFileUpdate =
  | {
      readonly _tag: "write";
      /** The complete new text of the file. */
      readonly text: string;
    }
  /**
   * The existing text is not a plain JSON object (pi also accepts comments,
   * for one), and there are models to add. This module cannot add them without
   * dropping what the text holds, so the caller must refuse it.
   */
  | { readonly _tag: "unreadable" }
  /**
   * The existing text is not a plain JSON object, and there are no models to
   * add. The caller uses the text as it is.
   */
  | { readonly _tag: "unchanged" };

type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPositiveInteger = (value: number | undefined): value is number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0;

/**
 * Parses the text of a `models.json` to its JSON object. A missing file
 * (undefined), a text of only white space and a leading byte-order mark all
 * give what an empty file would: an empty object. Returns `undefined` when the
 * text is not a JSON object.
 */
const parseJsonObject = (text: string | undefined): JsonObject | undefined => {
  const content = text?.replace(/^\uFEFF/, "");
  if (content === undefined || content.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(content);
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Builds the `models.json` entry for one catalog model. The entry holds the
 * id, the name, the kinds of input, and each of the context window, the output
 * limit and the reasoning flag that the catalog gave and pi accepts.
 */
const buildEntry = (model: ModelDeclaration): JsonObject => ({
  id: model.slug,
  name: model.name,
  ...(isPositiveInteger(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
  ...(isPositiveInteger(model.outputLimit) ? { maxTokens: model.outputLimit } : {}),
  input: model.imageInput === null ? ["text"] : ["text", "image"],
  ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
});

/**
 * Sets the models of `provider` in the text of a `models.json` to the models of
 * `declarations` that pi does not ship, and returns the text to use.
 * `nativeIds` are the ids of the models pi ships for the provider. They are
 * left out, because a declaration with the id of a shipped model would
 * replace pi's own definition of it (its thinking levels, compatibility
 * settings and cost).
 *
 * - The provider's `models` array is replaced as a whole, in the order of
 *   `declarations`. A model listed twice takes its last details. Nothing to
 *   declare gives an empty array.
 * - Every other key of the file, every other key of the provider (such as
 *   `baseUrl`) and every other provider stay as they are.
 *
 * `existingText` is the file's current text, or undefined when there is no
 * file. A leading byte-order mark is ignored, and so is a text of only white
 * space. Returns `write` with the new text, except for a text that is not a
 * plain JSON object: pi accepts comments in the file and `JSON.parse` does
 * not, so such a file may be fine for pi. That gives `unreadable` when there
 * are models to declare, because other providers' overrides in it would be
 * lost, and `unchanged` when there are none.
 */
export const setProviderModels = (
  existingText: string | undefined,
  provider: string,
  declarations: ReadonlyArray<ModelDeclaration>,
  nativeIds: ReadonlySet<string>,
): ModelsFileUpdate => {
  const entries = new Map(
    declarations
      .filter((model) => !nativeIds.has(model.slug))
      .map((model) => [model.slug, buildEntry(model)]),
  );

  const existing = parseJsonObject(existingText);
  if (existing === undefined) {
    return entries.size === 0 ? { _tag: "unchanged" } : { _tag: "unreadable" };
  }

  const providers = isJsonObject(existing["providers"]) ? existing["providers"] : {};
  const current = isJsonObject(providers[provider]) ? providers[provider] : {};
  const result: JsonObject = {
    ...existing,
    providers: { ...providers, [provider]: { ...current, models: [...entries.values()] } },
  };
  return { _tag: "write", text: `${JSON.stringify(result, null, 2)}\n` };
};
