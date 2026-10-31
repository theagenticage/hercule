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
import { UnlistedModels, UnlistedModelsLayer } from "./unlisted-models";

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

/** Lists the unlisted models for a frame that runs `model`, which only matters for a runner with no snapshot. */
const listUnlisted = (accountId: string, harnessId: string, runnerId: string, model = "a") =>
  Effect.flatMap(UnlistedModels, (unlisted) =>
    unlisted.listUnlistedModels(accountId, harnessId, runnerId, model),
  );

/** Runs `body` against an account of `apiprov`, running in `wide` by default, whose catalog holds `models`. */
const withApiAccount = <A, E>(
  body: (accountId: string) => Effect.Effect<A, E, SqlClient.SqlClient | UnlistedModels>,
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
    }).pipe(Effect.provide(UnlistedModelsLayer)),
    undefined,
    buildPlugins(),
  );

describe("UnlistedModels.listUnlistedModels", () => {
  it("returns the catalog models the harness lacks on the runner, with their details and in catalog order", async () => {
    const unlisted = await withApiAccount((accountId) =>
      Effect.gen(function* () {
        const runner = yield* addRunner("laptop");
        yield* addSnapshot(accountId, WIDE, runner, listing("a"));
        return yield* listUnlisted(accountId, WIDE, runner);
      }),
    );

    expect(unlisted).toEqual([catalog[1], catalog[2]]);
  });

  it("judges by the target runner's snapshot, not another runner's", async () => {
    const unlisted = await withApiAccount((accountId) =>
      Effect.gen(function* () {
        const target = yield* addRunner("target");
        const other = yield* addRunner("other");
        yield* addSnapshot(accountId, WIDE, target, listing("a"));
        yield* addSnapshot(accountId, WIDE, other, listing("a", "b", "c"));
        return yield* listUnlisted(accountId, WIDE, target);
      }),
    );

    expect(unlisted.map((model) => model.slug)).toEqual(["b", "c"]);
  });

  it("returns only the model the frame runs for a runner with no snapshot, whatever another runner lists", async () => {
    const unlisted = await withApiAccount((accountId) =>
      Effect.gen(function* () {
        const target = yield* addRunner("target");
        const other = yield* addRunner("other");
        yield* addSnapshot(accountId, WIDE, other, listing("a", "b"));
        return yield* listUnlisted(accountId, WIDE, target, "c");
      }),
    );

    expect(unlisted).toEqual([catalog[2]]);
  });

  it("returns nothing for a runner with no snapshot when the catalog lacks the model the frame runs", async () => {
    const unlisted = await withApiAccount((accountId) =>
      Effect.gen(function* () {
        const target = yield* addRunner("target");
        return yield* listUnlisted(accountId, WIDE, target, "not-in-catalog");
      }),
    );

    expect(unlisted).toEqual([]);
  });

  it("treats the snapshot of a signed-out probe as no snapshot", async () => {
    const unlisted = await withApiAccount((accountId) =>
      Effect.gen(function* () {
        const target = yield* addRunner("target");
        yield* addSnapshot(accountId, WIDE, target, {
          ...listing("a", "b"),
          auth: { status: "unauthenticated" },
        });
        return yield* listUnlisted(accountId, WIDE, target, "c");
      }),
    );

    expect(unlisted).toEqual([catalog[2]]);
  });

  it("returns nothing for a harness that runs only the models it lists itself", async () => {
    const unlisted = await withApiAccount((accountId) =>
      Effect.gen(function* () {
        const runner = yield* addRunner("laptop");
        return yield* listUnlisted(accountId, NARROW, runner);
      }),
    );

    expect(unlisted).toEqual([]);
  });

  it("returns nothing for a catalog that has no models", async () => {
    const unlisted = await withApiAccount(
      (accountId) =>
        Effect.gen(function* () {
          const runner = yield* addRunner("laptop");
          return yield* listUnlisted(accountId, WIDE, runner);
        }),
      [],
    );

    expect(unlisted).toEqual([]);
  });

  it("returns nothing for the harness the provider's catalog is read from, but the frame's model for another harness that runs any model", async () => {
    const { source, other } = await runWithAccounts(
      Effect.gen(function* () {
        const account = yield* addAccount({ providerId: PROBED_PROVIDER, defaultHarnessId: WIDE });
        yield* storeCatalog(account.id, catalog);
        const runner = yield* addRunner("laptop");
        return {
          source: yield* listUnlisted(account.id, WIDE, runner),
          other: yield* listUnlisted(account.id, OTHER, runner),
        };
      }).pipe(Effect.provide(UnlistedModelsLayer)),
      undefined,
      buildPlugins(),
    );

    expect(source).toEqual([]);
    expect(other).toEqual([catalog[0]]);
  });
});
