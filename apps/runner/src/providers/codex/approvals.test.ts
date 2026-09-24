/**
 * Every server-to-client request codex 0.154.0 declares, driven one at a time
 * against the scripted app-server: what the user is asked, what is written back
 * for each answer, and what happens to a request nobody answers. A request left
 * hanging is a turn that never ends with nothing said anywhere, so the absence
 * of an answer is asserted as hard as its content.
 *
 * Two mappings are stretches the SPEC names rather than hides. An
 * `item/permissions/requestApproval` has no decision enum, so a refusal is an
 * empty grant and nothing else - no `turn/interrupt`. An
 * `item/tool/requestUserInput` has no refusal shape at all, so a refusal is a
 * JSON-RPC error reply.
 *
 * ASSUMPTION, stated because the SPEC does not: `interrupt` on a session parked
 * on a permissions request answers it with that row's `deny` mapping, since the
 * row offers no `cancel`. `request.resolved` still carries `cancel` - that is
 * what ended the park.
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

/** Codex types a request id as a string or a number; both shapes arrive. */
const ID = 7;

/** The second request of a turn, which Codex asks without waiting for the first. */
const SECOND_ID = 8;

const STARTED_AT = 1789373122124;

type Run = Awaited<ReturnType<typeof startBusySession>>;

/** A session with a turn in flight, and one server request pushed into it. */
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

/** Opens the request, answers it as the user did, and hands back both. */
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

describe("a command Codex wants run", () => {
  it("asks with the command itself, and takes all four answers", async () => {
    const run = await pushServerRequest(COMMAND, COMMAND_PARAMS);

    const opened = await awaitOpenedRequest(run);
    expect(opened.sessionId).toBe(SESSION);
    expect(opened.request.kind).toBe("command_approval");
    expect(opened.request.itemId).toBe(ITEM);
    expect(opened.request.detail).toEqual({ command: "rm -rf build" });
    expect(opened.request.decisions).toEqual(["allow", "allow_always", "deny", "cancel"]);
  });

  for (const [decision, mapped] of COMMAND_ANSWERS) {
    it(`writes ${mapped} back for ${decision}, and says the park is over`, async () => {
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
 * The paths are not in the approval params at 0.154.0; they are in the item the
 * approval is about, which arrives first.
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

describe("a file change Codex wants written", () => {
  it("asks with the paths off the item, because the request carries none", async () => {
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
    it(`writes ${mapped} back for ${decision}`, async () => {
      const { run, answered } = await openAndAnswer(FILE_CHANGE, FILE_CHANGE_PARAMS, decision);

      expect(answered.result).toEqual({ decision: mapped });
      expect(filterByTag(run.seen, "request.resolved").map((event) => event.decision)).toEqual([
        decision,
      ]);
    });
  }
});

const PERMISSIONS = "item/permissions/requestApproval";

/** Both halves are set, so "the requested profile" has one honest reading. */
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
  it("asks as a tool approval, offering no cancel, because the answer cannot express one", async () => {
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

  it("grants the same profile for the session when the answer is always", async () => {
    const { answered } = await openAndAnswer(PERMISSIONS, PERMISSIONS_PARAMS, "allow_always");

    expect(answered.result).toEqual({ permissions: PROFILE, scope: "session" });
  });

  it("grants nothing on a deny, and does not also stop the turn", async () => {
    const { run, answered } = await openAndAnswer(PERMISSIONS, PERMISSIONS_PARAMS, "deny");

    expect(answered.result).toEqual({ permissions: {}, scope: "turn" });
    await settle();
    // Codex ends the turn itself after a refused permission: a `turn/interrupt`
    // from here would be a second, racing stop.
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
  it("asks as a tool approval named after the server, with no always to give", async () => {
    const run = await pushServerRequest(ELICITATION, ELICITATION_PARAMS);

    const opened = await awaitOpenedRequest(run);
    expect(opened.request.kind).toBe("tool_approval");
    expect(opened.request.detail).toEqual({ toolName: "linear" });
    // The elicitation answer has no for-session accept, so offering one would
    // be offering an answer this adapter would have to substitute for.
    expect(opened.request.decisions).toEqual(["allow", "deny", "cancel"]);
  });

  for (const [decision, mapped] of ELICITATION_ANSWERS) {
    it(`answers the server with ${JSON.stringify(mapped)} for ${decision}`, async () => {
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
  it("asks it as a question, offering only the two answers Hercule can express", async () => {
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
    // Answering with content is not built: a surface may only refuse.
    expect(opened.request.decisions).toEqual(["deny", "cancel"]);
  });

  it("refuses with an error reply, because the answer shape has no refusal in it", async () => {
    const { run, answered } = await openAndAnswer(USER_INPUT, USER_INPUT_PARAMS, "deny");

    expect(answered.error).toEqual(DECLINED);
    expect(answered.result).toBeUndefined();
    await settle();
    // A deny refuses this question; the turn goes on.
    expect(listSentParams(run.requests, "turn/interrupt")).toEqual([]);
    expect(filterByTag(run.seen, "request.resolved").map((event) => event.decision)).toEqual([
      "deny",
    ]);
  });

  it("refuses and then ends the turn when the answer is a cancel", async () => {
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
  it("declines it on the spot, without asking anybody", async () => {
    const run = await pushServerRequest(TOOL_CALL, TOOL_CALL_PARAMS);

    const answered = await awaitAnswer(run);
    expect(answered.result).toEqual({
      contentItems: [{ type: "inputText", text: "Hercule does not host dynamic tools" }],
      success: false,
    });
    await settle();
    // Hercule hosts no tools for Codex, so there is nothing a user could decide.
    expect(filterByTag(run.seen, "request.opened")).toEqual([]);
    expect(filterByTag(run.seen, "request.resolved")).toEqual([]);
  });
});

const INVENTED = "codex/somethingThisBuildHasNeverSeen";

const METHOD_NOT_FOUND = -32601;

describe("a request this build has no mapping for", () => {
  it("refuses it by its own id and names it once, rather than leaving the turn hanging", async () => {
    const run = await pushServerRequest(INVENTED, { threadId: THREAD }, "req-a");

    const answered = await awaitAnswer(run, "req-a");
    // The id is echoed verbatim: Codex types it as a string or a number, and an
    // answer under a reshaped id answers nothing.
    expect(answered.id).toBe("req-a");
    expect(answered.error?.code).toBe(METHOD_NOT_FOUND);
    expect(answered.result).toBeUndefined();
    await settle();
    const warnings = filterByTag(run.seen, "runtime.warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain(INVENTED);
    expect(filterByTag(run.seen, "request.opened")).toEqual([]);
  });

  it("refuses the four declared methods it maps nothing to", async () => {
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
    it(`opens a ${mode} thread on ${approvalPolicy} and ${sandbox}`, async () => {
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

describe("an approval answered while the turn is still running", () => {
  it("answers it, says the park is over, and leaves the turn where it was", async () => {
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
    // The turn the approval was about is still the turn in flight: an input now
    // steers it rather than opening a second one beside it.
    const sent = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "carry on" }));
    expect(sent).toEqual({ turnId: TURN, delivery: "steered" });
    expect(filterByTag(run.seen, "turn.completed")).toEqual([]);
  });
});

describe("a second request Codex asks before the first is answered", () => {
  const SECOND_PARAMS = { ...COMMAND_PARAMS, itemId: FILE_ITEM, command: "rm -rf dist" };

  it("opens them one at a time, and answers each under its own id", async () => {
    const run = await pushServerRequest(COMMAND, COMMAND_PARAMS);
    run.server.push({ id: SECOND_ID, method: COMMAND, params: SECOND_PARAMS });
    await settle();

    // A session has one open request, so announcing the second now would take
    // the first off every surface with nobody left able to answer it - and
    // Codex is waiting for both.
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

  it("cancels the one still waiting when the session is interrupted", async () => {
    const run = await pushServerRequest(COMMAND, COMMAND_PARAMS);
    run.server.push({ id: SECOND_ID, method: COMMAND, params: SECOND_PARAMS });
    await settle();
    const first = await awaitOpenedRequest(run);

    await Effect.runPromise(run.adapter.interrupt(SESSION));

    expect((await awaitAnswer(run, ID)).result).toEqual({ decision: "cancel" });
    expect((await awaitAnswer(run, SECOND_ID)).result).toEqual({ decision: "cancel" });
    // Only the open park was ever reported, so only it has an end to report.
    const resolved = filterByTag(run.seen, "request.resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ requestId: first.request.requestId, decision: "cancel" });
    expect(filterByTag(run.seen, "request.opened")).toHaveLength(1);
  });
});

describe("interrupting a session that is parked on a request", () => {
  it("cancels the request, says so, and ends the turn", async () => {
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

  it("refuses a question it cannot answer, and ends the turn", async () => {
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

  it("grants nothing on a permissions request, which is the only refusal it takes", async () => {
    const run = await pushServerRequest(PERMISSIONS, PERMISSIONS_PARAMS);
    await awaitOpenedRequest(run);

    await Effect.runPromise(run.adapter.interrupt(SESSION));

    // No `cancel` exists in a permissions answer, so the deny mapping is what a
    // cancel writes; the park is still reported as cancelled.
    expect((await awaitAnswer(run)).result).toEqual({ permissions: {}, scope: "turn" });
    expect(filterByTag(run.seen, "request.resolved").map((event) => event.decision)).toEqual([
      "cancel",
    ]);
    expect(listSentParams(run.requests, "turn/interrupt")).toEqual([
      { threadId: THREAD, turnId: TURN },
    ]);
  });
});

/** JSON-RPC's own, and what Codex refuses a request it cannot read with. */
const INVALID_REQUEST = -32600;

describe("a mapped request this build could not read", () => {
  it("refuses that one and goes on reading the connection", async () => {
    const run = await startBusySession();

    // A file change approval naming no item: the mapping reads a field the
    // server did not send, and a reader that died on it would drop every frame
    // after it with nothing said anywhere.
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

describe("a request about a thread nobody here holds", () => {
  it("refuses it without telling the sessions it is not about", async () => {
    const run = await startBusySession();

    run.server.push({
      id: "req-c",
      method: COMMAND,
      params: { ...COMMAND_PARAMS, threadId: OTHER_THREAD },
    });

    expect((await awaitAnswer(run, "req-c")).error?.code).toBe(INVALID_REQUEST);
    await settle();
    // There is no session it belongs to, so there is nobody it is news for.
    expect(filterByTag(run.seen, "runtime.warning")).toEqual([]);
    expect(filterByTag(run.seen, "request.opened")).toEqual([]);
  });
});

describe("a park the turn outran", () => {
  it("cannot be answered once the turn it belonged to has ended", async () => {
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
    // The park ended with its turn: Codex was told so at the end of the turn,
    // because every request it asks is answered, and the user's answer arrives
    // at a park that is no longer there. The controller closed the open request
    // on `turn.completed`, so there is no resolution to report either way.
    expect(run.answered).toEqual([{ id: ID, result: { decision: "cancel" } }]);
    expect(filterByTag(run.seen, "request.resolved")).toEqual([]);
  });

  it("answers the ones still waiting too, so nothing is left hanging", async () => {
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
