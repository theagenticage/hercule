/**
 * Decides what a harness runs a model of a Provider Account with: the one
 * descriptor that says whether the model takes images and which options it
 * offers. A Model Profile entry and an attachment check both ask this module,
 * so they cannot disagree, and `UnlistedModels` uses its rule to decide which
 * models a harness must be told about.
 */
import type { CatalogModel, ModelDescriptor } from "@hercule/protocol";
import type { RegisteredHarness, RegisteredProvider } from "../plugins";

/**
 * Returns whether the harness runs the provider's models from the
 * declarations of the provider's Model Catalog, so a model its own list lacks
 * is still run. That holds when both are true:
 *
 * - the harness's `runs` entry for the provider says `models: "all"`. A
 *   harness with an `own-list` runs only what it lists itself;
 * - the harness is not the provider's catalog source. The catalog of such a
 *   provider is what that harness listed, so it lacks nothing.
 *
 * Returns `false` for a harness or provider that is not registered.
 */
export const takesCatalogDeclarations = (
  provider: Pick<RegisteredProvider, "id" | "catalogSource"> | undefined,
  harness: Pick<RegisteredHarness, "id" | "runs"> | undefined,
): boolean => {
  if (provider === undefined || harness === undefined) return false;
  const runs = harness.runs.find((one) => one.providerId === provider.id);
  if (runs?.models !== "all") return false;
  return !(
    provider.catalogSource.kind === "harness-probe" &&
    provider.catalogSource.harnessId === harness.id
  );
};

/**
 * Returns the descriptor the harness runs the model with, or `undefined` when
 * nothing says what the model is:
 *
 * 1. The model as the harness lists it (`snapshotModel`), when it does. It
 *    always wins: the harness knows the model best, and only it carries the
 *    model's options.
 * 2. Else the model as the account's Model Catalog declares it
 *    (`catalogModel`), when the harness takes catalog declarations
 *    (`takesCatalogDeclarations`). The harness is then told this declaration
 *    and runs the model with it. Its options are empty: the options come from
 *    the harness's own list, and its own list never holds such a model.
 * 3. Else `undefined`.
 */
export const findRunDescriptor = (
  provider: Pick<RegisteredProvider, "id" | "catalogSource"> | undefined,
  harness: Pick<RegisteredHarness, "id" | "runs"> | undefined,
  snapshotModel: ModelDescriptor | undefined,
  catalogModel: CatalogModel | undefined,
): ModelDescriptor | undefined => {
  if (snapshotModel !== undefined) return snapshotModel;
  if (catalogModel === undefined || !takesCatalogDeclarations(provider, harness)) return undefined;
  return {
    slug: catalogModel.slug,
    name: catalogModel.name,
    imageInput: catalogModel.imageInput,
    options: [],
  };
};
