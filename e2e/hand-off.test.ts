/**
 * Tests handing a signal to a workflow through the shipped program (spec 11,
 * `signal.handOff`; ADR 0046): `hercule signal hand-off` as the user, against
 * a real controller, with every check going through the CLI's argv and
 * `--json` output.
 *
 * - The handoff creates a Task in progress with a handoff entry, starts the
 *   run on that Task, and resolves the signal with the run's id.
 * - A run started with `hercule run start` makes no Task.
 *
 * No agent runs: the workflows are made of the built-in `wait` action, so a
 * run needs no runner and no provider. The refusal of a session's token needs
 * a session, which only a scripted runner can host without an agent, so it is
 * tested in `e2e/desktop/tracking.test.ts`, whose program can import the
 * fleet.
 *
 * Continuing the Task of a plugin signal's thread is not tested here: no
 * plugin in the test binary can emit a signal with a thread. The controller's
 * integration test (`apps/controller/src/signals/handoffs.integration.test.ts`)
 * covers it.
 *
 * The suite is in vitest's `binary` project, so `pnpm test:binary` runs it and
 * `pnpm test` does not. It runs the release binary if one has been built, and
 * the dispatcher's source otherwise. This suite tests the controller and the
 * CLI, not the packaging, so both give the same result.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Run, Signal, Task } from "../packages/contract/src/index";
import {
  PASSWORD,
  USERNAME,
  completeSetup,
  runCli,
  startController,
  type Controller,
  type Ran,
} from "../scripts/controller-process";
import {
  assertSucceeded,
  createTemporaryHome,
  findReleaseBinary,
  parseJsonOutputOrFail,
  type Page,
  type TemporaryHome,
} from "./harness";

let state: TemporaryHome;
const binary = findReleaseBinary();
let controller: Controller;

/** Runs the CLI as the user who set the controller up. */
const runAsUser = (args: ReadonlyArray<string>, stdin?: string): Promise<Ran> =>
  runCli(args, { home: state.home, binary, stdin });

/** Runs the CLI as the user and returns the parsed `--json` output of a command that must succeed. */
const readAsUser = <A>(args: ReadonlyArray<string>, stdin?: string): Promise<A> =>
  runAsUser([...args, "--json"], stdin).then((ran) => parseJsonOutputOrFail<A>(ran));

/**
 * Returns the source of a workflow with one signal input that takes an FYI
 * and one `wait` step. The wait is the shortest the action allows, so the
 * run ends by itself.
 */
const buildHandOffSource = (name: string): string =>
  [
    `name: ${name}`,
    "inputs:",
    "  - name: signal",
    "    signal:",
    "      kinds: [fyi]",
    "    required: true",
    "steps:",
    "  - id: pause",
    "    kind: action",
    "    action: wait",
    "    params:",
    "      seconds: 1",
    "",
  ].join("\n");

/**
 * Creates a workflow from `source`, enables it, and returns its id. A signal
 * offers Hand to an agent only for an enabled workflow.
 */
const createWorkflow = async (source: string): Promise<string> => {
  const { workflow } = await readAsUser<{ readonly workflow: { readonly id: string } }>(
    ["workflow", "create"],
    source,
  );
  assertSucceeded(await runAsUser(["workflow", "update", workflow.id, "--enabled", "true"]));
  return workflow.id;
};

/** Raises an FYI signal titled `title` and returns its id. Create the workflows first: a signal is raised with the Hand to answers that exist then. */
const raiseSignal = async (title: string): Promise<string> =>
  (
    await readAsUser<{ readonly signalId: string }>([
      "signal",
      "raise",
      "--kind",
      "fyi",
      "--title",
      title,
      "--reason",
      "Raised by a test",
      "--event-id",
      "1",
    ])
  ).signalId;

const readSignal = (signalId: string): Promise<Signal> =>
  readAsUser<Signal>(["signal", "read", signalId]);

const readRun = (runId: string): Promise<Run> => readAsUser<Run>(["run", "read", runId]);

/** Lists every Task that carries a handoff entry. */
const listHandedOffTasks = async (): Promise<ReadonlyArray<Task>> =>
  (await readAsUser<Page<Task>>(["task", "list", "--handed-off", "true"])).items;

/** The id of the workflow every handoff below hands to. */
let workflowId: string;
const WORKFLOW_NAME = "Finish quickly";

beforeAll(async () => {
  state = createTemporaryHome();
  controller = await startController({ home: state.home, binary });
  const completed = await completeSetup({ home: state.home, url: controller.url, binary });
  expect(completed.code, `${completed.stdout}\n${completed.stderr}`).toBe(0);
  const login = await runAsUser(
    ["login", controller.url, "--username", USERNAME, "--password-stdin", "--name", "e2e-hand-off"],
    PASSWORD,
  );
  expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);
  workflowId = await createWorkflow(buildHandOffSource(WORKFLOW_NAME));
}, 90_000);

afterAll(async () => {
  await controller?.stop().catch(() => -1);
  state?.remove();
});

describe("handing a signal to a workflow", () => {
  it("creates a Task in progress with a handoff entry, starts the run on it, and resolves the signal with the run's id", async () => {
    const signalId = await raiseSignal("Retry failed webhooks");

    const resolved = await readAsUser<Signal>([
      "signal",
      "hand-off",
      signalId,
      "--workflow",
      workflowId,
    ]);

    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution).toMatchObject({
      kind: "decided",
      outcome: `Handed to ${WORKFLOW_NAME}`,
      actor: "user",
    });
    const runId = resolved.resolution!.runId!;
    const tasks = (await listHandedOffTasks()).filter(
      (task) => task.title === "Retry failed webhooks",
    );
    expect(tasks).toHaveLength(1);
    const [task] = tasks;
    expect(task).toMatchObject({ status: "in-progress", priority: "normal" });
    expect(task!.provenance).toEqual([
      { signalId, runId, at: expect.any(String) as unknown, actor: "user" },
    ]);
    expect(await readRun(runId)).toMatchObject({ taskId: task!.id });
    expect(await readSignal(signalId)).toMatchObject({ status: "resolved" });
  }, 60_000);

  it("makes no Task for a run started with run start", async () => {
    const tasksBefore = (await listHandedOffTasks()).length;
    const allTasksBefore = (await readAsUser<Page<Task>>(["task", "list"])).items.length;
    const started = await readAsUser<{ readonly runId: string }>([
      "run",
      "start",
      "--workflow",
      workflowId,
      "--inputs",
      JSON.stringify({ signal: await raiseSignal("Started by hand") }),
    ]);

    const run = await readRun(started.runId);

    expect(run.taskId).toBeUndefined();
    expect(await listHandedOffTasks()).toHaveLength(tasksBefore);
    expect((await readAsUser<Page<Task>>(["task", "list"])).items).toHaveLength(allTasksBefore);
  }, 60_000);
});
