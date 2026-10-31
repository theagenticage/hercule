import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { PluginHost } from "../plugins";
import { asUser, buildPluginStack } from "../plugins/testing";
import { ACME_PROVIDER_ID, buildAccountPlugins } from "../provider-accounts/testing";
import { ProviderService, ProviderServiceLayer } from "./service";

describe("provider.query", () => {
  it("lists the registered providers with their account kinds, setup steps and harnesses", async () => {
    const providers = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.flatMap(PluginHost, (host) => host.boot(buildAccountPlugins()));
        return yield* Effect.flatMap(ProviderService, (service) => service.query());
      }).pipe(
        Effect.provide(ProviderServiceLayer.pipe(Layer.provideMerge(buildPluginStack()))),
        asUser,
      ),
    );

    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ id: ACME_PROVIDER_ID, displayName: "Acme" });
    expect(
      providers[0]?.kinds.map((kind) => [
        kind.id,
        kind.setup.map((step) => step.kind),
        kind.harnesses,
      ]),
    ).toEqual([
      ["api-key", ["credentials"], ["alpha/alpha", "beta/beta"]],
      ["subscription", ["harness-login"], ["alpha/alpha"]],
    ]);
  });
});
