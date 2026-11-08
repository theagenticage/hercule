/**
 * Tests the boot step that installs the workflows that ship with Hercule,
 * on a running controller with the real workflow service:
 * - both shipped sources validate and are stored enabled, with their
 *   triggers, stamped as the system;
 * - a key is installed once: a later boot installs nothing, a deleted
 *   workflow stays deleted and an edited one stays edited;
 * - a source that does not validate installs nothing, leaves the boot
 *   running and raises one notification for each failing key, which the next
 *   boot that installs the key withdraws.
 *
 * The step takes the sources as an argument, so a test breaks a source by
 * passing a different list, and the production code has no seam for it.
 */
import { describe, expect, it, vi } from "vitest";
import * as Exit from "effect/Exit";
import type { Workflow } from "@hercule/contract";
import { WAIT_DEADLINE_MS } from "../../sessions/testing";
import { del, get, type ServerHarness } from "../../http/testing";
import {
  buildFileTaskSource,
  queryTriggers,
  queryWorkflows,
  updateWorkflow,
  withSetUpController,
  type SetUpController,
} from "../../workflows/testing";
import { SHIPPED_WORKFLOWS, type ShippedWorkflowSource } from "../../workflows";
import { runEffect } from "../testing";
import { installCardWorkflows } from "./card-workflows";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS + 10_000 });

/** A source the controller refuses: its only step names an action that does not exist. */
const BROKEN_SOURCE = [
  "name: Broken on purpose",
  "steps:",
  "  - id: nothing",
  "    kind: action",
  "    action: nothing.at-all",
  "",
].join("\n");

/** Runs the boot step with `sources` and returns whether it finished without failing. */
const boot = async (
  harness: ServerHarness,
  sources: ReadonlyArray<ShippedWorkflowSource> = SHIPPED_WORKFLOWS,
): Promise<boolean> =>
  Exit.isSuccess(await harness.runWithShippedWorkflowServices(installCardWorkflows(sources)));

const readInstalledKeys = async (harness: ServerHarness): Promise<ReadonlyArray<string>> =>
  (
    await runEffect(
      harness.sql<{ readonly key: string }>`SELECT key FROM shipped_workflows ORDER BY key`,
    )
  ).map((row) => row.key);

/** Returns the names of the stored workflows, sorted. */
const readWorkflowNames = async ({
  base,
  token,
}: SetUpController): Promise<ReadonlyArray<string>> =>
  (await queryWorkflows(base, token)).items.map((workflow) => workflow.name).sort();

interface StoredNotification {
  readonly status: string;
  readonly kind: string;
  readonly subject: string;
  readonly body: string;
  readonly resolution: string | null;
  readonly actions: string;
}

const readFailureNotifications = (
  harness: ServerHarness,
): Promise<ReadonlyArray<StoredNotification>> =>
  runEffect(
    harness.sql<StoredNotification>`
      SELECT status, kind, subject, body, resolution, actions FROM notifications
      WHERE kind = 'core.shipped-workflow-failed' ORDER BY created_at, id`,
  );

describe("installing the shipped workflows", () => {
  it("stores both sources enabled, with their triggers, stamped as the system", async () => {
    await withSetUpController(async (controller) => {
      const { harness, base, token } = controller;
      expect(await boot(harness)).toBe(true);

      const page = await queryWorkflows(base, token);
      expect(page.items.map((workflow) => [workflow.name, workflow.enabled]).sort()).toEqual([
        ["Move a card to In review when its pull request opens", true],
        ["Move a card to Landed when its work is finished", true],
      ]);
      expect(await readInstalledKeys(harness)).toEqual(["card-in-review", "card-landed"]);

      const triggers = await queryTriggers(base, token);
      expect(triggers.map((trigger) => trigger.triggerId).sort()).toEqual([
        "pull_request_open",
        "work_finished",
      ]);
      for (const trigger of triggers) {
        expect(trigger.on).toMatchObject({ kind: "task.entityChanged" });
        expect(trigger.status).toBe("active");
      }

      const created = await harness.audit("workflow.created");
      expect(created.map((entry) => entry.actor)).toEqual(["system", "system"]);
    });
  });
});

describe("a key that was installed once", () => {
  it("is not installed again by a later boot", async () => {
    await withSetUpController(async (controller) => {
      expect(await boot(controller.harness)).toBe(true);
      const before = await queryWorkflows(controller.base, controller.token);

      expect(await boot(controller.harness)).toBe(true);

      expect(await queryWorkflows(controller.base, controller.token)).toEqual(before);
      expect(await controller.harness.audit("workflow.created")).toHaveLength(2);
    });
  });

  it("stays deleted after the user deletes it", async () => {
    await withSetUpController(async (controller) => {
      const { harness, base, token } = controller;
      await boot(harness);
      const landed = (await queryWorkflows(base, token)).items.find((workflow) =>
        workflow.name.includes("Landed"),
      )!;
      expect((await del(base, `/api/v1/workflows/${landed.id}`, token)).status).toBe(200);

      expect(await boot(harness)).toBe(true);

      expect(await readWorkflowNames(controller)).toEqual([
        "Move a card to In review when its pull request opens",
      ]);
      expect(await readInstalledKeys(harness)).toEqual(["card-in-review", "card-landed"]);
    });
  });

  it("keeps the user's edit", async () => {
    await withSetUpController(async (controller) => {
      const { harness, base, token } = controller;
      await boot(harness);
      const inReview = (await queryWorkflows(base, token)).items.find((workflow) =>
        workflow.name.includes("In review"),
      )!;
      const edited = buildFileTaskSource("My own card rule");
      const response = await updateWorkflow(base, token, inReview.id, { source: edited });
      expect(response.status, await response.clone().text()).toBe(200);

      expect(await boot(harness)).toBe(true);

      const stored = await get(base, `/api/v1/workflows/${inReview.id}`, token);
      expect(((await stored.json()) as Workflow).source).toBe(edited);
      expect(await readWorkflowNames(controller)).toEqual([
        "Move a card to Landed when its work is finished",
        "My own card rule",
      ]);
    });
  });
});

describe("a source that does not validate", () => {
  const FAILING_KEYS = ["card-landed", "card-other"] as const;

  const buildSources = (landedSource: string): ReadonlyArray<ShippedWorkflowSource> => [
    SHIPPED_WORKFLOWS[0]!,
    { key: "card-landed", source: landedSource },
    { key: "card-other", source: BROKEN_SOURCE },
  ];

  it("installs nothing, lets the boot go on, and raises one notification for each failing key", async () => {
    await withSetUpController(async (controller) => {
      const { harness } = controller;

      expect(await boot(harness, buildSources(BROKEN_SOURCE))).toBe(true);

      expect(await readWorkflowNames(controller)).toEqual([]);
      expect(await readInstalledKeys(harness)).toEqual([]);
      const notifications = await readFailureNotifications(harness);
      expect(notifications.map((one) => JSON.parse(one.subject) as unknown)).toEqual(
        FAILING_KEYS.map((key) => [{ kind: "shippedWorkflow", id: key }]),
      );
      for (const one of notifications) {
        // A decision with a Dismiss answer: it stays open until the next boot withdraws it.
        expect(one.status).toBe("open");
        expect(JSON.parse(one.actions)).toEqual([
          { id: "dismiss", label: "Dismiss", operation: null },
        ]);
        expect(one.body).toContain("nothing.at-all");
      }
    });
  });

  it("raises no second notification while the first is open, and withdraws both when a boot installs the keys", async () => {
    await withSetUpController(async (controller) => {
      const { harness } = controller;
      await boot(harness, buildSources(BROKEN_SOURCE));
      await boot(harness, buildSources(BROKEN_SOURCE));
      expect(await readFailureNotifications(harness)).toHaveLength(2);

      expect(
        await boot(harness, [
          { key: "card-landed", source: buildFileTaskSource("Landed, fixed") },
          { key: "card-other", source: buildFileTaskSource("Other, fixed") },
        ]),
      ).toBe(true);

      expect(await readWorkflowNames(controller)).toEqual(["Landed, fixed", "Other, fixed"]);
      const notifications = await readFailureNotifications(harness);
      expect(notifications).toHaveLength(2);
      for (const one of notifications) {
        expect(one.status).toBe("resolved");
        expect(JSON.parse(one.resolution!)).toMatchObject({
          kind: "withdrawn",
          reason: "installed",
        });
      }
    });
  });
});
