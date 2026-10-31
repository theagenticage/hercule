import { Schema } from "effect";
import { CatalogModel, type ParseCatalogBody } from "@hercule/plugin-host";

/** The body of OpenRouter's model lists: `data` holds the models, which are checked one by one. */
const ModelsBody = Schema.Struct({ data: Schema.Array(Schema.Unknown) });

const decodeModelsBody = Schema.decodeUnknownSync(ModelsBody);

/**
 * One item of `data`, reduced to the fields read here. Every field but `id` may
 * be absent or `null`, because OpenRouter sends `null` for what a model does
 * not have, such as `max_completion_tokens`.
 */
const ModelItem = Schema.Struct({
  id: Schema.String,
  /** `Maker: Model name`, or just the model name. */
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** When OpenRouter added the model, in seconds since the epoch. */
  created: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  context_length: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  architecture: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        input_modalities: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
      }),
    ),
  ),
  /** US dollars per token, as strings. `"-1"` means the price varies. */
  pricing: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        prompt: Schema.optionalKey(Schema.NullOr(Schema.String)),
        completion: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  top_provider: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        max_completion_tokens: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
      }),
    ),
  ),
  supported_parameters: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
});

type ModelItem = Schema.Schema.Type<typeof ModelItem>;

const isModelItem = Schema.is(ModelItem);

const isCatalogModel = Schema.is(CatalogModel);

/** Returns `value` when it is a whole number above zero, and nothing otherwise. */
const readPositiveInteger = (value: number | null | undefined): number | undefined =>
  value !== null && value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;

/**
 * Converts a price in US dollars per token, sent as a string, to US dollars per
 * million tokens. Returns nothing when it is not a finite number of at least
 * zero, which covers the `"-1"` OpenRouter sends for a price that varies. The
 * result keeps 12 significant digits, because multiplying by a million in
 * floating point gives noise such as 0.15000000000000002 for `"0.00000015"`.
 */
const convertPrice = (pricePerToken: string | null | undefined): number | undefined => {
  if (pricePerToken === null || pricePerToken === undefined || pricePerToken.trim() === "") {
    return undefined;
  }
  const perMillion = Number(pricePerToken) * 1_000_000;
  return Number.isFinite(perMillion) && perMillion >= 0
    ? Number(perMillion.toPrecision(12))
    : undefined;
};

/** Converts `created`, in seconds since the epoch, to a timestamp, or returns nothing when it is not a date. */
const convertCreated = (created: number | null | undefined): string | undefined => {
  if (created === null || created === undefined || created <= 0) return undefined;
  const date = new Date(created * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
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
 * Builds the catalog model for one item. The result may still be invalid, for
 * example when the name is longer than a catalog model allows, so the caller
 * checks it.
 */
const buildCatalogModel = (item: ModelItem): CatalogModel => {
  // A model with no name is shown by its id.
  const { maker, name } = splitName(
    item.name === null || item.name === undefined || item.name === "" ? item.id : item.name,
  );
  const contextWindow = readPositiveInteger(item.context_length);
  const outputLimit = readPositiveInteger(item.top_provider?.max_completion_tokens);
  const inputPrice = convertPrice(item.pricing?.prompt);
  const outputPrice = convertPrice(item.pricing?.completion);
  const releasedAt = convertCreated(item.created);
  const parameters = item.supported_parameters;
  return {
    slug: item.id,
    name,
    imageInput: item.architecture?.input_modalities?.includes("image") ? { maxBytes: null } : null,
    options: [],
    ...(maker === undefined ? {} : { maker }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(outputLimit === undefined ? {} : { outputLimit }),
    ...(inputPrice === undefined ? {} : { inputPrice }),
    ...(outputPrice === undefined ? {} : { outputPrice }),
    ...(releasedAt === undefined ? {} : { releasedAt }),
    // A model that lists no parameters at all is unknown, not unable.
    ...(parameters === null || parameters === undefined
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
 *   that shows both does not print the maker twice.
 * - Prices are US dollars per million tokens, and absent when OpenRouter sends
 *   none or `"-1"` (the price varies).
 * - `tools` and `reasoning` come from `supported_parameters`, and a model that
 *   takes image input gets `imageInput: { maxBytes: null }`, because OpenRouter
 *   states no size limit.
 * - An item with no string `id`, with a field of the wrong type, or that does
 *   not make a valid `CatalogModel` (a name longer than 512 characters, for
 *   example), is left out. A price, count or date that is out of range is left
 *   out of its model.
 *
 * Throws when the answer is not an object with a `data` array, which the caller
 * records as a failed read.
 */
export const parseModelsBody: ParseCatalogBody = (body) => {
  const models: Array<CatalogModel> = [];
  for (const item of decodeModelsBody(body).data) {
    if (!isModelItem(item)) continue;
    const model = buildCatalogModel(item);
    if (isCatalogModel(model)) models.push(model);
  }
  return models;
};
