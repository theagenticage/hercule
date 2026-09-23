/**
 * Two rules of the workflow service that the wire does not show well: the
 * order a listing answers in when the caller names none, and what the event
 * log is told about a save.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CurrentActor, type Actor } from "../actor";
import { TestDatabase } from "../db/testing";
import { AuditLog, AuditLogLayer } from "../events";
import { WorkflowService, WorkflowServiceLayer } from "./index";

type Deps = WorkflowService | AuditLog | SqlClient.SqlClient;

const layer = WorkflowServiceLayer.pipe(
  Layer.provideMerge(AuditLogLayer),
  Layer.provideMerge(TestDatabase),
);

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

/** Every test runs on a `TestClock`, so a later write is later by a clock step and not by a race. */
const run = <A, E>(effect: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(CurrentActor, USER),
      Effect.provide(layer),
      Effect.provide(TestClock.layer()),
    ),
  );

/** The text of a prompt that no audit entry may repeat. */
const SECRET_PROMPT = "Read the private notes and say nothing of them";

const buildSource = (name: string): string =>
  [
    `name: ${name}`,
    "steps:",
    "  - id: review",
    "    kind: agent",
    "    agent: 0199e0e7-1111-7000-8000-0000000000ab",
    `    prompt: ${SECRET_PROMPT}`,
    "",
  ].join("\n");

describe("the workflow listing", () => {
  it("answers the workflow changed last first when the caller names no order", async () => {
    const names = await run(
      Effect.gen(function* () {
        const workflows = yield* WorkflowService;
        const first = yield* workflows.create({ source: buildSource("First") });
        yield* TestClock.adjust("1 second");
        yield* workflows.create({ source: buildSource("Second") });
        yield* TestClock.adjust("1 second");
        // An edit makes the first workflow the one changed last.
        yield* workflows.update({ id: first.workflow.id, enabled: true });
        const page = yield* workflows.query({});
        return page.items.map((item) => item.name);
      }),
    );

    expect(names).toEqual(["First", "Second"]);
  });
});

describe("what the event log is told about a workflow", () => {
  it("names the workflow and what changed, and never repeats the source", async () => {
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
      expect(JSON.stringify(entry.payload)).not.toContain(SECRET_PROMPT);
    }
  });
});
