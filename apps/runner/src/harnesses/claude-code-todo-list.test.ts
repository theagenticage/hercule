import { describe, expect, it } from "vitest";
import { MAX_FACT_LENGTH, MAX_MESSAGE_LENGTH, MAX_TODO_STEPS } from "@hercule/protocol";
import {
  applyTodoResult,
  buildTodoList,
  hasPendingTodoCall,
  recordTodoCall,
  type TodoList,
} from "./claude-code-todo-list";

let nextToolUseId = 0;

/** The `tool_result` of a call that succeeded. */
const ok = { isError: false, content: "ok" };

/** Records a call and applies its result in one go, like a call that answers at once. */
const run = (
  list: TodoList,
  name: string,
  input: unknown,
  result: unknown,
  options: { failed?: boolean; errorContent?: unknown; turnId?: string } = {},
): ReturnType<typeof applyTodoResult> => {
  const toolUseId = `tool-${nextToolUseId++}`;
  recordTodoCall(list, toolUseId, name, input, options.turnId ?? "turn-1");
  return applyTodoResult(
    list,
    toolUseId,
    {
      isError: options.failed ?? false,
      content: "errorContent" in options ? options.errorContent : "ok",
    },
    result,
  );
};

const todo = (content: string, status: "pending" | "in_progress" | "completed" = "pending") => ({
  content,
  status,
  activeForm: `${content}...`,
});

const step = (text: string, status: "pending" | "in_progress" | "completed" = "pending") => ({
  text,
  status,
});

const todoWrite = (list: TodoList, todos: ReadonlyArray<ReturnType<typeof todo>>) =>
  run(list, "TodoWrite", { todos }, { oldTodos: [], newTodos: todos });

const taskList = (
  list: TodoList,
  tasks: ReadonlyArray<{ id: string; subject: string; status: string }>,
) => run(list, "TaskList", {}, { tasks: tasks.map((task) => ({ ...task, blockedBy: [] })) });

const taskCreate = (list: TodoList, id: string, subject: string) =>
  run(list, "TaskCreate", { subject, description: "details" }, { task: { id, subject } });

const taskUpdate = (list: TodoList, input: Record<string, unknown>, result?: unknown) =>
  run(
    list,
    "TaskUpdate",
    input,
    result ?? { success: true, taskId: input.taskId, updatedFields: Object.keys(input) },
  );

describe("TodoWrite", () => {
  it("returns the new steps each time the list changes", () => {
    const list = buildTodoList(false);

    expect(todoWrite(list, [todo("a"), todo("b")])).toEqual({
      kind: "changed",
      turnId: "turn-1",
      steps: [step("a"), step("b")],
    });
    expect(todoWrite(list, [todo("a", "in_progress"), todo("b")])).toMatchObject({
      kind: "changed",
      steps: [step("a", "in_progress"), step("b")],
    });
    expect(todoWrite(list, [todo("a", "completed"), todo("b", "in_progress")])).toMatchObject({
      kind: "changed",
      steps: [step("a", "completed"), step("b", "in_progress")],
    });
  });

  it("returns an identical list again, because what a client shows is the caller's to compare", () => {
    const list = buildTodoList(false);
    todoWrite(list, [todo("a")]);

    expect(todoWrite(list, [todo("a")])).toEqual({
      kind: "changed",
      turnId: "turn-1",
      steps: [step("a")],
    });
  });

  it("clears the list with an empty one", () => {
    const list = buildTodoList(false);
    todoWrite(list, [todo("a")]);

    expect(todoWrite(list, [])).toEqual({ kind: "changed", turnId: "turn-1", steps: [] });
  });

  it("prefers the list in the result over the one in the input", () => {
    const list = buildTodoList(false);

    const outcome = run(
      list,
      "TodoWrite",
      { todos: [todo("from input")] },
      { oldTodos: [], newTodos: [todo("from result")] },
    );

    expect(outcome).toMatchObject({ kind: "changed", steps: [step("from result")] });
  });

  it("falls back to the input when the result is unusable", () => {
    const list = buildTodoList(false);

    const outcome = run(list, "TodoWrite", { todos: [todo("from input")] }, "not an object");

    expect(outcome).toMatchObject({ kind: "changed", steps: [step("from input")] });
  });

  it("fails when neither the result nor the input holds a list", () => {
    const list = buildTodoList(false);

    const outcome = run(list, "TodoWrite", { todos: "nope" }, undefined);

    expect(outcome).toMatchObject({
      kind: "failed",
      name: "TodoWrite",
      input: { todos: "nope" },
    });
  });

  it("fails on a step with no text or an unknown status", () => {
    const list = buildTodoList(false);

    expect(todoWrite(list, [todo("")]).kind).toBe("failed");
    expect(run(list, "TodoWrite", { todos: [{ content: "a", status: "stuck" }] }, null).kind).toBe(
      "failed",
    );
  });

  it("cuts step text to the length a step holds", () => {
    const list = buildTodoList(false);

    const outcome = todoWrite(list, [todo("x".repeat(MAX_FACT_LENGTH + 50))]);

    expect(outcome).toMatchObject({ kind: "changed" });
    const text = outcome.kind === "changed" ? outcome.steps[0]?.text : undefined;
    expect(text).toHaveLength(MAX_FACT_LENGTH);
    expect(text?.endsWith("…")).toBe(true);
  });

  it("fails on a list longer than a row can show, and the list moves on", () => {
    const list = buildTodoList(false);
    todoWrite(list, [todo("a")]);
    const tooMany = Array.from({ length: MAX_TODO_STEPS + 1 }, (_, index) => todo(`step ${index}`));

    const outcome = todoWrite(list, tooMany);

    expect(outcome).toMatchObject({
      kind: "failed",
      reason: `the list has ${MAX_TODO_STEPS + 1} steps, more than the ${MAX_TODO_STEPS} a row can show`,
    });
    // Back under the bound, the list is returned again.
    expect(todoWrite(list, [todo("a")])).toMatchObject({ kind: "changed", steps: [step("a")] });
  });
});

describe("a failed call", () => {
  it("returns failed with the name and input, and does not touch the list", () => {
    const list = buildTodoList(false);
    taskCreate(list, "1", "a");
    const input = { subject: "b" };

    const outcome = run(
      list,
      "TaskCreate",
      input,
      { task: { id: "2", subject: "b" } },
      { failed: true },
    );

    expect(outcome).toMatchObject({ kind: "failed", turnId: "turn-1", name: "TaskCreate", input });
    expect(taskCreate(list, "3", "c")).toMatchObject({ steps: [step("a"), step("c")] });
  });

  it("uses Claude's error text as the reason, from a string or from text blocks", () => {
    const list = buildTodoList(false);

    expect(
      run(list, "TodoWrite", {}, null, { failed: true, errorContent: "bad input" }),
    ).toMatchObject({ reason: "bad input" });
    expect(
      run(list, "TodoWrite", {}, null, {
        failed: true,
        errorContent: [
          { type: "text", text: "first" },
          { type: "image", source: {} },
          { type: "text", text: "second" },
        ],
      }),
    ).toMatchObject({ reason: "first\nsecond" });
  });

  it("names the tool as the reason when the error has no text", () => {
    const list = buildTodoList(false);

    for (const errorContent of ["", [], undefined, { type: "text", text: "not a list" }]) {
      expect(run(list, "TaskList", {}, null, { failed: true, errorContent })).toMatchObject({
        reason: "TaskList failed",
      });
    }
  });

  it("cuts a reason to the length of a message", () => {
    const list = buildTodoList(false);
    const long = "x".repeat(MAX_MESSAGE_LENGTH + 100);

    const fromError = run(list, "TodoWrite", {}, null, { failed: true, errorContent: long });
    const fromUpdate = run(list, "TaskUpdate", { taskId: "1" }, { success: false, error: long });

    for (const outcome of [fromError, fromUpdate]) {
      const reason = outcome.kind === "failed" ? outcome.reason : "";
      expect(reason).toHaveLength(MAX_MESSAGE_LENGTH);
      expect(reason.endsWith("…")).toBe(true);
    }
  });
});

describe("TaskCreate", () => {
  it("appends a pending step to a known list", () => {
    const list = buildTodoList(false);
    taskCreate(list, "1", "first");

    expect(taskCreate(list, "2", "second")).toEqual({
      kind: "changed",
      turnId: "turn-1",
      steps: [step("first"), step("second")],
    });
  });

  it("takes the subject from the input when the result has none", () => {
    const list = buildTodoList(false);

    const outcome = run(list, "TaskCreate", { subject: "from input" }, { task: { id: "1" } });

    expect(outcome).toMatchObject({ kind: "changed", steps: [step("from input")] });
  });

  it("fails without a task id in the result", () => {
    const list = buildTodoList(false);

    const outcome = run(list, "TaskCreate", { subject: "a" }, { task: {} });

    expect(outcome).toMatchObject({ kind: "failed", name: "TaskCreate" });
  });
});

describe("TaskUpdate", () => {
  const listWithTwoTasks = (): TodoList => {
    const list = buildTodoList(false);
    taskCreate(list, "1", "first");
    taskCreate(list, "2", "second");
    return list;
  };

  it("changes the subject and status of a task", () => {
    const list = listWithTwoTasks();

    expect(taskUpdate(list, { taskId: "2", subject: "renamed", status: "in_progress" })).toEqual({
      kind: "changed",
      turnId: "turn-1",
      steps: [step("first"), step("renamed", "in_progress")],
    });
  });

  it("removes a deleted task", () => {
    const list = listWithTwoTasks();

    expect(taskUpdate(list, { taskId: "1", status: "deleted" })).toMatchObject({
      kind: "changed",
      steps: [step("second")],
    });
  });

  it("reports an update of owner, metadata or dependencies as unchanged", () => {
    const list = listWithTwoTasks();

    expect(taskUpdate(list, { taskId: "1", owner: "me", addBlocks: ["2"] })).toEqual({
      kind: "unchanged",
    });
  });

  it("reports an update that repeats the current subject and status as unchanged", () => {
    const list = listWithTwoTasks();

    expect(taskUpdate(list, { taskId: "1", subject: "first", status: "pending" })).toEqual({
      kind: "unchanged",
    });
  });

  it("skips a task it never saw, and does not invent one", () => {
    const list = listWithTwoTasks();

    expect(taskUpdate(list, { taskId: "9", status: "completed", subject: "ghost" })).toEqual({
      kind: "unchanged",
    });
    expect(taskCreate(list, "3", "third")).toMatchObject({
      steps: [step("first"), step("second"), step("third")],
    });
  });

  it("forgets task ids when TodoWrite replaces the list", () => {
    const list = listWithTwoTasks();
    todoWrite(list, [todo("first"), todo("second")]);

    expect(taskUpdate(list, { taskId: "1", status: "completed" }).kind).toBe("unchanged");
  });

  it("fails when success is false, with the error as the reason", () => {
    const list = listWithTwoTasks();
    const input = { taskId: "1", status: "completed" };

    const outcome = taskUpdate(list, input, {
      success: false,
      taskId: "1",
      updatedFields: [],
      error: "no such task",
    });

    expect(outcome).toEqual({
      kind: "failed",
      turnId: "turn-1",
      name: "TaskUpdate",
      input,
      reason: "no such task",
    });
  });

  it("fails when the result has no success field", () => {
    const list = listWithTwoTasks();

    const outcome = taskUpdate(list, { taskId: "1", status: "completed" }, { taskId: "1" });

    expect(outcome).toMatchObject({ kind: "failed", name: "TaskUpdate" });
  });
});

describe("a resumed session", () => {
  it("publishes nothing until TaskList hands over the whole list", () => {
    const list = buildTodoList(true);

    expect(taskCreate(list, "3", "new")).toEqual({ kind: "unchanged" });
    expect(
      taskList(list, [
        { id: "1", subject: "first", status: "completed" },
        { id: "2", subject: "second", status: "pending" },
        { id: "3", subject: "new", status: "pending" },
      ]),
    ).toMatchObject({
      kind: "changed",
      steps: [step("first", "completed"), step("second"), step("new")],
    });
    expect(taskUpdate(list, { taskId: "2", status: "in_progress" })).toMatchObject({
      kind: "changed",
      steps: [step("first", "completed"), step("second", "in_progress"), step("new")],
    });
  });

  it("publishes nothing for a TaskUpdate before the list is known", () => {
    const list = buildTodoList(true);

    expect(taskUpdate(list, { taskId: "1", status: "completed" }).kind).toBe("unchanged");
  });

  it("learns the list from TodoWrite as well", () => {
    const list = buildTodoList(true);

    expect(todoWrite(list, [todo("a")])).toMatchObject({ kind: "changed", steps: [step("a")] });
  });

  it("still fails a call whose result is unusable", () => {
    const list = buildTodoList(true);

    expect(taskUpdate(list, { taskId: "1" }, { success: false }).kind).toBe("failed");
  });
});

describe("TaskList", () => {
  it("replaces the list in the order given", () => {
    const list = buildTodoList(false);
    taskCreate(list, "1", "old");

    expect(
      taskList(list, [
        { id: "b", subject: "second id first", status: "in_progress" },
        { id: "a", subject: "first id second", status: "pending" },
      ]),
    ).toMatchObject({
      kind: "changed",
      steps: [step("second id first", "in_progress"), step("first id second")],
    });
  });

  it("fails when the tasks cannot be read", () => {
    const list = buildTodoList(false);

    expect(run(list, "TaskList", {}, { tasks: [{ id: "1" }] }).kind).toBe("failed");
  });
});

describe("pending calls", () => {
  it("returns not_todo for an id that was never recorded", () => {
    expect(applyTodoResult(buildTodoList(false), "unknown", ok, {})).toEqual({
      kind: "not_todo",
    });
  });

  it("returns the turn of the call on its outcome", () => {
    const list = buildTodoList(false);
    recordTodoCall(list, "a", "TodoWrite", { todos: [todo("a")] }, "turn-a");
    recordTodoCall(list, "b", "TodoWrite", { todos: [todo("a")] }, "turn-b");

    expect(applyTodoResult(list, "b", ok, null)).toMatchObject({
      kind: "changed",
      turnId: "turn-b",
    });
    expect(applyTodoResult(list, "a", ok, null)).toMatchObject({
      kind: "changed",
      turnId: "turn-a",
    });
  });

  it("tells whether a call from a turn is waiting for its result", () => {
    const list = buildTodoList(false);
    recordTodoCall(list, "a", "TodoWrite", { todos: [] }, "turn-a");

    expect(hasPendingTodoCall(list, "turn-a")).toBe(true);
    expect(hasPendingTodoCall(list, "turn-b")).toBe(false);
    applyTodoResult(list, "a", ok, null);
    expect(hasPendingTodoCall(list, "turn-a")).toBe(false);
  });

  it("answers a result once: a second result for the same id is not_todo", () => {
    const list = buildTodoList(false);
    recordTodoCall(list, "a", "TodoWrite", { todos: [] }, "turn-1");
    applyTodoResult(list, "a", ok, null);

    expect(applyTodoResult(list, "a", ok, null)).toEqual({ kind: "not_todo" });
  });

  it("removes a failed call too", () => {
    const list = buildTodoList(false);
    recordTodoCall(list, "a", "TodoWrite", { todos: [] }, "turn-1");

    expect(applyTodoResult(list, "a", { isError: true, content: "" }, null).kind).toBe("failed");
    expect(applyTodoResult(list, "a", ok, null)).toEqual({ kind: "not_todo" });
  });
});
