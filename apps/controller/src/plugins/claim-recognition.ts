/**
 * Turns the web addresses and texts an observation reports into what the
 * active plugins recognize in them, before the observations reach the External
 * Entities domain.
 *
 * A plugin is untrusted input, and the observations are only decoded later, by
 * the External Entities ingest. So this module checks the counts and the sizes
 * of what it will search before it calls any recognizer. An observation that
 * breaks a bound gets no recognized claims here, and the ingest then refuses
 * the whole call with its own message.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ExternalRef } from "@hercule/contract";
import {
  MAX_ENTITY_OBSERVATIONS,
  LinkedUrls,
  ObservationTexts,
  type EntityObservation,
} from "@hercule/plugin-host";
import type { PluginRecognition } from "./entity-recognition";
import type {
  RecognizedClaims,
  RecognizedClaimsByRef,
  RecognizedTarget,
  StoredTextRevisions,
} from "./entity-observations";

/** The most things one text may name. The rest of the text is not searched for more. */
export const MAX_TARGETS_PER_TEXT = 20;

/** A function that recognizes a text over the plugins that are active now. */
export type RecognizeText = (text: string) => Effect.Effect<ReadonlyArray<PluginRecognition>>;

/** A function that reads the revisions stored for the texts of the given refs. */
export type ReadStoredTextRevisions = (
  refs: ReadonlyArray<string>,
) => Effect.Effect<StoredTextRevisions>;

const isExternalRef = Schema.is(ExternalRef);
const isLinkedUrls = Schema.is(LinkedUrls);
const isObservationTexts = Schema.is(ObservationTexts);

/** What recognition reads of an observation, whatever the plugin really sent. */
interface ReportedShape {
  readonly ref: unknown;
  readonly relations?: { readonly linkedUrls?: unknown };
  readonly texts?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Returns the web addresses of the observation when they all fit the bounds, or undefined when one does not. */
const readLinkedUrls = (observation: ReportedShape): ReadonlyArray<string> | undefined => {
  const urls = observation.relations?.linkedUrls;
  if (urls === undefined) return [];
  return isLinkedUrls(urls) ? urls : undefined;
};

/** Returns the texts of the observation when they all fit the bounds, or undefined when one does not. */
const readTexts = (
  observation: ReportedShape,
): Schema.Schema.Type<typeof ObservationTexts> | undefined => {
  const texts = observation.texts;
  if (texts === undefined) return [];
  return isObservationTexts(texts) ? texts : undefined;
};

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

const buildTargetKey = (target: RecognizedTarget): string =>
  target.recognized === "ref"
    ? `ref\u0000${target.ref}`
    : JSON.stringify([target.pluginId, target.kind, target.scopeHint, target.identifier]);

/** One observation that fits the bounds and carries something to search. */
interface Searchable {
  readonly ref: string;
  readonly linkedUrls: ReadonlyArray<string>;
  readonly texts: Schema.Schema.Type<typeof ObservationTexts>;
}

/**
 * Recognizes the web addresses and texts of `observations`, and returns the
 * result for each observation that has any, by ref.
 *
 * - A web address is given the first recognition with `form: "url"` among the
 *   active plugins, in registry order. No such recognition leaves its target
 *   out.
 * - A text is given every thing any plugin recognizes in it, each once, at
 *   most `MAX_TARGETS_PER_TEXT`.
 * - The same address or text is recognized once per call, however many
 *   observations carry it.
 * - A text with a `revision` is not searched when the stored claims of its
 *   `evidenceKey` were made from the same revision (`readStoredRevisions`,
 *   called once for the whole call). Its entry then has no `targets`, and the
 *   claims stay as they are.
 *
 * Never fails. Returns no claims at all for a call of more than
 * `MAX_ENTITY_OBSERVATIONS` observations, or for something that is not a list,
 * which the ingest refuses.
 */
export const recognizeClaims = (
  observations: ReadonlyArray<EntityObservation>,
  recognize: RecognizeText,
  readStoredRevisions?: ReadStoredTextRevisions,
): Effect.Effect<RecognizedClaimsByRef> =>
  Effect.gen(function* () {
    const byRef = new Map<string, RecognizedClaims>();
    if (!Array.isArray(observations) || observations.length > MAX_ENTITY_OBSERVATIONS) return byRef;

    const searchable: Array<Searchable> = [];
    for (const observation of observations as ReadonlyArray<ReportedShape>) {
      if (!isRecord(observation) || typeof observation.ref !== "string") continue;
      const linkedUrls = readLinkedUrls(observation);
      const texts = readTexts(observation);
      if (linkedUrls === undefined || texts === undefined) continue;
      if (linkedUrls.length === 0 && texts.length === 0) continue;
      searchable.push({ ref: observation.ref, linkedUrls, texts });
    }

    const refsWithRevisions = searchable
      .filter(({ texts }) => texts.some(({ revision }) => revision !== undefined))
      .map(({ ref }) => ref);
    const storedRevisions =
      readStoredRevisions === undefined || refsWithRevisions.length === 0
        ? new Map<string, ReadonlyMap<string, string>>()
        : yield* readStoredRevisions(refsWithRevisions);

    const urlTargets = new Map<string, RecognizedTarget | undefined>();
    const textTargets = new Map<string, ReadonlyArray<RecognizedTarget>>();

    const recognizeUrl = (url: string) =>
      Effect.gen(function* () {
        if (urlTargets.has(url)) return urlTargets.get(url);
        const recognitions = yield* recognize(url);
        const found = recognitions.find(({ recognition }) => recognition.form === "url");
        const target = found === undefined ? undefined : buildRecognizedTarget(found);
        urlTargets.set(url, target);
        return target;
      });

    const recognizeText = (text: string) =>
      Effect.gen(function* () {
        const known = textTargets.get(text);
        if (known !== undefined) return known;
        const targets = new Map<string, RecognizedTarget>();
        for (const recognition of yield* recognize(text)) {
          const target = buildRecognizedTarget(recognition);
          if (target !== undefined) targets.set(buildTargetKey(target), target);
          if (targets.size === MAX_TARGETS_PER_TEXT) break;
        }
        const list = [...targets.values()];
        textTargets.set(text, list);
        return list;
      });

    for (const { ref, linkedUrls, texts } of searchable) {
      const urls: Array<RecognizedClaims["urls"][number]> = [];
      for (const url of new Set(linkedUrls)) {
        const target = yield* recognizeUrl(url);
        urls.push(target === undefined ? { url } : { url, target });
      }
      const recognizedTexts: Array<RecognizedClaims["texts"][number]> = [];
      for (const { evidenceKey, text, revision } of texts) {
        const unchanged =
          revision !== undefined && storedRevisions.get(ref)?.get(evidenceKey) === revision;
        recognizedTexts.push({
          evidenceKey,
          ...(revision === undefined ? {} : { revision }),
          ...(unchanged ? {} : { targets: yield* recognizeText(text) }),
        });
      }
      byRef.set(ref, { urls, texts: recognizedTexts });
    }
    return byRef;
  });
