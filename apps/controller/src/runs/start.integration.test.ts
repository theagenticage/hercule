/**
 * Integration tests for starting a run of a stored workflow with `run.start`
 * (`POST /runs/start`), driven over HTTP against a real controller: what the new run records (its frozen
 * plan, resolved inputs and origin), and every request the controller refuses
 * before creating a run, including plans with elements runs cannot execute
 * yet.
 *
 * After each refusal, the tests count the rows of the runs table, because no
 * operation lists runs yet and a refused request must leave no run behind.
 *
 * No runner is connected, except in the one test that needs a session to
 * start the run.
 */
import { describe, expect, it, vi } from "vitest";
import { del, readErrorBody } from "../http/testing";
import {
  buildActionPlugin,
  buildForgePlugin,
  FORGE_CONNECTION_TYPE,
  FORGE_REVIEW_ACTION_ID,
  NOTE_APPEND_ACTION,
  NOTE_APPEND_ACTION_ID,
} from "../plugins/testing";
import {
  createProfile,
  readProfileNamed,
  spawnThreadUnder,
  WAIT_DEADLINE_MS,
  withAgentFleet,
} from "../sessions/testing";
import {
  ABSENT_ID,
  ACCEPTED_GITHUB_TOKEN,
  createAgent,
  createConnection,
  createWorkflowOrFail,
  disablePlugin,
  localMailPlugin,
  setConnectionStatus,
  updateWorkflow,
  withSetUpController,
} from "../workflows/testing";
import {
  buildCreateStep,
  countRuns,
  expectRefusedAt,
  expectStatus,
  findStepRecords,
  INPUTS_DEFINITION,
  listTasks,
  readRun,
  requestRun,
  requestStart,
  startRun,
  waitForRunToFinish,
} from "./testing";

/** Long enough for an agent fleet, a session, and a run that waits its full deadline. */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

/* ------------------------------------------------------------------------ */
/* Starting a run.                                                           */
/* ------------------------------------------------------------------------ */

describe("run.start of a stored workflow", () => {
  it("returns a run id, and the run holds the plan, the resolved inputs, the workflow id and a manual origin", async () => {
    await withSetUpController(async ({ base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, { definition: INPUTS_DEFINITION });

      const runId = await startRun(base, token, workflow.id, { inputs: { title: "Fix login" } });

      const run = await readRun(base, token, runId);
      expect(run.id).toBe(runId);
      expect(run.workflowId).toBe(workflow.id);
      expect(run.plan).toEqual(INPUTS_DEFINITION);
      // The default fills `priority`; `note` and `repo` have no value and no
      // default, so they are left out rather than set to null.
      expect(run.inputs).toEqual({ title: "Fix login", priority: "high" });
      expect(run.origin).toEqual({ kind: "manual", actor: "user" });

      await waitForRunToFinish(base, token, runId);
    });
  });

  it("starts a run of a workflow that has no inputs when the request leaves inputs out", async () => {
    await withSetUpController(async ({ base, token }) => {
      const definition = { name: "One task", steps: [buildCreateStep("create")] };
      const workflow = await createWorkflowOrFail(base, token, { definition });

      const runId = await startRun(base, token, workflow.id);

      const run = await waitForRunToFinish(base, token, runId);
      expect(run.inputs).toEqual({});
      expect(run.plan).toEqual(definition);
    });
  });

  it("keeps the run's plan when the workflow is edited, and when it is deleted", async () => {
    await withSetUpController(async ({ base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, { definition: INPUTS_DEFINITION });
      const runId = await startRun(base, token, workflow.id, { inputs: { title: "Fix login" } });

      const edited = await updateWorkflow(base, token, workflow.id, {
        definition: { name: "Renamed", steps: [buildCreateStep("other")] },
      });
      expect(edited.status, await edited.clone().text()).toBe(200);
      expect((await readRun(base, token, runId)).plan).toEqual(INPUTS_DEFINITION);

      // A workflow cannot be deleted while one of its runs is unfinished.
      await waitForRunToFinish(base, token, runId);
      const deleted = await del(base, `/api/v1/workflows/${workflow.id}`, token);
      expect(deleted.status, await deleted.clone().text()).toBe(200);

      const run = await readRun(base, token, runId);
      expect(run.plan).toEqual(INPUTS_DEFINITION);
      expect(run.workflowId).toBe(workflow.id);
    });
  });

  it("records an api origin with the session as actor when a session starts the run", async () => {
    await withAgentFleet(async (arranged) => {
      const base = arranged.harness.base;
      const definition = { name: "One task", steps: [buildCreateStep("create")] };
      const workflow = await createWorkflowOrFail(base, arranged.token, { definition });
      // The shipped assistant profile has the run.start and run.read grants.
      const agent = await spawnThreadUnder(arranged, await readProfileNamed(arranged, "assistant"));

      const runId = await startRun(base, agent.token, workflow.id);

      const run = await readRun(base, arranged.token, runId);
      expect(run.origin).toEqual({ kind: "api", actor: `session:${agent.session.id}` });
      await waitForRunToFinish(base, arranged.token, runId);
    });
  });

  it("runs a disabled workflow", async () => {
    await withSetUpController(async ({ base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        definition: { name: "One task", steps: [buildCreateStep("create")] },
      });
      const disabled = await updateWorkflow(base, token, workflow.id, { enabled: false });
      expect(disabled.status, await disabled.clone().text()).toBe(200);

      const run = await waitForRunToFinish(base, token, await startRun(base, token, workflow.id));
      expect(run.status).toBe("completed");
    });
  });

  it("refuses a request that names no workflow, or a stored one and a sent one, with validation", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        definition: { name: "One task", steps: [buildCreateStep("create")] },
      });
      for (const [description, body] of [
        ["no workflow", { inputs: {} }],
        [
          "a workflow id and a definition",
          {
            workflowId: workflow.id,
            definition: { name: "Other", steps: [buildCreateStep("create")] },
          },
        ],
        ["a workflow id and a source", { workflowId: workflow.id, source: "name: Other" }],
      ] as const) {
        const [issue] = await expectRefusedAt(
          harness,
          await requestStart(base, token, body),
          [[]],
          description,
        );
        expect(issue?.message, description).toBe(
          "Send exactly one of workflowId (a stored workflow), source (YAML text) or definition (an object).",
        );
      }
    });
  });

  it("refuses an unknown workflow with not_found", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const response = await requestRun(base, token, ABSENT_ID);
      const refusal = await readErrorBody(response);
      expect(response.status, refusal.text).toBe(404);
      expect(refusal.code).toBe("not_found");
      // The message names what was not found, which also tells this refusal
      // apart from the one for a route that does not exist.
      expect(refusal.message).toMatch(/workflow/i);
      expect(await countRuns(harness)).toBe(0);
    });
  });

  it("refuses unknown, missing and invalid input values, each at its path, and creates no run", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, { definition: INPUTS_DEFINITION });
      const cases: ReadonlyArray<{
        readonly description: string;
        readonly inputs: Record<string, unknown>;
        readonly paths: ReadonlyArray<ReadonlyArray<string>>;
      }> = [
        {
          description: "an input the workflow does not declare",
          inputs: { title: "Fix login", ghost: 1 },
          paths: [["inputs", "ghost"]],
        },
        { description: "a required input left out", inputs: {}, paths: [["inputs", "title"]] },
        {
          description: "a value that fails the input's JSON Schema",
          inputs: { title: "" },
          paths: [["inputs", "title"]],
        },
        {
          description: "a value of the wrong JSON type",
          inputs: { title: "Fix login", priority: 3 },
          paths: [["inputs", "priority"]],
        },
        {
          description: "every problem at once",
          inputs: { ghost: 1, priority: "someday" },
          paths: [
            ["inputs", "ghost"],
            ["inputs", "title"],
            ["inputs", "priority"],
          ],
        },
      ];
      for (const { description, inputs, paths } of cases) {
        const response = await requestRun(base, token, workflow.id, { inputs });
        await expectRefusedAt(harness, response, paths, description);
      }
    });
  });

  it("says in one sentence what is wrong with a value that fails its schema, and where inside it", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        definition: {
          name: "Schema messages",
          inputs: [
            { name: "title", schema: { type: "string", minLength: 1 }, required: true },
            {
              name: "limits",
              schema: { type: "object", properties: { hours: { type: "number" } } },
              required: false,
            },
          ],
          steps: [buildCreateStep("create")],
        },
      });

      const response = await requestRun(base, token, workflow.id, {
        inputs: { title: "", limits: { hours: "two" } },
      });
      const issues = await expectRefusedAt(harness, response, [
        ["inputs", "title"],
        ["inputs", "limits"],
      ]);

      const messageAt = (name: string): string =>
        issues.find((issue) => issue.path[1] === name)?.message ?? "";
      // The issue sits at the input already, so a violation of the value
      // itself names no location, and the sentence ends in one period.
      expect(messageAt("title")).toMatch(
        /^This value does not match the input's schema: [^#]*[^.]\.$/,
      );
      // A violation inside the value names the key it is at.
      expect(messageAt("limits")).toMatch(
        /^This value does not match the input's schema: #\/hours: .*[^.]\.$/,
      );
    });
  });

  it("refuses a connection input that names a missing, wrong-type or disabled Connection", async () => {
    await withSetUpController(
      async ({ harness, base, token }) => {
        const workflow = await createWorkflowOrFail(base, token, { definition: INPUTS_DEFINITION });
        const mailConnectionId = await createConnection(base, token, "mail/mail", {
          password: "an-app-password",
        });
        const disabledConnectionId = await createConnection(base, token, "github/github", {
          pat: ACCEPTED_GITHUB_TOKEN,
        });
        await setConnectionStatus(harness, disabledConnectionId, "disabled");

        for (const [description, repo] of [
          ["a Connection that does not exist", ABSENT_ID],
          ["a Connection of another type", mailConnectionId],
          ["a disabled Connection", disabledConnectionId],
        ] as const) {
          const response = await requestRun(base, token, workflow.id, {
            inputs: { title: "Fix login", repo },
          });
          await expectRefusedAt(harness, response, [["inputs", "repo"]], description);
        }

        // A working Connection of the right type is accepted, so the refusals
        // above were about the Connection and nothing else.
        const workingConnectionId = await createConnection(base, token, "github/github", {
          pat: ACCEPTED_GITHUB_TOKEN,
        });
        const runId = await startRun(base, token, workflow.id, {
          inputs: { title: "Fix login", repo: workingConnectionId },
        });
        expect((await readRun(base, token, runId)).inputs["repo"]).toBe(workingConnectionId);
        await waitForRunToFinish(base, token, runId);
      },
      [localMailPlugin],
    );
  });

  it("refuses a step whose connection param names a disabled Connection, and starts the run once it is enabled", async () => {
    await withSetUpController(
      async ({ harness, base, token }) => {
        const connectionId = await createConnection(base, token, FORGE_CONNECTION_TYPE, {
          token: "a-forge-token",
        });
        const workflow = await createWorkflowOrFail(base, token, {
          definition: {
            name: "Review a pull request",
            steps: [
              {
                id: "review",
                kind: "action",
                action: FORGE_REVIEW_ACTION_ID,
                params: { connection: connectionId, verdict: "approve" },
              },
            ],
          },
        });
        await setConnectionStatus(harness, connectionId, "disabled");
        const [issue] = await expectRefusedAt(harness, await requestRun(base, token, workflow.id), [
          ["steps", "0", "params", "connection"],
        ]);
        expect(issue!.message).toBe(
          `This Connection is disabled. Enable it, or name another Connection of type ${FORGE_CONNECTION_TYPE}.`,
        );

        // The same workflow starts once the Connection is enabled again, so
        // the refusal was about the Connection and nothing else.
        await setConnectionStatus(harness, connectionId, "connected");
        const runId = await startRun(base, token, workflow.id);
        await waitForRunToFinish(base, token, runId);
      },
      [buildForgePlugin().plugin],
    );
  });

  it("refuses a workflow whose definition no longer validates, and creates no run", async () => {
    await withSetUpController(
      async ({ harness, base, token }) => {
        const workflow = await createWorkflowOrFail(base, token, {
          definition: {
            name: "Append a note",
            steps: [
              { id: "note", kind: "action", action: NOTE_APPEND_ACTION_ID, params: { text: "hi" } },
            ],
          },
        });
        // The step's action disappears with its plugin, so the stored
        // definition names an action that no longer exists.
        await disablePlugin(base, token, "notes");

        const response = await requestRun(base, token, workflow.id);

        await expectRefusedAt(harness, response, [["steps", "0"]]);
      },
      [buildActionPlugin("notes", NOTE_APPEND_ACTION)],
    );
  });
});

/* ------------------------------------------------------------------------ */
/* What a run can execute.                                                   */
/* ------------------------------------------------------------------------ */

describe("the graphs a run accepts", () => {
  it("refuses each element runs cannot execute yet with one plain-worded issue at its path", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const agentId = await createAgent(base, token);
      const fixtures: ReadonlyArray<{
        readonly element: string;
        readonly definition: unknown;
        readonly path: ReadonlyArray<string>;
      }> = [
        {
          element: "an agent step",
          definition: {
            name: "Agent step",
            steps: [
              buildCreateStep("create"),
              { id: "review", kind: "agent", agent: agentId, prompt: "Review the task." },
            ],
            edges: [{ from: "create", to: "review" }],
          },
          path: ["steps", "1"],
        },
        {
          element: "a signal trigger",
          definition: {
            name: "Signal trigger",
            triggers: [
              {
                id: "task_changed",
                kind: "signal",
                on: { kind: "task.updated" },
                correlation: { event: "event.payload.taskId", run: "steps.create.output.id" },
              },
            ],
            steps: [buildCreateStep("create"), buildCreateStep("follow_up")],
            edges: [{ from: "task_changed", to: "follow_up" }],
          },
          path: ["triggers", "0"],
        },
      ];

      for (const { element, definition, path } of fixtures) {
        const workflow = await createWorkflowOrFail(base, token, { definition });
        const response = await requestRun(base, token, workflow.id);
        const issues = await expectRefusedAt(harness, response, [path], element);
        // A sentence for a person, not a schema library's dump.
        expect(issues[0]!.message, element).toMatch(/^[A-Z][^{}]*\.$/s);
      }
    });
  });

  it("reports one issue per unsupported element when a plan has several", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const agentId = await createAgent(base, token);
      const workflow = await createWorkflowOrFail(base, token, {
        definition: {
          name: "Two unsupported elements",
          triggers: [
            {
              id: "task_changed",
              kind: "signal",
              on: { kind: "task.updated" },
              correlation: { event: "event.payload.taskId", run: "steps.first.output.id" },
            },
          ],
          steps: [
            buildCreateStep("first"),
            { id: "review", kind: "agent", agent: agentId, prompt: "Review the task." },
            buildCreateStep("follow_up"),
          ],
          edges: [
            { from: "first", to: "review" },
            { from: "task_changed", to: "follow_up" },
          ],
        },
      });

      const response = await requestRun(base, token, workflow.id);

      await expectRefusedAt(harness, response, [
        ["triggers", "0"],
        ["steps", "1"],
      ]);
    });
  });

  it("runs each routing element to completion: conditions, join, maxTraversals, several incoming edges, an entry step an edge leads into and terminal", async () => {
    await withSetUpController(async ({ base, token }) => {
      const fixtures: ReadonlyArray<{
        readonly element: string;
        readonly definition: unknown;
        readonly records: ReadonlyArray<readonly [string, number, string]>;
      }> = [
        {
          element: "an edge condition",
          definition: {
            name: "Edge condition",
            steps: [buildCreateStep("first"), buildCreateStep("second")],
            edges: [{ from: "first", to: "second", condition: "true" }],
          },
          records: [
            ["first", 1, "completed"],
            ["second", 1, "completed"],
          ],
        },
        {
          element: "a step condition",
          definition: {
            name: "Step condition",
            steps: [buildCreateStep("first", { condition: "true" })],
          },
          records: [["first", 1, "completed"]],
        },
        {
          element: "join: any",
          definition: {
            name: "Join any",
            steps: [buildCreateStep("first"), buildCreateStep("second", { join: "any" })],
            edges: [{ from: "first", to: "second" }],
          },
          records: [
            ["first", 1, "completed"],
            ["second", 1, "completed"],
          ],
        },
        {
          element: "join: all",
          definition: {
            name: "Join all",
            steps: [
              buildCreateStep("left"),
              buildCreateStep("right"),
              buildCreateStep("merge", { join: "all" }),
            ],
            edges: [
              { from: "left", to: "merge" },
              { from: "right", to: "merge" },
            ],
          },
          records: [
            ["left", 1, "completed"],
            ["merge", 1, "completed"],
            ["right", 1, "completed"],
          ],
        },
        {
          element: "maxTraversals",
          definition: {
            name: "Max traversals",
            steps: [buildCreateStep("first"), buildCreateStep("second")],
            edges: [{ from: "first", to: "second", maxTraversals: 2 }],
          },
          records: [
            ["first", 1, "completed"],
            ["second", 1, "completed"],
          ],
        },
        {
          element: "a step with two incoming edges",
          definition: {
            name: "Two incoming edges",
            steps: [buildCreateStep("left"), buildCreateStep("right"), buildCreateStep("merge")],
            edges: [
              { from: "left", to: "merge" },
              { from: "right", to: "merge" },
            ],
          },
          records: [
            ["left", 1, "completed"],
            ["merge", 1, "completed"],
            ["merge", 2, "completed"],
            ["right", 1, "completed"],
          ],
        },
        {
          element: "entry: true on a step an edge leads into",
          definition: {
            name: "Entry with an incoming edge",
            steps: [buildCreateStep("first"), buildCreateStep("second", { entry: true })],
            edges: [{ from: "first", to: "second" }],
          },
          // `second` starts with the run, and runs again when the edge fires.
          records: [
            ["first", 1, "completed"],
            ["second", 1, "completed"],
            ["second", 2, "completed"],
          ],
        },
        {
          element: "terminal",
          definition: {
            name: "Terminal",
            steps: [buildCreateStep("first", { terminal: true })],
          },
          records: [["first", 1, "completed"]],
        },
      ];

      for (const { element, definition, records } of fixtures) {
        const workflow = await createWorkflowOrFail(base, token, { definition });
        const run = await waitForRunToFinish(base, token, await startRun(base, token, workflow.id));
        expect(run.status, `${element}: ${JSON.stringify(run)}`).toBe("completed");
        expect(
          run.steps.map((record) => [record.stepId, record.iteration, record.status]).sort(),
          element,
        ).toEqual(records);
      }
    });
  });

  it("refuses two edges with the same from and to, and entry: true with join: all, each with one plain-worded issue at its path", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const fixtures: ReadonlyArray<{
        readonly element: string;
        readonly definition: unknown;
        readonly path: ReadonlyArray<string>;
      }> = [
        {
          element: "two edges with the same from and to",
          definition: {
            name: "Duplicate edge",
            steps: [buildCreateStep("count"), buildCreateStep("file")],
            edges: [
              { from: "count", to: "file" },
              { from: "count", to: "file", condition: "true" },
            ],
          },
          path: ["edges", "1"],
        },
        {
          element: "entry: true with join: all",
          definition: {
            name: "Entry and join all",
            steps: [
              buildCreateStep("left"),
              buildCreateStep("merge", { entry: true, join: "all" }),
            ],
            edges: [{ from: "left", to: "merge" }],
          },
          path: ["steps", "1"],
        },
      ];

      // A save refuses both shapes, so each plan is sent with the request.
      for (const { element, definition, path } of fixtures) {
        const response = await requestStart(base, token, { definition });
        const issues = await expectRefusedAt(harness, response, [path], element);
        expect(issues[0]!.message, element).toMatch(/^[A-Z][^{}]*\.$/s);
      }
    });
  });

  it("runs action steps with fan-out, several entry steps, a start trigger and a workspace policy", async () => {
    await withSetUpController(async ({ base, token }) => {
      const definition = {
        name: "Every accepted shape",
        // A start trigger is frozen into the plan and never fires in a run.
        triggers: [{ id: "weekdays", kind: "start", on: { schedule: "0 9 * * 1-5" } }],
        steps: [
          buildCreateStep("root"),
          buildCreateStep("left"),
          buildCreateStep("right"),
          buildCreateStep("alone"),
        ],
        // `root` fans out to `left` and `right`; `alone` is a second entry step.
        edges: [
          { from: "root", to: "left" },
          { from: "root", to: "right" },
        ],
        workspace: { kind: "ephemeral", checkouts: [] },
      };
      const workflow = await createWorkflowOrFail(base, token, { definition });

      const run = await waitForRunToFinish(base, token, await startRun(base, token, workflow.id));

      expect(run.status).toBe("completed");
      expect(run.plan).toEqual(definition);
      expect(
        run.steps.map((record) => [record.stepId, record.iteration, record.status]).sort(),
      ).toEqual([
        ["alone", 1, "completed"],
        ["left", 1, "completed"],
        ["right", 1, "completed"],
        ["root", 1, "completed"],
      ]);
      expect((await listTasks(base, token)).map((task) => task.title).sort()).toEqual([
        "File the alone task",
        "File the left task",
        "File the right task",
        "File the root task",
      ]);
    });
  });
});

/* ------------------------------------------------------------------------ */
/* The connection.use grant.                                                 */
/* ------------------------------------------------------------------------ */

describe("run.start of a workflow that acts through a Connection", () => {
  /** The message of the refusal of a sent workflow, for a caller without the connection.use grant. */
  const SENT_WORKFLOW_REFUSAL =
    "This run's definition has a step that acts through a Connection, or that may give a Connection to a run it starts, and choosing that Connection needs the connection.use grant, which this session lacks. Start a stored workflow and leave its Connection inputs to their defaults, or ask the user to grant connection.use.";

  /** The message of the refusal of a value for the input `account`, for a caller without the connection.use grant. */
  const ACCOUNT_INPUT_REFUSAL =
    "The input account chooses the Connection a step acts through, or one a step gives to a run it starts, and giving it a value needs the connection.use grant, which this session lacks. A run that leaves the input to its default needs no grant. Ask the user to start the run, or to grant connection.use.";

  /**
   * Builds a workflow with one review step. Its `connection` param is
   * `connection`, and it declares an optional Connection input `account` of
   * the forge's type, which a template can read.
   */
  const buildReviewDefinitionWithAccountInput = (connection: string) => ({
    name: "Review a pull request",
    inputs: [{ name: "account", connection: { type: FORGE_CONNECTION_TYPE }, required: false }],
    steps: [
      {
        id: "review",
        kind: "action",
        action: FORGE_REVIEW_ACTION_ID,
        params: { connection, verdict: "approve" },
      },
    ],
  });

  it("refuses an assistant session that sends the workflow, whether the step names the Connection by its id or through a template", async () => {
    await withAgentFleet(
      async (arranged) => {
        const { harness, token } = arranged;
        const base = harness.base;
        const connectionId = await createConnection(base, token, FORGE_CONNECTION_TYPE, {
          token: "a-forge-token",
        });
        // The shipped assistant profile holds run.start but not connection.use.
        const agent = await spawnThreadUnder(
          arranged,
          await readProfileNamed(arranged, "assistant"),
        );

        for (const connection of [connectionId, "{{ inputs.account }}"]) {
          const response = await requestStart(base, agent.token, {
            definition: buildReviewDefinitionWithAccountInput(connection),
            inputs: { account: connectionId },
          });

          const refusal = await readErrorBody(response);
          expect(response.status, refusal.text).toBe(403);
          expect(refusal).toMatchObject({
            code: "forbidden",
            grant: "connection.use",
            message: SENT_WORKFLOW_REFUSAL,
          });
        }
        expect(await countRuns(harness)).toBe(0);
      },
      { plugins: [buildForgePlugin().plugin] },
    );
  });

  it("refuses an assistant session that gives a value for a stored workflow's Connection input, and starts the run when the Connection was chosen when the workflow was saved", async () => {
    await withAgentFleet(
      async (arranged) => {
        const { harness, token } = arranged;
        const base = harness.base;
        const connectionId = await createConnection(base, token, FORGE_CONNECTION_TYPE, {
          token: "a-forge-token",
        });
        const agent = await spawnThreadUnder(
          arranged,
          await readProfileNamed(arranged, "assistant"),
        );
        const fromInput = buildReviewDefinitionWithAccountInput("{{ inputs.account }}");
        const filled = await createWorkflowOrFail(base, token, { definition: fromInput });

        const response = await requestStart(base, agent.token, {
          workflowId: filled.id,
          inputs: { account: connectionId },
        });
        const refusal = await readErrorBody(response);
        expect(response.status, refusal.text).toBe(403);
        expect(refusal).toMatchObject({
          code: "forbidden",
          grant: "connection.use",
          message: ACCOUNT_INPUT_REFUSAL,
        });
        expect(await countRuns(harness)).toBe(0);

        // The user chose the Connection when saving: as the input's default,
        // or as the step's literal id.
        const defaulted = await createWorkflowOrFail(base, token, {
          definition: {
            ...fromInput,
            inputs: [
              {
                name: "account",
                connection: { type: FORGE_CONNECTION_TYPE },
                required: false,
                default: connectionId,
              },
            ],
          },
        });
        const literal = await createWorkflowOrFail(base, token, {
          definition: buildReviewDefinitionWithAccountInput(connectionId),
        });
        for (const workflow of [defaulted, literal]) {
          const runId = await startRun(base, agent.token, workflow.id);
          expect((await waitForRunToFinish(base, token, runId)).status).toBe("completed");
        }
      },
      { plugins: [buildForgePlugin().plugin] },
    );
  });

  it("starts the run for the user, and for a session whose profile holds connection.use, when the caller sends the workflow or fills in its Connection input", async () => {
    await withAgentFleet(
      async (arranged) => {
        const { harness, token } = arranged;
        const base = harness.base;
        const connectionId = await createConnection(base, token, FORGE_CONNECTION_TYPE, {
          token: "a-forge-token",
        });
        const profile = await createProfile(arranged, "Acts through Connections", [
          "run.start",
          "run.read",
          "connection.use",
        ]);
        const agent = await spawnThreadUnder(arranged, profile);
        const workflow = await createWorkflowOrFail(base, token, {
          definition: buildReviewDefinitionWithAccountInput("{{ inputs.account }}"),
        });

        for (const caller of [token, agent.token]) {
          const response = await requestStart(base, caller, {
            definition: buildReviewDefinitionWithAccountInput(connectionId),
          });
          expect(response.status, await response.clone().text()).toBe(200);
          const { runId } = (await response.json()) as { runId: string };
          expect((await waitForRunToFinish(base, token, runId)).status).toBe("completed");

          const storedRunId = await startRun(base, caller, workflow.id, {
            inputs: { account: connectionId },
          });
          expect((await waitForRunToFinish(base, token, storedRunId)).status).toBe("completed");
        }
      },
      { plugins: [buildForgePlugin().plugin] },
    );
  });
});

describe("run.start of a workflow whose run.start step gives a Connection to the run it starts", () => {
  /** The message of the refusal of a sent workflow, for a caller without the connection.use grant. */
  const SENT_WORKFLOW_REFUSAL =
    "This run's definition has a step that acts through a Connection, or that may give a Connection to a run it starts, and choosing that Connection needs the connection.use grant, which this session lacks. Start a stored workflow and leave its Connection inputs to their defaults, or ask the user to grant connection.use.";

  /** The message of the refusal of a value for the input `acc`, for a caller without the connection.use grant. */
  const ACC_INPUT_REFUSAL =
    "The input acc chooses the Connection a step acts through, or one a step gives to a run it starts, and giving it a value needs the connection.use grant, which this session lacks. A run that leaves the input to its default needs no grant. Ask the user to start the run, or to grant connection.use.";

  /**
   * Builds a workflow with one step that starts the workflow `targetId` and
   * gives `account` to its input `account`. It declares an optional
   * Connection input `acc` of the forge's type, which `account` can read.
   */
  const buildWrapperDefinition = (targetId: string, account: string) => ({
    name: "Start a review",
    inputs: [{ name: "acc", connection: { type: FORGE_CONNECTION_TYPE }, required: false }],
    steps: [
      {
        id: "start",
        kind: "action",
        action: "run.start",
        params: { workflowId: targetId, inputs: { account } },
      },
    ],
  });

  /** Saves, as the user, a workflow whose review step acts through its Connection input `account`. */
  const createReviewTarget = (base: string, token: string) =>
    createWorkflowOrFail(base, token, {
      definition: {
        name: "Review a pull request",
        inputs: [{ name: "account", connection: { type: FORGE_CONNECTION_TYPE }, required: true }],
        steps: [
          {
            id: "review",
            kind: "action",
            action: FORGE_REVIEW_ACTION_ID,
            params: { connection: "{{ inputs.account }}", verdict: "approve" },
          },
        ],
      },
    });

  it("refuses an assistant session that sends the wrapper, and no run starts", async () => {
    const forge = buildForgePlugin();
    await withAgentFleet(
      async (arranged) => {
        const { harness, token } = arranged;
        const base = harness.base;
        const connectionId = await createConnection(base, token, FORGE_CONNECTION_TYPE, {
          token: "a-forge-token",
        });
        const target = await createReviewTarget(base, token);
        // The shipped assistant profile holds run.start but not connection.use.
        const agent = await spawnThreadUnder(
          arranged,
          await readProfileNamed(arranged, "assistant"),
        );

        const response = await requestStart(base, agent.token, {
          definition: buildWrapperDefinition(target.id, connectionId),
        });

        const refusal = await readErrorBody(response);
        expect(response.status, refusal.text).toBe(403);
        expect(refusal).toMatchObject({
          code: "forbidden",
          grant: "connection.use",
          message: SENT_WORKFLOW_REFUSAL,
        });
        expect(await countRuns(harness)).toBe(0);
        expect(forge.contexts).toHaveLength(0);
      },
      { plugins: [forge.plugin] },
    );
  });

  it("refuses an assistant session that gives a stored wrapper the Connection it passes on", async () => {
    await withAgentFleet(
      async (arranged) => {
        const { harness, token } = arranged;
        const base = harness.base;
        const connectionId = await createConnection(base, token, FORGE_CONNECTION_TYPE, {
          token: "a-forge-token",
        });
        const target = await createReviewTarget(base, token);
        const wrapper = await createWorkflowOrFail(base, token, {
          definition: buildWrapperDefinition(target.id, "{{ inputs.acc }}"),
        });
        const agent = await spawnThreadUnder(
          arranged,
          await readProfileNamed(arranged, "assistant"),
        );

        const response = await requestStart(base, agent.token, {
          workflowId: wrapper.id,
          inputs: { acc: connectionId },
        });

        const refusal = await readErrorBody(response);
        expect(response.status, refusal.text).toBe(403);
        expect(refusal).toMatchObject({
          code: "forbidden",
          grant: "connection.use",
          message: ACC_INPUT_REFUSAL,
        });
        expect(await countRuns(harness)).toBe(0);
      },
      { plugins: [buildForgePlugin().plugin] },
    );
  });

  it("starts the wrapper for the user, and for a session whose profile holds connection.use, and the child acts through the Connection", async () => {
    const forge = buildForgePlugin();
    await withAgentFleet(
      async (arranged) => {
        const { harness, token } = arranged;
        const base = harness.base;
        const connectionId = await createConnection(base, token, FORGE_CONNECTION_TYPE, {
          token: "a-forge-token",
        });
        const target = await createReviewTarget(base, token);
        const profile = await createProfile(arranged, "Acts through Connections", [
          "run.start",
          "run.read",
          "connection.use",
        ]);
        const agent = await spawnThreadUnder(arranged, profile);

        for (const caller of [token, agent.token]) {
          const response = await requestStart(base, caller, {
            definition: buildWrapperDefinition(target.id, connectionId),
          });
          expect(response.status, await response.clone().text()).toBe(200);
          const { runId } = (await response.json()) as { runId: string };
          const wrapperRun = await waitForRunToFinish(base, token, runId);
          expect(wrapperRun.status, JSON.stringify(wrapperRun)).toBe("completed");
          const output = expectStatus(findStepRecords(wrapperRun, "start")[0], "completed")
            .output as { readonly runId: string };
          expect((await waitForRunToFinish(base, token, output.runId)).status).toBe("completed");
        }
        expect(forge.contexts).toHaveLength(2);
      },
      { plugins: [forge.plugin] },
    );
  });
});
