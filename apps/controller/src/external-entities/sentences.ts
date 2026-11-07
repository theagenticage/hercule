/**
 * The one place that turns a kind's declared sentence into finished text.
 *
 * A kind declares its `reasons` as templates such as "{person} mentioned you".
 * The entity keeps a copy of that table (`reason_templates`), so a sentence
 * can be written long after the plugin is gone. A card's reason, the lines of
 * its signals and the rows of its timeline all use this module, so they fill,
 * cut and fall back the same way.
 */
import { MAX_ENTITY_REASON_LENGTH, type EntityReason } from "@hercule/contract";
import { cutTextAtWord } from "../text";

/** The kind's `reasons` table as copied onto an entity at observation: `{ key: { say, tone } }`. */
export type ReasonTemplates = Readonly<
  Record<string, { readonly say: string; readonly tone: EntityReason["tone"] }>
>;

/** A `{name}` placeholder in a sentence template. */
const PLACEHOLDER = /\{([A-Za-z0-9_-]+)\}/g;

/**
 * Parses the stored `reason_templates` of an entity, or returns undefined
 * when the entity has none.
 */
export const parseReasonTemplates = (text: string | null): ReasonTemplates | undefined =>
  text === null ? undefined : (JSON.parse(text) as ReasonTemplates);

/** Returns the names of the `{name}` placeholders in `template`, in order, a repeated name once per use. */
export const listPlaceholders = (template: string): ReadonlyArray<string> =>
  Array.from(template.matchAll(PLACEHOLDER), (match) => match[1]!);

/**
 * Fills each `{name}` of `template` from `facts`. Returns undefined when the
 * template names something `facts` does not hold, so the caller can fall back
 * to other words instead of showing a half-filled sentence.
 */
export const fillSentence = (
  template: string,
  facts: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  let complete = true;
  const filled = template.replace(PLACEHOLDER, (_, name: string) => {
    const value = facts[name];
    if (value === undefined) complete = false;
    return value ?? "";
  });
  return complete ? filled : undefined;
};

/**
 * Builds a sentence with its tone. It uses `template` filled from `facts`
 * when there is a template and it can be filled to a non-empty text. Otherwise
 * it uses `fallback` with the `plain` tone. The text is cut at a word to the
 * length an `EntityReason` allows.
 */
export const renderSentence = (
  template: { readonly say: string; readonly tone: EntityReason["tone"] } | undefined,
  facts: Readonly<Record<string, string | undefined>>,
  fallback: string,
): EntityReason => {
  const filled = template === undefined ? undefined : fillSentence(template.say, facts);
  return filled === undefined || filled.trim() === ""
    ? { say: cutTextAtWord(fallback, MAX_ENTITY_REASON_LENGTH), tone: "plain" }
    : { say: cutTextAtWord(filled, MAX_ENTITY_REASON_LENGTH), tone: template!.tone };
};
