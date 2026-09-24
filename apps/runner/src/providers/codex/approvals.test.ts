/**
 * Tests for every server-to-client request codex 0.154.0 declares, each sent
 * to the scripted app-server: what the user is shown, what is sent back for
 * each decision, and what happens to a request the user never resolves. A
 * request with no reply leaves the turn hanging forever with no error, so the
 * tests check that a reply is sent as carefully as what it contains.
 *
 * Two mappings are approximate:
 *
 * - `item/permissions/requestApproval` has no decision enum, so a deny is an
 *   empty grant and nothing else: no `turn/interrupt`.
 * - `item/tool/requestUserInput` has no way to decline in its reply, so a
 *   decline is a JSON-RPC error reply.
 *
 * An `interrupt` on a session parked on a permissions request replies with
 * that row's deny mapping, because the row offers no `cancel`. The spec does
 * not cover this case. `request.resolved` still reports `cancel`, because the
 * interrupt is what ended the request.
 */
import { afterAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { ApprovalDecision, ProviderEvent } from "@hercule/protocol";
import {
  type Answered,
  startBusySession,
  cleanupHomes,
  CWD,
  createDriving,
  SESSION,
  listSentParams,
  settle,
  SPEC,
  filterByTag,
  THREAD,
  TURN,
  waitUntil,
} from "./testing";

afterAll(cleanupHomes);

const ITEM = "0199e0e7-0000-7000-8000-0000000000e1";

const FILE_ITEM = "0199e0e7-0000-7000-8000-0000000000e2";

/** Codex uses both string and number request ids; both kinds are tested. */
const ID = 7;

/** The id of a second request in the same turn, which Codex sends without waiting for the first. */
const SECOND_ID = 8;

const STARTED_AT = 1789373122124;

type Run = Awaited<ReturnType<typeof startBusySession>>;

/** Starts a session with a running turn, and sends it one server request. */
const pushServerRequest = async (
  method: string,
  params: unknown,
  id: string | number = ID,
): Promise<Run> => {
  const run = await startBusySession();
  run.server.push({ id, method, params });
  return run;
};

const awaitOpenedRequest = async (
  run: Run,
): Promise<Extract<ProviderEvent, { _tag: "request.opened" }>> => {
  await waitUntil("opened the request", () => filterByTag(run.seen, "request.opened").length === 1);
  return filterByTag(run.seen, "request.opened")[0]!;
};

const awaitAnswer = async (run: Run, id: string | number = ID): Promise<Answered> => {
  await waitUntil("answered the request", () => run.answered.some((written) => written.id === id));
  return run.answered.find((written) => written.id === id)!;
};

/** Sends a request, resolves it with `decision`, and returns the run and the adapter's reply. */
const openAndAnswer = async (
  method: string,
  params: unknown,
  decision: ApprovalDecision,
): Promise<{ readonly run: Run; readonly answered: Answered }> => {
  const run = await pushServerRequest(method, params);
  const opened = await awaitOpenedRequest(run);
  await Effect.runPromise(
    run.adapter.respondToRequest(SESSION, opened.request.requestId, decision),
  );
  return { run, answered: await awaitAnswer(run) };
};

const COMMAND = "item/commandExecution/requestApproval";

const COMMAND_PARAMS = {
  kind: "command",
  threadId: THREAD,
  turnId: TURN,
  itemId: ITEM,
  startedAtMs: STARTED_AT,
  environmentId: null,
  command: "rm -rf build",
  cwd: CWD,
  commandActions: [],
};

const COMMAND_ANSWERS: ReadonlyArray<readonly [ApprovalDecision, string]> = [
  ["allow", "accept"],
  ["allow_always", "acceptForSession"],
  ["deny", "decline"],
  ["cancel", "cancel"],
];

describe("a command Codex wants to run", () => {
  it("shows the command and offers all four decisions", async () => {
    const run = await pushServerRequest(COMMAND, COMMAND_PARAMS);

    const opened = await awaitOpenedRequest(run);
    expect(opened.sessionId).toBe(SESSION);
    expect(opened.request.kind).toBe("command_approval");
    expect(opened.request.itemId).toBe(ITEM);
    expect(opened.request.detail).toEqual({ command: "rm -rf build" });
    expect(opened.request.decisions).toEqual(["allow", "allow_always", "deny", "cancel"]);
  });

  for (const [decision, mapped] of COMMAND_ANSWERS) {
    it(`replies ${mapped} for ${decision}, and reports the request as resolved`, async () => {
      const { run, answered } = await openAndAnswer(COMMAND, COMMAND_PARAMS, decision);

      expect(answered.result).toEqual({ decision: mapped });
      expect(answered.error).toBeUndefined();
      const resolved = filterByTag(run.seen, "request.resolved");
      expect(resolved).toHaveLength(1);
      expect(resolved[0]?.decision).toBe(decision);
      expect(resolved[0]?.requestId).toBe(
        filterByTag(run.seen, "request.opened")[0]?.request.requestId,
      );
    });
  }
});

const FILE_CHANGE = "item/fileChange/requestApproval";

const FILE_CHANGE_PARAMS = {
  threadId: THREAD,
  turnId: TURN,
  itemId: FILE_ITEM,
  startedAtMs: STARTED_AT,
  reason: null,
  grantRoot: null,
};

/**
 * At 0.154.0 the paths are not in the request params. They are in the file
 * change item, which arrives before the request.
 */
const FILE_ITEM_STARTED = {
  method: "item/started",
  params: {
    threadId: THREAD,
    turnId: TURN,
    item: {
      type: "fileChange",
      id: FILE_ITEM,
      status: "inProgress",
      changes: [
        { path: "/tmp/work/a.ts", kind: "update", diff: "" },
        { path: "/tmp/work/b.ts", kind: "add", diff: "" },
      ],
    },
  },
};

const FILE_ANSWERS: ReadonlyArray<readonly [ApprovalDecision, string]> = [
  ["allow", "accept"],
  ["allow_always", "acceptForSession"],
  ["deny", "decline"],
  ["cancel", "cancel"],
];

describe("a file change Codex wants to write", () => {
  it("shows the paths from the item, because the request has none", async () => {
    const run = await startBusySession();
    run.server.push(FILE_ITEM_STARTED);
    await waitUntil("reported the item", () => filterByTag(run.seen, "item.started").length === 1);
    run.server.push({ id: ID, method: FILE_CHANGE, params: FILE_CHANGE_PARAMS });

    const opened = await awaitOpenedRequest(run);
    expect(opened.request.kind).toBe("file_change_approval");
    expect(opened.request.itemId).toBe(FILE_ITEM);
    expect(opened.request.detail).toEqual({ paths: ["/tmp/work/a.ts", "/tmp/work/b.ts"] });
    expect(opened.request.decisions).toEqual(["allow", "allow_always", "deny", "cancel"]);
  });

  for (const [decision, mapped] of FILE_ANSWERS) {
    it(`replies ${mapped} for ${decision}`, async () => {
      const { run, answered } = await openAndAnswer(FILE_CHANGE, FILE_CHANGE_PARAMS, decision);

      expect(answered.result).toEqual({ decision: mapped });
      expect(filterByTag(run.seen, "request.resolved").map((event) => event.decision)).toEqual([
        decision,
      ]);
    });
  }
});

const PERMISSIONS = "item/permissions/requestApproval";

/** Both parts are set, so "the requested profile" has only one meaning. */
const PROFILE = {
  network: { enabled: true },
  fileSystem: { read: ["/tmp/work"], write: ["/tmp/work"] },
};

const PERMISSIONS_PARAMS = {
  threadId: THREAD,
  turnId: TURN,
  itemId: ITEM,
  environmentId: null,
  startedAtMs: STARTED_AT,
  cwd: CWD,
  reason: "the tool needs the network",
  permissions: PROFILE,
};

describe("the permissions Codex asks to be granted", () => {
  it("shows a tool approval with no cancel, because the reply cannot express one", async () => {
    const run = await pushServerRequest(PERMISSIONS, PERMISSIONS_PARAMS);

    const opened = await awaitOpenedRequest(run);
    expect(opened.request.kind).toBe("tool_approval");
    expect(opened.request.detail).toEqual({ toolName: "permissions" });
    expect(opened.request.decisions).toEqual(["allow", "allow_always", "deny"]);
  });

  it("grants the profile that was asked for, for this turn only", async () => {
    const { answered } = await openAndAnswer(PERMISSIONS, PERMISSIONS_PARAMS, "allow");

    expect(answered.result).toEqual({ permissions: PROFILE, scope: "turn" });
  });

  it("grants the same profile for the whole session on allow_always", async () => {
    const { answered } = await openAndAnswer(PERMISSIONS, PERMISSIONS_PARAMS, "allow_always");

    expect(answered.result).toEqual({ permissions: PROFILE, scope: "session" });
  });

  it("grants nothing on a deny, and does not also interrupt the turn", async () => {
    const { run, answered } = await openAndAnswer(PERMISSIONS, PERMISSIONS_PARAMS, "deny");

    expect(answered.result).toEqual({ permissions: {}, scope: "turn" });
    await settle();
    // Codex ends the turn itself after a denied permission, so a
    // `turn/interrupt` from here would race it.
    expect(listSentParams(run.requests, "turn/interrupt")).toEqual([]);
    expect(filterByTag(run.seen, "request.resolved").map((event) => event.decision)).toEqual([
      "deny",
    ]);
  });
});

const ELICITATION = "mcpServer/elicitation/request";

const ELICITATION_PARAMS = {
  threadId: THREAD,
  turnId: TURN,
  serverName: "linear",
  mode: "form",
  _meta: null,
  message: "Which team should this go to?",
  requestedSchema: { type: "object", properties: {}, required: [] },
};

const ELICITATION_ANSWERS: ReadonlyArray<readonly [ApprovalDecision, unknown]> = [
  ["allow", { action: "accept", content: null }],
  ["deny", { action: "decline" }],
  ["cancel", { action: "cancel" }],
];

describe("an MCP server asking its own question", () => {
  it("shows a tool approval named after the server, with no allow_always", async () => {
    const run = await pushServerRequest(ELICITATION, ELICITATION_PARAMS);

    const opened = await awaitOpenedRequest(run);
    expect(opened.request.kind).toBe("tool_approval");
    expect(opened.request.detail).toEqual({ toolName: "linear" });
    // The elicitation reply has no "accept for this session", so offering
    // allow_always would mean replacing it with something else.
    expect(opened.request.decisions).toEqual(["allow", "deny", "cancel"]);
  });

  for (const [decision, mapped] of ELICITATION_ANSWERS) {
    it(`replies ${JSON.stringify(mapped)} for ${decision}`, async () => {
      const { run, answered } = await openAndAnswer(ELICITATION, ELICITATION_PARAMS, decision);

      expect(answered.result).toMatchObject(mapped as Record<string, unknown>);
      expect(filterByTag(run.seen, "request.resolved").map((event) => event.decision)).toEqual([
        decision,
      ]);
    });
  }
});

const USER_INPUT = "item/tool/requestUserInput";

const USER_INPUT_PARAMS = {
  threadId: THREAD,
  turnId: TURN,
  itemId: ITEM,
  isBlocking: true,
  autoResolutionMs: null,
  questions: [
    {
      id: "q1",
      header: "Deploy target",
      question: "Which environment should this go to?",
      isOther: false,
      isSecret: false,
      options: [
        { label: "staging", description: "the shared one" },
        { label: "production", description: "the real one" },
      ],
    },
  ],
};

const DECLINED = { code: -32603, message: "declined by the user" };

describe("a question the agent asks the user", () => {
  it("shows it as a question, offering only the two decisions Hercule can send", async () => {
    const run = await pushServerRequest(USER_INPUT, USER_INPUT_PARAMS);

    const opened = await awaitOpenedRequest(run);
    expect(opened.request.kind).toBe("question");
    expect(opened.request.itemId).toBe(ITEM);
    expect(opened.request.detail).toEqual({
      questions: [
        {
          header: "Deploy target",
          question: "Which environment should this go to?",
          multiSelect: false,
          options: [
            { label: "staging", description: "the shared one" },
            { label: "production", description: "the real one" },
          ],
        },
      ],
    });
    // Sending answers is not supported yet, so a surface can only decline.
    expect(opened.request.decisions).toEqual(["deny", "cancel"]);
  });

  it("replies with an error on deny, because the reply has no way to decline", async () => {
    const { run, answered } = await openAndAnswer(USER_INPUT, USER_INPUT_PARAMS, "deny");

    expect(answered.error).toEqual(DECLINED);
    expect(answered.result).toBeUndefined();
    await settle();
    // A deny declines this question only; the turn goes on.
    expect(listSentParams(run.requests, "turn/interrupt")).toEqual([]);
    expect(filterByTag(run.seen, "request.resolved").map((event) => event.decision)).toEqual([
      "deny",
    ]);
  });

  it("replies with an error and then interrupts the turn on cancel", async () => {
    const { run, answered } = await openAndAnswer(USER_INPUT, USER_INPUT_PARAMS, "cancel");

    expect(answered.error).toEqual(DECLINED);
    await waitUntil(
      "ended the turn",
      () => listSentParams(run.requests, "turn/interrupt").length === 1,
    );
    expect(listSentParams(run.requests, "turn/interrupt")).toEqual([
      { threadId: THREAD, turnId: TURN },
    ]);
    expect(filterByTag(run.seen, "request.resolved").map((event) => event.decision)).toEqual([
      "cancel",
    ]);
  });
});

const TOOL_CALL = "item/tool/call";

const TOOL_CALL_PARAMS = {
  threadId: THREAD,
  turnId: TURN,
  callId: "call-1",
  namespace: null,
  tool: "search",
  arguments: { query: "hercule" },
};

describe("a dynamic tool Codex wants this client to run", () => {
  it("declines it immediately, without asking the user", async () => {
    const run = await pushServerRequest(TOOL_CALL, TOOL_CALL_PARAMS);

    const answered = await awaitAnswer(run);
    expect(answered.result).toEqual({
      contentItems: [{ type: "inputText", text: "Hercule does not host dynamic tools" }],
      success: false,
    });
    await settle();
    // Hercule provides no dynamic tools to Codex, so there is nothing for a user to decide.
    expect(filterByTag(run.seen, "request.opened")).toEqual([]);
    expect(filterByTag(run.seen, "request.resolved")).toEqual([]);
  });
});

const INVENTED = "codex/somethingThisBuildHasNeverSeen";

const METHOD_NOT_FOUND = -32601;

describe("a request this build does not handle", () => {
  it("replies with an error under the request's own id and warns once, rather than leaving the turn hanging", async () => {
    const run = await pushServerRequest(INVENTED, { threadId: THREAD }, "req-a");

    const answered = await awaitAnswer(run, "req-a");
    // The id is sent back unchanged: Codex uses both string and number ids,
    // and a reply under a converted id would not match the request.
    expect(answered.id).toBe("req-a");
    expect(answered.error?.code).toBe(METHOD_NOT_FOUND);
    expect(answered.result).toBeUndefined();
    await settle();
    const warnings = filterByTag(run.seen, "runtime.warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain(INVENTED);
    expect(filterByTag(run.seen, "request.opened")).toEqual([]);
  });

  it("rejects the four declared methods it does not handle", async () => {
    for (const method of [
      "account/chatgptAuthTokens/refresh",
      "attestation/generate",
      "applyPatchApproval",
      "execCommandApproval",
    ]) {
      const run = await pushServerRequest(method, { threadId: THREAD });

      const answered = await awaitAnswer(run);
      expect(answered.error?.code, method).toBe(METHOD_NOT_FOUND);
      expect(filterByTag(run.seen, "request.opened"), method).toEqual([]);
    }
  });
});

const MODE_ROWS = [
  ["approval-required", "untrusted", "read-only", "user"],
  ["auto-accept-edits", "on-request", "workspace-write", "user"],
  ["auto", "on-request", "workspace-write", "auto_review"],
  ["full-access", "never", "danger-full-access", "user"],
] as const;

describe("the access mode a thread is opened in", () => {
  for (const [mode, approvalPolicy, sandbox, approvalsReviewer] of MODE_ROWS) {
    it(`opens a ${mode} thread with ${approvalPolicy} and ${sandbox}`, async () => {
      const run = createDriving();

      await Effect.runPromise(
        run.adapter.startSession(SESSION, { ...SPEC, accessMode: mode }, run.ctx),
      );

      const opened = listSentParams(run.requests, "thread/start");
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({ approvalPolicy, sandbox, approvalsReviewer });
    });
  }
});

describe("an approval resolved while the turn is still running", () => {
  it("replies to Codex, reports the request as resolved, and leaves the turn running", async () => {
    const run = await pushServerRequest(COMMAND, COMMAND_PARAMS);
    const opened = await awaitOpenedRequest(run);

    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([
      { sessionId: SESSION, nativeSessionId: THREAD, instanceId: SPEC.instanceId },
    ]);

    await Effect.runPromise(
      run.adapter.respondToRequest(SESSION, opened.request.requestId, "allow"),
    );

    expect((await awaitAnswer(run)).result).toEqual({ decision: "accept" });
    expect(filterByTag(run.seen, "request.resolved").map((event) => event.decision)).toEqual([
      "allow",
    ]);
    // The turn is still running: an input now steers it rather than starting
    // a second turn beside it.
    const sent = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "carry on" }));
    expect(sent).toEqual({ turnId: TURN, delivery: "steered" });
    expect(filterByTag(run.seen, "turn.completed")).toEqual([]);
  });
});

describe("a second request Codex sends before the first is resolved", () => {
  const SECOND_PARAMS = { ...COMMAND_PARAMS, itemId: FILE_ITEM, command: "rm -rf dist" };

  it("opens them one at a time, and replies to each under its own id", async () => {
    const run = await pushServerRequest(COMMAND, COMMAND_PARAMS);
    run.server.push({ id: SECOND_ID, method: COMMAND, params: SECOND_PARAMS });
    await settle();

    // A session has one open request. Opening the second now would remove the
    // first from every surface with no way to resolve it, and Codex is
    // waiting for both.
    const first = await awaitOpenedRequest(run);
    expect(first.request.detail).toEqual({ command: "rm -rf build" });
    expect(run.answered).toEqual([]);

    await Effect.runPromise(
      run.adapter.respondToRequest(SESSION, first.request.requestId, "allow"),
    );

    await waitUntil(
      "opened the second",
      () => filterByTag(run.seen, "request.opened").length === 2,
    );
    const second = filterByTag(run.seen, "request.opened")[1]!;
    expect(second.request.detail).toEqual({ command: "rm -rf dist" });
    expect((await awaitAnswer(run, ID)).result).toEqual({ decision: "accept" });

    await Effect.runPromise(
      run.adapter.respondToRequest(SESSION, second.request.requestId, "deny"),
    );

    expect((await awaitAnswer(run, SECOND_ID)).result).toEqual({ decision: "decline" });
    expect(filterByTag(run.seen, "request.resolved").map((event) => event.decision)).toEqual([
      "allow",
      "deny",
    ]);
  });

  it("cancels the waiting request too when the session is interrupted", async () => {
    const run = await pushServerRequest(COMMAND, COMMAND_PARAMS);
    run.server.push({ id: SECOND_ID, method: COMMAND, params: SECOND_PARAMS });
    await settle();
    const first = await awaitOpenedRequest(run);

    await Effect.runPromise(run.adapter.interrupt(SESSION));

    expect((await awaitAnswer(run, ID)).result).toEqual({ decision: "cancel" });
    expect((await awaitAnswer(run, SECOND_ID)).result).toEqual({ decision: "cancel" });
    // Only the open request was ever reported as opened, so only it is reported as resolved.
    const resolved = filterByTag(run.seen, "request.resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ requestId: first.request.requestId, decision: "cancel" });
    expect(filterByTag(run.seen, "request.opened")).toHaveLength(1);
  });
});

describe("interrupting a session that is parked on a request", () => {
  it("cancels the request, reports it as cancelled, and interrupts the turn", async () => {
    const run = await pushServerRequest(COMMAND, COMMAND_PARAMS);
    const opened = await awaitOpenedRequest(run);

    await Effect.runPromise(run.adapter.interrupt(SESSION));

    expect((await awaitAnswer(run)).result).toEqual({ decision: "cancel" });
    const resolved = filterByTag(run.seen, "request.resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ requestId: opened.request.requestId, decision: "cancel" });
    expect(listSentParams(run.requests, "turn/interrupt")).toEqual([
      { threadId: THREAD, turnId: TURN },
    ]);
  });

  it("replies to a question with an error, and interrupts the turn", async () => {
    const run = await pushServerRequest(USER_INPUT, USER_INPUT_PARAMS);
    const opened = await awaitOpenedRequest(run);

    await Effect.runPromise(run.adapter.interrupt(SESSION));

    expect((await awaitAnswer(run)).error).toEqual(DECLINED);
    expect(filterByTag(run.seen, "request.resolved")[0]).toMatchObject({
      requestId: opened.request.requestId,
      decision: "cancel",
    });
    expect(listSentParams(run.requests, "turn/interrupt")).toEqual([
      { threadId: THREAD, turnId: TURN },
    ]);
  });

  it("grants nothing on a permissions request, which is the only way to decline it", async () => {
    const run = await pushServerRequest(PERMISSIONS, PERMISSIONS_PARAMS);
    await awaitOpenedRequest(run);

    await Effect.runPromise(run.adapter.interrupt(SESSION));

    // A permissions reply has no `cancel`, so a cancel sends the deny reply;
    // the request is still reported as cancelled.
    expect((await awaitAnswer(run)).result).toEqual({ permissions: {}, scope: "turn" });
    expect(filterByTag(run.seen, "request.resolved").map((event) => event.decision)).toEqual([
      "cancel",
    ]);
    expect(listSentParams(run.requests, "turn/interrupt")).toEqual([
      { threadId: THREAD, turnId: TURN },
    ]);
  });
});

/** The standard JSON-RPC code for an invalid request, which Codex also uses. */
const INVALID_REQUEST = -32600;

describe("a handled request this build could not read", () => {
  it("rejects that request and keeps reading the connection", async () => {
    const run = await startBusySession();

    // A file change request with no item id: the mapping reads a field the
    // server did not send. If the reader crashed on it, every later frame
    // would be dropped with no error anywhere.
    run.server.push({
      id: "req-b",
      method: FILE_CHANGE,
      params: { threadId: THREAD, turnId: TURN },
    });

    expect((await awaitAnswer(run, "req-b")).error?.code).toBe(INVALID_REQUEST);
    expect(filterByTag(run.seen, "request.opened")).toEqual([]);
    run.server.push({ id: ID, method: COMMAND, params: COMMAND_PARAMS });
    expect((await awaitOpenedRequest(run)).request.kind).toBe("command_approval");
  });
});

const OTHER_THREAD = "0199e0e7-0000-7000-8000-0000000000e9";

describe("a request about a thread no session here holds", () => {
  it("rejects it without warning a session it is not about", async () => {
    const run = await startBusySession();

    run.server.push({
      id: "req-c",
      method: COMMAND,
      params: { ...COMMAND_PARAMS, threadId: OTHER_THREAD },
    });

    expect((await awaitAnswer(run, "req-c")).error?.code).toBe(INVALID_REQUEST);
    await settle();
    // No session holds the thread, so no session is warned.
    expect(filterByTag(run.seen, "runtime.warning")).toEqual([]);
    expect(filterByTag(run.seen, "request.opened")).toEqual([]);
  });
});

describe("a request whose turn ends before it is resolved", () => {
  it("ignores a decision that arrives after its turn has ended", async () => {
    const run = await pushServerRequest(COMMAND, COMMAND_PARAMS);
    const opened = await awaitOpenedRequest(run);
    run.server.push({
      method: "turn/completed",
      params: {
        threadId: THREAD,
        turn: { id: TURN, items: [], itemsView: "full", status: "completed" },
      },
    });
    await waitUntil("ended the turn", () => filterByTag(run.seen, "turn.completed").length === 1);

    await Effect.runPromise(
      run.adapter.respondToRequest(SESSION, opened.request.requestId, "allow"),
    );

    await settle();
    // The request ended with its turn. Codex got a cancel reply when the turn
    // ended, because every request gets a reply, so the user's decision
    // arrives for a request that no longer exists. The controller closed the
    // open request on `turn.completed`, so no resolution is reported either.
    expect(run.answered).toEqual([{ id: ID, result: { decision: "cancel" } }]);
    expect(filterByTag(run.seen, "request.resolved")).toEqual([]);
  });

  it("replies to the waiting requests too, so none is left without a reply", async () => {
    const run = await pushServerRequest(COMMAND, COMMAND_PARAMS);
    run.server.push({
      id: SECOND_ID,
      method: COMMAND,
      params: { ...COMMAND_PARAMS, itemId: FILE_ITEM, command: "rm -rf dist" },
    });
    await settle();
    run.server.push({
      method: "turn/completed",
      params: {
        threadId: THREAD,
        turn: { id: TURN, items: [], itemsView: "full", status: "completed" },
      },
    });
    await waitUntil("ended the turn", () => filterByTag(run.seen, "turn.completed").length === 1);

    await settle();
    expect(run.answered).toEqual([
      { id: SECOND_ID, result: { decision: "cancel" } },
      { id: ID, result: { decision: "cancel" } },
    ]);
    expect(filterByTag(run.seen, "request.resolved")).toEqual([]);
    expect(filterByTag(run.seen, "request.opened")).toHaveLength(1);
  });
});
