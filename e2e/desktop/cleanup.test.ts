/**
 * Tests the cleanup dialog of a machine's page in the packaged app, signed in
 * to a real controller whose own, real runner hosts a Thread (spec 17 §Fleet):
 * the dialog archives and removes a Thread's idle workspace, the workspace
 * folder is gone from the machine, and the machine's free space grows.
 *
 * Only the agent is a stand-in: `stub-claude-code.ts` stands in for the
 * Claude Code CLI on the runner's `PATH`, and writes a large file into its
 * workspace as its work. The runner measures that workspace, removes it, and
 * reports the disk's free space, as it does for a real agent.
 *
 * A workspace is idle after 7 days of no use, and the controller keeps the
 * time of the last use in its database. Waiting 7 days is not an option, so
 * the test moves that time back 8 days while the controller is stopped,
 * which is the only moment the database is not locked.
 *
 * The runner reports its free space once a minute, so the last step of the
 * test waits for up to two reports. It checks a function, not a speed.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import type { Session } from "../../packages/contract/src/index";
import { pollUntil } from "../../apps/desktop/scripts/poll";
import { readRunnerStorageDir } from "../harness";
import { arrangeFleet, locateCard, openFleet, openSignedIn } from "./harness";

/** What the stand-in agent writes into its workspace. */
const BULK_BYTES = 256 * 1024 * 1024;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The runner reports its free space every 60 seconds, so a report that
 * follows the removal arrives within two minutes at the latest.
 */
const FREE_SPACE_REPORT_TIMEOUT_MS = 150_000;

/**
 * Writes a `claude` command into a new scratch folder that runs the stand-in
 * agent, and returns the folder. The folder is deleted when the test ends.
 */
function writeStandInAgent(): string {
  const folder = mkdtempSync(join(tmpdir(), "hercule-stand-in-agent-"));
  onTestFinished(() => {
    rmSync(folder, { recursive: true, force: true });
  });
  const command = join(folder, "claude");
  writeFileSync(
    command,
    [
      "#!/bin/sh",
      `BULK_BYTES=${String(BULK_BYTES)} exec "${process.execPath}" "${join(import.meta.dirname, "stub-claude-code.ts")}" "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(command, 0o755);
  return folder;
}

/** Returns the bytes the disk holding `folder` has free. */
function readFreeBytes(folder: string): number {
  const { bavail, bsize } = statfsSync(folder);
  return bavail * bsize;
}

/** Sets the time of last use of the workspace `workspaceId` to `usedAt`, in the database of the stopped controller in `home`. */
function setWorkspaceLastUsedAt(home: string, workspaceId: string, usedAt: Date): void {
  const database = new DatabaseSync(join(home, "data", "hercule.db"));
  try {
    const changed = database
      .prepare("UPDATE workspaces SET last_used_at = ? WHERE id = ?")
      .run(usedAt.toISOString(), Buffer.from(workspaceId.replaceAll("-", ""), "hex")).changes;
    expect(changed).toBe(1);
  } finally {
    database.close();
  }
}

it("archives and removes an idle workspace from the cleanup dialog, and the machine's free space grows", async () => {
  const agentFolder = writeStandInAgent();
  const { url, home, fleet, client, waitForStatus, restartController } = await arrangeFleet({
    ownRunnerEnv: { PATH: `${agentFolder}${delimiter}${process.env["PATH"] ?? ""}` },
  });
  const [runner] = (await client.runner.query({ query: { limit: 10 } })).items;
  await client.runner.update({ params: { id: runner!.id }, payload: { name: "atlas" } });
  // The controller places a thread only on a runner whose probe of the account found a sign-in.
  const accountId = await pollUntil(
    async () =>
      (await client.providerAccount.query()).find(
        (account) =>
          account.defaultHarnessId === "claude-code/claude-code" &&
          account.snapshots.some(
            (snapshot) => snapshot.runnerId === runner!.id && snapshot.auth.status === "ok",
          ),
      )?.id,
    {
      timeoutMs: 30_000,
      intervalMs: 100,
      timeoutMessage: "the runner never reported a signed-in Claude Code account",
    },
  );

  // The agent writes its large file, answers, and the user stops the Thread: the workspace stays.
  const thread = await fleet.call<Session>("POST", "/sessions", {
    prompt: "Fill the workspace",
    runnerId: runner!.id,
    providerAccountId: accountId,
    workspace: { kind: "ephemeral", checkouts: [] },
  });
  await waitForStatus(thread.id, "idle");
  await client.session.stop({ params: { id: thread.id } });
  await waitForStatus(thread.id, "exited");
  const workspaceId = (await client.session.read({ params: { id: thread.id } })).workspaceId!;
  // The runner keeps a managed workspace in a folder named by its id; the API does not give the path.
  const workspaceFolder = join(readRunnerStorageDir(home), "workspaces", workspaceId);
  expect(statSync(join(workspaceFolder, "bulk.bin")).size).toBe(BULK_BYTES);
  // The runner measures the workspace once no session works in it.
  await pollUntil(
    async () => {
      const { diskUsage } = await client.workspace.read({ params: { id: workspaceId } });
      return diskUsage !== null && diskUsage.freesBytes >= BULK_BYTES ? true : undefined;
    },
    {
      timeoutMs: 30_000,
      intervalMs: 200,
      timeoutMessage: "the runner never measured the workspace at the size of the agent's file",
    },
  );

  // Not used for 8 days: idle for the dialog, which lists workspaces idle for 7.
  await restartController(() => {
    setWorkspaceLastUsedAt(home, workspaceId, new Date(Date.now() - 8 * DAY_MS));
  });
  await expect
    .poll(async () => (await client.runner.read({ params: { id: runner!.id } })).connectivity, {
      timeout: 30_000,
    })
    .toBe("online");

  const { page } = await openSignedIn(url);
  await openFleet(page);
  await locateCard(page, "atlas").getByRole("button", { name: "atlas", exact: true }).click();
  const storage = page.locator("#machine-storage");
  const idleRow = storage.locator(".machine-storage-idle-row", { hasText: "Fill the workspace" });
  await expect
    .poll(() => idleRow.locator(".machine-storage-idle-age").innerText())
    .toBe("1 week ago");

  await storage.getByRole("button", { name: "Clean up…" }).click();
  const dialog = page.getByRole("dialog", { name: "Clean up atlas" });
  const confirm = dialog.getByRole("button", { name: /^Archive and remove 1, frees \d+ MB$/ });
  // A Thread that is not Done is left unticked, because removing it archives it.
  await dialog.getByText("Fill the workspace", { exact: true }).click();
  await confirm.waitFor();
  // Nothing is archived or removed until the user confirms.
  expect((await client.session.read({ params: { id: thread.id } })).archived).toBeUndefined();
  expect(existsSync(workspaceFolder)).toBe(true);
  const freeBefore = readFreeBytes(workspaceFolder);
  await confirm.click();

  await page
    .getByRole("status")
    .getByText(/^Archived 1 thread and removed 1 workspace\. \d+ MB freed\.$/)
    .waitFor();
  expect((await client.session.read({ params: { id: thread.id } })).archived?.by).toBe("user");
  expect((await client.workspace.read({ params: { id: workspaceId } })).status).toBe("deleted");
  expect(existsSync(workspaceFolder)).toBe(false);
  await idleRow.waitFor({ state: "detached" });

  // The runner reports its free space every minute, so a report that follows the removal shows the file's size back.
  await pollUntil(
    async () => {
      const { metrics } = await client.runner.read({ params: { id: runner!.id } });
      return metrics !== null && metrics.diskFreeBytes >= freeBefore + BULK_BYTES / 2
        ? true
        : undefined;
    },
    {
      timeoutMs: FREE_SPACE_REPORT_TIMEOUT_MS,
      intervalMs: 1_000,
      timeoutMessage: `the runner never reported ${String(BULK_BYTES / 2)} bytes more free space than the ${String(freeBefore)} it had before the removal`,
    },
  );
}, 240_000);
