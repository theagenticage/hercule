/**
 * The records the model browser's specimen (settings-providers.tsx with
 * `?browser`) draws: an OpenRouter account whose Model Catalog holds 466
 * models, shaped like what the OpenRouter plugin's parser makes of its list
 * (about 55 makers, names without the "Maker: " prefix, a few free models, a few
 * whose price is unknown, one with no maker, one with a very long name), and the section that account has in "Main".
 *
 * The catalog is generated, not recorded: the same names, prices and dates on
 * every load, so the screenshots do not change from one run to the next.
 */
import type {
  ModelCatalog,
  ModelCatalogItem,
  ModelProfile,
  ProviderAccount,
} from "@hercule/contract";
import {
  buildProfileEntry,
  buildProfileSection,
  type ProviderAccountIdentity,
} from "@hercule/client-core/testing";
import { buildOpenRouterCatalog } from "./openrouter-catalog";

const OPENROUTER_ID = "01a06d02-8000-7000-8000-000000000a0f";

/** What the profile's builders need of the OpenRouter account. */
const OPENROUTER: ProviderAccountIdentity = {
  id: OPENROUTER_ID,
  providerId: "openrouter/openrouter",
  kind: "api-key",
  harnessId: "pi/pi",
  label: null,
};

/** The generated catalog's models, each first seen on the same fixed day. */
const buildOpenRouterModels = (): ModelCatalogItem[] =>
  buildOpenRouterCatalog().map((model) => ({ ...model, firstSeenAt: "2026-10-30T09:00:00.000Z" }));

/** The catalog `providerAccount.readCatalog` answers with for the OpenRouter account: 466 models. */
export const OPENROUTER_CATALOG: ModelCatalog = {
  providerAccountId: OPENROUTER_ID,
  readAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  error: null,
  models: buildOpenRouterModels(),
};

/** The OpenRouter account, with the catalog above read three hours before the page loads. */
export const OPENROUTER_ACCOUNT: ProviderAccount = {
  id: OPENROUTER_ID,
  providerId: "openrouter/openrouter",
  kind: "api-key",
  label: null,
  identity: null,
  planLabel: null,
  defaultHarnessId: "pi/pi",
  expiresAt: null,
  usage: [],
  failure: null,
  snapshots: [],
  createdAt: "2026-09-10T09:00:00.000Z",
  updatedAt: "2026-09-10T09:00:00.000Z",
  modelCount: OPENROUTER_CATALOG.models.length,
  catalogReadAt: OPENROUTER_CATALOG.readAt,
  catalogError: null,
  readiness: [],
};

/** Returns `profile` with a section for the OpenRouter account at the end, holding three of its models. */
export const addOpenRouterSection = (profile: ModelProfile): ModelProfile => ({
  ...profile,
  accounts: [
    ...profile.accounts,
    buildProfileSection(
      OPENROUTER,
      OPENROUTER_CATALOG.models
        .slice(0, 3)
        .map((model) => buildProfileEntry(OPENROUTER, model.slug, { name: model.name })),
    ),
  ],
});
