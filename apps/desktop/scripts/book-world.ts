/**
 * Starts a throwaway controller filled with the Crew Bureau book's world, as
 * `docs/design/shared/CONTENT.md` describes it, so an app can be signed in to
 * and compared with the book's pages:
 * `pnpm --filter @hercule/desktop world:book`, after `pnpm build:binary`.
 * `world:book --port 4950` asks for a fixed port, so a device's saved URL
 * keeps working across runs. Without it, a free port is picked.
 *
 * It binds to 127.0.0.1, which the Android emulator reaches as 10.0.2.2.
 * `world:book --host <address>` binds to another address instead, such as the
 * Mac's tailnet address (`tailscale ip -4`), so a phone on the tailnet can
 * reach it. The emulator cannot reach a controller bound that way.
 *
 * It starts the compiled binary in a new Hercule Home under the system's temp
 * folder, completes setup, retires the controller's own runner and enlists
 * the book's three scripted runners. Then it creates:
 *
 * - the projects webshop, ops and payments-api;
 * - the assistants Ada, Milo and Juno, with their heartbeats off. Ada is
 *   working: she is still writing her answer to the user's question about
 *   the backup job. Milo has answered a message, so he is idle. Juno has
 *   answered a message and her session was then unloaded, so she is asleep;
 * - the book's threads, on the runner and in the project the book gives each:
 *   three waiting on a Request, seven working and three idle.
 *
 * That is the book's 16 live sessions less the paused Trigger: studio-mac
 * holds 5 of its 6, build-box-1 7 of its 8, and build-box-2 3 of its 8.
 *
 * The book's Runs ("Ship release v2.15", "Investigate backup timeouts",
 * "Webhook retry backoff", "Cart total rounding on discounts" and "Draft
 * reply to Jonas at Kiteworks") are made as ordinary threads with the same
 * titles, because the phone app shows no Runs. The book's paused Trigger,
 * "Label new issues", is left out. Ages are not set back: every thread looks
 * a few seconds old.
 *
 * Ada's Conversation differs from the book in two ways, because the
 * controller does not run heartbeats yet:
 *
 * - her reply mode is `segments`, not the book's `turn-end`, so a turn
 *   that writes two messages leaves two replies. With `turn-end` only the
 *   turn's last text would be kept;
 * - the Conversation starts with the exchange the desktop app's specimens
 *   give her the evening before. Only a message from the user starts a
 *   session, and the controller refuses `session.input` to an assistant's
 *   session, so her 09:00 morning message is the second reply of that
 *   evening's turn. It then shows with no message from the user before it,
 *   as a heartbeat's would.
 *
 * The first message the user sends Ada is steered into the turn that is
 * still writing the backup answer, so that turn finishes the answer and then
 * answers the message, as two replies.
 *
 * Then it prints the address to sign in at and the account, and keeps
 * running: each message the user sends Ada gets a canned reply. A thread
 * whose Request is answered with an allow, or whose question is answered,
 * finishes its turn. Ctrl-C or SIGTERM stops the runners and the controller
 * and deletes the Home.
 *
 * `world:book --defer-question` holds back the question of "Migrate ops
 * dashboards": the thread writes its first message and keeps working, and
 * the question opens only when the script receives SIGUSR1
 * (`kill -USR1 <script pid>`). An app records the Requests already open
 * when it signs in and alerts for none of them, so this is how a device
 * gets a Request alert to answer.
 *
 * It runs on plain Node, like the perf script, so its imports name the `.ts`
 * file.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import type {
  Assistant,
  ConversationMessage,
  Heartbeat,
  Runner,
  Session,
} from "../../../packages/contract/src/index";
import {
  PASSWORD,
  USERNAME,
  completeSetup,
  deleteMasterKeyItem,
  findCompiledBinary,
  startController,
} from "../../../scripts/controller-process.ts";
import { connectFleet, type Fleet, type TurnProgress } from "./fleet.ts";
import { pollUntil } from "./poll.ts";
import type { ScriptedRunner, ScriptStep } from "./scripted-runner.ts";

/** How long a working thread runs its last command: longer than any session with the app. */
const KEEPS_WORKING_MS = 12 * 3_600_000;

/** The thread whose question `--defer-question` holds back until SIGUSR1. */
const DEFERRED_QUESTION_TITLE = "Migrate ops dashboards";

/** How often the script looks for a new message to Ada. */
const ANSWER_POLL_MS = 250;

/**
 * The heartbeat each assistant gets: turned off. The default wakes an
 * assistant every hour, and nothing would play the turn that opens.
 */
const HEARTBEAT_OFF: Heartbeat = {
  enabled: false,
  schedule: "0 9 * * *",
  prompt: "Check what you are waiting on.",
  target: "web",
};

/** The reply Ada gives every message the user sends her while the world runs. */
const ADA_REPLY = "Got it, Rogier. I'll keep an eye on it and tell you when something changes.";

/**
 * The book's runners and their caps. studio-mac is enlisted first, and the
 * assistants answer their first messages while it is the only runner, so
 * their sessions are placed there, as in the book. An idle session keeps its
 * runner, so later messages go there too.
 */
const RUNNERS = [
  { name: "studio-mac", maxConcurrentSessions: 6 },
  { name: "build-box-1", maxConcurrentSessions: 8 },
  { name: "build-box-2", maxConcurrentSessions: 8 },
] as const;

type RunnerName = (typeof RUNNERS)[number]["name"];

const PROJECT_NAMES = ["webshop", "ops", "payments-api"] as const;

type ProjectName = (typeof PROJECT_NAMES)[number];

/** One of the book's threads: where it runs, what it was asked, and the turn it plays. */
interface BookThread {
  /** The first line of the prompt, which becomes the thread's title. */
  readonly title: string;
  /** The rest of the user's first message. */
  readonly request: string;
  readonly runner: RunnerName;
  readonly project: ProjectName;
  readonly script: ReadonlyArray<ScriptStep>;
  /** Where the first turn has got to once the thread is ready: the lane the app files it in. */
  readonly settlesAs: Extract<TurnProgress, "running" | "waiting" | "completed">;
}

/** The Fix thread's first answer, as the book's session page has it. */
const FIX_CAUSE_MESSAGE = [
  "Found it. Since Stripe SDK v14, `confirmPayment` returns `status: 'requires_action'` for cards " +
    "that need 3‑D Secure. `handlePaymentResult` in `src/checkout/payment.ts` only handles " +
    '`succeeded` and treats everything else as a failure, so we show "Card declined" instead of ' +
    "opening the 3‑D Secure modal.",
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
 * The book's threads, oldest first in the book, so the newest is created
 * last. Each lane holds what the book's office.html shows, without the Runs
 * the app leaves out:
 *
 * - waiting: Fix, Migrate, Ship release;
 * - working: Refactor, Investigate, Webhook, Cart rounding, Payout, Rotate,
 *   Draft reply (and Ada, who is not a thread);
 * - idle: Read, iDEAL, Tidy.
 */
const BOOK_THREADS: ReadonlyArray<BookThread> = [
  {
    title: "Tidy checkout CSS",
    request: "Remove the unused rules from the checkout stylesheet.",
    runner: "build-box-1",
    project: "webshop",
    script: [
      { kind: "file_change", path: "src/checkout/checkout.css" },
      {
        kind: "message",
        text: "Removed 41 unused rules from `checkout.css`. Nothing renders differently.",
      },
      { kind: "end", state: "completed" },
    ],
    settlesAs: "completed",
  },
  {
    title: "Add iDEAL research",
    request: "Find out what adding iDEAL as a payment method takes.",
    runner: "build-box-2",
    project: "payments-api",
    script: [
      {
        kind: "message",
        text: "iDEAL goes through Stripe's Payment Element: no new provider, one more payment method type, and a redirect back to checkout.",
      },
      { kind: "end", state: "completed" },
    ],
    settlesAs: "completed",
  },
  {
    title: "Refactor cart totals",
    request: "Move the cart total calculation into one module, with tests.",
    runner: "build-box-1",
    project: "webshop",
    script: [
      {
        kind: "message",
        text: "Moving the totals into `src/cart/totals.ts`, then running the cart tests.",
      },
      { kind: "file_change", path: "src/cart/totals.ts" },
      { kind: "command", command: "pnpm test cart", forMs: KEEPS_WORKING_MS },
    ],
    settlesAs: "running",
  },
  {
    title: "Read the Stripe v14 changelog",
    request: "Read the Stripe SDK v14 changelog and list what affects checkout.",
    runner: "studio-mac",
    project: "webshop",
    script: [
      {
        kind: "message",
        text: "Two changes affect checkout: `confirmPayment` now returns `requires_action` for 3‑D Secure, and `handleCardAction` is gone.",
      },
      { kind: "end", state: "completed" },
    ],
    settlesAs: "completed",
  },
  {
    title: "Cart total rounding on discounts",
    request:
      "Cart totals are a cent off when a percentage discount applies. Find the rounding error " +
      "and fix it, with a test.",
    runner: "build-box-1",
    project: "webshop",
    script: [
      { kind: "message", text: "Reproducing it with a 15% discount on three items first." },
      { kind: "file_change", path: "src/cart/discounts.test.ts" },
      { kind: "command", command: "pnpm test cart/discounts", forMs: KEEPS_WORKING_MS },
    ],
    settlesAs: "running",
  },
  {
    title: "Rotate staging secrets",
    request: "Rotate every secret in staging and update the services that read them.",
    runner: "build-box-1",
    project: "ops",
    script: [
      { kind: "message", text: "Listing the staging secrets first." },
      { kind: "command", command: "vault kv list secret/staging", forMs: KEEPS_WORKING_MS },
    ],
    settlesAs: "running",
  },
  {
    title: "Fix 3-D Secure checkout for EU cards",
    request:
      "Checkout fails for EU cards that need 3‑D Secure since deploy #1289. Find the cause " +
      "and fix it. Add a test that reproduces it first.",
    runner: "studio-mac",
    project: "webshop",
    script: [
      { kind: "command", command: "git log --oneline -5 -- src/checkout" },
      { kind: "message", text: FIX_CAUSE_MESSAGE },
      { kind: "file_change", path: "src/checkout/payment.test.ts" },
      { kind: "file_change", path: "src/checkout/payment.ts" },
      { kind: "file_change", path: "src/checkout/3ds-modal.tsx" },
      { kind: "command", command: "pnpm test checkout" },
      { kind: "message", text: "Tests pass. Ready to push the branch and open a pull request." },
      { kind: "command", command: "git push -u origin fix/3ds-eu-cards", ask: true },
      { kind: "message", text: "Pushed `fix/3ds-eu-cards`. The pull request is ready for review." },
      { kind: "end", state: "completed" },
    ],
    settlesAs: "waiting",
  },
  {
    title: "Payout report for September",
    request: "Write the payout report for September from the Stripe payouts.",
    runner: "build-box-1",
    project: "payments-api",
    script: [
      { kind: "message", text: "Reading September's payouts from Stripe." },
      {
        kind: "command",
        command: "stripe payouts list --created 2026-09",
        forMs: KEEPS_WORKING_MS,
      },
    ],
    settlesAs: "running",
  },
  {
    title: "Investigate backup timeouts",
    request:
      "The nightly backup job on ops-db has hit its 2h limit three nights in a row. Find out why.",
    runner: "build-box-1",
    project: "ops",
    script: [
      { kind: "message", text: "Reading the backup job's logs first." },
      {
        kind: "command",
        command: "journalctl -u backup-ops-db --since -3d",
        forMs: KEEPS_WORKING_MS,
      },
    ],
    settlesAs: "running",
  },
  {
    title: "Migrate ops dashboards",
    request: "Move the ops dashboards from Grafana v10 to the new folder layout.",
    runner: "studio-mac",
    project: "ops",
    script: [
      {
        kind: "message",
        text: "The dashboards are in the new layout. One thing before I clean up.",
      },
      {
        kind: "question",
        questions: [
          {
            question: "Keep the old Grafana folder?",
            header: "Grafana",
            options: [
              { label: "Keep", description: "Leave the v10 dashboards where they are." },
              { label: "Delete", description: "Remove the v10 dashboards." },
            ],
            multiSelect: false,
          },
        ],
      },
      { kind: "message", text: "Done. The migration is finished." },
      { kind: "end", state: "completed" },
    ],
    settlesAs: "waiting",
  },
  {
    title: "Webhook retry backoff",
    request:
      "Stripe webhook retries have been rising since 07:40. Retry failed webhook deliveries " +
      "with exponential backoff instead of at once.",
    runner: "build-box-1",
    project: "payments-api",
    script: [
      {
        kind: "message",
        text: "The retries come from `retryDelivery`, which tries again at once. Writing the fix.",
      },
      { kind: "file_change", path: "src/webhooks/retry.ts", forMs: KEEPS_WORKING_MS },
    ],
    settlesAs: "running",
  },
  {
    title: "Ship release v2.15",
    request: "Ship payments-api 2.15.0: run the checks, tag it and publish it to npm.",
    runner: "build-box-2",
    project: "payments-api",
    script: [
      { kind: "command", command: "pnpm test" },
      { kind: "command", command: "git tag v2.15.0" },
      { kind: "message", text: "The checks pass and v2.15.0 is tagged. Publishing to npm next." },
      { kind: "command", command: "npm publish", ask: true },
      { kind: "message", text: "Published payments-api 2.15.0 to npm." },
      { kind: "end", state: "completed" },
    ],
    settlesAs: "waiting",
  },
  {
    title: "Draft reply to Jonas at Kiteworks",
    request:
      "Jonas at Kiteworks asks about our API rate limits. Draft a reply that explains them and " +
      "how to ask for a higher limit.",
    runner: "build-box-2",
    project: "payments-api",
    script: [
      { kind: "message", text: "Reading the current rate limits before I draft the reply." },
      {
        kind: "command",
        command: "grep -rn rateLimit src/config",
        forMs: KEEPS_WORKING_MS,
      },
    ],
    settlesAs: "running",
  },
];

/**
 * Ada's morning message, the book's 09:00 heartbeat. "3‑D" holds the book's
 * non-breaking hyphen.
 */
const ADA_MORNING_MESSAGE =
  "Morning Rogier. Triage found one urgent thing: EU card payments that need 3‑D Secure " +
  "have failed since yesterday's deploy. You started a fix at 09:02; it's waiting on your " +
  "OK to push. Also: Marta at Brightline wants her invoice in the company name - I can " +
  "draft that.";

/** The question Ada is still answering when the world is ready. */
const BACKUP_QUESTION = "What's the status of the backup job?";

/**
 * The part of Ada's backup answer she has written when the world is ready,
 * as the book shows it. It is plain text, as the desktop app's specimen
 * draws it (conversation-fixture.ts), because the app draws the text being
 * written without Markdown.
 */
const BACKUP_ANSWER_SO_FAR =
  "Milo started an investigation at 09:35 on build-box-1. So far: the backup job's pg_dump " +
  "has been slower each night since the table events passed 40 GB";

/** How long apart the words of Ada's backup answer stream. */
const BACKUP_WORD_DELAY_MS = 20;

/**
 * The rest of the backup answer, written once the user sends Ada a message.
 * It starts with a space and a word, so the last word written before the
 * pause is "GB" alone: the runner streams the text in pieces split before
 * each word, and punctuation would join "GB" in one piece.
 */
const BACKUP_ANSWER_REST = " and last night it ran past the end of its window, finishing at 05:12.";

/**
 * The exchanges that put Milo's Conversation in the book's state, each a
 * message and its reply. Ada's are played in their own order, see
 * `seedAdaConversation`.
 */
const MILO_EXCHANGES: ReadonlyArray<readonly [message: string, reply: string]> = [
  ["Anything on your list?", "Nothing on my list right now."],
];

/** Juno's one exchange, which gives her a session to unload. */
const JUNO_EXCHANGE = [
  "Any support tickets waiting?",
  "None right now. The queue is empty.",
] as const;

/** Logs a failure of a background play without stopping the world. */
function reportFailure(what: string, error: unknown): void {
  process.stderr.write(`${what}: ${error instanceof Error ? error.message : String(error)}\n`);
}

/**
 * Retires the controller's own runner once it has come online. It may be
 * signed in to a real provider, and an assistant's session placed there would
 * run a real agent. Fails after 20 s when it never comes online.
 */
async function retireOwnRunner(call: Fleet["call"]): Promise<void> {
  const own = await pollUntil(
    async () => {
      const { items } = await call<{ readonly items: ReadonlyArray<Runner> }>(
        "GET",
        "/runners?limit=10",
      );
      return items.find((runner) => runner.connectivity === "online");
    },
    {
      timeoutMs: 20_000,
      intervalMs: 100,
      timeoutMessage: "the controller's own runner never came online",
    },
  );
  await call("POST", `/runners/${own.id}/retire`, {});
}

/**
 * Returns the busy sessions of the Conversation `conversationId`: those whose
 * turn a sent message has opened and nothing has answered yet.
 */
async function readBusySessions(
  call: Fleet["call"],
  conversationId: string,
): Promise<ReadonlyArray<Session>> {
  const { items } = await call<{ readonly items: ReadonlyArray<Session> }>(
    "GET",
    `/sessions?conversationId=${conversationId}&status=busy&limit=10`,
  );
  return items;
}

/**
 * Plays `reply` as the answer to the turn a message opened on `session`, on
 * the runner that holds it, then waits until the controller shows the session
 * no longer busy. Fails when the session is on none of `runners`, or when it
 * is still busy 10 s after the reply.
 */
async function answerTurn(
  call: Fleet["call"],
  runners: ReadonlyMap<string, ScriptedRunner>,
  session: Session,
  reply: string,
): Promise<void> {
  await findSessionRunner(runners, session).playScript(session.id, [
    { kind: "message", text: reply },
    { kind: "end", state: "completed" },
  ]);
  await waitUntilNotBusy(call, session.id);
}

/**
 * Finds the runner that holds `session` among `runners`. Assistant sessions
 * are not pinned to a runner, so it is looked up by the session's
 * `runnerId`. Fails when the session is on none of them.
 */
function findSessionRunner(
  runners: ReadonlyMap<string, ScriptedRunner>,
  session: Session,
): ScriptedRunner {
  const runner = session.runnerId === null ? undefined : runners.get(session.runnerId);
  if (runner === undefined) {
    throw new Error(
      `session ${session.id} is on runner ${String(session.runnerId)}, not a scripted one`,
    );
  }
  return runner;
}

/** Waits until the controller shows the session `sessionId` not busy. Fails after 10 s. */
async function waitUntilNotBusy(call: Fleet["call"], sessionId: string): Promise<void> {
  await pollUntil(
    async () => {
      const read = await call<Session>("GET", `/sessions/${sessionId}`);
      return read.status === "busy" ? undefined : true;
    },
    {
      timeoutMs: 10_000,
      intervalMs: 50,
      timeoutMessage: `session ${sessionId} stayed busy after its reply`,
    },
  );
}

/**
 * Waits until the Conversation `conversationId` has a busy session, and
 * returns it. Fails when none turns busy within 10 s.
 */
async function waitForBusySession(call: Fleet["call"], conversationId: string): Promise<Session> {
  const [session] = await pollUntil(
    async () => {
      const busy = await readBusySessions(call, conversationId);
      return busy.length === 0 ? undefined : busy;
    },
    {
      timeoutMs: 10_000,
      intervalMs: 50,
      timeoutMessage: `no session of conversation ${conversationId} became busy`,
    },
  );
  return session!;
}

/**
 * Sends `message` to the Conversation `conversationId` and returns the busy
 * session that takes it. Fails when no session turns busy within 10 s.
 */
async function sendMessage(
  call: Fleet["call"],
  conversationId: string,
  message: string,
): Promise<Session> {
  await call("POST", `/conversations/${conversationId}/messages`, { text: message });
  return waitForBusySession(call, conversationId);
}

/**
 * Sends `message` to the Conversation `conversationId` and answers it with
 * `reply`. Fails when no session turns busy within 10 s.
 */
async function exchangeMessage(
  call: Fleet["call"],
  runners: ReadonlyMap<string, ScriptedRunner>,
  conversationId: string,
  message: string,
  reply: string,
): Promise<void> {
  await answerTurn(call, runners, await sendMessage(call, conversationId, message), reply);
}

/**
 * Puts the assistant whose Conversation is `conversationId` to sleep: it
 * answers `message` with `reply`, then the runner unloads its idle session,
 * as a real runner does after a while without input. The session is then
 * exited and resumable, which is what the apps show as asleep: the next
 * message resumes it. An assistant with no session at all would show idle
 * instead. Fails when the session is not exited within 10 s.
 */
async function sendAssistantToSleep(
  call: Fleet["call"],
  runners: ReadonlyMap<string, ScriptedRunner>,
  conversationId: string,
  [message, reply]: readonly [message: string, reply: string],
): Promise<void> {
  const session = await sendMessage(call, conversationId, message);
  await answerTurn(call, runners, session, reply);
  findSessionRunner(runners, session).endSession(session.id, "idle_unload");
  await pollUntil(
    async () => {
      const read = await call<Session>("GET", `/sessions/${session.id}`);
      return read.status === "exited" ? true : undefined;
    },
    {
      timeoutMs: 10_000,
      intervalMs: 50,
      timeoutMessage: `session ${session.id} did not exit after it was unloaded`,
    },
  );
}

/** Returns the highest message position in the Conversation `conversationId`, 0 when it has none. */
async function readLastPosition(call: Fleet["call"], conversationId: string): Promise<number> {
  const { items } = await call<{ readonly items: ReadonlyArray<ConversationMessage> }>(
    "GET",
    `/conversations/${conversationId}/messages?sort=position:desc&limit=1`,
  );
  return items[0]?.position ?? 0;
}

/**
 * Waits until the user sends a message to the Conversation `conversationId`
 * after position `after`. Returns true when one came, and false when
 * `stopped` returned true first.
 */
async function waitForOwnerMessage(
  stopped: () => boolean,
  call: Fleet["call"],
  conversationId: string,
  after: number,
): Promise<boolean> {
  while (!stopped()) {
    try {
      const { items } = await call<{ readonly items: ReadonlyArray<ConversationMessage> }>(
        "GET",
        `/conversations/${conversationId}/messages?sort=position:desc&limit=10`,
      );
      if (items.some((message) => message.position > after && message.senderRole === "owner")) {
        return true;
      }
    } catch (error) {
      if (!stopped()) reportFailure("Reading Ada's messages failed", error);
    }
    await sleep(ANSWER_POLL_MS);
  }
  return false;
}

/**
 * Puts Ada's Conversation in the book's state and leaves her working:
 *
 * 1. the evening exchange the desktop app's specimens give her;
 * 2. her morning message, written by the same turn as a second reply, so no
 *    message from the user comes before it;
 * 3. the reminder exchange;
 * 4. the backup question, whose answer she is still writing.
 *
 * Returns that last turn's session and its play, which reports its own
 * failure and so never fails. The turn stops after `BACKUP_ANSWER_SO_FAR`
 * until `answerFirst` resolves, then finishes the answer, answers the
 * message that resolved it with `ADA_REPLY`, and completes.
 */
async function seedAdaConversation(
  { call, readTranscript }: Fleet,
  runners: ReadonlyMap<string, ScriptedRunner>,
  conversationId: string,
  answerFirst: Promise<void>,
): Promise<{ readonly sessionId: string; readonly played: Promise<void> }> {
  const evening = await sendMessage(call, conversationId, "Anything urgent before I log off?");
  await findSessionRunner(runners, evening).playScript(evening.id, [
    {
      kind: "message",
      text: "Nothing urgent. The staging deploy is green and no Task is waiting on you.",
    },
    { kind: "message", text: ADA_MORNING_MESSAGE },
    { kind: "end", state: "completed" },
  ]);
  await waitUntilNotBusy(call, evening.id);
  await exchangeMessage(
    call,
    runners,
    conversationId,
    "Remind me Friday to renew the SSL cert for ops.",
    "Done. Reminder set for Friday 2 October, 09:00: renew the SSL cert for ops.",
  );
  const backup = await sendMessage(call, conversationId, BACKUP_QUESTION);
  const wordsSoFar = BACKUP_ANSWER_SO_FAR.split(/\s+/).length;
  const played = findSessionRunner(runners, backup)
    .playScript(backup.id, [
      {
        kind: "message",
        text: BACKUP_ANSWER_SO_FAR + BACKUP_ANSWER_REST,
        deltaMs: BACKUP_WORD_DELAY_MS,
        pauses: [{ afterWords: wordsSoFar, until: answerFirst }],
      },
      { kind: "message", text: ADA_REPLY },
      { kind: "end", state: "completed" },
    ])
    .catch((error: unknown) => reportFailure("Ada's backup answer stopped", error));
  // The world is ready once the answer so far is written, and the pause holds
  // it there. The controller stores the words of an unfinished message only
  // once it completes, so the transcript shows only that it started, and the
  // words are given the time they take to stream.
  await pollUntil(
    async () => {
      const rows = await readTranscript(backup.id);
      return rows.some(({ event }) => event._tag === "item.started") ? true : undefined;
    },
    { timeoutMs: 10_000, intervalMs: 50, timeoutMessage: "Ada never started her backup answer" },
  );
  await sleep(wordsSoFar * BACKUP_WORD_DELAY_MS + 500);
  return { sessionId: backup.id, played };
}

/**
 * Answers every message sent to the Conversation `conversationId` with
 * `ADA_REPLY`, until `stopped` returns true. A failed answer is logged and the
 * loop goes on.
 */
async function answerMessagesUntil(
  stopped: () => boolean,
  call: Fleet["call"],
  runners: ReadonlyMap<string, ScriptedRunner>,
  conversationId: string,
): Promise<void> {
  while (!stopped()) {
    try {
      for (const session of await readBusySessions(call, conversationId)) {
        await answerTurn(call, runners, session, ADA_REPLY);
      }
    } catch (error) {
      if (!stopped()) reportFailure("Answering Ada's message failed", error);
    }
    await sleep(ANSWER_POLL_MS);
  }
}

const { values: options } = parseArgs({
  options: {
    port: { type: "string" },
    host: { type: "string" },
    "defer-question": { type: "boolean" },
  },
});
const port = options.port === undefined ? undefined : Number(options.port);
if (port !== undefined && !Number.isInteger(port)) {
  throw new Error(`--port takes a whole number, such as 4950, not "${String(options.port)}"`);
}

// The handlers go in before the Home is created, and stay until it is
// deleted. A Ctrl-C while the controller starts or stops would otherwise kill
// the script outright and leave the Home behind; with them in, the script
// finishes starting, then stops the controller and deletes the Home as
// usual, and any later Ctrl-C does nothing.
let onInterrupt = (): void => {};
const interrupted = new Promise<void>((resolve) => {
  onInterrupt = resolve;
});
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onInterrupt);
const home = mkdtempSync(join(tmpdir(), "hercule-book-world-"));
try {
  const binary = findCompiledBinary();
  const controller = await startController({ home, binary, port, host: options.host });
  let fleet: Fleet | undefined;
  try {
    const setup = await completeSetup({ home, url: controller.url, binary });
    if (setup.code !== 0) {
      throw new Error(`setup failed with exit code ${String(setup.code)}:\n${setup.stderr}`);
    }
    const connected = await connectFleet(controller.url);
    fleet = connected;
    const { call } = connected;
    await retireOwnRunner(call);

    const runnersByName = new Map<RunnerName, ScriptedRunner>();
    const runnersById = new Map<string, ScriptedRunner>();
    const enlist = async ({ name, maxConcurrentSessions }: (typeof RUNNERS)[number]) => {
      const runner = await connected.enlistRunner(name, { maxConcurrentSessions });
      runnersByName.set(name, runner);
      runnersById.set(runner.runnerId, runner);
    };
    const [firstRunner, ...otherRunners] = RUNNERS;
    await enlist(firstRunner);

    const projectIds = new Map<ProjectName, string>();
    for (const name of PROJECT_NAMES) {
      projectIds.set(name, (await connected.createProject(name)).id);
    }

    // Setup creates an assistant of its own, which the book does not have.
    const { items: setUpAssistants } = await call<{ readonly items: ReadonlyArray<Assistant> }>(
      "GET",
      "/assistants?limit=10",
    );
    for (const assistant of setUpAssistants) await call("DELETE", `/assistants/${assistant.id}`);

    let stopped = false;
    const ada = await call<Assistant>("POST", "/assistants", {
      name: "Ada",
      heartbeat: HEARTBEAT_OFF,
      reply: "segments",
    });
    const adaConversationId = ada.mainConversationId;
    // Ada's backup turn stays open until the user sends her a message. The
    // message is looked for only after the turn's own question was sent.
    let onAdaMessaged: (messaged: boolean) => void = () => {};
    const adaMessaged = new Promise<boolean>((resolve) => {
      onAdaMessaged = resolve;
    });
    const adaBackupTurn = await seedAdaConversation(
      connected,
      runnersById,
      adaConversationId,
      // On shutdown the pause never ends: stopping the runner stops the turn.
      adaMessaged.then((messaged) => (messaged ? undefined : new Promise<void>(() => {}))),
    );
    const lastPosition = await readLastPosition(call, adaConversationId);
    void waitForOwnerMessage(() => stopped, call, adaConversationId, lastPosition).then(
      onAdaMessaged,
    );

    const milo = await call<Assistant>("POST", "/assistants", {
      name: "Milo",
      heartbeat: HEARTBEAT_OFF,
    });
    for (const [message, reply] of MILO_EXCHANGES) {
      await exchangeMessage(call, runnersById, milo.mainConversationId, message, reply);
    }
    const juno = await call<Assistant>("POST", "/assistants", {
      name: "Juno",
      heartbeat: HEARTBEAT_OFF,
    });
    await sendAssistantToSleep(call, runnersById, juno.mainConversationId, JUNO_EXCHANGE);

    for (const runner of otherRunners) await enlist(runner);

    for (const thread of BOOK_THREADS) {
      const runner = runnersByName.get(thread.runner)!;
      // A deferred question splits the script: the steps before the question
      // play now and leave the turn running, the rest play on SIGUSR1.
      const deferred =
        options["defer-question"] === true && thread.title === DEFERRED_QUESTION_TITLE;
      const questionAt = thread.script.findIndex((step) => step.kind === "question");
      const { thread: session, played } = await connected.spawnScriptedThread(
        {
          runner,
          projectId: projectIds.get(thread.project)!,
          prompt: `${thread.title}\n\n${thread.request}`,
        },
        deferred ? thread.script.slice(0, questionAt) : thread.script,
      );
      played.catch((error: unknown) => reportFailure(`"${thread.title}" stopped`, error));
      await connected.waitForTurn(session.id, 1, deferred ? "running" : thread.settlesAs);
      if (deferred) {
        process.once("SIGUSR1", () => {
          void played
            .then(() => runner.playScript(session.id, thread.script.slice(questionAt)))
            .catch((error: unknown) => reportFailure(`"${thread.title}" stopped`, error));
        });
      }
    }

    // Once the backup turn has answered the user's first message, every later
    // message gets a turn of its own, answered by the loop.
    const answering = (async () => {
      if (!(await adaMessaged)) return;
      await adaBackupTurn.played;
      try {
        await waitUntilNotBusy(call, adaBackupTurn.sessionId);
      } catch (error) {
        if (!stopped) reportFailure("Answering Ada's first message failed", error);
      }
      await answerMessagesUntil(() => stopped, call, runnersById, adaConversationId);
    })();
    process.stdout.write(
      [
        "",
        "The book's world is ready.",
        "",
        `Controller:    ${controller.url} (pid ${String(controller.pid)})`,
        ...(options.host === undefined
          ? [`From emulator: http://10.0.2.2:${String(controller.port)}`]
          : []),
        `Sign in as:    ${USERNAME} / ${PASSWORD}`,
        `Hercule Home:  ${home}`,
        `This script:   pid ${String(process.pid)}`,
        ...(options["defer-question"] === true
          ? [`Ask "${DEFERRED_QUESTION_TITLE}": kill -USR1 ${String(process.pid)}`]
          : []),
        "",
        "Messages to Ada get a canned reply. Press Ctrl-C to stop the controller and delete the Home.",
        "",
      ].join("\n"),
    );
    await interrupted;
    stopped = true;
    await answering;
  } finally {
    // The runners go first, which stops every script still playing, so
    // nothing holds the process open once the controller has stopped.
    await fleet?.disconnectRunners();
    await controller.stop();
  }
} finally {
  rmSync(home, { recursive: true, force: true });
  deleteMasterKeyItem(home);
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onInterrupt);
}
