/**
 * Pure recognition of what a text names, over the entity lookups of event
 * sources.
 *
 * Two callers need it. `EntityLookups.recognize` answers the Add button on
 * Work. The External Entities ingest recognizes the web addresses and texts a
 * plugin's poll reports: the ingest context hands it a `RecognizeText` over
 * the sources that are active at that moment.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ExternalRef } from "@hercule/contract";
import type { EntityRecognition } from "@hercule/plugin-host";
import type { RegisteredEventSource } from "./event-sources";

/** The most recognitions one plugin returns for a text. */
const MAX_RECOGNITIONS = 20;

/**
 * A thing that a plugin recognized but cannot place without reading it. `kind`
 * is the qualified kind word and `scopeHint` the scope the text named, either
 * of which may be absent. A pending claim keeps the same four fields in its
 * target (see `PendingTarget`).
 */
export interface ScopedTarget {
  readonly pluginId: string;
  readonly kind?: string;
  readonly scopeHint?: string;
  readonly identifier: string;
}

/** What recognition found a reference to. A `ref` names exactly one thing. A `scoped` target needs a read to place. */
export type RecognizedTarget =
  | { readonly recognized: "ref"; readonly ref: string }
  | ({ readonly recognized: "scoped" } & ScopedTarget);

/** Recognizes a text over the plugins that are active now. Pure: it makes no request. */
export type RecognizeText = (text: string) => Effect.Effect<ReadonlyArray<PluginRecognition>>;

/** Lists the event sources of the plugins that are active now. */
export type ListActiveSources = () => Effect.Effect<ReadonlyArray<RegisteredEventSource>>;

/** One plugin's recognition of a text. The recognition's `kind`, when it has one, is qualified. */
export interface PluginRecognition {
  readonly pluginId: string;
  readonly recognition: EntityRecognition;
}

/**
 * Builds the recognition a lookup reads for a scoped target. The `kind` stays
 * qualified, as `EntityLookups.resolve` expects.
 */
export const buildScopedRecognition = (target: ScopedTarget): EntityRecognition => ({
  recognized: "scoped",
  form: "identifier",
  ...(target.kind === undefined ? {} : { kind: target.kind }),
  identifier: target.identifier,
  ...(target.scopeHint === undefined ? {} : { scopeHint: target.scopeHint }),
});

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

const isExternalRef = Schema.is(ExternalRef);

/**
 * Converts a plugin's recognition to a target for a claim. Returns undefined
 * for a ref that is not a valid External Ref (or that is a pending target in
 * disguise) and for a scoped recognition with no identifier. Both the poll
 * and the resolver loop use it, so a target is checked the same way wherever
 * it comes from.
 */
export const buildRecognizedTarget = ({
  pluginId,
  recognition,
}: PluginRecognition): RecognizedTarget | undefined => {
  if (recognition.recognized === "ref") {
    return isExternalRef(recognition.ref) && !recognition.ref.startsWith("unresolved:")
      ? { recognized: "ref", ref: recognition.ref }
      : undefined;
  }
  if (recognition.identifier === "") return undefined;
  return {
    recognized: "scoped",
    pluginId,
    ...(recognition.kind === undefined || recognition.kind === ""
      ? {}
      : { kind: recognition.kind }),
    ...(recognition.scopeHint === undefined || recognition.scopeHint === ""
      ? {}
      : { scopeHint: recognition.scopeHint }),
    identifier: recognition.identifier,
  };
};

/**
 * Returns the target of a web address from what the plugins recognized in it:
 * the first recognition with `form: "url"`, in registry order. Returns
 * undefined when no plugin recognized the address, or when the first one is
 * not a usable target (see `buildRecognizedTarget`). The poll and the resolver
 * loop both read an address this way, so one address is never two things.
 */
export const findUrlTarget = (
  recognitions: ReadonlyArray<PluginRecognition>,
): RecognizedTarget | undefined => {
  const found = recognitions.find(({ recognition }) => recognition.form === "url");
  return found === undefined ? undefined : buildRecognizedTarget(found);
};
