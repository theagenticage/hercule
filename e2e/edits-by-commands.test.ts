/**
 * Tests that two real Claude Code sessions, each changing the same file only
 * through shell commands, end up in one overlap Discussion (spec 19 section
 * 4.1). A shell command names no file, so the runner has to find the change
 * itself, by asking git after the command.
 *
 * The repository is a bare one in a temporary directory, and the resource
 * refers to it by an `https://` URL that git's `insteadOf` rewrites to the bare
 * repository, as `workspace.test.ts` does. Each session gets its own ephemeral
 * workspace of that repository, so neither shares a checkout with the other.
 *
 * Opt-in, like `agent-session.test.ts`: it spends the developer's tokens. Set
 * `HERCULE_LIVE_SESSION_TEST=1` to run it. With no login available the case is
 * skipped with a message.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  completeSetup,
  PASSWORD,
  ROOT,
  runCli,
  startController,
  USERNAME,
  type Controller,
} from "../scripts/controller-process";
import {
  buildGitEnv,
  createTemporaryHome,
  isLiveSessionTestEnabled,
  isLoginAvailable,
  LOGIN_DEADLINE_MS,
  parseJsonOutputOrFail,
  prepareLoggedInAccount,
  readApiKey,
  waitForTranscriptTag,
  type Page,
  type Session,
  type TemporaryHome,
} from "./harness";

/** Opt-in: `pnpm test:binary` on any machine must not silently spend a subscription. */
const wanted = isLiveSessionTestEnabled();

const binary = join(ROOT, "hercule");
const REMOTE = "https://hercule.test/acme/overlap";
const SHARED_FILE = "shared.txt";

/** Long enough for a cold harness to start, run a command and finish its turn. */
const TURN_DEADLINE_MS = 180_000;
/** How long the controller may take to open the Discussion after both turns end. */
const DISCUSSION_DEADLINE_MS = 60_000;

let state: TemporaryHome;
/** Holds the bare remote. */
let world: TemporaryHome;
/** The `HOME` the machine's git and the test's own git read, and nothing else. */
let gitHome: TemporaryHome;
let controller: Controller;
let resourceId: string;
let runnerId: string | undefined;

interface Resource {
  readonly id: string;
}

interface DiscussionSummary {
  readonly id: string;
}

interface SharedFile {
  readonly path: string;
  readonly sessionIds: ReadonlyArray<string>;
}

interface Discussion {
  readonly sharedFiles: ReadonlyArray<SharedFile>;
}

/** Runs git on the test's own files. Throws with git's output when it fails. */
const runGit = (args: ReadonlyArray<string>, cwd: string): void => {
  const ran = Bun.spawnSync(["git", ...args], { cwd, env: buildGitEnv(gitHome.home) });
  if (ran.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} in ${cwd}:\n${ran.stderr.toString()}`);
  }
};

/** Runs the CLI as the logged-in user of the throwaway home. */
const runLoggedInCli = (args: ReadonlyArray<string>, stdin?: string) =>
  runCli(args, { home: state.home, binary, stdin });

/**
 * Spawns a session in its own ephemeral workspace of the repository, in
 * `full-access` so the agent is not parked on an approval nobody is there to
 * give.
 */
const spawnSession = async (prompt: string): Promise<Session> =>
  parseJsonOutputOrFail<Session>(
    await runLoggedInCli(
      [
        "session",
        "spawn",
        "--runner",
        runnerId!,
        "--access-mode",
        "full-access",
        "--workspace",
        JSON.stringify({ kind: "ephemeral", checkouts: [{ resourceId, baseBranch: "main" }] }),
        "--json",
      ],
      prompt,
    ),
  );

/** Returns the overlap Discussions of the repository. */
const listOverlaps = async (): Promise<ReadonlyArray<DiscussionSummary>> =>
  parseJsonOutputOrFail<Page<DiscussionSummary>>(
    await runLoggedInCli([
      "discussion",
      "list",
      "--resource",
      resourceId,
      "--kind",
      "overlap",
      "--json",
    ]),
  ).items;

/** Reads a Discussion with its shared files. */
const readDiscussion = async (id: string): Promise<Discussion> =>
  parseJsonOutputOrFail<{ discussion: Discussion }>(
    await runLoggedInCli(["discussion", "read", id, "--json"]),
  ).discussion;

beforeAll(async () => {
  if (!wanted) return;
  if (!isLoginAvailable()) return;
  state = createTemporaryHome();
  world = createTemporaryHome();
  gitHome = createTemporaryHome("[init]\n\tdefaultBranch = main\n");
  const bare = join(world.home, "remote.git");

  // A bare repository with one commit on `main`, holding the file both
  // sessions will change.
  runGit(["init", "--bare", "--initial-branch=main", bare], world.home);
  const seed = join(world.home, "seed");
  mkdirSync(seed);
  runGit(["init", "--initial-branch=main"], seed);
  writeFileSync(join(seed, SHARED_FILE), "version: one\n");
  runGit(["add", SHARED_FILE], seed);
  runGit(["commit", "-m", "one commit"], seed);
  runGit(["push", bare, "main"], seed);
  appendFileSync(
    join(gitHome.home, ".gitconfig"),
    `[url "file://${bare}"]\n\tinsteadOf = ${REMOTE}\n`,
  );

  controller = await startController({
    home: state.home,
    binary,
    env: { HOME: gitHome.home, GIT_CONFIG_NOSYSTEM: "1" },
  });
  const completed = await completeSetup({ home: state.home, url: controller.url, binary });
  expect(completed.code, `${completed.stdout}\n${completed.stderr}`).toBe(0);
  const login = await runCli(
    [
      "login",
      controller.url,
      "--username",
      USERNAME,
      "--password-stdin",
      "--name",
      "e2e-edits-by-commands",
    ],
    { home: state.home, binary, stdin: PASSWORD },
  );
  expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);

  ({ runnerId } = await prepareLoggedInAccount({
    home: state.home,
    binary,
    url: controller.url,
    apiKey: readApiKey(state.home),
  }));
  resourceId = parseJsonOutputOrFail<Resource>(
    await runLoggedInCli(["resource", "create", "--kind", "repo", "--remote", REMOTE, "--json"]),
  ).id;
}, LOGIN_DEADLINE_MS * 2);

afterAll(async () => {
  await controller?.stop().catch(() => -1);
  state?.remove();
  world?.remove();
  gitHome?.remove();
});

describe.skipIf(!wanted)("two sessions that change one file only through shell commands", () => {
  it(
    "end up in one overlap Discussion",
    async (ctx) => {
      if (runnerId === undefined) {
        ctx.skip(
          "no login for the claude-code account: name a credentials file in " +
            "HERCULE_E2E_CLAUDE_CREDENTIALS, or put ANTHROPIC_API_KEY on the environment.",
        );
        return;
      }

      // `sed -i` through Bash is the point: no edit tool is used, so the only
      // way to learn of the change is to ask git after the command.
      const prompt = (word: string): string =>
        `Use the Bash tool to run exactly this command, and nothing else, then stop: ` +
        `sed -i.bak 's/one/${word}/' ${SHARED_FILE}. Do not use any edit or write tool.`;
      const first = await spawnSession(prompt("alpha"));
      const second = await spawnSession(prompt("beta"));

      for (const session of [first, second]) {
        await waitForTranscriptTag({
          home: state.home,
          binary,
          id: session.id,
          tag: "turn.completed",
          timeoutMs: TURN_DEADLINE_MS,
        });
      }

      const deadline = Date.now() + DISCUSSION_DEADLINE_MS;
      let overlaps = await listOverlaps();
      while (overlaps.length === 0 && Date.now() < deadline) {
        await Bun.sleep(1_000);
        overlaps = await listOverlaps();
      }

      expect(overlaps, "no overlap Discussion was opened").toHaveLength(1);
      // `sed -i.bak` also leaves `shared.txt.bak` in each workspace, which may
      // be shared too.
      const { sharedFiles } = await readDiscussion(overlaps[0]!.id);
      const shared = sharedFiles.find((file) => file.path === SHARED_FILE);
      expect(shared, `${SHARED_FILE} is not shared`).toBeDefined();
      expect([...shared!.sessionIds].sort()).toEqual([first.id, second.id].sort());
    },
    LOGIN_DEADLINE_MS + 2 * TURN_DEADLINE_MS + DISCUSSION_DEADLINE_MS + 60_000,
  );
});
