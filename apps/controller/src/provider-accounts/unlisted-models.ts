/**
 * Decides which models of an account's Model Catalog a harness must be told
 * about because it does not list them itself. A frame that runs a harness
 * (a session's start, resume or fork, and a text generation call) carries
 * them as `unlistedModels`, so a harness that can run any model of the
 * provider, such as pi with OpenRouter, can run a model its own list lacks.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as Struct from "effect/Struct";
import { UNLISTED_MODEL_KEYS, type CatalogModel, type UnlistedModel } from "@hercule/protocol";
import { PluginHost } from "../plugins";
import { modelCatalogRepository } from "./model-catalog-repository";
import { providerAccountRepository } from "./repository";
import { takesCatalogDeclarations } from "./run-descriptor";

/**
 * Returns the part of a catalog model that a runner needs to run it, which is
 * every field of `UnlistedModel` and nothing else. The details a client shows
 * and filters by (prices, maker, options) stay in the controller. This is the
 * one place a catalog model becomes an `UnlistedModel`.
 */
const toUnlistedModel = (model: CatalogModel): UnlistedModel =>
  Struct.pick(model, UNLISTED_MODEL_KEYS);

const make = Effect.gen(function* () {
  const accounts = yield* providerAccountRepository;
  const catalogs = yield* modelCatalogRepository;
  const host = yield* PluginHost;

  return {
    /**
     * Returns the models of the account's Model Catalog that the harness's
     * own list on the runner lacks, in the catalog's order, as the
     * `UnlistedModel`s a runner takes (without the catalog's other details).
     * The caller leaves
     * `unlistedModels` out of its frame when the list is empty. Reads the
     * database only, so it can run inside a transaction.
     *
     * The list is empty unless the harness takes catalog declarations for the
     * account's provider (`takesCatalogDeclarations`).
     *
     * "The harness's own list on the runner" is the successful snapshot of
     * that runner alone. Another runner's snapshot proves nothing about this
     * runner's harness: the harness there may lack a model the other one
     * lists, and the runner writes only what it is sent.
     *
     * - With that snapshot, the list is the catalog models it lacks. The
     *   runner replaces its list of declared models at each start, so this
     *   mends itself once the runner has a snapshot.
     * - Without it, the list is only `model`, the model the frame runs, when
     *   the catalog holds it. A model the harness ships must never be
     *   declared again, because the declaration would replace the harness's
     *   own definition of it (pi would lose the model's reasoning settings and
     *   costs). Without the runner's own list we cannot tell which models the
     *   harness ships, so only the model that has to run is declared.
     *
     * Dies when a stored catalog or snapshot is corrupt. Returns an empty list
     * for an unknown account, provider or harness: the caller builds the
     * `HarnessAccount` of the same frame first, and that refuses them.
     */
    listUnlistedModels: (
      providerAccountId: string,
      harnessId: string,
      runnerId: string,
      model: string,
    ): Effect.Effect<ReadonlyArray<UnlistedModel>, SqlError> =>
      Effect.gen(function* () {
        const account = Option.getOrUndefined(yield* accounts.one(providerAccountId));
        if (account === undefined) return [];
        const provider = (yield* host.providers()).find((one) => one.id === account.providerId);
        const harness = (yield* host.harnesses()).find((one) => one.id === harnessId);
        if (!takesCatalogDeclarations(provider, harness)) return [];
        const catalog = Option.getOrUndefined(yield* catalogs.readOne(providerAccountId));
        if (catalog === undefined || catalog.models.length === 0) return [];
        const ownSnapshot = (yield* accounts.listHarnessSnapshots(
          providerAccountId,
          harnessId,
        )).find((snapshot) => snapshot.runnerId === runnerId && snapshot.auth.status === "ok");
        if (ownSnapshot === undefined) {
          return catalog.models.filter((one) => one.slug === model).map(toUnlistedModel);
        }
        const listed = new Set(ownSnapshot.models.map((one) => one.slug));
        return catalog.models.filter((one) => !listed.has(one.slug)).map(toUnlistedModel);
      }).pipe(Effect.catchTag("SchemaError", Effect.die)),
  };
});

/** The service that decides which catalog models a harness has to be told about. */
export class UnlistedModels extends Context.Service<UnlistedModels, Effect.Success<typeof make>>()(
  "hercule/controller/provider-accounts/UnlistedModels",
) {}

export const UnlistedModelsLayer: Layer.Layer<
  UnlistedModels,
  never,
  SqlClient.SqlClient | PluginHost
> = Layer.effect(UnlistedModels)(make);
