/**
 * The records the thread specimen seeds its query cache with, as the
 * controller would return them: the Fix thread of the Bureau book's
 * session-active.html, open, with its transcript, its queued input and the
 * workspace it shares with the Read thread.
 *
 * The Fix thread asked to run `git push` ten minutes ago and has waited on
 * the user since. Its turn ran two work stretches, each ended by a message
 * of the agent's, at the book's times: the user wrote at 09:02, the agent
 * answered at 09:04 and 09:09, and the Request opened at 09:31. Every time is
 * in UTC, which the capture sets as the system time zone.
 *
 * Everything else is the sidebar specimen's (sidebar-fixture.ts), with two
 * changes the header needs: Fix and Read share an own-branch workspace, so
 * the header draws both tabs, and Fix runs Opus 5.5 at high effort with
 * edits accepted, as the book's composer shows it. The sidebar keeps its own
 * Fix thread, because the book's sidebar draws no workspace labels, and it
 * shortens the Request to "Run git push?".
 *
 * The reference sheet reads this module too (thread-reference.ts), to edit
 * the book's thread where the app draws the fixture's words instead of the
 * book's.
 */
import type { Input, OpenRequest, TranscriptRow, Workspace } from "@hercule/contract";
import { buildCheckout, buildWorkspace } from "@hercule/client-core/threads/testing";
import type { EventBody } from "../app/testing";
import { ADA, buildAssistantSession } from "./assistant-states-fixture";
import type { SidebarRecords, ThreadScreenRecords } from "./shell-page";
import {
  buildSpecimenSession,
  CLAUDE_OPUS,
  CLAUDE_SONNET,
  FIX_THREAD_ID,
  SPECIMEN_NOW,
  SPECIMEN_RECORDS,
  STUDIO_MAC,
} from "./sidebar-fixture";

/** The thread that shares the Fix thread's workspace, drawn as the header's second tab. */
const READ_THREAD_ID = "s-read";

/** The Request the Fix thread waits on: may the agent push its branch. */
export const PUSH_REQUEST: OpenRequest = {
  requestId: "rq-fix-push",
  itemId: "it-push",
  kind: "command_approval",
  decisions: ["allow", "allow_always", "deny"],
  detail: { command: "git push -u origin fix/3ds-eu-cards" },
};

/** The workspace Fix and Read work in: its own branch of webshop, on studio-mac. */
const FIX_WORKSPACE: Workspace = buildWorkspace({
  id: "w-fix",
  runnerId: STUDIO_MAC.id,
  kind: "ephemeral",
  checkouts: [
    {
      ...buildCheckout("r-webshop", "fix/3ds-eu-cards", ["main", "fix/3ds-eu-cards"]),
      form: "worktree",
      startingRevision: { kind: "remote", branch: "main" },
    },
  ],
  sessionIds: [FIX_THREAD_ID, READ_THREAD_ID],
});

/** The Fix thread, working and waiting on `PUSH_REQUEST`, which opened ten minutes ago. */
const FIX_SESSION = buildSpecimenSession({
  id: FIX_THREAD_ID,
  title: "Fix 3-D Secure checkout for EU cards",
  projectId: "p-webshop",
  status: "busy",
  minutesAgo: 10,
  model: CLAUDE_OPUS,
  modelSelection: { model: CLAUDE_OPUS.slug, options: { effort: "high" } },
  requestedAccessMode: "auto-accept-edits",
  accessMode: "auto-accept-edits",
  workspaceId: FIX_WORKSPACE.id,
  openRequests: [PUSH_REQUEST],
});

/** The moment the Fix thread's turn started: 2026-09-29 09:02 UTC. */
const TURN_START = Date.UTC(2026, 8, 29, 9, 2, 0);

/** The one turn of the Fix thread. */
const TURN_ID = "turn-1";

/** The row that starts an item, without the fields every event has. */
type ItemStartedBody = Extract<EventBody, { _tag: "item.started" }>;

/** The kind of item a transcript row starts. */
type ItemKind = ItemStartedBody["kind"];

/** What the provider reports about an item as it starts and completes. */
type ItemDetail = NonNullable<ItemStartedBody["detail"]>;

/** One event of the transcript, and how many seconds after `TURN_START` it happened. */
type TranscriptStep = readonly [seconds: number, event: EventBody];

/**
 * Returns the steps of one item that runs from `from` to `to` seconds: its
 * start, the text it wrote when `text` is given, and its completion.
 */
const runItem = (
  [from, to]: readonly [number, number],
  itemId: string,
  kind: ItemKind,
  detail: ItemDetail | undefined,
  text?: string,
): TranscriptStep[] => {
  const item = { turnId: TURN_ID, itemId, kind, ...(detail === undefined ? {} : { detail }) };
  return [
    [from, { _tag: "item.started", ...item }],
    ...(text === undefined
      ? []
      : [
          [
            to,
            {
              _tag: "content.delta",
              turnId: TURN_ID,
              itemId,
              streamKind: "assistant_text",
              delta: text,
            },
          ] as const,
        ]),
    [to, { _tag: "item.completed", ...item, status: "completed" }],
  ];
};

/**
 * Returns the steps of a tool call Claude Code reports: its name and its
 * input, as the adapter passes them on. A file read also carries its fixed
 * field `path`, as the adapter sets it from the input's `file_path`.
 */
const runTool = (
  seconds: readonly [number, number],
  itemId: string,
  kind: ItemKind,
  name: string,
  input: Record<string, string>,
): TranscriptStep[] =>
  runItem(seconds, itemId, kind, {
    ...(kind === "file_read" ? { path: input.file_path } : {}),
    name,
    input,
    ...(kind === "tool_call" ? { kind: "native" } : {}),
  });

/** The agent's first message: the cause, the fix, and how it was made. */
const CAUSE_MESSAGE = [
  "Found it. Since Stripe SDK v14, `confirmPayment` returns `status: 'requires_action'` for cards " +
    "that need 3\u2011D Secure. `handlePaymentResult` in `src/checkout/payment.ts` only handles " +
    '`succeeded` and treats everything else as a failure, so we show "Card declined" instead of ' +
    "opening the 3\u2011D Secure modal.",
  "",
  "```ts",
  'if (result.status === "requires_action") {',
  "  return openThreeDSModal(result.clientSecret);",
  "}",
  "```",
  "",
  "I wrote a failing test first, then the fix.",
].join("\n");

/**
 * The Fix thread's turn, in seconds after 09:02:
 *
 * - 0: the user's message;
 * - 5 to 74: six file reads and one command, the first work stretch;
 * - 134: the agent's first message, 2m 14s after the user's;
 * - 145 to 300: three edits and the test run, the second work stretch;
 * - 431: the agent's second message, 4m 51s after the first one ended;
 * - 1740: the Request to push, at 09:31.
 *
 * The push's own item has not started: the book draws no work stretch after
 * the second message, and a started item would draw one.
 */
const FIX_STEPS: ReadonlyArray<TranscriptStep> = [
  [0, { _tag: "turn.started", turnId: TURN_ID, model: CLAUDE_OPUS.slug }],
  ...runItem([0, 0], "it-ask", "user_message", {
    text:
      "Checkout fails for EU cards that need 3\u2011D Secure since deploy #1289. Find the cause " +
      "and fix it. Add a test that reproduces it first.",
  }),
  ...runTool([5, 6], "it-read-1", "file_read", "Read", { file_path: "src/checkout/payment.ts" }),
  ...runTool([12, 13], "it-read-2", "file_read", "Read", { file_path: "src/checkout/stripe.ts" }),
  ...runTool([20, 21], "it-read-3", "file_read", "Read", {
    file_path: "src/checkout/3ds-modal.tsx",
  }),
  ...runTool([31, 32], "it-read-4", "file_read", "Read", {
    file_path: "src/checkout/checkout.tsx",
  }),
  ...runTool([45, 46], "it-read-5", "file_read", "Read", { file_path: "package.json" }),
  ...runTool([58, 59], "it-read-6", "file_read", "Read", { file_path: "CHANGELOG.md" }),
  ...runTool([70, 74], "it-log", "command_execution", "Bash", {
    command: "git log --oneline -5 -- src/checkout",
  }),
  ...runItem([134, 140], "it-cause", "assistant_message", undefined, CAUSE_MESSAGE),
  ...runTool([145, 150], "it-test", "file_change", "Write", {
    file_path: "src/checkout/payment.test.ts",
  }),
  ...runTool([170, 176], "it-fix", "file_change", "Edit", { file_path: "src/checkout/payment.ts" }),
  ...runTool([190, 195], "it-modal", "file_change", "Edit", {
    file_path: "src/checkout/3ds-modal.tsx",
  }),
  ...runTool([210, 300], "it-run-tests", "command_execution", "Bash", {
    command: "pnpm test checkout",
  }),
  ...runItem(
    [431, 434],
    "it-ready",
    "assistant_message",
    undefined,
    "Tests pass. Ready to push the branch and open a pull request.",
  ),
  [1740, { _tag: "request.opened", request: PUSH_REQUEST }],
];

/** Returns the transcript rows of `steps` for the Fix thread, with positions from 1. */
const buildTranscript = (steps: ReadonlyArray<TranscriptStep>): TranscriptRow[] =>
  steps.map(([seconds, body], index) => {
    const at = new Date(TURN_START + seconds * 1000).toISOString();
    return {
      position: index + 1,
      at,
      event: { ...body, eventId: `event-${String(index + 1)}`, sessionId: FIX_THREAD_ID, at },
    };
  });

/**
 * The Fix thread with two runtime warnings among its work, which the book
 * never draws: a short one between two reads, and a long one, as the runner
 * writes it when it shrinks an oversized event, between the last edit and
 * the test run.
 */
const FIX_STEPS_WITH_WARNINGS: ReadonlyArray<TranscriptStep> = FIX_STEPS.flatMap((step) => {
  const [seconds] = step;
  if (seconds === 31) {
    return [
      [
        24,
        {
          _tag: "runtime.warning",
          turnId: TURN_ID,
          message: "Overloaded (529). Retrying in 4s, attempt 1 of 10.",
        },
      ],
      step,
    ] as const;
  }
  if (seconds === 210) {
    return [
      [
        196,
        {
          _tag: "runtime.warning",
          turnId: TURN_ID,
          message:
            "A tool call result was 6.43 MiB, too large to send (the limit is 2 MiB), so its output " +
            "and raw data were left out. Item toolu_01HZK7Q4X9V3RTD8NB2WMJ5FEA.",
        },
      ],
      step,
    ] as const;
  }
  return [step];
});

/** What the first read returned: the start of src/checkout/payment.ts, with one line wider than the box. */
const PAYMENT_SOURCE = [
  'import type { PaymentIntentResult, Stripe, StripeElements } from "@stripe/stripe-js";',
  'import { reportCheckoutError } from "./errors";',
  "",
  "/** Handles the result of `confirmPayment`, and shows the card error when the payment did not succeed. */",
  "export async function handlePaymentResult(result: PaymentIntentResult): Promise<CheckoutOutcome> {",
  "  if (result.error) {",
  "    reportCheckoutError(result.error);",
  '    return { kind: "declined", message: result.error.message ?? "Card declined" };',
  "  }",
  '  if (result.paymentIntent.status === "succeeded") {',
  '    return { kind: "paid", paymentIntentId: result.paymentIntent.id };',
  "  }",
  '  return { kind: "declined", message: "Card declined" };',
  "}",
].join("\n");

/**
 * Returns `step` with its completion's detail set to `detail`, and its status
 * to `status`, when it completes the item `itemId`; any other step as it is.
 */
const setCompletion = (
  step: TranscriptStep,
  itemId: string,
  status: "completed" | "failed",
  detail: ItemDetail,
): TranscriptStep => {
  const [seconds, event] = step;
  return event._tag === "item.completed" && event.itemId === itemId
    ? [seconds, { ...event, status, detail }]
    : step;
};

/**
 * The Fix thread whose first stretch shows what an open stretch draws, which
 * the book never draws: a web search before the reads, what the first read
 * returned, and a command that failed with its error. The divider's summary
 * differs from the book's, so `pnpm compare:bureau` does not compare it.
 */
const FIX_STEPS_WITH_RESULTS: ReadonlyArray<TranscriptStep> = [
  ...FIX_STEPS.slice(0, 3),
  ...runItem([2, 4], "it-search", "web_search", {
    name: "WebSearch",
    input: { query: "Stripe confirmPayment requires_action 3-D Secure SDK v14" },
  }),
  ...FIX_STEPS.slice(3).map((step) =>
    setCompletion(
      setCompletion(step, "it-read-1", "completed", {
        content: [{ type: "text", text: PAYMENT_SOURCE }],
      }),
      "it-log",
      "failed",
      {
        content:
          "fatal: bad revision 'src/checkout'\nhint: use '--' to separate paths from revisions",
      },
    ),
  ),
];

/** The message the user queued behind the turn, four minutes ago. */
const QUEUED_INPUT: Input = {
  id: "in-apple-pay",
  sessionId: FIX_THREAD_ID,
  source: "user",
  actor: "user",
  text: "Also check the Apple Pay path",
  attachments: [],
  status: "queued",
  delivery: null,
  createdAt: new Date(SPECIMEN_NOW - 4 * 60_000).toISOString(),
  deliveredAt: null,
  sentAt: null,
  reason: null,
};

/** The Fix thread as the thread screen reads it. */
export const FIX_THREAD: ThreadScreenRecords = {
  session: FIX_SESSION,
  transcript: buildTranscript(FIX_STEPS),
  queuedInputs: [QUEUED_INPUT],
};

/** The Fix thread with runtime warnings among its work, for the thread specimen's `?state=warning`. */
export const FIX_THREAD_WITH_WARNINGS: ThreadScreenRecords = {
  ...FIX_THREAD,
  transcript: buildTranscript(FIX_STEPS_WITH_WARNINGS),
};

/** The Fix thread with results in its first stretch, for the thread specimen's `?state=steps`. */
export const FIX_THREAD_WITH_RESULTS: ThreadScreenRecords = {
  ...FIX_THREAD,
  transcript: buildTranscript(FIX_STEPS_WITH_RESULTS),
};

/** Every list the shell reads: the sidebar specimen's, with Fix and Read in `FIX_WORKSPACE`. */
export const THREAD_PAGE_RECORDS: SidebarRecords = {
  ...SPECIMEN_RECORDS,
  threads: SPECIMEN_RECORDS.threads.map((thread) =>
    thread.id === FIX_THREAD_ID
      ? FIX_SESSION
      : thread.id === READ_THREAD_ID
        ? { ...thread, workspaceId: FIX_WORKSPACE.id }
        : thread,
  ),
  workspaces: [FIX_WORKSPACE],
};

/** The thread whose agent sends the Fix thread a message: its face is lime, a loud hue. */
const STRIPE_THREAD = buildSpecimenSession({
  id: "01a0ec64-6e80-7000-8000-000000000103",
  title: "Upgrade Stripe SDK to v15",
  projectId: "p-webshop",
  status: "busy",
  minutesAgo: 30,
  model: CLAUDE_SONNET,
});

/**
 * The thread whose agent answers the Fix thread with a short "OK": its title
 * is longer than a sender chip, which ends it in an ellipsis without
 * stretching the short bubble under it.
 */
const IDEMPOTENCY_THREAD = buildSpecimenSession({
  id: "01a0ec64-6e80-7000-8000-000000000104",
  title: "Move every checkout webhook handler onto the new idempotency keys",
  projectId: "p-webshop",
  status: "busy",
  minutesAgo: 12,
  model: CLAUDE_SONNET,
});

/** A session that sent the Fix thread a message and can no longer be read: its face is teal. */
const GONE_SESSION_ID = "01a0ec64-6e80-7000-8000-000000000100";

/** The session of Ada's main conversation, whose agent sends the Fix thread a message as Ada. */
const ADA_SESSION = buildAssistantSession(ADA, { minutesAgo: 5, status: "busy" });

/** Returns the steps of a message sent into the Fix thread's running turn at `seconds`. */
const steerMessage = (
  seconds: number,
  itemId: string,
  text: string,
  senderSessionId?: string,
): TranscriptStep[] =>
  runItem([seconds, seconds], itemId, "user_message", {
    text,
    steered: true,
    ...(senderSessionId === undefined ? {} : { senderSessionId }),
  });

/**
 * The Fix thread with messages other agents sent into its turn, which the
 * book never draws:
 *
 * - at 09:05, the Stripe thread's agent steers a message in, between two edits;
 * - at 09:09, after the agent's second message, the user steers one in;
 * - then Ada sends one, a session that can no longer be read sends one, and
 *   the thread with the long title answers "OK".
 */
const FIX_STEPS_WITH_SENDERS: ReadonlyArray<TranscriptStep> = FIX_STEPS.flatMap((step) => {
  const [seconds] = step;
  if (seconds === 190) {
    return [
      ...steerMessage(
        180,
        "it-from-stripe",
        "Heads up: I'm bumping `stripe` to v15 in `package.json` on `chore/stripe-15`. v15 " +
          "renames `requires_action` to `requires_customer_action`. Please match on both so " +
          "your fix survives my merge.",
        STRIPE_THREAD.id,
      ),
      step,
    ];
  }
  if (seconds === 1740) {
    return [
      ...steerMessage(440, "it-from-user", "Also keep the old error copy for real declines."),
      ...steerMessage(
        460,
        "it-from-ada",
        "Rogier asked me to check: does the fix cover saved cards too?",
        ADA_SESSION.id,
      ),
      ...steerMessage(
        470,
        "it-from-gone",
        "Done with the shared fixture, it's yours.",
        GONE_SESSION_ID,
      ),
      ...steerMessage(475, "it-from-idempotency", "OK", IDEMPOTENCY_THREAD.id),
      step,
    ];
  }
  return [step];
});

/** Returns an input another session's agent queued for the Fix thread `minutesAgo` minutes ago. */
const buildAgentInput = (
  id: string,
  senderSessionId: string,
  text: string,
  minutesAgo: number,
): Input => ({
  ...QUEUED_INPUT,
  id,
  actor: `session:${senderSessionId}`,
  text,
  createdAt: new Date(SPECIMEN_NOW - minutesAgo * 60_000).toISOString(),
});

/**
 * The Fix thread with messages from other agents in its transcript and its
 * queue, for the thread specimen's `?state=senders`: the user's queued input,
 * then one the Stripe thread's agent queued, one from the session that can
 * no longer be read, and the long-titled thread's "OK".
 */
export const FIX_THREAD_WITH_SENDERS: ThreadScreenRecords = {
  session: FIX_SESSION,
  transcript: buildTranscript(FIX_STEPS_WITH_SENDERS),
  queuedInputs: [
    QUEUED_INPUT,
    buildAgentInput(
      "in-from-stripe",
      STRIPE_THREAD.id,
      "When you're done, rebase on chore/stripe-15 and run the checkout suite against v15",
      3,
    ),
    buildAgentInput("in-from-gone", GONE_SESSION_ID, "Shared fixture is free again.", 2),
    buildAgentInput("in-from-idempotency", IDEMPOTENCY_THREAD.id, "OK", 1),
  ],
  senders: [
    { id: STRIPE_THREAD.id, session: STRIPE_THREAD },
    { id: ADA_SESSION.id, session: ADA_SESSION },
    { id: GONE_SESSION_ID, session: null },
    { id: IDEMPOTENCY_THREAD.id, session: IDEMPOTENCY_THREAD },
  ],
};

/** The shell's lists for `FIX_THREAD_WITH_SENDERS`: the thread page's, with Ada among the assistants. */
export const SENDERS_PAGE_RECORDS: SidebarRecords = {
  ...THREAD_PAGE_RECORDS,
  assistants: [{ assistant: ADA, currentSession: ADA_SESSION }],
};
