/**
 * Tests the output that is not the generic table: the hint after a spawn, the
 * transcript, the output of workflow read, create, update and validate, and
 * the two catalogs used to write a workflow. Also tests one rule of the
 * table: each row stays on one line.
 */
import { describe, expect, it } from "vitest";
import { renderHuman } from "./render";
import { findCommandByWords, type Command } from "./tree";

const lookUpCommand = (...words: ReadonlyArray<string>): Command => {
  const found = findCommandByWords(words);
  expect(found, words.join(" ")).toBeDefined();
  return found!;
};

const SESSION = "0199e0e7-1111-7000-8000-0000000000ff";

const buildTranscriptRow = (position: number, event: Record<string, unknown>) => ({
  position,
  at: "2026-09-07T10:00:00.000Z",
  event: { eventId: "e1", sessionId: SESSION, at: "2026-09-07T10:00:00.000Z", ...event },
});

describe("hercule session spawn", () => {
  it("prints the session and a hint with the command that reads its transcript", () => {
    const lines = renderHuman(
      { kind: "value", value: { id: SESSION, status: "starting" } },
      lookUpCommand("session", "spawn"),
    );

    expect(lines[0]).toBe(`id      ${SESSION.slice(-8)}`);
    expect(lines).toContain(
      `read what it has done so far with \`hercule transcript read ${SESSION.slice(-8)}\``,
    );
  });

  it("prints no hint after an ordinary read", () => {
    const lines = renderHuman(
      { kind: "value", value: { id: SESSION, status: "idle" } },
      lookUpCommand("session", "read"),
    );

    expect(lines.join("\n")).not.toContain("hercule transcript read");
  });
});

describe("hercule transcript read", () => {
  it("prints one line per row: position, time, tag, and the event's own fields", () => {
    const lines = renderHuman(
      {
        kind: "value",
        value: {
          items: [
            buildTranscriptRow(1, { _tag: "turn.started", turnId: "t1" }),
            buildTranscriptRow(2, {
              _tag: "content.delta",
              turnId: "t1",
              itemId: "i1",
              streamKind: "assistant_text",
              delta: "Hello\nthere",
            }),
            buildTranscriptRow(3, { _tag: "turn.completed", turnId: "t1", state: "completed" }),
          ],
        },
      },
      lookUpCommand("transcript", "read"),
    );

    expect(lines).toEqual([
      "1  2026-09-07T10:00:00.000Z  turn.started",
      "2  2026-09-07T10:00:00.000Z  content.delta  streamKind=assistant_text  delta=Hello there",
      "3  2026-09-07T10:00:00.000Z  turn.completed  state=completed",
    ]);
  });

  it("truncates a long delta rather than wrapping, and shows how to get the next page", () => {
    const lines = renderHuman(
      {
        kind: "value",
        value: {
          items: [
            buildTranscriptRow(1, {
              _tag: "content.delta",
              turnId: "t1",
              itemId: "i1",
              streamKind: "command_output",
              delta: "x".repeat(400),
            }),
          ],
          nextCursor: "next",
        },
      },
      lookUpCommand("transcript", "read"),
    );

    expect(lines[0]).toContain("...");
    expect(lines[0]!.length).toBeLessThan(200);
    expect(lines).toContain("more results: --cursor next, or --all");
  });

  it("prints no results when the transcript is empty", () => {
    const lines = renderHuman(
      { kind: "value", value: { items: [] } },
      lookUpCommand("transcript", "read"),
    );

    expect(lines).toEqual(["no results"]);
  });
});

describe("hercule workflow", () => {
  const WORKFLOW = "0199e0e7-2222-7000-8000-0000000000aa";
  const SOURCE = "# Files a task.\nname: File a task\nsteps: []\n";
  const record = {
    id: WORKFLOW,
    enabled: false,
    source: SOURCE,
    createdAt: "2026-09-22T10:00:00.000Z",
    updatedAt: "2026-09-22T10:00:00.000Z",
  };

  it("prints the source of a read unchanged, and nothing else", () => {
    expect(
      renderHuman({ kind: "value", value: record }, lookUpCommand("workflow", "read")),
    ).toEqual([SOURCE]);
  });

  it("adds a carriage return after a CRLF source, so its last line ends in CRLF when printed", () => {
    const crlfSource = SOURCE.replaceAll("\n", "\r\n").slice(0, -"\r\n".length);
    expect(
      renderHuman(
        { kind: "value", value: { ...record, source: crlfSource } },
        lookUpCommand("workflow", "read"),
      ),
    ).toEqual([`${crlfSource}\r`]);
  });

  it("keeps each row of a list on one line when a description or a filter has several lines", () => {
    const listed = renderHuman(
      {
        kind: "value",
        value: {
          items: [
            { id: WORKFLOW, name: "File a task", description: "Files one task.\nEvery morning." },
          ],
        },
      },
      lookUpCommand("workflow", "list"),
    );
    expect(listed).toEqual([
      "id        name         description",
      `${WORKFLOW.slice(-8)}  File a task  Files one task. ...`,
    ]);

    const triggers = renderHuman(
      {
        kind: "value",
        value: { items: [{ triggerId: "on_label", filter: "event.a == 1 &&\r\n  event.b == 2" }] },
      },
      lookUpCommand("trigger", "list"),
    );
    expect(triggers).toEqual(["triggerId  filter", "on_label   event.a == 1 && ..."]);
  });

  it("prints one line per error and per warning after validate, or one line when there are none", () => {
    const validate = lookUpCommand("workflow", "validate");
    expect(
      renderHuman(
        {
          kind: "value",
          value: {
            errors: [{ path: ["steps", "1", "action"], message: "task.creat is not an action." }],
            warnings: [{ path: ["steps"], message: "A run can end only when someone cancels it." }],
          },
        },
        validate,
      ),
    ).toEqual([
      "error: steps.1.action: task.creat is not an action.",
      "warning: steps: A run can end only when someone cancels it.",
    ]);
    expect(renderHuman({ kind: "value", value: { errors: [], warnings: [] } }, validate)).toEqual([
      "valid: no errors and no warnings",
    ]);
  });

  it("prints the id, whether it is enabled and one line per warning after a save, and never the source", () => {
    const saved = {
      workflow: record,
      warnings: [
        { path: [], message: "The run can end only when someone cancels it." },
        { path: ["steps", "0"], message: "Nothing starts this step." },
      ],
    };
    for (const verb of ["create", "update"]) {
      expect(renderHuman({ kind: "value", value: saved }, lookUpCommand("workflow", verb))).toEqual(
        [
          `id       ${WORKFLOW.slice(-8)}`,
          "enabled  false",
          "warning: The run can end only when someone cancels it.",
          "warning: steps.0: Nothing starts this step.",
        ],
      );
    }
  });
});

describe("a catalog query that returns a plain array", () => {
  it("prints the event kinds as a table, like a page", () => {
    expect(
      renderHuman(
        {
          kind: "value",
          value: [
            { kind: "cron.tick", description: "A schedule came due.", connectionRequired: false },
            { kind: "github.pr.labeled", description: "Labels changed.", connectionRequired: true },
          ],
        },
        lookUpCommand("event-kind", "list"),
      ),
    ).toEqual([
      "kind               description           connectionRequired",
      "cron.tick          A schedule came due.  false",
      "github.pr.labeled  Labels changed.       true",
    ]);
  });

  it("lists the params of each workflow action by name, marking optional ones, instead of their schema", () => {
    expect(
      renderHuman(
        {
          kind: "value",
          value: [
            {
              id: "task.create",
              displayName: "Create a task",
              description: "Creates one Task.",
              inputSchema: {
                type: "object",
                properties: { title: {}, description: {}, labels: {} },
                required: ["title", "description"],
              },
            },
          ],
        },
        lookUpCommand("workflow-action", "list"),
      ),
    ).toEqual([
      "id           params                     description",
      "task.create  title description labels?  Creates one Task.",
    ]);
  });
});

describe("hercule run", () => {
  const RUN = "0199e0e7-3333-7000-8000-0000000000bb";
  const CONNECTION = "0199e0e7-4444-7000-8000-0000000000cc";

  it("prints the new run's full id after run start, and the command that shows it", () => {
    expect(
      renderHuman({ kind: "value", value: { runId: RUN } }, lookUpCommand("run", "start")),
    ).toEqual([
      `run ${RUN} started`,
      "",
      `subscribe for updates: hercule subscription create run:${RUN}`,
    ]);
  });

  it("prints a run as a summary with its full id, its inputs and one row per step, without the plan or the outputs", () => {
    const failed = {
      id: RUN,
      workflowId: null,
      plan: { name: "File a task", steps: [] },
      inputs: { title: "Fix login", count: 3, account: CONNECTION, reviewers: [CONNECTION] },
      origin: { kind: "manual", actor: "user" },
      status: "failed",
      failureReason: "step-failed",
      failedStepId: "start_task",
      steps: [
        {
          stepId: "file_task",
          iteration: 1,
          status: "completed",
          startedAt: "2026-09-24T10:00:00.000Z",
          finishedAt: "2026-09-24T10:00:00.040Z",
          output: { id: "t_1" },
        },
        {
          stepId: "start_task",
          iteration: 1,
          status: "failed",
          startedAt: "2026-09-24T10:00:00.040Z",
          finishedAt: "2026-09-24T10:01:15.040Z",
          error: { code: "not_found", message: "no such task" },
        },
        {
          stepId: "notify",
          iteration: 1,
          status: "cancelled",
          finishedAt: "2026-09-24T10:01:15.040Z",
        },
      ],
      createdAt: "2026-09-24T10:00:00.000Z",
      startedAt: "2026-09-24T10:00:00.000Z",
      finishedAt: "2026-09-24T10:00:01.540Z",
    };
    expect(renderHuman({ kind: "value", value: failed }, lookUpCommand("run", "read"))).toEqual([
      `id             ${RUN}`,
      "workflow       File a task",
      "status         failed",
      "failureReason  step-failed",
      "failedStep     start_task",
      "startedBy      you",
      "createdAt      2026-09-24T10:00:00.000Z",
      "startedAt      2026-09-24T10:00:00.000Z",
      "finishedAt     2026-09-24T10:00:01.540Z",
      "",
      "inputs",
      "title      Fix login",
      "count      3",
      `account    ${CONNECTION}`,
      `reviewers  ${CONNECTION}`,
      "",
      "steps",
      "step        status     took    error",
      "file_task   completed  40ms",
      "start_task  failed     1m 15s  not_found: no such task",
      "notify      cancelled",
    ]);
  });

  it("prints none under inputs and under steps for a run that has neither", () => {
    const lines = renderHuman(
      {
        kind: "value",
        value: {
          id: RUN,
          workflowId: null,
          plan: { name: "Nothing", steps: [] },
          inputs: {},
          origin: { kind: "api", actor: `session:${RUN}` },
          status: "pending",
          steps: [],
          createdAt: "2026-09-24T10:00:00.000Z",
        },
      },
      lookUpCommand("run", "read"),
    );
    expect(lines.slice(lines.indexOf("inputs"))).toEqual(["inputs", "none", "", "steps", "none"]);
  });

  it("prints a run the controller could not carry out without the step and times it never had", () => {
    const lines = renderHuman(
      {
        kind: "value",
        value: {
          id: RUN,
          workflowId: null,
          plan: { name: "Nothing", steps: [] },
          inputs: {},
          origin: { kind: "manual", actor: "user" },
          status: "failed",
          failureReason: "controller-error",
          steps: [],
          createdAt: "2026-09-24T10:00:00.000Z",
          finishedAt: "2026-09-24T10:00:00.010Z",
        },
      },
      lookUpCommand("run", "read"),
    );
    expect(lines.slice(0, lines.indexOf(""))).toEqual([
      `id             ${RUN}`,
      "workflow       Nothing",
      "status         failed",
      "failureReason  controller-error",
      "startedBy      you",
      "createdAt      2026-09-24T10:00:00.000Z",
      "finishedAt     2026-09-24T10:00:00.010Z",
    ]);
  });

  it("prints what went wrong at the edge a run failed at", () => {
    const lines = renderHuman(
      {
        kind: "value",
        value: {
          id: RUN,
          workflowId: null,
          plan: { name: "A loop", steps: [] },
          inputs: {},
          origin: { kind: "manual", actor: "user" },
          status: "failed",
          failureReason: "iteration-limit",
          failedStepId: "count",
          failedEdge: { index: 2, message: "The edge ran out." },
          steps: [],
          edgeTraversals: [],
          createdAt: "2026-09-24T10:00:00.000Z",
          startedAt: "2026-09-24T10:00:00.000Z",
          finishedAt: "2026-09-24T10:00:00.010Z",
        },
      },
      lookUpCommand("run", "read"),
    );
    expect(lines.slice(2, 6)).toEqual([
      "status             failed",
      "failureReason      iteration-limit",
      "failedStep         count",
      "failedEdgeMessage  The edge ran out.",
    ]);
  });

  /** A plan whose `file` and `count` steps loop, with `escalate` after the loop. */
  const LOOP_PLAN = {
    name: "File a batch",
    steps: [],
    edges: [
      { from: "lookup", to: "file" },
      { from: "file", to: "count" },
      {
        from: "count",
        to: "file",
        condition: "size(steps.count.output.items) < 3",
        maxTraversals: 3,
      },
      { from: "count", to: "escalate", condition: "inputs.urgent" },
    ],
  };

  /** Returns a completed step record that took 20ms. */
  const completeStep = (stepId: string, iteration: number) => ({
    stepId,
    iteration,
    status: "completed",
    startedAt: "2026-09-24T10:00:00.000Z",
    finishedAt: "2026-09-24T10:00:00.020Z",
    output: { items: [] },
  });

  /** Returns the lines `hercule run read` prints for a failed run of `LOOP_PLAN`. */
  const renderLoopFailure = (failure: Record<string, unknown>): ReadonlyArray<string> =>
    renderHuman(
      {
        kind: "value",
        value: {
          id: RUN,
          workflowId: null,
          plan: LOOP_PLAN,
          inputs: {},
          origin: { kind: "manual", actor: "user" },
          status: "failed",
          failedStepId: "count",
          steps: [],
          edgeTraversals: [1, 1, 3, 0],
          createdAt: "2026-09-24T10:00:00.000Z",
          startedAt: "2026-09-24T10:00:00.000Z",
          finishedAt: "2026-09-24T10:00:00.010Z",
          ...failure,
        },
      },
      lookUpCommand("run", "read"),
    );

  it("names the edge a run failed at its iteration limit, as from -> to", () => {
    const lines = renderLoopFailure({
      failureReason: "iteration-limit",
      failedEdge: { index: 2, message: "The edge ran out." },
    });
    expect(lines.slice(2, 7)).toEqual([
      "status             failed",
      "failureReason      iteration-limit",
      "failedStep         count",
      "failedEdge         count -> file",
      "failedEdgeMessage  The edge ran out.",
    ]);
  });

  it("names the edge whose condition failed to evaluate, as from -> to", () => {
    const lines = renderLoopFailure({
      failureReason: "expression-error",
      failedEdge: { index: 3, message: "no such key: urgent" },
    });
    expect(lines.slice(2, 7)).toEqual([
      "status             failed",
      "failureReason      expression-error",
      "failedStep         count",
      "failedEdge         count -> escalate",
      "failedEdgeMessage  no such key: urgent",
    ]);
  });

  it("prints no failedEdge for a step that failed on its own", () => {
    const lines = renderLoopFailure({ failureReason: "step-failed" });
    expect(lines.some((line) => line.startsWith("failedEdge"))).toBe(false);
  });

  it("prints an iteration column when a step ran more than once, and a skipped step's row", () => {
    const lines = renderHuman(
      {
        kind: "value",
        value: {
          id: RUN,
          workflowId: null,
          plan: LOOP_PLAN,
          inputs: {},
          origin: { kind: "manual", actor: "user" },
          status: "completed",
          steps: [
            completeStep("lookup", 1),
            completeStep("file", 1),
            completeStep("count", 1),
            completeStep("file", 2),
            completeStep("count", 2),
            {
              stepId: "escalate",
              iteration: 1,
              status: "skipped",
              finishedAt: "2026-09-24T10:00:00.100Z",
            },
          ],
          edgeTraversals: [1, 2, 1, 1],
          createdAt: "2026-09-24T10:00:00.000Z",
          startedAt: "2026-09-24T10:00:00.000Z",
          finishedAt: "2026-09-24T10:00:00.100Z",
        },
      },
      lookUpCommand("run", "read"),
    );
    expect(lines.slice(lines.indexOf("steps"))).toEqual([
      "steps",
      "step      iteration  status     took  error",
      "lookup    1          completed  20ms",
      "file      1          completed  20ms",
      "count     1          completed  20ms",
      "file      2          completed  20ms",
      "count     2          completed  20ms",
      "escalate  1          skipped",
    ]);
  });

  it("prints a skipped step's row without an iteration column when every step ran once", () => {
    const lines = renderHuman(
      {
        kind: "value",
        value: {
          id: RUN,
          workflowId: null,
          plan: LOOP_PLAN,
          inputs: {},
          origin: { kind: "manual", actor: "user" },
          status: "completed",
          steps: [
            completeStep("lookup", 1),
            {
              stepId: "escalate",
              iteration: 1,
              status: "skipped",
              finishedAt: "2026-09-24T10:00:00.100Z",
            },
          ],
          edgeTraversals: [1, 0, 0, 0],
          createdAt: "2026-09-24T10:00:00.000Z",
          startedAt: "2026-09-24T10:00:00.000Z",
          finishedAt: "2026-09-24T10:00:00.100Z",
        },
      },
      lookUpCommand("run", "read"),
    );
    expect(lines.slice(lines.indexOf("steps"))).toEqual([
      "steps",
      "step      status     took  error",
      "lookup    completed  20ms",
      "escalate  skipped",
    ]);
  });

  it("prints the output of a run that a terminal step ended, under the inputs", () => {
    const readOutput = (output: unknown): ReadonlyArray<string> => {
      const lines = renderHuman(
        {
          kind: "value",
          value: {
            id: RUN,
            workflowId: null,
            plan: { name: "End early", steps: [] },
            inputs: {},
            origin: { kind: "manual", actor: "user" },
            status: "completed",
            output,
            steps: [],
            edgeTraversals: [],
            createdAt: "2026-09-24T10:00:00.000Z",
            startedAt: "2026-09-24T10:00:00.000Z",
            finishedAt: "2026-09-24T10:00:00.010Z",
          },
        },
        lookUpCommand("run", "read"),
      );
      return lines.slice(lines.indexOf("inputs"), lines.indexOf("steps"));
    };
    expect(readOutput({ id: RUN, title: "Fix login" })).toEqual([
      "inputs",
      "none",
      "",
      "output",
      `id     ${RUN}`,
      "title  Fix login",
      "",
    ]);
    expect(readOutput(null)).toEqual(["inputs", "none", "", "output", "null", ""]);
    expect(readOutput([1, 2])).toEqual([
      "inputs",
      "none",
      "",
      "output",
      "[",
      "  1,",
      "  2",
      "]",
      "",
    ]);
  });

  it("prints a list of objects in a run's output as indented JSON under the value column", () => {
    const lines = renderHuman(
      {
        kind: "value",
        value: {
          id: RUN,
          workflowId: null,
          plan: { name: "File", steps: [] },
          inputs: {},
          origin: { kind: "manual", actor: "user" },
          status: "completed",
          output: { labels: ["a", "b"], provenance: [{ runId: RUN }] },
          steps: [],
          edgeTraversals: [],
          createdAt: "2026-09-24T10:00:00.000Z",
          startedAt: "2026-09-24T10:00:00.000Z",
          finishedAt: "2026-09-24T10:00:00.010Z",
        },
      },
      lookUpCommand("run", "read"),
    );
    expect(lines.slice(lines.indexOf("output"), lines.indexOf("steps"))).toEqual([
      "output",
      "labels      a,b",
      "provenance  [",
      "              {",
      `                "runId": "${RUN}"`,
      "              }",
      "            ]",
      "",
    ]);
  });

  it("describes who started a run in the words the web app uses", () => {
    const readStartedBy = (
      origin: Record<string, unknown>,
      triggerEvent?: Record<string, unknown>,
    ): string | undefined =>
      renderHuman(
        {
          kind: "value",
          value: {
            id: RUN,
            workflowId: null,
            plan: { name: "Nothing", steps: [] },
            inputs: {},
            origin,
            ...(triggerEvent === undefined ? {} : { triggerEvent }),
            status: "pending",
            steps: [],
            createdAt: "2026-09-24T10:00:00.000Z",
          },
        },
        lookUpCommand("run", "read"),
      ).find((line) => line.startsWith("startedBy"));
    expect(readStartedBy({ kind: "api", actor: `session:${CONNECTION}` })).toBe(
      "startedBy  session 000000cc through the API",
    );
    expect(readStartedBy({ kind: "action", parentRunId: RUN, stepId: "spawn" })).toBe(
      "startedBy  run 000000bb at step spawn",
    );
    expect(
      readStartedBy(
        { kind: "trigger", triggerId: "on_issue", eventId: 42 },
        { kind: "github.issue.opened" },
      ),
    ).toBe("startedBy  trigger on_issue on github.issue.opened");
  });

  it("prints what did not validate for a run a trigger could not start, which has no start time", () => {
    const lines = renderHuman(
      {
        kind: "value",
        value: {
          id: RUN,
          workflowId: null,
          plan: { name: "File a task", steps: [] },
          inputs: {},
          origin: { kind: "trigger", triggerId: "on_issue", eventId: 42 },
          status: "failed",
          failureReason: "validation-error",
          failureMessage: "The input title is required.",
          steps: [],
          edgeTraversals: [],
          createdAt: "2026-09-24T10:00:00.000Z",
          finishedAt: "2026-09-24T10:00:00.000Z",
        },
      },
      lookUpCommand("run", "read"),
    );
    expect(lines.slice(0, 8)).toEqual([
      `id              ${RUN}`,
      "workflow        File a task",
      "status          failed",
      "failureReason   validation-error",
      "failureMessage  The input title is required.",
      "startedBy       trigger on_issue",
      "createdAt       2026-09-24T10:00:00.000Z",
      "finishedAt      2026-09-24T10:00:00.000Z",
    ]);
  });

  it("prints a trigger's health and missed scheduled times on one short line each", () => {
    const lines = renderHuman(
      {
        kind: "value",
        value: {
          items: [
            {
              triggerId: "weekday_morning",
              status: "active",
              health: { state: "ok" },
              nextFireAt: "2026-09-29T07:00:00.000Z",
              skippedTicks: {
                from: "2026-09-26T07:00:00.000Z",
                until: "2026-09-27T07:00:00.000Z",
              },
            },
            {
              triggerId: "on_issue",
              status: "paused",
              health: {
                state: "error",
                message: "no such key: labels",
                at: "2026-09-28T09:00:00.000Z",
              },
            },
          ],
        },
      },
      lookUpCommand("trigger", "list"),
    );
    expect(lines).toEqual([
      "triggerId        status  health                      nextFireAt                skippedTicks",
      "weekday_morning  active  ok                          2026-09-29T07:00:00.000Z  2026-09-26T07:00:00.000Z to 2026-09-27T07:00:00.000Z",
      "on_issue         paused  error: no such key: labels",
    ]);
  });
});
