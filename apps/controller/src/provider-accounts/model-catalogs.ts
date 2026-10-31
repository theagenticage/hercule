/**
 * Model Catalogs: the list of models each Provider Account may use, as the
 * provider's catalog source reports it for that account (spec 06 section 16).
 *
 * A catalog is read by probing the harness the provider names
 * (`catalogSource.harnessId`) for the account, on one runner chosen before
 * the probe is sent. The outcome of that probe is the read: a probe that finds
 * the account signed in replaces the models, any other outcome records an
 * error and keeps the models. Every other probe leaves the catalog alone.
 *
 * This domain stores catalogs and decides what to read. The controller daemon
 * sends the probes (it is the only module that talks to runners) and hands
 * each outcome back to `recordCatalogRead`. Every other module reads the
 * catalogs through this service, never through the repository.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  createNotFoundError,
  type ModelCatalog,
  type ModelCatalogItem,
  type NotFound,
} from "@hercule/contract";
import type { ModelDescriptor, ProbeResult } from "@hercule/protocol";
import { announce, nowIso, withTransaction } from "../db";
import { PluginHost, type RegisteredProvider } from "../plugins";
import { PromotionState } from "../promotion";
import { runnerRepository } from "../runners";
import { ProviderAccountRunners, type AccountRunners } from "./account-runners";
import { modelCatalogRepository, type StoredModelCatalog } from "./model-catalog-repository";
import { ModelProfileMembership, type DefaultSelection } from "./model-profile-membership";
import type { ProbePair, ProbeStamp } from "./probes";
import { providerAccountRepository } from "./repository";

/** How old a catalog's last successful read may be before it is read again (spec 06 section 16.3). */
const CATALOG_MAX_AGE_MILLIS = 4 * 60 * 60 * 1000;

const NO_SUCH_PROVIDER_ACCOUNT = "no such provider account";

/**
 * Returns whether a catalog is due for a read: it was never read, or its last
 * successful read ended `CATALOG_MAX_AGE_MILLIS` ago or more. A catalog whose
 * last read failed is judged by its last successful read, so a failure is
 * tried again on the next sweep only when that read is old enough.
 */
const isCatalogReadDue = (readAt: string | null, nowMillis: number): boolean =>
  readAt === null || nowMillis - Date.parse(readAt) >= CATALOG_MAX_AGE_MILLIS;

/**
 * Computes the models an account brings into a Model Profile when it is first
 * added, from the provider's rule and the account's catalog:
 *
 * - `current-models`: every model that is not legacy, in the catalog's order.
 *   `defaultModel` is the model the harness marks as its default, when that
 *   model is among them, else `null`.
 * - `none`: no model.
 */
export const computeDefaultSelection = (
  provider: Pick<RegisteredProvider, "defaultSelection">,
  models: ReadonlyArray<ModelDescriptor>,
): DefaultSelection => {
  if (provider.defaultSelection === "none") return { models: [], defaultModel: null };
  const current = models.filter((model) => model.isLegacy !== true);
  return {
    models: current.map((model) => model.slug),
    defaultModel: current.find((model) => model.isDefault === true)?.slug ?? null,
  };
};

/** A model that joined an account's Default Selection after the account's first catalog read. */
export interface ArrivedModel {
  readonly model: string;
  /** The model's name in the account's catalog. */
  readonly name: string;
  /** When the controller first saw the model in the account's catalog. */
  readonly firstSeenAt: string;
}

/**
 * Computes the models that arrived in an account's Default Selection after
 * its first successful catalog read, in the order of the Default Selection.
 * Returns none while the account has never been read, and none for a provider
 * whose Default Selection is `none`.
 *
 * A model arrived when it is in the Default Selection now and was first seen
 * later than the first read. So a model of the first read never arrived, and a
 * model first seen after it but marked legacy has not arrived yet. If that
 * model later stops being legacy, it arrives then, because its first-seen time
 * is still after the first read.
 */
export const computeArrivedModels = (
  provider: Pick<RegisteredProvider, "defaultSelection">,
  catalog: Pick<StoredModelCatalog, "models" | "firstSeen" | "firstReadAt">,
): ReadonlyArray<ArrivedModel> => {
  if (catalog.firstReadAt === null) return [];
  const firstReadMillis = Date.parse(catalog.firstReadAt);
  const names = new Map(catalog.models.map((model) => [model.slug, model.name]));
  return computeDefaultSelection(provider, catalog.models).models.flatMap((model) => {
    const firstSeenAt = catalog.firstSeen.get(model);
    return firstSeenAt !== undefined && Date.parse(firstSeenAt) > firstReadMillis
      ? [{ model, name: names.get(model) ?? model, firstSeenAt }]
      : [];
  });
};

/**
 * Returns the error to store for a probe that did not find the account signed
 * in: the harness's own message when it gave one, else a sentence that says
 * what to do.
 */
const describeReadFailure = (result: Pick<ProbeResult, "auth">): string =>
  result.auth.message ??
  (result.auth.status === "unauthenticated"
    ? "Sign in on a machine first."
    : "The harness could not list this account's models.");

/**
 * Returns the sentence for a due read that no connected machine can serve:
 * why the account cannot run in the source harness anywhere when that is the
 * case (a missing key, a harness that is not installed, no sign-in), else
 * that no machine that could is connected.
 */
const describeNoReader = (available: AccountRunners): string =>
  available.noRunnerMessage ??
  `No connected machine can run ${available.subject} right now. Connect one to list this account's models.`;

/** A due catalog read that no connected machine can serve, and what the user can do about it. */
export interface UnservedRead {
  readonly providerAccountId: string;
  readonly message: string;
}

/**
 * What one catalog read observed: the result of the probe, judged against the
 * account's identity, or the reason there is no result because no probe was
 * sent or none was answered (no machine to ask, a key that does not decrypt,
 * a machine that did not answer in time).
 */
export type CatalogReadOutcome =
  | { readonly _tag: "probed"; readonly result: Pick<ProbeResult, "auth" | "models"> }
  | { readonly _tag: "failed"; readonly message: string };

/** The catalog reads `chooseDueReads` chose to send, and the accounts it could not serve. */
export interface ChosenReads {
  readonly reads: ReadonlyArray<ProbePair>;
  readonly unserved: ReadonlyArray<UnservedRead>;
}

/**
 * Builds the public catalog from the stored one, adding when each model was
 * first seen. Dies when a model has no first-seen time, because
 * `recordSuccess` writes that time with the models, so a row without it is
 * corrupt.
 */
const toModelCatalog = (stored: StoredModelCatalog): Effect.Effect<ModelCatalog> =>
  Effect.gen(function* () {
    const models: Array<ModelCatalogItem> = [];
    for (const model of stored.models) {
      const firstSeenAt = stored.firstSeen.get(model.slug);
      if (firstSeenAt === undefined) {
        return yield* Effect.die(
          new Error(
            `the catalog of provider account ${stored.providerAccountId} lists the model ${model.slug} but has no time it was first seen`,
          ),
        );
      }
      models.push({ ...model, firstSeenAt });
    }
    return {
      providerAccountId: stored.providerAccountId,
      models,
      readAt: stored.readAt,
      error: stored.error,
    };
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const catalogs = yield* modelCatalogRepository;
  const accounts = yield* providerAccountRepository;
  const runners = yield* runnerRepository;
  const accountRunners = yield* ProviderAccountRunners;
  const host = yield* PluginHost;
  const membership = yield* ModelProfileMembership;
  const promotion = yield* PromotionState;

  /**
   * Stores one catalog read in the caller's transaction. Returns whether the
   * catalog changed.
   *
   * - A probed result that found the account signed in replaces the models,
   *   sets `readAt` to now, and gives every Model Profile section of the
   *   account that waits for its first catalog the account's Default
   *   Selection (`ModelProfileMembership`). It clears the error unless a read
   *   sent later has failed since.
   * - Any other outcome keeps the models and records why it failed.
   *
   * A success sent before the models the catalog already holds is dropped,
   * and so is a failure sent before the newest read the catalog holds.
   */
  const storeRead = (
    account: { readonly id: string; readonly providerId: string },
    outcome: CatalogReadOutcome,
    sentAt: string,
  ): Effect.Effect<boolean, SqlError | Schema.SchemaError> =>
    Effect.gen(function* () {
      if (outcome._tag === "failed") {
        return yield* catalogs.recordFailure(account.id, outcome.message, sentAt);
      }
      const { result } = outcome;
      if (result.auth.status !== "ok") {
        return yield* catalogs.recordFailure(account.id, describeReadFailure(result), sentAt);
      }
      const stored = yield* catalogs.recordSuccess(
        account.id,
        result.models,
        yield* nowIso,
        sentAt,
      );
      const provider = (yield* host.providers()).find((one) => one.id === account.providerId);
      if (stored && provider !== undefined) {
        yield* membership.fillPendingSelections(
          account.id,
          computeDefaultSelection(provider, result.models),
        );
      }
      return stored;
    });

  /** Returns the stored catalog of every account, in the order the accounts were added. Dies when a stored row is corrupt. */
  const listStoredCatalogs = (): Effect.Effect<ReadonlyArray<StoredModelCatalog>, SqlError> =>
    catalogs.listCatalogs().pipe(Effect.catchTag("SchemaError", Effect.die));

  return {
    /**
     * Returns the catalog of every account, in the order the accounts were
     * added. An account that was never read has an empty catalog with no read
     * time. Dies when a stored row is corrupt.
     */
    listCatalogs: (): Effect.Effect<ReadonlyArray<ModelCatalog>, SqlError> =>
      Effect.flatMap(listStoredCatalogs(), (all) => Effect.forEach(all, toModelCatalog)),

    /**
     * Returns the catalog of every account, as `listCatalogs` does, and with
     * it the models that arrived in each account's Default Selection after its
     * first read (`computeArrivedModels`), by account id. An account whose
     * provider is not loaded has no entry there. Reads the stored catalogs
     * once for both. Dies when a stored row is corrupt.
     */
    listCatalogsWithArrivedModels: (): Effect.Effect<
      {
        readonly catalogs: ReadonlyArray<ModelCatalog>;
        readonly arrivedModels: ReadonlyMap<string, ReadonlyArray<ArrivedModel>>;
      },
      SqlError
    > =>
      Effect.gen(function* () {
        const stored = yield* listStoredCatalogs();
        const providers = yield* host.providers();
        const providerIds = new Map(
          (yield* accounts.list()).map((account) => [account.id, account.providerId]),
        );
        const arrivedModels = new Map<string, ReadonlyArray<ArrivedModel>>();
        for (const catalog of stored) {
          const provider = providers.find(
            (one) => one.id === providerIds.get(catalog.providerAccountId),
          );
          if (provider !== undefined) {
            arrivedModels.set(catalog.providerAccountId, computeArrivedModels(provider, catalog));
          }
        }
        return { catalogs: yield* Effect.forEach(stored, toModelCatalog), arrivedModels };
      }),

    /**
     * Returns the account's catalog. Fails with `NotFound` when the account
     * does not exist. An account that was never read has an empty catalog.
     * Dies when the stored row is corrupt.
     */
    read: (providerAccountId: string): Effect.Effect<ModelCatalog, SqlError | NotFound> =>
      catalogs.readOne(providerAccountId).pipe(
        Effect.catchTag("SchemaError", Effect.die),
        Effect.flatMap((found) =>
          Option.match(found, {
            onNone: () => Effect.fail(createNotFoundError(NO_SUCH_PROVIDER_ACCOUNT)),
            onSome: toModelCatalog,
          }),
        ),
      ),

    /** Returns the size and read state of every account's catalog, by account id, without reading the models. */
    listSummaries: () =>
      Effect.map(
        catalogs.listSummaries(),
        (all) => new Map(all.map((summary) => [summary.providerAccountId, summary])),
      ),

    /**
     * Chooses the catalog reads to send now. `reads` holds each as the probe
     * to send: the account, the provider's source harness, and the runner.
     *
     * - An account is read when its catalog is due (`isCatalogReadDue`) or
     *   `force` is set. `accountIds` limits the accounts considered; left out,
     *   every account is.
     * - The runner is chosen here, before the probe: among the connected
     *   runners where the account is ready in the source harness, the local
     *   runner (`localRunnerId`) first, else the first in the order the runners
     *   were added.
     * - An account with no such runner is in `unserved`, with a sentence that
     *   says what to do (install the harness, sign in). The caller records
     *   that message with `recordCatalogRead`.
     * - With `servedBy`, only the accounts that runner can serve are
     *   considered. The others are in neither list: a runner that just
     *   connected knows nothing about an account whose machine has not
     *   connected yet, so it must not make that account's catalog look
     *   unreadable.
     *
     * The caller sends each chosen read as a probe of its own and hands the
     * outcome to `recordCatalogRead`.
     */
    chooseDueReads: (options: {
      readonly accountIds?: ReadonlyArray<string>;
      readonly force: boolean;
      readonly localRunnerId: string | undefined;
      readonly servedBy?: string;
    }): Effect.Effect<ChosenReads, SqlError | Schema.SchemaError> =>
      Effect.gen(function* () {
        const providers = yield* host.providers();
        const nowMillis = yield* Clock.currentTimeMillis;
        const summaries = new Map(
          (yield* catalogs.listSummaries()).map((one) => [one.providerAccountId, one]),
        );
        const due = (yield* accounts.list()).flatMap((account) => {
          const provider = providers.find((one) => one.id === account.providerId);
          const readAt = summaries.get(account.id)?.readAt ?? null;
          const scoped =
            options.accountIds === undefined || options.accountIds.includes(account.id);
          return provider !== undefined &&
            scoped &&
            (options.force || isCatalogReadDue(readAt, nowMillis))
            ? [{ account, harnessId: provider.catalogSource.harnessId }]
            : [];
        });
        if (due.length === 0) return { reads: [], unserved: [] };
        const available = yield* accountRunners.listMany(
          due.map(({ account, harnessId }) => ({ providerAccountId: account.id, harnessId })),
        );
        const connected = new Set(yield* runners.connected());
        const reads: Array<ProbePair> = [];
        const unserved: Array<UnservedRead> = [];
        for (const [index, { account, harnessId }] of due.entries()) {
          const usable = available[index]!.runnerIds.filter((id) => connected.has(id));
          if (options.servedBy !== undefined && !usable.includes(options.servedBy)) continue;
          const runnerId =
            options.localRunnerId !== undefined && usable.includes(options.localRunnerId)
              ? options.localRunnerId
              : usable[0];
          if (runnerId !== undefined) {
            reads.push({ runnerId, providerAccountId: account.id, harnessId });
          } else {
            unserved.push({
              providerAccountId: account.id,
              message: describeNoReader(available[index]!),
            });
          }
        }
        return { reads, unserved };
      }),

    /**
     * Records the outcome of one catalog read: the single place where a read
     * is stored, whether a probe answered it or no probe could be sent.
     * `stamp` is when the controller started the read and which credential the
     * account had then (see `ProviderAccountProbes.readProbeStamp`).
     *
     * Runs in its own transaction, or joins the caller's: the probe that
     * carries a read stores its snapshot and the read together. In that
     * transaction it announces the change on the `provider` topic. Does
     * nothing when the account is gone, when its credential changed after the
     * read started (the outcome describes the old credential), or while a
     * promotion has sealed this controller. What is stored is described at
     * `storeRead`.
     */
    recordCatalogRead: (
      providerAccountId: string,
      outcome: CatalogReadOutcome,
      stamp: ProbeStamp,
    ): Effect.Effect<void, SqlError | Schema.SchemaError> =>
      promotion.whenServingOr(
        withTransaction(
          sql,
          Effect.gen(function* () {
            const found = yield* accounts.one(providerAccountId);
            if (
              Option.isNone(found) ||
              found.value.credentialGeneration > stamp.credentialGeneration
            ) {
              return;
            }
            if (!(yield* storeRead(found.value, outcome, stamp.sentAt))) return;
            yield* announce({
              _tag: "record",
              topic: "provider",
              id: providerAccountId,
              kind: "updated",
            });
          }),
        ),
        () => Effect.void,
      ),
  };
});

/** The service that stores Model Catalogs and chooses which to read. */
export class ModelCatalogs extends Context.Service<ModelCatalogs, Effect.Success<typeof make>>()(
  "hercule/controller/provider-accounts/ModelCatalogs",
) {}

export const ModelCatalogsLayer: Layer.Layer<
  ModelCatalogs,
  never,
  | SqlClient.SqlClient
  | PluginHost
  | PromotionState
  | ProviderAccountRunners
  | ModelProfileMembership
> = Layer.effect(ModelCatalogs)(make);
