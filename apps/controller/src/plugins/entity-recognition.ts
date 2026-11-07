/**
 * Pure recognition of what a text names, over the entity lookups of event
 * sources.
 *
 * Two callers need it. `EntityLookups.recognize` answers the Add button on
 * Work. The ingest context recognizes the web addresses and texts a plugin's
 * poll reports. The ingest context cannot depend on the plugin host, which
 * needs the ingest loops that build it, so it reads the host's active sources
 * through `EntityRecognizer`, a small accessor the host fills in when it
 * starts.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type { EntityRecognition } from "@hercule/plugin-host";
import type { RegisteredEventSource } from "./event-sources";

/** The most recognitions one plugin returns for a text. */
const MAX_RECOGNITIONS = 20;

/** One plugin's recognition of a text. The recognition's `kind`, when it has one, is qualified. */
export interface PluginRecognition {
  readonly pluginId: string;
  readonly recognition: EntityRecognition;
}

/** Returns the recognition with its `kind`, when it has one, qualified by the plugin id. */
const qualifyKind = (pluginId: string, recognition: EntityRecognition): EntityRecognition =>
  recognition.kind === undefined
    ? recognition
    : { ...recognition, kind: `${pluginId}/${recognition.kind}` };

/**
 * Returns what each source's lookup recognizes in `text`, source by source in
 * the order given. Pure: no plugin gets credentials, and none makes a request.
 * A recognition's `kind`, when it has one, is qualified with the plugin id. A
 * lookup that throws recognizes nothing, and a warning in the log names the
 * plugin.
 */
export const recognizeInSources = (
  sources: ReadonlyArray<RegisteredEventSource>,
  text: string,
): Effect.Effect<ReadonlyArray<PluginRecognition>> =>
  Effect.map(
    Effect.forEach(sources, (source) => {
      const lookup = source.entityLookup;
      if (lookup === undefined) return Effect.succeed<ReadonlyArray<PluginRecognition>>([]);
      try {
        return Effect.succeed(
          lookup
            .recognize(text)
            .slice(0, MAX_RECOGNITIONS)
            .map((recognition) => ({
              pluginId: source.pluginId,
              recognition: qualifyKind(source.pluginId, recognition),
            })),
        );
      } catch (error) {
        return Effect.as(
          Effect.logWarning(
            `The entity lookup of ${source.pluginId} failed to recognize a text: ${String(error)}`,
          ),
          [] as ReadonlyArray<PluginRecognition>,
        );
      }
    }),
    (perSource) => perSource.flat(),
  );

/** Lists the event sources of the plugins that are active now. */
type ListActiveSources = () => Effect.Effect<ReadonlyArray<RegisteredEventSource>>;

const makeRecognizer = Effect.gen(function* () {
  const listSources = yield* Ref.make<ListActiveSources>(() => Effect.succeed([]));
  return {
    /**
     * Tells the recognizer where the active sources come from. The plugin host
     * calls it once, when it starts. Until then no plugin is active, so
     * nothing is recognized.
     */
    useActiveSources: (list: ListActiveSources): Effect.Effect<void> => Ref.set(listSources, list),

    /**
     * Returns a function that recognizes a text over the plugins that are
     * active at this moment. Read it once per call that recognizes several
     * texts, so they all see the same plugins.
     */
    readRecognizer: (): Effect.Effect<
      (text: string) => Effect.Effect<ReadonlyArray<PluginRecognition>>
    > =>
      Effect.map(
        Effect.flatMap(Ref.get(listSources), (list) => list()),
        (sources) => (text) => recognizeInSources(sources, text),
      ),
  };
});

/**
 * Gives the ingest context the host's active sources at call time, without a
 * dependency on the plugin host (which would be a construction cycle).
 */
export class EntityRecognizer extends Context.Service<
  EntityRecognizer,
  Effect.Success<typeof makeRecognizer>
>()("hercule/controller/plugins/EntityRecognizer") {}

export const EntityRecognizerLayer: Layer.Layer<EntityRecognizer> =
  Layer.effect(EntityRecognizer)(makeRecognizer);
