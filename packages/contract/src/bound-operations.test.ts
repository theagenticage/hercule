import type { AnswerPlace } from "@hercule/plugin-host";
import { Cause, Effect, Exit, Schema } from "effect";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import { describe, expect, it } from "vitest";
import { api } from "./api";
import {
  decodeAnswerOperation,
  dispatchAnswerOperation,
  listAnswerOperations,
  OWN_SESSION_ALIAS,
  type AnswerOperation,
  type AnswerOperationHandlers,
} from "./bound-operations";
import { CLI } from "./cli";
import { listDecodeIssues } from "./errors";
import { BoundOperation, NotificationCreateInput } from "./groups/notification";
import { readRequirement } from "./operations";

const SESSION_ID = "01a06d02-c111-7a0e-8b3d-9c1f7c82ebeb";
const PATH = ["actions", "0", "operation"];

/** Runs `decodeAnswerOperation` for `place` and returns its exit, so a test can read the success or the failure. */
const check = (op: string, input: unknown, place: AnswerPlace = "notification.answer") =>
  Effect.runSyncExit(decodeAnswerOperation(place, { op, input }, PATH));

/** Returns the issues of a failed check, or fails the test when the check succeeded. */
const readIssues = (exit: Exit.Exit<AnswerOperation, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error("the check succeeded");
  const error = Exit.findErrorOption(exit);
  if (error._tag === "None") throw new Error("the check died instead of failing");
  return (error.value as { error: { details: { issues: ReadonlyArray<{ path: string[] }> } } })
    .error.details.issues;
};

/**
 * Returns the errors each endpoint declares across all its status codes,
 * keyed by operation id such as `notification.act`. Each error is kept as its
 * schema's AST, because `HttpApi.reflect` wraps every schema in a new object
 * but keeps the AST inside it. Two endpoints that declare the same error then
 * hold the same AST.
 */
const listEndpointErrors = (): ReadonlyMap<string, ReadonlySet<Schema.Top["ast"]>> => {
  const found = new Map<string, ReadonlySet<Schema.Top["ast"]>>();
  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ endpoint, group, errors }) => {
      found.set(
        `${group.identifier}.${endpoint.identifier}`,
        new Set([...errors.values()].flat().map((schema) => schema.ast)),
      );
    },
  });
  return found;
};

const NOTIFICATION_OPERATIONS = listAnswerOperations("notification.answer");
const SIGNAL_OPERATIONS = listAnswerOperations("signal.answer");
const ANSWER_OPERATIONS = [...new Set([...NOTIFICATION_OPERATIONS, ...SIGNAL_OPERATIONS])];

describe("the operations an answer may run", () => {
  it("are the ones whose usableIn lists an answer place", () => {
    expect(NOTIFICATION_OPERATIONS).toEqual([
      "permission.decide",
      "task.update",
      "run.start",
      "session.input",
      "session.respondToApprovalRequest",
    ]);
    expect(SIGNAL_OPERATIONS).toEqual(["task.create", "task.update", "run.start"]);
  });

  // An answer runs as the user, without checking the producer's grants, so it
  // must never reach credentials, secrets, the infrastructure, permissions or
  // the management of Connections.
  //
  // `permission.decide` is exempt from the `permission` family by name, and
  // only it: it is how the user answers a Permission Request, and the core
  // refuses it from every producer but itself, so no producer can make a
  // click grant something the answer does not show.
  it.each(ANSWER_OPERATIONS)("do not let %s touch a guarded area", (op) => {
    const requirement = readRequirement(op);
    const guarded =
      op === "permission.decide"
        ? /^(credential|secret|infra)\./
        : /^(credential|secret|infra|permission)\./;
    expect(requirement).not.toMatch(guarded);
    expect(requirement).not.toBe("connection.manage");
  });

  // One click must never destroy anything wholesale.
  it.each(ANSWER_OPERATIONS)("do not let %s delete or purge", (op) => {
    expect(op).not.toMatch(/\.(delete|purge)$/);
  });

  // `notification.act` and `signal.act` return the operation's own error when
  // it fails, so each endpoint must declare every error that the endpoint of
  // an operation usable in its place declares.
  it.each([
    ...NOTIFICATION_OPERATIONS.map((op) => ["notification.act", op] as const),
    ...SIGNAL_OPERATIONS.map((op) => ["signal.act", op] as const),
  ])("fail %s only with errors its endpoint declares, for %s", (act, op) => {
    const errors = listEndpointErrors();
    const actErrors = errors.get(act) ?? new Set();
    const opErrors = errors.get(op) ?? new Set();
    expect(opErrors.size).toBeGreaterThan(0);
    for (const error of opErrors) {
      expect(actErrors.has(error), `an error of ${op} is missing from ${act}`).toBe(true);
    }
  });
});

describe("decodeAnswerOperation", () => {
  it("accepts a valid input and returns it decoded", () => {
    const exit = check("session.input", { sessionId: SESSION_ID, text: "Event-sourced" });
    expect(exit).toEqual(
      Exit.succeed({
        op: "session.input",
        input: { sessionId: SESSION_ID, text: "Event-sourced" },
      }),
    );
  });

  it("refuses an operation an answer may not run, listing the ones it may", () => {
    const issues = readIssues(check("secret.set", { name: "x", value: "y" }));
    expect(issues).toEqual([
      {
        path: [...PATH, "op"],
        message: `An answer on a notification cannot run secret.set. An answer on a notification can run one of: ${NOTIFICATION_OPERATIONS.join(", ")}, or a plugin action that lists notification.answer in its usableIn.`,
      },
    ]);
  });

  it("refuses an operation that is usable only in another place", () => {
    const issues = readIssues(
      check("session.input", { sessionId: SESSION_ID, text: "hi" }, "signal.answer"),
    );
    expect(issues).toEqual([
      {
        path: [...PATH, "op"],
        message: `An answer on a signal cannot run session.input. An answer on a signal can run one of: ${SIGNAL_OPERATIONS.join(", ")}, or a plugin action that lists signal.answer in its usableIn.`,
      },
    ]);
    expect(Exit.isFailure(check("task.create", { title: "T", description: "D" }))).toBe(true);
    expect(
      Exit.isSuccess(check("task.create", { title: "T", description: "D" }, "signal.answer")),
    ).toBe(true);
  });

  it("refuses an input that does not fit, with each issue under the input's path", () => {
    const issues = readIssues(check("run.start", { workflowId: "not-an-id" }));
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.path.slice(0, PATH.length + 1)).toEqual([...PATH, "input"]);
    }
    expect(issues.map((issue) => issue.path)).toContainEqual([...PATH, "input", "workflowId"]);
  });
});

describe("dispatchAnswerOperation", () => {
  const handlers: AnswerOperationHandlers<"notification.answer", string> = {
    "task.update": ({ taskId }) => `task.update of ${taskId}`,
    "run.start": ({ workflowId }) => `run.start of ${workflowId}`,
    "session.input": ({ sessionId, text }) => `session.input of "${text}" to ${sessionId}`,
    "session.respondToApprovalRequest": ({ requestId, decision }) =>
      `session.respondToApprovalRequest of ${decision} to ${requestId}`,
    "permission.decide": ({ requestId, outcome }) =>
      `permission.decide of ${outcome} to ${requestId}`,
  };

  it("calls the handler for the operation with the operation's input", () => {
    expect(
      dispatchAnswerOperation(handlers, {
        op: "session.input",
        input: { sessionId: SESSION_ID, text: "hi" },
      }),
    ).toBe(`session.input of "hi" to ${SESSION_ID}`);
    expect(
      dispatchAnswerOperation(handlers, {
        op: "session.respondToApprovalRequest",
        input: { sessionId: SESSION_ID, requestId: "req-1", decision: "deny" },
      }),
    ).toBe("session.respondToApprovalRequest of deny to req-1");
  });
});

describe("BoundOperation", () => {
  const decode = Schema.decodeUnknownExit(BoundOperation);

  it("accepts a contract operation id and a plugin action's qualified id", () => {
    expect(Exit.isSuccess(decode({ op: "run.start", input: {} }))).toBe(true);
    expect(
      Exit.isSuccess(
        decode({ op: "github/pr.merge", connectionId: SESSION_ID, input: { number: 1 } }),
      ),
    ).toBe(true);
  });

  it("refuses an id that is neither", () => {
    expect(Exit.isFailure(decode({ op: "nothing.here", input: {} }))).toBe(true);
    expect(Exit.isFailure(decode({ op: "Github/pr.merge", input: {} }))).toBe(true);
  });
});

describe("notification.create", () => {
  it("refuses an answer with a typed field, at the field's path", () => {
    const exit = Schema.decodeUnknownExit(NotificationCreateInput)({
      kind: "triage.unsure",
      title: "A question",
      actions: [
        { id: "ok", label: "OK", operation: null },
        {
          id: "reply",
          label: "Reply",
          operation: null,
          field: { name: "body", placeholder: "Write a reply" },
        },
      ],
    });
    if (Exit.isSuccess(exit)) throw new Error("the decode succeeded");
    expect(listDecodeIssues(Cause.squash(exit.cause) as Schema.SchemaError)).toEqual([
      {
        path: ["actions", "1", "field"],
        message:
          "A notification's answer cannot take typed text. Leave out field, and let the user answer in the session instead.",
      },
    ]);
  });
});

describe("the notification create examples", () => {
  const examples = CLI["notification.create"].examples;
  const actions = examples.flatMap((example) =>
    example.args.flatMap((arg, index) =>
      example.args[index - 1] === "--action" ? [JSON.parse(arg) as unknown] : [],
    ),
  );

  it("include an answer that runs an operation", () => {
    expect(actions.some((action) => (action as { operation: unknown }).operation !== null)).toBe(
      true,
    );
  });

  // The core replaces the own-session alias with the calling session before
  // it checks an answer, so the test does the same.
  it.each(actions)("bind an answer the core accepts: %j", (action) => {
    const decoded = Schema.decodeUnknownSync(NotificationCreateInput)({
      kind: "triage.unsure",
      title: "A question",
      actions: [action],
    });
    const operation = decoded.actions?.[0]?.operation;
    if (operation === null || operation === undefined) return;
    const input = { ...(operation.input as Record<string, unknown>) };
    if (input.sessionId === OWN_SESSION_ALIAS) input.sessionId = SESSION_ID;
    expect(Exit.isSuccess(check(operation.op, input))).toBe(true);
  });
});
