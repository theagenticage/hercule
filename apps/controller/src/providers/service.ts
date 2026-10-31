/**
 * The `provider.query` operation: every Provider a plugin registered, with its
 * Account Kinds. A Provider is a plugin contribution, so it is never stored.
 * The accounts users hold at a Provider are in the provider-accounts domain.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Forbidden, Provider, Unauthenticated } from "@hercule/contract";
import { requireGrant } from "../actor";
import { PluginHost } from "../plugins";

const make = Effect.gen(function* () {
  const host = yield* PluginHost;

  return {
    /** Returns every registered Provider, in the order the plugins registered them. */
    query: (): Effect.Effect<ReadonlyArray<Provider>, Unauthenticated | Forbidden> =>
      Effect.gen(function* () {
        yield* requireGrant("provider.query");
        const registered = yield* host.providers();
        return registered.map((definition) => ({
          id: definition.id,
          pluginId: definition.pluginId,
          displayName: definition.displayName,
          kinds: definition.kinds,
        }));
      }),
  };
});

export class ProviderService extends Context.Service<
  ProviderService,
  Effect.Success<typeof make>
>()("hercule/controller/providers/ProviderService") {}

export const ProviderServiceLayer: Layer.Layer<ProviderService, never, PluginHost> =
  Layer.effect(ProviderService)(make);
