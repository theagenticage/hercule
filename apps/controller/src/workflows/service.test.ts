/**
 * Tests two rules of the workflow service that the HTTP tests cannot check
 * well: the default sort order of the workflow list, and what the event log
 * records about each write.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CurrentActor, type Actor } from "../actor";
import { AuditLog, EventKindsLayer } from "../events";
import { EventKindCatalogLayer, PluginHost } from "../plugins";
import { pluginStack } from "../plugins/testing";
import { WorkflowService, WorkflowServiceLayer } from "./index";
import { buildFileTaskSource } from "./testing";

type Deps = WorkflowService | AuditLog | PluginHost | SqlClient.SqlClient;

/**
 * Uses the real plugin host, because a save validates each step's action
 * against the built-in actions that the host registers.
 */
const layer = WorkflowServiceLayer.pipe(
  Layer.provideMerge(EventKindsLayer.pipe(Layer.provide(EventKindCatalogLayer))),
  Layer.provideMerge(pluginStack()),
);

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

/**
 * Runs `effect` as the user, after booting the plugin host with no plugins so
 * that the built-in actions are registered.
 *
 * The clock is a `TestClock`, so a test makes a later write get a later
 * timestamp by moving the clock, instead of depending on real time passing.
 */
const run = <A, E>(effect: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(
    Effect.andThen(
      Effect.flatMap(PluginHost, (host) => host.boot([])),
      effect,
    ).pipe(
      Effect.provideService(CurrentActor, USER),
      Effect.provide(layer),
      Effect.provide(TestClock.layer()),
    ),
  );

/** The description of every workflow in these tests. No event log entry may contain it. */
const SECRET_TEXT = "Read the private notes and say nothing of them";

/** Returns the YAML source of a workflow that files one task, described by `SECRET_TEXT`. */
const buildSource = (name: string): string => buildFileTaskSource(name, SECRET_TEXT);

describe("listing workflows", () => {
  it("sorts the most recently changed workflow first when no sort is given", async () => {
    const names = await run(
      Effect.gen(function* () {
        const workflows = yield* WorkflowService;
        const first = yield* workflows.create({ source: buildSource("First") });
        yield* TestClock.adjust("1 second");
        const second = yield* workflows.create({ source: buildSource("Second") });
        yield* TestClock.adjust("1 second");
        // A new source makes the first workflow the most recently changed.
        yield* workflows.update({ id: first.workflow.id, source: buildSource("First, edited") });
        yield* TestClock.adjust("1 second");
        // Enabling a workflow does not change its source, so the order stays the same.
        yield* workflows.update({ id: second.workflow.id, enabled: true });
        const page = yield* workflows.query({});
        return page.items.map((item) => item.name);
      }),
    );

    expect(names).toEqual(["First, edited", "Second"]);
  });
});

describe("event log entries for workflow writes", () => {
  it("record the workflow id and its name or changed fields, and never the source", async () => {
    const entries = await run(
      Effect.gen(function* () {
        const workflows = yield* WorkflowService;
        const audit = yield* AuditLog;
        const created = yield* workflows.create({ source: buildSource("Audited") });
        yield* workflows.update({ id: created.workflow.id, source: buildSource("Audited again") });
        yield* workflows.delete({ id: created.workflow.id });
        return [
          ...(yield* audit.listByKind("workflow.created")),
          ...(yield* audit.listByKind("workflow.updated")),
          ...(yield* audit.listByKind("workflow.deleted")),
        ];
      }),
    );

    expect(entries.map((entry) => entry.payload)).toEqual([
      { workflowId: expect.any(String) as unknown, name: "Audited" },
      { workflowId: expect.any(String) as unknown, changed: ["source"] },
      { workflowId: expect.any(String) as unknown, name: "Audited again" },
    ]);
    for (const entry of entries) {
      expect(JSON.stringify(entry.payload)).not.toContain(SECRET_TEXT);
    }
  });

  it("are written once per update, and list in changed only the fields that changed", async () => {
    const changes = await run(
      Effect.gen(function* () {
        const workflows = yield* WorkflowService;
        const audit = yield* AuditLog;
        const source = buildSource("Unchanged");
        const { workflow } = yield* workflows.create({ source });
        // Same source, same enabled state.
        yield* workflows.update({ id: workflow.id, source, enabled: false });
        // Same source, new enabled state.
        yield* workflows.update({ id: workflow.id, source, enabled: true });
        // New source, same enabled state.
        yield* workflows.update({ id: workflow.id, source: buildSource("Changed"), enabled: true });
        return (yield* audit.listByKind("workflow.updated")).map((entry) => entry.payload.changed);
      }),
    );

    expect(changes).toEqual([[], ["enabled"], ["source"]]);
  });
});
