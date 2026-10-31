/**
 * Helpers for tests that run the Model Profile service on a real database and
 * the real plugin host, with no HTTP in between. They build on the Provider
 * Account fixtures (the provider `acme/acme` and the harnesses `alpha/alpha`
 * and `beta/beta`) and add what profiles need: the service, and the
 * membership store that Provider Accounts calls when an account is deleted.
 */
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import type { ModelDescriptor } from "@hercule/protocol";
import { withTransaction } from "../db";
import { NotifierLayer } from "../notifications";
import type { Plugin } from "@hercule/plugin-host";
import { PluginHost } from "../plugins";
import { asUser, buildPluginStack } from "../plugins/testing";
import {
  HarnessAccountsLayer,
  modelCatalogRepository,
  ModelCatalogsLayer,
  ModelProfileMembership,
  ProviderAccountProbesLayer,
  ProviderAccountRunnersLayer,
  ProviderAccountServiceLayer,
  ProviderKeyRequestsLayer,
} from "../provider-accounts";
import {
  buildAccountPlugins,
  buildFakeProviderApi,
  type AccountServices,
} from "../provider-accounts/testing";
import { RunnerConnectionsLayer } from "../runners";
import { SettingsLayer } from "../settings";
import { AccountUsageLayer } from "../usage";
import * as SqlClient from "effect/sql/SqlClient";
import { ProjectService, ProjectServiceLayer } from "../projects";
import { ModelProfileLookupLayer } from "./lookup";
import { ModelProfileMembershipLayer } from "./membership";
import { ModelProfileService, ModelProfileServiceLayer } from "./service";

const buildStack = (providerApi: HttpClient.HttpClient) =>
  ModelProfileServiceLayer.pipe(
    Layer.provideMerge(ProjectServiceLayer),
    Layer.provideMerge(ModelProfileLookupLayer),
    Layer.provideMerge(ProviderAccountServiceLayer),
    Layer.provideMerge(ProviderKeyRequestsLayer),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, providerApi)),
    Layer.provideMerge(ProviderAccountProbesLayer),
    Layer.provideMerge(ModelCatalogsLayer),
    Layer.provideMerge(ProviderAccountRunnersLayer),
    Layer.provideMerge(HarnessAccountsLayer),
    Layer.provideMerge(SettingsLayer),
    Layer.provideMerge(AccountUsageLayer),
    Layer.provideMerge(RunnerConnectionsLayer),
    Layer.provideMerge(NotifierLayer),
    Layer.provideMerge(ModelProfileMembershipLayer),
    Layer.provideMerge(buildPluginStack()),
  );

export type ProfileServices =
  | AccountServices
  | ModelProfileService
  | ModelProfileMembership
  | ProjectService;

/**
 * Runs an effect as the user on a fresh database, after the fixture plugins
 * have been booted. The database starts with the profile "Main", which the
 * migration made. A test that needs other providers passes `plugins` in place
 * of the fixture plugins.
 */
export const runWithProfiles = <A, E>(
  body: Effect.Effect<A, E, ProfileServices>,
  plugins: ReadonlyArray<Plugin> = buildAccountPlugins(),
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.flatMap(PluginHost, (host) => host.boot(plugins));
      return yield* body;
    }).pipe(Effect.provide(buildStack(buildFakeProviderApi().client)), asUser) as Effect.Effect<
      A,
      E,
      never
    >,
  );

/** Builds a model the way a harness lists it: not legacy, not the default, no options. */
export const buildModel = (
  slug: string,
  extra: Partial<ModelDescriptor> = {},
): ModelDescriptor => ({ slug, name: `Model ${slug}`, imageInput: null, options: [], ...extra });

/** Stores a successful catalog read for the account: its models, in this order, read at `readAt`. */
export const storeCatalog = (
  accountId: string,
  models: ReadonlyArray<ModelDescriptor>,
  readAt = "2026-10-31T09:00:00.000Z",
): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const catalogs = yield* modelCatalogRepository;
    yield* withTransaction(sql, catalogs.recordSuccess(accountId, models, readAt, readAt));
  });
