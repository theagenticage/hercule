/**
 * Tests that a Skill Reference (`$name` for a library skill, `$<checkout>:name`
 * for a repository skill) in the text of an input runs the skill in Claude
 * Code, Codex and pi, through the release binary (spec 06 section 9.4,
 * "Composer rules").
 *
 * The text of an input is stored as typed. The runner translates each
 * reference for its harness and records the names it translated in
 * `detail.skills` of the `user_message` item:
 *
 * - Claude Code: the last skill becomes the slash command that runs it
 *   (`/skills:<name>` or `/repo-<checkout>:<name>`), placed in the last text
 *   part after the images. Every earlier skill is named by its command in the
 *   text before it, and runs only if the model chooses to call it.
 * - Codex: one `skill` input item per skill.
 * - pi: the first skill pi can run under its own name leads the message as
 *   `/skill:<name> `. Every other skill is a line that names its `SKILL.md`,
 *   which the model has to read.
 *
 * The skills are made so that their effect is visible without trusting the
 * model's prose. The body of each skill's `SKILL.md` tells the model to put a
 * code word in its reply, and the word is in the body only, never in the
 * skill's description. A word in the reply shows the harness gave the model
 * the whole skill. The words end in a random suffix made for each run, so
 * nothing the model has seen before can produce one.
 *
 * Four cases run for each harness:
 *
 * - Two skills and an image in one input, `$alpha $bravo ...`: the transcript
 *   holds the text as typed and both names in `detail.skills`, and the reply
 *   holds the words of both skills.
 * - A library skill and a repository skill both called `release`:
 *   `$release` gets the word of the library skill and `$webshop:release` the
 *   word of the repository skill.
 * - The CLI: `hercule session input <id>` with the text `$review the diff` on
 *   stdin runs the skill. The command takes its text from stdin only, as
 *   `hercule session input --help` says.
 * - Steering (Claude Code and Codex): while a turn runs, an input with a skill
 *   is steered. Claude cannot start a slash command in the middle of a turn.
 *   Codex accepts a skill item on a steer but never loads the skill body, so
 *   the model would not see the skill. Both runners refuse the steer with the
 *   message in `STEER_REFUSALS`, the input stays queued, the Thread shows no
 *   error, and the input runs when the turn ends. pi steers normally, so this
 *   case does not run for it.
 *
 * Opt-in, like `session.test.ts`: it spends the developer's tokens and takes a
 * few minutes per harness. Set `HERCULE_LIVE_SESSION_TEST=1` to run it. Each
 * harness runs only when its login is given, and is skipped with a message
 * otherwise:
 *
 * - Claude Code: either of the two routes `e2e/harness.ts` documents.
 * - Codex: `HERCULE_E2E_CODEX_AUTH` names a Codex `auth.json`, which is copied
 *   into the account's `CODEX_HOME`. Two live copies of an OAuth login can
 *   rotate each other out, so prefer a file written by `codex login
 *   --with-api-key`, which holds no refresh token. `codex` must be on the
 *   `PATH`.
 * - pi: `ZAI_API_KEY` on the environment, which is stored as the pi
 *   account's Z.ai key. `pi` must be on the `PATH`.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  deleteMasterKeyItem,
  findCompiledBinary,
  runCli,
  startController,
  type Controller,
} from "../scripts/controller-process";
import {
  LIVE_HARNESSES,
  LOGIN_DEADLINE_MS,
  assertSucceeded,
  buildGitEnv,
  collectAssistantText,
  completeSetupAndLogin,
  createSkillsFolder,
  createTemporaryHome,
  isLiveSessionTestEnabled,
  parseJsonOutputOrFail,
  prepareHarness,
  readSession,
  readTranscript,
  sendSessionInput,
  stopSessions,
  waitForEnrolledRunner,
  waitForTurns,
  writeSkill,
  type LiveHarness,
  type Page,
  type PreparedHarness,
  type Row,
  type Session,
  type TemporaryHome,
} from "./harness";

/** Opt-in: `pnpm test:binary` on any machine must not silently spend a subscription. */
const wanted = isLiveSessionTestEnabled();

let binary: string;

/** Long enough for a cold harness to start, connect and reply to one prompt. */
const TURN_DEADLINE_MS = 180_000;

/** The URL every repository's remote starts with; `insteadOf` rewrites it to `remotes/`. */
const REMOTE_PREFIX = "https://hercule.test/acme/";

/**
 * The message each runner gives when a skill is steered into a running turn,
 * by harness id. A harness without an entry steers the skill normally.
 */
const STEER_REFUSALS: Partial<Record<string, string>> = {
  "claude-code/claude-code":
    "Not steered: Claude Code can't start a skill in the middle of a turn. The input stays queued and runs when this turn ends.",
  "codex/codex":
    "Not steered: Codex can't start a skill in the middle of a turn. The input stays queued and runs when this turn ends.",
};

/** Distinguishes the words of one run from those of any other run. */
const RUN = randomBytes(3).toString("hex").toUpperCase();

/** The code word each skill tells the model to put in its reply. */
const ALPHA_WORD = `ALPHA-${RUN}`;
const BRAVO_WORD = `BRAVO-${RUN}`;
const REVIEW_WORD = `REVIEW-${RUN}`;
/** The words of the library skill `release` and of the `release` skill of `webshop`. */
const LIBRARY_RELEASE_WORD = `LIBREL-${RUN}`;
const REPOSITORY_RELEASE_WORD = `REPOREL-${RUN}`;

/** The controller's home, which the CLI is logged in from. */
let state: TemporaryHome;
/** Holds the bare repository `webshop`. */
let world: TemporaryHome;
/** The `HOME` of the controller and its runner: the git configuration that rewrites the remote. */
let gitHome: TemporaryHome;
/** The folder of the library skills, which `hercule skill import` reads. */
let libraryFixture: string;
/** A folder that holds the red image the first case sends. */
let imageFolder: string;
let imagePath: string;

let controller: Controller;
let url: string;
let apiKey: string;
/** The runner the controller starts for itself. */
let runnerId: string;
let webshopResourceId: string;

/** The sessions started here, so the suite can stop each one before the controller goes. */
const started: Array<string> = [];

/** Runs the CLI from the controller's home, where the login is. */
const runLoggedInCli = (args: ReadonlyArray<string>, stdin?: string) =>
  runCli(args, { home: state.home, binary, stdin });

/** Runs git on the test's own files. Throws with git's output when it fails. */
const runGit = (args: ReadonlyArray<string>, cwd: string): void => {
  const ran = Bun.spawnSync(["git", ...args], { cwd, env: buildGitEnv(gitHome.home) });
  if (ran.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} in ${cwd}:\n${ran.stderr.toString()}`);
  }
};

/**
 * Writes a skill whose body tells the model to put `word` in its reply
 * beside whatever else the user asked for. `writeSkill` of the harness makes
 * the model reply with the word alone, which two skills in one input would
 * contradict.
 */
const writeAdditiveSkill = (dir: string, name: string, word: string): void => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(
    join(dir, name, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      "description: Adds a code line to a reply.",
      "---",
      `The user asked for this skill by name. Put the exact code word ${word} on a line of its own in your reply, beside whatever else the user asked for.`,
      "",
    ].join("\n"),
  );
};

/**
 * Writes a skill that makes the model reply with `word` alone, whatever else
 * the user's text asks for. The CLI case sends `$review the diff`, which
 * invites a model to go and read a diff; the skill must win over that.
 */
const writeStrictSkill = (dir: string, name: string, word: string): void => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(
    join(dir, name, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      "description: Replies with a code word.",
      "---",
      `This is a test of the skill mechanism. Whatever the user's message asks for, do not read any file, run any command or use any tool. Reply with exactly the single word ${word} and nothing else.`,
      "",
    ].join("\n"),
  );
};

/** Returns a PNG file of one solid red square, built here so the test needs no fixture. */
const buildRedPng = (): Buffer => {
  const size = 32;
  const buildPngChunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(Bun.hash.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // colour type: RGB
  // One filter byte (none) and three bytes per pixel, for each row.
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.alloc(size * 3).fill(Buffer.from([255, 0, 0])),
  ]);
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    buildPngChunk("IHDR", header),
    buildPngChunk("IDAT", deflateSync(pixels)),
    buildPngChunk("IEND", Buffer.alloc(0)),
  ]);
};

/** Gives the harness's account its login, and waits until the runner's probe reports it. */
const prepareLoggedInHarness = (harness: LiveHarness): Promise<PreparedHarness> =>
  prepareHarness(harness, {
    home: state.home,
    binary,
    url,
    apiKey,
    runnerId,
    // The controller's own runner keeps its storage in the controller's home.
    runnerHome: state.home,
  });

/** What a `session spawn` of this file asks for beyond its input. */
interface SpawnOptions {
  readonly workspace: unknown;
  readonly images?: ReadonlyArray<string>;
  readonly accessMode?: string;
}

/** Starts a Thread with one input on the controller's runner, and returns its id. */
const startThread = async (
  prepared: PreparedHarness,
  input: string,
  options: SpawnOptions,
): Promise<string> => {
  const session = parseJsonOutputOrFail<Session>(
    await runLoggedInCli(
      [
        "session",
        "spawn",
        "--account",
        prepared.providerAccountId,
        "--harness",
        prepared.harnessId,
        "--runner",
        runnerId,
        ...(prepared.model === undefined ? [] : ["--model", prepared.model]),
        "--workspace",
        JSON.stringify(options.workspace),
        ...(options.accessMode === undefined ? [] : ["--access-mode", options.accessMode]),
        ...(options.images ?? []).flatMap((path) => ["--image", path]),
        "--json",
      ],
      input,
    ),
  );
  started.push(session.id);
  return session.id;
};

/**
 * Waits until a session has completed `count` turns, and returns its
 * transcript. A timeout also reports what the session was parked on, because
 * a harness that waits for an approval never ends its turn.
 */
const waitForTurnCount = async (id: string, count: number): Promise<ReadonlyArray<Row>> => {
  try {
    return await waitForTurns({ home: state.home, binary, id, count, timeoutMs: TURN_DEADLINE_MS });
  } catch (error) {
    const session = await runLoggedInCli(["session", "read", id, "--json"]);
    const rows = await readTranscript({ home: state.home, binary, id });
    const opened = rows.filter((row) => row.event._tag === "request.opened");
    throw new Error(
      `${String(error)}\nsession: ${session.stdout.slice(0, 1500)}\nrequests: ${JSON.stringify(opened)}\nlast rows: ${JSON.stringify(rows.slice(-4))}`,
      { cause: error },
    );
  }
};

/**
 * Sends `input` to a running session, waits for turn number `turn` to
 * complete, and returns the transcript with the text the assistant wrote in
 * the turns since `previous`.
 */
const completeTurn = async (
  id: string,
  input: string,
  turn: number,
  previous: ReadonlyArray<Row>,
): Promise<{ readonly rows: ReadonlyArray<Row>; readonly text: string }> => {
  await sendSessionInput({ home: state.home, binary, id, input });
  const rows = await waitForTurnCount(id, turn);
  return { rows, text: collectAssistantText(rows.slice(previous.length)) };
};

/** One user message of a transcript: what was typed and what the runner translated. */
interface UserMessage {
  readonly text: string;
  readonly skills: ReadonlyArray<string> | undefined;
}

/** Returns the user messages of a transcript in order, from their completed items. */
const listUserMessages = (rows: ReadonlyArray<Row>): ReadonlyArray<UserMessage> =>
  rows.flatMap((row) => {
    const event = row.event;
    if (event._tag !== "item.completed" || event["kind"] !== "user_message") return [];
    const detail = event["detail"] as {
      readonly text: string;
      readonly skills?: ReadonlyArray<string>;
    };
    return [{ text: detail.text, skills: detail.skills }];
  });

/** Returns the tags of the `runtime.error` events of a transcript. */
const listRuntimeErrors = (rows: ReadonlyArray<Row>): ReadonlyArray<unknown> =>
  rows.filter((row) => row.event._tag === "runtime.error").map((row) => row.event);

/** Returns a harness's reply for a failure message: the assistant text and the whole transcript. */
const describeReply = (rows: ReadonlyArray<Row>): string =>
  `reply: ${JSON.stringify(collectAssistantText(rows))}\ntranscript: ${JSON.stringify(rows)}`;

/** The scratch workspace: a directory with no repository in it. */
const SCRATCH_WORKSPACE = { kind: "ephemeral", checkouts: [] } as const;

beforeAll(async () => {
  if (!wanted) return;
  binary = findCompiledBinary();
  world = createTemporaryHome();
  gitHome = createTemporaryHome("[init]\n\tdefaultBranch = main\n");
  // The Hercule Home sits inside the `HOME`, as `~/.hercule` does in a real install.
  const hercule = join(gitHome.home, ".hercule");
  mkdirSync(hercule);
  state = { home: hercule, remove: () => deleteMasterKeyItem(hercule) };

  // The runner clones `https://hercule.test/acme/<name>` from `remotes/<name>`.
  appendFileSync(
    join(gitHome.home, ".gitconfig"),
    `[url "file://${join(world.home, "remotes")}/"]\n\tinsteadOf = ${REMOTE_PREFIX}\n`,
  );

  controller = await startController({
    home: state.home,
    binary,
    // The runner the controller starts reads this `HOME`, and nothing of the developer's.
    env: { HOME: gitHome.home, GIT_CONFIG_NOSYSTEM: "1" },
  });
  url = controller.url;
  apiKey = await completeSetupAndLogin({
    home: state.home,
    url,
    binary,
    apiKeyName: "e2e-skill-references",
  });
  runnerId = await waitForEnrolledRunner({ home: state.home, binary });

  // The library holds `alpha`, `bravo`, `review` and `release`. The first two
  // add their word to a reply; the other two make the reply that word alone.
  libraryFixture = createSkillsFolder({ release: LIBRARY_RELEASE_WORD });
  writeStrictSkill(libraryFixture, "review", REVIEW_WORD);
  writeAdditiveSkill(libraryFixture, "alpha", ALPHA_WORD);
  writeAdditiveSkill(libraryFixture, "bravo", BRAVO_WORD);
  // Imported once: no case changes the library after this.
  assertSucceeded(await runLoggedInCli(["skill", "import", libraryFixture]));

  // The repository `webshop` holds its own `release`.
  const bare = join(world.home, "remotes", "webshop");
  const seed = join(world.home, "seeds", "webshop");
  mkdirSync(seed, { recursive: true });
  runGit(["init", "--bare", "--initial-branch=main", bare], world.home);
  runGit(["init", "--initial-branch=main"], seed);
  writeFileSync(join(seed, "README.md"), "webshop\n");
  writeSkill(join(seed, ".agents", "skills"), "release", REPOSITORY_RELEASE_WORD);
  runGit(["add", "."], seed);
  runGit(["commit", "-m", "one commit"], seed);
  runGit(["push", bare, "main"], seed);
  webshopResourceId = parseJsonOutputOrFail<{ readonly id: string }>(
    await runLoggedInCli([
      "resource",
      "create",
      "--kind",
      "repo",
      "--remote",
      `${REMOTE_PREFIX}webshop`,
      "--json",
    ]),
  ).id;

  imageFolder = mkdtempSync(join(tmpdir(), "hercule-e2e-image-"));
  imagePath = join(imageFolder, "red.png");
  writeFileSync(imagePath, buildRedPng());
}, LOGIN_DEADLINE_MS * 3);

afterAll(async () => {
  if (started.length > 0) await stopSessions({ home: state.home, binary, ids: started });
  await controller?.stop().catch(() => -1);
  state?.remove();
  world?.remove();
  gitHome?.remove();
  for (const folder of [libraryFixture, imageFolder]) {
    if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  }
}, 60_000);

// Each harness is passed with its label first, because `%s` prints a label
// without the quotes that `$label` would add.
describe.skipIf(!wanted).each(LIVE_HARNESSES.map((harness) => [harness.label, harness] as const))(
  "Skill References in a %s Thread",
  (label, harness) => {
    const skipReason = harness.findSkipReason();
    let prepared: PreparedHarness | undefined;

    beforeAll(async () => {
      if (skipReason !== undefined) return;
      prepared = await prepareLoggedInHarness(harness);
    }, LOGIN_DEADLINE_MS + 30_000);

    it(
      "runs two skills named in one input that has an image",
      async (ctx) => {
        if (prepared === undefined) {
          ctx.skip(skipReason);
          return;
        }
        const text = "$alpha $bravo what colour is the image? Answer in one short sentence.";
        // Full access, because a model may read the skill files before it
        // answers, and in approval-required mode that read waits for a person
        // (Codex did this in two of five runs). This test checks the
        // translation, not the approvals.
        const id = await startThread(prepared, text, {
          workspace: SCRATCH_WORKSPACE,
          images: [imagePath],
          accessMode: "full-access",
        });
        const rows = await waitForTurnCount(id, 1);
        const reply = collectAssistantText(rows);
        // What each harness did with the reply is the finding, so print it.
        console.log(`[${label}] two skills and an image: ${JSON.stringify(reply)}`);

        // The text is stored as typed, and both skills were translated.
        const [message] = listUserMessages(rows);
        expect(message?.text).toBe(text);
        expect(message?.skills).toEqual(["alpha", "bravo"]);
        expect(listRuntimeErrors(rows)).toEqual([]);

        // Only the skills the harness runs by itself are required. Claude runs
        // the last one as a command and leaves the earlier ones to the model;
        // pi runs the first one natively and gives the others as a pointer to
        // read.
        const guaranteed = {
          "claude-code/claude-code": [BRAVO_WORD],
          "codex/codex": [ALPHA_WORD, BRAVO_WORD],
          "pi/pi": [ALPHA_WORD],
        }[harness.harnessId] ?? [ALPHA_WORD, BRAVO_WORD];
        for (const word of guaranteed) expect(reply, describeReply(rows)).toContain(word);
        // Whether a harness reads the image is a property of its model, not of
        // the translation; the cheap pi model may not take images.
        if (harness.harnessId !== "pi/pi") {
          expect(reply.toLowerCase(), describeReply(rows)).toContain("red");
        }
      },
      TURN_DEADLINE_MS + 60_000,
    );

    it(
      "tells a library skill from a repository skill of the same name",
      async (ctx) => {
        if (prepared === undefined) {
          ctx.skip(skipReason);
          return;
        }
        const id = await startThread(prepared, "$release", {
          workspace: { kind: "ephemeral", checkouts: [{ resourceId: webshopResourceId }] },
        });
        const first = await waitForTurnCount(id, 1);
        const libraryReply = collectAssistantText(first);
        console.log(`[${label}] $release: ${JSON.stringify(libraryReply)}`);
        expect(listUserMessages(first)[0]?.skills).toEqual(["release"]);
        // In pi both skills are called `release` in its own list, so which one
        // `/skill:release` runs is pi's choice. The reply is logged instead.
        if (harness.harnessId !== "pi/pi") {
          expect(libraryReply, describeReply(first)).toContain(LIBRARY_RELEASE_WORD);
          expect(libraryReply, describeReply(first)).not.toContain(REPOSITORY_RELEASE_WORD);
        }

        const second = await completeTurn(id, "$webshop:release", 2, first);
        console.log(`[${label}] $webshop:release: ${JSON.stringify(second.text)}`);
        expect(listUserMessages(second.rows)[1]?.skills).toEqual(["webshop:release"]);
        // In pi a repository skill is a pointer to its `SKILL.md`, which the
        // model has to read; the reply is logged instead.
        if (harness.harnessId !== "pi/pi") {
          expect(second.text, describeReply(second.rows)).toContain(REPOSITORY_RELEASE_WORD);
          expect(second.text, describeReply(second.rows)).not.toContain(LIBRARY_RELEASE_WORD);
        }
      },
      TURN_DEADLINE_MS * 2 + 120_000,
    );

    it(
      "runs a skill from the text `hercule session input` reads on stdin",
      async (ctx) => {
        if (prepared === undefined) {
          ctx.skip(skipReason);
          return;
        }
        // The first turn has no skill, so the skill comes only from the CLI input.
        const id = await startThread(prepared, "Reply with the single word READY.", {
          workspace: SCRATCH_WORKSPACE,
        });
        const first = await waitForTurnCount(id, 1);

        const text = "$review the diff";
        const sent = parseJsonOutputOrFail<{ readonly inputId: string }>(
          await runLoggedInCli(["session", "input", id, "--json"], text),
        );
        expect(sent.inputId).toBeTruthy();
        const rows = await waitForTurnCount(id, 2);
        const reply = collectAssistantText(rows.slice(first.length));
        console.log(`[${label}] CLI $review: ${JSON.stringify(reply)}`);

        expect(listUserMessages(rows)[1]).toEqual({ text, skills: ["review"] });
        expect(reply, describeReply(rows)).toContain(REVIEW_WORD);
      },
      TURN_DEADLINE_MS * 2 + 120_000,
    );

    const steerRefusal = STEER_REFUSALS[harness.harnessId];
    if (steerRefusal !== undefined) {
      it(
        "refuses to steer a skill into a running turn, keeps the input queued and runs it when the turn ends",
        async (ctx) => {
          if (prepared === undefined) {
            ctx.skip(skipReason);
            return;
          }
          // A shell command that sleeps keeps the turn busy for longer than the
          // test needs. Full access, so that no approval parks the turn.
          const id = await startThread(
            prepared,
            "Run the shell command `sleep 45`, wait for it to finish, then reply with the single word WAITED.",
            { workspace: SCRATCH_WORKSPACE, accessMode: "full-access" },
          );
          const deadline = Date.now() + TURN_DEADLINE_MS;
          while ((await readSession({ home: state.home, binary, id })).status !== "busy") {
            if (Date.now() > deadline) throw new Error(`session ${id} never became busy`);
            await Bun.sleep(500);
          }
          // Wait until the model has started its command, so the turn is well under way.
          for (;;) {
            const rows = await readTranscript({ home: state.home, binary, id });
            if (
              rows.some(
                (row) =>
                  row.event._tag === "item.started" && row.event["kind"] === "command_execution",
              )
            ) {
              break;
            }
            if (Date.now() > deadline) throw new Error(`session ${id} never ran its command`);
            await Bun.sleep(500);
          }

          // `--steer true` stores the input and tries to steer it. The refusal
          // leaves the input queued, so the answer is `queued`.
          const sent = parseJsonOutputOrFail<{ readonly inputId: string; readonly result: string }>(
            await runLoggedInCli(
              ["session", "input", id, "--steer", "true", "--json"],
              "$alpha say hello",
            ),
          );
          expect(sent.result).toBe("queued");

          // The reason of the refusal is on the queued input. The steer runs
          // after the request ends, so the reason may take a moment to appear.
          const listInputs = async () =>
            parseJsonOutputOrFail<
              Page<{
                readonly id: string;
                readonly status: string;
                readonly reason?: string | null;
              }>
            >(await runLoggedInCli(["input", "list", id, "--json", "--all"])).items;
          let queued = (await listInputs()).find((one) => one.id === sent.inputId);
          for (let i = 0; i < 20 && queued?.reason == null; i++) {
            await Bun.sleep(500);
            queued = (await listInputs()).find((one) => one.id === sent.inputId);
          }
          console.log(`[${label}] steer refusal on the input: ${JSON.stringify(queued)}`);
          expect(queued?.status).toBe("queued");
          expect(queued?.reason).toBe(steerRefusal);

          // Steering the same input by hand is refused the same way, and
          // `invalid_state` carries the message.
          const steered = await runLoggedInCli(["input", "steer", id, sent.inputId]);
          console.log(`[${label}] input steer: ${steered.stdout}${steered.stderr}`);
          expect(steered.code).not.toBe(0);
          expect(`${steered.stdout}${steered.stderr}`).toContain(steerRefusal);

          // Nothing failed in the Thread, and the input waits for the turn to end.
          const during = await readTranscript({ home: state.home, binary, id });
          expect(listRuntimeErrors(during)).toEqual([]);
          expect(listUserMessages(during)).toHaveLength(1);

          // The first turn ends, and the queued input runs as the next turn.
          const rows = await waitForTurnCount(id, 2);
          expect(listRuntimeErrors(rows)).toEqual([]);
          const messages = listUserMessages(rows);
          expect(messages.map((one) => one.text)).toEqual([
            expect.stringContaining("sleep 45"),
            "$alpha say hello",
          ]);
          expect(messages[1]?.skills).toEqual(["alpha"]);
          const lastTurn = collectAssistantText(rows.slice(during.length));
          console.log(`[${label}] after the turn: ${JSON.stringify(lastTurn)}`);
          expect(lastTurn, describeReply(rows)).toContain(ALPHA_WORD);
          assertSucceeded(await runLoggedInCli(["session", "stop", id]));
        },
        TURN_DEADLINE_MS * 2 + 120_000,
      );
    }
  },
);
