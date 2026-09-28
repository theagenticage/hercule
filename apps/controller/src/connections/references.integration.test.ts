/**
 * Tests `connection.delete` against the records in other domains that name a
 * Connection, over HTTP on a set-up controller with the local GitHub plugin.
 * The connections domain reads those records through its
 * `ConnectionReferences` port, which the controller daemon provides.
 *
 * A trigger that names a Connection starts runs only on events from that
 * Connection. If the Connection were deleted, the trigger would never match
 * again and the workflow would go quiet without telling anyone, so the delete
 * is refused while such a trigger exists. The same holds for a resource that
 * acts through the Connection. Clearing a resource's Connection is tested in
 * the resources suite.
 */
import { describe, expect, it } from "vitest";
import { del, get, post, readErrorBody } from "../http/testing";
import {
  ACCEPTED_GITHUB_TOKEN,
  createConnection,
  createWorkflowOrFail,
  withSetUpController,
} from "../workflows/testing";

/**
 * Returns the source of a workflow named `name` with one start trigger, `id`,
 * on labelled pull requests from `connectionId`, which is a Connection's id
 * or `any`.
 */
const buildLabeledWorkflowSource = (name: string, id: string, connectionId: string): string =>
  `name: ${name}
triggers:
  - id: ${id}
    kind: start
    source:
      kind: github.pr.labeled
      connectionId: ${connectionId}
steps:
  - id: file_task
    kind: action
    action: task.create
    params:
      title: Triage the pull request
      description: Filed by a trigger.
`;

const deleteConnection = (base: string, token: string, id: string): Promise<Response> =>
  del(base, `/api/v1/connections/${id}`, token);

/** Returns the HTTP status of a read of the Connection: 200 while it exists, 404 after. */
const readConnectionStatus = async (base: string, token: string, id: string): Promise<number> =>
  (await get(base, `/api/v1/connections/${id}`, token)).status;

describe("connection.delete while workflow triggers name the Connection", () => {
  it("refuses with invalid_state, names every trigger and its workflow, and keeps the Connection", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const connectionId = await createConnection(base, token, "github/github", {
        pat: ACCEPTED_GITHUB_TOKEN,
      });
      await createWorkflowOrFail(base, token, {
        source: buildLabeledWorkflowSource("Release notes", "labeled", connectionId),
      });
      await createWorkflowOrFail(base, token, {
        source: buildLabeledWorkflowSource("Label triage", "on_label", connectionId),
      });

      const response = await deleteConnection(base, token, connectionId);

      const refusal = await readErrorBody(response);
      expect(response.status, refusal.text).toBe(409);
      expect(refusal.code).toBe("invalid_state");
      // Listed by workflow name, so the message reads the same every time.
      expect(refusal.message).toBe(
        "workflow triggers start runs on events from this connection: " +
          "on_label in the workflow Label triage, labeled in the workflow Release notes; " +
          "point those triggers at another connection, or delete them, before deleting this one",
      );
      expect(await readConnectionStatus(base, token, connectionId)).toBe(200);
      expect(await harness.audit("connection.deleted")).toEqual([]);
    });
  });

  it("deletes the Connection once the workflow whose trigger named it is deleted", async () => {
    await withSetUpController(async ({ base, token }) => {
      const connectionId = await createConnection(base, token, "github/github", {
        pat: ACCEPTED_GITHUB_TOKEN,
      });
      const workflow = await createWorkflowOrFail(base, token, {
        source: buildLabeledWorkflowSource("Label triage", "labeled", connectionId),
      });
      const refused = await deleteConnection(base, token, connectionId);
      expect(refused.status, await refused.clone().text()).toBe(409);

      const workflowDeleted = await del(base, `/api/v1/workflows/${workflow.id}`, token);
      expect(workflowDeleted.status, await workflowDeleted.clone().text()).toBe(200);
      const response = await deleteConnection(base, token, connectionId);

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await readConnectionStatus(base, token, connectionId)).toBe(404);
    });
  });
});

describe("connection.delete with a trigger on any Connection", () => {
  it("deletes the Connection, because the trigger does not depend on that one", async () => {
    await withSetUpController(async ({ base, token }) => {
      const connectionId = await createConnection(base, token, "github/github", {
        pat: ACCEPTED_GITHUB_TOKEN,
      });
      await createWorkflowOrFail(base, token, {
        source: buildLabeledWorkflowSource("Label triage", "labeled", "any"),
      });

      const response = await deleteConnection(base, token, connectionId);

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await readConnectionStatus(base, token, connectionId)).toBe(404);
    });
  });
});

describe("connection.delete while a resource and a trigger both name the Connection", () => {
  it("refuses with one message that names the resource and the trigger, and what to do about each", async () => {
    await withSetUpController(async ({ base, token }) => {
      const connectionId = await createConnection(base, token, "github/github", {
        pat: ACCEPTED_GITHUB_TOKEN,
      });
      const created = await post(
        base,
        "/api/v1/resources",
        { kind: "repo", remote: "https://github.com/acme/web.git", connectionId },
        token,
      );
      expect(created.status, await created.clone().text()).toBe(200);
      const resourceId = ((await created.json()) as { id: string }).id;
      await createWorkflowOrFail(base, token, {
        source: buildLabeledWorkflowSource("Label triage", "labeled", connectionId),
      });

      const response = await deleteConnection(base, token, connectionId);

      const refusal = await readErrorBody(response);
      expect(response.status, refusal.text).toBe(409);
      expect(refusal.code).toBe("invalid_state");
      expect(refusal.message).toBe(
        "resources act through this connection: " +
          `https://github.com/acme/web.git (${resourceId}); ` +
          "point those resources at another connection before deleting this one; " +
          "workflow triggers start runs on events from this connection: " +
          "labeled in the workflow Label triage; " +
          "point those triggers at another connection, or delete them, before deleting this one",
      );
      expect(await readConnectionStatus(base, token, connectionId)).toBe(200);
    });
  });
});
