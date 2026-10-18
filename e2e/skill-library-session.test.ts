/**
 * Tests that Claude Code, Codex and pi Threads get the Skill Library on every
 * runner, through the release binary (spec 06 section 9.4).
 *
 * The controller runs in one temporary home, and a second runner joins it from
 * a home of its own, as a machine elsewhere on the fleet would. Each harness
 * gets the same two cases.
 *
 * The first case places every Thread on the second runner with `--runner`, so
 * the skills reach it only by the runner fetching each revision from the
 * controller. Two skills are imported with `hercule skill import`. Each one
 * tells the model to reply with a word nothing else in the run contains:
 *
 * - the first Thread runs `implement` and replies with its word;
 * - `teach` is then deleted, and the next Thread's skills folder on the runner
 *   holds `implement` alone, while the first Thread's folder still holds both.
 *   Running `teach` there does not produce the word of `teach`;
 * - the first Thread is then stopped and resumed with `teach`. The resumed
 *   process gets a new folder, holding `implement` alone, and `teach` does
 *   not produce its word. A last turn runs `implement`, which completes and
 *   replies with its word. That shows the harness loads the skills from the
 *   new folder when it resumes: for Claude a plugin folder that moved, for
 *   Codex a new app-server that is given the skills folder again, for pi a new
 *   process with a new `--skill` path.
 *
 * Each harness names a skill its own way: `/implement` in Claude Code,
 * `$implement` in Codex, and `/skill:implement` in pi. The case imports both
 * skills again before it starts, because the case of the harness before it
 * deleted `teach`.
 *
 * The second case runs a Thread on the controller's own runner, the one runner
 * whose Threads see the user's own material. The controller, and so that
 * runner, runs with a temporary `HOME` that holds a skill named `decoy` in each
 * folder a harness used to load the user's skills from. The Thread runs
 * `decoy`, and the reply must not hold the word of `decoy`, whose description
 * would put it in front of the model if the harness had loaded it. A second
 * turn runs `implement`, to show the Thread worked at all.
 *
 * The folder is the deterministic check. A reply that lacks a word is only a
 * second sign, because a model asked to run a skill that does not exist could
 * reply with anything.
 *
 * Opt-in, like `session.test.ts`: it spends the developer's tokens and takes a
 * few minutes per harness. Set `HERCULE_LIVE_SESSION_TEST=1` to run it. Each
 * harness runs only when its login is given, and is skipped with a message
 * otherwise:
 *
 * - Claude Code: either of the two routes `e2e/harness.ts` documents.
 * - Codex: `HERCULE_E2E_CODEX_AUTH` names a Codex `auth.json`, which is copied
 *   into the instance's `CODEX_HOME` on both runners. Two live copies of an
 *   OAuth login can rotate each other out, so prefer a file written by
 *   `codex login --with-api-key`, which holds no refresh token. `codex` must
 *   be on the `PATH`.
 * - pi: `ZAI_API_KEY` on the environment, which is stored as the pi
 *   instance's Z.ai key. `pi` must be on the `PATH`.
 */
import {
  copyFileSync,
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
  readSession,
  readTranscript,
  waitForEnrolledRunner,
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

/** The word the `decoy` skill in the user's own skill folders tells the model to reply with. */
const DECOY_WORD = "GUAVA734";

/** The Codex `auth.json` lent to the Codex instance, when the developer named one. */
const LENT_CODEX_AUTH = process.env["HERCULE_E2E_CODEX_AUTH"];

/** The Z.ai key stored as the pi instance's own, when the environment has one. */
const ZAI_API_KEY = process.env["ZAI_API_KEY"];

/** The controller's home, which the CLI is logged in from. */
let state: TemporaryHome;
/** The second runner's home: the remote machine. */
let machine: TemporaryHome;
/** The `HOME` the controller and its own runner run with, holding the `decoy` skills. */
let userHome: TemporaryHome;
/** The folder of the two skills that `hercule skill import` reads. */
let fixture: string;

let controller: Controller;
/** The second runner's daemon, started here so it can be stopped by its own pid. */
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;

/** The controller and both runners, once all of them are up. */
interface Fleet {
  readonly url: string;
  readonly apiKey: string;
  /** The runner the controller starts for itself. */
  readonly localRunnerId: string;
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
  /** Gives the instance its login on both runners. */
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
      // With ANTHROPIC_API_KEY instead, the key reaches both runners through
      // their environment.
      if (LENT_CREDENTIALS !== undefined) {
        for (const home of [state.home, machine.home]) lendCredential(home, instanceId);
      }
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
      for (const home of [state.home, machine.home]) {
        const codexHome = join(buildInstanceDir(home, instanceId), "codex");
        mkdirSync(codexHome, { recursive: true, mode: 0o700 });
        copyFileSync(LENT_CODEX_AUTH!, join(codexHome, "auth.json"));
      }
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

/** Writes the skill `name` into the folder of skills `dir`. */
const writeSkill = (dir: string, name: string, word: string): void => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), buildSkillMd(name, word));
};

/** Writes the folder of two skills, `implement` and `teach`, and returns its path. */
const buildSkillsFolder = (): string => {
  fixture = mkdtempSync(join(tmpdir(), "hercule-e2e-skills-"));
  writeSkill(fixture, "implement", IMPLEMENT_WORD);
  writeSkill(fixture, "teach", TEACH_WORD);
  return fixture;
};

/**
 * Writes the `decoy` skill into every folder under `home` that a harness
 * loaded the user's own skills from before the Skill Library: Claude's
 * `~/.claude/skills`, Codex's `~/.agents/skills`, and pi's `~/.agents/skills`
 * and `~/.pi/agent/skills`.
 */
const plantDecoySkills = (home: string): void => {
  for (const dir of [".claude/skills", ".agents/skills", ".pi/agent/skills"]) {
    writeSkill(join(home, dir), "decoy", DECOY_WORD);
  }
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

/** A harness's instance, logged in on both runners. */
interface Ready {
  readonly instanceId: string;
  /** The cheapest model the remote runner reported, or `undefined` for the instance's default. */
  readonly model: string | undefined;
}

/**
 * Gives the harness's instance its login on both runners, and waits until
 * each runner's probe reports it logged in. Returns the instance with the
 * cheapest model the remote runner reports.
 */
const prepare = async (harness: Harness): Promise<Ready> => {
  const { url, apiKey, localRunnerId, remoteRunnerId } = fleet!;
  const instance = (await listInstances({ url, apiKey })).find(
    (one) => one.providerId === harness.providerId,
  );
  if (instance === undefined) throw new Error(`no ${harness.providerId} instance was seeded`);
  await harness.lendLogin(instance.id);
  const probe = (runnerId: string) =>
    probeUntilLoggedIn({ home: state.home, binary, runnerId, instanceId: instance.id });
  const [snapshot] = await Promise.all([probe(remoteRunnerId), probe(localRunnerId)]);
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
  // With a gitconfig, the home links `Library` back, so the controller still
  // finds its master key in the login keychain under the moved `HOME`.
  userHome = createTemporaryHome("");
  plantDecoySkills(userHome.home);
  controller = await startController({
    home: state.home,
    binary,
    env: { HOME: userHome.home },
  });
  const url = controller.url;

  const completed = await completeSetup({ home: state.home, url, binary });
  expect(completed.code, `${completed.stdout}\n${completed.stderr}`).toBe(0);
  const login = await runCli(
    ["login", url, "--username", USERNAME, "--password-stdin", "--name", "e2e-skill-library"],
    { home: state.home, binary, stdin: PASSWORD },
  );
  expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);
  buildSkillsFolder();

  // The controller's own runner is the only one online until the second joins.
  const localRunnerId = await waitForEnrolledRunner({ home: state.home, binary });
  const remoteRunnerId = await startRemoteRunner(url);
  fleet = { url, apiKey: readApiKey(state.home), localRunnerId, remoteRunnerId };
}, LOGIN_DEADLINE_MS * 3);

afterAll(async () => {
  for (const id of started) await runLoggedInCli(["session", "stop", id]).catch(() => undefined);
  await stopRemoteRunner();
  await controller?.stop().catch(() => -1);
  machine?.remove();
  state?.remove();
  userHome?.remove();
  if (fixture !== undefined) rmSync(fixture, { recursive: true, force: true });
}, 60_000);

// Each harness is passed with its label first, because `%s` prints a label
// without the quotes that `$label` would add.
describe.skipIf(!wanted).each(HARNESSES.map((harness) => [harness.label, harness] as const))(
  "the Skill Library in a %s Thread",
  (_label, harness) => {
    const skipReason = harness.findSkipReason();
    let ready: Ready | undefined;

    beforeAll(async () => {
      if (skipReason === undefined) ready = await prepare(harness);
    }, LOGIN_DEADLINE_MS + 30_000);

    it(
      "runs implement on a remote runner, and after teach is deleted the next Thread and a resume lack it, while the resume still runs implement",
      async (ctx) => {
        if (ready === undefined) {
          ctx.skip(skipReason);
          return;
        }
        const { remoteRunnerId } = fleet!;
        const imported = await runLoggedInCli(["skill", "import", fixture]);
        expect(imported.code, `${imported.stdout}\n${imported.stderr}`).toBe(0);

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
        const stopped = await runLoggedInCli(["session", "stop", first]);
        expect(stopped.code, `${stopped.stdout}\n${stopped.stderr}`).toBe(0);
        await waitForExit(first);
        await sendInput(first, harness.invokeSkill("teach"));
        const resumedRows = await waitForTurns(first, 2);
        expect(listSessionSkills(first)).toEqual(["implement"]);
        const resumedText = collectAssistantText(resumedRows.slice(firstRows.length));
        expect(resumedText, JSON.stringify(resumedRows)).not.toContain(TEACH_WORD);

        // A failed turn would also lack the word of `teach`, so the resumed
        // process must also run a skill it still has, and complete.
        await sendInput(first, harness.invokeSkill("implement"));
        const implementedRows = await waitForTurns(first, 3);
        const lastTurns = implementedRows.slice(resumedRows.length);
        expect(collectAssistantText(lastTurns), JSON.stringify(lastTurns)).toContain(
          IMPLEMENT_WORD,
        );
        expect(listTurnStates(implementedRows), JSON.stringify(implementedRows)).toEqual([
          "completed",
          "completed",
          "completed",
        ]);
      },
      TURN_DEADLINE_MS * 5 + 60_000,
    );

    it(
      "does not load the user's own skills on the controller's runner, and still runs implement there",
      async (ctx) => {
        if (ready === undefined) {
          ctx.skip(skipReason);
          return;
        }
        const thread = await startThread(ready, fleet!.localRunnerId, harness.invokeSkill("decoy"));
        const decoyRows = await waitForTurns(thread, 1);
        expect(collectAssistantText(decoyRows), JSON.stringify(decoyRows)).not.toContain(
          DECOY_WORD,
        );

        await sendInput(thread, harness.invokeSkill("implement"));
        const rows = await waitForTurns(thread, 2);
        const lastTurn = rows.slice(decoyRows.length);
        expect(collectAssistantText(lastTurn), JSON.stringify(lastTurn)).toContain(IMPLEMENT_WORD);
        expect(listTurnStates(rows), JSON.stringify(rows)).toEqual(["completed", "completed"]);
      },
      TURN_DEADLINE_MS * 2 + 60_000,
    );
  },
);
