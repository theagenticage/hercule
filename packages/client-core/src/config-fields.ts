/**
 * A plugin's configuration form, as data.
 *
 * The controller serves the plugin's config schema as JSON Schema, and the
 * screen has to turn it into fields, read the stored config into them, and hand
 * back a config typed the way the schema names. All three are readings of the
 * domain, so they live here with a test rather than inside a component; what is
 * left in the app is one widget per kind.
 *
 * The shapes accepted here are exactly the ones the host will derive: a flat
 * object of strings, numbers, integers, booleans, string enums and string
 * arrays. Anything else never reaches a client, because a plugin whose schema
 * goes beyond that is turned away at load and carries no schema at all.
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

/** A config, in the shape the API carries it. */
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

/**
 * Which widget one property asks for. The six are the whole of what a config
 * schema may hold: the host derives this document and refuses every other shape
 * before it is persisted, so nothing else reaches a client.
 */
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

/** What a field holds before the user has touched anything. */
const storedValue = (field: ConfigField, stored: unknown): ConfigValue => {
  if (field.kind === "boolean") return stored === true;
  if (field.kind === "stringList") return asStrings(stored) ?? [];
  if (typeof stored === "number" || typeof stored === "string") return String(stored);
  return "";
};

/** The stored config read into the widgets, one entry per field. */
export const configDraft = (fields: ReadonlyArray<ConfigField>, config: unknown): ConfigDraft => {
  const stored = asRecord(config) ?? {};
  return Object.fromEntries(
    fields.map((field) => [field.name, storedValue(field, stored[field.name])]),
  );
};

/**
 * The config a draft means, typed the way the schema names.
 *
 * An empty text or number field is left out of the config rather than sent as
 * an empty string or a `NaN`: absent is the one thing every schema can say
 * about a setting nobody filled in. Whether that absence is allowed is the
 * plugin's schema to answer, and only the controller holds it.
 */
export const configPayload = (
  fields: ReadonlyArray<ConfigField>,
  draft: ConfigDraft,
): ConfigJson => {
  const config: Record<string, ConfigJson> = {};
  for (const field of fields) {
    const value = draft[field.name];
    if (field.kind === "boolean") {
      config[field.name] = value === true;
    } else if (field.kind === "stringList") {
      config[field.name] = [...(asStrings(value) ?? [])];
    } else if (typeof value === "string" && value !== "") {
      config[field.name] = field.kind === "string" || field.kind === "enum" ? value : Number(value);
    }
  }
  return config;
};

/**
 * The message per field a refused write blamed, keyed by the field its path
 * names. Anything else the call could have failed with belongs to the form as a
 * whole, not to one field, so it comes back empty.
 */
export const configIssues = (error: unknown): Readonly<Record<string, string>> => {
  if (!(error instanceof ApiError) || error.code !== "validation") return {};
  const issues = asRecord(error.details)?.["issues"];
  if (!Array.isArray(issues)) return {};

  const messages: Record<string, string> = {};
  for (const issue of issues as ReadonlyArray<Issue>) {
    const field = issue.path[0];
    if (field !== undefined) messages[field] ??= issue.message;
  }
  return messages;
};
