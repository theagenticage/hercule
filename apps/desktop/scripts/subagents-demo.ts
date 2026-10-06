/**
 * Starts a throwaway controller with one thread whose agent works through
 * subagents, so the subagent screens of the web app and the desktop app can be
 * looked at, screenshotted and recorded without a harness, a model or a login:
 * `pnpm --filter @hercule/desktop demo:subagents`, after `pnpm build:binary`.
 *
 * It starts the compiled binary in a new Hercule Home under the system's temp
 * folder, completes setup, retires the controller's own runner, enlists one
 * scripted runner and spawns the thread on it. Then it prints the address to
 * open and the account to sign in with, and waits. Ctrl-C stops the
 * controller and deletes the Home.
 *
 * `SUBAGENTS_SCENARIO` below is the thread's first turn, with its timeline.
 * Allow the command and answer the question in the app: the scripted runner
 * plays only a tool call the user allows, so a Deny leaves the asking
 * subagent's turn open and is printed as a failure here.
 *
 * It runs on plain Node, like the perf script, so its imports name the `.ts`
 * file.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "../../../packages/contract/src/index";
import {
  PASSWORD,
  USERNAME,
  deleteMasterKeyItem,
  startSetUpController,
} from "../../../scripts/controller-process.ts";
import { connectFleet } from "./fleet.ts";
import { pollUntil } from "./poll.ts";
import type { ScriptStep } from "./scripted-runner.ts";

const MINUTE_MS = 60_000;

/** How long a subagent that "keeps working" runs its last command: longer than any recording. */
const KEEPS_WORKING_MS = 60 * MINUTE_MS;

/** The user's first message, which also titles the thread. */
const PROMPT = "Get the release ready: flaky tests, dependency bumps and the database migration.";

/**
 * The thread's first turn. Times are from the spawn, roughly:
 *
 * - 0 s: the session's own agent starts three subagents in the background.
 *   - "Find the flaky tests" (Explore) runs the suite and is done at ~60 s.
 *   - "Bump the dependencies" fails at ~80 s.
 *   - "Plan the database migration" (Plan) starts two subagents of its own:
 *     - "Read the schema history" keeps working for an hour and reports no
 *       Token Usage, so its tokens are left out;
 *     - "Dry-run the deploy script" asks within a second to allow a command, and is
 *       done 20 s after the user allows it.
 *   - At ~4 s, "Plan the database migration" asks three questions. Once they
 *     are answered, it keeps working for an hour.
 * - ~2 min: the session's own agent watches CI and then ends its turn, so the thread
 *   is idle while the subagents' Requests stay open.
 *
 * Stop any running subagent from the app to see it stopped: stopping "Plan
 * the database migration" also stops the two below it and cancels their
 * open Requests.
 */
const SUBAGENTS_SCENARIO: ReadonlyArray<ScriptStep> = [
  {
    kind: "message",
    text: "I'll split the release prep into three parts and hand each to a subagent.",
  },
  {
    kind: "subagent",
    subagentId: "flaky-tests",
    description: "Find the flaky tests",
    agentType: "Explore",
    model: "claude-haiku-4-5",
    brief: "Run the test suite three times and list every test that does not pass every time.",
    background: true,
    steps: [
      { kind: "message", text: "Running the suite three times to see which tests flip." },
      { kind: "command", command: "pnpm test --repeat 3", forMs: MINUTE_MS },
      { kind: "usage", usage: { inputTokens: 38_200, outputTokens: 3_512 } },
      {
        kind: "message",
        text: "Two tests flip: checkout.test.ts and session-timeout.test.ts. Both wait on the real clock.",
      },
    ],
  },
  {
    kind: "subagent",
    subagentId: "bump-dependencies",
    description: "Bump the dependencies",
    agentType: "general-purpose",
    model: "claude-sonnet-4-5",
    brief: "Update every dependency to its latest version and check that the build still passes.",
    background: true,
    steps: [
      { kind: "message", text: "Updating every dependency to its latest version." },
      { kind: "command", command: "pnpm update --latest", forMs: 30_000 },
      { kind: "file_change", path: "package.json", forMs: 5_000 },
      { kind: "command", command: "pnpm typecheck", forMs: 45_000 },
      { kind: "usage", usage: { inputTokens: 5_410, outputTokens: 812 } },
      {
        kind: "message",
        text: "The upgrade breaks the build: 14 files still use an API the new version removed.",
      },
      { kind: "end", state: "failed" },
    ],
  },
  {
    kind: "subagent",
    subagentId: "plan-migration",
    description: "Plan the database migration",
    agentType: "Plan",
    model: "claude-opus-4-5",
    brief: "Plan the migration that adds the archived_at column, and how to roll it out safely.",
    background: true,
    steps: [
      {
        kind: "message",
        text: "I'll read the schema history and dry-run the deploy script in parallel.",
      },
      {
        kind: "subagent",
        subagentId: "schema-history",
        description: "Read the schema history",
        agentType: "Explore",
        brief: "Read every change to db/schema.sql since the last release and summarize them.",
        background: true,
        steps: [
          { kind: "message", text: "Reading every change to the schema since the last release." },
          {
            kind: "command",
            command: "git log --follow -p db/schema.sql",
            forMs: KEEPS_WORKING_MS,
          },
        ],
      },
      {
        kind: "subagent",
        subagentId: "dry-run-deploy",
        description: "Dry-run the deploy script",
        agentType: "general-purpose",
        model: "claude-haiku-4-5",
        brief:
          "Dry-run the deploy script against production and report how long the migration takes.",
        background: true,
        steps: [
          {
            kind: "message",
            text: "The dry run reads the production config, so it needs your go-ahead.",
          },
          {
            kind: "command",
            command: "./scripts/deploy.sh --dry-run --env production",
            ask: true,
            forMs: 20_000,
          },
          { kind: "usage", usage: { inputTokens: 6_020, outputTokens: 214 } },
          {
            kind: "message",
            text: "The dry run passes. The migration takes about 40 s on a copy of production.",
          },
        ],
      },
      { kind: "command", command: "cat db/migrations/README.md", forMs: 3_000 },
      { kind: "usage", usage: { inputTokens: 21_700, outputTokens: 1_480 } },
      {
        kind: "question",
        questions: [
          {
            question: "Can the migration take the service down for a minute?",
            header: "Downtime",
            options: [
              { label: "Yes, at night", description: "Simplest: one migration, run at 03:00." },
              { label: "No", description: "The column is added in two steps, with no downtime." },
            ],
            multiSelect: false,
          },
          {
            question: "How should archived_at be filled for the rows that exist today?",
            header: "Backfill",
            options: [
              { label: "In the migration", description: "One transaction; slow on big tables." },
              { label: "In a background job", description: "Fast migration; rows fill later." },
              { label: "Leave it empty", description: "Old rows count as not archived." },
            ],
            multiSelect: false,
          },
          {
            question: "Which checks should run against the migrated copy?",
            header: "Checks",
            options: [
              { label: "Typecheck", description: "Catches a renamed column in seconds." },
              { label: "Integration tests", description: "Runs the API against the copy." },
              { label: "Load test", description: "Shows whether the new index holds up." },
            ],
            multiSelect: true,
          },
        ],
      },
      { kind: "message", text: "Thanks. Writing the plan with those choices." },
      { kind: "usage", usage: { inputTokens: 34_900, outputTokens: 6_800 } },
      { kind: "command", command: "pnpm db:migrate --dry-run", forMs: KEEPS_WORKING_MS },
    ],
  },
  {
    kind: "message",
    text: "Three subagents are working on it. I'll watch CI while they do.",
  },
  { kind: "command", command: "gh pr checks --watch", forMs: 2 * MINUTE_MS },
  {
    kind: "message",
    text: "CI is green. I'll pick up the results when the subagents report back.",
  },
  { kind: "end", state: "completed" },
];

/**
 * Retires the controller's own runner once it has come online, so the only
 * runner on screen is the scripted one. Fails after 20 s when it never
 * registers.
 */
async function retireOwnRunner(
  call: <T>(method: string, path: string, body?: unknown) => Promise<T>,
): Promise<void> {
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

/** Resolves on the first Ctrl-C or SIGTERM. */
function waitForInterrupt(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

// The handlers go in before the Home is created. A Ctrl-C while the
// controller starts would otherwise kill the script outright and leave the
// Home behind; with them in, the script finishes starting, then stops the
// controller and deletes the Home as usual.
const interrupted = waitForInterrupt();
const home = mkdtempSync(join(tmpdir(), "hercule-subagents-demo-"));
try {
  const controller = await startSetUpController({ home });
  try {
    const fleet = await connectFleet(controller.url);
    await retireOwnRunner(fleet.call);
    const runner = await fleet.enlistRunner("scripted");
    const { thread, played } = await fleet.spawnScriptedThread(
      { runner, prompt: PROMPT },
      SUBAGENTS_SCENARIO,
    );
    played.catch((error: unknown) => {
      process.stderr.write(
        `The scenario stopped: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
    process.stdout.write(
      [
        "",
        `Controller:  ${controller.url} (pid ${String(controller.pid)})`,
        `Hercule Home: ${home}`,
        `Sign in as:  ${USERNAME} / ${PASSWORD}`,
        `Thread:      ${controller.url}/threads/${thread.id}`,
        `API token:   ${fleet.token}`,
        "",
        "Press Ctrl-C to stop the controller and delete the Home.",
        "",
      ].join("\n"),
    );
    await interrupted;
    await fleet.disconnectRunners();
  } finally {
    await controller.stop();
  }
} finally {
  rmSync(home, { recursive: true, force: true });
  deleteMasterKeyItem(home);
}
