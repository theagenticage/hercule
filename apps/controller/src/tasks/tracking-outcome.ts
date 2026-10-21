/**
 * Shapes what an agent step produced into the outcome the Tracking pane
 * draws (`task.readTracking`).
 *
 * A step with no output schema ends with `{ text, exitStatus }`, and its
 * `text` is the agent's last message. A step with an output schema ends with
 * an object that fits the schema. The pane draws the first as text and the
 * second as a list of labelled fields. Both are cut, so a reply stays small
 * whatever the agent wrote.
 */
import type * as Schema from "effect/Schema";
import {
  MAX_TRACKING_OUTPUT_FIELDS,
  MAX_TRACKING_OUTPUT_TEXT,
  MAX_TRACKING_OUTPUT_VALUE,
  type TrackingOutcome,
  type TrackingOutputField,
  type TrackingOutputValue,
} from "@hercule/contract";

/** What the shaping reads of a completed agent step. */
export interface AgentStepResult {
  /** The step's `name`, else its id. */
  readonly stepName: string;
  /** The session that ran the step. Absent when the step has none. */
  readonly sessionId: string | undefined;
  /** The output the step completed with. */
  readonly output: Schema.Json;
  /** The step's `outputSchema`, when it declares one. */
  readonly outputSchema: { readonly [name: string]: Schema.Json } | undefined;
}

const ELLIPSIS = "…";

/** Checks that a JSON value is an object, not an array or null. */
const isJsonObject = (value: Schema.Json | undefined): value is { [name: string]: Schema.Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Cuts `text` to at most `limit` characters and ends it with "…". Returns
 * `text` unchanged when it fits.
 *
 * The cut falls at the last paragraph break within the limit, else the last
 * line break, else the last space, else at the limit. Ending on a break keeps
 * a sentence or a list item from being torn in half. The cut never splits a
 * surrogate pair, which would leave half an emoji.
 */
export const cutText = (text: string, limit: number): string => {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const breaks = [head.lastIndexOf("\n\n"), head.lastIndexOf("\n"), head.search(/\s\S*$/)];
  const at = breaks.find((index) => index > 0);
  if (at !== undefined) return head.slice(0, at).trimEnd() + ELLIPSIS;
  const lastCode = head.charCodeAt(head.length - 1);
  const isHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
  return (isHighSurrogate ? head.slice(0, -1) : head) + ELLIPSIS;
};

/** Shapes one field value: strings are cut, an array or an object is counted. */
const shapeValue = (value: Schema.Json): TrackingOutputValue => {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return cutText(value, MAX_TRACKING_OUTPUT_VALUE);
  if (Array.isArray(value)) return { items: value.length };
  return { fields: Object.keys(value).length };
};

/**
 * Returns the label of a field: the `title` of its property in the output
 * schema, else the property's name.
 */
const readFieldLabel = (properties: { [name: string]: Schema.Json } | undefined, name: string) => {
  const title = properties?.[name];
  return isJsonObject(title) && typeof title["title"] === "string" && title["title"] !== ""
    ? title["title"]
    : name;
};

/**
 * Returns the fields of a structured output, at most
 * `MAX_TRACKING_OUTPUT_FIELDS`. They come in the order of the schema's
 * properties, so the pane lists them as the author of the schema ordered
 * them. A schema that lists no properties gives the output's own order.
 */
const shapeFields = (
  output: { [name: string]: Schema.Json },
  outputSchema: { readonly [name: string]: Schema.Json },
): ReadonlyArray<TrackingOutputField> => {
  const declared = outputSchema["properties"];
  const properties = isJsonObject(declared) ? declared : undefined;
  const names = (properties === undefined ? Object.keys(output) : Object.keys(properties)).filter(
    (name) => Object.hasOwn(output, name),
  );
  return names.slice(0, MAX_TRACKING_OUTPUT_FIELDS).map((name) => ({
    label: readFieldLabel(properties, name),
    value: shapeValue(output[name]!),
  }));
};

/**
 * Returns the outcome the pane draws for a completed agent step, or
 * `undefined` when the step left nothing to draw:
 *
 * - a step with an output schema gives a `fields` outcome, unless its output
 *   is not an object or holds none of the schema's properties;
 * - a step with no output schema gives a `text` outcome from the output's
 *   `text`, unless that is missing, not a string, or blank.
 */
export const shapeTrackingOutcome = (step: AgentStepResult): TrackingOutcome | undefined => {
  const identity = {
    stepName: step.stepName,
    ...(step.sessionId === undefined ? {} : { sessionId: step.sessionId }),
  };
  if (!isJsonObject(step.output)) return undefined;
  if (step.outputSchema !== undefined) {
    const fields = shapeFields(step.output, step.outputSchema);
    return fields.length === 0 ? undefined : { kind: "fields", ...identity, fields };
  }
  const text = step.output["text"];
  if (typeof text !== "string" || text.trim() === "") return undefined;
  return { kind: "text", ...identity, text: cutText(text.trim(), MAX_TRACKING_OUTPUT_TEXT) };
};
