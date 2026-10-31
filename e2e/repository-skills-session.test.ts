/**
 * Tests that Claude Code, Codex and pi Threads get the skills of their
 * workspace's repositories beside the Skill Library, and never the user's own
 * skills, through the release binary (spec 06 section 9.4).
 *
 * The repositories are bare ones in a temporary directory, and each resource
 * refers to its repository by an `https://` URL that git's `insteadOf`
 * rewrites to the bare repository, as `workspace.test.ts` does. The controller
 * and its own runner run with a `HOME` of this file's making, which holds the
 * git configuration and also a user's own skill, `user-skill`, in both
 * `~/.claude/skills` and `~/.agents/skills`. The Hercule Home is `~/.hercule`
 * in that `HOME`, as in a real install, so a harness that walks up from its
 * workspace reaches those folders. The runner cloned the repositories through
 * that `HOME`, so a workspace that exists shows the runner reads it.
 *
 * The repositories are `shop`, with `.claude/skills/from-claude` and
 * `.agents/skills/from-agents`, and `api` and `web`, which each hold
 * `.agents/skills/release`. The Skill Library holds `implement`. The body of
 * each skill's `SKILL.md` tells the model to reply with a word nothing else in
 * the run contains. The word is in the body only, never in the skill's
 * description, so a reply that holds it shows the harness gave the model the
 * whole skill, not just the list of skills.
 *
 * Each harness gets three cases, and each case stands alone:
 *
 * - A Thread in the main workspace of `shop` runs `from-claude`,
 *   `from-agents` and `implement`, and replies with the word of each.
 *   `session skill list` lists `implement`, `shop:from-agents` and
 *   `shop:from-claude`. `review` is then imported into the library: it is not
 *   in that session's list, which holds the library as it was at the start, and
 *   it is in the list a new Thread would get, which `session skill preview`
 *   gives for the draft of a Thread. The Thread is then
 *   stopped and resumed, and now its list holds `review`, which the resumed
 *   process runs.
 * - A Thread in a new workspace of `api` and `web` lists `api:release` and
 *   `web:release`: the same skill name in two repositories is two names. It
 *   does not have `user-skill`.
 * - A Thread in a workspace with no checkout does not have `user-skill`.
 *
 * Each harness names a skill its own way. A library skill is `/implement` in
 * Claude Code, `$implement` in Codex and `/skill:implement` in pi. A repository
 * skill is `/repo-shop:from-claude` in Claude Code, `$from-claude` in Codex and
 * `/skill:from-claude` in pi.
 *
 * The listed skills and the session skills folder on the runner are the
 * deterministic check. A reply that lacks the word of `user-skill` is only a
 * second sign, because a model asked to run a skill that does not exist could
 * reply with anything. The runner's unit and integration tests own the check
 * that the harness is not given the folders of the user's own skills.
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
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  deleteMasterKeyItem,
  findCompiledBinary,
  runCli,
  startController,
  type Controller,
  type Ran,
} from "../scripts/controller-process";
import {
  LIVE_HARNESSES,
  LOGIN_DEADLINE_MS,
  buildGitEnv,
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
  waitForEnrolledRunner,
  waitForExit,
  waitForTurns,
  writeSkill,
  type LiveHarness,
  type PreparedHarness,
  type Row,
  type TemporaryHome,
} from "./harness";

/** Opt-in: `pnpm test:binary` on any machine must not silently spend a subscription. */
const wanted = isLiveSessionTestEnabled();

let binary: string;

/** Long enough for a cold harness to start, connect and reply to one prompt. */
const TURN_DEADLINE_MS = 180_000;

/** How long a clone and a worktree may take on a cold machine. */
const PROVISION_DEADLINE_MS = 60_000;

/** The URL every repository's remote starts with; `insteadOf` rewrites it to `remotes/`. */
const REMOTE_PREFIX = "https://hercule.test/acme/";

/** The word the library skill `implement` tells the model to reply with. */
const IMPLEMENT_WORD = "MANGO768";

/** The word the library skill `review` tells the model to reply with. */
const REVIEW_WORD = "KIWI768";

/** The word the `.claude/skills/from-claude` skill of `shop` tells the model to reply with. */
const FROM_CLAUDE_WORD = "GUAVA768";

/** The word the `.agents/skills/from-agents` skill of `shop` tells the model to reply with. */
const FROM_AGENTS_WORD = "LYCHEE768";

/** The word of the `release` skill of `api` and `web`, which no case runs. */
const RELEASE_WORD = "FIG768";

/** The word of the user's own skill, which no harness may give the model. */
const USER_SKILL_WORD = "PAPAYA369";

/** The controller's home, which the CLI is logged in from. */
let state: TemporaryHome;
/** Holds the bare repositories. */
let world: TemporaryHome;
/**
 * The `HOME` of the controller and the runner it starts: the git configuration
 * that rewrites the remotes, and the user's own skills.
 */
let gitHome: TemporaryHome;
/** The folder of the library skill `implement`, which `hercule skill import` reads. */
let libraryFixture: string;
/** The folder of `review`, imported only while a case runs. */
let reviewFixture: string;

let controller: Controller;
let url: string;
let apiKey: string;
/** The runner the controller starts for itself, where every workspace is made. */
let runnerId: string;
/** The resource of each repository, by the repository's name. */
const resourceIds = new Map<string, string>();

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
 * Creates the bare repository `name` under `remotes/`, with one commit that
 * holds the skills in `skills`, and records it as a resource. Each skill is a
 * folder `<skillsFolder>/<skill>` for a pair `[skillsFolder, skill, word]`.
 */
const createRepository = async (
  name: string,
  skills: ReadonlyArray<readonly [skillsFolder: string, skill: string, word: string]>,
): Promise<void> => {
  const bare = join(world.home, "remotes", name);
  const seed = join(world.home, "seeds", name);
  mkdirSync(seed, { recursive: true });
  runGit(["init", "--bare", "--initial-branch=main", bare], world.home);
  runGit(["init", "--initial-branch=main"], seed);
  writeFileSync(join(seed, "README.md"), `${name}\n`);
  for (const [skillsFolder, skill, word] of skills) {
    writeSkill(join(seed, skillsFolder), skill, word);
  }
  runGit(["add", "."], seed);
  runGit(["commit", "-m", "one commit"], seed);
  runGit(["push", bare, "main"], seed);
  const resource = parseJsonOutputOrFail<{ readonly id: string }>(
    await runLoggedInCli([
      "resource",
      "create",
      "--kind",
      "repo",
      "--remote",
      `${REMOTE_PREFIX}${name}`,
      "--json",
    ]),
  );
  resourceIds.set(name, resource.id);
};

/** Returns the id of the resource of the repository `name`. */
const readResourceId = (name: string): string => {
  const id = resourceIds.get(name);
  if (id === undefined) throw new Error(`no resource was made for ${name}`);
  return id;
};

/** Gives the harness's account its login, and waits until the runner's probe reports it. */
const prepare = (harness: LiveHarness): Promise<PreparedHarness> =>
  prepareHarness(harness, {
    home: state.home,
    binary,
    url,
    apiKey,
    runnerId,
    // The controller's own runner keeps its storage in the controller's home.
    runnerHome: state.home,
  });

/**
 * Provisions the main workspace of a repository on the runner, and waits until
 * it is ready. A draft Thread's list reads this workspace.
 */
const provisionMainWorkspace = async (resourceId: string): Promise<void> => {
  const provisioned = parseJsonOutputOrFail<{ readonly id: string }>(
    await runLoggedInCli([
      "workspace",
      "provision",
      "--resource",
      resourceId,
      "--runner",
      runnerId,
      "--json",
    ]),
  );
  const deadline = Date.now() + PROVISION_DEADLINE_MS;
  for (;;) {
    const workspace = parseJsonOutputOrFail<{
      readonly status: string;
      readonly message?: string;
    }>(await runLoggedInCli(["workspace", "read", provisioned.id, "--json"]));
    if (workspace.status === "ready") return;
    if (workspace.status !== "provisioning") {
      throw new Error(`workspace ${provisioned.id} is ${workspace.status}: ${workspace.message}`);
    }
    if (Date.now() > deadline) throw new Error(`workspace ${provisioned.id} never became ready`);
    await Bun.sleep(250);
  }
};

/** Starts a Thread in `workspace` with one input, and returns its id. */
const startThread = async (
  prepared: PreparedHarness,
  workspace: unknown,
  input: string,
): Promise<string> => {
  const id = await spawnThread({ home: state.home, binary, runnerId, prepared, input, workspace });
  started.push(id);
  return id;
};

/** Waits until a session has completed `count` turns, and returns its transcript. */
const waitForTurnCount = (id: string, count: number): Promise<ReadonlyArray<Row>> =>
  waitForTurns({ home: state.home, binary, id, count, timeoutMs: TURN_DEADLINE_MS });

/**
 * Sends `input` to a running session, waits for turn number `turn` to
 * complete, and returns the text the assistant wrote in the turns since
 * `previous`, with the whole transcript.
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

/**
 * Parses the `--json` output of `hercule session skill list` or `preview` into
 * the names of its skills. Library skills come first, then repository skills
 * as `<checkout>:<skill>`. Fails when the controller reports the list as
 * incomplete or skipped a skill folder, because a missing part would look like
 * an empty one.
 */
const readSkillNames = (ran: Ran): ReadonlyArray<string> => {
  const list = parseJsonOutputOrFail<{
    readonly items: ReadonlyArray<{ readonly name: string }>;
    readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
    readonly incompleteReason?: string;
  }>(ran);
  expect(list.incompleteReason).toBeUndefined();
  expect(list.skipped).toEqual([]);
  return list.items.map((item) => item.name);
};

/** Lists the names of the skills `hercule session skill list` gives for the session `id`. */
const listSessionSkills = async (id: string): Promise<ReadonlyArray<string>> =>
  readSkillNames(await runLoggedInCli(["session", "skill", "list", id, "--json"]));

/**
 * Lists the names of the skills `hercule session skill preview` gives for a
 * new Thread on the controller's runner that opens the repository `resourceId`.
 */
const previewThreadSkills = async (resourceId: string): Promise<ReadonlyArray<string>> =>
  readSkillNames(
    await runLoggedInCli([
      "session",
      "skill",
      "preview",
      "--runner",
      runnerId,
      "--resource",
      resourceId,
      "--json",
    ]),
  );

/**
 * Returns the names of the library skills in the session skills folder of a
 * session's current start, and then the repository skills staged in it as
 * `<checkout>:<skill>`, each part sorted.
 */
const listSessionFolderSkills = (sessionId: string): ReadonlyArray<string> => {
  const folder = findSessionSkillsFolder(state.home, sessionId);
  const repositories = join(folder, "repositories");
  const staged = existsSync(repositories)
    ? readdirSync(repositories)
        .sort()
        .flatMap((checkout) =>
          readdirSync(join(repositories, checkout, "skills"))
            .sort()
            .map((skill) => `${checkout}:${skill}`),
        )
    : [];
  return [...readdirSync(join(folder, "skills")).sort(), ...staged];
};

beforeAll(async () => {
  if (!wanted) return;
  binary = findCompiledBinary();
  world = createTemporaryHome();
  gitHome = createTemporaryHome("[init]\n\tdefaultBranch = main\n");
  // The Hercule Home sits inside the `HOME`, as `~/.hercule` does in a real
  // install. A workspace is made under the Hercule Home, so the walk up from a
  // harness's working directory reaches `<HOME>/.claude/skills`, which is the
  // way a user's own skills used to reach a Thread (#369).
  const hercule = join(gitHome.home, ".hercule");
  mkdirSync(hercule);
  state = { home: hercule, remove: () => deleteMasterKeyItem(hercule) };

  // The runner clones `https://hercule.test/acme/<name>` from `remotes/<name>`.
  appendFileSync(
    join(gitHome.home, ".gitconfig"),
    `[url "file://${join(world.home, "remotes")}/"]\n\tinsteadOf = ${REMOTE_PREFIX}\n`,
  );
  // The user's own skills, in the two folders a harness reads them from.
  writeSkill(join(gitHome.home, ".claude", "skills"), "user-skill", USER_SKILL_WORD);
  writeSkill(join(gitHome.home, ".agents", "skills"), "user-skill", USER_SKILL_WORD);

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
    apiKeyName: "e2e-repository-skills",
  });
  libraryFixture = createSkillsFolder({ implement: IMPLEMENT_WORD });
  reviewFixture = createSkillsFolder({ review: REVIEW_WORD });

  runnerId = await waitForEnrolledRunner({ home: state.home, binary });
  await createRepository("shop", [
    [".claude/skills", "from-claude", FROM_CLAUDE_WORD],
    [".agents/skills", "from-agents", FROM_AGENTS_WORD],
  ]);
  await createRepository("api", [[".agents/skills", "release", RELEASE_WORD]]);
  await createRepository("web", [[".agents/skills", "release", RELEASE_WORD]]);
  // Provisioned once for all harnesses. The workspace existing also shows the
  // runner's git read `gitHome`, so its `HOME` is the one holding `user-skill`.
  await provisionMainWorkspace(readResourceId("shop"));
}, LOGIN_DEADLINE_MS * 3);

afterAll(async () => {
  if (started.length > 0) await stopSessions({ home: state.home, binary, ids: started });
  await controller?.stop().catch(() => -1);
  state?.remove();
  world?.remove();
  gitHome?.remove();
  for (const folder of [libraryFixture, reviewFixture]) {
    if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  }
}, 60_000);

// Each harness is passed with its label first, because `%s` prints a label
// without the quotes that `$label` would add.
describe.skipIf(!wanted).each(LIVE_HARNESSES.map((harness) => [harness.label, harness] as const))(
  "the repository skills in a %s Thread",
  (_label, harness) => {
    const skipReason = harness.findSkipReason();
    let prepared: PreparedHarness | undefined;

    beforeAll(async () => {
      if (skipReason !== undefined) return;
      prepared = await prepare(harness);
    }, LOGIN_DEADLINE_MS + 30_000);

    // The first case imports `review`, which the next cases must not see in
    // the library their Threads start with.
    beforeEach(async () => {
      if (skipReason !== undefined) return;
      await resetSkillLibrary({ home: state.home, binary, fixture: libraryFixture });
    }, 60_000);

    it(
      "runs a library skill and one from .claude/skills and .agents/skills, and lists a library skill imported later only for a draft and after a resume",
      async (ctx) => {
        if (prepared === undefined) {
          ctx.skip(skipReason);
          return;
        }
        const shop = readResourceId("shop");
        const workspace = { kind: "primary", resourceId: shop };
        const expectedAtStart = ["implement", "shop:from-agents", "shop:from-claude"];

        const id = await startThread(
          prepared,
          workspace,
          harness.invokeRepositorySkill("shop", "from-claude"),
        );
        let rows = await waitForTurnCount(id, 1);
        expect(collectAssistantText(rows), JSON.stringify(rows)).toContain(FROM_CLAUDE_WORD);

        let turn = await completeTurn(
          id,
          harness.invokeRepositorySkill("shop", "from-agents"),
          2,
          rows,
        );
        expect(turn.text, JSON.stringify(turn.rows)).toContain(FROM_AGENTS_WORD);
        rows = turn.rows;

        turn = await completeTurn(id, harness.invokeSkill("implement"), 3, rows);
        expect(turn.text, JSON.stringify(turn.rows)).toContain(IMPLEMENT_WORD);
        rows = turn.rows;

        expect(await listSessionSkills(id)).toEqual(expectedAtStart);
        expect(listSessionFolderSkills(id)).toEqual(expectedAtStart);

        // A library skill imported after the start is not on this session's
        // disk, so it is not in its list. A draft Thread would get it.
        const imported = await runLoggedInCli(["skill", "import", reviewFixture]);
        expect(imported.code, `${imported.stdout}\n${imported.stderr}`).toBe(0);
        expect(await listSessionSkills(id)).toEqual(expectedAtStart);
        expect(await previewThreadSkills(shop)).toEqual([
          "implement",
          "review",
          "shop:from-agents",
          "shop:from-claude",
        ]);

        // A resume is a new start, so it gets the library as it is now.
        const stopped = await runLoggedInCli(["session", "stop", id]);
        expect(stopped.code, `${stopped.stdout}\n${stopped.stderr}`).toBe(0);
        await waitForExit({ home: state.home, binary, id, timeoutMs: TURN_DEADLINE_MS });
        turn = await completeTurn(id, harness.invokeSkill("review"), 4, rows);
        expect(turn.text, JSON.stringify(turn.rows)).toContain(REVIEW_WORD);
        const expectedAfterResume = ["implement", "review", "shop:from-agents", "shop:from-claude"];
        expect(await listSessionSkills(id)).toEqual(expectedAfterResume);
        expect(listSessionFolderSkills(id)).toEqual(expectedAfterResume);
      },
      TURN_DEADLINE_MS * 6 + 60_000,
    );

    it(
      "lists the same skill name of two repositories as two prefixed names, and does not load the user's own skills",
      async (ctx) => {
        if (prepared === undefined) {
          ctx.skip(skipReason);
          return;
        }
        const expected = ["implement", "api:release", "web:release"];

        const id = await startThread(
          prepared,
          {
            kind: "ephemeral",
            checkouts: [
              { resourceId: readResourceId("api") },
              { resourceId: readResourceId("web") },
            ],
          },
          harness.invokeSkill("user-skill"),
        );
        const rows = await waitForTurnCount(id, 1);

        expect(await listSessionSkills(id)).toEqual(expected);
        expect(listSessionFolderSkills(id)).toEqual(expected);
        expect(collectAssistantText(rows), JSON.stringify(rows)).not.toContain(USER_SKILL_WORD);
      },
      TURN_DEADLINE_MS + 60_000,
    );

    it(
      "does not load the user's own skills in a workspace with no checkout",
      async (ctx) => {
        if (prepared === undefined) {
          ctx.skip(skipReason);
          return;
        }
        // An empty list of checkouts makes a scratch workspace, a directory
        // with no repository in it.
        const id = await startThread(
          prepared,
          { kind: "ephemeral", checkouts: [] },
          harness.invokeSkill("user-skill"),
        );
        const rows = await waitForTurnCount(id, 1);

        expect(await listSessionSkills(id)).toEqual(["implement"]);
        expect(listSessionFolderSkills(id)).toEqual(["implement"]);
        expect(collectAssistantText(rows), JSON.stringify(rows)).not.toContain(USER_SKILL_WORD);
      },
      TURN_DEADLINE_MS + 60_000,
    );
  },
);
