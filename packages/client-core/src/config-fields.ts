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
    fields.push({
      name,
      kind,
      label: typeof title === "string" ? title : name,
      ...(typeof description === "string" ? { description } : {}),
      required: required.has(name),
      ...(kind === "enum" ? { options: readStringList(property["enum"]) ?? [] } : {}),
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
  const stored = readJsonObject(config) ?? {};
  const payload: Record<string, ConfigJson> = {};
  for (const field of fields) {
    const value = draft[field.name];
    if (field.kind === "boolean") {
      if (!isUnfilled(field, stored, value !== true)) payload[field.name] = value === true;
    } else if (field.kind === "stringList") {
      const list = [...(readStringList(value) ?? [])];
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
