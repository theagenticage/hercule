/**
 * Tests against real GitHub: a machine that holds no git credential of its own
 * pushes to a private repository with a token that is never written to its
 * disk.
 *
 * Opt-in, like `e2e/session.test.ts`: it uses a real account and leaves a
 * branch there until it deletes it, so it runs only with
 * `HERCULE_E2E_GITHUB_TOKEN` and `HERCULE_E2E_GITHUB_REPO` (`owner/name`) set.
 *
 * The controller runs under a `HOME` that holds no `.gitconfig` of the
 * developer's, no `.git-credentials` and no `gh` login, so every credential in
 * this suite can only have come from the Connection through Hercule's own helper.
 *
 * Two things are tested without spending a model token. The machine's own
 * clone of the private repository tests reading: `workspace.provision` cannot
 * finish without a credential, so a workspace whose status is `ready` is a
 * clone that authenticated. The push tests writing, and the test runs it
 * rather than an agent, for the reason given at `pushed` below.
 *
 * The second test is the main one and costs a model turn, so it also needs
 * `HERCULE_LIVE_SESSION_TEST`: a real Claude Code thread in a worktree of the
 * same repository runs `git commit` and `git push` itself, and the branch it
 * leaves on GitHub is read back and deleted.
 *
 * The third test runs a workflow whose `git.commit` and `git.push` steps run
 * in a workspace made for the run, so the push authenticates with the claim
 * the machine's git sends while it runs a workspace step. It costs no model
 * token.
 */
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PASSWORD,
  USERNAME,
  runCli,
  completeSetup,
  startController,
  type Controller,
  type Ran,
} from "../scripts/controller-process";
import {
  readApiKey,
  buildGitEnv,
  parseJsonOutput,
  isLiveSessionTestEnabled,
  findReleaseBinary,
  createTemporaryHome,
  type TemporaryHome,
} from "./harness";

const token = process.env["HERCULE_E2E_GITHUB_TOKEN"];
const repo = process.env["HERCULE_E2E_GITHUB_REPO"];
const wanted = token !== undefined && repo !== undefined;

/**
 * The main test - an agent pushing with Hercule's credential - costs a real
 * Claude Code turn, so it is opt-in on top of the token, like
 * `e2e/session.test.ts`: a thread of its own, in a worktree of the same
 * repository, running `git push` itself.
 */
const live = wanted && isLiveSessionTestEnabled();

let state: TemporaryHome;
let world: TemporaryHome;
const binary = findReleaseBinary();

/** The `HOME` both the machine's git and the test's own git read, and nothing else. */
let gitHome: TemporaryHome;
/** The repository the push is made from: an empty one, with the remote configured. */
let sender: string;

/** The branch this run creates on GitHub, and deletes again. */
const branch = `hercule-e2e/${Math.random().toString(16).slice(2, 10)}`;

/**
 * The branch the thread pushes, known only once its session has an id, and
 * deleted by the suite whether the case reached its own delete or not.
 */
let threadBranch: string | undefined;

/** The branch the workflow run pushes, deleted by the suite like the thread's. */
let runBranch: string | undefined;

const remote = `https://github.com/${repo ?? ""}`;

let controller: Controller;
let url: string;
/** The socket the machine's helper listens on: `<home>/runner/<storage>/daemon.sock`. */
let socketPath: string;

/** Long enough for a clone of a small repository over the network. */
const PROVISION_DEADLINE_MS = 120_000;

/** Long enough for a clone, a commit and a push over the network. */
const RUN_DEADLINE_MS = 180_000;

/** Long enough for a cold harness to start, run two git commands and reply. */
const TURN_DEADLINE_MS = 300_000;

const runLoggedInCli = (args: ReadonlyArray<string>, stdin?: string): Promise<Ran> =>
  runCli(args, { home: state.home, binary, stdin });

const expectJsonOutput = <A>(ran: Ran): A => {
  expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(0);
  return parseJsonOutput(ran) as A;
};

interface Workspace {
  readonly id: string;
  readonly status: string;
  readonly message: string | null;
  readonly checkouts: ReadonlyArray<{ readonly branch: string | null }>;
}

/** Calls GitHub as the token's owner. Only used to check and undo what the push did. */
const fetchGitHub = (path: string, init?: RequestInit): Promise<Response> =>
  fetch(`https://api.github.com/repos/${repo!}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token!}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });

/**
 * Deletes a branch from the account, and throws when it cannot: a branch this
 * run created and left behind puts the account in a state the next run does
 * not expect. `404` and `422` are GitHub's responses for a ref that does not
 * exist, which is the state after a case deleted its own branch.
 */
const removeBranch = async (name: string): Promise<void> => {
  const response = await fetchGitHub(`/git/refs/heads/${name}`, { method: "DELETE" });
  if (response.status === 204 || response.status === 404 || response.status === 422) return;
  throw new Error(
    `${name} is still on the account: ${String(response.status)} ${await response.text()}`,
  );
};

/**
 * Lists every regular file under a directory, here rather than with `grep -r`.
 * A live Hercule Home holds the runner daemon's Unix socket, and grep run on a
 * directory containing one exits with `2` - failure - however many matches it
 * also printed, which looks exactly like a broken search. The files are what
 * is searched, so the files are passed to grep.
 */
const listRegularFiles = (where: string): ReadonlyArray<string> =>
  readdirSync(where, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));

/**
 * Finds every file under a directory that contains a string, and returns
 * grep's exit code with it: `0` found something, `1` found nothing, anything
 * else means grep failed. `--binary-files=text` is essential: the database is
 * where a token would be, and a grep that skipped it as binary would find
 * nothing and report that as clean.
 */
const findFilesHolding = (
  needle: string,
  where: string,
): { readonly code: number; readonly files: string } => {
  const files = listRegularFiles(where);
  // Nothing to search is not the same as "found nothing": it means the search
  // was pointed at an empty directory, which the check below catches.
  if (files.length === 0) return { code: 1, files: "" };
  const ran = Bun.spawnSync([
    "grep",
    "-l",
    "--binary-files=text",
    "--devices=skip",
    "--",
    needle,
    ...files,
  ]);
  return { code: ran.exitCode, files: ran.stdout.toString().trim() };
};

/**
 * Checks that no file under the Hercule Home contains the token - but only
 * after showing that the search works at all, by finding the API key the
 * login wrote into that same home. Otherwise a grep that matched nothing,
 * because it searched the wrong directory or skipped the database as binary,
 * would look like a clean result.
 */
const expectNoTokenIn = (where: string): void => {
  const control = findFilesHolding(readApiKey(where), where);
  expect(control.code, "the search found nothing it was known to be able to find").toBe(0);
  expect(control.files).toContain(join(where, "credentials.json"));

  const held = findFilesHolding(token!, where);
  expect(held.files, "these files under the Hercule Home hold the token").toBe("");
  expect(held.code, "the search failed rather than finding nothing").toBe(1);
};

/** The helper command as the machine writes it: the binary, or Bun and the dispatcher. */
const helperCommand = (() => {
  const built = findReleaseBinary();
  return built === undefined
    ? `${process.execPath} ${join(import.meta.dirname, "..", "packages/hercule/src/main.ts")} git-credential`
    : `${built} git-credential`;
})();

/**
 * Runs git with the environment the machine gives a workspace: Hercule's
 * helper ahead of any helper the machine might otherwise have, the socket it
 * listens on, and the claim that identifies who is asking. Built here rather
 * than imported, because the environment the runner builds is what is being
 * tested.
 */
const runGitWithHelper = (
  args: ReadonlyArray<string>,
  cwd: string,
  claim: Record<string, string>,
): { readonly code: number; readonly output: string } => {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    // The empty helper first: git reads helpers in order, and an inherited
    // helper would otherwise reply with the machine owner's credential.
    ["credential.helper", ""],
    ["credential.helper", helperCommand],
    ["credential.useHttpPath", "true"],
    ["user.name", "Hercule E2E"],
    ["user.email", "e2e@hercule.test"],
  ];
  const ran = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...buildGitEnv(gitHome.home),
      HERCULE_RUNNER_SOCKET: socketPath,
      GIT_CONFIG_COUNT: String(pairs.length),
      ...Object.fromEntries(
        pairs.flatMap((pair, at) => [
          [`GIT_CONFIG_KEY_${String(at)}`, pair[0]],
          [`GIT_CONFIG_VALUE_${String(at)}`, pair[1]],
        ]),
      ),
      ...claim,
    },
  });
  return {
    code: ran.exitCode,
    output: `${ran.stdout.toString()}${ran.stderr.toString()}`,
  };
};

interface Session {
  readonly id: string;
  readonly status: string;
  readonly workspaceId: string | null;
}

/** Checks whether any machine reports a logged-in claude-code instance to spawn on. */
const isClaudeLoggedIn = async (): Promise<boolean> => {
  const response = await fetch(`${url}/api/v1/providers`, {
    headers: { authorization: `Bearer ${readApiKey(state.home)}` },
  });
  const body = await response.text();
  expect(response.status, body).toBe(200);
  return (
    JSON.parse(body) as ReadonlyArray<{
      providerId: string;
      snapshots: ReadonlyArray<{ auth: { status: string } }>;
    }>
  ).some(
    (one) =>
      one.providerId === "claude-code" &&
      one.snapshots.some((snapshot) => snapshot.auth.status === "ok"),
  );
};

interface Run {
  readonly status: string;
  readonly steps: ReadonlyArray<{
    readonly stepId: string;
    readonly status: string;
    readonly output?: Record<string, unknown>;
  }>;
}

const readRun = async (id: string): Promise<Run> =>
  expectJsonOutput<Run>(await runLoggedInCli(["run", "read", id, "--json"]));

const readWorkspace = async (id: string): Promise<Workspace> =>
  expectJsonOutput<Workspace>(await runLoggedInCli(["workspace", "read", id, "--json"]));

beforeAll(async () => {
  if (!wanted) return;
  state = createTemporaryHome();
  world = createTemporaryHome();
  gitHome = createTemporaryHome("");
  sender = join(world.home, "sender");

  controller = await startController({
    home: state.home,
    binary,
    // None of the developer's git configuration, and no system one either:
    // whatever authenticates here has to come from Hercule.
    env: { HOME: gitHome.home, GIT_CONFIG_NOSYSTEM: "1" },
  });
  url = controller.url;

  const completed = await completeSetup({ home: state.home, url, binary });
  expect(completed.code, `${completed.stdout}\n${completed.stderr}`).toBe(0);

  const login = await runCli(
    ["login", url, "--username", USERNAME, "--password-stdin", "--name", "e2e-github"],
    { home: state.home, binary, stdin: PASSWORD },
  );
  expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);

  // The repository the push comes from. It is the test's own: the machine's
  // checkout does not exist until provisioning has finished, and outside a
  // workspace step the claim the helper accepts is only valid until then.
  mkdirSync(sender);
  for (const args of [
    ["init", "--initial-branch=main", "."],
    ["remote", "add", "origin", remote],
    ["commit", "--allow-empty", "-m", `hercule e2e ${branch}`],
  ]) {
    const ran = Bun.spawnSync(["git", ...args], { cwd: sender, env: buildGitEnv(gitHome.home) });
    expect(ran.exitCode, ran.stderr.toString()).toBe(0);
  }
}, 180_000);

afterAll(async () => {
  if (wanted) {
    // Whatever the run did, the account is left as it was.
    await removeBranch(branch);
    if (threadBranch !== undefined) await removeBranch(threadBranch);
    if (runBranch !== undefined) await removeBranch(runBranch);
  }
  await controller?.stop().catch(() => -1);
  state?.remove();
  world?.remove();
  gitHome?.remove();
});

describe.skipIf(!wanted)("pushes to GitHub with only Hercule's credential", () => {
  /** The repo and the machine the first case records, which the live case uses again. */
  let resourceId = "";
  let machineId = "";

  it("clones the private repo, pushes a branch with the workspace's own env, and keeps no token", async () => {
    // The account, from the token alone. Creating the connection asks GitHub
    // who the token belongs to, so a connection that exists has a working
    // token.
    const connection = expectJsonOutput<{ id: string; displayName: string }>(
      await runLoggedInCli(
        [
          "connection",
          "create",
          "--type",
          "github/github",
          "--label",
          "e2e",
          "--topic",
          "e2e",
          "--json",
        ],
        JSON.stringify({ pat: token }),
      ),
    );
    expect(connection.displayName.length).toBeGreaterThan(0);

    const resource = expectJsonOutput<{ id: string; canonicalRemote: string | null }>(
      await runLoggedInCli([
        "resource",
        "create",
        "--kind",
        "repo",
        "--remote",
        remote,
        "--connection",
        connection.id,
        "--json",
      ]),
    );
    expect(resource.canonicalRemote).toBe(`github.com/${repo!.toLowerCase()}`);
    resourceId = resource.id;

    const runnerId = expectJsonOutput<{
      items: ReadonlyArray<{ id: string; connectivity: string }>;
    }>(await runLoggedInCli(["runner", "list", "--connectivity", "online", "--json"])).items[0]?.id;
    expect(runnerId, `no machine came online:\n${controller.output()}`).toBeDefined();
    machineId = runnerId!;

    // The socket the helper listens on for this machine. The storage
    // directory gets a random name when the machine joins, so it is read
    // rather than guessed.
    const pin = JSON.parse(readFileSync(join(state.home, "runner", "runner.json"), "utf8")) as {
      readonly storageDirectory: string;
    };
    socketPath = join(state.home, "runner", pin.storageDirectory, "daemon.sock");

    // Requested over HTTP rather than by starting another process: what
    // follows has to happen while this workspace is still being made.
    const answered = (await (
      await fetch(`${url}/api/v1/workspaces`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${readApiKey(state.home)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ resourceId: resource.id, runnerId }),
      })
    ).json()) as Workspace;
    expect(answered.status, JSON.stringify(answered)).toBe("provisioning");

    /**
     * The push, with the claim the machine's own git sends while it is making
     * a workspace.
     *
     * A session's claim is its Session Token, which the controller stores
     * hashed and gives to nobody but the machine, so no harness can present
     * it. The workspace claim is one a test can hold, and it goes through the
     * same helper, the same socket and the same controller check. The live
     * case below covers an agent running `git push` itself.
     *
     * Outside a workspace step, the workspace claim is only valid while the
     * workspace is `provisioning`, which lasts as long as the clone takes, so
     * the push is retried for as long as that is true, rather than tried
     * once in a window nobody measured.
     */
    const window = Date.now() + PROVISION_DEADLINE_MS;
    // The loop ends only when the push succeeds; every other outcome throws
    // with git's output.
    for (;;) {
      const pushed = runGitWithHelper(
        ["push", "-u", "origin", `HEAD:refs/heads/${branch}`],
        sender,
        {
          HERCULE_RUNNER_WORKSPACE: answered.id,
        },
      );
      if (pushed.code === 0) break;
      const now = await readWorkspace(answered.id);
      if (now.status !== "provisioning") {
        throw new Error(
          `the push did not succeed while the workspace was being made; its status is ${now.status}` +
            `${now.message === null ? "" : ` (${now.message})`} and git said:\n${pushed.output}`,
        );
      }
      if (Date.now() > window) {
        throw new Error(
          `the push did not succeed in ${String(PROVISION_DEADLINE_MS)}ms, with the workspace still ` +
            `being made; git said:\n${pushed.output}`,
        );
      }
      // Slow enough that the clone gets the machine's time rather than this loop.
      await Bun.sleep(500);
    }

    // The clone the machine was making needed a credential of its own, so a
    // ready workspace proves reading works through the same path.
    const deadline = Date.now() + PROVISION_DEADLINE_MS;
    let workspace = await readWorkspace(answered.id);
    while (workspace.status === "provisioning" && Date.now() < deadline) {
      await Bun.sleep(500);
      workspace = await readWorkspace(answered.id);
    }
    expect(workspace.status, workspace.message ?? "").toBe("ready");
    expect(workspace.checkouts[0]?.branch).not.toBeNull();

    // The branch is on GitHub, and it is the commit this run made.
    const ref = await fetchGitHub(`/git/ref/heads/${branch}`);
    const body = await ref.text();
    expect(ref.status, body).toBe(200);
    expect((JSON.parse(body) as { object: { sha: string } }).object.sha).toBe(
      Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: sender }).stdout.toString().trim(),
    );

    const deleted = await fetchGitHub(`/git/refs/heads/${branch}`, { method: "DELETE" });
    expect(deleted.status, await deleted.text()).toBe(204);

    // Nothing under the Hercule Home contains the token: not the database, not
    // a log, not a git config the machine wrote.
    expectNoTokenIn(state.home);
  }, 300_000);
  it.skipIf(!live)(
    "a real thread pushes a branch GitHub accepted on the credential the daemon answered, " +
      "and the home is left holding no token",
    async (ctx) => {
      if (!(await isClaudeLoggedIn())) {
        ctx.skip(
          "no machine reports a logged-in claude-code instance. A session runs against the " +
            "instance's own CLAUDE_CONFIG_DIR under this throwaway home, which is empty, so " +
            "this case needs ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN on the environment.",
        );
        return;
      }

      // `full-access` so the agent is not parked on an approval nobody is there
      // to give; this tests the credential, not the permission card.
      const session = expectJsonOutput<Session>(
        await runLoggedInCli(
          [
            "session",
            "spawn",
            "--runner",
            machineId,
            "--access-mode",
            "full-access",
            "--workspace",
            JSON.stringify({ kind: "ephemeral", checkouts: [{ resourceId }] }),
            "--json",
          ],
          "Run exactly this and nothing else: git commit --allow-empty -m 'hercule e2e' && " +
            "git push -u origin HEAD. Then reply done.",
        ),
      );
      expect(session.workspaceId).not.toBeNull();
      // Named after the thread, so the branch checked on GitHub afterwards
      // belongs to this session and nothing else.
      threadBranch = `hercule/thread-${session.id.slice(-8)}`;

      // The thread is stopped whatever happens next: one left running keeps a
      // worktree and, on a real account, keeps spending.
      try {
        // The worktree comes from a clone of the private repository, which
        // tests reading through the same credential path.
        const provisioned = Date.now() + PROVISION_DEADLINE_MS;
        let workspace = await readWorkspace(session.workspaceId!);
        while (workspace.status === "provisioning" && Date.now() < provisioned) {
          await Bun.sleep(500);
          workspace = await readWorkspace(session.workspaceId!);
        }
        expect(workspace.status, workspace.message ?? "").toBe("ready");
        expect(workspace.checkouts[0]?.branch).toBe(threadBranch);

        // The turn is over when the transcript has both its start and its
        // completion; the status alone cannot tell, because a session that has
        // not started its first turn yet is idle too.
        const done = Date.now() + TURN_DEADLINE_MS;
        let tags: ReadonlyArray<string>;
        for (;;) {
          tags = expectJsonOutput<{ items: ReadonlyArray<{ event: { _tag: string } }> }>(
            await runLoggedInCli(["transcript", "read", session.id, "--json", "--all"]),
          ).items.map((row) => row.event._tag);
          if (tags.includes("turn.completed")) break;
          if (Date.now() > done) {
            const read = expectJsonOutput<Session>(
              await runLoggedInCli(["session", "read", session.id, "--json"]),
            );
            throw new Error(
              `the thread never finished a turn; it reads ${read.status} and its transcript holds ` +
                `${tags.join(", ") || "nothing"}`,
            );
          }
          await Bun.sleep(1000);
        }
        // A model really ran: the agent used tools and replied. A branch on
        // GitHub without these would be someone else's push.
        expect(tags, tags.join(", ")).toContain("item.completed");
        expect(tags, tags.join(", ")).toContain("content.delta");

        // The branch is on GitHub, pushed by the agent with a token no file on
        // this machine contains. If the branch is missing, the error includes
        // the transcript.
        const ref = await fetchGitHub(`/git/ref/heads/${threadBranch}`);
        const body = await ref.text();
        if (ref.status !== 200) {
          const transcript = await runLoggedInCli([
            "transcript",
            "read",
            session.id,
            "--json",
            "--all",
          ]);
          throw new Error(
            `no ${threadBranch} on GitHub (${String(ref.status)} ${body}); the thread said:\n` +
              transcript.stdout,
          );
        }

        const deleted = await fetchGitHub(`/git/refs/heads/${threadBranch}`, { method: "DELETE" });
        expect(deleted.status, await deleted.text()).toBe(204);
        threadBranch = undefined;
      } finally {
        const stopped = await runLoggedInCli(["session", "stop", session.id, "--json"]);
        expect(stopped.code, `${stopped.stdout}\n${stopped.stderr}`).toBe(0);
      }

      // The same check as in the case above, now that an agent has used the
      // credential: nothing under the Hercule Home contains the token.
      expectNoTokenIn(state.home);
    },
    PROVISION_DEADLINE_MS + TURN_DEADLINE_MS + 120_000,
  );

  it(
    "a workflow run commits and pushes its branch with git.commit and git.push",
    async () => {
      // The setup command gives the commit something to hold. It is removed
      // again afterwards, so the resource is left as the first case recorded it.
      const updated = await runLoggedInCli([
        "resource",
        "update",
        resourceId,
        "--setup-command",
        "echo from-setup > hercule-e2e.txt",
        "--json",
      ]);
      expect(updated.code, `${updated.stdout}\n${updated.stderr}`).toBe(0);
      try {
        const source = [
          "name: Commit and push to GitHub",
          "workspace:",
          "  kind: ephemeral",
          "  checkouts:",
          `    - resourceId: ${resourceId}`,
          "steps:",
          "  - id: commit",
          "    kind: action",
          "    action: git.commit",
          "    params:",
          "      message: hercule e2e",
          "  - id: push",
          "    kind: action",
          "    action: git.push",
          "edges:",
          "  - from: commit",
          "    to: push",
          "    condition: size(steps.commit.output.sha) == 40",
          "",
        ].join("\n");
        const workflowId = expectJsonOutput<{ workflow: { id: string } }>(
          await runLoggedInCli(["workflow", "create", "--json"], source),
        ).workflow.id;
        const runId = expectJsonOutput<{ runId: string }>(
          await runLoggedInCli(["run", "start", "--workflow", workflowId, "--json"]),
        ).runId;
        runBranch = `hercule/run-${runId}`;

        const deadline = Date.now() + RUN_DEADLINE_MS;
        let run = await readRun(runId);
        while ((run.status === "pending" || run.status === "running") && Date.now() < deadline) {
          await Bun.sleep(500);
          run = await readRun(runId);
        }
        expect(run.status, `${JSON.stringify(run)}\n${controller.output()}`).toBe("completed");
        // The edge's condition held, so the push ran and pushed the commit's sha.
        const sha = run.steps.find((record) => record.stepId === "commit")?.output?.["sha"];
        expect(run.steps.find((record) => record.stepId === "push")).toMatchObject({
          status: "completed",
          output: { branch: runBranch, sha },
        });

        // The run's branch is on GitHub, and it is the commit the run made.
        const ref = await fetchGitHub(`/git/ref/heads/${runBranch}`);
        const body = await ref.text();
        expect(ref.status, body).toBe(200);
        expect((JSON.parse(body) as { object: { sha: string } }).object.sha).toBe(sha);

        const deleted = await fetchGitHub(`/git/refs/heads/${runBranch}`, { method: "DELETE" });
        expect(deleted.status, await deleted.text()).toBe(204);
        runBranch = undefined;
      } finally {
        const reset = await runLoggedInCli([
          "resource",
          "update",
          resourceId,
          "--setup-command",
          "null",
          "--json",
        ]);
        expect(reset.code, `${reset.stdout}\n${reset.stderr}`).toBe(0);
      }

      expectNoTokenIn(state.home);
    },
    RUN_DEADLINE_MS + 60_000,
  );
});
