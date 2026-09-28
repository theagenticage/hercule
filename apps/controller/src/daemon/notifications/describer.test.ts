/**
 * Tests the describe lines of answers against real rows in a migrated
 * in-memory database: each line names what its operation acts on by the
 * entity's current name, and by its id once the entity is gone, and shows
 * every value the operation will run with in full.
 *
 * A screen joins the parts of a line with nothing in between, so the tests
 * compare whole part lists, spaces included.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as Statement from "effect/unstable/sql/Statement";
import type {
  BindableOperation,
  DescribeLine,
  OpenRequest,
  WorkflowDefinition,
} from "@hercule/contract";
import { connectionRepository } from "../../connections";
import { mintUuid, uuidToString } from "../../db";
import { TestDatabase } from "../../db/testing";
import { projectRepository } from "../../projects";
import { sessionRepository } from "../../sessions";
import { taskRepository } from "../../tasks";
import { workflowRepository } from "../../workflows";
import { buildDescribe } from "./describer";

const layer = TestDatabase;

const AT = "2026-09-07T10:00:00.000Z";

/** An id no row has. */
const MISSING_ID = "0199e0e7-9999-7000-8000-000000000000";

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, layer));

/** Returns a new canonical v7 id, the only id format the database accepts. */
const mintId = () => uuidToString(mintUuid());

const text = (value: string) => ({ kind: "text", text: value }) as const;
const marked = (value: string) => ({ kind: "marked", text: value }) as const;

/** Returns the describe line of one operation. */
const describeOperation = (operation: BindableOperation) =>
  Effect.flatMap(buildDescribe, (describe) =>
    Effect.map(describe([operation]), (lines) => lines[0]!),
  );

/** Inserts a workflow with this definition and returns its id. */
const insertWorkflow = (definition: WorkflowDefinition) =>
  Effect.gen(function* () {
    const workflows = yield* workflowRepository;
    const workflow = yield* workflows.insert({ source: "steps: []\n", definition }, AT);
    return workflow.id;
  });

/** Inserts a task titled `title` and returns its id. */
const insertTask = (title: string) =>
  Effect.gen(function* () {
    const tasks = yield* taskRepository;
    const task = yield* tasks.insert({
      title,
      description: "",
      status: "open",
      priority: "normal",
      labels: [],
      projectId: undefined,
      provenance: [],
      at: AT,
      actor: "user",
    });
    return task.id;
  });

/** Inserts a session titled `title`, waiting on `openRequest`, and returns its id. */
const insertSession = (title: string, openRequest: OpenRequest | null = null) =>
  Effect.gen(function* () {
    const sessions = yield* sessionRepository;
    const id = mintId();
    yield* sessions.insert({
      id,
      title,
      permissionProfileId: mintId(),
      agentId: undefined,
      conversationId: undefined,
      instanceId: mintId(),
      runnerId: mintId(),
      requestedAccessMode: "approval-required",
      accessMode: "approval-required",
      workspaceId: null,
      projectId: undefined,
      checkoutBranch: undefined,
      githubConnectionId: undefined,
      spec: "{}",
      modelSelection: { model: "clever", options: {} },
      parentSessionId: undefined,
      at: AT,
    });
    yield* sessions.setOpenRequest(id, openRequest);
    return id;
  });

/** Builds a command approval the session waits on, with the id `requestId`. */
const buildCommandRequest = (requestId: string, command: string): OpenRequest => ({
  requestId,
  itemId: "item-1",
  kind: "command_approval",
  decisions: ["allow", "allow_always", "deny", "cancel"],
  detail: { command },
});

describe("run.start", () => {
  it("names the workflow", async () => {
    const lines = await run(
      Effect.gen(function* () {
        const workflowId = yield* insertWorkflow({ name: "Bugfix", steps: [] });
        return {
          bare: yield* describeOperation({ op: "run.start", input: { workflowId } }),
          missing: yield* describeOperation({ op: "run.start", input: { workflowId: MISSING_ID } }),
        };
      }),
    );

    expect(lines.bare).toEqual([text("Start a run of "), marked("Bugfix")]);
    expect(lines.missing).toEqual([text("Start a run of "), marked(MISSING_ID)]);
  });

  it("lists every input with its whole value", async () => {
    const long = "x".repeat(400);
    const line = await run(
      Effect.gen(function* () {
        const workflowId = yield* insertWorkflow({ name: "Bugfix", steps: [] });
        return yield* describeOperation({
          op: "run.start",
          input: { workflowId, inputs: { issue: 42, title: long, dryRun: true, extra: 1 } },
        });
      }),
    );

    expect(line).toEqual([
      text("Start a run of "),
      marked("Bugfix"),
      text(" with "),
      text("issue "),
      marked("42"),
      text(", "),
      text("title "),
      marked(`"${long}"`),
      text(", "),
      text("dryRun "),
      marked("true"),
      text(", "),
      text("extra "),
      marked("1"),
    ]);
  });

  it("names a Connection input by the Connection's label, and by its value when there is none", async () => {
    const line = await run(
      Effect.gen(function* () {
        const connection = yield* (yield* connectionRepository).insert({
          pluginId: "github",
          type: "github/github",
          label: "Acme GitHub",
          displayName: "acme",
          labels: [],
          config: {},
          at: AT,
        });
        const workflowId = yield* insertWorkflow({
          name: "Bugfix",
          inputs: [
            { name: "repo", connection: { type: "github/github" }, required: true },
            { name: "mirror", connection: { type: "github/github" }, required: false },
          ],
          steps: [],
        });
        return yield* describeOperation({
          op: "run.start",
          input: { workflowId, inputs: { repo: connection.id, mirror: MISSING_ID } },
        });
      }),
    );

    expect(line).toEqual([
      text("Start a run of "),
      marked("Bugfix"),
      text(" with "),
      text("repo connection "),
      marked("Acme GitHub"),
      text(", "),
      text("mirror "),
      marked(`"${MISSING_ID}"`),
    ]);
  });
});

describe("task.update", () => {
  it("names the task and the project, and lists each change in full", async () => {
    const longDescription = "new words ".repeat(50);
    const lines = await run(
      Effect.gen(function* () {
        const taskId = yield* insertTask("Fix the login page");
        const project = yield* (yield* projectRepository).insert({
          name: "Website",
          description: undefined,
          at: AT,
        });
        return {
          changed: yield* describeOperation({
            op: "task.update",
            input: {
              taskId,
              title: "Fix the sign-in page",
              status: "done",
              projectId: project.id,
              addLabels: ["urgent"],
              removeLabels: ["triage", "later"],
            },
          }),
          removedFromProject: yield* describeOperation({
            op: "task.update",
            input: { taskId, projectId: null, description: longDescription, priority: "high" },
          }),
          // An empty list passes the check but changes nothing to describe.
          nothingDescribed: yield* describeOperation({
            op: "task.update",
            input: { taskId, addLabels: [] },
          }),
          missing: yield* describeOperation({
            op: "task.update",
            input: { taskId: MISSING_ID, projectId: MISSING_ID },
          }),
        };
      }),
    );

    expect(lines.changed).toEqual([
      text("Update task "),
      marked("Fix the login page"),
      text(": "),
      text("title → "),
      marked("Fix the sign-in page"),
      text(", "),
      text("status → done"),
      text(", "),
      text("move to project "),
      marked("Website"),
      text(", "),
      text("add label urgent"),
      text(", "),
      text("remove labels triage, later"),
    ]);
    expect(lines.removedFromProject).toEqual([
      text("Update task "),
      marked("Fix the login page"),
      text(": "),
      text("description → "),
      marked(longDescription),
      text(", "),
      text("priority → high"),
      text(", "),
      text("remove from its project"),
    ]);
    expect(lines.nothingDescribed).toEqual([text("Update task "), marked("Fix the login page")]);
    expect(lines.missing).toEqual([
      text("Update task "),
      marked(MISSING_ID),
      text(": "),
      text("move to project "),
      marked(MISSING_ID),
    ]);
  });
});

describe("task.update provenance", () => {
  it("lists what each entry records", async () => {
    const runId = mintId();
    const line = await run(
      Effect.gen(function* () {
        const taskId = yield* insertTask("Fix the login page");
        return yield* describeOperation({
          op: "task.update",
          input: {
            taskId,
            provenance: [{ ref: "github:issue:acme/web#1", eventId: 7 }, { runId }],
          },
        });
      }),
    );

    expect(line).toEqual([
      text("Update task "),
      marked("Fix the login page"),
      text(": "),
      text("record where it came from: "),
      text("ref "),
      marked("github:issue:acme/web#1"),
      text(", "),
      text("event "),
      marked("7"),
      text("; "),
      text("run "),
      marked(runId),
    ]);
  });
});

describe("session.input", () => {
  it("quotes the whole text, names the session, and lists the model and every option", async () => {
    const long = "a".repeat(2_000);
    const lines = await run(
      Effect.gen(function* () {
        const sessionId = yield* insertSession("Refactor the parser");
        return {
          plain: yield* describeOperation({
            op: "session.input",
            input: { sessionId, text: "continue" },
          }),
          withModel: yield* describeOperation({
            op: "session.input",
            input: {
              sessionId,
              text: long,
              model: "clever",
              options: { effort: "high", thinking: true },
            },
          }),
          missing: yield* describeOperation({
            op: "session.input",
            input: { sessionId: MISSING_ID, text: "continue" },
          }),
        };
      }),
    );

    expect(lines.plain).toEqual([
      text("Send "),
      marked("continue"),
      text(" to session "),
      marked("Refactor the parser"),
    ]);
    expect(lines.withModel).toEqual([
      text("Send "),
      marked(long),
      text(" to session "),
      marked("Refactor the parser"),
      text(" on model "),
      marked("clever"),
      text(" with model options "),
      text("effort "),
      marked('"high"'),
      text(", "),
      text("thinking "),
      marked("true"),
    ]);
    expect(lines.missing).toEqual([
      text("Send "),
      marked("continue"),
      text(" to session "),
      marked(MISSING_ID),
    ]);
  });
});

describe("session.respond", () => {
  it("says what each answer does to the request the session waits on", async () => {
    const lines = await run(
      Effect.gen(function* () {
        const sessionId = yield* insertSession(
          "Refactor the parser",
          buildCommandRequest("req-1", "npm test"),
        );
        const answer = (decision: "allow" | "allow_always" | "deny" | "cancel") =>
          describeOperation({
            op: "session.respond",
            input: { sessionId, requestId: "req-1", decision },
          });
        return {
          allow: yield* answer("allow"),
          allowAlways: yield* answer("allow_always"),
          deny: yield* answer("deny"),
          cancel: yield* answer("cancel"),
        };
      }),
    );

    const request: DescribeLine = [text("the command "), marked("npm test")];
    const session = marked("Refactor the parser");
    expect(lines.allow).toEqual([text("Allow "), ...request, text(" once in session "), session]);
    expect(lines.allowAlways).toEqual([
      text("Allow "),
      ...request,
      text(" and stop asking while session "),
      session,
      text(" keeps running"),
    ]);
    expect(lines.deny).toEqual([
      text("Deny "),
      ...request,
      text(" in session "),
      session,
      text("; the agent is told and continues"),
    ]);
    expect(lines.cancel).toEqual([
      text("Deny "),
      ...request,
      text(" and stop the turn in session "),
      session,
    ]);
  });

  it("describes the request by its kind with every path, and as the request once it is no longer open", async () => {
    const lines = await run(
      Effect.gen(function* () {
        const changing = yield* insertSession("Two files", {
          requestId: "req-1",
          itemId: "item-1",
          kind: "file_change_approval",
          decisions: ["allow", "deny"],
          detail: { paths: ["a.ts", "b.ts"] },
        });
        const answeredElsewhere = yield* insertSession(
          "Moved on",
          buildCommandRequest("req-2", "ls"),
        );
        return {
          files: yield* describeOperation({
            op: "session.respond",
            input: { sessionId: changing, requestId: "req-1", decision: "allow" },
          }),
          otherRequest: yield* describeOperation({
            op: "session.respond",
            input: { sessionId: answeredElsewhere, requestId: "req-1", decision: "allow" },
          }),
          missing: yield* describeOperation({
            op: "session.respond",
            input: { sessionId: MISSING_ID, requestId: "req-1", decision: "deny" },
          }),
        };
      }),
    );

    expect(lines.files).toEqual([
      text("Allow "),
      text("the change to "),
      marked("a.ts"),
      text(", "),
      marked("b.ts"),
      text(" once in session "),
      marked("Two files"),
    ]);
    expect(lines.otherRequest).toEqual([
      text("Allow "),
      text("the request"),
      text(" once in session "),
      marked("Moved on"),
    ]);
    expect(lines.missing).toEqual([
      text("Deny "),
      text("the request"),
      text(" in session "),
      marked(MISSING_ID),
      text("; the agent is told and continues"),
    ]);
  });
});

describe("describing the answers of one decision", () => {
  it("reads each entity once, however many answers name it", async () => {
    const statements: Array<string> = [];
    const countStatements: Statement.Transformer = (statement) =>
      Effect.sync(() => {
        statements.push(statement.compile()[0]);
        return statement;
      });

    const lines = await run(
      Effect.gen(function* () {
        const taskId = yield* insertTask("Fix the login page");
        const sessionId = yield* insertSession("Refactor the parser");
        return yield* Effect.provideService(
          Effect.flatMap(buildDescribe, (describe) =>
            describe([
              { op: "task.update", input: { taskId, status: "done" } },
              { op: "task.update", input: { taskId, status: "cancelled" } },
              { op: "session.input", input: { sessionId, text: "yes" } },
              { op: "session.input", input: { sessionId, text: "no" } },
            ]),
          ),
          Statement.CurrentTransformer,
          countStatements,
        );
      }),
    );

    expect(lines.map((line) => line[1])).toEqual([
      marked("Fix the login page"),
      marked("Fix the login page"),
      marked("yes"),
      marked("no"),
    ]);
    // Reading a task takes two statements, the task and its provenance, so
    // the test counts the statements that read each entity's own table.
    expect(statements.filter((sql) => /FROM tasks\s/.test(sql))).toHaveLength(1);
    expect(statements.filter((sql) => /FROM sessions WHERE/.test(sql))).toHaveLength(1);
  });
});
