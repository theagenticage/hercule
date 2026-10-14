/**
 * The changes that may let a runner take a text generation that found none.
 * A call that waits for a runner (see `TextGeneration.generate`) subscribes
 * here and looks for a runner again after each change.
 *
 * A change is announced:
 *
 * - when a provider snapshot is stored, which can show a new login or model
 *   on a runner;
 * - when the `textGeneration.model` setting is written, which changes the
 *   model the call runs on, or turns text generation off;
 * - when a runner connects, may have become placeable, or is retired (see
 *   `Arrival`, `Inbound` and `Retirement`).
 *
 * The domains that publish the first two changes do not know about text
 * generation's waits, so `forwardTargetChanges` passes them on here.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ProviderProbes } from "../../providers";
import { SettingsOperations } from "../../settings";

const make = Effect.gen(function* () {
  // Each subscriber keeps at most one change it has not taken yet: a waiting
  // call only needs to know that something changed since it last looked.
  const changes = yield* PubSub.sliding<void>(1);
  return {
    /** Announces a change to every call waiting for a runner. */
    announce: (): Effect.Effect<void> => Effect.asVoid(PubSub.publish(changes, undefined)),
    /**
     * Subscribes to the changes for the life of the scope. Take from the
     * subscription with `PubSub.takeAll`, which waits for the next change and
     * takes every change announced since.
     */
    subscribe: (): Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope> =>
      PubSub.subscribe(changes),
  };
});

export class TextGenerationTargetChanges extends Context.Service<
  TextGenerationTargetChanges,
  Effect.Success<typeof make>
>()("hercule/controller/daemon/TextGenerationTargetChanges") {}

export const TextGenerationTargetChangesLayer: Layer.Layer<TextGenerationTargetChanges> =
  Layer.effect(TextGenerationTargetChanges)(make);

/**
 * Announces a change each time a provider snapshot is stored or the
 * `textGeneration.model` setting is written. Never returns.
 */
export const forwardTargetChanges: Effect.Effect<
  void,
  never,
  ProviderProbes | SettingsOperations | TextGenerationTargetChanges
> = Effect.gen(function* () {
  const probes = yield* ProviderProbes;
  const settings = yield* SettingsOperations;
  const targetChanges = yield* TextGenerationTargetChanges;
  yield* Stream.runForEach(
    Stream.merge(probes.snapshotChanges, settings.textGenerationModelChanges),
    targetChanges.announce,
  );
});
