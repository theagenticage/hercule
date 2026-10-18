/**
 * Tests `revalidateStoredWorkflows` and the notification body it writes. The
 * HTTP tests break a workflow by disabling a plugin or deleting an Agent;
 * these tests break it by writing its stored definition directly, so they
 * check the method alone: when it marks, when it clears, and what it writes.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CurrentActor, type Actor } from "../actor";
import { uuidFromString, withTransaction } from "../db";
import { EventKindsLayer } from "../events";
import { readEventsOfKind } from "../events/testing";
import { readNotificationBodiesAbout } from "../notifications/testing";
import { EventKindCatalogLayer, PluginHost } from "../plugins";
import { buildPluginStack } from "../plugins/testing";
import { SettingsLayer } from "../settings";
import {
  WorkflowRuns,
  WorkflowService,
  WorkflowServiceLayer,
  WorkflowSignals,
  WorkflowValidity,
  WorkflowValidityLayer,
} from "./index";
import { buildFileTaskSource } from "./testing";
import { describeInvalidWorkflow } from "./validity";

type Deps = WorkflowService | WorkflowValidity | PluginHost | SqlClient.SqlClient;

const layer = Layer.mergeAll(WorkflowServiceLayer, WorkflowValidityLayer).pipe(
  Layer.provideMerge(EventKindsLayer.pipe(Layer.provide(EventKindCatalogLayer))),
  Layer.provide(Layer.succeed(WorkflowRuns)({ hasUnfinishedRun: () => Effect.succeed(false) })),
  Layer.provide(Layer.succeed(WorkflowSignals)({ readKind: () => Effect.succeedNone })),
  Layer.provideMerge(SettingsLayer),
  Layer.provideMerge(buildPluginStack()),
);

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

/**
 * Runs `effect` as the user, after booting the plugin host with no plugins so
 * that the built-in actions, such as `task.create`, are registered.
 */
const run = <A, E>(effect: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(
    Effect.andThen(
      Effect.flatMap(PluginHost, (host) => host.boot([])),
      effect,
    ).pipe(Effect.provideService(CurrentActor, USER), Effect.provide(layer)),
  );

/**
 * Sets the action of the stored workflow's first step, bypassing validation,
 * as if the action had been registered once and has gone since.
 */
const setStoredAction = (workflowId: string, action: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.asVoid(
      withTransaction(
        sql,
        sql`
      UPDATE workflows SET definition = json_set(definition, '$.steps[0].action', ${action})
      WHERE id = ${uuidFromString(workflowId)}`,
      ),
    ),
  );

/** Returns the invalid mark of the stored workflow, as `workflow.read` returns it. */
const readInvalidSince = (workflowId: string) =>
  Effect.map(
    Effect.flatMap(WorkflowService, (workflows) => workflows.read(workflowId)),
    (workflow) => workflow.invalidSince,
  );

const revalidate = Effect.flatMap(WorkflowValidity, (validity) =>
  validity.revalidateStoredWorkflows(),
);

describe("revalidateStoredWorkflows", () => {
  it("leaves a valid workflow unmarked and writes nothing", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { workflow } = yield* (yield* WorkflowService).create({
          source: buildFileTaskSource("Valid"),
        });
        yield* revalidate;
        return {
          invalidSince: yield* readInvalidSince(workflow.id),
          invalidated: yield* readEventsOfKind("workflow.invalidated"),
          revalidated: yield* readEventsOfKind("workflow.revalidated"),
        };
      }),
    );
    expect(result).toEqual({ invalidSince: undefined, invalidated: [], revalidated: [] });
  });

  it("marks a workflow that stopped validating once, and clears the mark once it validates again", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { workflow } = yield* (yield* WorkflowService).create({
          source: buildFileTaskSource("Breaks"),
        });
        yield* setStoredAction(workflow.id, "gone/action");
        yield* revalidate;
        const markedAt = yield* readInvalidSince(workflow.id);
        // A second pass finds the workflow still invalid and changes nothing.
        yield* revalidate;
        const stillMarkedAt = yield* readInvalidSince(workflow.id);
        const bodies = yield* readNotificationBodiesAbout("core.workflow-invalid", {
          kind: "workflow",
          id: workflow.id,
        });

        yield* setStoredAction(workflow.id, "task.create");
        yield* revalidate;
        return {
          workflowId: workflow.id,
          markedAt,
          stillMarkedAt,
          bodies,
          clearedTo: yield* readInvalidSince(workflow.id),
          invalidated: yield* readEventsOfKind("workflow.invalidated"),
          revalidated: yield* readEventsOfKind("workflow.revalidated"),
        };
      }),
    );

    expect(result.markedAt).toEqual(expect.any(String));
    expect(result.stillMarkedAt).toBe(result.markedAt);
    expect(result.bodies).toHaveLength(1);
    expect(result.bodies[0]).toContain("its triggers start no runs and `run.start` refuses it");
    expect(result.bodies[0]).toContain("gone/action");
    expect(result.clearedTo).toBeUndefined();
    for (const entries of [result.invalidated, result.revalidated]) {
      expect(entries.map(({ actor, payload }) => ({ actor, payload }))).toEqual([
        { actor: "system", payload: { workflowId: result.workflowId } },
      ]);
    }
  });

  it("marks only the workflows that fail", async () => {
    const result = await run(
      Effect.gen(function* () {
        const workflows = yield* WorkflowService;
        const broken = (yield* workflows.create({ source: buildFileTaskSource("Broken") }))
          .workflow;
        const intact = (yield* workflows.create({ source: buildFileTaskSource("Intact") }))
          .workflow;
        yield* setStoredAction(broken.id, "gone/action");
        yield* revalidate;
        return {
          broken: yield* readInvalidSince(broken.id),
          intact: yield* readInvalidSince(intact.id),
        };
      }),
    );
    expect(result.broken).toEqual(expect.any(String));
    expect(result.intact).toBeUndefined();
  });

  it("marks a workflow whose stored definition no longer decodes, with its schema errors, and still judges the others", async () => {
    const result = await run(
      Effect.gen(function* () {
        const workflows = yield* WorkflowService;
        const create = (name: string) =>
          Effect.map(
            workflows.create({ source: buildFileTaskSource(name) }),
            ({ workflow }) => workflow.id,
          );
        const legacy = yield* create("Legacy");
        const broken = yield* create("Broken");
        const intact = yield* create("Intact");
        // An older controller accepted any spawn bound, so it could store one
        // over the limit a save enforces today.
        const sql = yield* SqlClient.SqlClient;
        yield* withTransaction(
          sql,
          sql`
          UPDATE workflows SET definition = json_set(definition, '$.triggers', json(${JSON.stringify(
            [
              {
                id: "on_task",
                kind: "start",
                on: { kind: "task.created" },
                spawnBound: { maxRuns: 20_000, windowSeconds: 3600 },
              },
            ],
          )}))
          WHERE id = ${uuidFromString(legacy)}`,
        );
        yield* setStoredAction(broken, "gone/action");
        yield* revalidate;
        return {
          legacy: yield* readInvalidSince(legacy),
          broken: yield* readInvalidSince(broken),
          intact: yield* readInvalidSince(intact),
          bodies: yield* readNotificationBodiesAbout("core.workflow-invalid", {
            kind: "workflow",
            id: legacy,
          }),
        };
      }),
    );
    expect(result.legacy).toEqual(expect.any(String));
    expect(result.broken).toEqual(expect.any(String));
    expect(result.intact).toBeUndefined();
    expect(result.bodies).toHaveLength(1);
    expect(result.bodies[0]).toContain("triggers.0.spawnBound.maxRuns");
  });
});

describe("describeInvalidWorkflow", () => {
  it("lists the first three errors with their paths and counts the rest", () => {
    const errors = ["a", "b", "c", "d", "e"].map((id) => ({
      path: ["steps", id],
      message: `Step ${id} is broken.`,
    }));
    const lines = describeInvalidWorkflow(errors).split("\n");
    expect(lines.slice(-5)).toEqual([
      "What did not validate:",
      "- ` steps.a: Step a is broken. `",
      "- ` steps.b: Step b is broken. `",
      "- ` steps.c: Step c is broken. `",
      "- and 2 more",
    ]);
  });

  it("adds no count when every error is listed", () => {
    const body = describeInvalidWorkflow([{ path: ["name"], message: "Name is missing." }]);
    expect(body.endsWith("What did not validate:\n- ` name: Name is missing. `")).toBe(true);
  });

  it("shows each error as inline code, so a quoted link or image is not rendered", () => {
    const body = describeInvalidWorkflow([
      { path: ["steps", "a"], message: "Unknown action `[x](http://evil.example)`." },
    ]);
    expect(body.split("\n").at(-1)).toBe(
      "- `` steps.a: Unknown action `[x](http://evil.example)`. ``",
    );
  });
});
