/**
 * Human output.
 *
 * `--json` prints the contract's output schema verbatim and this module is not
 * reached. Everything here is for a person: a page becomes a table, a single
 * object becomes aligned key-value lines, and ids are shortened to the tail the
 * CLI accepts back as an argument.
 */
import type {
  Issue,
  StructuredResult,
  Workflow,
  WorkflowAction,
  WorkflowIssues,
  WorkflowSaved,
} from "@hercule/contract";
import type { Outcome } from "./execute";
import type { Command } from "./tree";

/** A canonical lowercase UUIDv7; the only value shortened to a tail. */
const CANONICAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** How long a tail the human rendering prints, and the shortest the CLI accepts. */
const TAIL = 8;

const cell = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return CANONICAL_ID.test(value) ? value.slice(-TAIL) : value;
  if (Array.isArray(value)) return value.map(cell).join(",");
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? "";
};

/** Every key any row has, in the order the rows introduce them. */
const columnsOf = (rows: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<string> => {
  const columns: Array<string> = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  }
  return columns;
};

/**
 * A table cell on one line. A value that spans several lines, such as a
 * description, would break its row across the columns, so the cell shows the
 * value's first line and " ..." to say that more follows. The space keeps the
 * dots apart from a full stop that ends the first line.
 */
const keepOnOneLine = (text: string): string => {
  const lineBreak = text.search(/[\r\n]/);
  return lineBreak === -1 ? text : `${text.slice(0, lineBreak).trimEnd()} ...`;
};

const table = (rows: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<string> => {
  if (rows.length === 0) return ["no results"];
  const columns = columnsOf(rows);
  const body = rows.map((row) => columns.map((column) => keepOnOneLine(cell(row[column]))));
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...body.map((row) => row[index]!.length)),
  );
  const line = (cells: ReadonlyArray<string>): string =>
    cells
      .map((text, index) => (index === cells.length - 1 ? text : text.padEnd(widths[index]!)))
      .join("  ")
      .trimEnd();
  return [line(columns), ...body.map(line)];
};

/**
 * A nested object becomes dotted keys rather than a JSON blob, so
 * `hercule settings read` reads as the flat key set it is. An array stays a cell:
 * its elements are values, not sub-keys.
 */
const flatten = (
  value: Record<string, unknown>,
  prefix = "",
): ReadonlyArray<readonly [string, unknown]> =>
  Object.entries(value).flatMap(([key, item]) => {
    const name = `${prefix}${key}`;
    return typeof item === "object" && item !== null && !Array.isArray(item)
      ? flatten(item as Record<string, unknown>, `${name}.`)
      : [[name, item] as const];
  });

const keyValues = (value: Record<string, unknown>): ReadonlyArray<string> => {
  const entries = flatten(value);
  if (entries.length === 0) return ["ok"];
  const width = Math.max(...entries.map(([key]) => key.length));
  // Trimmed as the table's lines are: a key whose value is empty reads as the
  // key, not as the key plus the padding that would have held a value.
  return entries.map(([key, item]) => `${key.padEnd(width)}  ${cell(item)}`.trimEnd());
};

const isPage = (
  value: unknown,
): value is { items: Array<Record<string, unknown>>; nextCursor?: string } =>
  typeof value === "object" &&
  value !== null &&
  Array.isArray((value as { items?: unknown }).items);

/**
 * The fields of a normalized event that do not go on a transcript line. Four
 * say nothing: the event's own id, the session every line belongs to, the
 * instant the line already begins with, and the turn and item ids, which name
 * nothing a reader can look up. `_tag` is left out because the line prints it
 * as its own column. `providerRefs` and `raw` are the vendor passthrough - the
 * escape hatch that keeps a trimmed taxonomy honest - and a line that carried
 * them would be a JSON dump; `--json` is where they are read.
 *
 * What is left is the tag's own payload, which is the part that differs from
 * line to line.
 */
const TRANSCRIPT_NOISE = new Set([
  "_tag",
  "eventId",
  "sessionId",
  "at",
  "providerRefs",
  "raw",
  "turnId",
  "itemId",
]);

/** How much of one field's value a transcript line shows before it is cut. */
const TRANSCRIPT_FIELD = 100;

/**
 * One value on a transcript line: on one line, and short. A coalesced
 * `content.delta` carries a whole assistant message or a screenful of command
 * output, and a transcript is read for its shape - `hercule transcript read
 * --json` is what hands back the text in full.
 */
const brief = (value: unknown): string => {
  const text = cell(value).replace(/\s+/g, " ").trim();
  return text.length > TRANSCRIPT_FIELD ? `${text.slice(0, TRANSCRIPT_FIELD)}...` : text;
};

/**
 * Describes what a turn answered under its session's output schema, as a
 * sentence on the turn's own line. The answer is what the session was spawned
 * for, so it reads as a sentence, and not as one more `field=value` beside the
 * turn's state. The sentence gives the value, or the reason there is no value.
 */
const describeResult = (structuredResult: unknown): string => {
  const answer = structuredResult as StructuredResult;
  switch (answer.outcome) {
    case "ok":
      return `result: ok ${brief(answer.value)}`;
    case "schema-failure":
      return `result: schema-failure: ${brief(answer.reason)}`;
  }
};

/** `<position>  <at>  <tag>  <what that tag adds>`. */
const transcriptLine = (row: Record<string, unknown>): string => {
  const event = (row["event"] ?? {}) as Record<string, unknown>;
  const fields = Object.entries(event)
    .filter(([key]) => !TRANSCRIPT_NOISE.has(key) && key !== "structuredResult")
    .map(([key, value]) => `${key}=${brief(value)}`);
  // The answer is placed right after the turn's state, and not where the event
  // happens to carry it. The reader reads the line for the answer, and behind
  // the usage figures the answer wraps off a 120-column terminal.
  const answered = event["structuredResult"];
  if (answered !== undefined) {
    fields.splice(
      fields.findIndex((field) => field.startsWith("state=")) + 1,
      0,
      describeResult(answered),
    );
  }
  return [cell(row["position"]), cell(row["at"]), cell(event["_tag"]), ...fields]
    .join("  ")
    .trimEnd();
};

/**
 * A transcript is a sequence, not a set of records: every row is the same three
 * columns plus a payload whose fields differ per tag, so a table of it would be
 * mostly empty cells. It is rendered as lines instead.
 */
const transcript = (rows: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<string> =>
  rows.length === 0 ? ["no results"] : rows.map(transcriptLine);

/**
 * One issue as a line: its path, with the keys joined by dots, and then its
 * message. An issue with an empty path is its message alone.
 */
export const describeIssue = (issue: Issue): string =>
  issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`;

/**
 * What a workflow save answers, without the source the caller has just sent:
 * the id to read it back by, whether it is on, and one line per warning, each
 * naming its place in the definition.
 */
const renderWorkflowSaved = (answer: WorkflowSaved): ReadonlyArray<string> => [
  ...keyValues({ id: answer.workflow.id, enabled: answer.workflow.enabled }),
  ...answer.warnings.map((warning) => `warning: ${describeIssue(warning)}`),
];

/**
 * What a check of a workflow answers: one line per error and one per warning,
 * each naming its place in the definition, or one line that says there is no
 * problem.
 */
const renderWorkflowIssues = (answer: WorkflowIssues): ReadonlyArray<string> =>
  answer.errors.length === 0 && answer.warnings.length === 0
    ? ["valid: no errors and no warnings"]
    : [
        ...answer.errors.map((error) => `error: ${describeIssue(error)}`),
        ...answer.warnings.map((warning) => `warning: ${describeIssue(warning)}`),
      ];

/**
 * One workflow action as a row: its params by name, each optional one marked
 * with `?`, in place of the JSON Schema they are declared in, which does not
 * fit on a line. `--json` prints the schema.
 */
const summarizeWorkflowAction = (action: WorkflowAction): Record<string, unknown> => {
  const properties = Object.keys(action.inputSchema["properties"] ?? {});
  const required = new Set((action.inputSchema["required"] ?? []) as ReadonlyArray<string>);
  return {
    id: action.id,
    params: properties.map((name) => (required.has(name) ? name : `${name}?`)).join(" "),
    description: action.description,
  };
};

/** The lines the CLI prints for a successful command, without `--json`. */
export const renderHuman = (outcome: Outcome, command: Command): ReadonlyArray<string> => {
  const asLines = command.id === "transcript.read" ? transcript : table;

  if (outcome.kind === "items") return asLines(outcome.items);

  const value = outcome.value;
  // The two catalogs a workflow is written from answer with the whole array,
  // a short list that ends, so each one is printed as a table, as a page is.
  if (command.id === "workflowAction.query") {
    return table((value as ReadonlyArray<WorkflowAction>).map(summarizeWorkflowAction));
  }
  if (command.id === "eventKind.query") {
    return table(value as ReadonlyArray<Record<string, unknown>>);
  }
  if (isPage(value)) {
    const lines = [...asLines(value.items)];
    if (value.nextCursor !== undefined) {
      lines.push("", `more results: --cursor ${value.nextCursor}, or --all`);
    }
    return lines;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    // A workflow's source is a document, and it is printed as it is, so what a
    // read prints can be edited and piped back into the command that stores
    // it. A save prints no source at all: the caller has just sent it.
    if (command.id === "workflow.read") {
      const { source } = value as Workflow;
      // The CLI ends each printed line with `\n`. A source whose first line
      // break is `\r\n` gets a `\r` before it, so the output ends with the
      // line break the source uses, and a CRLF file comes back byte for byte.
      return [/^[^\n]*\r\n/.test(source) ? `${source}\r` : source];
    }
    if (command.id === "workflow.create" || command.id === "workflow.update") {
      return renderWorkflowSaved(value as WorkflowSaved);
    }
    if (command.id === "workflow.validate") return renderWorkflowIssues(value as WorkflowIssues);
    const lines = [...keyValues(record)];
    // The one teaching line this build has. A caller who has just spawned a
    // session wants to watch it. It is not pointed at a subscription on that
    // session: no platform event about a session is emitted yet, so such a
    // claim is refused. It is pointed at the transcript it can already read.
    if (command.id === "session.spawn") {
      lines.push("", `read what it says with \`hercule transcript read ${cell(record["id"])}\``);
    }
    return lines;
  }
  return [cell(value)];
};
