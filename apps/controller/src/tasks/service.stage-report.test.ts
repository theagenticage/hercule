/**
 * Tests `task.reportStage` through the Task service on real rows: each outcome
 * of the table in spec 09 ("Stage reports") and the order they are checked in,
 * who may report, what a moved report writes, and how other stage writes treat
 * the cause a report leaves.
 *
 * The lead is set directly on the Task row: how a lead is elected is tested
 * with the lead rules.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import type { TaskStage } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { mintUuid, uuidFromString, uuidToString, withTransaction } from "../db";
import { readEventsOfKind } from "../events/testing";
import { TaskService } from "./index";
import {
  A_MINUTE,
  arrange,
  arrangeConnection,
  createTaskLinking,
  pr,
  run,
  setLifecycle,
} from "./testing";

const sessionActor = (sessionId: string): Actor =>
  ({
    _tag: "session",
    sessionId,
    profileId: "0199e0e7-0003-7000-8000-000000000000",
    grants: ["task.update"],
    profileGrants: ["task.update"],
    assistantId: null,
    agentId: null,
  }) as unknown as Actor;

const RUN: Actor = {
  _tag: "run",
  runId: "0199e0e7-0004-7000-8000-000000000000",
  stepId: "move",
  workflowId: null,
};

/** The Thread that leads the Task of a story, and a helper Agent session on it. */
interface Cast {
  readonly taskId: string;
  readonly lead: string;
  readonly helper: string;
}

const insertSession = (
  id: string,
  kind: "thread" | "agent",
  title: string,
  taskId: string | null,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* withTransaction(
      sql,
      sql`
      INSERT INTO sessions (id, agent_id, permission_profile_id, provider_account_id, runner_id,
                            requested_access_mode, access_mode, spec, title, status, created_at,
                            last_activity_at, task_id, harness_id)
      VALUES (${uuidFromString(id)}, ${kind === "agent" ? mintUuid() : null}, randomblob(16), randomblob(16), randomblob(16),
              'approval-required', 'approval-required', '{}', ${title}, 'idle',
              '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z',
              ${taskId === null ? null : uuidFromString(taskId)}, 'test/test')`,
    );
  });

/** Creates a Task at `stage` that links `refs`, led by a Thread called "Pricing research". */
const arrangeLedTask = (stage: TaskStage, ...refs: ReadonlyArray<ReturnType<typeof pr>>) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(A_MINUTE);
    const tasks = yield* TaskService;
    const sql = yield* SqlClient.SqlClient;
    const task = yield* tasks.create({
      title: `At ${stage}`,
      description: "",
      stage,
      provenance: refs.map((ref) => ({ ref })),
    });
    const lead = mintUuid();
    const helper = mintUuid();
    const leadId = uuidToString(lead);
    const helperId = uuidToString(helper);
    yield* insertSession(leadId, "thread", "Pricing research", task.id);
    yield* insertSession(helperId, "agent", "Helper", task.id);
    yield* withTransaction(
      sql,
      sql`UPDATE tasks SET lead_session_id = ${lead} WHERE id = ${uuidFromString(task.id)}`,
    );
    return { taskId: task.id, lead: leadId, helper: helperId } satisfies Cast;
  });

const report = (by: string, stage: TaskStage) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(A_MINUTE);
    const tasks = yield* TaskService;
    return yield* tasks
      .reportStage({ stage })
      .pipe(Effect.provideService(CurrentActor, sessionActor(by)));
  });

/** Returns the code and message of the API error a refused call fails with. */
const readRefusal = (error: unknown) =>
  (error as { readonly error: { readonly code: string; readonly message: string } }).error;

/** Writes a stage as a person does, by `task.update`. */
const drag = (taskId: string, stage: TaskStage) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(A_MINUTE);
    const tasks = yield* TaskService;
    yield* tasks.update({ id: taskId, stage });
  });

/** Sends the stage write a workflow sends when a fact arrives. */
const deliverFact = (taskId: string, factId: number, stage: TaskStage) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(A_MINUTE);
    const tasks = yield* TaskService;
    yield* tasks
      .update({ id: taskId, stage, stageFactId: factId })
      .pipe(Effect.provideService(CurrentActor, RUN));
  });

interface Row {
  readonly stage: string;
  readonly fence: number;
  readonly causeFact: number | null;
  readonly causeSession: string | null;
  readonly stageRevision: number;
}

const readRow = (taskId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{
      readonly stage: string;
      readonly stage_fact_fence: number;
      readonly stage_cause_fact_id: number | null;
      readonly stage_cause_session_id: Uint8Array | null;
      readonly stage_revision: number;
    }>`SELECT stage, stage_fact_fence, stage_cause_fact_id, stage_cause_session_id, stage_revision
       FROM tasks WHERE id = ${uuidFromString(taskId)}`;
    return {
      stage: row!.stage,
      fence: row!.stage_fact_fence,
      causeFact: row!.stage_cause_fact_id,
      causeSession:
        row!.stage_cause_session_id === null ? null : uuidToString(row!.stage_cause_session_id),
      stageRevision: row!.stage_revision,
    } satisfies Row;
  });

const readAudit = Effect.map(readEventsOfKind("task.stageReported"), (events) =>
  events.map((event) => event.payload),
);

/** A Task at `stage` whose open pull request has put it there by a fact. */
const arrangeFactPlacedTask = (stage: TaskStage) =>
  Effect.gen(function* () {
    yield* arrangeConnection;
    yield* arrange({ ref: pr(1), lifecycle: "open", identifier: "#1" });
    const cast = yield* arrangeLedTask("planned", pr(1)); // the link writes fact 1
    yield* deliverFact(cast.taskId, 1, stage);
    return cast;
  });

describe("task.reportStage", () => {
  describe("the outcome table", () => {
    it("moves the card to the reported stage", async () => {
      const { answer, row } = await run(
        Effect.gen(function* () {
          const cast = yield* arrangeLedTask("exploring");
          const answer = yield* report(cast.lead, "planned");
          return { answer, row: yield* readRow(cast.taskId) };
        }),
      );
      expect(answer).toEqual({ outcome: "moved", message: "Moved to Planned." });
      expect(row.stage).toBe("planned");
    });

    it("keeps a finished Task where it is", async () => {
      const answer = await run(
        Effect.gen(function* () {
          const cast = yield* arrangeLedTask("done");
          return yield* report(cast.lead, "planned");
        }),
      );
      expect(answer.outcome).toBe("finished");
      expect(answer.message).toBe("Kept at Done: the Task is finished.");
    });

    it("answers already when the Task has the stage", async () => {
      const answer = await run(
        Effect.gen(function* () {
          const cast = yield* arrangeLedTask("planned");
          return yield* report(cast.lead, "planned");
        }),
      );
      expect(answer).toEqual({ outcome: "already", message: "Already at Planned." });
    });

    it("keeps a stage a fact placed while something linked is open", async () => {
      const { answer, row } = await run(
        Effect.gen(function* () {
          const cast = yield* arrangeFactPlacedTask("in-review");
          const answer = yield* report(cast.lead, "building");
          return { answer, row: yield* readRow(cast.taskId) };
        }),
      );
      expect(answer.outcome).toBe("fact");
      expect(answer.message).toContain("Kept at In review");
      expect(row.stage).toBe("in-review");
    });

    it("moves the card when the fact that placed it was voided by an unlink", async () => {
      const { answer, row } = await run(
        Effect.gen(function* () {
          const cast = yield* arrangeFactPlacedTask("in-review");
          yield* arrange({ ref: pr(2), lifecycle: "open", identifier: "#2" });
          const tasks = yield* TaskService;
          // Another open link keeps openLinks above zero, so only the void decides.
          yield* tasks.linkEntity({ id: cast.taskId, ref: pr(2) });
          yield* tasks.unlinkEntity({ id: cast.taskId, ref: pr(1) });
          const answer = yield* report(cast.lead, "building");
          return { answer, row: yield* readRow(cast.taskId) };
        }),
      );
      expect(answer.outcome).toBe("moved");
      expect(row).toMatchObject({ stage: "building", causeFact: null });
    });

    it("moves the card when nothing linked is open any more, a pull request closed unmerged", async () => {
      const { answer, row } = await run(
        Effect.gen(function* () {
          const cast = yield* arrangeFactPlacedTask("in-review");
          const sql = yield* SqlClient.SqlClient;
          yield* withTransaction(sql, setLifecycle(pr(1), "abandoned"));
          const answer = yield* report(cast.lead, "building");
          return { answer, row: yield* readRow(cast.taskId) };
        }),
      );
      expect(answer.outcome).toBe("moved");
      expect(row.stage).toBe("building");
    });

    it("keeps the card out of Landed while something linked is open", async () => {
      const answer = await run(
        Effect.gen(function* () {
          yield* arrangeConnection;
          yield* arrange({ ref: pr(1), lifecycle: "open", identifier: "#1" });
          const cast = yield* arrangeLedTask("building", pr(1));
          return yield* report(cast.lead, "landed");
        }),
      );
      expect(answer.outcome).toBe("open-links");
    });

    it("lands the card once nothing linked is open", async () => {
      const answer = await run(
        Effect.gen(function* () {
          yield* arrangeConnection;
          yield* arrange({ ref: pr(1), lifecycle: "open", identifier: "#1" });
          const cast = yield* arrangeLedTask("building", pr(1));
          const sql = yield* SqlClient.SqlClient;
          yield* withTransaction(sql, setLifecycle(pr(1), "completed"));
          return yield* report(cast.lead, "landed");
        }),
      );
      expect(answer.outcome).toBe("moved");
    });
  });

  describe("the order the rules are checked in", () => {
    it("answers fact, not open-links, for Landed on a stage a fact placed", async () => {
      const answer = await run(
        Effect.gen(function* () {
          const cast = yield* arrangeFactPlacedTask("in-review");
          return yield* report(cast.lead, "landed");
        }),
      );
      expect(answer.outcome).toBe("fact");
    });

    it("answers repeat, not fact, for the stage reported last while a fact stands", async () => {
      const { outcome, row } = await run(
        Effect.gen(function* () {
          yield* arrangeConnection;
          yield* arrange({ ref: pr(1), lifecycle: "open", identifier: "#1" });
          const cast = yield* arrangeLedTask("exploring", pr(1));
          yield* report(cast.lead, "building"); // the claim
          yield* deliverFact(cast.taskId, 1, "in-review"); // a fact takes the card, open link
          const answer = yield* report(cast.lead, "building");
          return { outcome: answer.outcome, row: yield* readRow(cast.taskId) };
        }),
      );
      expect(outcome).toBe("repeat");
      expect(row).toMatchObject({ stage: "in-review", causeFact: 1 });
    });

    it("keeps a repeat from undoing a drag, while a different claim moves the card", async () => {
      const stages = await run(
        Effect.gen(function* () {
          const cast = yield* arrangeLedTask("exploring");
          yield* report(cast.lead, "planned");
          yield* drag(cast.taskId, "building");
          const repeat = yield* report(cast.lead, "planned");
          const afterRepeat = (yield* readRow(cast.taskId)).stage;
          const different = yield* report(cast.lead, "exploring");
          return { repeat: repeat.outcome, afterRepeat, different: different.outcome };
        }),
      );
      expect(stages).toEqual({ repeat: "repeat", afterRepeat: "building", different: "moved" });
    });

    it("checks a repeat against the Task's claim, whoever made it", async () => {
      const answer = await run(
        Effect.gen(function* () {
          const cast = yield* arrangeLedTask("exploring");
          yield* report(cast.lead, "planned");
          yield* drag(cast.taskId, "building");
          // A new lead takes over the Task and repeats the old lead's claim.
          const sql = yield* SqlClient.SqlClient;
          const successor = mintUuid();
          yield* insertSession(uuidToString(successor), "thread", "Successor", cast.taskId);
          yield* withTransaction(
            sql,
            sql`UPDATE tasks SET lead_session_id = ${successor}
                WHERE id = ${uuidFromString(cast.taskId)}`,
          );
          return yield* report(uuidToString(successor), "planned");
        }),
      );
      expect(answer.outcome).toBe("repeat");
    });
  });

  describe("who may report", () => {
    it("refuses a helper, naming the lead, and writes nothing", async () => {
      const { error, claims, audit } = await run(
        Effect.gen(function* () {
          const cast = yield* arrangeLedTask("exploring");
          const sql = yield* SqlClient.SqlClient;
          const error = yield* Effect.flip(report(cast.helper, "planned"));
          const claims = yield* sql`SELECT 1 FROM task_stage_reports`;
          return { error, claims: claims.length, audit: yield* readAudit };
        }),
      );
      expect(readRefusal(error)).toMatchObject({
        code: "invalid_state",
        message:
          "Only the Thread that leads this Task reports its stage: “Pricing research”. Tell it what you found instead.",
      });
      expect(claims).toBe(0);
      expect(audit).toEqual([]);
    });

    it("refuses the user", async () => {
      const error = await run(
        Effect.gen(function* () {
          const tasks = yield* TaskService;
          return yield* Effect.flip(tasks.reportStage({ stage: "planned" }));
        }),
      );
      expect(readRefusal(error)).toMatchObject({
        code: "invalid_state",
        message:
          "Only an agent session reports a stage. To move a card yourself, use `hercule task move`.",
      });
    });

    it("refuses a session that is on no Task", async () => {
      const error = await run(
        Effect.gen(function* () {
          const loose = uuidToString(mintUuid());
          yield* insertSession(loose, "thread", "Loose", null);
          return yield* Effect.flip(report(loose, "planned"));
        }),
      );
      expect(readRefusal(error).code).toBe("invalid_state");
      expect(readRefusal(error).message).toContain("on no Task");
    });

    it("refuses a report on a Task with no lead", async () => {
      const error = await run(
        Effect.gen(function* () {
          const cast = yield* arrangeLedTask("exploring");
          const sql = yield* SqlClient.SqlClient;
          yield* withTransaction(
            sql,
            sql`UPDATE tasks SET lead_session_id = NULL WHERE id = ${uuidFromString(cast.taskId)}`,
          );
          return yield* Effect.flip(report(cast.helper, "planned"));
        }),
      );
      expect(readRefusal(error).message).toContain("No Thread leads this Task");
    });
  });

  describe("what a moved report writes", () => {
    it("leaves the fence, sets the report cause, raises the stage revision, and announces once", async () => {
      const result = await run(
        Effect.gen(function* () {
          yield* arrangeConnection;
          yield* arrange({ ref: pr(1), lifecycle: "open", identifier: "#1" });
          const cast = yield* arrangeLedTask("planned", pr(1));
          yield* deliverFact(cast.taskId, 1, "in-review"); // fence 1, cause fact 1
          // A drag clears the fact cause, so the report is not refused for a fact.
          yield* drag(cast.taskId, "planned");
          const sql = yield* SqlClient.SqlClient;
          const other = yield* createTaskLinking("Neighbour");
          yield* withTransaction(
            sql,
            sql`UPDATE tasks SET stage = 'building', board_rank = 'zzz'
                WHERE id = ${uuidFromString(other.id)}`,
          );
          const before = yield* readRow(cast.taskId);
          const updatesBefore = (yield* readEventsOfKind("task.updated")).length;
          yield* report(cast.lead, "building");
          const after = yield* readRow(cast.taskId);
          const updates = (yield* readEventsOfKind("task.updated")).slice(updatesBefore);
          const [ranks] = yield* sql<{ readonly last: number }>`
            SELECT board_rank = (SELECT max(board_rank) FROM tasks WHERE stage = 'building') AS last
            FROM tasks WHERE id = ${uuidFromString(cast.taskId)}`;
          return { before, after, updates, last: ranks!.last, lead: cast.lead };
        }),
      );
      expect(result.after.stage).toBe("building");
      expect(result.after.fence).toBe(result.before.fence);
      expect(result.after.causeFact).toBeNull();
      expect(result.after.causeSession).toBe(result.lead);
      expect(result.after.stageRevision).toBe(result.before.stageRevision + 1);
      expect(result.last).toBe(1);
      expect(result.updates).toHaveLength(1);
      expect(result.updates[0]!.actor).toBe(`session:${result.lead}`);
    });

    it("stores the claim, replacing the previous one", async () => {
      const rows = await run(
        Effect.gen(function* () {
          const cast = yield* arrangeLedTask("exploring");
          yield* report(cast.lead, "planned");
          yield* report(cast.lead, "building");
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ readonly stage: string }>`SELECT stage FROM task_stage_reports`;
        }),
      );
      expect(rows.map((row) => row.stage)).toEqual(["building"]);
    });
  });

  describe("how other writes treat a report's cause", () => {
    it("lets a fact after a report apply, and clears the report cause", async () => {
      const row = await run(
        Effect.gen(function* () {
          yield* arrangeConnection;
          yield* arrange({ ref: pr(1), lifecycle: "open", identifier: "#1" });
          const cast = yield* arrangeLedTask("exploring", pr(1));
          yield* report(cast.lead, "building");
          yield* deliverFact(cast.taskId, 1, "in-review");
          return yield* readRow(cast.taskId);
        }),
      );
      expect(row).toMatchObject({ stage: "in-review", causeFact: 1, causeSession: null });
    });

    it("lets a fact that agrees with the reported stage take the cause over", async () => {
      const { row, answer } = await run(
        Effect.gen(function* () {
          yield* arrangeConnection;
          yield* arrange({ ref: pr(1), lifecycle: "open", identifier: "#1" });
          const cast = yield* arrangeLedTask("exploring", pr(1));
          yield* report(cast.lead, "in-review");
          yield* deliverFact(cast.taskId, 1, "in-review");
          const answer = yield* report(cast.lead, "building");
          return { row: yield* readRow(cast.taskId), answer };
        }),
      );
      expect(row).toMatchObject({ stage: "in-review", causeFact: 1, causeSession: null });
      expect(answer.outcome).toBe("fact");
    });

    it("keeps the report cause when a fact that would agree is refused", async () => {
      const row = await run(
        Effect.gen(function* () {
          yield* arrangeConnection;
          yield* arrange({ ref: pr(1), lifecycle: "open", identifier: "#1" });
          const cast = yield* arrangeLedTask("exploring", pr(1));
          yield* report(cast.lead, "in-review");
          // A person decided after the fact, so the fact is at or below the fence.
          yield* drag(cast.taskId, "in-review");
          yield* report(cast.lead, "planned");
          yield* deliverFact(cast.taskId, 1, "planned");
          return yield* readRow(cast.taskId);
        }),
      );
      expect(row.causeSession).not.toBeNull();
      expect(row.causeFact).toBeNull();
    });

    it("clears the report cause on a drag by task.update and on task.move", async () => {
      const rows = await run(
        Effect.gen(function* () {
          const cast = yield* arrangeLedTask("exploring");
          yield* report(cast.lead, "planned");
          const reported = yield* readRow(cast.taskId);
          yield* drag(cast.taskId, "building");
          const updated = yield* readRow(cast.taskId);
          yield* report(cast.lead, "exploring");
          const reportedAgain = yield* readRow(cast.taskId);
          const tasks = yield* TaskService;
          yield* tasks.move({ id: cast.taskId, stage: "planned" });
          const moved = yield* readRow(cast.taskId);
          return { reported, updated, reportedAgain, moved };
        }),
      );
      expect(rows.reported.causeSession).not.toBeNull();
      expect(rows.updated.causeSession).toBeNull();
      expect(rows.reportedAgain.causeSession).not.toBeNull();
      expect(rows.moved.causeSession).toBeNull();
    });

    it("clears the report cause when a drag keeps the stage", async () => {
      const row = await run(
        Effect.gen(function* () {
          const cast = yield* arrangeLedTask("exploring");
          yield* report(cast.lead, "planned");
          yield* drag(cast.taskId, "planned");
          return yield* readRow(cast.taskId);
        }),
      );
      expect(row.causeSession).toBeNull();
    });
  });

  describe("the audit entry", () => {
    it("records every outcome with the ids and words only", async () => {
      const { audit, lead, taskId } = await run(
        Effect.gen(function* () {
          const cast = yield* arrangeLedTask("exploring");
          yield* report(cast.lead, "planned"); // moved
          yield* report(cast.lead, "planned"); // repeat
          yield* report(cast.lead, "building"); // moved
          yield* report(cast.lead, "building"); // repeat
          yield* drag(cast.taskId, "exploring");
          yield* report(cast.lead, "planned"); // moved again
          yield* drag(cast.taskId, "done");
          yield* report(cast.lead, "landed"); // finished
          return { audit: yield* readAudit, lead: cast.lead, taskId: cast.taskId };
        }),
      );
      expect(audit.map((entry) => entry["outcome"])).toEqual([
        "moved",
        "repeat",
        "moved",
        "repeat",
        "moved",
        "finished",
      ]);
      expect(audit[0]).toEqual({ taskId, sessionId: lead, stage: "planned", outcome: "moved" });
    });

    it("records already, fact and open-links", async () => {
      const audit = await run(
        Effect.gen(function* () {
          yield* arrangeConnection;
          yield* arrange({ ref: pr(1), lifecycle: "open", identifier: "#1" });
          const already = yield* arrangeLedTask("planned");
          yield* report(already.lead, "planned");
          const fact = yield* arrangeLedTask("planned", pr(1));
          yield* deliverFact(fact.taskId, 1, "in-review");
          yield* report(fact.lead, "building");
          const open = yield* arrangeLedTask("building", pr(1));
          yield* report(open.lead, "landed");
          return yield* readAudit;
        }),
      );
      expect(audit.map((entry) => entry["outcome"])).toEqual(["already", "fact", "open-links"]);
    });
  });
});
