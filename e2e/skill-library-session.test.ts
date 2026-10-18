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
 *   into the instance's `CODEX_HOME` on the second runner. Two live copies of an
 *   OAuth login can rotate each other out, so prefer a file written by
 *   `codex login --with-api-key`, which holds no refresh token. `codex` must
 *   be on the `PATH`.
 * - pi: `ZAI_API_KEY` on the environment, which is stored as the pi
 *   instance's Z.ai key. `pi` must be on the `PATH`.
 */
import {
  chmodSync,
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
  buildInstanceDir,
  collectAssistantText,
  createTemporaryHome,
  isLiveSessionTestEnabled,
  isLoginAvailable,
  lendCredential,
  listInstances,
  parseJsonOutputOrFail,
  probeUntilLoggedIn,
  readApiKey,
  readRunnerStorageDir,
  readSession,
  readTranscript,
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

/** The word the `review` skill tells the model to reply with. */
const REVIEW_WORD = "KIWI734";

/** The Codex `auth.json` lent to the Codex instance, when the developer named one. */
const LENT_CODEX_AUTH = process.env["HERCULE_E2E_CODEX_AUTH"];

/** The Z.ai key stored as the pi instance's own, when the environment has one. */
const ZAI_API_KEY = process.env["ZAI_API_KEY"];

/** The controller's home, which the CLI is logged in from. */
let state: TemporaryHome;
/** The second runner's home: the remote machine. */
let machine: TemporaryHome;
/** The folder of `implement` and `teach`, which `hercule skill import` reads. */
let libraryFixture: string;
/** The folder of `review`, imported only before a resume. */
let reviewFixture: string;
/** Every folder of skills this file wrote, so `afterAll` can remove them. */
const fixtures: Array<string> = [];

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

/** One harness, and how this file drives it. */
interface Harness {
  readonly providerId: string;
  readonly label: string;
  /** Returns the input that runs the skill `name` in this harness. */
  readonly invokeSkill: (name: string) => string;
  /** Checks whether a model slug is one of the cheap models this file prefers. */
  readonly isCheapModel: (slug: string) => boolean;
  /** Returns why this harness cannot run on this machine, or `undefined` when it can. */
  readonly findSkipReason: () => string | undefined;
  /** Gives the instance its login on the second runner. */
  readonly lendLogin: (instanceId: string) => Promise<void>;
}

/** Returns a reason to skip when `name` is not on the `PATH`, or `undefined` when it is. */
const findMissingBinary = (name: string): string | undefined =>
  Bun.which(name) === null ? `\`${name}\` is not on the PATH.` : undefined;

const HARNESSES: ReadonlyArray<Harness> = [
  {
    providerId: "claude-code",
    label: "Claude Code",
    invokeSkill: (name) => `/${name}`,
    isCheapModel: (slug) => slug.includes("haiku"),
    findSkipReason: () =>
      isLoginAvailable()
        ? undefined
        : "no login for the claude-code instance: name a credentials file in " +
          "HERCULE_E2E_CLAUDE_CREDENTIALS, or put ANTHROPIC_API_KEY on the environment.",
    lendLogin: (instanceId) => {
      // With ANTHROPIC_API_KEY instead, the key reaches the runner through its
      // environment.
      if (LENT_CREDENTIALS !== undefined) lendCredential(machine.home, instanceId);
      return Promise.resolve();
    },
  },
  {
    providerId: "codex",
    label: "Codex",
    invokeSkill: (name) => `$${name}`,
    isCheapModel: (slug) => slug.includes("mini"),
    findSkipReason: () =>
      LENT_CODEX_AUTH === undefined
        ? "no login for the codex instance: name a Codex auth.json in HERCULE_E2E_CODEX_AUTH."
        : findMissingBinary("codex"),
    lendLogin: (instanceId) => {
      // The Codex adapter runs every process with `CODEX_HOME` set to the
      // instance's `codex` folder, where Codex keeps its login.
      const codexHome = join(buildInstanceDir(machine.home, instanceId), "codex");
      mkdirSync(codexHome, { recursive: true, mode: 0o700 });
      // Written with the mode a login needs, not the mode of the file lent.
      const auth = join(codexHome, "auth.json");
      writeFileSync(auth, readFileSync(LENT_CODEX_AUTH!, "utf8"), { mode: 0o600 });
      chmodSync(auth, 0o600);
      return Promise.resolve();
    },
  },
  {
    providerId: "pi",
    label: "pi",
    invokeSkill: (name) => `/skill:${name}`,
    isCheapModel: (slug) => slug.includes("flash"),
    findSkipReason: () =>
      ZAI_API_KEY === undefined
        ? "no login for the pi instance: put ZAI_API_KEY on the environment."
        : findMissingBinary("pi"),
    lendLogin: async (instanceId) => {
      // Over HTTP rather than `hercule provider update --config`, so the key
      // is never on a command line other processes can read.
      const { url, apiKey } = fleet!;
      const response = await fetch(`${url}/api/v1/providers/${instanceId}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ config: { zaiApiKey: ZAI_API_KEY } }),
      });
      expect(response.status, await response.text()).toBe(200);
    },
  },
];

/** Runs the CLI from the controller's home, where the login is. */
const runLoggedInCli = (args: ReadonlyArray<string>, stdin?: string) =>
  runCli(args, { home: state.home, binary, stdin });

/**
 * Returns a `SKILL.md` whose body tells the model to reply with one word and
 * nothing else. The description does not name the word, so the model learns
 * it only from the body.
 */
const buildSkillMd = (name: string, word: string): string =>
  [
    "---",
    `name: ${name}`,
    "description: Replies with a code word.",
    "---",
    `Reply with exactly the single word ${word} and nothing else. Use no tools.`,
    "",
  ].join("\n");

/** Writes the skill `name` into the folder of skills `dir`. */
const writeSkill = (dir: string, name: string, word: string): void => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), buildSkillMd(name, word));
};

/**
 * Writes a temporary folder of skills, one for each name in `words` with its
 * word, and returns its path.
 */
const buildSkillsFolder = (words: Readonly<Record<string, string>>): string => {
  const folder = mkdtempSync(join(tmpdir(), "hercule-e2e-skills-"));
  fixtures.push(folder);
  for (const [name, word] of Object.entries(words)) writeSkill(folder, name, word);
  return folder;
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
 * Brings the library back to `implement` and `teach` alone: imports both, and
 * deletes `review` when a harness before this one imported it.
 */
const resetLibrary = async (): Promise<void> => {
  const imported = await runLoggedInCli(["skill", "import", libraryFixture]);
  expect(imported.code, `${imported.stdout}\n${imported.stderr}`).toBe(0);
  const listed = parseJsonOutputOrFail<Page<{ readonly name: string }>>(
    await runLoggedInCli(["skill", "list", "--json"]),
  ).items;
  if (listed.some((skill) => skill.name === "review")) {
    const deleted = await runLoggedInCli(["skill", "delete", "review"]);
    expect(deleted.code, `${deleted.stdout}\n${deleted.stderr}`).toBe(0);
  }
};

/** A harness's instance, logged in on the second runner. */
interface Ready {
  readonly instanceId: string;
  /** The cheapest model the remote runner reported, or `undefined` for the instance's default. */
  readonly model: string | undefined;
}

/**
 * Gives the harness's instance its login on the second runner, and waits
 * until that runner's probe reports it logged in. Returns the instance with
 * the cheapest model the runner reports.
 */
const prepare = async (harness: Harness): Promise<Ready> => {
  const { url, apiKey, remoteRunnerId } = fleet!;
  const instance = (await listInstances({ url, apiKey })).find(
    (one) => one.providerId === harness.providerId,
  );
  if (instance === undefined) throw new Error(`no ${harness.providerId} instance was seeded`);
  await harness.lendLogin(instance.id);
  const snapshot = await probeUntilLoggedIn({
    home: state.home,
    binary,
    runnerId: remoteRunnerId,
    instanceId: instance.id,
  });
  const model = snapshot.models.map((one) => one.slug).find(harness.isCheapModel);
  return { instanceId: instance.id, model };
};

/** Starts a Thread on a runner with one input, and returns its id. */
const startThread = async (ready: Ready, runnerId: string, input: string): Promise<string> => {
  const session = parseJsonOutputOrFail<Session>(
    await runLoggedInCli(
      [
        "session",
        "spawn",
        "--instance",
        ready.instanceId,
        "--runner",
        runnerId,
        ...(ready.model === undefined ? [] : ["--model", ready.model]),
        "--json",
      ],
      input,
    ),
  );
  started.push(session.id);
  return session.id;
};

/** Sends one more input to a session, resuming it when it has exited. */
const sendInput = async (id: string, input: string): Promise<void> => {
  const sent = await runLoggedInCli(["session", "input", id], input);
  expect(sent.code, `${sent.stdout}\n${sent.stderr}`).toBe(0);
};

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

/** Returns the end state of every completed turn in a transcript, in order. */
const listTurnStates = (rows: ReadonlyArray<Row>): ReadonlyArray<unknown> =>
  rows.flatMap((row) => (row.event._tag === "turn.completed" ? [row.event["state"]] : []));

/**
 * Returns the names of the skills in the folder of a session's current start
 * on the remote runner, sorted. Each start gets a folder of its own,
 * `session-skills/<sessionId>-<uuid>/`, built before its process starts and
 * removed when the process exits, so it is read while the session runs.
 */
const listSessionSkills = (sessionId: string): ReadonlyArray<string> => {
  const dir = join(readRunnerStorageDir(machine.home), "session-skills");
  const folders = readdirSync(dir).filter((name) => name.startsWith(`${sessionId}-`));
  if (folders.length !== 1) {
    throw new Error(
      `the runner has ${String(folders.length)} session skills folders for session ${sessionId}, not one`,
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
  libraryFixture = buildSkillsFolder({ implement: IMPLEMENT_WORD, teach: TEACH_WORD });
  reviewFixture = buildSkillsFolder({ review: REVIEW_WORD });

  const remoteRunnerId = await startRemoteRunner(url);
  fleet = { url, apiKey: readApiKey(state.home), remoteRunnerId };
}, LOGIN_DEADLINE_MS * 3);

afterAll(async () => {
  for (const id of started) await runLoggedInCli(["session", "stop", id]).catch(() => undefined);
  await stopRemoteRunner();
  await controller?.stop().catch(() => -1);
  machine?.remove();
  state?.remove();
  for (const folder of fixtures) rmSync(folder, { recursive: true, force: true });
}, 60_000);

// Each harness is passed with its label first, because `%s` prints a label
// without the quotes that `$label` would add.
describe.skipIf(!wanted).each(HARNESSES.map((harness) => [harness.label, harness] as const))(
  "the Skill Library in a %s Thread",
  (_label, harness) => {
    const skipReason = harness.findSkipReason();
    let ready: Ready | undefined;

    beforeAll(async () => {
      if (skipReason !== undefined) return;
      await resetLibrary();
      ready = await prepare(harness);
    }, LOGIN_DEADLINE_MS + 30_000);

    it(
      "runs implement on a remote runner, and after teach is deleted the next Thread and a resume lack it, while the resume runs review, imported before it",
      async (ctx) => {
        if (ready === undefined) {
          ctx.skip(skipReason);
          return;
        }
        const { remoteRunnerId } = fleet!;

        const first = await startThread(ready, remoteRunnerId, harness.invokeSkill("implement"));
        const firstRows = await waitForTurns(first, 1);
        expect(listSessionSkills(first)).toEqual(["implement", "teach"]);
        expect(collectAssistantText(firstRows), JSON.stringify(firstRows)).toContain(
          IMPLEMENT_WORD,
        );

        const deleted = await runLoggedInCli(["skill", "delete", "teach"]);
        expect(deleted.code, `${deleted.stdout}\n${deleted.stderr}`).toBe(0);

        const second = await startThread(ready, remoteRunnerId, harness.invokeSkill("teach"));
        const secondRows = await waitForTurns(second, 1);
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
        await waitForExit(first);
        await sendInput(first, harness.invokeSkill("teach"));
        const resumedRows = await waitForTurns(first, 2);
        expect(listSessionSkills(first)).toEqual(["implement", "review"]);
        const resumedText = collectAssistantText(resumedRows.slice(firstRows.length));
        expect(resumedText, JSON.stringify(resumedRows)).not.toContain(TEACH_WORD);

        // A failed turn would also lack the word of `teach`, so the resumed
        // process must also run a skill only the new folder holds, and
        // complete. No earlier turn ran `review`, so its word can come only
        // from the new folder.
        await sendInput(first, harness.invokeSkill("review"));
        const reviewedRows = await waitForTurns(first, 3);
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
