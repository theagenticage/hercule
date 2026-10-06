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
 * - `item/tool/requestUserInput` has no way to decline in its reply, so the
 *   cancel an interrupt sends is a JSON-RPC error reply.
 *
 * An `interrupt` on a session parked on a permissions request replies with
 * that row's deny mapping, because the row offers no `cancel`. The spec does
 * not cover this case. `request.resolved` still reports `cancel`, because the
 * interrupt is what ended the request.
 */
import { afterAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { ApprovalDecision, ProviderEvent, QuestionAnswers } from "@hercule/protocol";
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

/** Returns how each resolved request was resolved: its decision, or its answers. */
const listResolutions = (run: Run): ReadonlyArray<unknown> =>
  filterByTag(run.seen, "request.resolved").map((event) =>
    "decision" in event ? event.decision : event.answers,
  );

/** Sends a request, resolves it with `decision`, and returns the run and the adapter's reply. */
const openAndAnswer = async (
  method: string,
  params: unknown,
  decision: ApprovalDecision,
): Promise<{ readonly run: Run; readonly answered: Answered }> => {
  const run = await pushServerRequest(method, params);
  const opened = await awaitOpenedRequest(run);
  await Effect.runPromise(
    run.adapter.respondToApprovalRequest(SESSION, opened.request.requestId, decision),
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
    expect(opened.request).toMatchObject({
      decisions: ["allow", "allow_always", "deny", "cancel"],
    });
  });

  for (const [decision, mapped] of COMMAND_ANSWERS) {
    it(`replies ${mapped} for ${decision}, and reports the request as resolved`, async () => {
      const { run, answered } = await openAndAnswer(COMMAND, COMMAND_PARAMS, decision);

      expect(answered.result).toEqual({ decision: mapped });
      expect(answered.error).toBeUndefined();
      const resolved = filterByTag(run.seen, "request.resolved");
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({ decision });
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
    expect(opened.request).toMatchObject({
      decisions: ["allow", "allow_always", "deny", "cancel"],
    });
  });

  for (const [decision, mapped] of FILE_ANSWERS) {
    it(`replies ${mapped} for ${decision}`, async () => {
      const { run, answered } = await openAndAnswer(FILE_CHANGE, FILE_CHANGE_PARAMS, decision);

      expect(answered.result).toEqual({ decision: mapped });
      expect(listResolutions(run)).toEqual([decision]);
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
    expect(opened.request).toMatchObject({ decisions: ["allow", "allow_always", "deny"] });
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
    expect(listResolutions(run)).toEqual(["deny"]);
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
    expect(opened.request).toMatchObject({ decisions: ["allow", "deny", "cancel"] });
  });

  for (const [decision, mapped] of ELICITATION_ANSWERS) {
    it(`replies ${JSON.stringify(mapped)} for ${decision}`, async () => {
      const { run, answered } = await openAndAnswer(ELICITATION, ELICITATION_PARAMS, decision);

      expect(answered.result).toMatchObject(mapped as Record<string, unknown>);
      expect(listResolutions(run)).toEqual([decision]);
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
  it("shows it as a question, which takes answers and no decision", async () => {
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
    expect(opened.request).not.toHaveProperty("decisions");
  });

  for (const decision of ["deny", "cancel"] as const) {
    it(`ignores a ${decision}, because a question is turned down by stopping the turn`, async () => {
      const run = await pushServerRequest(USER_INPUT, USER_INPUT_PARAMS);
      const opened = await awaitOpenedRequest(run);

      await Effect.runPromise(
        run.adapter.respondToApprovalRequest(SESSION, opened.request.requestId, decision),
      );

      await settle();
      expect(run.answered).toEqual([]);
      expect(filterByTag(run.seen, "request.resolved")).toEqual([]);
      expect(listSentParams(run.requests, "turn/interrupt")).toEqual([]);
    });
  }
});

/** Sends a question, resolves it with `answers`, and returns the run and the adapter's reply. */
const openAndAnswerQuestion = async (
  params: unknown,
  answers: QuestionAnswers,
): Promise<{ readonly run: Run; readonly answered: Answered }> => {
  const run = await pushServerRequest(USER_INPUT, params);
  const opened = await awaitOpenedRequest(run);
  await Effect.runPromise(
    run.adapter.respondToQuestion(SESSION, opened.request.requestId, answers),
  );
  return { run, answered: await awaitAnswer(run) };
};

/** Two questions, so a test can tell which answer went to which question id. */
const TWO_QUESTIONS_PARAMS = {
  ...USER_INPUT_PARAMS,
  questions: [
    USER_INPUT_PARAMS.questions[0],
    {
      id: "q2",
      header: "Reason",
      question: "Why deploy now?",
      isOther: true,
      isSecret: false,
      options: null,
    },
  ],
};

describe("answering a question the agent asks", () => {
  it("replies with each answer as a list under its question id, and reports the answers", async () => {
    const answers: QuestionAnswers = { "Deploy target": ["staging"], Reason: "the fix is urgent" };

    const { run, answered } = await openAndAnswerQuestion(TWO_QUESTIONS_PARAMS, answers);

    // A single answer is sent as a list of one, because that is the only
    // shape the reply has.
    expect(answered.result).toEqual({
      answers: {
        q1: { answers: ["staging"] },
        q2: { answers: ["the fix is urgent"] },
      },
    });
    expect(answered.error).toBeUndefined();
    // The stream records what the user said, not a decision standing in for it.
    expect(listResolutions(run)).toEqual([answers]);
  });

  it("does not interrupt the turn after the answers", async () => {
    const { run } = await openAndAnswerQuestion(USER_INPUT_PARAMS, { "Deploy target": "staging" });

    await settle();
    // The agent goes on with the answer in the same turn.
    expect(listSentParams(run.requests, "turn/interrupt")).toEqual([]);
    expect(filterByTag(run.seen, "turn.completed")).toEqual([]);
  });

  it("answers a question while another Request stays open", async () => {
    const run = await pushServerRequest(USER_INPUT, USER_INPUT_PARAMS);
    run.server.push({ id: SECOND_ID, method: COMMAND, params: COMMAND_PARAMS });
    await settle();
    await waitUntil(
      "opened both requests",
      () => filterByTag(run.seen, "request.opened").length === 2,
    );
    const question = filterByTag(run.seen, "request.opened")[0]!;

    await Effect.runPromise(
      run.adapter.respondToQuestion(SESSION, question.request.requestId, {
        "Deploy target": "production",
      }),
    );

    expect((await awaitAnswer(run, ID)).result).toEqual({
      answers: { q1: { answers: ["production"] } },
    });
    await waitUntil(
      "opened the second",
      () => filterByTag(run.seen, "request.opened").length === 2,
    );
    expect(filterByTag(run.seen, "request.opened")[1]?.request.kind).toBe("command_approval");
  });

  it("ignores answers to an approval request", async () => {
    const run = await pushServerRequest(COMMAND, COMMAND_PARAMS);
    const opened = await awaitOpenedRequest(run);

    await Effect.runPromise(
      run.adapter.respondToQuestion(SESSION, opened.request.requestId, {
        "Deploy target": "staging",
      }),
    );

    await settle();
    expect(run.answered).toEqual([]);
    expect(filterByTag(run.seen, "request.resolved")).toEqual([]);
  });

  it("ignores answers to a question shown as a tool approval", async () => {
    const run = await pushServerRequest(USER_INPUT, {
      ...USER_INPUT_PARAMS,
      questions: [{ ...USER_INPUT_PARAMS.questions[0], header: "" }],
    });
    const opened = await awaitOpenedRequest(run);

    await Effect.runPromise(
      run.adapter.respondToQuestion(SESSION, opened.request.requestId, {
        "Deploy target": "staging",
      }),
    );

    await settle();
    expect(run.answered).toEqual([]);
    expect(filterByTag(run.seen, "request.resolved")).toEqual([]);
  });
});

describe("the question request built from a Codex question", () => {
  it("keeps a secret question and marks it secret, so the user is warned before answering", async () => {
    const run = await pushServerRequest(USER_INPUT, {
      ...USER_INPUT_PARAMS,
      questions: [{ ...USER_INPUT_PARAMS.questions[0], isSecret: true }],
    });

    const opened = await awaitOpenedRequest(run);
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
          secret: true,
        },
      ],
    });
  });

  it("shows a question with no options as a question with an empty option list", async () => {
    const run = await pushServerRequest(USER_INPUT, {
      ...USER_INPUT_PARAMS,
      questions: [TWO_QUESTIONS_PARAMS.questions[1]],
    });

    const opened = await awaitOpenedRequest(run);
    expect(opened.request.detail).toEqual({
      questions: [
        { header: "Reason", question: "Why deploy now?", multiSelect: false, options: [] },
      ],
    });
  });

  it("numbers a header that repeats an earlier question's, and sends each answer to its own question", async () => {
    const answers: QuestionAnswers = { "Deploy target": "staging", "Deploy target (2)": "now" };
    const { run, answered } = await openAndAnswerQuestion(
      {
        ...USER_INPUT_PARAMS,
        questions: [
          USER_INPUT_PARAMS.questions[0],
          { ...TWO_QUESTIONS_PARAMS.questions[1], header: "Deploy target" },
        ],
      },
      answers,
    );

    const opened = filterByTag(run.seen, "request.opened")[0];
    expect(
      opened?.request.kind === "question"
        ? opened.request.detail.questions.map((question) => question.header)
        : [],
    ).toEqual(["Deploy target", "Deploy target (2)"]);
    expect(answered.result).toEqual({
      answers: { q1: { answers: ["staging"] }, q2: { answers: ["now"] } },
    });
  });

  it("drops a question whose id repeats an earlier question's id, so no answer is sent under another's id", async () => {
    const answers: QuestionAnswers = { "Deploy target": "staging" };
    const { run, answered } = await openAndAnswerQuestion(
      {
        ...USER_INPUT_PARAMS,
        questions: [
          USER_INPUT_PARAMS.questions[0],
          { ...TWO_QUESTIONS_PARAMS.questions[1], id: "q1" },
        ],
      },
      answers,
    );

    const opened = filterByTag(run.seen, "request.opened")[0];
    expect(
      opened?.request.kind === "question"
        ? opened.request.detail.questions.map((question) => question.header)
        : [],
    ).toEqual(["Deploy target"]);
    expect(answered.result).toEqual({ answers: { q1: { answers: ["staging"] } } });
  });

  it("falls back to a tool approval that can be denied when no question can be read", async () => {
    const run = await pushServerRequest(USER_INPUT, {
      ...USER_INPUT_PARAMS,
      questions: [{ ...USER_INPUT_PARAMS.questions[0], header: "" }],
    });

    const opened = await awaitOpenedRequest(run);
    expect(opened.request.kind).toBe("tool_approval");
    expect(opened.request.detail).toEqual({ toolName: "requestUserInput" });
    expect(opened.request).toMatchObject({ decisions: ["deny", "cancel"] });
  });

  it("replies with an error when that tool approval is denied, and lets the turn go on", async () => {
    const { run, answered } = await openAndAnswer(
      USER_INPUT,
      { ...USER_INPUT_PARAMS, questions: [{ ...USER_INPUT_PARAMS.questions[0], header: "" }] },
      "deny",
    );

    // The reply has no way to decline, so the deny is an error reply.
    expect(answered.error).toEqual(DECLINED);
    await settle();
    expect(listSentParams(run.requests, "turn/interrupt")).toEqual([]);
    expect(listResolutions(run)).toEqual(["deny"]);
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
      run.adapter.respondToApprovalRequest(SESSION, opened.request.requestId, "allow"),
    );

    expect((await awaitAnswer(run)).result).toEqual({ decision: "accept" });
    expect(listResolutions(run)).toEqual(["allow"]);
    // The turn is still running: an input now steers it rather than starting
    // a second turn beside it.
    const sent = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "carry on" }));
    expect(sent).toEqual({ turnId: TURN, delivery: "steered" });
    expect(filterByTag(run.seen, "turn.completed")).toEqual([]);
  });
});

describe("a second request Codex sends before the first is resolved", () => {
  const SECOND_PARAMS = { ...COMMAND_PARAMS, itemId: FILE_ITEM, command: "rm -rf dist" };

  it("opens both at once and accepts answers in reverse order", async () => {
    const run = await pushServerRequest(COMMAND, COMMAND_PARAMS);
    run.server.push({ id: SECOND_ID, method: COMMAND, params: SECOND_PARAMS });
    await waitUntil(
      "opened both requests",
      () => filterByTag(run.seen, "request.opened").length === 2,
    );
    const [first, second] = filterByTag(run.seen, "request.opened");
    expect(run.answered).toEqual([]);
    await Effect.runPromise(
      run.adapter.respondToApprovalRequest(SESSION, second!.request.requestId, "deny"),
    );
    expect((await awaitAnswer(run, SECOND_ID)).result).toEqual({ decision: "decline" });
    expect(run.answered.some((reply) => reply.id === ID)).toBe(false);
    await Effect.runPromise(
      run.adapter.respondToApprovalRequest(SESSION, first!.request.requestId, "allow_always"),
    );
    expect((await awaitAnswer(run, ID)).result).toEqual({ decision: "acceptForSession" });
    expect(listResolutions(run)).toEqual(["deny", "allow_always"]);
    expect(filterByTag(run.seen, "request.resolved").map((event) => event.requestId)).toEqual([
      second!.request.requestId,
      first!.request.requestId,
    ]);
  });

  it("cancels every open Request when the session is interrupted", async () => {
    const run = await pushServerRequest(COMMAND, COMMAND_PARAMS);
    run.server.push({ id: SECOND_ID, method: COMMAND, params: SECOND_PARAMS });
    await waitUntil(
      "opened both requests",
      () => filterByTag(run.seen, "request.opened").length === 2,
    );
    await Effect.runPromise(run.adapter.interrupt(SESSION));
    expect((await awaitAnswer(run, ID)).result).toEqual({ decision: "cancel" });
    expect((await awaitAnswer(run, SECOND_ID)).result).toEqual({ decision: "cancel" });
    expect(filterByTag(run.seen, "request.resolved")).toHaveLength(2);
    expect(listResolutions(run)).toEqual(["cancel", "cancel"]);
  });

  it("cancels the asker's other Request while leaving its sibling's approval open", async () => {
    const childId = "0199e0e7-0000-7000-8000-0000000000b1";
    const run = await startBusySession({
      "thread/read": () => ({ thread: { id: childId, parentThreadId: THREAD } }),
    });
    run.server.push({
      method: "turn/started",
      params: {
        threadId: childId,
        turn: { id: "child-turn", status: "inProgress", items: [], itemsView: "full" },
      },
    });
    run.server.push({ id: ID, method: COMMAND, params: COMMAND_PARAMS });
    run.server.push({ id: SECOND_ID, method: COMMAND, params: SECOND_PARAMS });
    run.server.push({
      id: "sibling-approval",
      method: COMMAND,
      params: {
        ...COMMAND_PARAMS,
        threadId: childId,
        turnId: "child-turn",
        itemId: "sibling-item",
      },
    });
    await waitUntil(
      "opened both asker Requests and sibling approval",
      () => filterByTag(run.seen, "request.opened").length === 3,
    );
    const opened = filterByTag(run.seen, "request.opened");
    const own = opened.filter((event) => event.subagentId === undefined);
    const sibling = opened.find((event) => event.subagentId === childId)!;
    await Effect.runPromise(
      run.adapter.respondToApprovalRequest(SESSION, own[0]!.request.requestId, "cancel"),
    );
    expect(run.answered).toEqual([
      { id: ID, result: { decision: "cancel" } },
      { id: SECOND_ID, result: { decision: "cancel" } },
    ]);
    expect(filterByTag(run.seen, "request.resolved").map((event) => event.requestId)).toEqual(
      own.map((event) => event.request.requestId),
    );
    expect(listSentParams(run.requests, "turn/interrupt")).toEqual([]);
    await Effect.runPromise(
      run.adapter.respondToApprovalRequest(SESSION, sibling.request.requestId, "allow"),
    );
    expect((await awaitAnswer(run, "sibling-approval")).result).toEqual({ decision: "accept" });
  });

  it("keeps late Requests of the cancelled turn cancelled while later turns and other agents can work", async () => {
    const child = "0199e0e7-0000-7000-8000-0000000000b1";
    const descendant = "0199e0e7-0000-7000-8000-0000000000b2";
    const sibling = "0199e0e7-0000-7000-8000-0000000000b3";
    const run = await startBusySession({
      "thread/read": (params) => {
        const { threadId } = params as { threadId: string };
        return {
          thread: { id: threadId, parentThreadId: threadId === descendant ? child : THREAD },
        };
      },
    });
    const pushTurn = (threadId: string, turnId: string, status = "inProgress") =>
      run.server.push({
        method: status === "inProgress" ? "turn/started" : "turn/completed",
        params: { threadId, turn: { id: turnId, status, items: [], itemsView: "full" } },
      });
    const pushApproval = (threadId: string, turnId: string, id: string) =>
      run.server.push({
        id,
        method: COMMAND,
        params: { ...COMMAND_PARAMS, threadId, turnId, itemId: id },
      });
    for (const id of [child, descendant, sibling]) {
      pushTurn(id, id);
      pushApproval(id, id, id);
    }
    await waitUntil(
      "opened asker, descendant and sibling approvals",
      () => filterByTag(run.seen, "request.opened").length === 3,
    );
    const opened = filterByTag(run.seen, "request.opened");
    const asker = opened.find((event) => event.subagentId === child)!;
    await Effect.runPromise(
      run.adapter.respondToApprovalRequest(SESSION, asker.request.requestId, "cancel"),
    );
    pushApproval(child, child, "late-approval");
    await waitUntil(
      "opened the late approval",
      () => filterByTag(run.seen, "request.opened").length === 4,
    );
    const late = filterByTag(run.seen, "request.opened")[3]!;
    await Effect.runPromise(
      run.adapter.respondToApprovalRequest(SESSION, late.request.requestId, "allow"),
    );
    expect(run.answered).toEqual([
      { id: child, result: { decision: "cancel" } },
      { id: "late-approval", result: { decision: "cancel" } },
    ]);
    expect(filterByTag(run.seen, "request.resolved").map((event) => event.requestId)).toEqual([
      asker.request.requestId,
      late.request.requestId,
    ]);
    pushTurn(child, child, "interrupted");
    pushTurn(child, "new-turn");
    pushApproval(child, "new-turn", "new-approval");
    await waitUntil(
      "opened the subsequent turn's approval",
      () => filterByTag(run.seen, "request.opened").length === 5,
    );
    const current = filterByTag(run.seen, "request.opened")[4]!;
    await Effect.runPromise(
      run.adapter.respondToApprovalRequest(SESSION, current.request.requestId, "allow"),
    );
    for (const event of opened.filter((event) => event.subagentId !== child))
      await Effect.runPromise(
        run.adapter.respondToApprovalRequest(SESSION, event.request.requestId, "allow"),
      );
    expect(run.answered.slice(2)).toEqual([
      { id: "new-approval", result: { decision: "accept" } },
      ...opened
        .filter((event) => event.subagentId !== child)
        .map((event) => ({ id: event.subagentId, result: { decision: "accept" } })),
    ]);
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
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
    expect(listResolutions(run)).toEqual(["cancel"]);
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

describe("a Request from a thread first discovered through its approval", () => {
  it("reads metadata, introduces the child and publishes the Request", async () => {
    const run = await startBusySession({
      "thread/read": () => ({
        thread: {
          id: OTHER_THREAD,
          parentThreadId: THREAD,
          model: "gpt-5.5",
          agentRole: "reviewer",
          agentNickname: "Audit",
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: THREAD,
                depth: 1,
                agent_path: "/root/audit",
                agent_nickname: "Audit",
                agent_role: "reviewer",
              },
            },
          },
        },
      }),
    });
    run.server.push({
      id: "req-c",
      method: COMMAND,
      params: { ...COMMAND_PARAMS, threadId: OTHER_THREAD },
    });
    const opened = await awaitOpenedRequest(run);
    expect(opened.subagentId).toBe(OTHER_THREAD);
    expect(filterByTag(run.seen, "subagent.started")[0]).toMatchObject({
      subagentId: OTHER_THREAD,
      description: "Audit",
      agentType: "reviewer",
    });
    expect(listSentParams(run.requests, "thread/read")).toEqual([
      { threadId: OTHER_THREAD, includeTurns: false },
    ]);
    await Effect.runPromise(
      run.adapter.respondToApprovalRequest(SESSION, opened.request.requestId, "allow"),
    );
    expect((await awaitAnswer(run, "req-c")).result).toEqual({ decision: "accept" });
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
      run.adapter.respondToApprovalRequest(SESSION, opened.request.requestId, "allow"),
    );

    await settle();
    // The request ended with its turn. Codex got a cancel reply when the turn
    // ended, because every request gets a reply, so the user's decision
    // arrives for a request that no longer exists. The controller closed the
    // open request on `turn.completed`, so no resolution is reported either.
    expect(run.answered).toEqual([{ id: ID, result: { decision: "cancel" } }]);
    expect(filterByTag(run.seen, "request.resolved")).toEqual([]);
  });

  it("replies to every open Request when the turn ends", async () => {
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
      { id: ID, result: { decision: "cancel" } },
      { id: SECOND_ID, result: { decision: "cancel" } },
    ]);
    expect(filterByTag(run.seen, "request.resolved")).toEqual([]);
    expect(filterByTag(run.seen, "request.opened")).toHaveLength(2);
  });
});
