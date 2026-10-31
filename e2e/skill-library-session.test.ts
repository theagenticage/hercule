/**
 * Tests that Claude Code, Codex and pi Threads get the Skill Library on every
 * runner, through the release binary (spec 06 section 9.4).
 *
 * The controller runs in one temporary home, and a second runner joins it from
 * a home of its own, as a machine elsewhere on the fleet would. Each harness
 * gets the same case.
 *
 * Before each harness's case, the library is brought back to two skills,
 * `implement` and `teach`, so each case stands alone: a harness before it
 * may have deleted `teach` and imported `review`. The body of each skill's
 * `SKILL.md` tells the model to reply with a word nothing else in the run
 * contains. The word is in the body only, never in the skill's description,
 * so a reply that holds it shows the harness gave the model the whole skill,
 * not just the list of skills.
 *
 * The case places every Thread on the second runner with `--runner`, so the
 * skills reach it only by the runner fetching each revision from the
 * controller:
 *
 * - the first Thread runs `implement` and replies with its word;
 * - `teach` is then deleted, and the next Thread's session skills folder on
 *   the runner holds `implement` alone, while the first Thread's folder still
 *   holds both. Running `teach` there does not produce the word of `teach`;
 * - `review` is then imported, and the first Thread is stopped and resumed
 *   with `teach`. The resumed process gets a new folder, holding `implement`
 *   and `review`, and `teach` does not produce its word. A last turn runs
 *   `review`, which completes and replies with its word. No turn before it
 *   could have produced that word, so the reply shows the harness loads the
 *   skills from the new folder when it resumes: for Claude a plugin folder
 *   that moved, for Codex a new app-server that is given the session skills
 *   folder again, for pi a new process with a new `--skill` path.
 *
 * Each harness names a skill its own way: `/implement` in Claude Code,
 * `$implement` in Codex, and `/skill:implement` in pi.
 *
 * The session skills folder is the deterministic check, and a reply that
 * lacks a word is only a second sign, because a model asked to run a skill
 * that does not exist could reply with anything. The runner's unit and
 * integration tests own the check that a Thread on the controller's own
 * runner never loads the user's own skills.
 *
 * Opt-in, like `session.test.ts`: it spends the developer's tokens and takes a
 * few minutes per harness. Set `HERCULE_LIVE_SESSION_TEST=1` to run it. Each
 * harness runs only when its login is given, and is skipped with a message
 * otherwise:
 *
 * - Claude Code: either of the two routes `e2e/harness.ts` documents.
 * - Codex: `HERCULE_E2E_CODEX_AUTH` names a Codex `auth.json`, which is copied
 *   into the account's `CODEX_HOME` on the second runner. Two live copies of an
 *   OAuth login can rotate each other out, so prefer a file written by
 *   `codex login --with-api-key`, which holds no refresh token. `codex` must
 *   be on the `PATH`.
 * - pi: `ZAI_API_KEY` on the environment, which is stored as the pi
 *   account's Z.ai key. `pi` must be on the `PATH`.
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ROOT,
  buildCleanEnv,
  findCompiledBinary,
  runCli,
  startController,
  type Controller,
} from "../scripts/controller-process";
import {
  LIVE_HARNESSES,
  LOGIN_DEADLINE_MS,
  collectAssistantText,
  completeSetupAndLogin,
  createSkillsFolder,
  createTemporaryHome,
  findSessionSkillsFolder,
  isLiveSessionTestEnabled,
  parseJsonOutputOrFail,
  prepareHarness,
  resetSkillLibrary,
  sendSessionInput,
  spawnThread,
  stopSessions,
  waitForExit,
  waitForTurns,
  type LiveHarness,
  type Page,
  type PreparedHarness,
  type Row,
  type TemporaryHome,
} from "./harness";

/** Opt-in: `pnpm test:binary` on any machine must not silently spend a subscription. */
const wanted = isLiveSessionTestEnabled();

let binary: string;

/** Long enough for a cold harness to start, connect and reply to one prompt. */
const TURN_DEADLINE_MS = 180_000;

/** The word the `implement` skill tells the model to reply with. */
const IMPLEMENT_WORD = "MANGO733";

/** The word the `teach` skill tells the model to reply with. */
const TEACH_WORD = "PAPAYA733";

/** The word the `review` skill tells the model to reply with. */
const REVIEW_WORD = "KIWI734";

/** The controller's home, which the CLI is logged in from. */
let state: TemporaryHome;
/** The second runner's home: the remote machine. */
let machine: TemporaryHome;
/** The folder of `implement` and `teach`, which `hercule skill import` reads. */
let libraryFixture: string;
/** The folder of `review`, imported only before a resume. */
let reviewFixture: string;

let controller: Controller;
/** The second runner's daemon, started here so it can be stopped by its own pid. */
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;

/** The controller and the second runner, once both are up. */
interface Fleet {
  readonly url: string;
  readonly apiKey: string;
  /** The second runner, in its own home. */
  readonly remoteRunnerId: string;
}

let fleet: Fleet | undefined;

/** The sessions started here, so the suite can stop each one before the runner goes. */
const started: Array<string> = [];

/** Runs the CLI from the controller's home, where the login is. */
const runLoggedInCli = (args: ReadonlyArray<string>, stdin?: string) =>
  runCli(args, { home: state.home, binary, stdin });

/**
 * Joins the second runner to the controller and starts its daemon. Returns the
 * runner's id once the controller lists it online.
 */
const startRemoteRunner = async (url: string): Promise<string> => {
  const token = parseJsonOutputOrFail<{ readonly token: string }>(
    await runLoggedInCli(["runner", "join-token", "create", "--json"]),
  ).token;
  const joined = await runCli(["runner", "join", url, "--token", token, "--no-service"], {
    home: machine.home,
    binary,
  });
  expect(joined.code, `${joined.stdout}\n${joined.stderr}`).toBe(0);
  const runnerId = (
    JSON.parse(readFileSync(join(machine.home, "runner", "runner.json"), "utf8")) as {
      readonly runnerId: string;
    }
  ).runnerId;

  daemon = Bun.spawn([binary, "runner"], {
    cwd: ROOT,
    env: { ...buildCleanEnv(), HERCULE_HOME: machine.home },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const deadline = Date.now() + LOGIN_DEADLINE_MS;
  for (;;) {
    const online = parseJsonOutputOrFail<Page<{ readonly id: string }>>(
      await runLoggedInCli(["runner", "list", "--connectivity", "online", "--json"]),
    ).items;
    if (online.some((one) => one.id === runnerId)) return runnerId;
    if (Date.now() > deadline) {
      throw new Error(`the second runner never came online:\n${await stopRemoteRunner()}`);
    }
    await Bun.sleep(500);
  }
};

/**
 * Stops the second runner's daemon, by the process this file started, and
 * returns everything it printed. Returns an empty string when no daemon runs.
 */
const stopRemoteRunner = async (): Promise<string> => {
  if (daemon === undefined) return "";
  const stopping = daemon;
  daemon = undefined;
  stopping.kill("SIGTERM");
  const [stdout, stderr] = await Promise.all([
    new Response(stopping.stdout).text(),
    new Response(stopping.stderr).text(),
    stopping.exited,
  ]);
  return `${stdout}${stderr}`;
};

/**
 * Gives the harness's account its login on the second runner, and waits
 * until that runner's probe reports it logged in.
 */
const prepare = (harness: LiveHarness): Promise<PreparedHarness> => {
  const { url, apiKey, remoteRunnerId } = fleet!;
  return prepareHarness(harness, {
    home: state.home,
    binary,
    url,
    apiKey,
    runnerId: remoteRunnerId,
    runnerHome: machine.home,
  });
};

/** Starts a Thread on the second runner with one input, and returns its id. */
const startThread = async (prepared: PreparedHarness, input: string): Promise<string> => {
  const id = await spawnThread({
    home: state.home,
    binary,
    runnerId: fleet!.remoteRunnerId,
    prepared,
    input,
  });
  started.push(id);
  return id;
};

/** Sends one more input to a session, resuming it when it has exited. */
const sendInput = (id: string, input: string): Promise<void> =>
  sendSessionInput({ home: state.home, binary, id, input });

/** Waits until a session has completed `count` turns, and returns its transcript. */
const waitForTurnCount = (id: string, count: number): Promise<ReadonlyArray<Row>> =>
  waitForTurns({ home: state.home, binary, id, count, timeoutMs: TURN_DEADLINE_MS });

/** Returns the end state of every completed turn in a transcript, in order. */
const listTurnStates = (rows: ReadonlyArray<Row>): ReadonlyArray<unknown> =>
  rows.flatMap((row) => (row.event._tag === "turn.completed" ? [row.event["state"]] : []));

/**
 * Returns the names of the skills in the folder of a session's current start
 * on the remote runner, sorted.
 */
const listSessionSkills = (sessionId: string): ReadonlyArray<string> =>
  readdirSync(join(findSessionSkillsFolder(machine.home, sessionId), "skills")).sort();

beforeAll(async () => {
  if (!wanted) return;
  binary = findCompiledBinary();
  state = createTemporaryHome();
  machine = createTemporaryHome();
  controller = await startController({ home: state.home, binary });
  const url = controller.url;

  const apiKey = await completeSetupAndLogin({
    home: state.home,
    url,
    binary,
    apiKeyName: "e2e-skill-library",
  });
  libraryFixture = createSkillsFolder({ implement: IMPLEMENT_WORD, teach: TEACH_WORD });
  reviewFixture = createSkillsFolder({ review: REVIEW_WORD });

  const remoteRunnerId = await startRemoteRunner(url);
  fleet = { url, apiKey, remoteRunnerId };
}, LOGIN_DEADLINE_MS * 3);

afterAll(async () => {
  if (started.length > 0) await stopSessions({ home: state.home, binary, ids: started });
  await stopRemoteRunner();
  await controller?.stop().catch(() => -1);
  machine?.remove();
  state?.remove();
  for (const folder of [libraryFixture, reviewFixture]) {
    if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  }
}, 60_000);

// Each harness is passed with its label first, because `%s` prints a label
// without the quotes that `$label` would add.
describe.skipIf(!wanted).each(LIVE_HARNESSES.map((harness) => [harness.label, harness] as const))(
  "the Skill Library in a %s Thread",
  (_label, harness) => {
    const skipReason = harness.findSkipReason();
    let prepared: PreparedHarness | undefined;

    beforeAll(async () => {
      if (skipReason !== undefined) return;
      await resetSkillLibrary({ home: state.home, binary, fixture: libraryFixture });
      prepared = await prepare(harness);
    }, LOGIN_DEADLINE_MS + 30_000);

    it(
      "runs implement on a remote runner, and after teach is deleted the next Thread and a resume lack it, while the resume runs review, imported before it",
      async (ctx) => {
        if (prepared === undefined) {
          ctx.skip(skipReason);
          return;
        }

        const first = await startThread(prepared, harness.invokeSkill("implement"));
        const firstRows = await waitForTurnCount(first, 1);
        expect(listSessionSkills(first)).toEqual(["implement", "teach"]);
        expect(collectAssistantText(firstRows), JSON.stringify(firstRows)).toContain(
          IMPLEMENT_WORD,
        );

        const deleted = await runLoggedInCli(["skill", "delete", "teach"]);
        expect(deleted.code, `${deleted.stdout}\n${deleted.stderr}`).toBe(0);

        const second = await startThread(prepared, harness.invokeSkill("teach"));
        const secondRows = await waitForTurnCount(second, 1);
        expect(listSessionSkills(second)).toEqual(["implement"]);
        expect(collectAssistantText(secondRows), JSON.stringify(secondRows)).not.toContain(
          TEACH_WORD,
        );
        // The first Thread is still running, and keeps the set it started with.
        expect(listSessionSkills(first)).toEqual(["implement", "teach"]);

        // A resume is a new start, so it gets the library as it is now.
        const imported = await runLoggedInCli(["skill", "import", reviewFixture]);
        expect(imported.code, `${imported.stdout}\n${imported.stderr}`).toBe(0);
        const stopped = await runLoggedInCli(["session", "stop", first]);
        expect(stopped.code, `${stopped.stdout}\n${stopped.stderr}`).toBe(0);
        await waitForExit({ home: state.home, binary, id: first, timeoutMs: TURN_DEADLINE_MS });
        await sendInput(first, harness.invokeSkill("teach"));
        const resumedRows = await waitForTurnCount(first, 2);
        expect(listSessionSkills(first)).toEqual(["implement", "review"]);
        const resumedText = collectAssistantText(resumedRows.slice(firstRows.length));
        expect(resumedText, JSON.stringify(resumedRows)).not.toContain(TEACH_WORD);

        // A failed turn would also lack the word of `teach`, so the resumed
        // process must also run a skill only the new folder holds, and
        // complete. No earlier turn ran `review`, so its word can come only
        // from the new folder.
        await sendInput(first, harness.invokeSkill("review"));
        const reviewedRows = await waitForTurnCount(first, 3);
        const lastTurns = reviewedRows.slice(resumedRows.length);
        expect(collectAssistantText(lastTurns), JSON.stringify(lastTurns)).toContain(REVIEW_WORD);
        expect(listTurnStates(reviewedRows), JSON.stringify(reviewedRows)).toEqual([
          "completed",
          "completed",
          "completed",
        ]);
      },
      TURN_DEADLINE_MS * 5 + 60_000,
    );
  },
);
