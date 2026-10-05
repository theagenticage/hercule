/**
 * PROTOTYPE (#354), throwaway. The records the subagents prototype draws: one
 * thread whose main agent split an audit across subagents, in two states.
 *
 * - `?state=busy` (default): the main agent is still working and asks to run
 *   `stripe listen`. A grandchild subagent asks too, so two Requests are open.
 * - `?state=idle`: the main agent's turn ended. The iDEAL subagent still runs
 *   in the background, and its grandchild still waits on the user.
 *
 * The subagent records follow the `Subagent` shape decided in #352 (id,
 * parent, item id, description, status, started, ended), plus what the
 * prototype needs to draw: a type, a brief, a live activity line, a one-line
 * result and the subagent's own transcript rows.
 */
import type { OpenRequest, Session, TranscriptRow } from "@hercule/contract";
import { buildSpecimenSession, CLAUDE_OPUS, FIX_THREAD_ID } from "../sidebar-fixture";

export type SubagentStatus = "running" | "completed" | "failed" | "stopped";

export interface ProtoSubagent {
  readonly id: string;
  readonly parentId: string | null;
  readonly itemId: string;
  readonly description: string | null;
  readonly agentType: string;
  readonly status: SubagentStatus;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** What a running subagent is doing right now, as one line. */
  readonly activity: string | null;
  /** How a finished subagent ended, as one line. */
  readonly result: string | null;
  /** What its parent asked it to do. */
  readonly brief: string;
  readonly tokens: number;
  readonly rows: readonly TranscriptRow[];
}

export interface ProtoRequest {
  readonly request: OpenRequest;
  /** `null` for the main agent. */
  readonly subagentId: string | null;
  readonly openedAt: string;
}

export interface Scenario {
  readonly state: "busy" | "idle";
  readonly session: Session;
  readonly mainRows: readonly TranscriptRow[];
  readonly subagents: readonly ProtoSubagent[];
  /** Oldest first. */
  readonly requests: readonly ProtoRequest[];
}

export const THREAD_ID = FIX_THREAD_ID;

/** The main turn started at 09:24 UTC; the specimen's clock stands at 09:41. */
const T0 = Date.UTC(2026, 8, 29, 9, 24, 0);
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();

type Body = Record<string, unknown> & { readonly _tag: string };
type Step = readonly [seconds: number, body: Body];

const item = (
  turnId: string,
  [from, to]: readonly [number, number | null],
  itemId: string,
  kind: string,
  detail?: Record<string, unknown>,
  text?: string,
  status: string = "completed",
): Step[] => {
  const base = { turnId, itemId, kind, ...(detail === undefined ? {} : { detail }) };
  const steps: Step[] = [[from, { _tag: "item.started", ...base }]];
  if (to === null) return steps;
  if (text !== undefined) {
    steps.push([
      to,
      { _tag: "content.delta", turnId, itemId, streamKind: "assistant_text", delta: text },
    ]);
  }
  steps.push([to, { _tag: "item.completed", ...base, status }]);
  return steps;
};

const tool = (
  turnId: string,
  span: readonly [number, number | null],
  itemId: string,
  kind: "tool_call" | "command_execution" | "file_change" | "web_search",
  name: string,
  input: Record<string, string>,
  status?: string,
): Step[] =>
  item(
    turnId,
    span,
    itemId,
    kind,
    { name, input, ...(kind === "tool_call" ? { kind: "native" } : {}) },
    undefined,
    status,
  );

const message = (turnId: string, span: readonly [number, number], itemId: string, text: string) =>
  item(turnId, span, itemId, "assistant_message", undefined, text);

const spawn = (
  turnId: string,
  span: readonly [number, number | null],
  itemId: string,
  description: string | null,
  status = "completed",
): Step[] =>
  item(
    turnId,
    span,
    itemId,
    "subagent",
    { name: "Task", input: description === null ? {} : { description } },
    undefined,
    status,
  );

const buildRows = (prefix: string, steps: readonly Step[]): TranscriptRow[] =>
  [...steps]
    .sort((a, b) => a[0] - b[0])
    .map(([seconds, body], index) => ({
      position: index + 1,
      at: at(seconds),
      event: {
        ...body,
        eventId: `${prefix}-${String(index + 1)}`,
        sessionId: THREAD_ID,
        at: at(seconds),
      } as unknown as TranscriptRow["event"],
    }));

const MOLLIE_REQUEST: OpenRequest = {
  requestId: "rq-mollie",
  itemId: "it-mollie-curl",
  kind: "command_approval",
  decisions: ["allow", "allow_always", "deny"],
  detail: { command: "curl -s https://docs.mollie.com/reference/get-payment" },
};

const MAIN_REQUEST: OpenRequest = {
  requestId: "rq-stripe-listen",
  itemId: "it-stripe-listen",
  kind: "command_approval",
  decisions: ["allow", "allow_always", "deny"],
  detail: { command: "stripe listen --forward-to localhost:3000/api/webhooks" },
};

const REPORT = [
  "Here's where the audit stands:",
  "",
  "- **3-D Secure**: fine. Every path handles `requires_action`.",
  "- **SEPA Direct Debit**: the check failed. This workspace has no Stripe test key, so it could not list mandates. Set `STRIPE_SECRET_KEY` and I'll run it again.",
  "- **Apple Pay**: you stopped that check before it finished.",
  "- **iDEAL**: still running in the background. I'll report when it's done.",
].join("\n");

const buildMainRows = (state: "busy" | "idle"): TranscriptRow[] => {
  const t = "turn-main";
  const steps: Step[] = [
    [0, { _tag: "turn.started", turnId: t, model: CLAUDE_OPUS.slug }],
    ...item(t, [0, 0], "it-ask", "user_message", {
      text:
        "We launch in the EU on Monday. Audit checkout for anything that breaks for EU shoppers: " +
        "3-D Secure, SEPA Direct Debit, the iDEAL redirect and Apple Pay. Use one subagent per area.",
    }),
    ...tool(t, [6, 7], "it-read-1", "tool_call", "Read", { file_path: "src/checkout/payment.ts" }),
    ...tool(t, [10, 11], "it-read-2", "tool_call", "Read", {
      file_path: "src/checkout/methods.ts",
    }),
    ...tool(t, [14, 15], "it-grep", "tool_call", "Grep", { pattern: "ideal|sepa|applePay" }),
    ...spawn(t, [28, 168], "it-sa-3ds", "Check the 3-D Secure flow"),
    ...spawn(t, [29, 101], "it-sa-sepa", "Check SEPA Direct Debit mandates", "failed"),
    ...spawn(t, [30, 31], "it-sa-ideal", "Check the iDEAL redirect"),
    ...spawn(t, [31, 205], "it-sa-apple", "Check the Apple Pay path", "failed"),
    ...message(t, [240, 246], "it-report", REPORT),
  ];
  if (state === "idle") {
    steps.push([247, { _tag: "turn.completed", turnId: t, state: "completed" }]);
  } else {
    steps.push(
      ...tool(t, [250, 330], "it-tests", "command_execution", "Bash", {
        command: "pnpm test checkout",
      }),
      ...message(
        t,
        [340, 342],
        "it-webhooks",
        "Tests pass. To check the webhooks the iDEAL subagent will need, I want to forward Stripe's events to the dev server.",
      ),
      [720, { _tag: "request.opened", request: MAIN_REQUEST }],
    );
  }
  return buildRows("main", steps);
};

const turnStart = (t: string, s: number): Step => [
  s,
  { _tag: "turn.started", turnId: t, model: "claude-sonnet-5" },
];
const turnEnd = (t: string, s: number, state: string, error?: string): Step => [
  s,
  { _tag: "turn.completed", turnId: t, state, ...(error === undefined ? {} : { error }) },
];

const SUBAGENTS: readonly ProtoSubagent[] = [
  {
    id: "toolu_01H3dsVq8fK2pLm4nR7sT9aB",
    parentId: null,
    itemId: "it-sa-3ds",
    description: "Check the 3-D Secure flow",
    agentType: "Explore",
    status: "completed",
    startedAt: at(28),
    endedAt: at(168),
    activity: null,
    result: "No issues: every path handles requires_action",
    brief:
      "Check the 3-D Secure flow in src/checkout for EU cards. Report any path where `requires_action` is not handled. Do not edit files.",
    tokens: 18_400,
    rows: buildRows("3ds", [
      turnStart("t-3ds", 28),
      ...tool("t-3ds", [33, 34], "3ds-r1", "tool_call", "Read", {
        file_path: "src/checkout/payment.ts",
      }),
      ...tool("t-3ds", [40, 41], "3ds-r2", "tool_call", "Read", {
        file_path: "src/checkout/3ds-modal.tsx",
      }),
      ...tool("t-3ds", [52, 53], "3ds-g", "tool_call", "Grep", { pattern: "requires_action" }),
      ...tool("t-3ds", [70, 71], "3ds-r3", "tool_call", "Read", {
        file_path: "src/checkout/stripe.ts",
      }),
      ...message(
        "t-3ds",
        [160, 166],
        "3ds-m",
        "Every path handles `requires_action`: `handlePaymentResult` opens the 3-D Secure modal, and the saved-card path goes through the same function. No issues found.",
      ),
      turnEnd("t-3ds", 168, "completed"),
    ]),
  },
  {
    id: "toolu_01SePa7mWq3xYb9cKd2EfGh4",
    parentId: null,
    itemId: "it-sa-sepa",
    description: "Check SEPA Direct Debit mandates",
    agentType: "general-purpose",
    status: "failed",
    startedAt: at(29),
    endedAt: at(101),
    activity: null,
    result: "Failed: STRIPE_SECRET_KEY is not set in this workspace",
    brief:
      "Check that SEPA Direct Debit mandates are created at checkout and shown on the order page. Use the Stripe CLI against test mode.",
    tokens: 9_100,
    rows: buildRows("sepa", [
      turnStart("t-sepa", 29),
      ...tool("t-sepa", [35, 36], "sepa-r1", "tool_call", "Read", {
        file_path: "src/checkout/sepa.ts",
      }),
      ...tool(
        "t-sepa",
        [60, 62],
        "sepa-c1",
        "command_execution",
        "Bash",
        {
          command: "stripe mandates list --limit 3",
        },
        "failed",
      ),
      turnEnd("t-sepa", 101, "failed", "STRIPE_SECRET_KEY is not set in this workspace."),
    ]),
  },
  {
    id: "toolu_01iDeAL5nRt8uVw2XyZ3aBc6",
    parentId: null,
    itemId: "it-sa-ideal",
    description: "Check the iDEAL redirect",
    agentType: "general-purpose",
    status: "running",
    startedAt: at(30),
    endedAt: null,
    activity: "Reading src/checkout/webhooks.ts",
    result: null,
    brief:
      "Check the iDEAL redirect end to end: the return URL, the webhook, and what the shopper sees when they cancel at their bank. Use subagents if it helps. Run in the background.",
    tokens: 41_700,
    rows: buildRows("ideal", [
      turnStart("t-ideal", 30),
      ...tool("t-ideal", [35, 36], "ideal-r1", "tool_call", "Read", {
        file_path: "src/checkout/ideal.ts",
      }),
      ...tool("t-ideal", [40, 41], "ideal-r2", "tool_call", "Read", {
        file_path: "src/checkout/ideal-return.ts",
      }),
      ...spawn("t-ideal", [60, null], "it-sa-mollie", "Read Mollie's iDEAL docs"),
      ...spawn("t-ideal", [62, 290], "it-sa-anon", null),
      ...message(
        "t-ideal",
        [300, 306],
        "ideal-m1",
        "Found one problem so far: when the shopper cancels at their bank, `ideal-return.ts` drops the `payment_intent` query parameter, so the order stays **pending** forever. Still waiting on the Mollie docs check before I look at the webhook.",
      ),
      ...tool("t-ideal", [320, null], "ideal-r3", "tool_call", "Read", {
        file_path: "src/checkout/webhooks.ts",
      }),
    ]),
  },
  {
    id: "toolu_01MoLLie4kP9qRs2TuV7wXy1",
    parentId: "toolu_01iDeAL5nRt8uVw2XyZ3aBc6",
    itemId: "it-sa-mollie",
    description: "Read Mollie's iDEAL docs",
    agentType: "general-purpose",
    status: "running",
    startedAt: at(60),
    endedAt: null,
    activity: "Waiting on you: run curl -s https://docs.mollie.com/…",
    result: null,
    brief:
      "Read Mollie's iDEAL docs and tell me which status a payment ends in when the shopper cancels at their bank.",
    tokens: 6_200,
    rows: buildRows("mollie", [
      turnStart("t-mollie", 60),
      ...tool("t-mollie", [66, 70], "mollie-s", "web_search", "WebSearch", {
        query: "mollie ideal cancelled payment status",
      }),
      [300, { _tag: "request.opened", request: MOLLIE_REQUEST }],
    ]),
  },
  {
    id: "toolu_01AnoN2bC4dE6fG8hJ0kL2mN",
    parentId: "toolu_01iDeAL5nRt8uVw2XyZ3aBc6",
    itemId: "it-sa-anon",
    description: null,
    agentType: "general-purpose",
    status: "completed",
    startedAt: at(62),
    endedAt: at(290),
    activity: null,
    result: "Two places build an iDEAL return URL",
    brief: "List every place that builds an iDEAL return URL, with file and line.",
    tokens: 7_800,
    rows: buildRows("anon", [
      turnStart("t-anon", 62),
      ...tool("t-anon", [64, 65], "anon-g", "tool_call", "Grep", { pattern: "return_url" }),
      ...tool("t-anon", [70, 71], "anon-r1", "tool_call", "Read", {
        file_path: "src/checkout/ideal.ts",
      }),
      ...message(
        "t-anon",
        [284, 288],
        "anon-m",
        "Two places build an iDEAL return URL:\n\n- `src/checkout/ideal.ts:42`, `buildReturnUrl`\n- `src/checkout/ideal-return.ts:17`, the retry after a cancel",
      ),
      turnEnd("t-anon", 290, "completed"),
    ]),
  },
  {
    id: "toolu_01ApPLe9zY8xW7vU6tS5rQ4p",
    parentId: null,
    itemId: "it-sa-apple",
    description: "Check the Apple Pay path",
    agentType: "general-purpose",
    status: "stopped",
    startedAt: at(31),
    endedAt: at(205),
    activity: null,
    result: "Stopped by you",
    brief:
      "Check the Apple Pay path for EU cards, including merchant validation and the 3-D Secure fallback.",
    tokens: 12_300,
    rows: buildRows("apple", [
      turnStart("t-apple", 31),
      ...tool("t-apple", [36, 37], "apple-r1", "tool_call", "Read", {
        file_path: "src/checkout/apple-pay.ts",
      }),
      ...tool("t-apple", [48, 49], "apple-r2", "tool_call", "Read", {
        file_path: "src/checkout/merchant-validation.ts",
      }),
      ...tool("t-apple", [80, 81], "apple-r3", "tool_call", "Read", {
        file_path: "src/checkout/3ds-modal.tsx",
      }),
      turnEnd("t-apple", 205, "interrupted"),
    ]),
  },
];

/** Builds the scenario for `state`. */
export const buildScenario = (state: "busy" | "idle"): Scenario => {
  const requests: ProtoRequest[] = [
    { request: MOLLIE_REQUEST, subagentId: "toolu_01MoLLie4kP9qRs2TuV7wXy1", openedAt: at(300) },
    ...(state === "busy" ? [{ request: MAIN_REQUEST, subagentId: null, openedAt: at(720) }] : []),
  ];
  const session = buildSpecimenSession({
    id: THREAD_ID,
    title: "Audit checkout before the EU launch",
    projectId: "p-webshop",
    status: state === "busy" ? "busy" : "idle",
    minutesAgo: 5,
    model: CLAUDE_OPUS,
    modelSelection: { model: CLAUDE_OPUS.slug, options: { effort: "high" } },
    requestedAccessMode: "auto-accept-edits",
    accessMode: "auto-accept-edits",
    workspaceId: "w-fix",
    openRequest: requests[0]!.request,
  });
  return { state, session, mainRows: buildMainRows(state), subagents: SUBAGENTS, requests };
};
