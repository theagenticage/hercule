/**
 * The logic of the model browser: the dialog that lists a large Model Catalog
 * (OpenRouter's has hundreds of models) so the user can search, filter and
 * sort it.
 *
 * The catalog's details (maker, context, price, abilities) are for showing and
 * filtering only. A model whose detail is unknown is never guessed: it does not
 * pass a filter on that detail, and it sorts after the models that have it.
 * The one exception is "newest": a model without a release date is placed by
 * the date Hercule first saw it in the catalog, which is a real date, and not
 * after the models that have a release date.
 *
 * Cost: `indexModelCatalog` runs once per catalog and sorts it four times.
 * `browseModels` is then one linear pass over the models in the chosen order,
 * with one substring check per search word, so a keystroke in the search field
 * does no sorting and builds no strings.
 */
import type { ModelCatalogItem } from "@hercule/contract";

// The search below has its own helpers, apart from `catalog-search.ts`, which the
// composer's menu loads with the first screen: sharing them would make the first
// screen's chunk export them to this lazy one, and the first screen is held to its size
// (spec 17 §Measured).

/** Returns the words of a search text, lowercased. A blank text has none. */
const splitSearchWords = (search: string): string[] =>
  search.toLowerCase().split(/\s+/).filter(Boolean);

/** Returns the lowercased text that a search looks in: the model's name, id and maker. */
const buildSearchText = (model: ModelCatalogItem): string =>
  `${model.name} ${model.slug} ${model.maker ?? ""}`.toLowerCase();

/** The orders the browser sorts in. */
export type ModelSort = "newest" | "price" | "context" | "name";

/** What the user filters the catalog on, besides the search text. */
export interface ModelFacets {
  /** Makers to keep, matched exactly as listed by `ModelMaker`. Empty keeps every maker. */
  readonly makers: readonly string[];
  /** Keeps only the models that can call tools. */
  readonly tools: boolean;
  /** Keeps only the models that take image input. */
  readonly images: boolean;
  /** Keeps only the models that can reason. */
  readonly reasoning: boolean;
  /** The smallest context window to keep, in tokens, or `null` for any. */
  readonly minContextWindow: number | null;
  /** The input price to stay under, in US dollars per million tokens, or `null` for any. */
  readonly maxInputPrice: number | null;
}

/** The facets with nothing chosen. */
export const NO_MODEL_FACETS: ModelFacets = {
  makers: [],
  tools: false,
  images: false,
  reasoning: false,
  minContextWindow: null,
  maxInputPrice: null,
};

/** Everything the browser shows the models for: the search text, the facets and the order. */
export interface ModelBrowserQuery {
  readonly search: string;
  readonly facets: ModelFacets;
  readonly sort: ModelSort;
}

/** One maker of a catalog and how many of the catalog's models it made. */
export interface ModelMaker {
  readonly name: string;
  readonly count: number;
}

/** One option of a facet or of the sort, as the dialog labels it. */
export interface ModelBrowserChoice<Value> {
  readonly label: string;
  readonly value: Value;
}

/** The context facet's options, from the broadest to the narrowest. */
export const MODEL_CONTEXT_CHOICES: readonly ModelBrowserChoice<number | null>[] = [
  { label: "Any", value: null },
  { label: "200K+", value: 200_000 },
  { label: "400K+", value: 400_000 },
  { label: "1M+", value: 1_000_000 },
];

/** The price facet's options, as a ceiling on the input price per million tokens. */
export const MODEL_PRICE_CHOICES: readonly ModelBrowserChoice<number | null>[] = [
  { label: "Any", value: null },
  { label: "Under $1", value: 1 },
  { label: "Under $5", value: 5 },
];

/** The sort's options. Newest is the default. */
export const MODEL_SORT_CHOICES: readonly ModelBrowserChoice<ModelSort>[] = [
  { label: "Newest first", value: "newest" },
  { label: "Cheapest first", value: "price" },
  { label: "Longest context", value: "context" },
  { label: "By name", value: "name" },
];

/** What the dialog says when nothing matches: a title and a line under it. */
export const NO_MODEL_MATCHES_TEXT = {
  title: "No model matches",
  hint: "Loosen a filter, or search for a maker such as google or meta.",
} as const;

interface IndexedModel {
  readonly model: ModelCatalogItem;
  /** The lowercased text the search looks in. */
  readonly searchText: string;
  /**
   * When the model came out, in milliseconds: `releasedAt`, else `firstSeenAt`
   * (when Hercule first saw the model in the catalog).
   */
  readonly releasedMs: number;
}

/** The key under which an index keeps its models in each order. Not exported, so only this file reads them. */
const IN_ORDER = Symbol("inOrder");

/**
 * A catalog prepared for the browser. Build it with `indexModelCatalog` and
 * read the models through `browseModels`. Besides `makers` and `modelCount`,
 * it holds the models in a form only `browseModels` can read.
 */
export interface ModelBrowserIndex {
  /** Every maker in the catalog, the one with the most models first. */
  readonly makers: readonly ModelMaker[];
  readonly modelCount: number;
  readonly [IN_ORDER]: Readonly<Record<ModelSort, readonly IndexedModel[]>>;
}

/** Compares names the way the user's locale orders them. */
const nameCollator = new Intl.Collator();

const compareNames = (a: ModelCatalogItem, b: ModelCatalogItem): number =>
  nameCollator.compare(a.name, b.name) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

/** Compares two numbers that may be unknown. An unknown one sorts last, in either direction. */
const compareKnownFirst = (
  a: number | undefined,
  b: number | undefined,
  direction: "ascending" | "descending",
): number => {
  if (a === undefined || b === undefined) {
    return a === b ? 0 : a === undefined ? 1 : -1;
  }
  return direction === "ascending" ? a - b : b - a;
};

const COMPARATORS: Readonly<Record<ModelSort, (a: IndexedModel, b: IndexedModel) => number>> = {
  newest: (a, b) => b.releasedMs - a.releasedMs,
  price: (a, b) => compareKnownFirst(a.model.inputPrice, b.model.inputPrice, "ascending"),
  context: (a, b) => compareKnownFirst(a.model.contextWindow, b.model.contextWindow, "descending"),
  name: () => 0,
};

const listMakers = (models: readonly ModelCatalogItem[]): ModelMaker[] => {
  const counts = new Map<string, number>();
  for (const { maker } of models) {
    if (maker !== undefined) counts.set(maker, (counts.get(maker) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || nameCollator.compare(a.name, b.name));
};

/**
 * Prepares a catalog for `browseModels`: builds each model's search text and
 * release time once (`releasedAt`, else the date the model was first seen), sorts the models in each of the four orders (ties are
 * broken by name, then slug) and counts the makers. Build it once per catalog
 * read, not per keystroke.
 *
 * The makers are listed in full, the one with the most models first and equal
 * counts by name. The browser draws a scrolling list of them, because a catalog
 * like OpenRouter's has about 60 makers and a "top makers and Others" cut would
 * hide most of them behind a bucket that cannot be told apart. A model without
 * a maker is under none of them: it matches no maker choice, and the search
 * still finds it.
 */
export const indexModelCatalog = (models: readonly ModelCatalogItem[]): ModelBrowserIndex => {
  const indexed = models.map((model): IndexedModel => ({
    model,
    searchText: buildSearchText(model),
    releasedMs: Date.parse(model.releasedAt ?? model.firstSeenAt),
  }));
  const sortedBy = (sort: ModelSort): IndexedModel[] =>
    [...indexed].sort((a, b) => COMPARATORS[sort](a, b) || compareNames(a.model, b.model));
  return {
    makers: listMakers(models),
    modelCount: models.length,
    [IN_ORDER]: {
      newest: sortedBy("newest"),
      price: sortedBy("price"),
      context: sortedBy("context"),
      name: sortedBy("name"),
    },
  };
};

/** Checks whether the user has chosen anything in `facets`, so the dialog can offer "Clear filters". */
export const hasActiveFacets = (facets: ModelFacets): boolean =>
  facets.makers.length > 0 ||
  facets.tools ||
  facets.images ||
  facets.reasoning ||
  facets.minContextWindow !== null ||
  facets.maxInputPrice !== null;

/**
 * Returns the models of `index` that match the query, in the query's order.
 *
 * - The search needs every word in the model's name, slug or maker, ignoring case.
 * - Each ability the facets turn on is required. Images means the model takes image input.
 * - A model with an unknown maker, context window or input price does not pass
 *   a facet on it.
 * - The price ceiling is strict: "Under $1" does not keep a model at exactly $1.
 *   A free model passes.
 *
 * The result is every match; the caller decides how many rows to draw.
 */
export const browseModels = (
  index: ModelBrowserIndex,
  { search, facets, sort }: ModelBrowserQuery,
): ModelCatalogItem[] => {
  const words = splitSearchWords(search);
  const makers = facets.makers.length > 0 ? new Set(facets.makers) : null;
  const { minContextWindow, maxInputPrice } = facets;
  const matches: ModelCatalogItem[] = [];
  for (const { model, searchText } of index[IN_ORDER][sort]) {
    if (
      words.every((word) => searchText.includes(word)) &&
      (makers === null || (model.maker !== undefined && makers.has(model.maker))) &&
      (!facets.tools || model.tools === true) &&
      (!facets.images || model.imageInput !== null) &&
      (!facets.reasoning || model.reasoning === true) &&
      (minContextWindow === null ||
        (model.contextWindow !== undefined && model.contextWindow >= minContextWindow)) &&
      (maxInputPrice === null ||
        (model.inputPrice !== undefined && model.inputPrice < maxInputPrice))
    ) {
      matches.push(model);
    }
  }
  return matches;
};

/**
 * Describes a count of tokens as "200K" or "1M". Windows the makers state in
 * binary steps read as the makers say them: 131,072 is "128K" and 1,048,576
 * is "1M". Round counts such as 200,000 and 128,000 read as written.
 */
const describeTokenCount = (tokens: number): string => {
  if (tokens < 1000) return String(tokens);
  const isBinaryCount = tokens % 1024 === 0 && tokens % 1000 !== 0;
  const step = isBinaryCount ? 1024 : 1000;
  if (tokens < 1_000_000) return `${String(Math.round(tokens / step))}K`;
  return `${String(Number((tokens / (step * step)).toFixed(1)))}M`;
};

/** Returns the model's context window as "200K" or "1M", or "-" when the catalog does not say. */
export const describeContextWindow = (model: ModelCatalogItem): string =>
  model.contextWindow === undefined ? "-" : describeTokenCount(model.contextWindow);

const WHOLE_DOLLARS = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const DOLLARS_AND_CENTS = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});
// Below a dollar, prices such as $0.075 and $0.0375 need the third digit to stay true.
const FRACTIONS_OF_A_DOLLAR = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
});

const describePrice = (dollars: number | undefined): string => {
  if (dollars === undefined) return "-";
  if (dollars === 0) return "free";
  if (Number.isInteger(dollars)) return WHOLE_DOLLARS.format(dollars);
  return (dollars < 1 ? FRACTIONS_OF_A_DOLLAR : DOLLARS_AND_CENTS).format(dollars);
};

/**
 * Returns the model's price per million tokens as "$3 / $15" (input, then
 * output). A side the catalog does not price shows "-". It returns "free" when
 * both sides are 0.
 */
export const describeModelPrice = (model: ModelCatalogItem): string =>
  model.inputPrice === 0 && model.outputPrice === 0
    ? "free"
    : `${describePrice(model.inputPrice)} / ${describePrice(model.outputPrice)}`;
