/**
 * Tests resources, workspaces and checkouts through the shipped program: a repo
 * recorded, its main workspace created on the controller's runner, and a
 * thread's worktree made from the same managed repository.
 *
 * Nothing here contacts GitHub. The repository is a bare one in a temporary
 * directory, and the resource refers to it the way a user would - `https://` -
 * because the controller rejects a `file://` remote outright (`isClonableRemote`
 * in `apps/controller/src/resources/remote.ts` takes `https://` and git's
 * `user@host:owner/repo` and nothing else).
 *
 * Both cases start from the fetched remote, so git's own
 * `url.<base>.insteadOf` is written into the machine's `HOME` first, which
 * makes the https URL resolve to the bare repository next to it. Managed
 * storage is selected explicitly here, so the user's own checkout stays
 * untouched. Existing-checkout attachment is tested separately.
 *
 * The worktree case is the only one that needs a session, and no fake provider
 * ships, so it runs a real one and is opt-in under `HERCULE_LIVE_SESSION_TEST`
 * like `e2e/session.test.ts`. The rest run everywhere.
 *
 * The suite is in vitest's `binary` project, so `pnpm test:binary` runs it and
 * `pnpm test` does not. It requires the built release binary, so the checks
 * cover the program a user installs.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Workspace } from "../packages/contract/src/index";
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

let state: TemporaryHome;
/** Holds the bare remote and the user's own checkout of it. */
let world: TemporaryHome;
const binary = findReleaseBinary();

/** The URL the resource uses for the repository; it resolves to `bare` through `HOME`. */
const REMOTE = "https://hercule.test/acme/web";

/**
 * Opt-in, like `e2e/session.test.ts`: the worktree case is the only one here
 * that needs a session, no fake provider ships, and a real one spends the
 * developer's tokens.
 */
const live = isLiveSessionTestEnabled();

let bare: string;
let checkout: string;
/** The `HOME` both the machine's git and the test's own git read, and nothing else. */
let gitHome: TemporaryHome;

let controller: Controller;
let url: string;
let apiKey: string;
/** The runner the controller starts for itself, where every workspace is made. */
let runnerId: string;

/** How long a clone, a fetch and a worktree may take on a cold machine. */
const PROVISION_DEADLINE_MS = 60_000;

const runLoggedInCli = (args: ReadonlyArray<string>, stdin?: string): Promise<Ran> =>
  runCli(args, { home: state.home, binary, stdin });

/**
 * Parses a command's JSON output. Fails with the command's own output, rather
 * than later on an undefined field.
 */
const expectJsonOutput = <A>(ran: Ran): A => {
  expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(0);
  return parseJsonOutput(ran) as A;
};

/** Runs git on the test's own files, with none of the developer's configuration. */
const runGit = (args: ReadonlyArray<string>, cwd: string): string => {
  const ran = Bun.spawnSync(["git", ...args], { cwd, env: buildGitEnv(gitHome.home) });
  if (ran.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} in ${cwd}:\n${ran.stderr.toString()}`);
  }
  return ran.stdout.toString().trim();
};

interface Resource {
  readonly id: string;
  readonly kind: string;
  readonly remote: string | null;
  readonly canonicalRemote: string | null;
}

interface Session {
  readonly id: string;
  readonly status: string;
  readonly workspaceId: string | null;
}

interface Snapshot {
  readonly auth: { readonly status: string };
}

/**
 * Reads a workspace until it is no longer provisioning, and returns it. Throws
 * when it is still provisioning at the deadline.
 */
const waitForSettledWorkspace = async (id: string): Promise<Workspace> => {
  const deadline = Date.now() + PROVISION_DEADLINE_MS;
  for (;;) {
    const workspace = expectJsonOutput<Workspace>(
      await runLoggedInCli(["workspace", "read", id, "--json"]),
    );
    if (workspace.status !== "provisioning") return workspace;
    if (Date.now() > deadline) {
      throw new Error(`${id} was still provisioning after ${String(PROVISION_DEADLINE_MS)}ms`);
    }
    await Bun.sleep(250);
  }
};

/**
 * Checks whether any machine has reported a logged-in provider instance. A
 * thread cannot be spawned without one - `session.spawn` resolves an
 * instance, a machine and a model catalog before it writes anything - and this
 * build has no provider that works without a vendor login, so the worktree
 * case is skipped with a message.
 */
const isAnyInstanceLoggedIn = async (): Promise<boolean> => {
  const response = await fetch(`${url}/api/v1/providers`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const body = await response.text();
  expect(response.status, body).toBe(200);
  return (JSON.parse(body) as ReadonlyArray<{ snapshots: ReadonlyArray<Snapshot> }>).some((one) =>
    one.snapshots.some((snapshot) => snapshot.auth.status === "ok"),
  );
};

beforeAll(async () => {
  state = createTemporaryHome();
  world = createTemporaryHome();
  bare = join(world.home, "remote.git");
  checkout = join(world.home, "web");
  gitHome = createTemporaryHome("[init]\n\tdefaultBranch = main\n");

  // A bare repository with one commit on `main`, and the user's own working
  // copy of it next to it, which Hercule must never touch.
  runGit(["init", "--bare", "--initial-branch=main", bare], world.home);
  const seed = join(world.home, "seed");
  mkdirSync(seed);
  runGit(["init", "--initial-branch=main"], seed);
  writeFileSync(join(seed, "README.md"), "hercule e2e\n");
  runGit(["add", "README.md"], seed);
  runGit(["commit", "-m", "one commit"], seed);
  runGit(["push", bare, "main"], seed);
  runGit(["clone", "--", bare, checkout], world.home);
  runGit(["remote", "set-url", "origin", REMOTE], checkout);
  // The machine clones and fetches the https URL, which git's own rewrite
  // resolves to the bare repository next to it.
  appendFileSync(
    join(gitHome.home, ".gitconfig"),
    `[url "file://${bare}"]\n\tinsteadOf = ${REMOTE}\n`,
  );

  controller = await startController({
    home: state.home,
    binary,
    // The machine's git reads this `HOME`, and nothing of the developer's.
    env: { HOME: gitHome.home, GIT_CONFIG_NOSYSTEM: "1" },
  });
  url = controller.url;

  const completed = await completeSetup({ home: state.home, url, binary });
  expect(completed.code, `${completed.stdout}\n${completed.stderr}`).toBe(0);

  const login = await runCli(
    ["login", url, "--username", USERNAME, "--password-stdin", "--name", "e2e-workspace"],
    { home: state.home, binary, stdin: PASSWORD },
  );
  expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);
  apiKey = readApiKey(state.home);

  // Wait for the controller's own machine to connect: a workspace is made on
  // a machine, so there is nothing to test until one is there.
  const deadline = Date.now() + 30_000;
  for (;;) {
    const fleet = expectJsonOutput<{ items: ReadonlyArray<{ id: string; connectivity: string }> }>(
      await runLoggedInCli(["runner", "list", "--json"]),
    ).items.filter((one) => one.connectivity === "online");
    if (fleet.length > 0) {
      runnerId = fleet[0]!.id;
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(`no machine came online:\n${controller.output()}`);
    }
    await Bun.sleep(250);
  }
}, 120_000);

afterAll(async () => {
  await controller?.stop().catch(() => -1);
  state?.remove();
  world?.remove();
  gitHome?.remove();
});

describe("a repo, its main workspace and a thread's worktree, through the CLI", () => {
  /** The resource the whole suite uses, recorded by the first case. */
  let resourceId = "";

  it("records the repo under the canonical form of the remote it was given", async () => {
    const resource = expectJsonOutput<Resource>(
      await runLoggedInCli(["resource", "create", "--kind", "repo", "--remote", REMOTE, "--json"]),
    );
    expect(resource.kind).toBe("repo");
    expect(resource.remote).toBe(REMOTE);
    // The identity a second spelling of this repository would conflict with:
    // the scheme and the case are not part of it.
    expect(resource.canonicalRemote).toBe("hercule.test/acme/web");
    resourceId = resource.id;
  }, 30_000);

  it("creates a separate main worktree without touching the user's own checkout", async () => {
    const before = runGit(["status", "--porcelain=v1", "--untracked-files=all"], checkout);
    const head = runGit(["rev-parse", "HEAD"], checkout);

    const answered = expectJsonOutput<Workspace>(
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
    // The command returns before the machine has done anything: the machine
    // does the provisioning, and the caller polls the row.
    expect(answered.status).toBe("provisioning");
    expect(answered.kind).toBe("primary");
    expect(answered.runnerId).toBe(runnerId);

    const workspace = await waitForSettledWorkspace(answered.id);
    expect(workspace.status, workspace.message ?? "").toBe("ready");
    expect(workspace.checkouts).toHaveLength(1);
    const [only] = workspace.checkouts;
    expect(only!.resourceId).toBe(resourceId);
    expect(only!.form).toBe("worktree");
    expect(only!.branch).not.toBe("main");
    expect(only!.branches).toContain(only!.branch);
    expect(only!.branches).toContain("main");
    expect(only!.headCommit).toBe(head);
    expect(only!.baseCommit).toBe(head);

    // The user's own checkout of this repository does not belong to Hercule
    // and is never read or written: it is exactly as it was, on the same
    // commit.
    expect(runGit(["status", "--porcelain=v1", "--untracked-files=all"], checkout)).toBe(before);
    expect(runGit(["rev-parse", "HEAD"], checkout)).toBe(head);
  }, 120_000);

  it("rejects a second main workspace of the same repo on the same machine", async () => {
    const ran = await runLoggedInCli([
      "workspace",
      "provision",
      "--resource",
      resourceId,
      "--runner",
      runnerId,
      "--json",
    ]);
    expect(ran.code).not.toBe(0);
    expect(`${ran.stdout}${ran.stderr}`).toMatch(/conflict|already/i);
  }, 30_000);

  it.skipIf(!live)(
    "gives a thread its own worktree, on a branch named after the session",
    async (ctx) => {
      if (!(await isAnyInstanceLoggedIn())) {
        ctx.skip(
          "no machine reports a logged-in provider instance. `session.spawn` resolves an " +
            "instance, a machine and a model catalog before it writes anything, and this build " +
            "carries no provider that answers without a vendor login, so an ephemeral workspace " +
            "cannot be made here. Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN to run it.",
        );
        return;
      }

      const spawned = expectJsonOutput<Session>(
        await runLoggedInCli(
          [
            "session",
            "spawn",
            "--runner",
            runnerId,
            "--workspace",
            JSON.stringify({
              kind: "ephemeral",
              checkouts: [{ resourceId, baseBranch: "main" }],
            }),
            "--json",
          ],
          "Say nothing and stop.",
        ),
      );
      expect(spawned.workspaceId).not.toBeNull();

      const workspace = await waitForSettledWorkspace(spawned.workspaceId!);
      expect(workspace.status, workspace.message ?? "").toBe("ready");
      expect(workspace.kind).toBe("ephemeral");
      const [only] = workspace.checkouts;
      expect(only!.form).toBe("worktree");
      // The thread's branch belongs to the session alone: the end of the
      // session id tells two threads in one repo apart.
      expect(only!.branch).toBe(`hercule/thread-${spawned.id.slice(-8)}`);
      // It starts where `main` is, so the worktree came from the cache the
      // clone filled rather than from a repository nobody could reach.
      expect(only!.branches).toContain(only!.branch!);
      // The workspace records which thread is in it: the sidebar groups by
      // `sessionIds`, and the reaper reads it before disposing anything.
      expect(workspace.sessionIds).toContain(spawned.id);

      // The thread belongs to the test, so it must not outlive it.
      const stopped = await runLoggedInCli(["session", "stop", spawned.id, "--json"]);
      expect(stopped.code, `${stopped.stdout}\n${stopped.stderr}`).toBe(0);
    },
    180_000,
  );
});
