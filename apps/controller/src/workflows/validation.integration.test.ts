/**
 * What the controller checks in a workflow before it stores one, over a real
 * socket: the graph, the expressions at every site, the actions and their
 * params, the agents and their output schemas, the triggers and the inputs,
 * the one warning, and the two catalogs an editor reads its choices from.
 *
 * Each refusal fixture is broken in one place and valid in every other way, so
 * the paths a refusal names are exactly the places the fixture broke. A save
 * and a check must name the same places, because the editor shows the answer
 * of the check while the author types and the save is what the author trusts.
 * So each fixture is sent to `workflow.create` and to `workflow.validate`, and
 * the save is sent first: when the save takes a fixture it must refuse, the
 * failure says so before it says anything about the check.
 *
 * The controller has GitHub, locally, for its event kind and its Connection
 * type; a second Connection type, for a Connection of the wrong type; a
 * provider, for an Agent; and a plugin that declares one workflow action.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect, Schema } from "effect";
import { STARTER_WORKFLOW_SOURCE, type Issue } from "@hercule/contract";
import { HOST_API, registerConnectionType, type Plugin } from "@hercule/plugin-host";
import { lintOutputSchema } from "@hercule/protocol";
import { get, post, readRefusal } from "../http/testing";
import { NOTE_APPEND_ACTION, NOTE_APPEND_ACTION_ID, notesPlugin } from "../plugins/testing";
import { agentOn, profileNamed, WAIT_DEADLINE_MS, withAgentFleet } from "../sessions/testing";
import {
  ABSENT_ID,
  ACCEPTED_GITHUB_TOKEN,
  createAgent,
  createConnection,
  createWorkflow,
  expectNothingStored,
  readIssues,
  updateWorkflow,
  withSetUpController,
  type SetUpController,
} from "./testing";

/**
 * Three, because a case about a session token waits for the fleet to be
 * probed and then for each session it starts.
 */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

/**
 * A second Connection type, `mail/mail`, and no event source. A Connection of
 * this type is a real Connection of a type that no GitHub event arrives
 * through, and that no GitHub input takes.
 */
const localMailPlugin: Plugin = {
  manifest: {
    id: "mail",
    displayName: "Mail",
    hostApi: HOST_API,
    capabilities: ["connections"],
    configSchema: Schema.Struct({}),
  },
  register: (host) =>
    registerConnectionType(host, {
      type: "mail",
      displayName: "Mail",
      setup: [{ kind: "credentials", fields: [{ name: "password", label: "App password" }] }],
      validate: () => Effect.succeed({ displayName: "me@example.com" }),
    }),
  activate: () => Effect.succeed(Effect.void),
};

/** The actions the core declares. A step can name each one while no plugin is on. */
const BUILT_IN_ACTION_IDS = ["task.create", "task.query", "task.update"];

/** The event kinds the core emits. A trigger names each one without a Connection. */
const CORE_EVENT_KINDS = [
  "cron.tick",
  "run.cancelled",
  "run.completed",
  "run.failed",
  "task.created",
  "task.updated",
];

/** What the fixtures read from the controller they are sent to: ids that exist on it. */
interface FixtureContext {
  readonly agentId: string;
  readonly githubConnectionId: string;
  readonly mailConnectionId: string;
}

/** A controller past setup, with an Agent and a Connection of each type on it. */
interface ArrangedController extends SetUpController, FixtureContext {}

/** A controller with every fixture plugin on it, an Agent, and one Connection of each type. */
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
      });
    },
    [localMailPlugin, notesPlugin],
  );

/** What `workflow.validate` answers: the problems that stop a save, and the ones that do not. */
interface ValidationAnswer {
  readonly errors: ReadonlyArray<Issue>;
  readonly warnings: ReadonlyArray<Issue>;
}

const validateWorkflow = (base: string, token: string, body: unknown): Promise<Response> =>
  post(base, "/api/v1/workflows/validate", body, token);

/** The answer of a check the controller took, whatever it found in the workflow. */
const readValidationAnswer = async (response: Response): Promise<ValidationAnswer> => {
  expect(response.status, await response.clone().text()).toBe(200);
  const answer = (await response.json()) as ValidationAnswer;
  expect(Object.keys(answer).sort()).toEqual(["errors", "warnings"]);
  return answer;
};

/** Paths in one fixed order, so two lists of the same places compare equal. */
const sortIssuePaths = (
  paths: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<ReadonlyArray<string>> =>
  [...paths].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

/** One source the controller must refuse, and the places the refusal must name. */
interface RefusalFixture {
  readonly description: string;
  readonly build: (context: FixtureContext) => string;
  readonly paths: ReadonlyArray<ReadonlyArray<string>>;
}

/**
 * Refuses the fixture's source at exactly the fixture's paths, through a save
 * and through a check, and answers the issues of the check.
 */
const expectRefusedAt = async (
  controller: ArrangedController,
  refusalFixture: RefusalFixture,
): Promise<ReadonlyArray<Issue>> => {
  const { base, token } = controller;
  const source = refusalFixture.build(controller);

  const response = await createWorkflow(base, token, { source });
  expect(response.status, `${refusalFixture.description}: ${await response.clone().text()}`).toBe(
    400,
  );
  const refusal = await readRefusal(response);
  expect(refusal.code, refusalFixture.description).toBe("validation");
  expect(sortIssuePaths(refusal.issues), refusalFixture.description).toEqual(
    sortIssuePaths(refusalFixture.paths),
  );

  const answer = await readValidationAnswer(await validateWorkflow(base, token, { source }));
  expect(
    sortIssuePaths(answer.errors.map((issue) => issue.path)),
    refusalFixture.description,
  ).toEqual(sortIssuePaths(refusalFixture.paths));
  return answer.errors;
};

/** Takes the source through a save and through a check, and answers what the check said. */
const expectAccepted = async (
  controller: ArrangedController,
  description: string,
  source: string,
): Promise<ValidationAnswer> => {
  const { base, token } = controller;
  const response = await createWorkflow(base, token, { source });
  expect([200, 201], `${description}: ${await response.clone().text()}`).toContain(response.status);
  const answer = await readValidationAnswer(await validateWorkflow(base, token, { source }));
  expect(answer.errors, description).toEqual([]);
  return answer;
};

/** The issue at one path, which the caller expects to be there. */
const findIssueAt = (issues: ReadonlyArray<Issue>, path: ReadonlyArray<string>): Issue => {
  const found = issues.find((issue) => JSON.stringify(issue.path) === JSON.stringify(path));
  expect(found, `an issue at ${JSON.stringify(path)} in ${JSON.stringify(issues)}`).toBeDefined();
  return found!;
};

const disablePlugin = async (base: string, token: string, id: string): Promise<void> => {
  const response = await post(base, `/api/v1/plugins/${id}/disable`, {}, token);
  expect(response.status, await response.clone().text()).toBe(200);
};

/**
 * An action step that files a task, as YAML lines under `steps:`. Most
 * fixtures need steps that are valid in every way, so that the one broken
 * element is the only thing refused. Each extra line is written under the step.
 */
const buildTaskStep = (id: string, ...extraLines: ReadonlyArray<string>): string =>
  [
    `  - id: ${id}`,
    "    kind: action",
    "    action: task.create",
    "    params:",
    `      title: File the ${id} task`,
    "      description: Filed by a workflow.",
    ...extraLines.map((line) => `    ${line}`),
  ].join("\n");

/** The smallest workflow a controller accepts: one step that files a task. */
const FILE_TASK_SOURCE = `name: File a task
steps:
${buildTaskStep("file_task")}
`;

/* ------------------------------------------------------------------------ */
/* Fixtures for a source the parse refuses, before any check of meaning.     */
/* ------------------------------------------------------------------------ */

const PARSE_REFUSALS: ReadonlyArray<RefusalFixture> = [
  {
    description: "a YAML syntax error",
    build: () => `name: broken
steps:
  - id: file_task
    kind: action
    action: task.create
    params:
      title: "one" two
      description: body
`,
    paths: [[]],
  },
  {
    description: "a step kind that does not exist",
    build: () => `name: wrong kind
steps:
  - id: file_task
    kind: script
    action: task.create
`,
    paths: [["steps", "0", "kind"]],
  },
  {
    description: "two steps with one id",
    build: () => `name: two steps, one id
steps:
${buildTaskStep("file_task")}
${buildTaskStep("file_task")}
`,
    paths: [["steps", "1", "id"]],
  },
  {
    description: "a step id that is not snake_case",
    build: () => `name: kebab step
steps:
${buildTaskStep("open-pr")}
`,
    paths: [["steps", "0", "id"]],
  },
];

/* ------------------------------------------------------------------------ */
/* The graph.                                                                */
/* ------------------------------------------------------------------------ */

const EDGE_TO_NO_NODE: RefusalFixture = {
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

const EDGE_FROM_NO_NODE: RefusalFixture = {
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

const EDGE_INTO_SIGNAL: RefusalFixture = {
  description: "an edge into a signal trigger",
  build: () => `name: An edge into a signal
triggers:
  - id: task_changed
    kind: signal
    source:
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
 * The cycle is implement, review, fix and back to implement. Its edges are
 * written out of the order a walk from implement finds them, so the lowest
 * index among them (1) is not the first edge that walk takes (2).
 */
const UNCAPPED_CYCLE: RefusalFixture = {
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

const JOIN_ALL_IN_CYCLE: RefusalFixture = {
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

const EDGE_FROM_START_TRIGGER: RefusalFixture = {
  description: "an edge from a start trigger",
  build: () => `name: An edge from a start trigger
triggers:
  - id: on_create
    kind: start
    source:
      kind: task.created
steps:
${buildTaskStep("plan")}
edges:
  - from: on_create
    to: plan
`,
  paths: [["edges", "0", "from"]],
};

/** A step that polls, after a step that plans, with an edge from the poll back into itself. */
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

const UNCAPPED_SELF_LOOP: RefusalFixture = {
  description: "a step that leads into itself with no maxTraversals",
  build: () => buildSelfLoopSource(undefined),
  paths: [["edges", "1"]],
};

const GRAPH_REFUSALS: ReadonlyArray<RefusalFixture> = [
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
  it("refuses an edge from or to no node, an edge into a signal trigger, an uncapped cycle and join all in a cycle, each at its element", async () => {
    await withArrangedController(async (controller) => {
      for (const refusalFixture of GRAPH_REFUSALS)
        await expectRefusedAt(controller, refusalFixture);
      await expectNothingStored(controller.base, controller.token);
    });
  });

  it("names every step of a cycle that has no capped edge", async () => {
    await withArrangedController(async (controller) => {
      const [issue] = await expectRefusedAt(controller, UNCAPPED_CYCLE);
      for (const stepId of ["implement", "review", "fix"]) {
        expect(issue!.message).toContain(stepId);
      }
    });
  });

  it("accepts a cycle with one capped edge and join any on every step", async () => {
    await withArrangedController(async (controller) => {
      await expectAccepted(controller, "a capped cycle", CAPPED_CYCLE_SOURCE);
    });
  });

  it("refuses an edge from a start trigger, saying that a start trigger starts runs and cannot have edges", async () => {
    await withArrangedController(async (controller) => {
      const [issue] = await expectRefusedAt(controller, EDGE_FROM_START_TRIGGER);
      expect(issue!.message).toContain("start trigger");
      expect(issue!.message).toContain("cannot have edges");
    });
  });

  it("refuses a step that leads into itself with no maxTraversals, naming the step, and accepts it with one", async () => {
    await withArrangedController(async (controller) => {
      const [issue] = await expectRefusedAt(controller, UNCAPPED_SELF_LOOP);
      expect(issue!.message).toContain('"poll" leads into itself');

      await expectAccepted(controller, "a capped loop of one step", buildSelfLoopSource(5));
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Where a run begins.                                                       */
/* ------------------------------------------------------------------------ */

/**
 * The loop of the workflows spec: implement, open a pull request, review, and
 * back to implement, capped; a failed check sends the run back to implement;
 * the merge leads to the terminal step. Every step of the loop has an
 * incoming edge, so no step starts when the run starts. `task_done` is first,
 * so that implement is at index 1 and not at index 0.
 */
const buildReviewLoopSource = (agentId: string, implementEntryLine: string): string =>
  `name: Implement until merged
triggers:
  - id: checks_failed
    kind: signal
    source:
      kind: task.updated
    correlation:
      event: event.payload.taskId
      run: steps.open_pr.output.id
  - id: pr_merged
    kind: signal
    source:
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

const REVIEW_LOOP_WITHOUT_ENTRY: RefusalFixture = {
  description: "a loop that no step begins",
  build: ({ agentId }) => buildReviewLoopSource(agentId, ""),
  paths: [["steps", "1"]],
};

/** A step with no incoming edge begins the run; a step after a signal only waits. */
const SIGNAL_ONLY_STEP_SOURCE = `name: Close out when the task changes
triggers:
  - id: task_changed
    kind: signal
    source:
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
 * Plan leads into ship, and retry and wait form a capped loop that no edge
 * leads into from outside. Plan begins the run, so the loop is never reached.
 */
const UNREACHED_LOOP: RefusalFixture = {
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
 * An edge from the signal trigger leads into each step, and no step leads into
 * another. So no step begins a run, and no step is one that another step
 * leads into: the refusal is placed at the first step.
 */
const EVERY_STEP_AFTER_A_SIGNAL: RefusalFixture = {
  description: "a workflow whose every step waits for a signal",
  build: () => `name: Every step waits for a signal
triggers:
  - id: task_changed
    kind: signal
    source:
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
  it("refuses the review loop at implement, suggesting entry: true, and not at the step only a signal reaches", async () => {
    await withArrangedController(async (controller) => {
      const { base, token } = controller;
      const source = REVIEW_LOOP_WITHOUT_ENTRY.build(controller);

      const savedIssues = await readIssues(await createWorkflow(base, token, { source }));
      expect(findIssueAt(savedIssues, ["steps", "1"]).message).toContain("entry: true");
      // task_done is reached only from the pr_merged signal, and needs no entry.
      expect(savedIssues.map((issue) => issue.path)).not.toContainEqual(["steps", "0"]);

      const answer = await readValidationAnswer(await validateWorkflow(base, token, { source }));
      expect(answer.errors).toEqual(savedIssues);
      await expectNothingStored(base, token);
    });
  });

  it("accepts the review loop once implement says entry: true", async () => {
    await withArrangedController(async (controller) => {
      await expectAccepted(
        controller,
        "the loop with an entry step",
        buildReviewLoopSource(controller.agentId, "\n    entry: true"),
      );
    });
  });

  it("refuses each step of a loop that no path reaches while another step begins the run, suggesting entry: true", async () => {
    await withArrangedController(async (controller) => {
      const issues = await expectRefusedAt(controller, UNREACHED_LOOP);
      for (const issue of issues) expect(issue.message).toContain("entry: true");
    });
  });

  it("refuses a workflow whose every step waits for a signal at its first step, suggesting entry: true", async () => {
    await withArrangedController(async (controller) => {
      const [issue] = await expectRefusedAt(controller, EVERY_STEP_AFTER_A_SIGNAL);
      expect(issue!.message).toContain("entry: true");
    });
  });

  it("accepts a step reached only from a signal trigger, and a linear workflow, with no entry anywhere", async () => {
    await withArrangedController(async (controller) => {
      await expectAccepted(controller, "a step after a signal", SIGNAL_ONLY_STEP_SOURCE);
      await expectAccepted(controller, "a linear workflow", LINEAR_SOURCE);
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Expressions, each in the environment of its own site.                     */
/* ------------------------------------------------------------------------ */

/**
 * A valid expression at every site: a start trigger's filter and input
 * mapping; a signal trigger's filter, both sides of its correlation and an
 * output; a step condition; an edge condition; templates in a prompt and in a
 * string param, one of them the literal `{{`.
 */
const buildEverySiteSource = (agentId: string): string => `name: Every expression site
inputs:
  - name: pr_number
    schema:
      type: integer
    required: false
triggers:
  - id: on_create
    kind: start
    source:
      kind: task.created
      filter: 'event.payload.priority == "high"'
    inputs:
      pr_number: event.payload.number
  - id: task_changed
    kind: signal
    source:
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
 * The same sites, each reading a variable its site does not declare: `steps`
 * or `inputs` where only `event` is declared, and `event` where only `inputs`
 * and `steps` are.
 */
const WRONG_VARIABLES: RefusalFixture = {
  description: "expressions that read a variable their site does not declare",
  build: ({ agentId }) => `name: Expressions that read the wrong variables
inputs:
  - name: pr_number
    schema:
      type: integer
    required: false
triggers:
  - id: on_create
    kind: start
    source:
      kind: task.created
      filter: 'steps.file_task.output.id == "x"'
    inputs:
      pr_number: inputs.pr_number
  - id: task_changed
    kind: signal
    source:
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
    ["triggers", "0", "source", "filter"],
    ["triggers", "0", "inputs", "pr_number"],
    ["triggers", "1", "source", "filter"],
    ["triggers", "1", "correlation", "event"],
    ["triggers", "1", "correlation", "run"],
    ["triggers", "1", "outputs", "status"],
    ["steps", "0", "condition"],
    ["steps", "0", "params", "title"],
    ["steps", "1", "prompt"],
    ["edges", "0", "condition"],
  ],
};

const SYNTAX_ERRORS: RefusalFixture = {
  description: "expressions that are not CEL",
  build: ({ agentId }) => `name: Expressions that are not CEL
triggers:
  - id: on_create
    kind: start
    source:
      kind: task.created
      filter: 'event.payload.number >'
steps:
  - id: review
    kind: agent
    agent: ${agentId}
    prompt: "Review {{ inputs.pr_number + }}."
`,
  paths: [
    ["triggers", "0", "source", "filter"],
    ["steps", "0", "prompt"],
  ],
};

const UNCLOSED_TEMPLATES: RefusalFixture = {
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
 * of a type that is not bool. A value of another type never says yes.
 */
const CONDITIONS_THAT_ARE_NOT_BOOL: RefusalFixture = {
  description: "filters and conditions whose type is not bool",
  build: () => `name: Conditions that never say yes
triggers:
  - id: on_create
    kind: start
    source:
      kind: task.created
      filter: size(event.payload.labels)
  - id: task_changed
    kind: signal
    source:
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
    ["triggers", "0", "source", "filter"],
    ["triggers", "1", "source", "filter"],
    ["steps", "0", "condition"],
    ["edges", "0", "condition"],
  ],
};

const EXPRESSION_REFUSALS: ReadonlyArray<RefusalFixture> = [
  WRONG_VARIABLES,
  SYNTAX_ERRORS,
  UNCLOSED_TEMPLATES,
  CONDITIONS_THAT_ARE_NOT_BOOL,
];

describe("the expressions", () => {
  it("accepts a valid expression at every site, and the literal {{ in a template", async () => {
    await withArrangedController(async (controller) => {
      await expectAccepted(controller, "every site", buildEverySiteSource(controller.agentId));
    });
  });

  it("refuses at each site a variable that site does not declare: steps in a start filter, event in an edge condition, and the rest", async () => {
    await withArrangedController(async (controller) => {
      await expectRefusedAt(controller, WRONG_VARIABLES);
    });
  });

  it("refuses a filter or a condition whose type is not bool, naming the type and saying the place needs true or false", async () => {
    await withArrangedController(async (controller) => {
      const issues = await expectRefusedAt(controller, CONDITIONS_THAT_ARE_NOT_BOOL);
      expect(findIssueAt(issues, ["steps", "0", "condition"]).message).toContain("string");
      expect(findIssueAt(issues, ["edges", "0", "condition"]).message).toContain("int");
      for (const issue of issues) expect(issue.message).toContain("true or false");
    });
  });

  it("refuses a syntax error in a filter and in a template, and a template that is not closed, each at its path", async () => {
    await withArrangedController(async (controller) => {
      await expectRefusedAt(controller, SYNTAX_ERRORS);
      await expectRefusedAt(controller, UNCLOSED_TEMPLATES);
      await expectNothingStored(controller.base, controller.token);
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Actions and their params.                                                 */
/* ------------------------------------------------------------------------ */

const UNKNOWN_ACTION: RefusalFixture = {
  description: "an action nobody declared",
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

const MISSING_REQUIRED_PARAM: RefusalFixture = {
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

const UNKNOWN_PARAM: RefusalFixture = {
  description: "a param the action does not take",
  build: () => `name: A task with a colour
steps:
${buildTaskStep("file_task", "  colour: red")}
`,
  paths: [["steps", "0", "params", "colour"]],
};

const WRONG_TYPE_PARAM: RefusalFixture = {
  description: "a literal param of the wrong type",
  build: () => `name: Labels as a number
steps:
${buildTaskStep("file_task", "  labels: 42")}
`,
  paths: [["steps", "0", "params", "labels"]],
};

/**
 * Templates deep in a param's value: one reads a variable a run does not
 * have, and one is not closed. Each is refused at its own place.
 */
const NESTED_TEMPLATE_REFUSALS: RefusalFixture = {
  description: "templates deep in a param that read the wrong variable or are not closed",
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

/** An update that names the task and no field to change: it would change nothing. */
const UPDATE_WITHOUT_CHANGE: RefusalFixture = {
  description: "a task update that names no field to change",
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

/** A template under a key that a provenance entry does not declare. */
const TEMPLATE_UNDER_UNDECLARED_KEY: RefusalFixture = {
  description: "a template under a key that the input does not declare",
  build: () => `name: A template under no field
steps:
${buildTaskStep("file_task", "  provenance:", "    - eventId: 5", '      bogus: "{{ inputs.a }}"')}
`,
  paths: [["steps", "0", "params", "provenance", "0", "bogus"]],
};

/** A template in the field of a provenance entry that the core stamps. */
const TEMPLATE_IN_STAMPED_FIELD: RefusalFixture = {
  description: "a template in a field that the core stamps",
  build: () => `name: A template the core would overwrite
steps:
${buildTaskStep("file_task", "  provenance:", "    - eventId: 5", '      at: "{{ inputs.at }}"')}
`,
  paths: [["steps", "0", "params", "provenance", "0", "at"]],
};

const ACTION_REFUSALS: ReadonlyArray<RefusalFixture> = [
  UNKNOWN_ACTION,
  MISSING_REQUIRED_PARAM,
  UNKNOWN_PARAM,
  WRONG_TYPE_PARAM,
  NESTED_TEMPLATE_REFUSALS,
  UPDATE_WITHOUT_CHANGE,
  TEMPLATE_UNDER_UNDECLARED_KEY,
  TEMPLATE_IN_STAMPED_FIELD,
];

/**
 * Templates deep in a param's value: a list item, and a number field of a
 * provenance entry. What each one renders is known only when a run renders it.
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
 * An array field and a field of fixed words, each given a template. What a
 * template renders is known only when a run renders it, so its type cannot be
 * checked before.
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
  it("refuses an unknown action at its step and lists every action a step can name", async () => {
    await withArrangedController(async (controller) => {
      const [issue] = await expectRefusedAt(controller, UNKNOWN_ACTION);
      for (const actionId of [...BUILT_IN_ACTION_IDS, NOTE_APPEND_ACTION_ID]) {
        expect(issue!.message).toContain(actionId);
      }
    });
  });

  it("resolves task.create", async () => {
    await withArrangedController(async (controller) => {
      await expectAccepted(controller, "task.create", FILE_TASK_SOURCE);
    });
  });

  it("resolves a plugin's action by its qualified id while the plugin is enabled, and refuses it once the plugin is disabled", async () => {
    await withArrangedController(async (controller) => {
      await expectAccepted(controller, "the notes action", PLUGIN_ACTION_SOURCE);

      await disablePlugin(controller.base, controller.token, "notes");
      await expectRefusedAt(controller, {
        description: "the notes action with its plugin disabled",
        build: () => PLUGIN_ACTION_SOURCE,
        paths: [["steps", "0", "action"]],
      });
    });
  });

  it("refuses a missing required param, an unknown param and a literal of the wrong type, each at its path", async () => {
    await withArrangedController(async (controller) => {
      for (const refusalFixture of [MISSING_REQUIRED_PARAM, UNKNOWN_PARAM, WRONG_TYPE_PARAM]) {
        await expectRefusedAt(controller, refusalFixture);
      }
      await expectNothingStored(controller.base, controller.token);
    });
  });

  it("accepts a template string for a param of any type", async () => {
    await withArrangedController(async (controller) => {
      await expectAccepted(controller, "templates", TEMPLATES_FOR_ANY_TYPE_SOURCE);
    });
  });

  it("accepts a template deep in a param's value, such as a number field of a provenance entry", async () => {
    await withArrangedController(async (controller) => {
      await expectAccepted(controller, "nested templates", NESTED_TEMPLATES_SOURCE);
    });
  });

  it("refuses a template deep in a param's value that reads the wrong variable, or is not closed, at its own place", async () => {
    await withArrangedController(async (controller) => {
      const issues = await expectRefusedAt(controller, NESTED_TEMPLATE_REFUSALS);
      expect(
        findIssueAt(issues, ["steps", "0", "params", "provenance", "0", "eventId"]).message,
      ).toContain("event");
      expect(findIssueAt(issues, ["steps", "0", "params", "labels", "1"]).message).toContain(
        "no }} closes",
      );
    });
  });

  it("refuses a template under a key the input does not declare, and in a field the core stamps, each at its place", async () => {
    await withArrangedController(async (controller) => {
      const [undeclared] = await expectRefusedAt(controller, TEMPLATE_UNDER_UNDECLARED_KEY);
      expect(undeclared!.message).toContain("Remove the field");
      const [stamped] = await expectRefusedAt(controller, TEMPLATE_IN_STAMPED_FIELD);
      expect(stamped!.message).toContain("The core sets this field");
    });
  });

  it("refuses a task.update step that names no field to change, at its params, as the operation refuses such an update", async () => {
    await withArrangedController(async (controller) => {
      const [issue] = await expectRefusedAt(controller, UPDATE_WITHOUT_CHANGE);
      expect(issue!.message).toContain("at least one field to change");
    });
  });

  it("says why a param cannot be taken in one short sentence each, without repeating a long value or a full stop", async () => {
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
/* Agents and output schemas.                                                */
/* ------------------------------------------------------------------------ */

const UNKNOWN_AGENT: RefusalFixture = {
  description: "an agent step that names no Agent",
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
 * Two mistakes in two places: a keyword outside the subset on one property,
 * and an object without `additionalProperties: false` on the other.
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
 * An agent step at index 1 with this output schema. JSON is YAML, so the
 * schema is written into the source as the same object the lint reads.
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

/** The prefix of the path of every lint finding on the agent step above. */
const OUTPUT_SCHEMA_PATH = ["steps", "1", "outputSchema"];

describe("the agent steps", () => {
  it("refuses an agent step that names no existing Agent", async () => {
    await withArrangedController(async (controller) => {
      await expectRefusedAt(controller, UNKNOWN_AGENT);
    });
  });

  it("gives one issue under the output schema for each finding of the strict-subset lint", async () => {
    await withArrangedController(async ({ base, token, agentId }) => {
      const findings = lintOutputSchema(LINT_FAILING_OUTPUT_SCHEMA);
      // Two findings, so the count proves one issue per finding and not one per schema.
      expect(findings).toHaveLength(2);
      const source = buildOutputSchemaSource(agentId, LINT_FAILING_OUTPUT_SCHEMA);

      const response = await createWorkflow(base, token, { source });
      expect(response.status, await response.clone().text()).toBe(400);
      const refusal = await readRefusal(response);
      expect(refusal.code).toBe("validation");
      expect(refusal.issues).toHaveLength(findings.length);
      for (const path of refusal.issues) {
        expect(path.slice(0, OUTPUT_SCHEMA_PATH.length)).toEqual(OUTPUT_SCHEMA_PATH);
      }

      const answer = await readValidationAnswer(await validateWorkflow(base, token, { source }));
      expect(answer.errors.map((issue) => issue.path)).toEqual(refusal.issues);
    });
  });

  it("accepts an existing Agent with a clean output schema", async () => {
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

/** A workflow of one start trigger, written as the YAML lines under its `- id:` line. */
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
  "source:",
  "  kind: github.pr.labeled",
  "  connectionId: any",
);

const UNKNOWN_EVENT_KIND: RefusalFixture = {
  description: "an event kind nobody emits",
  build: () =>
    buildOneTriggerSource(
      "A kind nobody emits",
      "kind: start",
      "source:",
      "  kind: github.pr.labelled",
      "  connectionId: any",
    ),
  paths: [["triggers", "0", "source", "kind"]],
};

const PLUGIN_KIND_WITHOUT_CONNECTION: RefusalFixture = {
  description: "a plugin kind with no Connection selection",
  build: () =>
    buildOneTriggerSource(
      "Labels from no Connection",
      "kind: start",
      "source:",
      "  kind: github.pr.labeled",
    ),
  paths: [["triggers", "0", "source", "connectionId"]],
};

const CORE_KIND_WITH_CONNECTION: RefusalFixture = {
  description: "a core kind with a Connection selection",
  build: () =>
    buildOneTriggerSource(
      "Tasks from any Connection",
      "kind: start",
      "source:",
      "  kind: task.created",
      "  connectionId: any",
    ),
  paths: [["triggers", "0", "source", "connectionId"]],
};

const ABSENT_CONNECTION: RefusalFixture = {
  description: "a Connection that does not exist",
  build: () =>
    buildOneTriggerSource(
      "Labels from a missing Connection",
      "kind: start",
      "source:",
      "  kind: github.pr.labeled",
      `  connectionId: ${ABSENT_ID}`,
    ),
  paths: [["triggers", "0", "source", "connectionId"]],
};

const WRONG_TYPE_CONNECTION: RefusalFixture = {
  description: "a Connection of another type than the kind's event source",
  build: ({ mailConnectionId }) =>
    buildOneTriggerSource(
      "Labels from a mail Connection",
      "kind: start",
      "source:",
      "  kind: github.pr.labeled",
      `  connectionId: ${mailConnectionId}`,
    ),
  paths: [["triggers", "0", "source", "connectionId"]],
};

const CRON_WITHOUT_SCHEDULE: RefusalFixture = {
  description: "a cron trigger with no schedule",
  build: () =>
    buildOneTriggerSource("Ticks with no schedule", "kind: start", "source:", "  kind: cron.tick"),
  paths: [["triggers", "0", "schedule"]],
};

/** Two schedules no cron parser reads: words, and an hour past 23. */
const INVALID_SCHEDULES: RefusalFixture = {
  description: "cron schedules that are not valid",
  build: () => `name: Schedules no clock can keep
triggers:
  - id: in_words
    kind: start
    source:
      kind: cron.tick
    schedule: every morning
  - id: hour_out_of_range
    kind: start
    source:
      kind: cron.tick
    schedule: "0 25 * * *"
steps:
${buildTaskStep("file_task")}
`,
  paths: [
    ["triggers", "0", "schedule"],
    ["triggers", "1", "schedule"],
  ],
};

/** A schedule with a sixth field, which a cron parser reads as seconds. */
const SCHEDULE_WITH_SECONDS: RefusalFixture = {
  description: "a cron schedule with a field for seconds",
  build: () =>
    buildOneTriggerSource(
      "Ticks each second",
      "kind: start",
      "source:",
      "  kind: cron.tick",
      'schedule: "0 0 9 * * 1-5"',
    ),
  paths: [["triggers", "0", "schedule"]],
};

const INVALID_TIMEZONE: RefusalFixture = {
  description: "a timezone that does not exist",
  build: () =>
    buildOneTriggerSource(
      "Ticks in no timezone",
      "kind: start",
      "source:",
      "  kind: cron.tick",
      'schedule: "0 9 * * 1-5"',
      "timezone: Mars/Olympus_Mons",
    ),
  paths: [["triggers", "0", "timezone"]],
};

const SCHEDULE_ON_NON_CRON_KIND: RefusalFixture = {
  description: "a schedule on a kind that is not cron.tick",
  build: () =>
    buildOneTriggerSource(
      "A schedule on tasks",
      "kind: start",
      "source:",
      "  kind: task.created",
      'schedule: "0 9 * * *"',
    ),
  paths: [["triggers", "0", "schedule"]],
};

const UNDECLARED_INPUT_MAPPING: RefusalFixture = {
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
    source:
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
 * second does not. The signal trigger maps no input, and it starts no run.
 */
const UNMAPPED_REQUIRED_INPUT: RefusalFixture = {
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
    source:
      kind: github.pr.labeled
      connectionId: any
    inputs:
      pr_url: event.payload.subject.url
  - id: on_create
    kind: start
    source:
      kind: task.created
  - id: task_changed
    kind: signal
    source:
      kind: task.updated
    correlation:
      event: event.payload.taskId
      run: steps.file_task.output.id
steps:
${buildTaskStep("file_task", "terminal: true")}
`,
  paths: [["triggers", "1", "inputs"]],
};

/** A signal trigger that waits for a tick of the Scheduler, which never signals a live run. */
const SIGNAL_ON_CRON_TICK: RefusalFixture = {
  description: "a signal trigger on cron.tick",
  build: () => `name: Waits for a tick
triggers:
  - id: next_tick
    kind: signal
    source:
      kind: cron.tick
    correlation:
      event: event.id
      run: steps.file_task.output.id
steps:
${buildTaskStep("file_task", "terminal: true")}
`,
  paths: [["triggers", "0", "source", "kind"]],
};

const TRIGGER_REFUSALS: ReadonlyArray<RefusalFixture> = [
  UNKNOWN_EVENT_KIND,
  PLUGIN_KIND_WITHOUT_CONNECTION,
  CORE_KIND_WITH_CONNECTION,
  ABSENT_CONNECTION,
  WRONG_TYPE_CONNECTION,
  CRON_WITHOUT_SCHEDULE,
  INVALID_SCHEDULES,
  INVALID_TIMEZONE,
  SCHEDULE_ON_NON_CRON_KIND,
  UNDECLARED_INPUT_MAPPING,
  UNMAPPED_REQUIRED_INPUT,
];

/**
 * Every Connection selection a plugin kind takes, a trigger on each core kind,
 * and a required input with a default, which a trigger may leave unmapped.
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
    source:
      kind: github.pr.labeled
      connectionId: any
  - id: work_label
    kind: start
    source:
      kind: github.pr.labeled
      connectionId: ${githubConnectionId}
    inputs:
      pr_url: event.payload.subject.url
  - id: weekday_morning
    kind: start
    source:
      kind: cron.tick
    schedule: "0 9 * * 1-5"
    timezone: Europe/Amsterdam
  - id: on_run_completed
    kind: start
    source:
      kind: run.completed
  - id: on_run_failed
    kind: start
    source:
      kind: run.failed
  - id: on_run_cancelled
    kind: start
    source:
      kind: run.cancelled
  - id: on_task_created
    kind: start
    source:
      kind: task.created
  - id: on_task_updated
    kind: start
    source:
      kind: task.updated
steps:
${buildTaskStep("file_task")}
`;

describe("the trigger rules", () => {
  it("refuses each broken trigger at its path", async () => {
    await withArrangedController(async (controller) => {
      for (const refusalFixture of TRIGGER_REFUSALS)
        await expectRefusedAt(controller, refusalFixture);
      await expectNothingStored(controller.base, controller.token);
    });
  });

  it("refuses a schedule with six fields, saying that a schedule has five and none for seconds", async () => {
    await withArrangedController(async (controller) => {
      const [issue] = await expectRefusedAt(controller, SCHEDULE_WITH_SECONDS);
      expect(issue!.message).toContain("six fields");
      expect(issue!.message).toContain("seconds");
    });
  });

  it("names a few unmapped inputs in each message, so the answer stays small for many inputs and several start triggers", async () => {
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
          "    source:",
          "      kind: task.created",
        ]).flat(),
        "steps:",
        buildTaskStep("file_task"),
        "",
      ].join("\n");

      const saved = await createWorkflow(base, token, { source });
      expect(saved.status).toBe(400);
      const refusal = await readRefusal(saved);
      expect(refusal.issues).toHaveLength(5);
      // Each message names five inputs and the number of the others, where a
      // message that named each input would make the answer about 200 kB.
      expect(refusal.text.length).toBeLessThan(10_000);
      expect(refusal.text).toContain("and 995 more");

      const checked = await validateWorkflow(base, token, { source });
      expect((await checked.text()).length).toBeLessThan(10_000);
    });
  });

  it("refuses a signal trigger on cron.tick, saying why it could never fire", async () => {
    await withArrangedController(async (controller) => {
      const [issue] = await expectRefusedAt(controller, SIGNAL_ON_CRON_TICK);
      expect(issue!.message).toContain("never signals a live run");
    });
  });

  it("names the trigger and the input when a start trigger leaves a required input unmapped", async () => {
    await withArrangedController(async (controller) => {
      const [issue] = await expectRefusedAt(controller, UNMAPPED_REQUIRED_INPUT);
      expect(issue!.message).toContain("on_create");
      expect(issue!.message).toContain("pr_url");
    });
  });

  it("accepts any and a named Connection for a plugin kind, every core kind, and an unmapped required input with a default", async () => {
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

/** A workflow whose second input is a GitHub Connection with this default. */
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

const ABSENT_CONNECTION_DEFAULT: RefusalFixture = {
  description: "a Connection input whose default names no Connection",
  build: () => buildConnectionInputSource(ABSENT_ID),
  paths: [["inputs", "1", "default"]],
};

const WRONG_TYPE_CONNECTION_DEFAULT: RefusalFixture = {
  description: "a Connection input whose default is a Connection of another type",
  build: ({ mailConnectionId }) => buildConnectionInputSource(mailConnectionId),
  paths: [["inputs", "1", "default"]],
};

/** A Connection input of a type that no plugin registered: `github/gh` is a typo. */
const UNKNOWN_CONNECTION_TYPE: RefusalFixture = {
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

const INPUT_REFUSALS: ReadonlyArray<RefusalFixture> = [
  ABSENT_CONNECTION_DEFAULT,
  WRONG_TYPE_CONNECTION_DEFAULT,
];

describe("the inputs", () => {
  it("refuses a Connection input whose default names no Connection, or one of another type", async () => {
    await withArrangedController(async (controller) => {
      for (const refusalFixture of INPUT_REFUSALS)
        await expectRefusedAt(controller, refusalFixture);
      await expectNothingStored(controller.base, controller.token);
    });
  });

  it("refuses a Connection input whose type no plugin registered, listing the types", async () => {
    await withArrangedController(async (controller) => {
      const [issue] = await expectRefusedAt(controller, UNKNOWN_CONNECTION_TYPE);
      expect(issue!.message).toContain("github/github");
    });
  });

  it("refuses a Connection input whose type is of a disabled plugin, saying to enable the plugin", async () => {
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
      const [issue] = await expectRefusedAt(controller, {
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
/* Names an expression reads.                                                */
/* ------------------------------------------------------------------------ */

/**
 * An input and a signal output, each once in a spelling an expression can read
 * and once in one it cannot. The two readable spellings are in both fixtures.
 */
const buildNamedValuesSource = (inputName: string, outputName: string): string =>
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
    source:
      kind: task.created
  - id: pr_merged
    kind: signal
    source:
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

const NAMES_NO_EXPRESSION_READS: RefusalFixture = {
  description: "an input name and a signal output name that are not CEL identifiers",
  build: () => buildNamedValuesSource("pr-url", "pr-url"),
  paths: [
    ["inputs", "1", "name"],
    ["triggers", "1", "outputs", "pr-url"],
  ],
};

describe("the names an expression reads", () => {
  it("refuses an input name and a signal output name that an expression cannot read, saying why", async () => {
    await withArrangedController(async (controller) => {
      const issues = await expectRefusedAt(controller, NAMES_NO_EXPRESSION_READS);
      for (const issue of issues) expect(issue.message).toMatch(/expression/i);
    });
  });

  it("accepts prUrl and pr_url as an input name and as a signal output name", async () => {
    await withArrangedController(async (controller) => {
      await expectAccepted(
        controller,
        "readable names",
        buildNamedValuesSource("pr_url", "pr_url"),
      );
    });
  });
});

/* ------------------------------------------------------------------------ */
/* The one warning.                                                          */
/* ------------------------------------------------------------------------ */

/** A signal trigger and a step after it; `terminalLine` makes that step end the run. */
const buildSignalWorkflowSource = (terminalLine: string): string =>
  `name: Waits for the task to change
triggers:
  - id: task_changed
    kind: signal
    source:
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

/** What a save answers: the stored record, and the warnings of this save. */
interface SaveAnswer {
  readonly workflow: { readonly id: string };
  readonly warnings: ReadonlyArray<Issue>;
}

const readSaveAnswer = async (response: Response): Promise<SaveAnswer> => {
  expect([200, 201], await response.clone().text()).toContain(response.status);
  return (await response.json()) as SaveAnswer;
};

/** The one warning a run that only cancellation can end is given. */
const expectOnlyCancellationWarning = (warnings: ReadonlyArray<Issue>): void => {
  expect(warnings.map((warning) => warning.path)).toEqual([["steps"]]);
  expect(warnings[0]!.message).toMatch(/cancel/i);
};

describe("the warning about a run with no end", () => {
  it("saves a workflow with a signal trigger and no terminal step, and create, update and validate each give one warning", async () => {
    await withArrangedController(async ({ base, token }) => {
      const source = buildSignalWorkflowSource("");

      const created = await readSaveAnswer(await createWorkflow(base, token, { source }));
      expectOnlyCancellationWarning(created.warnings);

      const updated = await readSaveAnswer(
        await updateWorkflow(base, token, created.workflow.id, { source }),
      );
      expectOnlyCancellationWarning(updated.warnings);

      const checked = await readValidationAnswer(await validateWorkflow(base, token, { source }));
      expect(checked.errors).toEqual([]);
      expectOnlyCancellationWarning(checked.warnings);
    });
  });

  it("gives no warning for a workflow with no signal trigger, or with a terminal step", async () => {
    await withArrangedController(async ({ base, token }) => {
      for (const source of [FILE_TASK_SOURCE, buildSignalWorkflowSource("terminal: true")]) {
        const created = await readSaveAnswer(await createWorkflow(base, token, { source }));
        expect(created.warnings, source).toEqual([]);

        const updated = await readSaveAnswer(
          await updateWorkflow(base, token, created.workflow.id, { source }),
        );
        expect(updated.warnings, source).toEqual([]);

        const checked = await readValidationAnswer(await validateWorkflow(base, token, { source }));
        expect(checked, source).toEqual({ errors: [], warnings: [] });
      }
    });
  });
});

/* ------------------------------------------------------------------------ */
/* workflow.validate against workflow.create.                                */
/* ------------------------------------------------------------------------ */

/**
 * Every fixture in this file that the controller refuses. The lint fixture has
 * no exact paths here, because its paths follow the lint's own pointers; the
 * comparison below needs none.
 */
const EVERY_REFUSAL: ReadonlyArray<Pick<RefusalFixture, "description" | "build">> = [
  ...PARSE_REFUSALS,
  ...GRAPH_REFUSALS,
  REVIEW_LOOP_WITHOUT_ENTRY,
  ...EXPRESSION_REFUSALS,
  ...ACTION_REFUSALS,
  UNKNOWN_AGENT,
  {
    description: "an output schema the lint refuses",
    build: ({ agentId }) => buildOutputSchemaSource(agentId, LINT_FAILING_OUTPUT_SCHEMA),
  },
  ...TRIGGER_REFUSALS,
  ...INPUT_REFUSALS,
  NAMES_NO_EXPRESSION_READS,
  EDGE_FROM_START_TRIGGER,
  UNCAPPED_SELF_LOOP,
  UNREACHED_LOOP,
  SIGNAL_ON_CRON_TICK,
  UNKNOWN_CONNECTION_TYPE,
  EVERY_STEP_AFTER_A_SIGNAL,
  SCHEDULE_WITH_SECONDS,
];

/** A definition object that names an action nobody declared. */
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
  // The Workflows screen opens a new workflow on this text, so that the
  // author sees a graph and no problem before the first keystroke.
  it("finds no error and no warning in the text that a new workflow starts from", async () => {
    await withSetUpController(async ({ base, token }) => {
      expect(
        await readValidationAnswer(
          await validateWorkflow(base, token, { source: STARTER_WORKFLOW_SOURCE }),
        ),
      ).toEqual({ errors: [], warnings: [] });
    });
  });

  it("stores nothing, whatever it is sent", async () => {
    await withArrangedController(async (controller) => {
      const { base, token } = controller;
      // A valid source with a trigger, so a stored workflow or a stored
      // trigger row would each show in its listing.
      for (const source of [
        buildEveryTriggerSource(controller.githubConnectionId),
        ...EVERY_REFUSAL.map((refusalFixture) => refusalFixture.build(controller)),
      ]) {
        await readValidationAnswer(await validateWorkflow(base, token, { source }));
      }
      await expectNothingStored(base, token);
    });
  });

  it("answers, for every refusal fixture, errors equal to the issues create refuses with", async () => {
    await withArrangedController(async (controller) => {
      const { base, token } = controller;
      for (const refusalFixture of EVERY_REFUSAL) {
        const source = refusalFixture.build(controller);
        const answer = await readValidationAnswer(await validateWorkflow(base, token, { source }));

        const response = await createWorkflow(base, token, { source });
        expect(
          response.status,
          `${refusalFixture.description}: ${await response.clone().text()}`,
        ).toBe(400);
        expect(answer.errors, refusalFixture.description).not.toEqual([]);
        expect(answer.errors, refusalFixture.description).toEqual(await readIssues(response));
      }
      await expectNothingStored(base, token);
    });
  });

  it("checks a definition object as create does", async () => {
    await withArrangedController(async ({ base, token }) => {
      const answer = await readValidationAnswer(
        await validateWorkflow(base, token, { definition: UNKNOWN_ACTION_DEFINITION }),
      );
      expect(answer.errors.map((issue) => issue.path)).toEqual([["steps", "0", "action"]]);

      const response = await createWorkflow(base, token, {
        definition: UNKNOWN_ACTION_DEFINITION,
      });
      expect(answer.errors).toEqual(await readIssues(response));
    });
  });

  it("refuses a request that sends both a source and a definition, or neither", async () => {
    await withArrangedController(async ({ base, token }) => {
      for (const body of [
        { source: FILE_TASK_SOURCE, definition: UNKNOWN_ACTION_DEFINITION },
        {},
      ]) {
        const response = await validateWorkflow(base, token, body);
        expect(response.status, await response.clone().text()).toBe(400);
        expect((await readRefusal(response)).code).toBe("validation");
      }
    });
  });
});

/* ------------------------------------------------------------------------ */
/* The catalogs an editor reads its choices from.                            */
/* ------------------------------------------------------------------------ */

/** One action a step can name, as `workflowAction.query` answers it. */
interface WorkflowActionItem {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type?: unknown;
    readonly properties?: Record<string, unknown>;
    readonly required?: ReadonlyArray<string>;
  };
}

/** One event kind a trigger can name, as `eventKind.query` answers it. */
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
  it("answers the built-in actions and the actions of enabled plugins, each with its input as JSON Schema", async () => {
    await withArrangedController(async ({ base, token }) => {
      const actions = await listWorkflowActions(base, token);
      expect(actions.map((action) => action.id).sort()).toEqual(
        [...BUILT_IN_ACTION_IDS, NOTE_APPEND_ACTION_ID].sort(),
      );
      for (const action of actions) {
        expect(Object.keys(action).sort(), action.id).toEqual([
          "description",
          "displayName",
          "id",
          "inputSchema",
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

      // A built-in action takes its operation's own input.
      const taskCreate = findActionById(actions, "task.create");
      expect(Object.keys(taskCreate.inputSchema.properties ?? {})).toEqual(
        expect.arrayContaining(["title", "description"]),
      );
      expect(taskCreate.inputSchema.required).toEqual(
        expect.arrayContaining(["title", "description"]),
      );
    });
  });

  it("leaves out the actions of a plugin once it is disabled", async () => {
    await withArrangedController(async ({ base, token }) => {
      await disablePlugin(base, token, "notes");
      const actions = await listWorkflowActions(base, token);
      expect(actions.map((action) => action.id).sort()).toEqual(BUILT_IN_ACTION_IDS);
    });
  });
});

describe("eventKind.query", () => {
  it("answers the core kinds with no Connection and each plugin kind with one", async () => {
    await withArrangedController(async ({ base, token }) => {
      const kinds = await listEventKinds(base, token);
      expect(kinds.map((item) => item.kind).sort()).toEqual(
        [...CORE_EVENT_KINDS, "github.pr.labeled"].sort(),
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

  // A disabled plugin emits no events, so a trigger on one of its kinds could
  // never start a run. The kind is thus not offered and not accepted, as an
  // action of a disabled plugin is not.
  it("leaves out the kinds of a plugin once it is disabled, and refuses a trigger that names one", async () => {
    await withArrangedController(async (controller) => {
      const { base, token } = controller;
      await expectAccepted(controller, "the GitHub kind", GITHUB_LABEL_TRIGGER_SOURCE);

      await disablePlugin(base, token, "github");
      const kinds = await listEventKinds(base, token);
      expect(kinds.map((item) => item.kind).sort()).toEqual(CORE_EVENT_KINDS);
      await expectRefusedAt(controller, {
        description: "the GitHub kind with its plugin disabled",
        build: () => GITHUB_LABEL_TRIGGER_SOURCE,
        paths: [["triggers", "0", "source", "kind"]],
      });
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Who may check a workflow and read the catalogs.                           */
/* ------------------------------------------------------------------------ */

describe("what checking a workflow and reading the catalogs needs", () => {
  it("needs workflow.read for workflow.validate, workflowAction.query and eventKind.query", async () => {
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

      // The shipped worker profile holds no workflow grant at all.
      const workerSession = await agentOn(arranged, await profileNamed(arranged, "worker"));
      for (const [operation, read] of reads) {
        const response = await read(workerSession.token);
        const refusal = await readRefusal(response);
        expect(response.status, `${operation}: ${refusal.text}`).toBe(403);
        expect(refusal.code, operation).toBe("forbidden");
        expect(refusal.grant, operation).toBe("workflow.read");
      }

      // The shipped assistant profile holds workflow.read.
      const assistantSession = await agentOn(arranged, await profileNamed(arranged, "assistant"));
      for (const [operation, read] of reads) {
        const response = await read(assistantSession.token);
        expect(response.status, `${operation}: ${await response.clone().text()}`).toBe(200);
      }
    });
  });
});
