/**
 * Formats command output for people.
 *
 * With `--json` the CLI prints the operation's output unchanged and does not
 * use this module. Everything here is for a person: a page becomes a table, a
 * single object becomes aligned key-value lines, and ids are shortened to the
 * tail the CLI accepts back as an argument.
 */
import {
  describeRunOrigin,
  describeStepDuration,
  findFailedEdge,
  formatAge,
  describeResolution,
  describeTriggerOn,
  formatDescribeLine,
  countUsedTokens,
  readJsonObject,
  readStringList,
  readTimestamps,
} from "@hercule/client-core";
import {
  truncateText,
  formatIssue,
  isSchedule,
  type Notification,
  type Resolution,
  type Run,
  type RunStarted,
  type RunSummary,
  type StructuredResult,
  type Subagent,
  type Trigger,
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

/**
 * The characters a terminal acts on rather than prints:
 *
 * - the C0 control characters and DEL, except tab and line feed, which
 *   multi-line text such as a notification's body needs. ESC starts the
 *   sequences that move the cursor, erase a line or hide text, and a carriage
 *   return lets later text overwrite the start of a line;
 * - the C1 control characters, U+0080 to U+009F. Some terminals read U+009B as
 *   ESC followed by `[`;
 * - the Unicode bidirectional controls, which can reorder the text that
 *   follows them on screen: the embeddings and overrides U+202A to U+202E, the
 *   isolates U+2066 to U+2069, and the marks U+200E, U+200F and U+061C.
 */
const TERMINAL_CONTROLS =
  // Matching control characters is the point of this pattern.
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Removes the characters a terminal would act on rather than print, keeping
 * tabs and line breaks. Much of what the CLI prints was written by someone
 * other than the user, such as an agent's notification or an answer's label.
 * Printed as it is, an escape sequence in that text could erase or hide a
 * line, such as the line describing what an answer does.
 */
export const removeTerminalControls = (text: string): string => text.replace(TERMINAL_CONTROLS, "");

/**
 * Formats a value as the text of a table cell or of a `key  value` line. An
 * id is shortened to its tail, and characters a terminal would act on are
 * removed before the text is measured, so the columns stay aligned.
 */
const formatCell = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") {
    return CANONICAL_ID.test(value) ? value.slice(-TAIL) : removeTerminalControls(value);
  }
  if (Array.isArray(value)) return value.map(formatCell).join(",");
  // JSON escapes the C0 control characters but not the C1 or bidirectional ones.
  if (typeof value === "object") return removeTerminalControls(JSON.stringify(value));
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return removeTerminalControls(JSON.stringify(value) ?? "");
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
 * show that more lines follow, with each tab turned into a space. A cell with
 * a line break would break the table row, and a tab would move the columns
 * after it. The space before the dots keeps them apart from a full stop that
 * ends the first line.
 */
const keepOnOneLine = (text: string): string => {
  const lineBreak = text.search(/[\r\n]/);
  const firstLine = lineBreak === -1 ? text : `${text.slice(0, lineBreak).trimEnd()} ...`;
  return firstLine.replaceAll("\t", " ");
};

const renderTable = (rows: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<string> =>
  renderTableColumns(rows, listColumns(rows));

/** Same as `renderTable`, but prints only `columns`, in their order. */
const renderTableColumns = (
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  if (rows.length === 0) return ["no results"];
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
  // A value of several lines keeps its later lines under its first one, in the
  // value column. Trim like the table's lines, so a key with an empty value has
  // no trailing padding.
  const indent = " ".repeat(width + 2);
  return entries.flatMap(([key, item]) =>
    formatValue(item)
      .split("\n")
      .map((line, index) => `${index === 0 ? key.padEnd(width) + "  " : indent}${line}`.trimEnd()),
  );
};

/**
 * Formats a value like `formatCell`, but keeps every id whole, in a list too.
 * The run commands print ids in full, as `run start` prints the id it
 * starts, so an id a reader copies from `run read`, such as a Connection an
 * input names, works in every other command.
 *
 * A list that holds an object or a list prints as indented JSON over several
 * lines, the way the CLI prints JSON elsewhere, because one line of nested
 * JSON is hard to read.
 */
const formatKeepingIds = (item: unknown): string => {
  if (typeof item === "string") return item;
  if (!Array.isArray(item)) return formatCell(item);
  return item.some((element) => typeof element === "object" && element !== null)
    ? JSON.stringify(item, null, 2)
    : item.map(formatKeepingIds).join(",");
};

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

/**
 * Checks whether a transcript line shows a field of its event. Besides the
 * noise above, the line leaves out `subagentId`, the subagent an event belongs
 * to: a transcript read holds the rows of one agent, so the field would repeat
 * on every line. On `subagent.started` it is kept, because there it names the
 * new subagent, which a reader can pass to `--subagent`.
 */
const showsTranscriptField = (tag: unknown, key: string): boolean =>
  !TRANSCRIPT_NOISE.has(key) &&
  key !== "structuredResult" &&
  (key !== "subagentId" || tag === "subagent.started");

/** Formats one transcript row as `<position>  <at>  <tag>  <the event's own fields>`. */
const renderTranscriptLine = (row: Record<string, unknown>): string => {
  const event = (row["event"] ?? {}) as Record<string, unknown>;
  const fields = Object.entries(event)
    .filter(([key]) => showsTranscriptField(event["_tag"], key))
    .map(([key, value]) => `${key}=${abbreviateValue(value)}`);
  // A `subagent` item names the subagents it started. Their ids are printed in
  // full, right after the kind, because the detail they sit in is truncated
  // and a reader passes them to `--subagent`.
  const subagentIds =
    event["kind"] === "subagent"
      ? (readStringList(readJsonObject(event["detail"])?.["subagentIds"]) ?? [])
      : [];
  if (subagentIds.length > 0) {
    fields.splice(
      fields.findIndex((field) => field.startsWith("kind=")) + 1,
      0,
      `subagentIds=${subagentIds.map(removeTerminalControls).join(",")}`,
    );
  }
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
  // The `connection` param is not in the input schema, because the action
  // never receives it, but a step must still write it.
  const params = properties.map((name) => (required.has(name) ? name : `${name}?`));
  return {
    id: action.id,
    params: (action.connection === undefined ? params : ["connection", ...params]).join(" "),
    description: action.description,
  };
};

/**
 * Returns a trigger as a row of `trigger list`: every field, in the order the
 * contract gives them, with the nested ones on one short line each:
 *
 * - `on`: what the trigger fires on, as the web app shows it, such as
 *   "github.pr.labeled · any connection" or "0 9 * * 1-5 in Europe/Amsterdam".
 * - `filter`: an event trigger's filter. `renderTriggerList` prints it in
 *   the last column, because a filter is often long.
 * - `health`: `ok`, or `error: ` and the evaluation error.
 * - `skippedTicks`: the first and the last scheduled time a cron trigger
 *   missed.
 *
 * `--json` prints every field as the controller sent it, such as when the
 * error happened.
 */
const summarizeTrigger = (trigger: Trigger): Record<string, unknown> => ({
  ...trigger,
  on: describeTriggerOn(trigger.on),
  ...(trigger.health === undefined
    ? {}
    : { health: trigger.health.state === "ok" ? "ok" : `error: ${trigger.health.message}` }),
  ...(trigger.skippedTicks === undefined
    ? {}
    : { skippedTicks: `${trigger.skippedTicks.from} to ${trigger.skippedTicks.until}` }),
  ...(isSchedule(trigger.on) || trigger.on.filter === undefined
    ? {}
    : { filter: trigger.on.filter }),
});

/**
 * Returns the lines of `trigger list`: a table with a row per trigger, as
 * `summarizeTrigger` builds it. The filter column comes last, whichever row
 * first has a filter, so a long filter never pushes other columns to the
 * right.
 */
const renderTriggerList = (triggers: ReadonlyArray<Trigger>): ReadonlyArray<string> => {
  const rows = triggers.map(summarizeTrigger);
  const columns = listColumns(rows);
  return renderTableColumns(rows, [
    ...columns.filter((column) => column !== "filter"),
    ...columns.filter((column) => column === "filter"),
  ]);
};

/**
 * Returns the lines printed after `run start` and `run rerun`: the new run's
 * full id, and the command that subscribes to it. A caller who started a run
 * usually wants to know when it ends, and the subscription wakes it when the
 * run completes, fails or is cancelled.
 */
const renderRunStarted = (answer: RunStarted): ReadonlyArray<string> => [
  `run ${answer.runId} started`,
  "",
  `subscribe for updates: hercule subscription create run:${answer.runId}`,
];

/**
 * Describes who or what started a run, and how when not by hand, in the words
 * the web app uses: "you", "session 7c82ebeb through the API", "run 1f3a9c2e
 * at step spawn", "trigger on_issue on github.issue.opened". A run summary
 * holds no copy of the event, so a trigger run's row in `run list` reads
 * "trigger on_issue".
 */
const describeOrigin = (run: Run | RunSummary): string => {
  const { label, howStarted } = describeRunOrigin(run);
  return howStarted === undefined ? label : `${label} ${howStarted}`;
};

/**
 * Returns a run as a row of `run list`: its id, status, workflow, who started
 * it, and its age. The failure reason follows the status of a failed run,
 * because it is the first thing a reader of a failed run wants to know.
 */
const summarizeRun = (run: RunSummary, now: Date): Record<string, unknown> => ({
  id: run.id,
  status: run.status === "failed" ? `${run.status} (${run.failureReason})` : run.status,
  workflow: run.workflowName,
  startedBy: describeOrigin(run),
  age: formatAge(run.createdAt, now),
});

/** Returns the rows of `run list` as a table. */
const renderRunList = (runs: ReadonlyArray<RunSummary>): ReadonlyArray<string> => {
  const now = new Date();
  return renderTable(runs.map((run) => summarizeRun(run, now)));
};

/**
 * Returns a subagent as a row of `session subagent list`: its id, the
 * subagent that started it, its status, what it is, how much it has done,
 * its age, and what it was asked, is doing, or returned. A figure the harness
 * never reported is an empty cell, never 0.
 */
const summarizeSubagent = (subagent: Subagent, now: Date): Record<string, unknown> => ({
  id: subagent.id,
  parent: subagent.parentSubagentId,
  status: subagent.status,
  agentType: subagent.agentType,
  model: subagent.model,
  toolCalls: subagent.toolCalls,
  tokens: subagent.usage === undefined ? undefined : countUsedTokens(subagent.usage),
  age: formatAge(subagent.startedAt, now),
  description: subagent.description,
  activity: subagent.activity,
  result: subagent.result,
});

/**
 * Returns the rows of `session subagent list` as a table. A column no
 * subagent has a value for is left out: a harness that reports no models or
 * no usage would otherwise print empty columns.
 */
const renderSubagentList = (subagents: ReadonlyArray<Subagent>): ReadonlyArray<string> => {
  const now = new Date();
  const rows = subagents.map((subagent) => summarizeSubagent(subagent, now));
  return renderTableColumns(
    rows,
    listColumns(rows).filter((column) => rows.some((row) => row[column] !== undefined)),
  );
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
 * Returns a run's failure reason, the step it failed at, the edge it failed
 * at as `count -> file`, and what went wrong at that edge, as the fields of
 * `run read`, or no fields for a run that did not fail. A run the controller
 * could not carry out may have failed before it reached any step, and only a
 * run that failed at an edge has a failed edge and its message. A run a
 * trigger could not start has no step, only the message saying what did not
 * validate.
 */
const describeFailure = (run: Run): Record<string, string> => {
  if (run.status !== "failed") return {};
  if (run.failureReason === "validation-error") {
    return { failureReason: run.failureReason, failureMessage: run.failureMessage };
  }
  const planEdge = findFailedEdge(run);
  return {
    failureReason: run.failureReason,
    ...(run.failedStepId === undefined ? {} : { failedStep: run.failedStepId }),
    ...(planEdge === undefined ? {} : { failedEdge: `${planEdge.from} -> ${planEdge.to}` }),
    ...("failedEdge" in run && run.failedEdge !== undefined
      ? { failedEdgeMessage: run.failedEdge.message }
      : {}),
  };
};

/**
 * Returns the lines of a run's output under an `output` heading, or no lines
 * for a run without one: only a run that a terminal step ended has an
 * output. An object with fields prints as `key  value` lines, like the
 * inputs; any other value prints as indented JSON.
 */
const renderRunOutput = (run: Run): ReadonlyArray<string> => {
  if (run.status !== "completed" || run.output === undefined) return [];
  const fields = readJsonObject(run.output);
  return [
    "",
    "output",
    ...(fields !== undefined && Object.keys(fields).length > 0
      ? renderKeyValues(fields, formatKeepingIds)
      : JSON.stringify(run.output, null, 2).split("\n")),
  ];
};

/**
 * Returns the table of a run's step records, one row per record. The
 * iteration column shows only when a step has more than one record, so a run
 * with no loops reads as before.
 */
const renderStepTable = (steps: Run["steps"], now: number): ReadonlyArray<string> => {
  const stepIds = new Set(steps.map((record) => record.stepId));
  const hasRepeats = stepIds.size < steps.length;
  return renderTable(
    steps.map((record) => ({
      step: record.stepId,
      ...(hasRepeats ? { iteration: record.iteration } : {}),
      status: record.status,
      took: describeStepDuration(readTimestamps(record), now),
      error: record.status === "failed" ? `${record.error.code}: ${record.error.message}` : "",
    })),
  );
};

/**
 * Returns the lines printed for `run read`: a summary of the run, the inputs
 * it started with, the run's output when it has one, and a table with one
 * row per step record. A run with no inputs or no step records prints "none"
 * under that heading. The plan and the steps' outputs are left out, because
 * they are long; `--json` prints them.
 */
const renderRun = (run: Run, now: number): ReadonlyArray<string> => [
  ...renderKeyValues(
    {
      id: run.id,
      workflow: run.plan.name,
      status: run.status,
      ...describeFailure(run),
      startedBy: describeOrigin(run),
      createdAt: run.createdAt,
      ...readTimestamps(run),
    },
    formatKeepingIds,
  ),
  "",
  "inputs",
  ...(Object.keys(run.inputs).length === 0
    ? ["none"]
    : renderKeyValues(run.inputs, formatKeepingIds)),
  ...renderRunOutput(run),
  "",
  "steps",
  ...(run.steps.length === 0 ? ["none"] : renderStepTable(run.steps, now)),
];

/**
 * Returns the answers of a decision as a table: each answer's id, which
 * `notification act --action` takes, its label, what taking it does, and the
 * producer's description. The "does" column shows only for an open decision,
 * because the controller describes only answers that can still be taken.
 */
const renderAnswerTable = (actions: Notification["actions"]): ReadonlyArray<string> =>
  renderTable(
    actions.map((action) => ({
      id: action.id,
      label: action.label,
      ...(action.describeLine === undefined
        ? {}
        : { does: formatDescribeLine(action.describeLine) }),
      ...(action.description === undefined ? {} : { description: action.description }),
    })),
  );

/**
 * Returns a notification as a row of `notification list`: its id, kind,
 * title, status, the labels of its answers, and its age. The body, the
 * producer and what each answer does are left to `notification read`,
 * because they do not fit on one line.
 */
const summarizeNotification = (notification: Notification, now: Date): Record<string, unknown> => ({
  id: notification.id,
  kind: notification.kind,
  title: notification.title,
  status: notification.status,
  answers: notification.actions.map((action) => action.label).join(" / "),
  age: formatAge(notification.createdAt, now),
});

/** Returns the rows of `notification list` as a table. */
const renderNotificationList = (
  notifications: ReadonlyArray<Notification>,
): ReadonlyArray<string> => {
  const now = new Date();
  return renderTable(notifications.map((notification) => summarizeNotification(notification, now)));
};

/**
 * Returns the lines printed for `notification read`: the notification's fields
 * as key-value lines, then its markdown body and its answers under their own
 * headings. The body and the answers are left out when there are none.
 */
const renderNotification = (notification: Notification): ReadonlyArray<string> => {
  const { body, actions, ...fields } = notification;
  return [
    ...renderKeyValues(fields),
    ...(body === undefined ? [] : ["", "body", ...body.split("\n")]),
    ...(actions.length === 0 ? [] : ["", "answers", ...renderAnswerTable(actions)]),
  ];
};

/**
 * Returns the line printed after `notification act`: how the decision was
 * resolved. `notification.act` returns only a resolved decision, because a
 * failed operation fails the call instead. When an answer resolved the
 * decision, the line names that answer by its label. When the decision was
 * resolved another way first, such as withdrawn because its question stopped
 * existing, the line describes that resolution, so it never names an answer
 * that did not run.
 */
const renderNotificationDecided = (
  notification: Notification & { readonly resolution: Resolution },
): ReadonlyArray<string> => {
  const { resolution } = notification;
  const taken =
    resolution.kind === "decided"
      ? notification.actions.find((action) => action.id === resolution.actionId)
      : undefined;
  const outcome = taken === undefined ? describeResolution(resolution) : `decided: ${taken.label}`;
  return [`notification ${formatCell(notification.id)} ${outcome}`];
};

/**
 * Returns the lines for a successful command without `--json`, before
 * `renderHuman` removes the characters a terminal would act on.
 */
const renderLines = (outcome: Outcome, command: Command): ReadonlyArray<string> => {
  // The derived client decoded each item with the operation's schema, so the
  // items of `run.query` are run summaries, those of `trigger.query` are
  // triggers, those of `notification.query` are notifications, and those of
  // `session.querySubagents` are subagents.
  const asLines =
    command.id === "transcript.read"
      ? renderTranscript
      : command.id === "run.query"
        ? (items: ReadonlyArray<Record<string, unknown>>) =>
            renderRunList(items as ReadonlyArray<RunSummary>)
        : command.id === "trigger.query"
          ? (items: ReadonlyArray<Record<string, unknown>>) =>
              renderTriggerList(items as ReadonlyArray<Trigger>)
          : command.id === "notification.query"
            ? (items: ReadonlyArray<Record<string, unknown>>) =>
                renderNotificationList(items as unknown as ReadonlyArray<Notification>)
            : command.id === "session.querySubagents"
              ? (items: ReadonlyArray<Record<string, unknown>>) =>
                  renderSubagentList(items as unknown as ReadonlyArray<Subagent>)
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
    if (command.id === "run.start" || command.id === "run.rerun") {
      return renderRunStarted(value as RunStarted);
    }
    if (command.id === "run.read") return renderRun(value as Run, Date.now());
    if (command.id === "run.cancel") return renderRunCancelled(value as Run);
    if (command.id === "notification.read") return renderNotification(value as Notification);
    if (command.id === "notification.act") {
      return renderNotificationDecided(value as Notification & { readonly resolution: Resolution });
    }
    const lines = [...renderKeyValues(record)];
    // The only hint this build prints after a command. A caller who has just
    // spawned a session wants to watch it. The hint does not suggest a
    // subscription on the session: no platform event about a session is
    // emitted yet, so the controller would reject it. It points at the
    // transcript, which the caller can already read. `transcript read` returns
    // the rows so far and does not follow the session, so the hint uses "read",
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

/**
 * Returns the lines the CLI prints for a successful command without `--json`.
 *
 * Every line has the characters a terminal would act on removed, except the
 * source that `workflow read` prints, which must come back byte for byte.
 * `formatCell` has already removed them from table cells, so the columns
 * line up; this pass covers the text printed any other way, such as a
 * notification's body.
 */
export const renderHuman = (outcome: Outcome, command: Command): ReadonlyArray<string> => {
  const lines = renderLines(outcome, command);
  return command.id === "workflow.read" ? lines : lines.map(removeTerminalControls);
};
