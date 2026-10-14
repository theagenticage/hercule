/**
 * Wakes the runs whose text-generation step waits for a runner, when a change
 * may let a runner take its call:
 *
 * - a provider snapshot is stored, which can show a new login or model on a
 *   runner;
 * - the `textGeneration.model` setting is written, which changes the model
 *   the call runs on.
 *
 * A runner that connects, or that may have become placeable, wakes the same
 * runs elsewhere (see `Arrival` and `Inbound`). The domains that publish the
 * two changes do not import the runs domain, so the wake is wired here.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { PromotionState } from "../../promotion";
import { ProviderProbes } from "../../providers";
import { RunService } from "../../runs";
import { SettingsOperations } from "../../settings";
import { absorbFailures } from "../absorbing";

const make = Effect.gen(function* () {
  const probes = yield* ProviderProbes;
  const settings = yield* SettingsOperations;
  const runs = yield* RunService;
  const promotion = yield* PromotionState;

  return {
    /**
     * Runs forever. Wakes the runs waiting for a runner each time a provider
     * snapshot is stored or the `textGeneration.model` setting is written.
     * The wakes run one at a time; changes that arrive meanwhile are merged
     * into the next one.
     */
    driving: Stream.runForEach(
      Stream.merge(probes.snapshotChanges, settings.textGenerationModelChanges),
      () =>
        absorbFailures(
          "Waking the runs waiting for text generation failed",
          promotion.whenServing(runs.wakeRunsWaitingForRunner()),
        ),
    ),
  };
});

export class TextGenerationWakes extends Context.Service<
  TextGenerationWakes,
  Effect.Success<typeof make>
>()("hercule/controller/daemon/TextGenerationWakes") {}

export const TextGenerationWakesLayer: Layer.Layer<
  TextGenerationWakes,
  never,
  ProviderProbes | SettingsOperations | RunService | PromotionState
> = Layer.effect(TextGenerationWakes)(make);
