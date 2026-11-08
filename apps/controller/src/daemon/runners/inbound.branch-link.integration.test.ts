/**
 * Tests what the controller does when a runner reports that a checkout is on
 * another branch, over the runner socket against a real controller and one
 * fake runner: a pull request that Hercule already holds, whose head is that
 * branch, is linked to the Task of the workspace. A report that leaves the
 * branch as it was links nothing.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mintUuid, withTransaction } from "../../db";
import { spawnSessionOrFail, waitUntil, type Arranged } from "../../sessions/testing";
import {
  createRepo,
  readWorkspace,
  reportWorkspaceReady,
  withFleet,
} from "../../workspaces/testing";

const REMOTE = "github.com/acme/branch-link";

/** Stores a pull request whose head is `branch` of the repository, as a poll leaves it. */
const storePullRequest = (arranged: Arranged, number: number, branch: string) => {
  const sql = arranged.harness.sql;
  return Effect.runPromise(
    withTransaction(
      sql,
      sql`INSERT INTO external_entities
            (id, ref, kind, noun, pace, completeness, title, lifecycle, repository,
             first_observed_at, updated_at)
          VALUES (${mintUuid()}, ${`github:pull-request:acme/branch-link#${String(number)}`},
                  'github/pull-request', 'Pull request', 'fast', 'full', 'A change', 'open',
                  ${JSON.stringify({
                    target: { remote: REMOTE },
                    head: { remote: REMOTE, branch },
                  })},
                  '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
    ).pipe(Effect.orDie),
  );
};

/** Lists the refs the Task links. */
const listLinkedRefs = async (arranged: Arranged, taskId: string): Promise<ReadonlyArray<string>> =>
  (
    await Effect.runPromise(
      Effect.orDie(
        arranged.harness.sql<{ readonly ref: string }>`
          SELECT ref FROM task_entity_links
          WHERE lower(hex(task_id)) = ${taskId.replaceAll("-", "")} ORDER BY ref`,
      ),
    )
  ).map((row) => row.ref);

/** Has the runner report that the workspace's checkouts are on `branch`, and waits until the controller has recorded the report. */
const reportBranch = async (
  arranged: Arranged,
  workspaceId: string,
  branch: string,
  observedAt: string,
): Promise<void> => {
  const workspace = await readWorkspace(arranged, workspaceId);
  arranged.wire.send({
    _tag: "workspaceReport",
    workspaceId,
    status: "ready",
    observedAt,
    checkouts: workspace.checkouts.map((checkout) => ({
      checkoutId: String(checkout.checkoutId),
      branch,
      branches: [branch],
      defaultBranch: "main",
    })),
  });
  await waitUntil("recorded the report", async () =>
    (await readWorkspace(arranged, workspaceId)).observedAt === observedAt ? true : undefined,
  );
};

describe("a runner reports that a checkout is on another branch", () => {
  it("links the pull request whose head is that branch to the Task, and only then", async () => {
    await withFleet(async (arranged) => {
      const repository = await createRepo(arranged, `https://${REMOTE}`);
      const session = await spawnSessionOrFail(arranged, {
        prompt: "fix the login",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: repository }] },
      });
      const workspaceId = String(session.workspaceId);
      const taskId = String(session.taskId);
      await reportWorkspaceReady(arranged, workspaceId);

      await storePullRequest(arranged, 1, "fix-login");
      await reportBranch(arranged, workspaceId, "fix-login", "2026-11-01T10:00:00.000Z");
      await waitUntil("linked the pull request", async () =>
        (await listLinkedRefs(arranged, taskId)).length === 1 ? true : undefined,
      );
      expect(await listLinkedRefs(arranged, taskId)).toEqual([
        "github:pull-request:acme/branch-link#1",
      ]);

      // A second pull request on the same branch waits for a scan: this report
      // moved no checkout, so nothing looked for it.
      await storePullRequest(arranged, 2, "fix-login");
      await reportBranch(arranged, workspaceId, "fix-login", "2026-11-01T10:05:00.000Z");
      expect(await listLinkedRefs(arranged, taskId)).toEqual([
        "github:pull-request:acme/branch-link#1",
      ]);
    });
  });
});
