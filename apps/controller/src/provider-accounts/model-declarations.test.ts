import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { HarnessDefinition } from "@hercule/plugin-host";
import type { CatalogModel, ProbeResult } from "@hercule/protocol";
import { nowIso, withTransaction } from "../db";
import {
  buildHarnessDefinition,
  buildProviderDefinition,
  createPluginFixture,
} from "../plugins/testing";
import { modelCatalogRepository } from "./model-catalog-repository";
import { addAccount, addRunner, addSnapshot, runWithAccounts } from "./testing";
import { ModelDeclarations, ModelDeclarationsLayer } from "./model-declarations";

const WIDE = "wide/wide";
const NARROW = "narrow/narrow";
const OTHER = "other/other";
const API_PROVIDER = "apiprov/apiprov";
const PROBED_PROVIDER = "probed/probed";

const runs = (providerId: string, models: "all" | "own-list") => ({
  providerId,
  kinds: [{ kind: "api-key", modelArgument: "{model}" }],
  models,
});

/**
 * Two providers and three harnesses:
 *
 * - `apiprov` reads its catalog from its API. `wide` runs any of its models,
 *   `narrow` only those it lists itself.
 * - `probed` reads its catalog by probing `wide`. `wide` and `other` both run
 *   any of its models.
 */
const buildPlugins = () => {
  const harness = (id: string, supports: HarnessDefinition["runs"]) =>
    createPluginFixture({ id, definitions: [buildHarnessDefinition(id, supports)] }).plugin;
  return [
    harness("wide", [runs(API_PROVIDER, "all"), runs(PROBED_PROVIDER, "all")]),
    harness("narrow", [runs(API_PROVIDER, "own-list")]),
    harness("other", [runs(PROBED_PROVIDER, "all")]),
    createPluginFixture({
      id: "apiprov",
      capabilities: ["providers"],
      definitions: [],
      providers: [
        {
          ...buildProviderDefinition("apiprov", [WIDE, NARROW]),
          catalogSource: {
            kind: "provider-api",
            url: "https://api.example.com/v1/models",
            headers: { authorization: "Bearer {apiKey}" },
          },
        },
      ],
      providerOptions: { parseCatalogBody: () => [] },
    }).plugin,
    createPluginFixture({
      id: "probed",
      capabilities: ["providers"],
      definitions: [],
      providers: [buildProviderDefinition("probed", [WIDE, OTHER])],
    }).plugin,
  ];
};

const catalogModel = (slug: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({
  slug,
  name: `Model ${slug}`,
  imageInput: null,
  options: [],
  ...extra,
});

/** The details a provider's API gives, which a harness probe does not. */
const WITH_DETAILS = { maker: "Maker", contextWindow: 200_000, inputPrice: 1.5, reasoning: true };

const catalog = [
  catalogModel("a"),
  catalogModel("b", WITH_DETAILS),
  catalogModel("c", { contextWindow: 8_000 }),
];

const listing = (...slugs: ReadonlyArray<string>): ProbeResult => ({
  harnessVersion: "1.0.0",
  auth: { status: "ok" },
  models: slugs.map((slug) => catalogModel(slug)),
  usage: null,
});

/** Stores the catalog the account has after a successful read. */
const storeCatalog = (accountId: string, models: ReadonlyArray<CatalogModel>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const catalogs = yield* modelCatalogRepository;
    yield* withTransaction(
      sql,
      catalogs.recordSuccess(accountId, models, yield* nowIso, "2026-10-31T10:00:00.000Z"),
    );
  });

/** Finds the declarations for a frame that runs `harnessId` for the account. */
const findDeclarations = (accountId: string, harnessId: string) =>
  Effect.flatMap(ModelDeclarations, (declarations) =>
    declarations.findModelDeclarations(accountId, harnessId),
  );

/** Runs `body` against an account of `apiprov`, running in `wide` by default, whose catalog holds `models`. */
const withApiAccount = <A, E>(
  body: (accountId: string) => Effect.Effect<A, E, SqlClient.SqlClient | ModelDeclarations>,
  models: ReadonlyArray<CatalogModel> = catalog,
) =>
  runWithAccounts(
    Effect.gen(function* () {
      const account = yield* addAccount({
        providerId: API_PROVIDER,
        defaultHarnessId: WIDE,
      });
      yield* storeCatalog(account.id, models);
      return yield* body(account.id);
    }).pipe(Effect.provide(ModelDeclarationsLayer)),
    undefined,
    buildPlugins(),
  );

describe("ModelDeclarations.findModelDeclarations", () => {
  it("returns the whole catalog in catalog order, with only what a runner needs, whatever any runner lists", async () => {
    const declarations = await withApiAccount((accountId) =>
      Effect.gen(function* () {
        const runner = yield* addRunner("laptop");
        yield* addSnapshot(accountId, WIDE, runner, listing("a"));
        return yield* findDeclarations(accountId, WIDE);
      }),
    );

    expect(declarations).toEqual([
      { slug: "a", name: "Model a", imageInput: null },
      {
        slug: "b",
        name: "Model b",
        imageInput: null,
        contextWindow: 200_000,
        reasoning: true,
      },
      { slug: "c", name: "Model c", imageInput: null, contextWindow: 8_000 },
    ]);
  });

  it("returns nothing for a harness that runs only the models it lists itself", async () => {
    const declarations = await withApiAccount((accountId) => findDeclarations(accountId, NARROW));

    expect(declarations).toBeUndefined();
  });

  it("returns an empty list for a catalog that was read and holds no models", async () => {
    const declarations = await withApiAccount((accountId) => findDeclarations(accountId, WIDE), []);

    expect(declarations).toEqual([]);
  });

  it("returns nothing for a catalog that was never read", async () => {
    const declarations = await runWithAccounts(
      Effect.gen(function* () {
        const account = yield* addAccount({ providerId: API_PROVIDER, defaultHarnessId: WIDE });
        return yield* findDeclarations(account.id, WIDE);
      }).pipe(Effect.provide(ModelDeclarationsLayer)),
      undefined,
      buildPlugins(),
    );

    expect(declarations).toBeUndefined();
  });

  it("returns nothing for the harness the provider's catalog is read from, but the catalog for another harness that runs any model", async () => {
    const { source, other } = await runWithAccounts(
      Effect.gen(function* () {
        const account = yield* addAccount({ providerId: PROBED_PROVIDER, defaultHarnessId: WIDE });
        yield* storeCatalog(account.id, catalog);
        return {
          source: yield* findDeclarations(account.id, WIDE),
          other: yield* findDeclarations(account.id, OTHER),
        };
      }).pipe(Effect.provide(ModelDeclarationsLayer)),
      undefined,
      buildPlugins(),
    );

    expect(source).toBeUndefined();
    expect(other?.map((model) => model.slug)).toEqual(["a", "b", "c"]);
  });
});
