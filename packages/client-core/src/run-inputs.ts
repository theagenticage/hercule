/**
 * The run form, as data: one field per input a workflow declares, the values
 * the form starts with, and the `inputs` a run is started with.
 *
 * The form does not check the values against the inputs' JSON Schemas. Only
 * the controller applies them, and a second check in the browser could
 * disagree with it about the same value. The controller's `validation` issues
 * come back at `inputs.<name>`, and the form shows each under its field.
 */
import {
  formatIssue,
  type Connection,
  type RunInputs,
  type WorkflowDefinition,
} from "@hercule/contract";
import { isNamedAfterAccount } from "./connections";
import { readValidationIssues } from "./errors";
import { parseWorkflowSourceWithRanges } from "./workflow-source";
import { readJsonObject, readStringList } from "./json-shape";

type InputDeclaration = NonNullable<WorkflowDefinition["inputs"]>[number];

/** One Connection a `connection` field offers. */
export interface ConnectionChoice {
  readonly id: string;
  /**
   * The Connection's label and its account, `work · octocat`, or the label
   * alone, `octocat`, when the Connection is named after its account.
   */
  readonly label: string;
  /** A disabled Connection is shown but cannot be chosen, because the controller refuses it. */
  readonly disabled: boolean;
}

/** What every field has, whatever its widget. */
interface FieldBase {
  readonly name: string;
  /** The schema's `description`, or for a Connection its type. */
  readonly description: string | undefined;
  readonly required: boolean;
}

/**
 * One input of the run form, with the widget it is edited with:
 * - `text`: a string;
 * - `number`: a number or an integer;
 * - `boolean`: a checkbox;
 * - `enum`: a choice of a string schema's `enum` values;
 * - `connection`: a choice of the Connections of one type;
 * - `json`: JSON text, for an object, an array, or a schema with no type.
 */
export type RunInputField =
  | (FieldBase & { readonly kind: "text" | "number" | "json"; readonly initial: string })
  | (FieldBase & { readonly kind: "boolean"; readonly initial: boolean | undefined })
  | (FieldBase & {
      readonly kind: "enum";
      readonly initial: string;
      /** The choices, in the schema's order. */
      readonly options: ReadonlyArray<string>;
    })
  | (FieldBase & {
      readonly kind: "connection";
      readonly initial: string;
      readonly connections: ReadonlyArray<ConnectionChoice>;
      /** The qualified type the Connections have, such as `github/github`. */
      readonly connectionType: string;
    });

/**
 * What a number field holds when the browser cannot read its text as a
 * number, such as `1.2.3`. The browser reports such text as empty, and an
 * empty field is left out of the run, so without this the run would start
 * with the input's default and the user would never know.
 */
export const UNREADABLE_NUMBER = Symbol("unreadable number");

/**
 * The value a widget holds while the user edits it: text, or for a checkbox
 * `true`, `false`, or `undefined` while the user has not touched it.
 */
export type RunInputValue = string | boolean | undefined | typeof UNREADABLE_NUMBER;

/** The whole form, keyed by input name. */
export type RunInputDraft = Readonly<Record<string, RunInputValue>>;

/** Converts a default to the text a text widget shows, or returns empty text when there is none. */
const toText = (value: unknown, isJson: boolean): string =>
  value === undefined ? "" : typeof value === "string" && !isJson ? value : JSON.stringify(value);

/** Returns the field for one input declaration. */
const buildField = (
  declaration: InputDeclaration,
  connections: ReadonlyArray<Connection>,
): RunInputField => {
  const schema = readJsonObject(declaration.schema) ?? {};
  const schemaDescription = schema["description"];
  const base = {
    name: declaration.name,
    description: typeof schemaDescription === "string" ? schemaDescription : undefined,
    required: declaration.required,
  };
  const connectionType = declaration.connection?.type;
  if (connectionType !== undefined) {
    return {
      ...base,
      kind: "connection",
      description: base.description ?? `A ${connectionType} Connection.`,
      initial: toText(declaration.default, false),
      connectionType,
      connections: connections
        .filter((connection) => connection.type === connectionType)
        .map((connection) => ({
          id: connection.id,
          label: isNamedAfterAccount(connection)
            ? connection.label
            : `${connection.label} · ${connection.displayName}`,
          disabled: connection.status === "disabled",
        })),
    };
  }
  const type = schema["type"];
  const options = readStringList(schema["enum"]);
  if (type === "string" && options !== undefined) {
    return { ...base, kind: "enum", options, initial: toText(declaration.default, false) };
  }
  if (type === "string")
    return { ...base, kind: "text", initial: toText(declaration.default, false) };
  if (type === "number" || type === "integer") {
    return { ...base, kind: "number", initial: toText(declaration.default, false) };
  }
  if (type === "boolean") {
    const initial = declaration.default;
    return {
      ...base,
      kind: "boolean",
      initial: typeof initial === "boolean" ? initial : undefined,
    };
  }
  return { ...base, kind: "json", initial: toText(declaration.default, true) };
};

/** The run form of a stored workflow: its fields, or why the form cannot have any. */
export type RunFormReading =
  { readonly fields: ReadonlyArray<RunInputField> } | { readonly refusal: string };

/**
 * Returns the run form's fields for a stored workflow's source, one per
 * declared input, in the order they are declared. A source that does not
 * parse as a workflow, such as one a newer contract rejects, has no fields
 * the form can trust, so the reading holds the reason instead.
 */
export const buildRunForm = (
  source: string,
  connections: ReadonlyArray<Connection>,
): RunFormReading => {
  const { definition } = parseWorkflowSourceWithRanges(source);
  if (definition === undefined) {
    return {
      refusal: "the saved workflow does not parse. Open it to see its problems",
    };
  }
  return {
    fields: (definition.inputs ?? []).map((declaration) => buildField(declaration, connections)),
  };
};

/**
 * Checks whether a form has a Connection field. Only such a form needs the
 * Connections read before it can be shown; any other form is complete without
 * them.
 */
export const hasConnectionField = (fields: ReadonlyArray<RunInputField>): boolean =>
  fields.some((field) => field.kind === "connection");

/**
 * Returns the errors to show when the form could not be read, such as a lost
 * connection to the controller: "The form could not be read: <message>." The
 * message does not mention starting, because nothing was started.
 */
export const buildRunFormLoadIssues = (reason: unknown): RunInputIssues => ({
  perField: {},
  summary: `The form could not be read: ${readMessage(reason).replace(/\.$/, "")}.`,
  general: [],
});

/** Returns the message of an error, a string as it is, and any other value as JSON. */
const readMessage = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : JSON.stringify(error);

/** Returns the values the form starts with, keyed by input name. */
export const buildRunInputDraft = (fields: ReadonlyArray<RunInputField>): RunInputDraft =>
  Object.fromEntries(fields.map((field) => [field.name, field.initial]));

/** The result of reading a draft: the inputs to send, or the fields whose text cannot be read. */
export type RunInputsReading =
  { readonly inputs: RunInputs } | { readonly errors: Readonly<Record<string, string>> };

/**
 * Converts a draft into the `inputs` of a run. An empty field and a checkbox
 * the user has not touched are left out, so the controller applies the
 * input's default or reports that a required input is missing. A number or
 * JSON text that cannot be read is an error on its field, because sending it
 * would only move the same error to the controller.
 *
 * Text is sent exactly as the user typed it, so text of only spaces is a
 * value like any other, and the input's schema decides whether it is allowed.
 * Number and JSON text ignore the whitespace around a value, so in those
 * fields whitespace alone is as empty as no text at all.
 */
export const buildRunInputs = (
  fields: ReadonlyArray<RunInputField>,
  draft: RunInputDraft,
): RunInputsReading => {
  const inputs: Record<string, RunInputs[string]> = {};
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = field.name in draft ? draft[field.name] : field.initial;
    if (value === UNREADABLE_NUMBER) {
      errors[field.name] = "Enter a number.";
      continue;
    }
    if (value === undefined) continue;
    if (typeof value === "boolean") {
      inputs[field.name] = value;
      continue;
    }
    const isNumberOrJson = field.kind === "number" || field.kind === "json";
    if ((isNumberOrJson ? value.trim() : value) === "") continue;
    if (field.kind === "number") {
      const number = Number(value);
      if (Number.isFinite(number)) inputs[field.name] = number;
      else errors[field.name] = "Enter a number.";
    } else if (field.kind === "json") {
      try {
        inputs[field.name] = JSON.parse(value) as RunInputs[string];
      } catch {
        errors[field.name] = "This is not valid JSON.";
      }
    } else {
      inputs[field.name] = value;
    }
  }
  return Object.keys(errors).length === 0 ? { inputs } : { errors };
};

/** The controller's errors for a refused run, split by where the form shows them. */
export interface RunInputIssues {
  /** The first error for each field, keyed by input name. */
  readonly perField: Readonly<Record<string, string>>;
  /**
   * The sentence the form shows above its buttons when an error belongs to
   * no field, such as "Not started: this workflow cannot run as it is saved
   * now.", or `undefined` when every error is on a field.
   */
  readonly summary: string | undefined;
  /**
   * The errors that belong to no field, each with its path, such as a
   * problem in a workflow that no longer validates. An error nobody is shown
   * is an error nobody can fix.
   */
  readonly general: ReadonlyArray<string>;
}

/** Returns the summary sentence for an error message: "Not started: <message>." */
const buildSummary = (message: string): string => `Not started: ${message.replace(/\.$/, "")}.`;

/**
 * Returns the errors of a refused run: each issue at `inputs.<name>` goes to
 * that field, and every other issue goes to `general`, under a summary. An
 * error that lists no issues, such as an unknown workflow or a lost
 * connection, has only its summary.
 */
export const buildRunInputIssues = (
  error: unknown,
  fields: ReadonlyArray<RunInputField>,
): RunInputIssues => {
  if (error === null || error === undefined) {
    return { perField: {}, summary: undefined, general: [] };
  }
  const message = readMessage(error);
  const issues = readValidationIssues(error);
  if (issues === undefined) return { perField: {}, summary: buildSummary(message), general: [] };
  const names = new Set(fields.map((field) => field.name));
  const perField: Record<string, string> = {};
  const general: string[] = [];
  for (const issue of issues) {
    const [head, name] = issue.path;
    if (head === "inputs" && name !== undefined && names.has(name)) {
      perField[name] ??= issue.message;
    } else {
      general.push(formatIssue(issue));
    }
  }
  // A refusal whose issues all sit on fields needs no sentence of its own;
  // any other refusal does, or the form would show nothing.
  const isAllOnFields = general.length === 0 && Object.keys(perField).length > 0;
  return { perField, summary: isAllOnFields ? undefined : buildSummary(message), general };
};

/**
 * Returns the errors the run form shows, from everything that can go wrong
 * with it, most recent concern first:
 * - a refused start, because it is what the user asked about last;
 * - a read that failed, such as the workflow or, for a form with a Connection
 *   field, the Connections;
 * - a stored workflow that does not parse.
 */
export const decideRunFormIssues = ({
  startError,
  loadError,
  form,
}: {
  readonly startError: unknown;
  readonly loadError: unknown;
  readonly form: RunFormReading | undefined;
}): RunInputIssues => {
  if (startError !== null && startError !== undefined) {
    return buildRunInputIssues(
      startError,
      form !== undefined && "fields" in form ? form.fields : [],
    );
  }
  if (loadError !== null && loadError !== undefined) return buildRunFormLoadIssues(loadError);
  if (form !== undefined && "refusal" in form) return buildRunFormLoadIssues(form.refusal);
  return buildRunInputIssues(null, []);
};
