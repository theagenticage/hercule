/**
 * Tracks the todo list of one Claude Code agent. Claude keeps its list through
 * four tools, and each one reports a different part of it:
 *
 * - `TodoWrite` sends the whole list every time.
 * - `TaskCreate` appends one task.
 * - `TaskUpdate` changes or deletes one task, by id.
 * - `TaskList` returns the whole list.
 *
 * This module turns those calls into the one thing a client shows: the full
 * list of steps, and whether it changed. It emits no events and knows nothing
 * about turns. It carries the `turnId` it is given from the call to the
 * result, so the caller can stamp the event it builds.
 *
 * A fresh session's list is known and empty. A resumed session's list is
 * unknown: the runner forgot it, and `TaskCreate` and `TaskUpdate` only
 * describe a part of it. Those two publish nothing until `TaskList` or
 * `TodoWrite` hands over the whole list again.
 *
 * Everything Claude sends is untrusted, so each input and output is decoded
 * with a schema before it is read.
 */
import { MAX_TODO_STEPS, type TodoStep, TodoStepStatus } from "@hercule/protocol";
import { Option, Schema } from "effect";
import { truncateFact } from "./text";

/** The tools that change the list. `TaskGet` is not one: it only reads one task. */
const TODO_TOOL_NAMES: ReadonlySet<string> = new Set([
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
]);

/** Checks whether `name` is a tool that changes the todo list. */
export const isTodoTool = (name: string): boolean => TODO_TOOL_NAMES.has(name);

/** One step of the list. `TodoWrite` steps have no id, so `id` may be missing. */
interface Entry {
  readonly id: string | undefined;
  readonly text: string;
  readonly status: Schema.Schema.Type<typeof TodoStepStatus>;
}

/** A todo tool call whose result has not arrived yet. */
interface PendingCall {
  readonly name: string;
  readonly input: unknown;
  readonly turnId: string;
}

/** The todo list of one agent. Create it with `buildTodoList`. */
export interface TodoList {
  /** The steps Claude's list holds, or `undefined` while the list is unknown. */
  entries: ReadonlyArray<Entry> | undefined;
  /** The steps last returned as `changed`: what a client shows now. */
  published: ReadonlyArray<TodoStep>;
  readonly pending: Map<string, PendingCall>;
}

/**
 * What a todo tool's result did to the list.
 *
 * - `not_todo`: no todo call with that id is pending. The caller treats the
 *   result as that of an ordinary tool.
 * - `unchanged`: the call succeeded and the list a client shows stays as it is.
 * - `changed`: the list is known and `steps` is the whole new list.
 * - `failed`: the call failed or its result was unusable. The caller draws a
 *   failed tool row from `name`, `input` and `reason`.
 */
export type TodoResultOutcome =
  | { readonly kind: "not_todo" }
  | { readonly kind: "unchanged"; readonly turnId: string }
  | {
      readonly kind: "changed";
      readonly turnId: string;
      readonly steps: ReadonlyArray<TodoStep>;
    }
  | {
      readonly kind: "failed";
      readonly turnId: string;
      readonly name: string;
      readonly input: unknown;
      readonly reason: string;
    };

/**
 * Builds the todo list of one agent. A fresh session's list is known and
 * empty. A resumed session's list is unknown, because the runner does not keep
 * it between runs.
 */
export const buildTodoList = (resumed: boolean): TodoList => ({
  entries: resumed ? undefined : [],
  published: [],
  pending: new Map(),
});

/**
 * Remembers a todo tool call until its result arrives. `input` is whatever
 * Claude sent, and is not checked here.
 */
export const recordTodoCall = (
  list: TodoList,
  toolUseId: string,
  name: string,
  input: unknown,
  turnId: string,
): void => {
  list.pending.set(toolUseId, { name, input, turnId });
};

const Text = Schema.NonEmptyString;

const TodoWriteInput = Schema.Struct({
  todos: Schema.Array(Schema.Struct({ content: Text, status: TodoStepStatus })),
});

const TodoWriteOutput = Schema.Struct({
  newTodos: Schema.Array(Schema.Struct({ content: Text, status: TodoStepStatus })),
});

const TaskCreateInput = Schema.Struct({ subject: Schema.optionalKey(Text) });

const TaskCreateOutput = Schema.Struct({
  task: Schema.Struct({ id: Schema.String, subject: Schema.optionalKey(Text) }),
});

const TaskUpdateInput = Schema.Struct({
  taskId: Schema.String,
  subject: Schema.optionalKey(Text),
  status: Schema.optionalKey(Schema.Union([TodoStepStatus, Schema.Literal("deleted")])),
});

const TaskUpdateOutput = Schema.Struct({
  success: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
});

const TaskListOutput = Schema.Struct({
  tasks: Schema.Array(Schema.Struct({ id: Schema.String, subject: Text, status: TodoStepStatus })),
});

const decodeTodoWriteInput = Schema.decodeUnknownOption(TodoWriteInput);
const decodeTodoWriteOutput = Schema.decodeUnknownOption(TodoWriteOutput);
const decodeTaskCreateInput = Schema.decodeUnknownOption(TaskCreateInput);
const decodeTaskCreateOutput = Schema.decodeUnknownOption(TaskCreateOutput);
const decodeTaskUpdateInput = Schema.decodeUnknownOption(TaskUpdateInput);
const decodeTaskUpdateOutput = Schema.decodeUnknownOption(TaskUpdateOutput);
const decodeTaskListOutput = Schema.decodeUnknownOption(TaskListOutput);

/**
 * What a successful call does to the list: `replacement` is the whole list
 * afterwards, `failure` says why the result is unusable, and `none` means the
 * call leaves the list as it is.
 */
type Change =
  | { readonly kind: "replacement"; readonly entries: ReadonlyArray<Entry> }
  | { readonly kind: "failure"; readonly reason: string }
  | { readonly kind: "none" };

const NONE: Change = { kind: "none" };

const buildUnreadableChange = (name: string): Change => ({
  kind: "failure",
  reason: `${name} returned a result that could not be read`,
});

/** Works out what a successful call does to the list. */
const computeChange = (list: TodoList, call: PendingCall, result: unknown): Change => {
  switch (call.name) {
    case "TodoWrite": {
      // The result carries the list as Claude's own tool stored it, so it wins
      // over the input. Both are whole lists.
      const todos = Option.match(decodeTodoWriteOutput(result), {
        onSome: (output) => Option.some(output.newTodos),
        onNone: () => Option.map(decodeTodoWriteInput(call.input), (input) => input.todos),
      });
      if (Option.isNone(todos)) return buildUnreadableChange(call.name);
      return {
        kind: "replacement",
        entries: todos.value.map((todo) => ({
          id: undefined,
          text: todo.content,
          status: todo.status,
        })),
      };
    }
    case "TaskList": {
      const output = decodeTaskListOutput(result);
      if (Option.isNone(output)) return buildUnreadableChange(call.name);
      return {
        kind: "replacement",
        entries: output.value.tasks.map((task) => ({
          id: task.id,
          text: task.subject,
          status: task.status,
        })),
      };
    }
    case "TaskCreate": {
      const output = decodeTaskCreateOutput(result);
      const input = decodeTaskCreateInput(call.input);
      const subject =
        Option.isSome(output) && output.value.task.subject !== undefined
          ? output.value.task.subject
          : Option.isSome(input)
            ? input.value.subject
            : undefined;
      if (Option.isNone(output) || subject === undefined) return buildUnreadableChange(call.name);
      if (list.entries === undefined) return NONE;
      return {
        kind: "replacement",
        entries: [...list.entries, { id: output.value.task.id, text: subject, status: "pending" }],
      };
    }
    case "TaskUpdate": {
      const output = decodeTaskUpdateOutput(result);
      if (Option.isNone(output)) return buildUnreadableChange(call.name);
      if (!output.value.success) {
        return {
          kind: "failure",
          reason: output.value.error ?? `${call.name} did not succeed`,
        };
      }
      const input = decodeTaskUpdateInput(call.input);
      if (Option.isNone(input)) return buildUnreadableChange(call.name);
      // The update may name a task from before a resume or a `TodoWrite`. The
      // list never invents a task for it.
      if (list.entries === undefined) return NONE;
      const { taskId, subject, status } = input.value;
      if (!list.entries.some((entry) => entry.id === taskId)) return NONE;
      return {
        kind: "replacement",
        entries:
          status === "deleted"
            ? list.entries.filter((entry) => entry.id !== taskId)
            : list.entries.map((entry) =>
                entry.id === taskId
                  ? { ...entry, text: subject ?? entry.text, status: status ?? entry.status }
                  : entry,
              ),
      };
    }
    default:
      return NONE;
  }
};

const areStepsEqual = (left: ReadonlyArray<TodoStep>, right: ReadonlyArray<TodoStep>): boolean =>
  left.length === right.length &&
  left.every(
    (step, index) => step.text === right[index]?.text && step.status === right[index].status,
  );

/**
 * Applies the result of a todo tool call to the list and returns what changed
 * for a client. The call must have been recorded with `recordTodoCall`. Every
 * outcome except `not_todo` removes the pending call.
 *
 * A call is only applied when it succeeded. `failed` is also returned when a
 * `TaskUpdate` reports `success` as anything but `true`, when a result cannot
 * be decoded, and when the list has more than `MAX_TODO_STEPS` steps: cutting
 * it would change the "2 of 5" count a client shows. In the last case the
 * agent's list still moves on, so a later change that brings it under the
 * bound shows again.
 */
export const applyTodoResult = (
  list: TodoList,
  toolUseId: string,
  failed: boolean,
  structuredResult: unknown,
): TodoResultOutcome => {
  const call = list.pending.get(toolUseId);
  if (call === undefined) return { kind: "not_todo" };
  list.pending.delete(toolUseId);
  const { turnId, name, input } = call;
  const buildFailure = (reason: string): TodoResultOutcome => ({
    kind: "failed",
    turnId,
    name,
    input,
    reason,
  });

  if (failed) return buildFailure(`${name} failed`);
  const change = computeChange(list, call, structuredResult);
  if (change.kind === "failure") return buildFailure(change.reason);
  if (change.kind === "none") return { kind: "unchanged", turnId };

  list.entries = change.entries;
  if (change.entries.length > MAX_TODO_STEPS) {
    return buildFailure(
      `the list has ${change.entries.length} steps, more than the ${MAX_TODO_STEPS} a row can show`,
    );
  }
  const steps = change.entries.map((entry) => ({
    text: truncateFact(entry.text),
    status: entry.status,
  }));
  if (areStepsEqual(steps, list.published)) return { kind: "unchanged", turnId };
  list.published = steps;
  return { kind: "changed", turnId, steps };
};
