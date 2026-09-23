/**
 * A plugin's configuration form, as data: the fields built from a JSON Schema,
 * the stored config converted into a draft, and a draft converted back into a
 * config. These rules live here with a test rather than in a component.
 *
 * Only the schemas the plugin host accepts are handled: a flat object of
 * strings, numbers, integers, booleans, string enums and string arrays. The
 * host refuses to load a plugin whose schema uses anything else, so such a
 * plugin has no schema here.
 */
import type { PluginConfigureInput } from "@hercule/contract";
import { readValidationIssues } from "./errors";

/** The type of a setting, which decides the widget that renders it. */
export type ConfigFieldKind = "string" | "number" | "integer" | "boolean" | "enum" | "stringList";

export interface ConfigField {
  readonly name: string;
  readonly kind: ConfigFieldKind;
  readonly label: string;
  readonly description?: string;
  readonly required: boolean;
  /** The choices of an `enum` field, in the order the schema lists them. */
  readonly options?: ReadonlyArray<string>;
}

export type ConfigJson = PluginConfigureInput["config"];

/** The value a widget holds while the user edits it. Each kind uses one of these types. */
export type ConfigValue = string | boolean | ReadonlyArray<string>;

/** The whole form, keyed by field name. */
export type ConfigDraft = Readonly<Record<string, ConfigValue>>;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asStrings = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;

/** Returns the field kind for a schema property. */
const decideFieldKind = (property: Record<string, unknown>): ConfigFieldKind => {
  const type = property["type"];
  if (type === "boolean" || type === "number" || type === "integer") return type;
  if (type === "string") return property["enum"] === undefined ? "string" : "enum";
  return "stringList";
};

/** Returns the form fields for a config schema, in the schema's order. */
export const buildConfigFields = (
  schema: Record<string, unknown> | undefined,
): ReadonlyArray<ConfigField> => {
  const properties = asRecord(schema?.["properties"]);
  if (properties === undefined) return [];
  const required = new Set(asStrings(schema?.["required"]) ?? []);

  const fields: ConfigField[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    const property = asRecord(raw) ?? {};
    const kind = decideFieldKind(property);

    const title = property["title"];
    const description = property["description"];
    fields.push({
      name,
      kind,
      label: typeof title === "string" ? title : name,
      ...(typeof description === "string" ? { description } : {}),
      required: required.has(name),
      ...(kind === "enum" ? { options: asStrings(property["enum"]) ?? [] } : {}),
    });
  }
  return fields;
};

const toDraftValue = (field: ConfigField, stored: unknown): ConfigValue => {
  if (field.kind === "boolean") return stored === true;
  if (field.kind === "stringList") return asStrings(stored) ?? [];
  if (typeof stored === "number" || typeof stored === "string") return String(stored);
  return "";
};

/**
 * Returns the form's starting values: the stored config, converted to each
 * field's widget value.
 */
export const buildConfigDraft = (
  fields: ReadonlyArray<ConfigField>,
  config: unknown,
): ConfigDraft => {
  const stored = asRecord(config) ?? {};
  return Object.fromEntries(
    fields.map((field) => [field.name, toDraftValue(field, stored[field.name])]),
  );
};

/**
 * Checks whether a checkbox or list field should be left out of the payload.
 * Both always have a value (`false`, `[]`), so writing each one back would
 * store a value for a setting nobody touched, which is not the same as unset.
 * A required field is always written, because it cannot be unset.
 */
const isUnfilled = (
  field: ConfigField,
  stored: Record<string, unknown>,
  atRest: boolean,
): boolean => atRest && !field.required && stored[field.name] === undefined;

/**
 * Returns the config to send for a draft, with each value converted to the
 * type the schema declares. An empty text or number field is left out rather
 * than sent as `""` or `NaN`: every schema can express "absent", and the
 * plugin's schema decides whether that is allowed. The stored config is read
 * for the same reason: it shows which settings the user has already set.
 */
export const buildConfigPayload = (
  fields: ReadonlyArray<ConfigField>,
  draft: ConfigDraft,
  config: unknown,
): Readonly<Record<string, ConfigJson>> => {
  const stored = asRecord(config) ?? {};
  const payload: Record<string, ConfigJson> = {};
  for (const field of fields) {
    const value = draft[field.name];
    if (field.kind === "boolean") {
      if (!isUnfilled(field, stored, value !== true)) payload[field.name] = value === true;
    } else if (field.kind === "stringList") {
      const list = [...(asStrings(value) ?? [])];
      if (!isUnfilled(field, stored, list.length === 0)) payload[field.name] = list;
    } else if (typeof value === "string" && value !== "") {
      payload[field.name] =
        field.kind === "string" || field.kind === "enum" ? value : Number(value);
    }
  }
  return payload;
};

/**
 * The validation errors of a rejected write, split by whether the form can show
 * them on a field.
 */
export interface ConfigIssues {
  /** The error message for each field, keyed by field name. */
  readonly perField: Readonly<Record<string, string>>;
  /**
   * Whether any error does not belong to a rendered field. The form must then
   * show a general error, or the write fails and the card shows nothing.
   */
  readonly rest: boolean;
}

/**
 * Returns the errors of a failed write, matched to the fields this form
 * renders.
 *
 * A write with more than one set of fields (for example a connection's pasted
 * credentials next to the type's own settings) puts the set's name first in
 * each issue path; `prefix` selects the set this form renders. Any error that
 * does not match a rendered field sets `rest`, because a message under a field
 * nobody can see is an error nobody is told about.
 */
export const readConfigIssues = (
  error: unknown,
  fields: ReadonlyArray<{ readonly name: string }>,
  prefix?: string,
): ConfigIssues => {
  if (error === null || error === undefined) return { perField: {}, rest: false };
  const issues = readValidationIssues(error);
  if (issues === undefined) return { perField: {}, rest: true };

  const rendered = new Set(fields.map((field) => field.name));
  const perField: Record<string, string> = {};
  let rest = false;
  for (const issue of issues) {
    const [head, next] = issue.path;
    const field = prefix === undefined ? head : head === prefix ? next : undefined;
    if (field !== undefined && rendered.has(field)) perField[field] ??= issue.message;
    else rest = true;
  }
  return { perField, rest };
};
