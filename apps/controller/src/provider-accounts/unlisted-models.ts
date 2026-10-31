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
import type { CatalogModel } from "@hercule/protocol";
import { PluginHost } from "../plugins";
import { findModels } from "./account-runners";
import { modelCatalogRepository } from "./model-catalog-repository";
import { providerAccountRepository } from "./repository";

const make = Effect.gen(function* () {
  const accounts = yield* providerAccountRepository;
  const catalogs = yield* modelCatalogRepository;
  const host = yield* PluginHost;

  return {
    /**
     * Returns the models of the account's Model Catalog that the harness's
     * own list on the runner lacks, in the catalog's order. The caller leaves
     * `unlistedModels` out of its frame when the list is empty. Reads the
     * database only, so it can run inside a transaction.
     *
     * The list is empty unless both of these hold:
     *
     * - The harness's `runs` entry for the account's provider says
     *   `models: "all"`. A harness with an `own-list` runs only what it lists,
     *   so telling it about other models would be pointless.
     * - The harness is not the provider's catalog source. The catalog of such
     *   a provider is what that harness listed, so it lacks nothing.
     *
     * "The harness's own list on the runner" is `findModels`: the runner's own
     * signed-in snapshot, else the newest signed-in one of any runner. With no
     * snapshot the harness has told us nothing, so every catalog model is
     * unlisted.
     *
     * Dies when a stored catalog or snapshot is corrupt. Returns an empty list
     * for an unknown account, provider or harness: the caller builds the
     * `HarnessAccount` of the same frame first, and that refuses them.
     */
    listUnlistedModels: (
      providerAccountId: string,
      harnessId: string,
      runnerId: string,
    ): Effect.Effect<ReadonlyArray<CatalogModel>, SqlError> =>
      Effect.gen(function* () {
        const account = Option.getOrUndefined(yield* accounts.one(providerAccountId));
        if (account === undefined) return [];
        const provider = (yield* host.providers()).find((one) => one.id === account.providerId);
        const harness = (yield* host.harnesses()).find((one) => one.id === harnessId);
        const runs = harness?.runs.find((one) => one.providerId === account.providerId);
        if (provider === undefined || runs?.models !== "all") return [];
        if (
          provider.catalogSource.kind === "harness-probe" &&
          provider.catalogSource.harnessId === harnessId
        ) {
          return [];
        }
        const catalog = Option.getOrUndefined(yield* catalogs.readOne(providerAccountId));
        if (catalog === undefined || catalog.models.length === 0) return [];
        const listed = new Set(
          findModels(
            yield* accounts.listHarnessSnapshots(providerAccountId, harnessId),
            runnerId,
          ).map((model) => model.slug),
        );
        return catalog.models.filter((model) => !listed.has(model.slug));
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
