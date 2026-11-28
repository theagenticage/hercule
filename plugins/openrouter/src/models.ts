import { Schema } from "effect";
import { CatalogModel, type ParseCatalogBody } from "@hercule/plugin-host";

/** The body of OpenRouter's model lists: `data` holds the items, which are read one by one and field by field. */
const ModelsBody = Schema.Struct({ data: Schema.Array(Schema.Unknown) });

const decodeModelsBody = Schema.decodeUnknownSync(ModelsBody);

const isCatalogModel = Schema.is(CatalogModel);

/** Checks a text against the limits of a catalog model's `slug`, `name` and `maker`. */
const isFact = Schema.is(CatalogModel.fields.slug);

type Item = { readonly [key: string]: unknown };

/** Returns whether `value` is a JSON object, and not `null` or an array. */
const isItem = (value: unknown): value is Item =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Returns the field `key` of `value` when `value` is an object, and nothing otherwise. */
const readField = (value: unknown, key: string): unknown =>
  isItem(value) ? value[key] : undefined;

/** Returns `value` when it is a finite number, and nothing otherwise. */
const readNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Returns `value` when it is a whole number above zero, and nothing otherwise. */
const readPositiveInteger = (value: unknown): number | undefined => {
  const number = readNumber(value);
  return number !== undefined && Number.isInteger(number) && number > 0 ? number : undefined;
};

/** Returns the strings of `value` when it is an array, and nothing otherwise. */
const readStrings = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;

/**
 * Converts a price in US dollars per token to US dollars per million tokens.
 * OpenRouter sends it as a string, and a number is read the same way. Returns
 * nothing when it is neither, or not a finite number of at least zero, which
 * covers the `"-1"` OpenRouter sends for a price that varies. The result keeps
 * 12 significant digits, because multiplying by a million in floating point
 * gives noise such as 0.15000000000000002 for `"0.00000015"`.
 */
const convertPrice = (pricePerToken: unknown): number | undefined => {
  if (
    typeof pricePerToken === "string"
      ? pricePerToken.trim() === ""
      : typeof pricePerToken !== "number"
  ) {
    return undefined;
  }
  const perMillion = Number(pricePerToken) * 1_000_000;
  return Number.isFinite(perMillion) && perMillion >= 0
    ? Number(perMillion.toPrecision(12))
    : undefined;
};

/**
 * Converts `created`, in seconds since the epoch, to a timestamp. Returns
 * nothing when it is not a positive number or does not make a date with a
 * four-digit year. The last case catches a value sent in milliseconds, which
 * read as seconds is the year 33658.
 */
const convertCreated = (created: unknown): string | undefined => {
  const seconds = readNumber(created);
  if (seconds === undefined || seconds <= 0) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) || date.getUTCFullYear() > 9999
    ? undefined
    : date.toISOString();
};

/**
 * Splits `Maker: Model name` at its first `: `. A name with no maker, such as
 * "Auto Router", comes back whole with no maker: the maker is never guessed
 * from the id.
 */
const splitName = (name: string): { readonly maker?: string; readonly name: string } => {
  const separator = name.indexOf(": ");
  if (separator <= 0 || separator + 2 >= name.length) return { name };
  return { maker: name.slice(0, separator), name: name.slice(separator + 2) };
};

/**
 * Builds the catalog model for one item, reading each field on its own so that
 * a field of an unexpected type is left out and the rest of the model stays.
 * Returns nothing when `id` is not a usable slug. A name that is missing or not
 * usable is replaced by the id, and a maker that is not usable is left out.
 */
const buildCatalogModel = (item: Item): CatalogModel | undefined => {
  const { id } = item;
  if (typeof id !== "string" || !isFact(id)) return undefined;
  const { maker, name } = splitName(isFact(item.name) ? item.name : id);
  const contextWindow = readPositiveInteger(item.context_length);
  const outputLimit = readPositiveInteger(readField(item.top_provider, "max_completion_tokens"));
  const inputPrice = convertPrice(readField(item.pricing, "prompt"));
  const outputPrice = convertPrice(readField(item.pricing, "completion"));
  const releasedAt = convertCreated(item.created);
  const modalities = readStrings(readField(item.architecture, "input_modalities"));
  const parameters = readStrings(item.supported_parameters);
  return {
    slug: id,
    name,
    imageInput: modalities?.includes("image") ? { maxBytes: null } : null,
    options: [],
    ...(maker === undefined || !isFact(maker) ? {} : { maker }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(outputLimit === undefined ? {} : { outputLimit }),
    ...(inputPrice === undefined ? {} : { inputPrice }),
    ...(outputPrice === undefined ? {} : { outputPrice }),
    ...(releasedAt === undefined ? {} : { releasedAt }),
    // A model that lists no parameters at all is unknown, not unable.
    ...(parameters === undefined
      ? {}
      : { tools: parameters.includes("tools"), reasoning: parameters.includes("reasoning") }),
  };
};

/**
 * Turns the JSON answer of OpenRouter's model list (`GET /api/v1/models/user`)
 * into catalog models, in the order OpenRouter lists them.
 *
 * - `slug` is `id`. `maker` and `name` come from `name`, which reads
 *   `Maker: Model name`: the model name is kept without the maker, so a screen
 *   that shows both does not print the maker twice. A model with no usable
 *   name is shown by its id.
 * - Prices are US dollars per million tokens, and absent when OpenRouter sends
 *   none or `"-1"` (the price varies). A price sent as a number is read too.
 * - `tools` and `reasoning` come from `supported_parameters`, and a model that
 *   takes image input gets `imageInput: { maxBytes: null }`, because OpenRouter
 *   states no size limit.
 * - Each field is read on its own. A field of an unexpected type or out of
 *   range (a price, a count, or a date that is not in seconds) is left out of
 *   its model, and the model stays.
 * - An item whose `id` is not a usable slug, or that still does not make a
 *   valid `CatalogModel`, is left out.
 *
 * Throws when the answer is not an object with a `data` array, and when
 * `data` has items and none of them could be read ("OpenRouter listed N
 * models and none could be read"). A parser cannot log, so the throw lets the
 * caller record an unavailable read and keep the last good models, where an
 * empty list would replace them. The caller records both as a failed read.
 */
export const parseModelsBody: ParseCatalogBody = (body) => {
  const { data } = decodeModelsBody(body);
  const models: Array<CatalogModel> = [];
  for (const item of data) {
    const model = isItem(item) ? buildCatalogModel(item) : undefined;
    if (model !== undefined && isCatalogModel(model)) models.push(model);
  }
  if (data.length > 0 && models.length === 0) {
    throw new Error(`OpenRouter listed ${data.length} models and none could be read`);
  }
  return models;
};
