/**
 * Tests that a Claude Code Thread on a remote runner gets the Skill Library,
 * through the release binary (spec 06 section 9.4).
 *
 * The controller runs in one temporary home, and a second runner joins it from
 * a home of its own, as a machine elsewhere on the fleet would. Every Thread is
 * placed on that second runner with `--runner`, so the skills reach it only by
 * the runner fetching each revision from the controller.
 *
 * Two skills are imported with `hercule skill import`. Each one tells the model
 * to reply with a word nothing else in the run contains:
 *
 * - the first Thread runs `/implement` and replies with its word;
 * - `teach` is then deleted, and the next Thread's skills folder on the runner
 *   holds `implement` alone, while the first Thread's folder still holds both.
 *   Running `/teach` there does not produce the word of `teach`;
 * - the first Thread is then stopped and resumed with `/teach`. The resumed
 *   process gets a new folder, holding `implement` alone, and `/teach` does
 *   not produce its word. A last turn runs `/implement`, which completes and
 *   replies with its word. That shows Claude resumes a session whose plugin
 *   folder moved, and loads the plugin from the new folder.
 *
 * The folder is the deterministic check. The reply to `/teach` is only a
 * second sign, because a model asked to run a skill that does not exist could
 * reply with anything.
 *
 * Opt-in, like `session.test.ts`: it spends the developer's tokens and takes a
 * few minutes. Set `HERCULE_LIVE_SESSION_TEST=1` to run it. The login it runs
 * on is provided by either of the two routes `e2e/harness.ts` documents; with
 * neither, the case is skipped with a message.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PASSWORD,
  ROOT,
  USERNAME,
  buildCleanEnv,
  completeSetup,
  runCli,
  startController,
  type Controller,
} from "../scripts/controller-process";
import {
  LENT_CREDENTIALS,
  LOGIN_DEADLINE_MS,
  collectAssistantText,
  createTemporaryHome,
  isLiveSessionTestEnabled,
  isLoginAvailable,
  lendCredential,
  parseJsonOutputOrFail,
  probeUntilLoggedIn,
  readApiKey,
  readClaudeInstance,
  readSession,
  readTranscript,
  waitForTranscriptTag,
  type Page,
  type Row,
  type Session,
  type TemporaryHome,
} from "./harness";

/** Opt-in: `pnpm test:binary` on any machine must not silently spend a subscription. */
const wanted = isLiveSessionTestEnabled();

const binary = join(ROOT, "hercule");

/** Long enough for a cold harness to start, connect and reply to one prompt. */
const TURN_DEADLINE_MS = 180_000;

/** The word the `implement` skill tells the model to reply with. */
const IMPLEMENT_WORD = "MANGO733";

/** The word the `teach` skill tells the model to reply with. */
const TEACH_WORD = "PAPAYA733";

/** The controller's home, which the CLI is logged in from. */
let state: TemporaryHome;
/** The second runner's home: the remote machine. */
let machine: TemporaryHome;
/** The folder of the two skills that `hercule skill import` reads. */
let fixture: string;

let controller: Controller;
/** The second runner's daemon, started here so it can be stopped by its own pid. */
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;

/** The remote runner and the Claude instance logged in on it, once both are ready. */
interface Ready {
  readonly runnerId: string;
  readonly instanceId: string;
  /** The cheapest model the runner reported, or `undefined` for the instance's default. */
  readonly model: string | undefined;
}

let ready: Ready | undefined;

/** The sessions started here, so the suite can stop each one before the runner goes. */
const started: Array<string> = [];

/** Runs the CLI from the controller's home, where the login is. */
const runLoggedInCli = (args: ReadonlyArray<string>, stdin?: string) =>
  runCli(args, { home: state.home, binary, stdin });

/** Returns a `SKILL.md` that tells the model to reply with one word and nothing else. */
const buildSkillMd = (name: string, word: string): string =>
  [
    "---",
    `name: ${name}`,
    `description: Replies with the word ${word}.`,
    "---",
    `Reply with exactly the single word ${word} and nothing else. Use no tools.`,
    "",
  ].join("\n");

/** Writes the folder of two skills, `implement` and `teach`, and returns its path. */
const buildSkillsFolder = (): string => {
  fixture = mkdtempSync(join(tmpdir(), "hercule-e2e-skills-"));
  for (const [name, word] of [
    ["implement", IMPLEMENT_WORD],
    ["teach", TEACH_WORD],
  ] as const) {
    mkdirSync(join(fixture, name));
    writeFileSync(join(fixture, name, "SKILL.md"), buildSkillMd(name, word));
  }
  return fixture;
};

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
 * Prepares the remote runner with a logged-in Claude instance, and picks the
 * cheapest model it reports. Only the remote runner is given the login, so
 * the controller's own runner could not host the Thread even without
 * `--runner`.
 */
const prepare = async (url: string, apiKey: string): Promise<Ready> => {
  const runnerId = await startRemoteRunner(url);
  const instance = await readClaudeInstance({ url, apiKey });
  if (LENT_CREDENTIALS !== undefined) lendCredential(machine.home, instance.id);
  const snapshot = await probeUntilLoggedIn({
    home: state.home,
    binary,
    runnerId,
    instanceId: instance.id,
  });
  const model = snapshot.models.map((one) => one.slug).find((slug) => slug.includes("haiku"));
  return { runnerId, instanceId: instance.id, model };
};

/** Starts a Thread on the remote runner's Claude instance with one input, and returns its id. */
const startThread = async (input: string): Promise<string> => {
  const { runnerId, instanceId, model } = ready!;
  const session = parseJsonOutputOrFail<Session>(
    await runLoggedInCli(
      [
        "session",
        "spawn",
        "--instance",
        instanceId,
        "--runner",
        runnerId,
        ...(model === undefined ? [] : ["--model", model]),
        "--json",
      ],
      input,
    ),
  );
  started.push(session.id);
  return session.id;
};

/** Waits for a Thread's first turn to end, and returns its transcript. */
const waitForTurn = (id: string): Promise<ReadonlyArray<Row>> =>
  waitForTranscriptTag({
    home: state.home,
    binary,
    id,
    tag: "turn.completed",
    timeoutMs: TURN_DEADLINE_MS,
  });

/** Waits until a session has completed `count` turns, and returns its transcript. */
const waitForTurns = async (id: string, count: number): Promise<ReadonlyArray<Row>> => {
  const deadline = Date.now() + TURN_DEADLINE_MS;
  for (;;) {
    const rows = await readTranscript({ home: state.home, binary, id });
    if (rows.filter((row) => row.event._tag === "turn.completed").length >= count) return rows;
    if (Date.now() > deadline) {
      throw new Error(
        `session ${id} did not complete ${String(count)} turns: its transcript holds ` +
          rows.map((row) => row.event._tag).join(", "),
      );
    }
    await Bun.sleep(500);
  }
};

/** Waits until a session reads `exited`. */
const waitForExit = async (id: string): Promise<void> => {
  const deadline = Date.now() + TURN_DEADLINE_MS;
  while ((await readSession({ home: state.home, binary, id })).status !== "exited") {
    if (Date.now() > deadline) throw new Error(`session ${id} never exited`);
    await Bun.sleep(500);
  }
};

/**
 * Returns the names of the skills in the folder of a session's current start
 * on the remote runner, sorted. Each start gets a folder of its own,
 * `session-skills/<sessionId>-<uuid>/`, built before its process starts and
 * removed when the process exits, so it is read while the session runs.
 */
const listSessionSkills = (sessionId: string): ReadonlyArray<string> => {
  const pin = JSON.parse(readFileSync(join(machine.home, "runner", "runner.json"), "utf8")) as {
    readonly storageDirectory: string;
  };
  const dir = join(machine.home, "runner", pin.storageDirectory, "session-skills");
  const folders = readdirSync(dir).filter((name) => name.startsWith(`${sessionId}-`));
  if (folders.length !== 1) {
    throw new Error(
      `the runner has ${String(folders.length)} skills folders for session ${sessionId}, not one`,
    );
  }
  return readdirSync(join(dir, folders[0]!, "skills")).sort();
};

beforeAll(async () => {
  if (!wanted) return;
  if (!existsSync(binary)) {
    throw new Error(
      `no binary at ${binary}: run \`pnpm build:binary\` before \`pnpm test:binary\`.`,
    );
  }
  state = createTemporaryHome();
  machine = createTemporaryHome();
  controller = await startController({ home: state.home, binary });
  const url = controller.url;

  const completed = await completeSetup({ home: state.home, url, binary });
  expect(completed.code, `${completed.stdout}\n${completed.stderr}`).toBe(0);
  const login = await runCli(
    ["login", url, "--username", USERNAME, "--password-stdin", "--name", "e2e-skill-library"],
    { home: state.home, binary, stdin: PASSWORD },
  );
  expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);

  const imported = await runLoggedInCli(["skill", "import", buildSkillsFolder()]);
  expect(imported.code, `${imported.stdout}\n${imported.stderr}`).toBe(0);

  if (!isLoginAvailable()) return;
  ready = await prepare(url, readApiKey(state.home));
}, LOGIN_DEADLINE_MS * 3);

afterAll(async () => {
  for (const id of started) await runLoggedInCli(["session", "stop", id]).catch(() => undefined);
  await stopRemoteRunner();
  await controller?.stop().catch(() => -1);
  machine?.remove();
  state?.remove();
  if (fixture !== undefined) rmSync(fixture, { recursive: true, force: true });
}, 60_000);

describe.skipIf(!wanted)("the Skill Library in a Claude Thread on a remote runner", () => {
  it(
    "runs /implement, and after teach is deleted the next Thread and a resume lack it, while the resume still runs implement",
    async (ctx) => {
      if (ready === undefined) {
        ctx.skip(
          "no login for the claude-code instance: name a credentials file in " +
            "HERCULE_E2E_CLAUDE_CREDENTIALS, or put ANTHROPIC_API_KEY on the environment.",
        );
        return;
      }

      const first = await startThread("/implement");
      const firstRows = await waitForTurn(first);
      expect(listSessionSkills(first)).toEqual(["implement", "teach"]);
      expect(collectAssistantText(firstRows), JSON.stringify(firstRows)).toContain(IMPLEMENT_WORD);

      const deleted = await runLoggedInCli(["skill", "delete", "teach"]);
      expect(deleted.code, `${deleted.stdout}\n${deleted.stderr}`).toBe(0);

      const second = await startThread("/teach");
      const secondRows = await waitForTurn(second);
      expect(listSessionSkills(second)).toEqual(["implement"]);
      expect(collectAssistantText(secondRows), JSON.stringify(secondRows)).not.toContain(
        TEACH_WORD,
      );
      // The first Thread is still running, and keeps the set it started with.
      expect(listSessionSkills(first)).toEqual(["implement", "teach"]);

      // A resume is a new start, so it gets the library as it is now.
      const stopped = await runLoggedInCli(["session", "stop", first]);
      expect(stopped.code, `${stopped.stdout}\n${stopped.stderr}`).toBe(0);
      await waitForExit(first);
      const resumed = await runLoggedInCli(["session", "input", first], "/teach");
      expect(resumed.code, `${resumed.stdout}\n${resumed.stderr}`).toBe(0);
      const resumedRows = await waitForTurns(first, 2);
      expect(listSessionSkills(first)).toEqual(["implement"]);
      const resumedText = collectAssistantText(resumedRows.slice(firstRows.length));
      expect(resumedText, JSON.stringify(resumedRows)).not.toContain(TEACH_WORD);

      // A failed turn would also lack the word of `teach`, so the resumed
      // process must also run a skill it still has, and complete.
      const implemented = await runLoggedInCli(["session", "input", first], "/implement");
      expect(implemented.code, `${implemented.stdout}\n${implemented.stderr}`).toBe(0);
      const implementedRows = await waitForTurns(first, 3);
      const lastTurns = implementedRows.slice(resumedRows.length);
      expect(collectAssistantText(lastTurns), JSON.stringify(lastTurns)).toContain(IMPLEMENT_WORD);
      const completions = implementedRows.flatMap((row) =>
        row.event._tag === "turn.completed" ? [row.event.state] : [],
      );
      expect(completions, JSON.stringify(implementedRows)).toEqual([
        "completed",
        "completed",
        "completed",
      ]);
    },
    TURN_DEADLINE_MS * 5 + 60_000,
  );
});
