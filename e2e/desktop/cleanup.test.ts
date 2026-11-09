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
 * The runner reports its free space once a minute, and right after it removes
 * a workspace. The test reads a report taken with the file in place, and one
 * taken after the removal, and tells them apart by what they hold and by the
 * order the controller stores them in (see `waitForFreeBytes`), never by the
 * minute a report falls in: the controller keeps one row per minute, so a
 * second report in the same minute replaces the first.
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
import type { HerculeClient } from "../../packages/client-core/src/index";
import { arrangeFleet, locateCard, openFleet, openSignedIn } from "./harness";

/** What the stand-in agent writes into its workspace. */
const BULK_BYTES = 1024 * 1024 * 1024;

/**
 * How much more free space the test requires after the removal, and the line
 * that tells a report taken with the file in place from one taken without it.
 * The scratch home shares its disk with the rest of the machine, and other
 * processes write to it during the test. The file is 1 GiB and the test
 * requires half of it, so ordinary writes by others (a build, a log, a
 * download) are unlikely to hide the removal. A process that writes or frees
 * more than 512 MiB between two reports can still fail a correct cleanup, or
 * pass a report taken at the wrong moment. That risk is accepted, because the
 * runner's storage cannot portably sit on its own volume.
 */
const REQUIRED_GROWTH_BYTES = BULK_BYTES / 2;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long to wait for a report. A runner reports within a second of
 * connecting. After a removal it starts the measurement within 5 seconds and
 * sends the report when the read ends, which takes milliseconds here. A slow
 * machine needs more time but not 60 seconds. A runner that sent no report
 * after its removals would usually fail this wait, but not always, because the
 * periodic report can fall inside it. The runner's own tests (`metrics.test.ts`)
 * prove the report after a removal exactly.
 */
const FREE_SPACE_REPORT_TIMEOUT_MS = 20_000;

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

/**
 * Returns the free bytes of the disk that holds `folder`, as the operating
 * system reports them to the runner, which reads the blocks an unprivileged
 * user may still write.
 */
function readDiskFreeBytes(folder: string): number {
  const stats = statfsSync(folder);
  return stats.bavail * stats.bsize;
}

/**
 * Waits until the free disk space in the runner's latest report is one that
 * `accept` takes, and returns it. The controller stores only the latest report
 * of a runner, and a report never replaces a newer one, so every read is the
 * report an earlier read saw or a later one. A caller therefore tells a report
 * apart from the ones before it by what it holds: `accept` is true only for a
 * value that no report taken earlier can hold. That does not depend on the
 * minute a report arrives in.
 */
async function waitForFreeBytes(
  client: HerculeClient,
  runnerId: string,
  accept: (freeBytes: number) => boolean,
  what: string,
): Promise<number> {
  let lastSeen: number | undefined;
  return pollUntil(
    async () => {
      lastSeen = (await client.runner.read({ params: { id: runnerId } })).metrics?.diskFreeBytes;
      return lastSeen !== undefined && accept(lastSeen) ? lastSeen : undefined;
    },
    {
      timeoutMs: FREE_SPACE_REPORT_TIMEOUT_MS,
      intervalMs: 250,
      timeoutMessage: () => `${what}; the latest report holds ${String(lastSeen)} free bytes`,
    },
  );
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
    controllerEnv: { PATH: `${agentFolder}${delimiter}${process.env["PATH"] ?? ""}` },
    keepOwnRunner: true,
  });
  const [runner] = (await client.runner.query({ query: { limit: 10 } })).items;
  await client.runner.update({ params: { id: runner!.id }, payload: { name: "atlas" } });
  // The runner can connect before setup creates the account. The probe that
  // follows a runner's connection then finds no account, and nothing probes
  // the new account until the next sweep, an hour later. A restart makes the
  // runner connect again, and the probe that follows finds the account.
  await restartController(() => {});
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
  // The bulk file is in the workspace and measured, and nothing is removed yet.
  // The report the runner sends as it reconnects is taken with the file in
  // place. The report the controller held before the restart may have been
  // taken before the file was written, which is 1 GiB more free space than now,
  // so it is told by that: with the file in place the free space is below the
  // line halfway between the two.
  const freeWithFile = readDiskFreeBytes(readRunnerStorageDir(home));
  const freeBefore = await waitForFreeBytes(
    client,
    runner!.id,
    (freeBytes) => freeBytes < freeWithFile + REQUIRED_GROWTH_BYTES,
    "the runner sent no report taken with the file in place",
  );

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
  const confirm = dialog.getByRole("button", {
    name: /^Archive and remove 1, frees [\d.]+ (?:MB|GB)$/,
  });
  // A Thread that is not Done is left unticked, because removing it archives it.
  await dialog.getByText("Fill the workspace", { exact: true }).click();
  await confirm.waitFor();
  // Nothing is archived or removed until the user confirms.
  expect((await client.session.read({ params: { id: thread.id } })).archived).toBeUndefined();
  expect(existsSync(workspaceFolder)).toBe(true);
  await confirm.click();

  await page
    .getByRole("status")
    .getByText(/^Archived 1 thread and removed 1 workspace\. [\d.]+ (?:MB|GB) freed\.$/)
    .waitFor();
  expect((await client.session.read({ params: { id: thread.id } })).archived?.by).toBe("user");
  expect((await client.workspace.read({ params: { id: workspaceId } })).status).toBe("deleted");
  expect(existsSync(workspaceFolder)).toBe(false);
  await idleRow.waitFor({ state: "detached" });

  // The runner reports as soon as the removal ends, so the user sees the freed
  // space at once. Only a report taken after the removal holds the file's size
  // back, and the report read before is the newest one the first read can have
  // seen, so a report that holds it is a later one.
  const freeAfter = await waitForFreeBytes(
    client,
    runner!.id,
    (freeBytes) => freeBytes - freeBefore >= REQUIRED_GROWTH_BYTES,
    "the runner sent no report after the removal that shows the freed space",
  );
  expect(freeAfter - freeBefore).toBeGreaterThanOrEqual(REQUIRED_GROWTH_BYTES);
}, 120_000);
