/**
 * A plugin's configuration form, as data: fields from JSON Schema, the stored
 * config read into them, and the config a draft means. All three are readings
 * of the domain, so they live here with a test rather than in a component.
 *
 * The shapes handled are exactly the ones the host derives - a flat object of
 * strings, numbers, integers, booleans, string enums and string arrays -
 * because a plugin whose schema goes beyond that is refused at load and carries
 * no schema at all.
 */
import type { Issue, PluginConfigureInput } from "@hydra/contract";
import { ApiError } from "./errors";

/** What one setting is, and which widget renders it. */
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

/** What a widget holds while the user is editing. One shape per kind. */
export type ConfigValue = string | boolean | ReadonlyArray<string>;

/** The whole form, keyed by field name. */
export type ConfigDraft = Readonly<Record<string, ConfigValue>>;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asStrings = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;

/** Which widget one property asks for. */
const kindOf = (property: Record<string, unknown>): ConfigFieldKind => {
  const type = property["type"];
  if (type === "boolean" || type === "number" || type === "integer") return type;
  if (type === "string") return property["enum"] === undefined ? "string" : "enum";
  return "stringList";
};

/** The fields one config schema asks for, in the order it lists them. */
export const configFields = (
  schema: Record<string, unknown> | undefined,
): ReadonlyArray<ConfigField> => {
  const properties = asRecord(schema?.["properties"]);
  if (properties === undefined) return [];
  const required = new Set(asStrings(schema?.["required"]) ?? []);

  const fields: ConfigField[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    const property = asRecord(raw) ?? {};
    const kind = kindOf(property);

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

const storedValue = (field: ConfigField, stored: unknown): ConfigValue => {
  if (field.kind === "boolean") return stored === true;
  if (field.kind === "stringList") return asStrings(stored) ?? [];
  if (typeof stored === "number" || typeof stored === "string") return String(stored);
  return "";
};

export const configDraft = (fields: ReadonlyArray<ConfigField>, config: unknown): ConfigDraft => {
  const stored = asRecord(config) ?? {};
  return Object.fromEntries(
    fields.map((field) => [field.name, storedValue(field, stored[field.name])]),
  );
};

/**
 * A checkbox and a list both have a value at rest, so writing every one back
 * would store a `false` or an `[]` under a setting nobody touched, which is not
 * the same as unset. A required one is written either way: it has no unset.
 */
const unfilled = (field: ConfigField, stored: Record<string, unknown>, atRest: boolean): boolean =>
  atRest && !field.required && stored[field.name] === undefined;

/**
 * The config a draft means, typed the way the schema names. An empty text or
 * number field is left out rather than sent as `""` or `NaN`: absent is the one
 * thing every schema can say about a setting nobody filled in, and whether that
 * is allowed is the plugin's schema to answer. The stored config is read for
 * the same reason - it says which settings the user has an answer for.
 */
export const configPayload = (
  fields: ReadonlyArray<ConfigField>,
  draft: ConfigDraft,
  config: unknown,
): Readonly<Record<string, ConfigJson>> => {
  const stored = asRecord(config) ?? {};
  const payload: Record<string, ConfigJson> = {};
  for (const field of fields) {
    const value = draft[field.name];
    if (field.kind === "boolean") {
      if (!unfilled(field, stored, value !== true)) payload[field.name] = value === true;
    } else if (field.kind === "stringList") {
      const list = [...(asStrings(value) ?? [])];
      if (!unfilled(field, stored, list.length === 0)) payload[field.name] = list;
    } else if (typeof value === "string" && value !== "") {
      payload[field.name] =
        field.kind === "string" || field.kind === "enum" ? value : Number(value);
    }
  }
  return payload;
};

/** What a refused write blamed, split by whether this form can show it. */
export interface ConfigIssues {
  /** The message per field, keyed by the field its path names. */
  readonly perField: Readonly<Record<string, string>>;
  /**
   * Whether anything the call was refused for lands on no rendered field. It
   * has to be said as the form's own failure, or a write is refused and the
   * card says nothing.
   */
  readonly rest: boolean;
}

/** What a refused write blamed, read against the fields this form renders. */
export const configIssues = (error: unknown, fields: ReadonlyArray<ConfigField>): ConfigIssues => {
  if (error === null || error === undefined) return { perField: {}, rest: false };
  if (!(error instanceof ApiError) || error.code !== "validation") {
    return { perField: {}, rest: true };
  }
  const issues = asRecord(error.details)?.["issues"];
  if (!Array.isArray(issues)) return { perField: {}, rest: true };

  const rendered = new Set(fields.map((field) => field.name));
  const perField: Record<string, string> = {};
  let rest = false;
  for (const issue of issues as ReadonlyArray<Issue>) {
    const field = issue.path[0];
    if (field !== undefined && rendered.has(field)) perField[field] ??= issue.message;
    else rest = true;
  }
  return { perField, rest };
};
