/**
 * Integration tests for `resource.listBranches`, driven over HTTP against a
 * controller with a fake runner on the real runner socket. The fake runner
 * answers `branchListRequest` with the outcome it is told to give; the runner
 * filters, sorts and cuts the lists, so the controller must pass them on as
 * they are.
 *
 * What the tests check:
 *
 * - The runner is asked about the repo's ready main workspace there, with the
 *   caller's text and maximum, or an empty text and the default maximum.
 * - A runner that cannot answer gives empty lists and a reason, never an
 *   error: no ready main workspace, too old, or git failed. A runner that
 *   cannot be asked is not sent a frame.
 * - `workspace.read` gates the operation; a resource that is missing or not a
 *   repo is refused.
 */
import { describe, expect, it, vi } from "vitest";
import { BRANCH_LIST_CAPABILITY } from "@hercule/protocol";
import { DEFAULT_MAX_BRANCHES, type ResourceBranches, type Runner } from "@hercule/contract";
import { get, post } from "../../http/testing";
import {
  CURRENT_CAPABILITIES,
  spawnThreadWithGrants,
  waitForRunnerGone,
  waitUntil,
  WAIT_DEADLINE_MS,
  type Arranged,
} from "../../sessions/testing";
import {
  createRepo,
  listFramesTagged,
  provisionWorkspaceOrFail,
  reportWorkspaceReady,
  withFleet,
} from "../../workspaces/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

const REMOTE = "https://fixture.invalid/acme/hercule";

const listBranches = async (
  arranged: Arranged,
  resourceId: string,
  query = "",
): Promise<ResourceBranches> => {
  const response = await get(
    arranged.harness.base,
    `/api/v1/resources/${resourceId}/branches?runnerId=${arranged.runnerId}${query}`,
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ResourceBranches;
};

const provisionReadyPrimary = async (arranged: Arranged, resourceId: string): Promise<string> => {
  const workspace = await provisionWorkspaceOrFail(arranged, {
    resourceId,
    runnerId: arranged.runnerId,
  });
  await reportWorkspaceReady(arranged, workspace.id);
  return workspace.id;
};

describe("resource.listBranches", () => {
  it("asks the runner about the repo's main workspace and passes its lists on unchanged", async () => {
    await withFleet(async (arranged) => {
      const resourceId = await createRepo(arranged, REMOTE);
      const primaryId = await provisionReadyPrimary(arranged, resourceId);
      arranged.wire.setBranchListAnswer(() => ({
        status: "listed",
        local: ["fix/login", "main"],
        remote: ["main"],
        more: true,
      }));

      const searched = await listBranches(arranged, resourceId, "&text=Fix&maxBranches=2");
      const unfiltered = await listBranches(arranged, resourceId);

      expect(searched).toEqual({ local: ["fix/login", "main"], remote: ["main"], more: true });
      expect(unfiltered.unavailableReason).toBeUndefined();
      expect(
        listFramesTagged(arranged.wire, "branchListRequest").map(
          ({ workspaceId, text, maxBranches }) => ({ workspaceId, text, maxBranches }),
        ),
      ).toEqual([
        { workspaceId: primaryId, text: "Fix", maxBranches: 2 },
        { workspaceId: primaryId, text: "", maxBranches: DEFAULT_MAX_BRANCHES },
      ]);
    });
  });

  it("gives a reason and asks nothing when the runner has no ready main workspace of the repo", async () => {
    await withFleet(async (arranged) => {
      const resourceId = await createRepo(arranged, REMOTE);

      const answer = await listBranches(arranged, resourceId);

      expect(answer).toMatchObject({ local: [], remote: [], more: false });
      expect(answer.unavailableReason).toContain("no ready main workspace");
      expect(listFramesTagged(arranged.wire, "branchListRequest")).toEqual([]);
    });
  });

  it("passes the runner's reason on when git fails", async () => {
    await withFleet(async (arranged) => {
      const resourceId = await createRepo(arranged, REMOTE);
      await provisionReadyPrimary(arranged, resourceId);
      arranged.wire.setBranchListAnswer(() => ({ status: "failed", message: "not a git repo" }));

      const answer = await listBranches(arranged, resourceId);

      expect(answer).toMatchObject({ local: [], remote: [], more: false });
      expect(answer.unavailableReason).toContain("not a git repo");
    });
  });

  it("gives a reason at once, without waiting out the deadline, when the runner is offline", async () => {
    await withFleet(async (arranged) => {
      const resourceId = await createRepo(arranged, REMOTE);
      await provisionReadyPrimary(arranged, resourceId);
      arranged.wire.close();
      await waitForRunnerGone(arranged);

      const started = Date.now();
      const answer = await listBranches(arranged, resourceId);

      expect(answer.unavailableReason).toContain("offline");
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  });

  it("gives a reason and sends nothing to a runner too old to list branches", async () => {
    await withFleet(async (arranged) => {
      const resourceId = await createRepo(arranged, REMOTE);
      await provisionReadyPrimary(arranged, resourceId);
      arranged.wire.close();
      await waitForRunnerGone(arranged);
      const older = await arranged.reconnect({
        capabilities: CURRENT_CAPABILITIES.filter(
          (capability) => capability !== BRANCH_LIST_CAPABILITY,
        ),
      });
      older.send({ _tag: "sessionsReport", sessions: [] });
      await waitUntil("negotiated the older runner's capabilities", async () => {
        const response = await get(
          arranged.harness.base,
          `/api/v1/runners/${arranged.runnerId}`,
          arranged.token,
        );
        const runner = (await response.json()) as Runner & {
          readonly negotiatedCapabilities: ReadonlyArray<string> | null;
        };
        return runner.connectivity === "online" &&
          runner.negotiatedCapabilities?.includes(BRANCH_LIST_CAPABILITY) === false
          ? true
          : undefined;
      });

      const answer = await listBranches(arranged, resourceId);

      expect(answer.unavailableReason).toContain("too old");
      expect(listFramesTagged(older, "branchListRequest")).toEqual([]);
    });
  });

  it("refuses a caller without workspace.read, and a resource that is missing or not a repo", async () => {
    await withFleet(async (arranged) => {
      const resourceId = await createRepo(arranged, REMOTE);
      const resourceReader = await spawnThreadWithGrants(arranged, "resource-reader", [
        "resource.read",
      ]);
      const folder = await post(
        arranged.harness.base,
        "/api/v1/resources",
        { kind: "folder", label: "Notes" },
        arranged.token,
      );
      const folderId = ((await folder.json()) as { id: string }).id;
      const query = `?runnerId=${arranged.runnerId}`;

      const refused = await get(
        arranged.harness.base,
        `/api/v1/resources/${resourceId}/branches${query}`,
        resourceReader.token,
      );
      const missing = await get(
        arranged.harness.base,
        `/api/v1/resources/0199e0e7-9999-7000-8000-000000000000/branches${query}`,
        arranged.token,
      );
      const notRepo = await get(
        arranged.harness.base,
        `/api/v1/resources/${folderId}/branches${query}`,
        arranged.token,
      );

      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        error: { code: "forbidden", details: { grant: "workspace.read" } },
      });
      expect(missing.status).toBe(404);
      expect(notRepo.status).toBe(400);
    });
  });
});
