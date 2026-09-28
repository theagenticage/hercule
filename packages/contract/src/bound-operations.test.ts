import { Effect, Exit, Schema } from "effect";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import { describe, expect, it } from "vitest";
import { api } from "./api";
import {
  BINDABLE_OPERATION_IDS,
  decodeBindableOperation,
  dispatchBindableOperation,
  OWN_SESSION_ALIAS,
  type BindableOperation,
  type BindableOperationHandlers,
} from "./bound-operations";
import { CLI } from "./cli";
import { NotificationCreateInput } from "./groups/notification";
import { readRequirement } from "./operations";

const SESSION_ID = "01a06d02-c111-7a0e-8b3d-9c1f7c82ebeb";
const PATH = ["actions", "0", "operation"];

/** Runs `decodeBindableOperation` and returns its exit, so a test can read the success or the failure. */
const check = (op: string, input: unknown) =>
  Effect.runSyncExit(decodeBindableOperation({ op, input }, PATH));

/** Returns the issues of a failed check, or fails the test when the check succeeded. */
const readIssues = (exit: Exit.Exit<BindableOperation, unknown>) => {
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

describe("the operations an answer may run", () => {
  // An answer runs as the user, without checking the producer's grants, so it
  // must never reach credentials, secrets, the infrastructure, permissions or
  // the management of Connections.
  it.each(BINDABLE_OPERATION_IDS)("do not let %s touch a guarded area", (op) => {
    const requirement = readRequirement(op);
    expect(requirement).not.toMatch(/^(credential|secret|infra|permission)\./);
    expect(requirement).not.toBe("connection.manage");
  });

  // One click must never destroy anything wholesale.
  it.each(BINDABLE_OPERATION_IDS)("do not let %s delete or purge", (op) => {
    expect(op).not.toMatch(/\.(delete|purge)$/);
  });

  // `notification.act` returns the operation's own error when it fails, so
  // its endpoint must declare every error the operation's endpoint declares.
  it.each(BINDABLE_OPERATION_IDS)(
    "fail notification.act only with errors its endpoint declares, for %s",
    (op) => {
      const errors = listEndpointErrors();
      const actErrors = errors.get("notification.act") ?? new Set();
      const opErrors = errors.get(op) ?? new Set();
      expect(opErrors.size).toBeGreaterThan(0);
      for (const error of opErrors) {
        expect(actErrors.has(error), `an error of ${op} is missing from notification.act`).toBe(
          true,
        );
      }
    },
  );
});

describe("decodeBindableOperation", () => {
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
        message: `An answer cannot run secret.set. An answer can run one of: ${BINDABLE_OPERATION_IDS.join(", ")}.`,
      },
    ]);
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

describe("dispatchBindableOperation", () => {
  const handlers: BindableOperationHandlers<string> = {
    "task.update": ({ taskId }) => `task.update of ${taskId}`,
    "run.start": ({ workflowId }) => `run.start of ${workflowId}`,
    "session.input": ({ sessionId, text }) => `session.input of "${text}" to ${sessionId}`,
    "session.respond": ({ requestId, decision }) =>
      `session.respond of ${decision} to ${requestId}`,
  };

  it("calls the handler for the operation with the operation's input", () => {
    expect(
      dispatchBindableOperation(handlers, {
        op: "session.input",
        input: { sessionId: SESSION_ID, text: "hi" },
      }),
    ).toBe(`session.input of "hi" to ${SESSION_ID}`);
    expect(
      dispatchBindableOperation(handlers, {
        op: "session.respond",
        input: { sessionId: SESSION_ID, requestId: "req-1", decision: "deny" },
      }),
    ).toBe("session.respond of deny to req-1");
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
