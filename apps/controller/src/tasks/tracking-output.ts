/**
 * Shapes what an agent step produced into the `TrackingOutput` the
 * Tracking pane draws (`task.readTracking`).
 *
 * A step with no output schema ends with `{ text, exitStatus }`, and its
 * `text` is the agent's last message. A step with an output schema ends with
 * an object that fits the schema. The pane draws the first as text and the
 * second as a list of labelled fields. Both are cut, and so is the step's
 * name, so a reply stays small whatever the agent or the workflow's author
 * wrote.
 */
import type * as Schema from "effect/Schema";
import {
  MAX_TRACKING_OUTPUT_FIELDS,
  MAX_TRACKING_OUTPUT_LABEL,
  MAX_TRACKING_OUTPUT_TEXT,
  MAX_TRACKING_OUTPUT_VALUE,
  MAX_TRACKING_STEP_NAME,
  type TrackingOutput,
  type TrackingOutputField,
  type TrackingOutputValue,
} from "@hercule/contract";
import { cutText } from "../text";

/** What the shaping reads of a completed agent step. */
export interface CompletedAgentStep {
  /** The step's `name`, else its id. Any length: `shapeTrackingOutput` cuts it. */
  readonly stepName: string;
  /** The session that ran the step. Absent when the step has none. */
  readonly sessionId: string | undefined;
  /** The output the step completed with. */
  readonly output: Schema.Json;
  /** The step's `outputSchema`, when it declares one. */
  readonly outputSchema: { readonly [name: string]: Schema.Json } | undefined;
}

/** Checks that a JSON value is an object, not an array or null. */
const isJsonObject = (value: Schema.Json | undefined): value is { [name: string]: Schema.Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Shapes one field value: strings are cut, an array or an object is counted. */
const shapeValue = (value: Schema.Json): TrackingOutputValue => {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return cutText(value, MAX_TRACKING_OUTPUT_VALUE);
  if (Array.isArray(value)) return { items: value.length };
  return { fields: Object.keys(value).length };
};

/**
 * Returns the label of a field: the `title` of its property in the output
 * schema, else the property's name, cut to `MAX_TRACKING_OUTPUT_LABEL`
 * characters. A title is as long as its author wrote it, and a property's
 * name is whatever key the agent put in its output, so neither is bounded
 * until it is cut here.
 */
const buildFieldLabel = (
  properties: { [name: string]: Schema.Json } | undefined,
  name: string,
): string => {
  const property = properties?.[name];
  const label =
    isJsonObject(property) && typeof property["title"] === "string" && property["title"] !== ""
      ? property["title"]
      : name;
  return cutText(label, MAX_TRACKING_OUTPUT_LABEL);
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
    label: buildFieldLabel(properties, name),
    value: shapeValue(output[name]!),
  }));
};

/**
 * Returns the `TrackingOutput` the pane draws for a completed agent step, or
 * `undefined` when the step left nothing to draw:
 *
 * - a step with an output schema gives `fields`, unless the step's output
 *   is not an object or holds none of the schema's properties;
 * - a step with no output schema gives `text` from the step's output
 *   `text`, unless that is missing, not a string, or blank.
 */
export const shapeTrackingOutput = (step: CompletedAgentStep): TrackingOutput | undefined => {
  const identity = {
    stepName: cutText(step.stepName, MAX_TRACKING_STEP_NAME),
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
