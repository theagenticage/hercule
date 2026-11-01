/**
 * Decides what a frame that runs a harness (a session's start, resume or fork,
 * and a text generation call) tells the harness about the account's Model
 * Catalog. A harness that can run any model of the provider, such as pi with
 * OpenRouter, gets the catalog as `catalogModels`, so it can run a model its
 * own list lacks.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as Struct from "effect/Struct";
import {
  MODEL_DECLARATION_KEYS,
  type CatalogModel,
  type ModelDeclaration,
} from "@hercule/protocol";
import { PluginHost } from "../plugins";
import { modelCatalogRepository } from "./model-catalog-repository";
import { providerAccountRepository } from "./repository";
import { takesCatalogDeclarations } from "./run-descriptor";

/**
 * Returns the part of a catalog model that a runner needs to run it, which is
 * every field of `ModelDeclaration` and nothing else. The details a client
 * shows and filters by (prices, maker, options) stay in the controller. This is
 * the one place a catalog model becomes a `ModelDeclaration`.
 */
const toModelDeclaration = (model: CatalogModel): ModelDeclaration =>
  Struct.pick(model, MODEL_DECLARATION_KEYS);

const make = Effect.gen(function* () {
  const accounts = yield* providerAccountRepository;
  const catalogs = yield* modelCatalogRepository;
  const host = yield* PluginHost;

  return {
    /**
     * Returns the account's whole Model Catalog as the `ModelDeclaration`s a
     * runner takes, in the catalog's order, for the frame's `catalogModels`.
     * Returns `undefined` when the frame must carry no such field, which is
     * when:
     *
     * - the harness does not take catalog declarations for the account's
     *   provider (`takesCatalogDeclarations`). It then lists every model
     *   itself;
     * - the account or the harness is unknown. The caller builds the
     *   `HarnessAccount` of the same frame first, and that refuses them;
     * - the catalog was never read. The controller knows nothing about the
     *   account's models yet, and an empty list would tell the runner to
     *   remove the declarations of an earlier start.
     *
     * The list is empty when the catalog was read and holds no model. The
     * runner then clears the declarations it wrote earlier.
     *
     * The list does not depend on the runner. Which of these models the
     * harness already ships is the runner's to find out, because only the
     * runner can ask the harness: a model the harness ships must not be
     * declared again, since the declaration would replace the harness's own
     * definition of it.
     *
     * Reads the database only, so it can run inside a transaction. Dies when
     * a stored catalog is corrupt.
     */
    findModelDeclarations: (
      providerAccountId: string,
      harnessId: string,
    ): Effect.Effect<ReadonlyArray<ModelDeclaration> | undefined, SqlError> =>
      Effect.gen(function* () {
        const account = Option.getOrUndefined(yield* accounts.one(providerAccountId));
        if (account === undefined) return undefined;
        const provider = (yield* host.providers()).find((one) => one.id === account.providerId);
        const harness = (yield* host.harnesses()).find((one) => one.id === harnessId);
        if (!takesCatalogDeclarations(provider, harness)) return undefined;
        const catalog = Option.getOrUndefined(yield* catalogs.readOne(providerAccountId));
        if (catalog === undefined || catalog.readAt === null) return undefined;
        return catalog.models.map(toModelDeclaration);
      }).pipe(Effect.catchTag("SchemaError", Effect.die)),
  };
});

/** The service that decides what a frame tells a harness about the account's Model Catalog. */
export class ModelDeclarations extends Context.Service<
  ModelDeclarations,
  Effect.Success<typeof make>
>()("hercule/controller/provider-accounts/ModelDeclarations") {}

export const ModelDeclarationsLayer: Layer.Layer<
  ModelDeclarations,
  never,
  SqlClient.SqlClient | PluginHost
> = Layer.effect(ModelDeclarations)(make);
