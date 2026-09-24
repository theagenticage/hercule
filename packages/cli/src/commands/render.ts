/**
 * Formats command output for people.
 *
 * With `--json` the CLI prints the operation's output unchanged and does not
 * use this module. Everything here is for a person: a page becomes a table, a
 * single object becomes aligned key-value lines, and ids are shortened to the
 * tail the CLI accepts back as an argument.
 */
import { formatAge } from "@hercule/client-core";
import {
  truncateText,
  formatIssue,
  type Run,
  type RunOrigin,
  type RunStarted,
  type RunSummary,
  type StepRecord,
  type StructuredResult,
  type Workflow,
  type WorkflowAction,
  type WorkflowIssues,
  type WorkflowSaveResult,
} from "@hercule/contract";
import type { Outcome } from "./execute";
import type { Command } from "./tree";

/** A canonical lowercase UUIDv7; the only value shortened to a tail. */
const CANONICAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The length of the id tail printed for people, which is also the shortest tail
 * the CLI accepts.
 */
const TAIL = 8;

const formatCell = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return CANONICAL_ID.test(value) ? value.slice(-TAIL) : value;
  if (Array.isArray(value)) return value.map(formatCell).join(",");
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? "";
};

/** Returns every key of any row, in order of first appearance. */
const listColumns = (rows: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<string> => {
  const columns: Array<string> = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  }
  return columns;
};

/**
 * Returns the first line of a multi-line table cell, followed by " ..." to
 * show that more lines follow. A cell with a line break would break the table
 * row. The space before the dots keeps them apart from a full stop that ends
 * the first line.
 */
const keepOnOneLine = (text: string): string => {
  const lineBreak = text.search(/[\r\n]/);
  return lineBreak === -1 ? text : `${text.slice(0, lineBreak).trimEnd()} ...`;
};

const renderTable = (rows: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<string> => {
  if (rows.length === 0) return ["no results"];
  const columns = listColumns(rows);
  const body = rows.map((row) => columns.map((column) => keepOnOneLine(formatCell(row[column]))));
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
 * Flattens a nested object into dotted keys rather than printing JSON, so
 * `hercule settings read` shows the flat key set it really is. An array stays
 * one value: its elements are values, not sub-keys.
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

/**
 * Returns an object as aligned `key  value` lines. `formatValue` formats each
 * value; by default an id is shortened to its tail.
 */
const renderKeyValues = (
  value: Record<string, unknown>,
  formatValue: (item: unknown) => string = formatCell,
): ReadonlyArray<string> => {
  const entries = flatten(value);
  if (entries.length === 0) return ["ok"];
  const width = Math.max(...entries.map(([key]) => key.length));
  // Trim like the table's lines, so a key with an empty value has no trailing
  // padding.
  return entries.map(([key, item]) => `${key.padEnd(width)}  ${formatValue(item)}`.trimEnd());
};

/**
 * Formats a value like `formatCell`, but keeps an id whole. The run commands
 * print a run's id in full, as `workflow run` prints the id it starts, so the
 * id a reader copies from one run command is the same in every other.
 */
const formatKeepingIds = (item: unknown): string =>
  typeof item === "string" ? item : formatCell(item);

const isPage = (
  value: unknown,
): value is { items: Array<Record<string, unknown>>; nextCursor?: string } =>
  typeof value === "object" &&
  value !== null &&
  Array.isArray((value as { items?: unknown }).items);

/**
 * The fields of a normalized event that are left off a transcript line:
 *
 * - fields that tell the reader nothing: the event's id, the session every
 *   line belongs to, the time the line already starts with, and the turn and
 *   item ids, which a reader cannot look up;
 * - `_tag`, because the line prints it as its own column;
 * - `providerRefs` and `raw`, the vendor's original data. A line with them
 *   would be a JSON dump; `--json` shows them.
 *
 * What is left is the event's own payload, which is the part that differs
 * from line to line.
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

/** How many characters of one field's value a transcript line shows before truncating it. */
const TRANSCRIPT_FIELD = 100;

/**
 * Formats one value for a transcript line: on one line, and short. A merged
 * `content.delta` can hold a whole assistant message or a screenful of command
 * output, and a transcript is read for its outline. `hercule transcript read
 * --json` returns the full text.
 */
const abbreviateValue = (value: unknown): string =>
  truncateText(formatCell(value).replace(/\s+/g, " ").trim(), TRANSCRIPT_FIELD);

/**
 * Describes a turn's structured result (the value it returned under its
 * session's output schema), for the turn's own line. The result is what the
 * session was spawned for, so it is shown as a phrase rather than as one more
 * `field=value` next to the turn's state. The phrase gives the value, or the
 * reason there is no value.
 */
const describeResult = (structuredResult: unknown): string => {
  const answer = structuredResult as StructuredResult;
  switch (answer.outcome) {
    case "ok":
      return `result: ok ${abbreviateValue(answer.value)}`;
    case "schema-failure":
      return `result: schema-failure: ${abbreviateValue(answer.reason)}`;
  }
};

/** Formats one transcript row as `<position>  <at>  <tag>  <the event's own fields>`. */
const renderTranscriptLine = (row: Record<string, unknown>): string => {
  const event = (row["event"] ?? {}) as Record<string, unknown>;
  const fields = Object.entries(event)
    .filter(([key]) => !TRANSCRIPT_NOISE.has(key) && key !== "structuredResult")
    .map(([key, value]) => `${key}=${abbreviateValue(value)}`);
  // Put the result right after the turn's state, not where the event happens
  // to have it. The result is what the reader looks for, and after the usage
  // figures it would wrap off a 120-column terminal.
  const answered = event["structuredResult"];
  if (answered !== undefined) {
    fields.splice(
      fields.findIndex((field) => field.startsWith("state=")) + 1,
      0,
      describeResult(answered),
    );
  }
  return [formatCell(row["position"]), formatCell(row["at"]), formatCell(event["_tag"]), ...fields]
    .join("  ")
    .trimEnd();
};

/**
 * Formats a transcript as lines rather than a table. A transcript is a
 * sequence, not a set of records: every row has the same three columns plus
 * fields that differ per event type, so a table would be mostly empty cells.
 */
const renderTranscript = (rows: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<string> =>
  rows.length === 0 ? ["no results"] : rows.map(renderTranscriptLine);

/**
 * Returns the lines printed after a workflow is created or updated: its id,
 * whether it is enabled, and one line per warning with its path in the
 * definition. The source is not printed, because the caller has just sent it.
 */
const renderWorkflowSaveResult = (answer: WorkflowSaveResult): ReadonlyArray<string> => [
  ...renderKeyValues({ id: answer.workflow.id, enabled: answer.workflow.enabled }),
  ...answer.warnings.map((warning) => `warning: ${formatIssue(warning)}`),
];

/**
 * Returns the lines printed for `workflow validate`: one line per error and
 * per warning, each with its path in the definition, or one line that reports
 * the workflow as valid.
 */
const renderWorkflowIssues = (answer: WorkflowIssues): ReadonlyArray<string> =>
  answer.errors.length === 0 && answer.warnings.length === 0
    ? ["valid: no errors and no warnings"]
    : [
        ...answer.errors.map((error) => `error: ${formatIssue(error)}`),
        ...answer.warnings.map((warning) => `warning: ${formatIssue(warning)}`),
      ];

/**
 * Returns a workflow action as a table row. The params are listed by name,
 * with `?` after each optional one, because the full JSON Schema does not fit
 * on one line. `--json` prints the schema.
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

/**
 * Returns the lines printed after `workflow run` and `workflow submit`: the
 * new run's full id, and the command that shows how far it got. The hint
 * points at `run read` rather than a subscription, because the controller
 * does not accept a subscription on a run yet.
 */
const renderRunStarted = (answer: RunStarted): ReadonlyArray<string> => [
  `run ${answer.runId} started`,
  "",
  `see how far it got with \`hercule run read ${answer.runId}\``,
];

/** Describes who or what started a run, in a few words. */
const describeOrigin = (origin: RunOrigin): string => {
  switch (origin.kind) {
    case "manual":
    case "api":
      return origin.actor;
    case "action":
      return `step ${origin.stepId} of run ${origin.parentRunId}`;
  }
};

/**
 * Returns a run as a row of `run list`: its id, status, workflow, who started
 * it, and its age. The failure reason follows the status of a failed run,
 * because it is the first thing a reader of a failed run wants to know.
 */
const summarizeRun = (run: RunSummary, now: Date): Record<string, unknown> => ({
  id: run.id,
  status: run.failureReason === undefined ? run.status : `${run.status} (${run.failureReason})`,
  workflow: run.workflowName,
  startedBy: describeOrigin(run.origin),
  age: formatAge(run.createdAt, now),
});

/** Returns the rows of `run list` as a table. */
const renderRunList = (rows: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<string> => {
  const now = new Date();
  return renderTable(rows.map((row) => summarizeRun(row as unknown as RunSummary, now)));
};

/**
 * Returns the lines printed after `run cancel`: that the run is cancelled,
 * and the command that shows what its steps did. The whole run is left to
 * `run read`. The id is printed in full, as every run command prints it.
 */
const renderRunCancelled = (run: Run): ReadonlyArray<string> => [
  `run ${run.id} cancelled`,
  "",
  `see what its steps did with \`hercule run read ${run.id}\``,
];

/**
 * Returns how long a step took, such as `1.2s`, or nothing when it has not
 * both started and ended.
 */
const describeDuration = (record: StepRecord): string => {
  if (record.startedAt === undefined || record.finishedAt === undefined) return "";
  const millis = Date.parse(record.finishedAt) - Date.parse(record.startedAt);
  return millis < 1000 ? `${String(millis)}ms` : `${(millis / 1000).toFixed(1)}s`;
};

/**
 * Returns the lines printed for `run read`: a summary of the run, the inputs
 * it started with, and a table with one row per step record. The plan and the
 * steps' outputs are left out, because they are long; `--json` prints them.
 */
const renderRun = (run: Run): ReadonlyArray<string> => [
  ...renderKeyValues(
    {
      id: run.id,
      workflow: run.plan.name,
      status: run.status,
      ...(run.failureReason === undefined ? {} : { failureReason: run.failureReason }),
      ...(run.failedStepId === undefined ? {} : { failedStep: run.failedStepId }),
      startedBy: describeOrigin(run.origin),
      createdAt: run.createdAt,
      ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
      ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    },
    formatKeepingIds,
  ),
  "",
  "inputs",
  ...(Object.keys(run.inputs).length === 0 ? ["none"] : renderKeyValues(run.inputs)),
  "",
  ...renderTable(
    run.steps.map((record) => ({
      step: record.stepId,
      status: record.status,
      took: describeDuration(record),
      error: record.error === undefined ? "" : `${record.error.code}: ${record.error.message}`,
    })),
  ),
];

/** Returns the lines the CLI prints for a successful command without `--json`. */
export const renderHuman = (outcome: Outcome, command: Command): ReadonlyArray<string> => {
  const asLines =
    command.id === "transcript.read"
      ? renderTranscript
      : command.id === "run.query"
        ? renderRunList
        : renderTable;

  if (outcome.kind === "items") return asLines(outcome.items);

  const value = outcome.value;
  // These two queries return a short, complete array instead of a page, so
  // print the array as a table, like the items of a page.
  if (command.id === "workflowAction.query") {
    return renderTable((value as ReadonlyArray<WorkflowAction>).map(summarizeWorkflowAction));
  }
  if (command.id === "eventKind.query") {
    return renderTable(value as ReadonlyArray<Record<string, unknown>>);
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
    // Print a workflow's source unchanged, so the output can be edited and
    // piped back into `workflow update`. A create or an update prints no
    // source, because the caller has just sent it.
    if (command.id === "workflow.read") {
      const { source } = value as Workflow;
      // The CLI ends each printed line with `\n`. If the source's first line
      // break is `\r\n`, add a `\r` at the end, so the output ends in `\r\n`
      // and a CRLF file comes back byte for byte.
      return [/^[^\n]*\r\n/.test(source) ? `${source}\r` : source];
    }
    if (command.id === "workflow.create" || command.id === "workflow.update") {
      return renderWorkflowSaveResult(value as WorkflowSaveResult);
    }
    if (command.id === "workflow.validate") return renderWorkflowIssues(value as WorkflowIssues);
    if (command.id === "workflow.run" || command.id === "workflow.submit") {
      return renderRunStarted(value as RunStarted);
    }
    if (command.id === "run.read") return renderRun(value as Run);
    if (command.id === "run.cancel") return renderRunCancelled(value as Run);
    const lines = [...renderKeyValues(record)];
    // The only hint this build prints after a command. A caller who has just
    // spawned a session wants to watch it. The hint does not suggest a
    // subscription on the session: no platform event about a session is
    // emitted yet, so the controller would reject it. It points at the
    // transcript, which the caller can already read. `transcript read` returns
    // the rows so far and does not follow the session, so the hint says "read",
    // not "watch".
    if (command.id === "session.spawn") {
      lines.push(
        "",
        `read what it has done so far with \`hercule transcript read ${formatCell(record["id"])}\``,
      );
    }
    return lines;
  }
  return [formatCell(value)];
};
