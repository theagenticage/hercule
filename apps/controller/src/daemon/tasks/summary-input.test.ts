/**
 * Tests the model call that writes a Task Summary, on real rows:
 *
 * - what the input holds, and that it is read with a fixed number of
 *   statements however many sessions the Task has;
 * - that the input never passes 24 KiB, whatever the Task holds;
 * - that the answer's schema has the three texts and nothing else, and that
 *   an answer is cut at a word, never refused.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import type { SessionRequest } from "@hercule/contract";
import { lintOutputSchema } from "@hercule/protocol";
import { mintUuid, uuidFromString, uuidToString, withTransaction } from "../../db";
import { runRepository } from "../../runs";
import { inputRepository, sessionRepository } from "../../sessions";
import { taskRepository } from "../../tasks";
import { TestDatabase } from "../../db/testing";
import { TaskTrackingRunsLayer } from "../runs";
import {
  buildTaskSummaryCall,
  MAX_SUMMARY_INPUT_BYTES,
  parseSummaryAnswer,
  SUMMARY_OUTPUT_SCHEMA,
} from "./summary-input";

const AT = "2026-11-02T10:00:00.000Z";

/** A session of the Task to arrange: its words, and the question it waits on, if any. */
interface SessionFixture {
  readonly title: string;
  readonly firstPrompt: string;
  /** The text deltas of the session's own agent, oldest first. */
  readonly deltas?: ReadonlyArray<string>;
  readonly question?: string;
  /** Whether the session also waits on an approval, which the summary does not read. */
  readonly approval?: boolean;
}

interface RunFixture {
  readonly workflow: string;
  readonly failure?: string;
}

interface TaskFixture {
  readonly title?: string;
  readonly description?: string;
  /** Oldest first: each opens a minute after the one before. */
  readonly sessions?: ReadonlyArray<SessionFixture>;
  /** Oldest first. */
  readonly runs?: ReadonlyArray<RunFixture>;
}

const askQuestion = (text: string): SessionRequest => ({
  requestId: "q1",
  itemId: "item-q1",
  kind: "question",
  detail: { questions: [{ question: text, header: "Ask", options: [], multiSelect: false }] },
});

const askApproval = (): SessionRequest => ({
  requestId: "a1",
  itemId: "item-a1",
  kind: "command_approval",
  detail: { command: "pnpm test" },
  decisions: ["allow", "deny"],
});

/** What the model reads, as the JSON in the call. */
interface ReadInput {
  readonly task: { readonly title: string; readonly description: string };
  readonly sessions: ReadonlyArray<{
    readonly kind: string;
    readonly title: string;
    readonly firstPrompt: string;
    readonly latestAssistantText: string;
  }>;
  readonly runs: ReadonlyArray<{
    readonly workflow: string;
    readonly status: string;
    readonly failure?: string;
  }>;
  readonly openQuestions: ReadonlyArray<{ readonly question: string }>;
}

/** Writes the Task of `fixture`, builds its summary call, and returns the call and the statements it sent. */
const buildCallFor = (fixture: TaskFixture) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tasks = yield* taskRepository;
      const sessions = yield* sessionRepository;
      const inputs = yield* inputRepository;
      const runs = yield* runRepository;
      const taskId = yield* withTransaction(
        sql,
        Effect.gen(function* () {
          const task = yield* tasks.insert({
            title: fixture.title ?? "Plan the depot rollout",
            description: fixture.description ?? "",
            status: "open",
            stage: "building",
            priority: "normal",
            labels: [],
            projectId: undefined,
            provenance: [],
            at: AT,
            actor: "user",
          });
          for (const [index, session] of (fixture.sessions ?? []).entries()) {
            const sessionAt = `2026-11-02T10:${String(index).padStart(2, "0")}:00.000Z`;
            const id = uuidToString(mintUuid());
            yield* sessions.insert({
              id,
              title: session.title,
              role: undefined,
              permissionProfileId: uuidToString(mintUuid()),
              agentId: undefined,
              conversationId: undefined,
              step: undefined,
              providerAccountId: uuidToString(mintUuid()),
              harnessId: "test/test",
              runnerId: uuidToString(mintUuid()),
              workspaceId: null,
              projectId: undefined,
              taskId: task.id,
              checkoutBranch: undefined,
              githubConnectionId: undefined,
              requestedAccessMode: "approval-required",
              accessMode: "approval-required",
              spec: "{}",
              modelSelection: { model: "clever", options: {} },
              parentSessionId: undefined,
              createdBy: "user",
              at: sessionAt,
            });
            yield* inputs.insert({
              sessionId: id,
              source: "user",
              actor: "user",
              text: session.firstPrompt,
              at: sessionAt,
            });
            for (const [seq, delta] of (session.deltas ?? []).entries()) {
              yield* sessions.append(id, {
                seq: seq + 1,
                at: sessionAt,
                event: {
                  eventId: uuidToString(mintUuid()),
                  sessionId: id,
                  at: sessionAt,
                  _tag: "content.delta",
                  turnId: "t1",
                  itemId: "i1",
                  streamKind: "assistant_text",
                  delta,
                },
              });
            }
            if (session.question !== undefined || session.approval === true) {
              const requests: Array<SessionRequest> = [
                ...(session.approval === true ? [askApproval()] : []),
                ...(session.question === undefined ? [] : [askQuestion(session.question)]),
              ];
              yield* sql`
                UPDATE sessions SET status = 'busy', open_requests = ${JSON.stringify(requests)}
                WHERE id = ${uuidFromString(id)}`;
            }
          }
          for (const run of fixture.runs ?? []) {
            const runId = yield* runs.insert(
              {
                workflowId: null,
                plan: { name: run.workflow, steps: [] },
                inputs: {},
                origin: { kind: "manual", actor: "user" },
                entryStepIds: ["work"],
                taskId: task.id,
              },
              AT,
            );
            yield* runs.start(runId, AT);
            yield* runs.finish(
              runId,
              run.failure === undefined
                ? { status: "completed" }
                : {
                    status: "failed",
                    failureReason: "validation-error",
                    failureMessage: run.failure,
                  },
              AT,
            );
          }
          return task.id;
        }),
      );
      const statements: Array<string> = [];
      const built = yield* Effect.provideService(
        buildTaskSummaryCall(taskId),
        Statement.CurrentTransformer,
        (statement) =>
          Effect.sync(() => {
            statements.push(statement.compile()[0]);
            return statement;
          }),
      );
      return { taskId, built, statements };
    }).pipe(Effect.provide(TaskTrackingRunsLayer.pipe(Layer.provideMerge(TestDatabase)))),
  );

/** Builds the call of `fixture` and returns it with the input the model reads, parsed. */
const readCall = async (fixture: TaskFixture) => {
  const { built, statements } = await buildCallFor(fixture);
  const call = Option.getOrThrow(built);
  return { call, statements, input: JSON.parse(call.input) as ReadInput };
};

const byteSize = (text: string): number => new TextEncoder().encode(text).length;

describe("the call that writes a summary", () => {
  it("asks core:tasks for task.summary, fails when no runner can take it, and sends the schema", async () => {
    const { call } = await readCall({});

    expect(call).toMatchObject({
      caller: "core:tasks",
      purpose: "task.summary",
      whenNoRunner: "fail",
      outputSchema: SUMMARY_OUTPUT_SCHEMA,
    });
  });

  it("holds the Task, each session, the runs' facts and the open questions", async () => {
    const { input } = await readCall({
      title: "Plan the depot rollout",
      description: "Open three depots before the holidays.",
      sessions: [
        {
          title: "Compare depot sites",
          firstPrompt: "Compare the three sites we shortlisted.",
          deltas: ["Three designs ", "are ready."],
          question: "Which depot opens first?",
        },
      ],
      runs: [
        { workflow: "Check stock levels" },
        { workflow: "Order pallets", failure: "supplier offline" },
      ],
    });

    expect(input).toEqual({
      task: {
        title: "Plan the depot rollout",
        description: "Open three depots before the holidays.",
      },
      sessions: [
        {
          kind: "thread",
          title: "Compare depot sites",
          firstPrompt: "Compare the three sites we shortlisted.",
          latestAssistantText: "Three designs are ready.",
        },
      ],
      runs: [
        { workflow: "Order pallets", status: "failed", failure: "supplier offline" },
        { workflow: "Check stock levels", status: "completed" },
      ],
      openQuestions: [{ question: "Which depot opens first?" }],
    });
  });

  it("reads the newest four sessions, newest first, and cuts a first prompt to 1,000 characters", async () => {
    const { input } = await readCall({
      sessions: Array.from({ length: 6 }, (_, index) => ({
        title: `Session ${String(index)}`,
        firstPrompt: index === 5 ? "x".repeat(5000) : "short",
      })),
    });

    expect(input.sessions.map((session) => session.title)).toEqual([
      "Session 5",
      "Session 4",
      "Session 3",
      "Session 2",
    ]);
    expect(input.sessions[0]!.firstPrompt).toHaveLength(1000);
    expect(input.sessions[1]!.firstPrompt).toBe("short");
  });

  it("reads the questions of every Thread, an older one included, and leaves approvals out", async () => {
    const { input } = await readCall({
      sessions: [
        { title: "Oldest", firstPrompt: "Start", question: "Which depot opens first?" },
        ...Array.from({ length: 5 }, (_, index) => ({
          title: `Session ${String(index)}`,
          firstPrompt: "Start",
          ...(index === 2 ? { approval: true } : {}),
        })),
      ],
    });

    expect(input.sessions.map((session) => session.title)).not.toContain("Oldest");
    expect(input.openQuestions).toEqual([{ question: "Which depot opens first?" }]);
  });

  it("sends the same number of statements for 5 sessions and for 30", async () => {
    const sessions = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        title: `Session ${String(index)}`,
        firstPrompt: "Start",
        deltas: ["text"],
      }));
    const runs = [{ workflow: "Check stock levels" }];

    const small = await readCall({ sessions: sessions(5), runs });
    const large = await readCall({ sessions: sessions(30), runs });

    expect(large.statements).toHaveLength(small.statements.length);
    expect(large.input.sessions).toHaveLength(4);
  });

  it("builds nothing for a Task that does not exist", async () => {
    const built = await Effect.runPromise(
      buildTaskSummaryCall(uuidToString(mintUuid())).pipe(
        Effect.provide(TaskTrackingRunsLayer.pipe(Layer.provideMerge(TestDatabase))),
      ),
    );

    expect(Option.isNone(built)).toBe(true);
  });
});

describe("the size of the input", () => {
  /** Text whose JSON takes many bytes a character: two-byte letters, quotes and control characters. */
  const heavy = (length: number): string =>
    `é"\u0001`.repeat(Math.ceil(length / 3)).slice(0, length);

  it("never passes 24 KiB, for a Task with a huge description, long texts and many sessions", async () => {
    const { call } = await readCall({
      title: "t".repeat(512),
      description: heavy(64 * 1024),
      sessions: Array.from({ length: 8 }, (_, index) => ({
        title: `Session ${String(index)} ${"s".repeat(500)}`,
        firstPrompt: heavy(60_000),
        deltas: Array.from({ length: 10 }, () => heavy(4096)),
        question: "q".repeat(2000),
      })),
      runs: Array.from({ length: 8 }, (_, index) => ({
        workflow: `Workflow ${String(index)}`,
        failure: heavy(300),
      })),
    });

    expect(byteSize(call.input)).toBeLessThanOrEqual(MAX_SUMMARY_INPUT_BYTES);
    expect((JSON.parse(call.input) as ReadInput).sessions).toHaveLength(4);
  });

  it("cuts the largest text first: a long description gives way before the short facts", async () => {
    // Two bytes a character: the description takes 12,000 bytes, the four
    // first prompts 4,000 and the four assistant texts 10,000.
    const { call, input } = await readCall({
      title: "Plan the depot rollout",
      description: "é".repeat(6000),
      sessions: Array.from({ length: 4 }, (_, index) => ({
        title: `Session ${String(index)}`,
        firstPrompt: "p".repeat(1000),
        deltas: ["a".repeat(2500)],
      })),
      runs: [{ workflow: "Order pallets", failure: "supplier offline" }],
    });

    expect(byteSize(call.input)).toBeLessThanOrEqual(MAX_SUMMARY_INPUT_BYTES);
    expect(input.task.description.length).toBeLessThan(6000);
    expect(input.sessions.map((session) => session.firstPrompt.length)).toEqual([
      1000, 1000, 1000, 1000,
    ]);
    expect(input.sessions.map((session) => session.latestAssistantText.length)).toEqual([
      2500, 2500, 2500, 2500,
    ]);
    expect(input.runs).toEqual([
      { workflow: "Order pallets", status: "failed", failure: "supplier offline" },
    ]);
    expect(input.task.title).toBe("Plan the depot rollout");
  });

  it("keeps the end of an assistant's text when it has to shorten it", async () => {
    // Four texts of 7,500 bytes are the largest texts, so they give way.
    const { call, input } = await readCall({
      description: "short",
      sessions: Array.from({ length: 4 }, (_, index) => ({
        title: `Session ${String(index)}`,
        firstPrompt: "p".repeat(1000),
        deltas: [`${"€".repeat(2480)} the end of the talk`],
      })),
    });

    expect(byteSize(call.input)).toBeLessThanOrEqual(MAX_SUMMARY_INPUT_BYTES);
    for (const session of input.sessions) {
      expect(session.latestAssistantText.length).toBeLessThan(2500);
      expect(session.latestAssistantText.endsWith("the end of the talk")).toBe(true);
    }
  });
});

describe("the answer", () => {
  it("has the three texts and nothing else, so a summary can hold no question", () => {
    expect(lintOutputSchema(SUMMARY_OUTPUT_SCHEMA)).toEqual([]);
    expect(Object.keys(SUMMARY_OUTPUT_SCHEMA["properties"] as object)).toEqual([
      "line",
      "standing",
      "left",
    ]);
    expect(SUMMARY_OUTPUT_SCHEMA["required"]).toEqual(["line", "standing", "left"]);
    expect(SUMMARY_OUTPUT_SCHEMA["additionalProperties"]).toBe(false);
  });

  it("does not carry the lengths of the stored texts, so a long answer is not refused", () => {
    expect(JSON.stringify(SUMMARY_OUTPUT_SCHEMA)).not.toContain("maxLength");
  });

  it("keeps a short answer, trimmed", () => {
    expect(
      parseSummaryAnswer({
        line: " Three designs, depots worried. ",
        standing: "Designs are drafted.",
        left: "Pricing.",
      }),
    ).toEqual({
      line: "Three designs, depots worried.",
      standing: "Designs are drafted.",
      left: "Pricing.",
    });
  });

  it("cuts each text at a word to the length of its field, and never refuses", () => {
    const words = (count: number) => Array.from({ length: count }, () => "stock").join(" ");

    const cut = parseSummaryAnswer({
      line: words(40),
      standing: words(300),
      left: words(200),
    });

    for (const [text, max] of [
      [cut.line, 60],
      [cut.standing, 400],
      [cut.left, 200],
    ] as const) {
      expect(text.length).toBeLessThanOrEqual(max);
      expect(text.endsWith("stock…")).toBe(true);
      expect(
        text
          .slice(0, -1)
          .split(" ")
          .every((word) => word === "stock"),
      ).toBe(true);
    }
  });

  it("cuts a line before a long word that starts early, rather than inside it", () => {
    const cut = parseSummaryAnswer({
      line: `A ${"reconciliation".repeat(6)}`,
      standing: "",
      left: "",
    });

    expect(cut.line).toBe("A…");
  });

  it("returns an empty text for an empty answer instead of refusing it", () => {
    expect(parseSummaryAnswer({ line: "", standing: "", left: "" })).toEqual({
      line: "",
      standing: "",
      left: "",
    });
  });
});
