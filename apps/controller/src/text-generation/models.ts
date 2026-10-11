/**
 * Works out which provider instance and model text generations run on now,
 * from the `textGeneration.model` setting.
 *
 * - `off`: nothing runs.
 * - A chosen instance and model: exactly that. It is never replaced by
 *   another provider, so a user who chose Codex never has a call quietly go
 *   to Claude.
 * - `automatic` (the default when the setting is unset): the first provider in
 *   `AUTOMATIC_PROVIDER_ORDER` that has an instance logged in on a runner
 *   whose catalog holds the provider's suggested text generation model.
 *   Choosing the model is visible, not hidden: Settings shows what
 *   `automatic` resolves to.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { PluginHost } from "../plugins";
import { isLoggedIn, providerRepository, type StoredSnapshot } from "../providers";
import { runnerRepository } from "../runners";
import { Settings } from "../settings";

/**
 * The providers `automatic` tries, best first. The order is a decision of the
 * controller, not of a provider, so a plugin cannot move itself to the front.
 * Each provider names its own suggested model on its definition.
 */
export const AUTOMATIC_PROVIDER_ORDER: ReadonlyArray<string> = ["codex", "pi", "claude-code"];

/**
 * What the setting resolves to:
 *
 * - `off`: text generation is switched off.
 * - `resolved`: calls run on this instance and model.
 * - `unresolved`: no model can be used, and `message` says why in words a
 *   user can act on. For example `automatic` found no match.
 */
export type TextGenerationChoice =
  | { readonly _tag: "off" }
  | {
      readonly _tag: "resolved";
      readonly instanceId: string;
      readonly providerId: string;
      readonly model: string;
    }
  | { readonly _tag: "unresolved"; readonly message: string };

const NO_AUTOMATIC_MATCH =
  "no provider instance is logged in to a model that text generation suggests; log one in, or choose a model in Settings";

const CHOSEN_INSTANCE_GONE =
  "the provider instance chosen for text generation no longer exists; choose another in Settings";

const make = Effect.gen(function* () {
  const settings = yield* Settings;
  const instances = yield* providerRepository;
  const runners = yield* runnerRepository;
  const host = yield* PluginHost;

  /**
   * Finds the first instance, in provider order, that is logged in on a
   * runner (a reserved or retired runner does not count) and whose catalog
   * there holds its provider's suggested model.
   */
  const resolveAutomatic: Effect.Effect<TextGenerationChoice, SqlError> = Effect.gen(function* () {
    const usable = new Set((yield* runners.listPlacementCandidates()).map((one) => one.id));
    const definitions = yield* host.providers();
    const all = yield* instances.list();
    const snapshots = yield* instances.snapshots();
    const offers = (instanceId: string, model: string): boolean =>
      snapshots.some(
        (snapshot: StoredSnapshot) =>
          snapshot.instanceId === instanceId &&
          usable.has(snapshot.runnerId) &&
          isLoggedIn(snapshot) &&
          snapshot.models.some((one) => one.slug === model),
      );
    for (const providerId of AUTOMATIC_PROVIDER_ORDER) {
      const model = definitions.find((one) => one.id === providerId)?.suggestedTextGenerationModel;
      if (model === undefined) continue;
      const instance = all.find((one) => one.providerId === providerId && offers(one.id, model));
      if (instance !== undefined) {
        return { _tag: "resolved", instanceId: instance.id, providerId, model } as const;
      }
    }
    return { _tag: "unresolved", message: NO_AUTOMATIC_MATCH } as const;
  }).pipe(
    // A stored row that no longer decodes is corruption, not a state the
    // caller can act on.
    Effect.catchTag("SchemaError", Effect.die),
  );

  return {
    /**
     * Resolves the setting to what text generations run on now. Reads the
     * stored snapshots and never probes a runner, so a login that expired
     * since the last probe still resolves; the call then fails and says so.
     * Fails only when the database cannot be read.
     */
    resolve: (): Effect.Effect<TextGenerationChoice, SqlError> =>
      Effect.gen(function* () {
        const setting = (yield* settings.all())["textGeneration.model"] ?? "automatic";
        if (setting === "off") return { _tag: "off" } as const;
        if (setting === "automatic") return yield* resolveAutomatic;
        const found = yield* Effect.catchTag(
          instances.one(setting.instanceId),
          "SchemaError",
          Effect.die,
        );
        return Option.isNone(found)
          ? ({ _tag: "unresolved", message: CHOSEN_INSTANCE_GONE } as const)
          : ({
              _tag: "resolved",
              instanceId: found.value.id,
              providerId: found.value.providerId,
              model: setting.model,
            } as const);
      }),
  };
});

/** The text generation model, as the setting resolves it. */
export class TextGenerationModels extends Context.Service<
  TextGenerationModels,
  Effect.Success<typeof make>
>()("hercule/controller/text-generation/TextGenerationModels") {}

export const TextGenerationModelsLayer: Layer.Layer<
  TextGenerationModels,
  never,
  SqlClient.SqlClient | Settings | PluginHost
> = Layer.effect(TextGenerationModels)(make);
