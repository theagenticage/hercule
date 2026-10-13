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
 * - the assistants Ada, Milo and Juno, with their heartbeats off. Ada and
 *   Milo have each answered a message, so they are idle; Juno has no session,
 *   so she is asleep;
 * - the book's threads, on the runner and in the project the book gives each:
 *   three waiting on a Request, four working and three idle.
 *
 * The book's Runs "Ship release v2.15" and "Investigate backup timeouts" are
 * made as ordinary threads with the same titles, because the phone app shows
 * no Runs. The book's paused Trigger, "Label new issues", is left out. Ages
 * are not set back: every thread looks a few seconds old.
 *
 * Then it prints the address to sign in at and the account, and keeps
 * running: each message the user sends Ada gets a canned reply. A thread
 * whose Request is answered with an allow, or whose question is answered,
 * finishes its turn. Ctrl-C or SIGTERM stops the runners and the controller
 * and deletes the Home.
 *
 * It runs on plain Node, like the perf script, so its imports name the `.ts`
 * file.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { Assistant, Heartbeat, Runner, Session } from "../../../packages/contract/src/index";
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
 * - working: Refactor, Investigate, Payout, Rotate;
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
];

/**
 * The messages that put Ada and Milo's Conversations in the book's state,
 * each with its reply. Ada's are the book's own lines.
 */
const ASSISTANT_EXCHANGES: ReadonlyArray<{
  readonly name: string;
  readonly exchanges: ReadonlyArray<readonly [message: string, reply: string]>;
}> = [
  {
    name: "Ada",
    exchanges: [
      [
        "Remind me Friday to renew the SSL cert for ops.",
        "Done. Reminder set for Friday 2 October, 09:00: renew the SSL cert for ops.",
      ],
      [
        "What's the status of the backup job?",
        "Milo started an investigation at 09:35 on build-box-1. So far: the backup job's " +
          "`pg_dump` has been slower each night since the table `events` passed 40 GB.",
      ],
    ],
  },
  {
    name: "Milo",
    exchanges: [["Anything on your list?", "Nothing on my list right now."]],
  },
  { name: "Juno", exchanges: [] },
];

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
 * idle again. Assistant sessions are not pinned to a runner, so the runner is
 * looked up by the session's `runnerId`. Fails when the session is on none of
 * `runners`, or when it is not idle within 10 s of the reply.
 */
async function answerTurn(
  call: Fleet["call"],
  runners: ReadonlyMap<string, ScriptedRunner>,
  session: Session,
  reply: string,
): Promise<void> {
  const runner = session.runnerId === null ? undefined : runners.get(session.runnerId);
  if (runner === undefined) {
    throw new Error(
      `session ${session.id} is on runner ${String(session.runnerId)}, not a scripted one`,
    );
  }
  await runner.playScript(session.id, [
    { kind: "message", text: reply },
    { kind: "end", state: "completed" },
  ]);
  await pollUntil(
    async () => {
      const read = await call<Session>("GET", `/sessions/${session.id}`);
      return read.status === "busy" ? undefined : true;
    },
    {
      timeoutMs: 10_000,
      intervalMs: 50,
      timeoutMessage: `session ${session.id} stayed busy after its reply`,
    },
  );
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
  await call("POST", `/conversations/${conversationId}/messages`, { text: message });
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
  await answerTurn(call, runners, session!, reply);
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

/** Resolves on the first Ctrl-C or SIGTERM. */
function waitForInterrupt(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

const { values: options } = parseArgs({
  options: { port: { type: "string" }, host: { type: "string" } },
});
const port = options.port === undefined ? undefined : Number(options.port);
if (port !== undefined && !Number.isInteger(port)) {
  throw new Error(`--port takes a whole number, such as 4950, not "${String(options.port)}"`);
}

// The handlers go in before the Home is created. A Ctrl-C while the
// controller starts would otherwise kill the script outright and leave the
// Home behind; with them in, the script finishes starting, then stops the
// controller and deletes the Home as usual.
const interrupted = waitForInterrupt();
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

    let adaConversationId = "";
    for (const { name, exchanges } of ASSISTANT_EXCHANGES) {
      const assistant = await call<Assistant>("POST", "/assistants", {
        name,
        heartbeat: HEARTBEAT_OFF,
      });
      if (name === "Ada") adaConversationId = assistant.mainConversationId;
      for (const [message, reply] of exchanges) {
        await exchangeMessage(call, runnersById, assistant.mainConversationId, message, reply);
      }
    }

    for (const runner of otherRunners) await enlist(runner);

    for (const thread of BOOK_THREADS) {
      const { thread: session, played } = await connected.spawnScriptedThread(
        {
          runner: runnersByName.get(thread.runner)!,
          projectId: projectIds.get(thread.project)!,
          prompt: `${thread.title}\n\n${thread.request}`,
        },
        thread.script,
      );
      played.catch((error: unknown) => reportFailure(`"${thread.title}" stopped`, error));
      await connected.waitForTurn(session.id, 1, thread.settlesAs);
    }

    let stopped = false;
    const answering = answerMessagesUntil(() => stopped, call, runnersById, adaConversationId);
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
}
