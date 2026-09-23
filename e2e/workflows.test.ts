/**
 * Tests a workflow round trip through the real program: `hercule workflow
 * create` reads a workflow from stdin, and `hercule workflow read` must print
 * back exactly the same bytes, including comments, blank lines and trailing
 * spaces.
 *
 * The CLI has no workflow-specific code. Its commands, how they read stdin and
 * how they print results all come from the contract. So only a real process,
 * with real argv, stdin, stdout and exit code, proves the round trip.
 *
 * The suite is in vitest's `binary` project, so `pnpm test:binary` runs it and
 * `pnpm test` does not. It runs the release binary if one has been built, and
 * the dispatcher's source otherwise. This suite tests the controller and the
 * CLI, not the packaging, so both give the same result.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PASSWORD,
  USERNAME,
  cli,
  completeSetup,
  jsonOk,
  releaseBinary,
  startController,
  temporaryHome,
  type Controller,
  type Ran,
} from "./harness";

const state = temporaryHome();
const binary = releaseBinary();

let controller: Controller;

const hercule = (args: ReadonlyArray<string>, stdin?: string): Promise<Ran> =>
  cli(args, { home: state.home, binary, stdin });

/**
 * A workflow file as a person would write it: comments, blank lines, keys in a
 * different order than the contract's, a block scalar with an indented line,
 * and trailing spaces. The schedule is quoted, and the stored source must keep
 * the quotes. The file ends with one newline, as an editor saves it. The CLI
 * strips that newline before sending and adds one when it prints the stored
 * source, so the printed bytes equal the file.
 */
const WORKFLOW_FILE = [
  "# Files a task every weekday morning.   ",
  "name: Morning failures",
  "",
  "# The schedule is read in the named zone.",
  "triggers:",
  "  - kind: start",
  "    id: weekday_morning",
  "    source:",
  "      kind: cron.tick",
  '    schedule: "0 9 * * 1-5"',
  "    timezone: Europe/Amsterdam",
  "",
  "steps:",
  "  - id: file_task",
  "    kind: action",
  "    action: task.create",
  "    params:",
  "      title: Look at the overnight failures",
  "      description: |",
  "        Check the runs that failed overnight.   ",
  "          Keep this indented line as it is.",
  "",
].join("\n");

beforeAll(async () => {
  controller = await startController({ home: state.home, binary });
  const completed = await completeSetup({ home: state.home, url: controller.url, binary });
  expect(completed.code, `${completed.stdout}\n${completed.stderr}`).toBe(0);
  const login = await hercule(
    [
      "login",
      controller.url,
      "--username",
      USERNAME,
      "--password-stdin",
      "--name",
      "e2e-workflows",
    ],
    PASSWORD,
  );
  expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);
}, 90_000);

afterAll(async () => {
  await controller.stop().catch(() => -1);
  state.remove();
});

describe("a workflow created from stdin and read back", () => {
  it("prints the exact bytes of the file, not key-value lines", async () => {
    const createAnswer = jsonOk<{ readonly workflow: { readonly id: string } }>(
      await hercule(["workflow", "create", "--json"], WORKFLOW_FILE),
    );

    const printed = await hercule(["workflow", "read", createAnswer.workflow.id]);
    expect(printed.code, printed.stderr).toBe(0);
    expect(printed.stdout).toBe(WORKFLOW_FILE);
  }, 60_000);
});
