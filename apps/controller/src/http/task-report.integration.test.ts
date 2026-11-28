/**
 * Tests `hercule task report --stage <stage>` end to end: the CLI command
 * tree, the HTTP API and the real runner socket, with the credential an agent
 * has inside its session.
 *
 * A Thread leads the Task it was started on, reports Planned, and the Work
 * board then shows the card at Planned with the report as its cause. A helper
 * Thread on the same Task and the user are both refused.
 */
import { describe, expect, it, vi } from "vitest";
import { main } from "../../../../packages/cli/src/index";
import type { Task, WorkBoard } from "@hercule/contract";
import {
  createProfile,
  spawnThreadUnder,
  WAIT_DEADLINE_MS,
  withAgentFleet as withFleet,
  type Arranged,
} from "../sessions/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

/** What one run of the CLI printed, and the exit code it returned. */
interface CliRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `hercule <argv>` in this process against the test controller, holding
 * `token` as its credential, the way the CLI runs inside a session.
 */
const runCli = async (
  arranged: Arranged,
  token: string,
  argv: ReadonlyArray<string>,
): Promise<CliRun> => {
  const out: Array<string> = [];
  const err: Array<string> = [];
  const exitCode = await main([...argv, "--json"], {
    env: { HERCULE_API_URL: arranged.harness.base, HERCULE_TOKEN: token },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdin: () => Promise.resolve(""),
    isTty: () => false,
    prompt: () => Promise.resolve(""),
    hostname: () => "test-host",
    fetch: (input, init) => fetch(input, init),
  });
  return { exitCode, stdout: out.join("\n"), stderr: err.join("\n") };
};

/** Runs the CLI and parses what it printed as JSON. Fails the test when the exit code is not 0. */
const runCliOk = async <A>(
  arranged: Arranged,
  token: string,
  argv: ReadonlyArray<string>,
): Promise<A> => {
  const run = await runCli(arranged, token, argv);
  expect(run.exitCode, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as A;
};

describe("hercule task report", () => {
  it("moves the card of the Task its lead leads, and refuses a helper and the user", async () => {
    await withFleet(async (arranged) => {
      const profile = await createProfile(arranged, "reporter", ["task.update"]);
      const lead = await spawnThreadUnder(arranged, profile);
      const helper = await spawnThreadUnder(arranged, profile, { taskId: lead.session.taskId! });
      const taskId = lead.session.taskId!;
      expect(helper.session.taskId).toBe(taskId);

      const report = await runCliOk<{ outcome: string }>(arranged, lead.token, [
        "task",
        "report",
        "--stage",
        "planned",
      ]);
      expect(report.outcome).toBe("moved");

      const task = await runCliOk<Task>(arranged, arranged.token, ["task", "read", taskId]);
      expect(task.leadSessionId).toBe(lead.session.id);
      expect(task.stage).toBe("planned");

      const board = await runCliOk<WorkBoard>(arranged, arranged.token, ["task", "board"]);
      const card = board.cards.find((one) => one.id === taskId);
      expect(card?.stage).toBe("planned");
      expect(card?.stageCause).toEqual({
        kind: "report",
        sessionId: lead.session.id,
        stageRevision: expect.any(Number) as number,
        text: `“${lead.session.title}” says Planned`,
      });

      const refusedHelper = await runCli(arranged, helper.token, [
        "task",
        "report",
        "--stage",
        "planned",
      ]);
      expect(refusedHelper.exitCode).not.toBe(0);
      const { error: refusal } = JSON.parse(refusedHelper.stderr) as {
        error: { code: string; message: string };
      };
      expect(refusal.code).toBe("invalid_state");
      expect(refusal.message).toContain(`“${lead.session.title}”`);

      const refusedUser = await runCli(arranged, arranged.token, [
        "task",
        "report",
        "--stage",
        "planned",
      ]);
      expect(refusedUser.exitCode).not.toBe(0);
      expect(refusedUser.stderr).toContain("Only an agent session reports a stage");

      const events = await runCliOk<{ items: ReadonlyArray<{ kind: string; payload: unknown }> }>(
        arranged,
        arranged.token,
        ["event", "list", "--kind", "task.stageReported"],
      );
      expect(events.items).toHaveLength(1);
      expect(events.items[0]?.payload).toMatchObject({
        taskId,
        sessionId: lead.session.id,
        stage: "planned",
        outcome: "moved",
      });
    });
  });
});
