/**
 * Tests what the controller does with a runner's disk usage report, over the
 * runner socket against a real controller and one fake runner (spec 03,
 * section 6.9):
 *
 * - the entries show on the workspaces and the totals on the runner, as the
 *   API reads them;
 * - an entry for a workspace the controller does not know is dropped, and the
 *   rest of the report is still stored;
 * - a report without totals keeps the totals stored before it;
 * - a failure with no measurement adds the error and keeps the stored numbers.
 */
import { describe, expect, it, vi } from "vitest";
import type { Runner } from "@hercule/contract";
import type { RunnerDiskUsageReport } from "@hercule/protocol";
import { get } from "../../http/testing";
import { WAIT_DEADLINE_MS, waitUntil, type Arranged } from "../../sessions/testing";
import { readWorkspace, spawnThread, withFleet } from "../../workspaces/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

const UNKNOWN_WORKSPACE = "0199e0e7-7b21-7000-8000-0000000000ff";
const MEASURED_AT = "2026-11-03T10:00:00.000Z";

/** Returns the runner as the API shows it. */
const readRunner = async (arranged: Arranged): Promise<Runner> => {
  const response = await get(
    arranged.harness.base,
    `/api/v1/runners/${arranged.runnerId}`,
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Runner;
};

const report = (
  workspaces: RunnerDiskUsageReport["workspaces"],
  runner: RunnerDiskUsageReport["runner"],
): RunnerDiskUsageReport => ({ workspaces, truncated: false, runner });

describe("a runner's disk usage report", () => {
  it("is stored on the workspaces and the runner, and a report without totals keeps the totals", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnThread(arranged, { kind: "ephemeral", checkouts: [] }, 1);
      const workspaceId = session.workspaceId!;
      expect((await readWorkspace(arranged, workspaceId)).diskUsage).toBeNull();
      expect((await readRunner(arranged)).diskUsage).toBeNull();

      arranged.wire.send({
        _tag: "diskUsageReport",
        diskUsage: report(
          [
            {
              workspaceId: UNKNOWN_WORKSPACE,
              diskUsage: { sizeBytes: 1, freesBytes: 1, measuredAt: MEASURED_AT },
              error: null,
            },
            {
              workspaceId,
              diskUsage: { sizeBytes: 5000, freesBytes: 3000, measuredAt: MEASURED_AT },
              error: null,
            },
          ],
          { repositoryCacheBytes: 700, harnessHomeBytes: 80, measuredAt: MEASURED_AT },
        ),
      });
      const stored = await waitUntil("stored the report", async () => {
        const workspace = await readWorkspace(arranged, workspaceId);
        return workspace.diskUsage === null ? undefined : workspace;
      });
      expect(stored.diskUsage).toEqual({
        sizeBytes: 5000,
        freesBytes: 3000,
        measuredAt: MEASURED_AT,
      });
      expect(stored.diskUsageError).toBeNull();
      expect((await readRunner(arranged)).diskUsage).toEqual({
        repositoryCacheBytes: 700,
        harnessHomeBytes: 80,
        measuredAt: MEASURED_AT,
      });

      arranged.wire.send({
        _tag: "diskUsageReport",
        diskUsage: report(
          [{ workspaceId, diskUsage: null, error: "Measuring took longer than 10 minutes" }],
          null,
        ),
      });
      const failed = await waitUntil("stored the failure", async () => {
        const workspace = await readWorkspace(arranged, workspaceId);
        return workspace.diskUsageError === null ? undefined : workspace;
      });
      expect(failed.diskUsageError).toBe("Measuring took longer than 10 minutes");
      expect(failed.diskUsage).toEqual({
        sizeBytes: 5000,
        freesBytes: 3000,
        measuredAt: MEASURED_AT,
      });
      expect((await readRunner(arranged)).diskUsage?.repositoryCacheBytes).toBe(700);
    });
  });
});
