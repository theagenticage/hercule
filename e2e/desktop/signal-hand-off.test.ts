/**
 * Tests that `hercule signal hand-off` refuses a session's token and writes
 * nothing (spec 11, `signal.handOff`). Only the user may hand a signal off.
 * The test starts no window: it lives with the packaged app's suite only
 * because a session needs a scripted runner, which `e2e/hand-off.test.ts`,
 * where the rest of the handoff is tested, cannot import.
 *
 * The workflow is made of the built-in `wait` action, so it needs no runner
 * and no provider.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { describe, expect, it } from "vitest";
import { findCompiledBinary, runCli } from "../../scripts/controller-process";
import { arrangeFleet } from "./harness";

describe("hercule signal hand-off", () => {
  it("refuses a session's token, and leaves the signal open with no Task", async () => {
    const arranged = await arrangeFleet();
    const { client } = arranged;
    const { workflow } = await client.workflow.create({
      payload: {
        definition: {
          name: "Review PR",
          inputs: [{ name: "signal", signal: { kinds: ["fyi"] }, required: true }],
          steps: [{ id: "work", kind: "action", action: "wait", params: { seconds: 1 } }],
        },
      },
    });
    await client.workflow.update({ params: { id: workflow.id }, payload: { enabled: true } });
    const { signalId } = await client.signal.raise({
      payload: {
        kind: "fyi",
        title: "Only the user may hand this off",
        reason: "Raised by a test",
        eventIds: [],
      },
    });
    const readTaskIds = async (): Promise<readonly string[]> =>
      (await client.task.query({ query: { limit: 100 } })).items.map((task) => task.id).sort();
    const tasksBefore = await readTaskIds();
    const runner = await arranged.fleet.enlistRunner("hand-off-runner");
    const [thread] = await arranged.fleet.spawnThreads(1, { runner });
    // The runner holds the thread, and so its token, once the controller has
    // started it there.
    await arranged.waitForStatus(thread!.id, "busy");

    const refused = await runCli(["signal", "hand-off", signalId, "--workflow", workflow.id], {
      home: arranged.home,
      binary: findCompiledBinary(),
      env: {
        HERCULE_API_URL: arranged.url,
        HERCULE_TOKEN: runner.readSessionToken(thread!.id),
      },
    });

    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("only the user may hand a signal off");
    expect((await client.signal.read({ params: { id: signalId } })).status).toBe("open");
    expect((await client.task.query({ query: { handedOff: true, limit: 10 } })).items).toEqual([]);
    // No Task at all, so a Task made without its handoff entry fails the test too.
    expect(await readTaskIds()).toEqual(tasksBefore);
  }, 120_000);
});
