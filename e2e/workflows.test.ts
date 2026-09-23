/**
 * A workflow through the shipped program: written to `hercule workflow create`
 * on stdin, and printed back by `hercule workflow read` as the bytes that were
 * written, comments, blank lines and trailing spaces included.
 *
 * The CLI has no workflow code of its own: its commands, their stdin rule and
 * their rendering come from the contract. So the round trip is only proven
 * when it runs through a real process: argv, stdin, stdout and the exit code.
 *
 * The suite is in vitest's `binary` project, so `pnpm test:binary` runs it and
 * `pnpm test` does not. It runs the release binary where one has been built
 * and the dispatcher's source where none has: what it exercises is the
 * controller's and the CLI's own surface, which is the same program either way.
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
 * A file as a person writes one: comments, blank lines, keys out of contract
 * order, a block scalar that keeps an indented line, and trailing spaces. The
 * schedule is quoted because the person chose to quote it; the store keeps the
 * quotes. The file ends with one newline, as an editor saves it: the CLI
 * sends it without that newline and prints the stored source with one, so the
 * bytes printed are the bytes of the file.
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

describe("a workflow written on stdin and read back", () => {
  it("prints the file's bytes, and not key-value lines", async () => {
    const createAnswer = jsonOk<{ readonly workflow: { readonly id: string } }>(
      await hercule(["workflow", "create", "--json"], WORKFLOW_FILE),
    );

    const printed = await hercule(["workflow", "read", createAnswer.workflow.id]);
    expect(printed.code, printed.stderr).toBe(0);
    expect(printed.stdout).toBe(WORKFLOW_FILE);
  }, 60_000);
});
