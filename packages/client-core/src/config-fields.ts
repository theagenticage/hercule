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
import type { Issue, PluginConfigureInput } from "@hercule/contract";
import { readValidationIssues } from "./errors";
import { readJsonObject, readStringList } from "./json-shape";

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
  /**
   * The schema's default for a text or number field, as text. The form shows
   * it as the placeholder, so an empty field shows the value the plugin uses
   * when the setting is unset. Absent when the schema declares no default.
   */
  readonly defaultValue?: string;
}

export type ConfigJson = PluginConfigureInput["config"];

/** The value a widget holds while the user edits it. Each kind uses one of these types. */
export type ConfigValue = string | boolean | ReadonlyArray<string>;

/** The whole form, keyed by field name. */
export type ConfigDraft = Readonly<Record<string, ConfigValue>>;

/** Returns the field kind for a schema property. */
const decideFieldKind = (property: Record<string, unknown>): ConfigFieldKind => {
  const type = property["type"];
  if (type === "boolean" || type === "number" || type === "integer") return type;
  if (type === "string") return property["enum"] === undefined ? "string" : "enum";
  return "stringList";
};

/**
 * Returns the default of a text or number field as text, or `undefined` when
 * the schema declares none. Other kinds get none, because a checkbox, a
 * select and a list have no placeholder to show it in.
 */
const readDefaultValue = (
  kind: ConfigFieldKind,
  property: Record<string, unknown>,
): string | undefined => {
  if (kind !== "string" && kind !== "number" && kind !== "integer") return undefined;
  const value = property["default"];
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
};

/** Returns the form fields for a config schema, in the schema's order. */
export const buildConfigFields = (
  schema: Record<string, unknown> | undefined,
): ReadonlyArray<ConfigField> => {
  const properties = readJsonObject(schema?.["properties"]);
  if (properties === undefined) return [];
  const required = new Set(readStringList(schema?.["required"]) ?? []);

  const fields: ConfigField[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    const property = readJsonObject(raw) ?? {};
    const kind = decideFieldKind(property);

    const title = property["title"];
    const description = property["description"];
    const defaultValue = readDefaultValue(kind, property);
    fields.push({
      name,
      kind,
      label: typeof title === "string" ? title : name,
      ...(typeof description === "string" ? { description } : {}),
      required: required.has(name),
      ...(kind === "enum" ? { options: readStringList(property["enum"]) ?? [] } : {}),
      ...(defaultValue === undefined ? {} : { defaultValue }),
    });
  }
  return fields;
};

/**
 * Returns the heading the form shows above the config's fields: the schema's
 * own `title`, so the plugin can name what its settings are about, or
 * "Configuration" when the schema has no title.
 */
export const readConfigHeading = (schema: Record<string, unknown> | undefined): string => {
  const title = schema?.["title"];
  return typeof title === "string" && title !== "" ? title : "Configuration";
};

const toDraftValue = (field: ConfigField, stored: unknown): ConfigValue => {
  if (field.kind === "boolean") return stored === true;
  if (field.kind === "stringList") return readStringList(stored) ?? [];
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
  const stored = readJsonObject(config) ?? {};
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

/** The message under an integer field whose text is not an integer. */
export const CONFIG_INTEGER_UNREADABLE = "Enter an integer.";

/** The message under a number field whose text is not a number. */
export const CONFIG_NUMBER_UNREADABLE = "Enter a number.";

/**
 * Parses an integer, such as "7" or "-5", from typed text. Returns
 * `undefined` for anything else, including "1.5", "1e3" and "0x10", which
 * `Number` alone would read as numbers the user did not type.
 */
const parseInteger = (text: string): number | undefined => {
  const trimmed = text.trim();
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : undefined;
};

/**
 * Parses a decimal number, such as "1.5" or "-2", from typed text. Returns
 * `undefined` for anything else, including "1e3" and "0x10", which `Number`
 * alone would read as numbers the user did not type.
 */
const parseDecimal = (text: string): number | undefined => {
  const trimmed = text.trim();
  return /^-?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : undefined;
};

/** The result of reading a draft: the config to send, or the fields whose text cannot be read. */
export type ConfigReading =
  | { readonly config: Readonly<Record<string, ConfigJson>> }
  | { readonly errors: Readonly<Record<string, string>> };

/**
 * Converts a draft into the config to send, with each value converted to the
 * type the schema declares. An empty field is left out rather than sent as
 * `""`: every schema can express "absent", and the plugin's schema decides
 * whether that is allowed. The stored config is read for the same reason: it
 * shows which settings the user has already set.
 *
 * A number field whose text cannot be read as a number is an error on that
 * field, and nothing is sent:
 *
 * - an integer field takes digits with an optional minus, so "abc", "1.5"
 *   and "1e3" are refused;
 * - a number field takes digits with an optional minus and decimal part, so
 *   "abc" and "1e3" are refused.
 *
 * Nothing else about a value is checked here, such as a minimum. Only the
 * controller holds the plugin's schema, and the form shows its errors under
 * the fields, so the browser and the controller never disagree about a rule.
 */
export const buildConfigPayload = (
  fields: ReadonlyArray<ConfigField>,
  draft: ConfigDraft,
  config: unknown,
): ConfigReading => {
  const stored = readJsonObject(config) ?? {};
  const payload: Record<string, ConfigJson> = {};
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = draft[field.name];
    if (field.kind === "boolean") {
      if (!isUnfilled(field, stored, value !== true)) payload[field.name] = value === true;
    } else if (field.kind === "stringList") {
      const list = [...(readStringList(value) ?? [])];
      if (!isUnfilled(field, stored, list.length === 0)) payload[field.name] = list;
    } else if (field.kind === "string" || field.kind === "enum") {
      if (typeof value === "string" && value !== "") payload[field.name] = value;
    } else if (typeof value === "string" && value.trim() !== "") {
      const number = field.kind === "integer" ? parseInteger(value) : parseDecimal(value);
      if (number !== undefined) payload[field.name] = number;
      else
        errors[field.name] =
          field.kind === "integer" ? CONFIG_INTEGER_UNREADABLE : CONFIG_NUMBER_UNREADABLE;
    }
  }
  return Object.keys(errors).length === 0 ? { config: payload } : { errors };
};

/**
 * The validation errors of a rejected write, split by whether the form can show
 * them on a field.
 */
export interface ConfigIssues {
  /** The error message for each field, keyed by field name. */
  readonly perField: Readonly<Record<string, string>>;
  /**
   * The error message for each entry of a list field, keyed by field name and
   * then by the entry's position, counted from 0. The form shows each one
   * under its entry, so the user can tell which entry is wrong.
   */
  readonly perEntry: Readonly<Record<string, Readonly<Record<number, string>>>>;
  /**
   * Whether any error does not belong to a rendered field. The form must then
   * show a general error, or the write fails and the card shows nothing.
   */
  readonly rest: boolean;
}

const NO_CONFIG_ISSUES: ConfigIssues = { perField: {}, perEntry: {}, rest: false };

/**
 * Matches validation issues to the fields a form renders. Each issue's path
 * starts at a field name: a caller whose paths start with a group name, such
 * as `config`, removes it first.
 *
 * - A path of a field name and a position, such as `["repos", "2"]`, goes
 *   under that entry of the list field. The positions match the entries on
 *   screen, because the forms clear a save's errors on any edit.
 * - Any other path that starts at a rendered field goes under that field.
 * - Any other issue sets `rest`.
 *
 * Only the first error of each field, and of each entry, is kept.
 */
export const matchConfigIssues = (
  issues: ReadonlyArray<Issue>,
  fields: ReadonlyArray<{ readonly name: string }>,
): ConfigIssues => {
  const rendered = new Set(fields.map((field) => field.name));
  const perField: Record<string, string> = {};
  const perEntry: Record<string, Record<number, string>> = {};
  let rest = false;
  for (const { path, message } of issues) {
    const [field, position] = path;
    if (field === undefined || !rendered.has(field)) rest = true;
    else if (path.length === 2 && position !== undefined && /^\d+$/.test(position))
      (perEntry[field] ??= {})[Number(position)] ??= message;
    else perField[field] ??= message;
  }
  return { perField, perEntry, rest };
};

/**
 * Returns the errors of a failed write, matched to the fields this form
 * renders, as `matchConfigIssues` describes.
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
  if (error === null || error === undefined) return NO_CONFIG_ISSUES;
  const issues = readValidationIssues(error);
  if (issues === undefined) return { ...NO_CONFIG_ISSUES, rest: true };
  if (prefix === undefined) return matchConfigIssues(issues, fields);

  const inGroup = listIssuesInGroup(issues, prefix);
  const matched = matchConfigIssues(inGroup, fields);
  return inGroup.length === issues.length ? matched : { ...matched, rest: true };
};

/**
 * Returns the issues whose path starts with the group's name, with that name
 * removed from each path.
 */
export const listIssuesInGroup = (
  issues: ReadonlyArray<Issue>,
  group: string,
): ReadonlyArray<Issue> =>
  issues.flatMap((issue) =>
    issue.path[0] === group ? [{ path: issue.path.slice(1), message: issue.message }] : [],
  );
