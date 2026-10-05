/**
 * Integration tests for workflow validation, run against a real controller over
 * HTTP. They cover the graph, expressions, actions and their params, agent
 * steps and output schemas, triggers, inputs, the warning about a run with no
 * end, and the two catalogs the editor offers choices from (workflow actions
 * and event kinds).
 *
 * A workflow is rejected when `workflow.create` fails with a Validation error
 * and `workflow.validate` reports errors. Each invalid fixture has one kind of
 * mistake and is valid in every other way, so its errors must be at exactly
 * the fixture's `paths`.
 *
 * Each invalid fixture is sent to both `workflow.create` and
 * `workflow.validate`. The two must report the same errors, because the editor
 * shows the result of `workflow.validate` while the author types, and the
 * author trusts that the save agrees. The create is sent first, so that if it
 * wrongly succeeds, the test fails on that before it checks
 * `workflow.validate`.
 *
 * The controller has these plugins:
 * - A local GitHub plugin, for its event kind and its Connection type.
 * - A mail plugin, for a Connection of the wrong type.
 * - A provider, for an Agent.
 * - A notes plugin that declares one workflow action.
 * - A forge plugin with a Connection type and one action that acts through
 *   it.
 */
import { describe, expect, it, vi } from "vitest";
import {
  STARTER_WORKFLOW_SOURCE,
  type Issue,
  type WorkflowIssues,
  type WorkflowSaveResult,
} from "@hercule/contract";
import { lintOutputSchema } from "@hercule/protocol";
import { get, post, readErrorBody } from "../http/testing";
import {
  buildForgePlugin,
  FORGE_CONNECTION_TYPE,
  FORGE_REVIEW_ACTION_ID,
  NOTE_APPEND_ACTION,
  NOTE_APPEND_ACTION_ID,
  notesPlugin,
} from "../plugins/testing";
import {
  spawnThreadUnder,
  readProfileNamed,
  WAIT_DEADLINE_MS,
  withAgentFleet,
} from "../sessions/testing";
import {
  ABSENT_ID,
  ACCEPTED_GITHUB_TOKEN,
  buildFileTaskSource,
  buildTaskStep,
  createAgent,
  createConnection,
  createWorkflow,
  createWorkflowOrFail,
  disablePlugin,
  DUPLICATE_STEP_ID_SOURCE,
  expectNothingStored,
  KEBAB_CASE_STEP_ID_SOURCE,
  localMailPlugin,
  readIssues,
  SYNTAX_ERROR_SOURCE,
  updateWorkflow,
  withSetUpController,
  WRONG_KIND_SOURCE,
  type SetUpController,
} from "./testing";

/**
 * The permission test waits up to WAIT_DEADLINE_MS three times: once for the
 * agent fleet to be ready, and once for each of the two sessions it starts.
 */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

/** The ids of the built-in actions. A step can use them with no plugin enabled. */
const BUILT_IN_ACTION_IDS = [
  "git.commit",
  "git.push",
  "notification.create",
  "run.start",
  "task.create",
  "task.query",
  "task.update",
  "wait",
];

/**
 * The event kinds the controller emits, which a trigger can listen for. A
 * trigger on one of them takes no Connection. The Scheduler's `cron.tick` is
 * not one of them: a trigger fires on a schedule by writing it under `on`.
 */
const PLATFORM_EVENT_KINDS = [
  "run.cancelled",
  "run.completed",
  "run.failed",
  "task.created",
  "task.updated",
];

/** Ids of records on the test controller that a fixture can refer to. */
interface FixtureContext {
  readonly agentId: string;
  readonly githubConnectionId: string;
  readonly mailConnectionId: string;
  readonly forgeConnectionId: string;
}

/** A controller after setup, with an Agent and one Connection of each type. */
interface ArrangedController extends SetUpController, FixtureContext {}

/**
 * Starts a controller with the mail, notes and forge plugins, an Agent and one
 * Connection of each type, and runs `body` against it.
 */
const withArrangedController = (
  body: (controller: ArrangedController) => Promise<void>,
): Promise<void> =>
  withSetUpController(
    async (controller) => {
      const { base, token } = controller;
      await body({
        ...controller,
        agentId: await createAgent(base, token),
        githubConnectionId: await createConnection(base, token, "github/github", {
          pat: ACCEPTED_GITHUB_TOKEN,
        }),
        mailConnectionId: await createConnection(base, token, "mail/mail", {
          password: "an-app-password",
        }),
        forgeConnectionId: await createConnection(base, token, FORGE_CONNECTION_TYPE, {
          token: "a-forge-token",
        }),
      });
    },
    [localMailPlugin, notesPlugin, buildForgePlugin().plugin],
  );

const validateWorkflow = (base: string, token: string, body: unknown): Promise<Response> =>
  post(base, "/api/v1/workflows/validate", body, token);

/** Checks that `workflow.validate` succeeded, and returns the errors and warnings it found. */
const readValidateResult = async (response: Response): Promise<WorkflowIssues> => {
  expect(response.status, await response.clone().text()).toBe(200);
  const result = (await response.json()) as WorkflowIssues;
  expect(Object.keys(result).sort()).toEqual(["errors", "warnings"]);
  return result;
};

/** Returns the paths sorted, so two lists of the same paths compare equal in any order. */
const sortIssuePaths = (
  paths: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<ReadonlyArray<string>> =>
  [...paths].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

/** A workflow source that must be rejected, and the path of each error it must produce. */
interface InvalidFixture {
  readonly description: string;
  readonly build: (context: FixtureContext) => string;
  readonly paths: ReadonlyArray<ReadonlyArray<string>>;
}

/**
 * Checks that `workflow.create` and `workflow.validate` both reject the
 * fixture's source, with errors at exactly the fixture's paths. Returns the
 * errors that `workflow.validate` reports.
 */
const expectErrorsAt = async (
  controller: ArrangedController,
  fixture: InvalidFixture,
): Promise<ReadonlyArray<Issue>> => {
  const { base, token } = controller;
  const source = fixture.build(controller);

  const response = await createWorkflow(base, token, { source });
  expect(response.status, `${fixture.description}: ${await response.clone().text()}`).toBe(400);
  const error = await readErrorBody(response);
  expect(error.code, fixture.description).toBe("validation");
  expect(sortIssuePaths(error.issues), fixture.description).toEqual(sortIssuePaths(fixture.paths));

  const result = await readValidateResult(await validateWorkflow(base, token, { source }));
  expect(sortIssuePaths(result.errors.map((issue) => issue.path)), fixture.description).toEqual(
    sortIssuePaths(fixture.paths),
  );
  return result.errors;
};

/** Checks that `workflow.create` saves the source and `workflow.validate` finds no errors in it. */
const expectAccepted = async (
  controller: ArrangedController,
  description: string,
  source: string,
): Promise<void> => {
  const { base, token } = controller;
  const response = await createWorkflow(base, token, { source });
  expect([200, 201], `${description}: ${await response.clone().text()}`).toContain(response.status);
  const result = await readValidateResult(await validateWorkflow(base, token, { source }));
  expect(result.errors, description).toEqual([]);
};

/** Returns the issue at `path`, and fails the test if there is none. */
const findIssueAt = (issues: ReadonlyArray<Issue>, path: ReadonlyArray<string>): Issue => {
  const found = issues.find((issue) => JSON.stringify(issue.path) === JSON.stringify(path));
  expect(found, `an issue at ${JSON.stringify(path)} in ${JSON.stringify(issues)}`).toBeDefined();
  return found!;
};

/** The smallest valid workflow: one step that creates a task. */
const FILE_TASK_SOURCE = buildFileTaskSource("File a task");

/* ------------------------------------------------------------------------ */
/* Errors found when the source is parsed, before any other validation.      */
/* ------------------------------------------------------------------------ */

const PARSE_ERROR_FIXTURES: ReadonlyArray<InvalidFixture> = [
  { description: "a YAML syntax error", build: () => SYNTAX_ERROR_SOURCE, paths: [[]] },
  {
    description: "a step kind that does not exist",
    build: () => WRONG_KIND_SOURCE,
    paths: [["steps", "0", "kind"]],
  },
  {
    description: "two steps with one id",
    build: () => DUPLICATE_STEP_ID_SOURCE,
    paths: [["steps", "1", "id"]],
  },
  {
    description: "a step id that is not snake_case",
    build: () => KEBAB_CASE_STEP_ID_SOURCE,
    paths: [["steps", "0", "id"]],
  },
];

/* ------------------------------------------------------------------------ */
/* The graph.                                                                */
/* ------------------------------------------------------------------------ */

const EDGE_TO_NO_NODE: InvalidFixture = {
  description: "an edge to a node that does not exist",
  build: () => `name: An edge to no step
steps:
${buildTaskStep("plan")}
${buildTaskStep("implement")}
edges:
  - from: plan
    to: implement
  - from: plan
    to: ship
`,
  paths: [["edges", "1", "to"]],
};

const EDGE_FROM_NO_NODE: InvalidFixture = {
  description: "an edge from a node that does not exist",
  build: () => `name: An edge from no step
steps:
${buildTaskStep("plan")}
${buildTaskStep("implement")}
edges:
  - from: plan
    to: implement
  - from: ghost
    to: implement
`,
  paths: [["edges", "1", "from"]],
};

const EDGE_INTO_SIGNAL: InvalidFixture = {
  description: "an edge into a signal trigger",
  build: () => `name: An edge into a signal
triggers:
  - id: task_changed
    kind: signal
    on:
      kind: task.updated
    correlation:
      event: event.payload.taskId
      run: steps.plan.output.id
steps:
${buildTaskStep("plan", "terminal: true")}
edges:
  - from: plan
    to: task_changed
`,
  paths: [["edges", "0", "to"]],
};

/**
 * The cycle is implement -> review -> fix -> implement. The edges are listed
 * out of order: a walk from implement takes edge 2 first, but the lowest edge
 * index in the cycle is 1. The error is expected at edge 1.
 */
const UNCAPPED_CYCLE: InvalidFixture = {
  description: "a cycle with no capped edge",
  build: () => `name: A loop with no end
steps:
${buildTaskStep("plan")}
${buildTaskStep("implement")}
${buildTaskStep("review")}
${buildTaskStep("fix")}
edges:
  - from: plan
    to: implement
  - from: fix
    to: implement
  - from: implement
    to: review
  - from: review
    to: fix
`,
  paths: [["edges", "1"]],
};

const JOIN_ALL_IN_CYCLE: InvalidFixture = {
  description: "a step with join all inside a cycle",
  build: () => `name: A barrier inside a loop
steps:
${buildTaskStep("plan")}
${buildTaskStep("implement", "join: all")}
${buildTaskStep("review")}
edges:
  - from: plan
    to: implement
  - from: implement
    to: review
  - from: review
    to: implement
    maxTraversals: 3
`,
  paths: [["steps", "1", "join"]],
};

const EDGE_FROM_START_TRIGGER: InvalidFixture = {
  description: "an edge from a start trigger",
  build: () => `name: An edge from a start trigger
triggers:
  - id: on_create
    kind: start
    on:
      kind: task.created
steps:
${buildTaskStep("plan")}
edges:
  - from: on_create
    to: plan
`,
  paths: [["edges", "0", "from"]],
};

/**
 * Builds a workflow where step `poll` follows `plan` and has an edge back to
 * itself, capped at `maxTraversals` when it is given.
 */
const buildSelfLoopSource = (maxTraversals: number | undefined): string => `name: Poll until done
steps:
${buildTaskStep("plan")}
${buildTaskStep("poll")}
edges:
  - from: plan
    to: poll
  - from: poll
    to: poll${maxTraversals === undefined ? "" : `\n    maxTraversals: ${String(maxTraversals)}`}
`;

const UNCAPPED_SELF_LOOP: InvalidFixture = {
  description: "a step with an edge to itself and no maxTraversals",
  build: () => buildSelfLoopSource(undefined),
  paths: [["edges", "1"]],
};

const GRAPH_ERROR_FIXTURES: ReadonlyArray<InvalidFixture> = [
  EDGE_TO_NO_NODE,
  EDGE_FROM_NO_NODE,
  EDGE_INTO_SIGNAL,
  UNCAPPED_CYCLE,
  JOIN_ALL_IN_CYCLE,
];

const CAPPED_CYCLE_SOURCE = `name: A loop with one capped edge
steps:
${buildTaskStep("plan")}
${buildTaskStep("implement", "join: any")}
${buildTaskStep("review", "join: any")}
edges:
  - from: plan
    to: implement
  - from: implement
    to: review
  - from: review
    to: implement
    condition: 'steps.review.output.id != ""'
    maxTraversals: 3
`;

describe("the graph rules", () => {
  it("rejects an edge from or to a missing node, an edge into a signal trigger, a cycle with no maxTraversals, and join: all in a cycle, each at its path", async () => {
    await withArrangedController(async (controller) => {
      for (const fixture of GRAPH_ERROR_FIXTURES) await expectErrorsAt(controller, fixture);
      await expectNothingStored(controller.base, controller.token);
    });
  });

  it("lists every step of a cycle with no maxTraversals in the error message", async () => {
    await withArrangedController(async (controller) => {
      const [issue] = await expectErrorsAt(controller, UNCAPPED_CYCLE);
      for (const stepId of ["implement", "review", "fix"]) {
        expect(issue!.message).toContain(stepId);
      }
    });
  });

  it("accepts a cycle with one capped edge and join: any on its steps", async () => {
    await withArrangedController(async (controller) => {
      await expectAccepted(controller, "a capped cycle", CAPPED_CYCLE_SOURCE);
    });
  });

  it("rejects an edge from a start trigger, with a message that a start trigger cannot have edges", async () => {
    await withArrangedController(async (controller) => {
      const [issue] = await expectErrorsAt(controller, EDGE_FROM_START_TRIGGER);
      expect(issue!.message).toContain("start trigger");
      expect(issue!.message).toContain("cannot have edges");
    });
  });

  it("rejects a step with an edge to itself and no maxTraversals, naming the step, and accepts it with maxTraversals", async () => {
    await withArrangedController(async (controller) => {
      const [issue] = await expectErrorsAt(controller, UNCAPPED_SELF_LOOP);
      expect(issue!.message).toContain('"poll" leads into itself');

      await expectAccepted(controller, "a capped loop of one step", buildSelfLoopSource(5));
    });
  });
});

/** Two edges from `count` to `file`, the second with a condition. */
const DUPLICATE_EDGE_SOURCE = `name: The same edge twice
steps:
${buildTaskStep("count")}
${buildTaskStep("file")}
edges:
  - from: count
    to: file
  - from: count
    to: file
    condition: "true"
`;

/** A step that is an entry step and also waits for every incoming edge. */
const ENTRY_JOIN_ALL_SOURCE = `name: An entry step that waits
steps:
${buildTaskStep("left")}
${buildTaskStep("merge", "entry: true", "join: all")}
edges:
  - from: left
    to: merge
`;

/**
 * Checks that the issues hold exactly one issue, whose path starts with
 * `prefix`, and whose message is a sentence for a person.
 */
const expectOneIssueUnder = (
  issues: ReadonlyArray<Issue>,
  prefix: ReadonlyArray<string>,
  description: string,
): void => {
  const shown = `${description}: ${JSON.stringify(issues)}`;
  expect(issues, shown).toHaveLength(1);
  expect(issues[0]!.path.slice(0, prefix.length), shown).toEqual(prefix);
  expect(issues[0]!.message, shown).toMatch(/^[A-Z][^{}]*\.$/s);
};

describe("the routing rules", () => {
  const ROUTING_FIXTURES = [
    {
      description: "two edges with the same from and to",
      source: DUPLICATE_EDGE_SOURCE,
      prefix: ["edges", "1"],
    },
    {
      description: "entry: true with join: all",
      source: ENTRY_JOIN_ALL_SOURCE,
      prefix: ["steps", "1"],
    },
  ] as const;

  it("rejects two edges with the same from and to, and entry: true with join: all, on create, validate and update, each with one issue at its path", async () => {
    await withArrangedController(async ({ base, token }) => {
      for (const { description, source, prefix } of ROUTING_FIXTURES) {
        expectOneIssueUnder(
          await readIssues(await createWorkflow(base, token, { source })),
          prefix,
          `create with ${description}`,
        );
        const validated = await readValidateResult(await validateWorkflow(base, token, { source }));
        expectOneIssueUnder(validated.errors, prefix, `validate with ${description}`);
      }
      await expectNothingStored(base, token);

      const created = await createWorkflow(base, token, { source: FILE_TASK_SOURCE });
      expect([200, 201], await created.clone().text()).toContain(created.status);
      const { workflow } = (await created.json()) as WorkflowSaveResult;
      for (const { description, source, prefix } of ROUTING_FIXTURES) {
        expectOneIssueUnder(
          await readIssues(await updateWorkflow(base, token, workflow.id, { source })),
          prefix,
          `update with ${description}`,
        );
      }
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Where a run begins.                                                       */
/* ------------------------------------------------------------------------ */

/**
 * Builds the review loop from the workflows spec:
 * - implement -> open_pr -> review -> implement, capped.
 * - The `checks_failed` signal sends the run back to implement.
 * - The `pr_merged` signal leads to the terminal step `task_done`.
 *
 * Every step in the loop has an incoming edge, so no step starts the run
 * unless `implementEntryLine` gives implement `entry: true`. `task_done` is
 * listed first so that implement is at index 1, not 0.
 */
const buildReviewLoopSource = (agentId: string, implementEntryLine: string): string =>
  `name: Implement until merged
triggers:
  - id: checks_failed
    kind: signal
    on:
      kind: task.updated
    correlation:
      event: event.payload.taskId
      run: steps.open_pr.output.id
  - id: pr_merged
    kind: signal
    on:
      kind: task.updated
    correlation:
      event: event.payload.taskId
      run: steps.open_pr.output.id
steps:
${buildTaskStep("task_done", "terminal: true")}
  - id: implement
    kind: agent
    agent: ${agentId}
    prompt: Implement the change.${implementEntryLine}
${buildTaskStep("open_pr")}
  - id: review
    kind: agent
    agent: ${agentId}
    prompt: Review the change.
edges:
  - from: implement
    to: open_pr
  - from: open_pr
    to: review
  - from: review
    to: implement
    maxTraversals: 3
  - from: checks_failed
    to: implement
    maxTraversals: 3
  - from: pr_merged
    to: task_done
`;

const REVIEW_LOOP_WITHOUT_ENTRY: InvalidFixture = {
  description: "a loop with no step that starts the run",
  build: ({ agentId }) => buildReviewLoopSource(agentId, ""),
  paths: [["steps", "1"]],
};

/**
 * `file_task` has no incoming edge, so it starts the run. `close_out` runs only
 * after the signal, so it needs no `entry: true`.
 */
const SIGNAL_ONLY_STEP_SOURCE = `name: Close out when the task changes
triggers:
  - id: task_changed
    kind: signal
    on:
      kind: task.updated
    correlation:
      event: event.payload.taskId
      run: steps.file_task.output.id
steps:
${buildTaskStep("file_task")}
${buildTaskStep("close_out", "terminal: true")}
edges:
  - from: task_changed
    to: close_out
`;

const LINEAR_SOURCE = `name: Three steps in a line
steps:
${buildTaskStep("plan")}
${buildTaskStep("implement")}
${buildTaskStep("ship")}
edges:
  - from: plan
    to: implement
  - from: implement
    to: ship
`;

/**
 * plan -> ship, and a capped loop retry -> wait -> retry with no edge into it
 * from outside. plan starts the run, so no path reaches the loop.
 */
const UNREACHED_LOOP: InvalidFixture = {
  description: "a loop that no path reaches",
  build: () => `name: A loop nothing reaches
steps:
${buildTaskStep("plan")}
${buildTaskStep("ship")}
${buildTaskStep("retry")}
${buildTaskStep("wait")}
edges:
  - from: plan
    to: ship
  - from: retry
    to: wait
  - from: wait
    to: retry
    maxTraversals: 3
`,
  paths: [
    ["steps", "2"],
    ["steps", "3"],
  ],
};

/**
 * Both steps have an edge from the signal trigger, and there is no edge
 * between steps. So no step starts the run. No step is a better place for the
 * error than another, so the error is at the first step.
 */
const EVERY_STEP_AFTER_A_SIGNAL: InvalidFixture = {
  description: "a workflow where every step waits for a signal",
  build: () => `name: Every step waits for a signal
triggers:
  - id: task_changed
    kind: signal
    on:
      kind: task.updated
    correlation:
      event: event.payload.taskId
      run: steps.file_task.output.id
steps:
${buildTaskStep("file_task")}
${buildTaskStep("close_out", "terminal: true")}
edges:
  - from: task_changed
    to: file_task
  - from: task_changed
    to: close_out
`,
  paths: [["steps", "0"]],
};

describe("where a run begins", () => {
  it("rejects the review loop with an error at implement that suggests entry: true, and no error at the step only a signal reaches", async () => {
    await withArrangedController(async (controller) => {
      const { base, token } = controller;
      const source = REVIEW_LOOP_WITHOUT_ENTRY.build(controller);

      const savedIssues = await readIssues(await createWorkflow(base, token, { source }));
      expect(findIssueAt(savedIssues, ["steps", "1"]).message).toContain("entry: true");
      // task_done is reached only from the pr_merged signal, and needs no entry.
      expect(savedIssues.map((issue) => issue.path)).not.toContainEqual(["steps", "0"]);

      const result = await readValidateResult(await validateWorkflow(base, token, { source }));
      expect(result.errors).toEqual(savedIssues);
      await expectNothingStored(base, token);
    });
  });

  it("accepts the review loop once implement has entry: true", async () => {
    await withArrangedController(async (controller) => {
      await expectAccepted(
        controller,
        "the loop with an entry step",
        buildReviewLoopSource(controller.agentId, "\n    entry: true"),
      );
    });
  });

  it("rejects each step of a loop that no path reaches, suggesting entry: true", async () => {
    await withArrangedController(async (controller) => {
      const issues = await expectErrorsAt(controller, UNREACHED_LOOP);
      for (const issue of issues) expect(issue.message).toContain("entry: true");
    });
  });

  it("rejects a workflow where every step waits for a signal, with an error at the first step that suggests entry: true", async () => {
    await withArrangedController(async (controller) => {
      const [issue] = await expectErrorsAt(controller, EVERY_STEP_AFTER_A_SIGNAL);
      expect(issue!.message).toContain("entry: true");
    });
  });

  it("accepts a step reached only from a signal trigger, and a linear workflow, with no entry: true anywhere", async () => {
    await withArrangedController(async (controller) => {
      await expectAccepted(controller, "a step after a signal", SIGNAL_ONLY_STEP_SOURCE);
      await expectAccepted(controller, "a linear workflow", LINEAR_SOURCE);
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Expressions, and the variables each field may read.                       */
/* ------------------------------------------------------------------------ */

/**
 * Builds a workflow with a valid expression in every field that takes one:
 * - a start trigger's filter and input mapping
 * - a signal trigger's filter, both sides of its correlation, and an output
 * - a step condition and an edge condition
 * - templates in a prompt and in a string param, including an escaped `{{`
 */
const buildEveryExpressionFieldSource = (agentId: string): string => `name: Every expression site
inputs:
  - name: pr_number
    schema:
      type: integer
    required: false
triggers:
  - id: on_create
    kind: start
    on:
      kind: task.created
      filter: 'event.payload.priority == "high"'
    inputs:
      pr_number: event.payload.number
  - id: task_changed
    kind: signal
    on:
      kind: task.updated
      filter: has(event.payload.changes)
    correlation:
      event: event.payload.taskId
      run: steps.file_task.output.id
    outputs:
      status: event.payload.changes.status
steps:
  - id: file_task
    kind: action
    action: task.create
    condition: has(inputs.pr_number)
    params:
      title: "Review pull request {{ inputs.pr_number }}"
      description: "Write {{ '{{' }} where a template starts."
  - id: review
    kind: agent
    agent: ${agentId}
    terminal: true
    prompt: |
      Review pull request {{ inputs.pr_number }}.
      The task is {{ steps.file_task.output.id }}.
      Write {{ '{{' }} where a template starts.
edges:
  - from: file_task
    to: review
    condition: 'steps.file_task.output.id != ""'
  - from: task_changed
    to: review
    maxTraversals: 3
`;

/**
 * The same fields, each reading a variable that the field may not read:
 * `steps` or `inputs` where only `event` is available, and `event` where only
 * `inputs` and `steps` are.
 */
const WRONG_VARIABLES: InvalidFixture = {
  description: "expressions that read a variable their field may not read",
  build: ({ agentId }) => `name: Expressions that read the wrong variables
inputs:
  - name: pr_number
    schema:
      type: integer
    required: false
triggers:
  - id: on_create
    kind: start
    on:
      kind: task.created
      filter: 'steps.file_task.output.id == "x"'
    inputs:
      pr_number: inputs.pr_number
  - id: task_changed
    kind: signal
    on:
      kind: task.updated
      filter: 'steps.file_task.output.id != ""'
    correlation:
      event: inputs.pr_number
      run: event.payload.taskId
    outputs:
      status: steps.file_task.output.id
steps:
  - id: file_task
    kind: action
    action: task.create
    condition: 'event.kind == "task.created"'
    params:
      title: "Review {{ event.payload.title }}"
      description: Filed by a workflow.
  - id: review
    kind: agent
    agent: ${agentId}
    terminal: true
    prompt: "Review {{ event.payload.title }}."
edges:
  - from: file_task
    to: review
    condition: 'event.kind == "task.updated"'
  - from: task_changed
    to: review
    maxTraversals: 3
`,
  paths: [
    ["triggers", "0", "on", "filter"],
    ["triggers", "0", "inputs", "pr_number"],
    ["triggers", "1", "on", "filter"],
    ["triggers", "1", "correlation", "event"],
    ["triggers", "1", "correlation", "run"],
    ["triggers", "1", "outputs", "status"],
    ["steps", "0", "condition"],
    ["steps", "0", "params", "title"],
    ["steps", "1", "prompt"],
    ["edges", "0", "condition"],
  ],
};

const SYNTAX_ERRORS: InvalidFixture = {
  description: "expressions that are not CEL",
  build: ({ agentId }) => `name: Expressions that are not CEL
triggers:
  - id: on_create
    kind: start
    on:
      kind: task.created
      filter: 'event.payload.number >'
steps:
  - id: review
    kind: agent
    agent: ${agentId}
    prompt: "Review {{ inputs.pr_number + }}."
`,
  paths: [
    ["triggers", "0", "on", "filter"],
    ["steps", "0", "prompt"],
  ],
};

const UNCLOSED_TEMPLATES: InvalidFixture = {
  description: "templates that are not closed",
  build: ({ agentId }) => `name: Templates that are not closed
steps:
  - id: file_task
    kind: action
    action: task.create
    params:
      title: "Review {{ inputs.pr_number"
      description: Filed by a workflow.
  - id: review
    kind: agent
    agent: ${agentId}
    prompt: "Review {{ steps.file_task.output.id"
edges:
  - from: file_task
    to: review
`,
  paths: [
    ["steps", "0", "params", "title"],
    ["steps", "1", "prompt"],
  ],
};

/**
 * A start filter, a signal filter, a step condition and an edge condition, each
 * with a type other than bool. A value that is not a bool is never true, so
 * the condition could never pass.
 */
const CONDITIONS_THAT_ARE_NOT_BOOL: InvalidFixture = {
  description: "filters and conditions whose type is not bool",
  build: () => `name: Conditions that never say yes
triggers:
  - id: on_create
    kind: start
    on:
      kind: task.created
      filter: size(event.payload.labels)
  - id: task_changed
    kind: signal
    on:
      kind: task.updated
      filter: "'changed'"
    correlation:
      event: event.payload.taskId
      run: steps.file_task.output.id
steps:
${buildTaskStep("file_task", "condition: \"'yes'\"")}
${buildTaskStep("close_out", "terminal: true")}
edges:
  - from: file_task
    to: close_out
    condition: 1 + 1
  - from: task_changed
    to: close_out
    maxTraversals: 3
`,
  paths: [
    ["triggers", "0", "on", "filter"],
    ["triggers", "1", "on", "filter"],
    ["steps", "0", "condition"],
    ["edges", "0", "condition"],
  ],
};

const EXPRESSION_ERROR_FIXTURES: ReadonlyArray<InvalidFixture> = [
  WRONG_VARIABLES,
  SYNTAX_ERRORS,
  UNCLOSED_TEMPLATES,
  CONDITIONS_THAT_ARE_NOT_BOOL,
];

describe("the expressions", () => {
  it("accepts a valid expression in every field that takes one, and an escaped {{ in a template", async () => {
    await withArrangedController(async (controller) => {
      await expectAccepted(
        controller,
        "every expression field",
        buildEveryExpressionFieldSource(controller.agentId),
      );
    });
  });

  it("rejects each expression that reads a variable its field may not read, such as steps in a start filter or event in an edge condition", async () => {
    await withArrangedController(async (controller) => {
      await expectErrorsAt(controller, WRONG_VARIABLES);
    });
  });

  it("rejects a filter or condition whose type is not bool, with a message that names the type and asks for true or false", async () => {
    await withArrangedController(async (controller) => {
      const issues = await expectErrorsAt(controller, CONDITIONS_THAT_ARE_NOT_BOOL);
      expect(findIssueAt(issues, ["steps", "0", "condition"]).message).toContain("string");
      expect(findIssueAt(issues, ["edges", "0", "condition"]).message).toContain("int");
      for (const issue of issues) expect(issue.message).toContain("true or false");
    });
  });

  it("rejects a CEL syntax error in a filter or a template, and a template that is not closed, each at its path", async () => {
    await withArrangedController(async (controller) => {
      await expectErrorsAt(controller, SYNTAX_ERRORS);
      await expectErrorsAt(controller, UNCLOSED_TEMPLATES);
      await expectNothingStored(controller.base, controller.token);
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Actions and their params.                                                 */
/* ------------------------------------------------------------------------ */

const UNKNOWN_ACTION: InvalidFixture = {
  description: "an action that does not exist",
  build: () => `name: An action nobody declared
steps:
${buildTaskStep("file_task")}
  - id: follow_up
    kind: action
    action: task.creat
    params:
      title: Follow up
      description: The second task.
edges:
  - from: file_task
    to: follow_up
`,
  paths: [["steps", "1", "action"]],
};

const MISSING_REQUIRED_PARAM: InvalidFixture = {
  description: "a param the action requires, left out",
  build: () => `name: A task with no description
steps:
  - id: file_task
    kind: action
    action: task.create
    params:
      title: Only a title
`,
  paths: [["steps", "0", "params"]],
};

const UNKNOWN_PARAM: InvalidFixture = {
  description: "a param the action does not take",
  build: () => `name: A task with a colour
steps:
${buildTaskStep("file_task", "  colour: red")}
`,
  paths: [["steps", "0", "params", "colour"]],
};

const WRONG_TYPE_PARAM: InvalidFixture = {
  description: "a literal param of the wrong type",
  build: () => `name: Labels as a number
steps:
${buildTaskStep("file_task", "  labels: 42")}
`,
  paths: [["steps", "0", "params", "labels"]],
};

/**
 * Templates nested inside a param's value: one reads `event`, which a step may
 * not read, and one is not closed. Each must get an error at its own path.
 */
const INVALID_NESTED_TEMPLATES: InvalidFixture = {
  description: "nested templates in a param that read the wrong variable or are not closed",
  build: () => `name: Templates deep in the params
steps:
${buildTaskStep(
  "file_task",
  '  labels: ["triage", "{{ inputs.label"]',
  "  provenance:",
  '    - eventId: "{{ event.id }}"',
)}
`,
  paths: [
    ["steps", "0", "params", "labels", "1"],
    ["steps", "0", "params", "provenance", "0", "eventId"],
  ],
};

/** A task.update step with a task id but no field to change. */
const UPDATE_WITHOUT_CHANGE: InvalidFixture = {
  description: "a task.update step with no field to change",
  build: () => `name: An update that changes nothing
steps:
  - id: touch_task
    kind: action
    action: task.update
    params:
      taskId: ${ABSENT_ID}
`,
  paths: [["steps", "0", "params"]],
};

/** A template under a key that a provenance entry does not have. */
const TEMPLATE_UNDER_UNKNOWN_KEY: InvalidFixture = {
  description: "a template under a key that the input schema does not have",
  build: () => `name: A template under no field
steps:
${buildTaskStep("file_task", "  provenance:", "    - eventId: 5", '      bogus: "{{ inputs.a }}"')}
`,
  paths: [["steps", "0", "params", "provenance", "0", "bogus"]],
};

/** A template in `at`, a provenance entry field that the core sets itself. */
const TEMPLATE_IN_CORE_SET_FIELD: InvalidFixture = {
  description: "a template in a field that the core sets",
  build: () => `name: A template the core would overwrite
steps:
${buildTaskStep("file_task", "  provenance:", "    - eventId: 5", '      at: "{{ inputs.at }}"')}
`,
  paths: [["steps", "0", "params", "provenance", "0", "at"]],
};

const ACTION_ERROR_FIXTURES: ReadonlyArray<InvalidFixture> = [
  UNKNOWN_ACTION,
  MISSING_REQUIRED_PARAM,
  UNKNOWN_PARAM,
  WRONG_TYPE_PARAM,
  INVALID_NESTED_TEMPLATES,
  UPDATE_WITHOUT_CHANGE,
  TEMPLATE_UNDER_UNKNOWN_KEY,
  TEMPLATE_IN_CORE_SET_FIELD,
];

/**
 * Templates nested inside a param's value: a list item, and `eventId`, a
 * number field of a provenance entry. A template's value is known only at run
 * time, so validation cannot check its type.
 */
const NESTED_TEMPLATES_SOURCE = `name: Templates deep in the params
steps:
${buildTaskStep(
  "file_task",
  '  labels: ["triage", "{{ inputs.label }}"]',
  "  provenance:",
  '    - eventId: "{{ inputs.eventId }}"',
)}
`;

/**
 * An array field and an enum field, each set to a template. A template's value
 * is known only at run time, so validation cannot check its type.
 */
const TEMPLATES_FOR_ANY_TYPE_SOURCE = `name: Templates for fields of every type
inputs:
  - name: labels
    schema:
      type: array
      items:
        type: string
    required: false
  - name: priority
    schema:
      type: string
    required: false
steps:
${buildTaskStep("file_task", '  labels: "{{ inputs.labels }}"', '  priority: "{{ inputs.priority }}"')}
`;

const PLUGIN_ACTION_SOURCE = `name: A note from a plugin
steps:
  - id: append_note
    kind: action
    action: ${NOTE_APPEND_ACTION_ID}
    params:
      text: The review is done.
`;

describe("the actions", () => {
  it("rejects an unknown action, and lists every available action in the message", async () => {
    await withArrangedController(async (controller) => {
      const [issue] = await expectErrorsAt(controller, UNKNOWN_ACTION);
      for (const actionId of [
        ...BUILT_IN_ACTION_IDS,
        NOTE_APPEND_ACTION_ID,
        FORGE_REVIEW_ACTION_ID,
      ]) {
        expect(issue!.message).toContain(actionId);
      }
    });
  });

  it("accepts task.create", async () => {
    await withArrangedController(async (controller) => {
      await expectAccepted(controller, "task.create", FILE_TASK_SOURCE);
    });
  });

  it("accepts a plugin's action by its qualified id while the plugin is enabled, and rejects it once the plugin is disabled", async () => {
    await withArrangedController(async (controller) => {
      await expectAccepted(controller, "the notes action", PLUGIN_ACTION_SOURCE);

      await disablePlugin(controller.base, controller.token, "notes");
      await expectErrorsAt(controller, {
        description: "the notes action with its plugin disabled",
        build: () => PLUGIN_ACTION_SOURCE,
        paths: [["steps", "0", "action"]],
      });
    });
  });

  it("rejects a missing required param, an unknown param and a literal of the wrong type, each at its path", async () => {
    await withArrangedController(async (controller) => {
      for (const fixture of [MISSING_REQUIRED_PARAM, UNKNOWN_PARAM, WRONG_TYPE_PARAM]) {
        await expectErrorsAt(controller, fixture);
      }
      await expectNothingStored(controller.base, controller.token);
    });
  });

  it("accepts a template string for a param of any type", async () => {
    await withArrangedController(async (controller) => {
      await expectAccepted(controller, "templates", TEMPLATES_FOR_ANY_TYPE_SOURCE);
    });
  });

  it("accepts a template nested inside a param's value, such as a number field of a provenance entry", async () => {
    await withArrangedController(async (controller) => {
      await expectAccepted(controller, "nested templates", NESTED_TEMPLATES_SOURCE);
    });
  });

  it("rejects a nested template that reads the wrong variable or is not closed, each at its own path", async () => {
    await withArrangedController(async (controller) => {
      const issues = await expectErrorsAt(controller, INVALID_NESTED_TEMPLATES);
      expect(
        findIssueAt(issues, ["steps", "0", "params", "provenance", "0", "eventId"]).message,
      ).toContain("event");
      expect(findIssueAt(issues, ["steps", "0", "params", "labels", "1"]).message).toContain(
        "no closing }}",
      );
    });
  });

  it("rejects a template under a key the input schema does not have, and in a field the core sets, each at its path", async () => {
    await withArrangedController(async (controller) => {
      const [unknownKey] = await expectErrorsAt(controller, TEMPLATE_UNDER_UNKNOWN_KEY);
      expect(unknownKey!.message).toContain("Remove the field");
      const [coreSetField] = await expectErrorsAt(controller, TEMPLATE_IN_CORE_SET_FIELD);
      expect(coreSetField!.message).toContain("The core sets this field");
    });
  });

  it("rejects a task.update step with no field to change, as the task.update operation would", async () => {
    await withArrangedController(async (controller) => {
      const [issue] = await expectErrorsAt(controller, UPDATE_WITHOUT_CHANGE);
      expect(issue!.message).toContain("at least one field to change");
    });
  });

  it("explains each invalid param in one short message, without repeating a long value or doubling a full stop", async () => {
    await withArrangedController(async ({ base, token }) => {
      const longRef = "x".repeat(5000);
      const source = `name: Values a task cannot take
steps:
${buildTaskStep(
  "file_task",
  "  provenance:",
  `    - ref: ${longRef}`,
  "    - {}",
  "    - eventId: 7",
  "      at: 2026-09-23T10:00:00.000Z",
)}
`;
      const issues = await readIssues(await createWorkflow(base, token, { source }));
      expect(issues.length).toBeGreaterThanOrEqual(3);
      for (const issue of issues) {
        expect(issue.message.length, issue.message).toBeLessThan(400);
        expect(issue.message, issue.message).not.toMatch(/[^.]\.\.(?!\.)/);
      }
      expect(
        findIssueAt(issues, ["steps", "0", "params", "provenance", "2", "at"]).message,
      ).toContain("The core sets this field");
    });
  });
});

/* ------------------------------------------------------------------------ */
/* The workspace actions.                                                    */
/* ------------------------------------------------------------------------ */

/** Two repos for the workspaces below. No save checks that they exist. */
const FIRST_REPO_ID = "0199f0b7-0000-7000-8000-00000000a001";
const SECOND_REPO_ID = "0199f0b7-0000-7000-8000-00000000a002";

/** Builds a workflow with one git.commit step, `params` lines under it, and `workspace` lines. */
const buildCommitSource = (workspace: ReadonlyArray<string>, params: ReadonlyArray<string> = []) =>
  [
    "name: Commit the work",
    ...workspace,
    "steps:",
    "  - id: commit",
    "    kind: action",
    "    action: git.commit",
    "    params:",
    "      message: Save the work",
    ...params.map((line) => `      ${line}`),
    "",
  ].join("\n");

const TWO_CHECKOUTS = [
  "workspace:",
  "  kind: ephemeral",
  "  checkouts:",
  `    - resourceId: ${FIRST_REPO_ID}`,
  `    - resourceId: ${SECOND_REPO_ID}`,
];

const WORKSPACE_ACTION_WITHOUT_WORKSPACE: InvalidFixture = {
  description: "a git.commit step in a workflow with no workspace",
  build: () => buildCommitSource([]),
  paths: [["steps", "0", "action"]],
};

const GIT_ACTION_WITHOUT_CHECKOUT: InvalidFixture = {
  description: "a git.commit step in a workspace with no checkout",
  build: () => buildCommitSource(["workspace:", "  kind: ephemeral", "  checkouts: []"]),
  paths: [["steps", "0", "action"]],
};

const GIT_ACTION_WITHOUT_RESOURCE: InvalidFixture = {
  description: "a git.commit step with no resourceId in a workspace of two checkouts",
  build: () => buildCommitSource(TWO_CHECKOUTS),
  paths: [["steps", "0", "params"]],
};

describe("the workspace actions", () => {
  it("rejects a workspace action in a workflow with no workspace, a git action in a workspace with no checkout, and a git action that does not say which of several checkouts it works in", async () => {
    await withArrangedController(async (controller) => {
      const [noWorkspace] = await expectErrorsAt(controller, WORKSPACE_ACTION_WITHOUT_WORKSPACE);
      expect(noWorkspace!.message).toContain("kind: ephemeral");
      const [noCheckout] = await expectErrorsAt(controller, GIT_ACTION_WITHOUT_CHECKOUT);
      expect(noCheckout!.message).toContain("workspace.checkouts");
      const [noResource] = await expectErrorsAt(controller, GIT_ACTION_WITHOUT_RESOURCE);
      expect(noResource!.message).toContain("resourceId");
      await expectNothingStored(controller.base, controller.token);
    });
  });

  it("accepts a git action in a workspace of one checkout, and one that names its checkout among several", async () => {
    await withArrangedController(async (controller) => {
      await expectAccepted(
        controller,
        "one checkout",
        buildCommitSource([
          "workspace:",
          "  kind: ephemeral",
          "  checkouts:",
          `    - resourceId: ${FIRST_REPO_ID}`,
        ]),
      );
      await expectAccepted(
        controller,
        "two checkouts, one named",
        buildCommitSource(TWO_CHECKOUTS, [`resourceId: ${SECOND_REPO_ID}`]),
      );
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Agents and output schemas.                                                */
/* ------------------------------------------------------------------------ */

const UNKNOWN_AGENT: InvalidFixture = {
  description: "an agent step whose Agent does not exist",
  build: () => `name: An Agent that does not exist
steps:
  - id: review
    kind: agent
    agent: ${ABSENT_ID}
    prompt: Review the pull request.
`,
  paths: [["steps", "0", "agent"]],
};

/**
 * An output schema with two lint errors: `verdict` uses `format`, a keyword
 * outside the strict subset, and `notes` is an object without
 * `additionalProperties: false`.
 */
const LINT_FAILING_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "notes"],
  properties: {
    verdict: { type: "string", format: "uri" },
    notes: { type: "object" },
  },
};

const CLEAN_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict"],
  properties: { verdict: { type: "string", enum: ["approve", "reject"] } },
};

/**
 * Builds a workflow with an agent step at index 1 that has `outputSchema`.
 * JSON is valid YAML, so the schema is written into the source as JSON.
 */
const buildOutputSchemaSource = (agentId: string, outputSchema: unknown): string =>
  `name: A review with a verdict
steps:
${buildTaskStep("file_task")}
  - id: review
    kind: agent
    agent: ${agentId}
    prompt: Review the pull request.
    outputSchema: ${JSON.stringify(outputSchema)}
edges:
  - from: file_task
    to: review
`;

/** The path prefix of every lint error on the agent step that `buildOutputSchemaSource` builds. */
const OUTPUT_SCHEMA_PATH = ["steps", "1", "outputSchema"];

describe("the agent steps", () => {
  it("rejects an agent step whose Agent does not exist", async () => {
    await withArrangedController(async (controller) => {
      await expectErrorsAt(controller, UNKNOWN_AGENT);
    });
  });

  it("rejects an agent step that names an assistant, on create, validate and update", async () => {
    await withArrangedController(async (controller) => {
      const { base, token } = controller;
      // Setup created the assistant `Hercule`, whose id is also an agent id.
      const listed = await get(base, "/api/v1/assistants", token);
      expect(listed.status, await listed.clone().text()).toBe(200);
      const [assistant] = ((await listed.json()) as { items: ReadonlyArray<{ id: string }> }).items;
      const naming: InvalidFixture = {
        description: "an agent step that names an assistant",
        build: () => `name: A step that runs an assistant
steps:
  - id: review
    kind: agent
    agent: ${assistant!.id}
    prompt: Review the pull request.
`,
        paths: [["steps", "0", "agent"]],
      };

      const [issue] = await expectErrorsAt(controller, naming);
      expect(issue!.message).toContain("assistant");

      const saved = await createWorkflow(base, token, { source: FILE_TASK_SOURCE });
      expect([200, 201], await saved.clone().text()).toContain(saved.status);
      const { workflow } = (await saved.json()) as WorkflowSaveResult;
      const updated = await readIssues(
        await updateWorkflow(base, token, workflow.id, { source: naming.build(controller) }),
      );
      expect(updated.map((found) => found.path)).toEqual(naming.paths);
    });
  });

  it("reports one error under outputSchema for each finding of the strict-subset lint", async () => {
    await withArrangedController(async ({ base, token, agentId }) => {
      const findings = lintOutputSchema(LINT_FAILING_OUTPUT_SCHEMA);
      // Two findings, so the count shows one error per finding, not one per schema.
      expect(findings).toHaveLength(2);
      const source = buildOutputSchemaSource(agentId, LINT_FAILING_OUTPUT_SCHEMA);

      const response = await createWorkflow(base, token, { source });
      expect(response.status, await response.clone().text()).toBe(400);
      const error = await readErrorBody(response);
      expect(error.code).toBe("validation");
      expect(error.issues).toHaveLength(findings.length);
      for (const path of error.issues) {
        expect(path.slice(0, OUTPUT_SCHEMA_PATH.length)).toEqual(OUTPUT_SCHEMA_PATH);
      }

      const result = await readValidateResult(await validateWorkflow(base, token, { source }));
      expect(result.errors.map((issue) => issue.path)).toEqual(error.issues);
    });
  });

  it("accepts an existing Agent with an output schema that passes the lint", async () => {
    await withArrangedController(async (controller) => {
      expect(lintOutputSchema(CLEAN_OUTPUT_SCHEMA)).toEqual([]);
      await expectAccepted(
        controller,
        "a clean output schema",
        buildOutputSchemaSource(controller.agentId, CLEAN_OUTPUT_SCHEMA),
      );
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Triggers.                                                                 */
/* ------------------------------------------------------------------------ */

/** Builds a workflow with one trigger, from the YAML lines that go under its `- id:` line. */
const buildOneTriggerSource = (name: string, ...triggerLines: ReadonlyArray<string>): string =>
  `name: ${name}
triggers:
  - id: on_event
${triggerLines.map((line) => `    ${line}`).join("\n")}
steps:
${buildTaskStep("file_task")}
`;

/** A start trigger on the GitHub plugin's kind, from any GitHub Connection. */
const GITHUB_LABEL_TRIGGER_SOURCE = buildOneTriggerSource(
  "Labels from any Connection",
  "kind: start",
  "on:",
  "  kind: github.pr.labeled",
  "  connectionId: any",
);

const UNKNOWN_EVENT_KIND: InvalidFixture = {
  description: "an event kind that no one emits",
  build: () =>
    buildOneTriggerSource(
      "A kind nobody emits",
      "kind: start",
      "on:",
      "  kind: github.pr.labelled",
      "  connectionId: any",
    ),
  paths: [["triggers", "0", "on", "kind"]],
};

const PLUGIN_KIND_WITHOUT_CONNECTION: InvalidFixture = {
  description: "a plugin event kind with no connectionId",
  build: () =>
    buildOneTriggerSource(
      "Labels from no Connection",
      "kind: start",
      "on:",
      "  kind: github.pr.labeled",
    ),
  paths: [["triggers", "0", "on", "connectionId"]],
};

const CORE_KIND_WITH_CONNECTION: InvalidFixture = {
  description: "a core event kind with a connectionId",
  build: () =>
    buildOneTriggerSource(
      "Tasks from any Connection",
      "kind: start",
      "on:",
      "  kind: task.created",
      "  connectionId: any",
    ),
  paths: [["triggers", "0", "on", "connectionId"]],
};

const ABSENT_CONNECTION: InvalidFixture = {
  description: "a Connection that does not exist",
  build: () =>
    buildOneTriggerSource(
      "Labels from a missing Connection",
      "kind: start",
      "on:",
      "  kind: github.pr.labeled",
      `  connectionId: ${ABSENT_ID}`,
    ),
  paths: [["triggers", "0", "on", "connectionId"]],
};

const WRONG_TYPE_CONNECTION: InvalidFixture = {
  description: "a Connection of a different type than the event kind needs",
  build: ({ mailConnectionId }) =>
    buildOneTriggerSource(
      "Labels from a mail Connection",
      "kind: start",
      "on:",
      "  kind: github.pr.labeled",
      `  connectionId: ${mailConnectionId}`,
    ),
  paths: [["triggers", "0", "on", "connectionId"]],
};

/**
 * A trigger that listens for the event the Scheduler emits. No trigger can:
 * a trigger fires on a schedule by writing the schedule under `on`.
 */
const LISTENS_FOR_CRON_TICK: InvalidFixture = {
  description: "a trigger that listens for cron.tick",
  build: () =>
    buildOneTriggerSource("Listens for ticks", "kind: start", "on:", "  kind: cron.tick"),
  paths: [["triggers", "0", "on", "kind"]],
};

/**
 * A signal trigger that listens for the event the Scheduler emits. A signal
 * trigger cannot fire on a schedule either, so its error must not say to
 * write one.
 */
const SIGNAL_LISTENS_FOR_CRON_TICK: InvalidFixture = {
  description: "a signal trigger that listens for cron.tick",
  build: () =>
    buildOneTriggerSource(
      "Waits for ticks",
      "kind: signal",
      "on:",
      "  kind: cron.tick",
      "correlation:",
      "  event: event.payload.taskId",
      "  run: steps.file_task.output.id",
    ),
  paths: [["triggers", "0", "on", "kind"]],
};

/** Two invalid cron schedules: plain words, and an hour past 23. */
const INVALID_SCHEDULES: InvalidFixture = {
  description: "cron schedules that are not valid",
  build: () => `name: Schedules no clock can keep
triggers:
  - id: in_words
    kind: start
    on:
      schedule: every morning
  - id: hour_out_of_range
    kind: start
    on:
      schedule: "0 25 * * *"
steps:
${buildTaskStep("file_task")}
`,
  paths: [
    ["triggers", "0", "on", "schedule"],
    ["triggers", "1", "on", "schedule"],
  ],
};

/**
 * A schedule with six fields. Some cron parsers read the first field as
 * seconds, which workflows do not support.
 */
const SCHEDULE_WITH_SECONDS: InvalidFixture = {
  description: "a cron schedule with a field for seconds",
  build: () =>
    buildOneTriggerSource("Ticks each second", "kind: start", "on:", '  schedule: "0 0 9 * * 1-5"'),
  paths: [["triggers", "0", "on", "schedule"]],
};

/**
 * A schedule that parses but that no date matches: February never has a
 * 31st, so the Scheduler could never compute when the trigger fires next.
 */
const SCHEDULE_THAT_NEVER_COMES_DUE: InvalidFixture = {
  description: "a cron schedule that no date matches",
  build: () =>
    buildOneTriggerSource(
      "Ticks on the 31st of February",
      "kind: start",
      "on:",
      '  schedule: "0 0 31 2 *"',
    ),
  paths: [["triggers", "0", "on", "schedule"]],
};

const INVALID_TIMEZONE: InvalidFixture = {
  description: "a timezone that does not exist",
  build: () =>
    buildOneTriggerSource(
      "Ticks in no timezone",
      "kind: start",
      "on:",
      '  schedule: "0 9 * * 1-5"',
      "  timezone: Mars/Olympus_Mons",
    ),
  paths: [["triggers", "0", "on", "timezone"]],
};

const UNDECLARED_INPUT_MAPPING: InvalidFixture = {
  description: "a mapping of an input the workflow does not declare",
  build: () => `name: A mapping of no input
inputs:
  - name: task_id
    schema:
      type: string
    required: false
triggers:
  - id: on_create
    kind: start
    on:
      kind: task.created
    inputs:
      ghost: event.payload.id
steps:
${buildTaskStep("file_task")}
`,
  paths: [["triggers", "0", "inputs", "ghost"]],
};

/**
 * A required input with no default. The first start trigger maps it and the
 * second does not, so the error is at the second. The signal trigger maps no
 * input either, but it starts no run, so it needs no inputs.
 */
const UNMAPPED_REQUIRED_INPUT: InvalidFixture = {
  description: "a required input that one start trigger does not map",
  build: () => `name: A required input left unmapped
inputs:
  - name: pr_url
    schema:
      type: string
    required: true
triggers:
  - id: on_label
    kind: start
    on:
      kind: github.pr.labeled
      connectionId: any
    inputs:
      pr_url: event.payload.subject.url
  - id: on_create
    kind: start
    on:
      kind: task.created
  - id: task_changed
    kind: signal
    on:
      kind: task.updated
    correlation:
      event: event.payload.taskId
      run: steps.file_task.output.id
steps:
${buildTaskStep("file_task", "terminal: true")}
`,
  paths: [["triggers", "1", "inputs"]],
};

const TRIGGER_ERROR_FIXTURES: ReadonlyArray<InvalidFixture> = [
  UNKNOWN_EVENT_KIND,
  PLUGIN_KIND_WITHOUT_CONNECTION,
  CORE_KIND_WITH_CONNECTION,
  ABSENT_CONNECTION,
  WRONG_TYPE_CONNECTION,
  LISTENS_FOR_CRON_TICK,
  SIGNAL_LISTENS_FOR_CRON_TICK,
  INVALID_SCHEDULES,
  INVALID_TIMEZONE,
  UNDECLARED_INPUT_MAPPING,
  UNMAPPED_REQUIRED_INPUT,
];

/**
 * Builds a valid workflow with:
 * - a plugin event kind with `connectionId: any`, and with a Connection id
 * - a trigger on each core event kind
 * - a required input with a default, which a trigger may leave unmapped
 */
const buildEveryTriggerSource = (githubConnectionId: string): string =>
  `name: Every way a trigger names its events
inputs:
  - name: pr_url
    schema:
      type: string
    required: true
    default: ""
triggers:
  - id: any_label
    kind: start
    on:
      kind: github.pr.labeled
      connectionId: any
  - id: work_label
    kind: start
    on:
      kind: github.pr.labeled
      connectionId: ${githubConnectionId}
    inputs:
      pr_url: event.payload.subject.url
  - id: weekday_morning
    kind: start
    on:
      schedule: "0 9 * * 1-5"
      timezone: Europe/Amsterdam
  - id: on_run_completed
    kind: start
    on:
      kind: run.completed
  - id: on_run_failed
    kind: start
    on:
      kind: run.failed
  - id: on_run_cancelled
    kind: start
    on:
      kind: run.cancelled
  - id: on_task_created
    kind: start
    on:
      kind: task.created
  - id: on_task_updated
    kind: start
    on:
      kind: task.updated
steps:
${buildTaskStep("file_task")}
`;

describe("the trigger rules", () => {
  it("rejects each invalid trigger at its path", async () => {
    await withArrangedController(async (controller) => {
      for (const fixture of TRIGGER_ERROR_FIXTURES) await expectErrorsAt(controller, fixture);
      await expectNothingStored(controller.base, controller.token);
    });
  });

  it("rejects a schedule with six fields, with a message that a schedule has five fields and none for seconds", async () => {
    await withArrangedController(async (controller) => {
      const [issue] = await expectErrorsAt(controller, SCHEDULE_WITH_SECONDS);
      expect(issue!.message).toContain("six fields");
      expect(issue!.message).toContain("seconds");
    });
  });

  it("rejects a schedule that never comes due, with a message that no date matches it", async () => {
    await withArrangedController(async (controller) => {
      const [issue] = await expectErrorsAt(controller, SCHEDULE_THAT_NEVER_COMES_DUE);
      expect(issue!.message).toContain("never comes due");
      expect(issue!.message).toContain("no date matches it");
    });
  });

  it("lists only a few unmapped inputs in each message, so the response stays small with many inputs and several start triggers", async () => {
    await withArrangedController(async ({ base, token }) => {
      const inputNames = Array.from(
        { length: 1000 },
        (_, index) => `input_${String(index)}_${"x".repeat(30)}`,
      );
      const source = [
        "name: Many inputs that no trigger maps",
        "inputs:",
        ...inputNames.flatMap((name) => [
          `  - name: ${name}`,
          "    schema: { type: string }",
          "    required: true",
        ]),
        "triggers:",
        ...Array.from({ length: 5 }, (_, index) => [
          `  - id: on_create_${String(index)}`,
          "    kind: start",
          "    on:",
          "      kind: task.created",
        ]).flat(),
        "steps:",
        buildTaskStep("file_task"),
        "",
      ].join("\n");

      const saved = await createWorkflow(base, token, { source });
      expect(saved.status).toBe(400);
      const error = await readErrorBody(saved);
      expect(error.issues).toHaveLength(5);
      // Each message lists five inputs and a count of the rest. A message that
      // listed every input would make the response about 200 kB.
      expect(error.text.length).toBeLessThan(10_000);
      expect(error.text).toContain("and 995 more");

      const checked = await validateWorkflow(base, token, { source });
      expect((await checked.text()).length).toBeLessThan(10_000);
    });
  });

  it("rejects a trigger on cron.tick, with a message that says to write a schedule under on", async () => {
    await withArrangedController(async (controller) => {
      const [issue] = await expectErrorsAt(controller, LISTENS_FOR_CRON_TICK);
      expect(issue!.message).toContain("the Scheduler emits it only for cron triggers");
      expect(issue!.message).toContain("write schedule under on in place of kind");
      expect(issue!.message).not.toContain("The known event kinds are");
    });
  });

  it("rejects a signal trigger on cron.tick, with a message that says to name the kind of an event the run waits for", async () => {
    await withArrangedController(async (controller) => {
      const [issue] = await expectErrorsAt(controller, SIGNAL_LISTENS_FOR_CRON_TICK);
      expect(issue!.message).toContain("A signal trigger resumes a run when an event arrives");
      expect(issue!.message).toContain("The known event kinds are");
      expect(issue!.message).not.toContain("schedule");
    });
  });

  it("rejects a trigger written with source, with a message that says to rename it to on", async () => {
    await withArrangedController(async (controller) => {
      const issues = await expectErrorsAt(controller, {
        description: "a trigger written with source",
        build: () =>
          buildOneTriggerSource(
            "Written before on",
            "kind: start",
            "source:",
            "  kind: task.created",
          ),
        // The missing on is not reported separately: renaming source fixes both.
        paths: [["triggers", "0", "source"]],
      });
      expect(issues[0]!.message).toContain("Rename source to on");
    });
  });

  it("includes the trigger id and the input name in the error when a start trigger leaves a required input unmapped", async () => {
    await withArrangedController(async (controller) => {
      const [issue] = await expectErrorsAt(controller, UNMAPPED_REQUIRED_INPUT);
      expect(issue!.message).toContain("on_create");
      expect(issue!.message).toContain("pr_url");
    });
  });

  it("accepts connectionId any or a Connection id for a plugin event kind, every core event kind, and an unmapped required input with a default", async () => {
    await withArrangedController(async (controller) => {
      await expectAccepted(
        controller,
        "every trigger",
        buildEveryTriggerSource(controller.githubConnectionId),
      );
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Inputs.                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Builds a workflow whose second input is a GitHub Connection with
 * `defaultConnectionId` as its default.
 */
const buildConnectionInputSource = (defaultConnectionId: string): string =>
  `name: Acts through one GitHub account
inputs:
  - name: title
    schema:
      type: string
    required: false
  - name: account
    connection:
      type: github/github
    required: false
    default: ${defaultConnectionId}
steps:
${buildTaskStep("file_task")}
`;

const ABSENT_CONNECTION_DEFAULT: InvalidFixture = {
  description: "a Connection input whose default Connection does not exist",
  build: () => buildConnectionInputSource(ABSENT_ID),
  paths: [["inputs", "1", "default"]],
};

const WRONG_TYPE_CONNECTION_DEFAULT: InvalidFixture = {
  description: "a Connection input whose default is a Connection of another type",
  build: ({ mailConnectionId }) => buildConnectionInputSource(mailConnectionId),
  paths: [["inputs", "1", "default"]],
};

/** A Connection input of a type that no plugin registered: `github/gh` is a typo. */
const UNKNOWN_CONNECTION_TYPE: InvalidFixture = {
  description: "a Connection input of a type no plugin registered",
  build: () => `name: Acts through an account of no type
inputs:
  - name: account
    connection:
      type: github/gh
    required: false
steps:
${buildTaskStep("file_task")}
`,
  paths: [["inputs", "0", "connection", "type"]],
};

/* ------------------------------------------------------------------------ */
/* An action that acts through a Connection.                                 */
/* ------------------------------------------------------------------------ */

/**
 * Builds a workflow with one step that calls the forge review action. The
 * workflow has a Connection input `account` of the type `accountType`, and a
 * string input `verdict`. `connection` is the YAML value of the step's
 * `connection` param, or `undefined` to leave the param out.
 */
const buildReviewSource = (
  connection: string | undefined,
  options: { readonly verdict?: string; readonly accountType?: string } = {},
): string => `name: Review through a Connection
inputs:
  - name: account
    connection:
      type: ${options.accountType ?? FORGE_CONNECTION_TYPE}
    required: false
  - name: verdict
    schema:
      type: string
    required: false
steps:
  - id: review
    kind: action
    action: ${FORGE_REVIEW_ACTION_ID}
    params:
${connection === undefined ? "" : `      connection: ${connection}\n`}      verdict: ${options.verdict ?? "approve"}
`;

/** The path of the review step's `connection` param in `buildReviewSource`. */
const REVIEW_CONNECTION_PATH = ["steps", "0", "params", "connection"];

const MISSING_CONNECTION_PARAM: InvalidFixture = {
  description: "a step that names no Connection for an action that acts through one",
  build: () => buildReviewSource(undefined),
  paths: [["steps", "0", "params"]],
};

const ABSENT_CONNECTION_PARAM: InvalidFixture = {
  description: "a step that names a Connection that does not exist",
  build: () => buildReviewSource(ABSENT_ID),
  paths: [REVIEW_CONNECTION_PATH],
};

const WRONG_TYPE_CONNECTION_PARAM: InvalidFixture = {
  description: "a step that names a Connection of another type",
  build: ({ githubConnectionId }) => buildReviewSource(githubConnectionId),
  paths: [REVIEW_CONNECTION_PATH],
};

const NUMBER_CONNECTION_PARAM: InvalidFixture = {
  description: "a step whose connection param is a number",
  build: () => buildReviewSource("42"),
  paths: [REVIEW_CONNECTION_PATH],
};

const WRONG_TYPE_CONNECTION_INPUT: InvalidFixture = {
  description: "a step that names a Connection input of another type",
  build: () => buildReviewSource('"{{ inputs.account }}"', { accountType: "github/github" }),
  paths: [REVIEW_CONNECTION_PATH],
};

const STRING_INPUT_AS_CONNECTION: InvalidFixture = {
  description: "a step that names an input that is not a Connection input",
  build: () => buildReviewSource('"{{ inputs.verdict }}"'),
  paths: [REVIEW_CONNECTION_PATH],
};

const ABSENT_INPUT_AS_CONNECTION: InvalidFixture = {
  description: "a step that names an input the workflow does not have",
  build: () => buildReviewSource('"{{ inputs.nobody }}"'),
  paths: [REVIEW_CONNECTION_PATH],
};

describe("an action that acts through a Connection", () => {
  it("rejects a step with no connection param, and says what the param names", async () => {
    await withArrangedController(async (controller) => {
      const [issue] = await expectErrorsAt(controller, MISSING_CONNECTION_PARAM);
      expect(issue!.message).toContain("needs the param connection");
      expect(issue!.message).toContain(FORGE_CONNECTION_TYPE);
    });
  });

  it("rejects a literal connection that is no Connection, or a Connection of another type", async () => {
    await withArrangedController(async (controller) => {
      const [absent] = await expectErrorsAt(controller, ABSENT_CONNECTION_PARAM);
      expect(absent!.message).toContain("No Connection has this id");
      const [wrongType] = await expectErrorsAt(controller, WRONG_TYPE_CONNECTION_PARAM);
      expect(wrongType!.message).toContain("This Connection is of type github/github");
      expect(wrongType!.message).toContain(FORGE_CONNECTION_TYPE);
      const [number] = await expectErrorsAt(controller, NUMBER_CONNECTION_PARAM);
      expect(number!.message).toContain("the id of a Connection of type");
      await expectNothingStored(controller.base, controller.token);
    });
  });

  it("rejects a template that reads an input which is not a Connection input of the action's type", async () => {
    await withArrangedController(async (controller) => {
      const [wrongType] = await expectErrorsAt(controller, WRONG_TYPE_CONNECTION_INPUT);
      expect(wrongType!.message).toContain("github/github");
      expect(wrongType!.message).toContain(FORGE_CONNECTION_TYPE);
      const [stringInput] = await expectErrorsAt(controller, STRING_INPUT_AS_CONNECTION);
      expect(stringInput!.message).toContain("is not a Connection input");
      const [absentInput] = await expectErrorsAt(controller, ABSENT_INPUT_AS_CONNECTION);
      expect(absentInput!.message).toContain("has no input named");
    });
  });

  it("accepts a Connection of the action's type, and a Connection input of that type", async () => {
    await withArrangedController(async (controller) => {
      await expectAccepted(
        controller,
        "a literal Connection",
        buildReviewSource(controller.forgeConnectionId),
      );
      await expectAccepted(
        controller,
        "a Connection input",
        buildReviewSource('"{{ inputs.account }}"'),
      );
      await expectAccepted(
        controller,
        "a Connection input with no spaces inside the braces",
        buildReviewSource('"{{inputs.account}}"'),
      );
    });
  });

  it("rejects every other template, and names the two forms the param takes", async () => {
    await withArrangedController(async (controller) => {
      for (const [description, connection] of [
        ["an input read with brackets", `'{{ inputs["account"] }}'`],
        ["a step's output", '"{{ steps.find.output.id }}"'],
        ["a field inside an input", '"{{ inputs.account.id }}"'],
        ["text around an input", '"acct-{{ inputs.account }}"'],
        ["two templates", '"{{ inputs.account }}{{ inputs.account }}"'],
      ] as const) {
        const [issue] = await expectErrorsAt(controller, {
          description,
          build: () => buildReviewSource(connection),
          paths: [REVIEW_CONNECTION_PATH],
        });
        expect(issue!.message, description).toBe(
          `The param connection cannot be computed by a template: the action acts through a Connection of type ${FORGE_CONNECTION_TYPE}, and that Connection must be known before a run starts. Write the id of a Connection of type ${FORGE_CONNECTION_TYPE}, or a template that is exactly one Connection input of that type, such as {{ inputs.account }}.`,
        );
      }
      await expectNothingStored(controller.base, controller.token);
    });
  });

  it("accepts a template for a param that allows only fixed literals, such as the verdict", async () => {
    await withArrangedController(async (controller) => {
      await expectAccepted(
        controller,
        "a verdict template",
        buildReviewSource(controller.forgeConnectionId, { verdict: '"{{ inputs.verdict }}"' }),
      );
    });
  });
});

/**
 * Builds a workflow with one `run.start` step. Its `workflowId` param is
 * `workflowId` and its `inputs` param is `inputs`, both as YAML values. The
 * workflow has a Connection input `acc` of the forge's type, and string
 * inputs `child` and `label`.
 */
const buildRunStartSource = (workflowId: string, inputs: string): string => `name: Start a review
inputs:
  - name: acc
    connection:
      type: ${FORGE_CONNECTION_TYPE}
    required: false
  - name: child
    schema:
      type: string
    required: false
  - name: label
    schema:
      type: string
    required: false
steps:
  - id: start
    kind: action
    action: run.start
    params:
      workflowId: ${workflowId}
      inputs: ${inputs}
`;

/** The path of the value the `run.start` step of `buildRunStartSource` gives for the input `account`. */
const STARTED_ACCOUNT_PATH = ["steps", "0", "params", "inputs", "account"];

describe("a run.start step that gives a value for a Connection input", () => {
  /** Saves the review workflow, whose Connection input `account` the review step acts through, and returns its id. */
  const createReviewTarget = async (controller: ArrangedController): Promise<string> =>
    (
      await createWorkflowOrFail(controller.base, controller.token, {
        source: buildReviewSource('"{{ inputs.account }}"'),
      })
    ).id;

  it("checks the value against the Connection input of a stored workflow, in the forms of the connection param", async () => {
    await withArrangedController(async (controller) => {
      const targetId = await createReviewTarget(controller);
      const forms = `Write the id of a Connection of type ${FORGE_CONNECTION_TYPE}, or a template that is exactly one Connection input of that type, such as {{ inputs.account }}.`;
      const need = `the input account of the workflow this step starts takes a Connection of type ${FORGE_CONNECTION_TYPE}`;
      for (const [description, account, message] of [
        [
          "a computed template",
          '"acct-{{ inputs.acc }}"',
          `The value for the input account cannot be computed by a template: ${need}, and that Connection must be known before a run starts. ${forms}`,
        ],
        ["an id no Connection has", ABSENT_ID, `No Connection has this id. ${forms}`],
        [
          "an input that is not a Connection input",
          '"{{ inputs.label }}"',
          `The input label is not a Connection input, and ${need}. ${forms}`,
        ],
        [
          "a Connection of another type",
          controller.githubConnectionId,
          `This Connection is of type github/github, but ${need}. ${forms}`,
        ],
      ] as const) {
        const [issue] = await expectErrorsAt(controller, {
          description,
          build: () => buildRunStartSource(targetId, `{ account: ${account} }`),
          paths: [STARTED_ACCOUNT_PATH],
        });
        expect(issue!.message, description).toBe(message);
      }

      await expectAccepted(
        controller,
        "a literal Connection",
        buildRunStartSource(targetId, `{ account: ${controller.forgeConnectionId} }`),
      );
      await expectAccepted(
        controller,
        "a Connection input",
        buildRunStartSource(targetId, '{ account: "{{ inputs.acc }}" }'),
      );
    });
  });

  it("refuses every computed value, and a computed inputs template, when the workflow to start is a template", async () => {
    await withArrangedController(async (controller) => {
      const fix =
        "Write the value itself, or a template that is exactly one input, such as {{ inputs.account }}. Or name the workflow to start by its id, so that only its Connection inputs are checked.";
      const need =
        "the workflow this step starts may take a Connection in its inputs, and that Connection must be known before a run starts.";
      // Which inputs take a Connection is unknown, so even a computed value
      // for what is plain text, such as a title, is refused.
      for (const [description, inputs, path, message] of [
        [
          "a computed value for a Connection",
          '{ account: "x-{{ inputs.acc }}" }',
          STARTED_ACCOUNT_PATH,
          `The value for the input account cannot be computed by a template: ${need} ${fix}`,
        ],
        [
          "a computed value for plain text",
          '{ title: "Review {{ inputs.label }}" }',
          ["steps", "0", "params", "inputs", "title"],
          `The value for the input title cannot be computed by a template: ${need} ${fix}`,
        ],
        [
          "a computed inputs template",
          '"{{ inputs.label }}-inputs"',
          ["steps", "0", "params", "inputs"],
          `The param inputs cannot be computed by a template: ${need} ${fix}`,
        ],
      ] as const) {
        const [issue] = await expectErrorsAt(controller, {
          description,
          build: () => buildRunStartSource('"{{ inputs.child }}"', inputs),
          paths: [path],
        });
        expect(issue!.message, description).toBe(message);
      }

      // Any literal, and any single input, may fill an input of a workflow
      // that is not known before a run, and so may fill the whole inputs param.
      for (const [description, inputs] of [
        ["a literal", "{ account: any-text }"],
        ["a string input", '{ account: "{{ inputs.label }}" }'],
        ["an inputs template that is exactly one input", '"{{ inputs.label }}"'],
      ] as const) {
        await expectAccepted(
          controller,
          description,
          buildRunStartSource('"{{ inputs.child }}"', inputs),
        );
      }
    });
  });
});

const INPUT_ERROR_FIXTURES: ReadonlyArray<InvalidFixture> = [
  ABSENT_CONNECTION_DEFAULT,
  WRONG_TYPE_CONNECTION_DEFAULT,
];

describe("the inputs", () => {
  it("rejects a Connection input whose default Connection does not exist or has the wrong type", async () => {
    await withArrangedController(async (controller) => {
      for (const fixture of INPUT_ERROR_FIXTURES) await expectErrorsAt(controller, fixture);
      await expectNothingStored(controller.base, controller.token);
    });
  });

  it("rejects a Connection input whose type no plugin registered, and lists the known types", async () => {
    await withArrangedController(async (controller) => {
      const [issue] = await expectErrorsAt(controller, UNKNOWN_CONNECTION_TYPE);
      expect(issue!.message).toContain("github/github");
    });
  });

  it("rejects a Connection input whose type belongs to a disabled plugin, and tells the user to enable the plugin", async () => {
    await withArrangedController(async (controller) => {
      const source = `name: Acts through a mail account
inputs:
  - name: account
    connection:
      type: mail/mail
    required: false
steps:
${buildTaskStep("file_task")}
`;
      await expectAccepted(controller, "a mail Connection input", source);

      await disablePlugin(controller.base, controller.token, "mail");
      const [issue] = await expectErrorsAt(controller, {
        description: "a mail Connection input with the mail plugin disabled",
        build: () => source,
        paths: [["inputs", "0", "connection", "type"]],
      });
      expect(issue!.message).toContain("Enable the plugin that declares this type");
    });
  });

  it("accepts a Connection input whose default is a Connection of its type", async () => {
    await withArrangedController(async (controller) => {
      await expectAccepted(
        controller,
        "a GitHub default",
        buildConnectionInputSource(controller.githubConnectionId),
      );
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Input names and signal output names.                                      */
/* ------------------------------------------------------------------------ */

/**
 * Builds a workflow with two inputs and two signal outputs. The first of each
 * is named `prUrl`, which is always valid. The second input is named
 * `inputName` and the second output `outputName`: these are the names under
 * test.
 */
const buildInputAndOutputNamesSource = (inputName: string, outputName: string): string =>
  `name: Names an expression reads
inputs:
  - name: prUrl
    schema:
      type: string
    required: false
  - name: ${inputName}
    schema:
      type: string
    required: false
triggers:
  - id: on_create
    kind: start
    on:
      kind: task.created
  - id: pr_merged
    kind: signal
    on:
      kind: task.updated
    correlation:
      event: event.payload.taskId
      run: steps.file_task.output.id
    outputs:
      prUrl: event.payload.url
      ${outputName}: event.payload.url
steps:
${buildTaskStep("file_task", "terminal: true")}
`;

const NAMES_THAT_ARE_NOT_IDENTIFIERS: InvalidFixture = {
  description: "an input name and a signal output name that are not CEL identifiers",
  build: () => buildInputAndOutputNamesSource("pr-url", "pr-url"),
  paths: [
    ["inputs", "1", "name"],
    ["triggers", "1", "outputs", "pr-url"],
  ],
};

describe("input names and signal output names", () => {
  it("rejects an input name and a signal output name that are not CEL identifiers, and explains that an expression could not read them", async () => {
    await withArrangedController(async (controller) => {
      const issues = await expectErrorsAt(controller, NAMES_THAT_ARE_NOT_IDENTIFIERS);
      for (const issue of issues) expect(issue.message).toMatch(/expression/i);
    });
  });

  it("accepts prUrl and pr_url as an input name and as a signal output name", async () => {
    await withArrangedController(async (controller) => {
      await expectAccepted(
        controller,
        "readable names",
        buildInputAndOutputNamesSource("pr_url", "pr_url"),
      );
    });
  });
});

/* ------------------------------------------------------------------------ */
/* The warning about a run with no end.                                      */
/* ------------------------------------------------------------------------ */

/**
 * Builds a workflow with a signal trigger and a step after it. Pass
 * `terminal: true` as `terminalLine` to make that step end the run.
 */
const buildSignalWorkflowSource = (terminalLine: string): string =>
  `name: Waits for the task to change
triggers:
  - id: task_changed
    kind: signal
    on:
      kind: task.updated
    correlation:
      event: event.payload.taskId
      run: steps.file_task.output.id
steps:
${buildTaskStep("file_task")}
${buildTaskStep("follow_up", ...(terminalLine === "" ? [] : [terminalLine]))}
edges:
  - from: task_changed
    to: follow_up
`;

const readWorkflowSaveResult = async (response: Response): Promise<WorkflowSaveResult> => {
  expect([200, 201], await response.clone().text()).toContain(response.status);
  return (await response.json()) as WorkflowSaveResult;
};

/** Checks that the only warning is the one for a run that only cancellation can end. */
const expectOnlyCancellationWarning = (warnings: ReadonlyArray<Issue>): void => {
  expect(warnings.map((warning) => warning.path)).toEqual([["steps"]]);
  expect(warnings[0]!.message).toMatch(/cancel/i);
};

describe("the warning about a run with no end", () => {
  it("saves a workflow with a signal trigger and no terminal step, and create, update and validate each return one warning", async () => {
    await withArrangedController(async ({ base, token }) => {
      const source = buildSignalWorkflowSource("");

      const created = await readWorkflowSaveResult(await createWorkflow(base, token, { source }));
      expectOnlyCancellationWarning(created.warnings);

      const updated = await readWorkflowSaveResult(
        await updateWorkflow(base, token, created.workflow.id, { source }),
      );
      expectOnlyCancellationWarning(updated.warnings);

      const checked = await readValidateResult(await validateWorkflow(base, token, { source }));
      expect(checked.errors).toEqual([]);
      expectOnlyCancellationWarning(checked.warnings);
    });
  });

  it("returns no warning for a workflow with no signal trigger, or with a terminal step", async () => {
    await withArrangedController(async ({ base, token }) => {
      for (const source of [FILE_TASK_SOURCE, buildSignalWorkflowSource("terminal: true")]) {
        const created = await readWorkflowSaveResult(await createWorkflow(base, token, { source }));
        expect(created.warnings, source).toEqual([]);

        const updated = await readWorkflowSaveResult(
          await updateWorkflow(base, token, created.workflow.id, { source }),
        );
        expect(updated.warnings, source).toEqual([]);

        const checked = await readValidateResult(await validateWorkflow(base, token, { source }));
        expect(checked, source).toEqual({ errors: [], warnings: [] });
      }
    });
  });
});

/* ------------------------------------------------------------------------ */
/* workflow.validate compared with workflow.create.                          */
/* ------------------------------------------------------------------------ */

/**
 * Every invalid fixture in this file. The output schema fixture has no
 * `paths`, because the lint decides its error paths. The tests below compare
 * create with validate, so they do not need `paths`.
 */
const EVERY_INVALID_FIXTURE: ReadonlyArray<Pick<InvalidFixture, "description" | "build">> = [
  ...PARSE_ERROR_FIXTURES,
  ...GRAPH_ERROR_FIXTURES,
  REVIEW_LOOP_WITHOUT_ENTRY,
  ...EXPRESSION_ERROR_FIXTURES,
  ...ACTION_ERROR_FIXTURES,
  UNKNOWN_AGENT,
  {
    description: "an output schema that fails the lint",
    build: ({ agentId }) => buildOutputSchemaSource(agentId, LINT_FAILING_OUTPUT_SCHEMA),
  },
  ...TRIGGER_ERROR_FIXTURES,
  ...INPUT_ERROR_FIXTURES,
  NAMES_THAT_ARE_NOT_IDENTIFIERS,
  EDGE_FROM_START_TRIGGER,
  UNCAPPED_SELF_LOOP,
  UNREACHED_LOOP,
  UNKNOWN_CONNECTION_TYPE,
  EVERY_STEP_AFTER_A_SIGNAL,
  SCHEDULE_WITH_SECONDS,
];

/** A definition object whose step uses an action that does not exist. */
const UNKNOWN_ACTION_DEFINITION = {
  name: "An action nobody declared",
  steps: [
    {
      id: "file_task",
      kind: "action",
      action: "task.creat",
      params: { title: "Look at the failures", description: "Filed by a workflow." },
    },
  ],
};

describe("workflow.validate", () => {
  // The Workflows screen opens a new workflow with this source. The author
  // must see a graph and no errors before typing anything.
  it("finds no errors or warnings in the starter workflow source", async () => {
    await withSetUpController(async ({ base, token }) => {
      expect(
        await readValidateResult(
          await validateWorkflow(base, token, { source: STARTER_WORKFLOW_SOURCE }),
        ),
      ).toEqual({ errors: [], warnings: [] });
    });
  });

  it("stores nothing, whether the input is valid or not", async () => {
    await withArrangedController(async (controller) => {
      const { base, token } = controller;
      // Include a valid source with a trigger, so that a stored workflow or a
      // stored trigger row would show up in its list.
      for (const source of [
        buildEveryTriggerSource(controller.githubConnectionId),
        ...EVERY_INVALID_FIXTURE.map((fixture) => fixture.build(controller)),
      ]) {
        await readValidateResult(await validateWorkflow(base, token, { source }));
      }
      await expectNothingStored(base, token);
    });
  });

  it("returns, for every invalid fixture, the same errors that create fails with", async () => {
    await withArrangedController(async (controller) => {
      const { base, token } = controller;
      for (const fixture of EVERY_INVALID_FIXTURE) {
        const source = fixture.build(controller);
        const result = await readValidateResult(await validateWorkflow(base, token, { source }));

        const response = await createWorkflow(base, token, { source });
        expect(response.status, `${fixture.description}: ${await response.clone().text()}`).toBe(
          400,
        );
        expect(result.errors, fixture.description).not.toEqual([]);
        expect(result.errors, fixture.description).toEqual(await readIssues(response));
      }
      await expectNothingStored(base, token);
    });
  });

  it("validates a definition object the same way create does", async () => {
    await withArrangedController(async ({ base, token }) => {
      const result = await readValidateResult(
        await validateWorkflow(base, token, { definition: UNKNOWN_ACTION_DEFINITION }),
      );
      expect(result.errors.map((issue) => issue.path)).toEqual([["steps", "0", "action"]]);

      const response = await createWorkflow(base, token, {
        definition: UNKNOWN_ACTION_DEFINITION,
      });
      expect(result.errors).toEqual(await readIssues(response));
    });
  });

  it("fails with a Validation error when both source and definition are sent, or neither", async () => {
    await withArrangedController(async ({ base, token }) => {
      for (const body of [
        { source: FILE_TASK_SOURCE, definition: UNKNOWN_ACTION_DEFINITION },
        {},
      ]) {
        const response = await validateWorkflow(base, token, body);
        expect(response.status, await response.clone().text()).toBe(400);
        expect((await readErrorBody(response)).code).toBe("validation");
      }
    });
  });
});

/* ------------------------------------------------------------------------ */
/* The catalogs the editor offers choices from.                              */
/* ------------------------------------------------------------------------ */

/** One action in the list that `workflowAction.query` returns. */
interface WorkflowActionItem {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly runsIn: string;
  readonly connection?: { readonly type: string };
  readonly inputSchema: {
    readonly type?: unknown;
    readonly properties?: Record<string, unknown>;
    readonly required?: ReadonlyArray<string>;
  };
}

/** One event kind in the list that `eventKind.query` returns. */
interface EventKindItem {
  readonly kind: string;
  readonly description: string;
  readonly connectionRequired: boolean;
}

const listWorkflowActions = async (
  base: string,
  token: string,
): Promise<ReadonlyArray<WorkflowActionItem>> => {
  const response = await get(base, "/api/v1/workflow-actions", token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ReadonlyArray<WorkflowActionItem>;
};

const listEventKinds = async (
  base: string,
  token: string,
): Promise<ReadonlyArray<EventKindItem>> => {
  const response = await get(base, "/api/v1/event-kinds", token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ReadonlyArray<EventKindItem>;
};

const findActionById = (
  actions: ReadonlyArray<WorkflowActionItem>,
  id: string,
): WorkflowActionItem => {
  const found = actions.find((action) => action.id === id);
  expect(found, id).toBeDefined();
  return found!;
};

describe("workflowAction.query", () => {
  it("returns the built-in actions and the actions of enabled plugins, each with its input as JSON Schema", async () => {
    await withArrangedController(async ({ base, token }) => {
      const actions = await listWorkflowActions(base, token);
      expect(actions.map((action) => action.id).sort()).toEqual(
        [...BUILT_IN_ACTION_IDS, NOTE_APPEND_ACTION_ID, FORGE_REVIEW_ACTION_ID].sort(),
      );
      for (const action of actions) {
        expect(Object.keys(action).sort(), action.id).toEqual([
          ...(action.id === FORGE_REVIEW_ACTION_ID ? ["connection"] : []),
          "description",
          "displayName",
          "id",
          "inputSchema",
          "runsIn",
        ]);
        expect(action.displayName.trim(), action.id).not.toBe("");
        expect(action.description.trim(), action.id).not.toBe("");
        expect(action.inputSchema.type, action.id).toBe("object");
      }

      const noteAppend = findActionById(actions, NOTE_APPEND_ACTION_ID);
      expect(noteAppend.displayName).toBe(NOTE_APPEND_ACTION.displayName);
      expect(noteAppend.description).toBe(NOTE_APPEND_ACTION.description);
      expect(Object.keys(noteAppend.inputSchema.properties ?? {}).sort()).toEqual([
        "pinned",
        "text",
      ]);
      expect(noteAppend.inputSchema.required).toEqual(["text"]);

      // Every plugin action runs on the controller; a git step runs in the workspace.
      expect(noteAppend.runsIn).toBe("controller");
      expect(findActionById(actions, "task.create").runsIn).toBe("controller");
      expect(findActionById(actions, "git.commit").runsIn).toBe("workspace");

      // A built-in action's input schema is the input schema of its operation.
      const taskCreate = findActionById(actions, "task.create");
      expect(Object.keys(taskCreate.inputSchema.properties ?? {})).toEqual(
        expect.arrayContaining(["title", "description"]),
      );
      expect(taskCreate.inputSchema.required).toEqual(
        expect.arrayContaining(["title", "description"]),
      );
    });
  });

  it("gives the Connection type of an action that acts through a Connection, and leaves the connection param out of its input schema", async () => {
    await withArrangedController(async ({ base, token }) => {
      const review = findActionById(await listWorkflowActions(base, token), FORGE_REVIEW_ACTION_ID);
      expect(review.connection).toEqual({ type: FORGE_CONNECTION_TYPE });
      expect(Object.keys(review.inputSchema.properties ?? {}).sort()).toEqual(["body", "verdict"]);
      expect(review.inputSchema.required).toEqual(["verdict"]);
    });
  });

  it("leaves out the actions of a plugin once it is disabled", async () => {
    await withArrangedController(async ({ base, token }) => {
      await disablePlugin(base, token, "notes");
      const actions = await listWorkflowActions(base, token);
      expect(actions.map((action) => action.id).sort()).toEqual(
        [...BUILT_IN_ACTION_IDS, FORGE_REVIEW_ACTION_ID].sort(),
      );
    });
  });
});

describe("eventKind.query", () => {
  it("returns the platform event kinds as needing no Connection, and each plugin event kind as needing one", async () => {
    await withArrangedController(async ({ base, token }) => {
      const kinds = await listEventKinds(base, token);
      expect(kinds.map((item) => item.kind).sort()).toEqual(
        [...PLATFORM_EVENT_KINDS, "github.pr.labeled"].sort(),
      );
      for (const item of kinds) {
        expect(Object.keys(item).sort(), item.kind).toEqual([
          "connectionRequired",
          "description",
          "kind",
        ]);
        expect(item.description.trim(), item.kind).not.toBe("");
        expect(item.connectionRequired, item.kind).toBe(item.kind === "github.pr.labeled");
      }
      expect(kinds.find((item) => item.kind === "github.pr.labeled")?.description).toBe(
        "The labels on a pull request changed.",
      );
    });
  });

  // A disabled plugin emits no events, so a trigger on one of its event kinds
  // could never start a run. So the kind is left out of the list and rejected,
  // the same as an action of a disabled plugin.
  it("leaves out the event kinds of a plugin once it is disabled, and rejects a trigger that uses one", async () => {
    await withArrangedController(async (controller) => {
      const { base, token } = controller;
      await expectAccepted(controller, "the GitHub kind", GITHUB_LABEL_TRIGGER_SOURCE);

      await disablePlugin(base, token, "github");
      const kinds = await listEventKinds(base, token);
      expect(kinds.map((item) => item.kind).sort()).toEqual(PLATFORM_EVENT_KINDS);
      await expectErrorsAt(controller, {
        description: "the GitHub kind with its plugin disabled",
        build: () => GITHUB_LABEL_TRIGGER_SOURCE,
        paths: [["triggers", "0", "on", "kind"]],
      });
    });
  });
});

/* ------------------------------------------------------------------------ */
/* The grant that validation and the catalogs need.                          */
/* ------------------------------------------------------------------------ */

describe("the grant that validation and the catalogs need", () => {
  it("requires the workflow.read grant for workflow.validate, workflowAction.query and eventKind.query", async () => {
    await withAgentFleet(async (arranged) => {
      const base = arranged.harness.base;
      const reads: ReadonlyArray<readonly [string, (token: string) => Promise<Response>]> = [
        [
          "workflow.validate",
          (token) => validateWorkflow(base, token, { source: FILE_TASK_SOURCE }),
        ],
        ["workflowAction.query", (token) => get(base, "/api/v1/workflow-actions", token)],
        ["eventKind.query", (token) => get(base, "/api/v1/event-kinds", token)],
      ];

      // The shipped worker profile has no workflow grant at all.
      const workerSession = await spawnThreadUnder(
        arranged,
        await readProfileNamed(arranged, "worker"),
      );
      for (const [operation, read] of reads) {
        const response = await read(workerSession.token);
        const error = await readErrorBody(response);
        expect(response.status, `${operation}: ${error.text}`).toBe(403);
        expect(error.code, operation).toBe("forbidden");
        expect(error.grant, operation).toBe("workflow.read");
      }

      // The shipped assistant profile has workflow.read.
      const assistantSession = await spawnThreadUnder(
        arranged,
        await readProfileNamed(arranged, "assistant"),
      );
      for (const [operation, read] of reads) {
        const response = await read(assistantSession.token);
        expect(response.status, `${operation}: ${await response.clone().text()}`).toBe(200);
      }
    });
  });
});
