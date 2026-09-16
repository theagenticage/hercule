/**
 * Resources, workspaces and checkouts out of the shipped program: a repo
 * recorded, its main checkout adopted on the machine the controller runs for
 * itself, and a thread's own worktree made off the cache that adopt seeded.
 *
 * Nothing here reaches GitHub. The repository is a bare one in a temporary
 * directory, and the resource names it the way a user would - `https://` -
 * because the controller refuses a `file://` remote outright (`isClonableRemote`
 * in `apps/controller/src/resources/remote.ts` takes `https://` and git's
 * `user@host:owner/repo` and nothing else).
 *
 * Adopting needs no network: the machine seeds its cache from the folder and
 * only checks that the folder's `origin` names the same repository the resource
 * does. Making a worktree does need one - `ensureCache` fetches the remote every
 * time and a failed fetch fails the workspace - so the worktree case writes
 * git's own `url.<base>.insteadOf` into the machine's `HOME` first, which is
 * what makes the https spelling resolve to the bare repository beside it. It is
 * written late rather than up front because the rewrite also applies to
 * `git remote get-url`, which is the question adopt asks of the folder.
 *
 * The worktree case is the only one that needs a session, and no fake provider
 * ships, so it runs a real one and is opt-in under `HYDRA_LIVE_SESSION_TEST`
 * like `e2e/session.test.ts`. The rest run everywhere.
 *
 * The suite is in vitest's `binary` project, so `pnpm test:binary` is what runs
 * it and `pnpm test` does not. It runs the release binary where one has been
 * built and the dispatcher's source where none has: what it exercises is the
 * controller's own surface, which is the same program either way.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PASSWORD,
  USERNAME,
  apiKeyIn,
  cli,
  completeSetup,
  gitEnv,
  jsonOf,
  liveSessionsAsked,
  releaseBinary,
  startController,
  temporaryHome,
  type Controller,
  type Ran,
} from "./harness";

const state = temporaryHome();
/** The bare remote, the checkout that adopts it, and the `HOME` that joins them. */
const world = temporaryHome();
const binary = releaseBinary();

/** How the resource spells the repository; it resolves to `bare` through `HOME`. */
const REMOTE = "https://hydra.test/acme/web";

/**
 * Opt-in, like `e2e/session.test.ts`: the worktree case is the only one here
 * that needs a session, no fake provider ships, and a real one spends the
 * developer's tokens.
 */
const live = liveSessionsAsked();

const bare = join(world.home, "remote.git");
const checkout = join(world.home, "web");
/** The `HOME` both the machine's git and the test's own git read, and nothing else. */
const gitHome = temporaryHome("[init]\n\tdefaultBranch = main\n");

let controller: Controller;
let url: string;
let apiKey: string;
/** The machine the controller starts for itself, which is where everything lands. */
let runnerId: string;

/** How long a clone, a fetch and a worktree may take on a cold machine. */
const PROVISION_DEADLINE_MS = 60_000;

const hydra = (args: ReadonlyArray<string>, stdin?: string): Promise<Ran> =>
  cli(args, { home: state.home, binary, stdin });

/** Fails with the command's own output rather than on an undefined field. */
const ok = <A>(ran: Ran): A => {
  expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(0);
  return jsonOf(ran) as A;
};

/** git, run by the test on its own files, with nothing of the developer's in it. */
const git = (args: ReadonlyArray<string>, cwd: string): string => {
  const ran = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv(gitHome.home) });
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

interface Checkout {
  readonly resourceId: string;
  readonly form: string;
  readonly branch: string | null;
  readonly branches: ReadonlyArray<string>;
  readonly defaultBranch: string | null;
}

interface Workspace {
  readonly id: string;
  readonly runnerId: string;
  readonly kind: string;
  readonly status: string;
  readonly message: string | null;
  readonly checkouts: ReadonlyArray<Checkout>;
  /** The sessions in it that have not exited. */
  readonly sessionIds: ReadonlyArray<string>;
}

interface Session {
  readonly id: string;
  readonly status: string;
  readonly workspaceId: string | null;
}

interface Snapshot {
  readonly auth: { readonly status: string };
}

/** Reads a workspace back until it stops being made, or says what it still reads. */
const settled = async (id: string): Promise<Workspace> => {
  const deadline = Date.now() + PROVISION_DEADLINE_MS;
  for (;;) {
    const workspace = ok<Workspace>(await hydra(["workspace", "read", id, "--json"]));
    if (workspace.status !== "provisioning") return workspace;
    if (Date.now() > deadline) {
      throw new Error(`${id} was still provisioning after ${String(PROVISION_DEADLINE_MS)}ms`);
    }
    await Bun.sleep(250);
  }
};

/**
 * Whether any machine has reported a logged-in provider instance. A thread is
 * refused without one - `session.spawn` resolves an instance, a machine and a
 * model catalog before it writes anything - and this build carries no provider
 * that answers without a vendor login, so the worktree case says so and skips.
 */
const anyLoggedIn = async (): Promise<boolean> => {
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
  // A bare repository with one commit on `main`, and a working copy of it whose
  // `origin` is spelled the way the resource is: adopting checks that the two
  // name one repository before it touches anything.
  git(["init", "--bare", "--initial-branch=main", bare], world.home);
  const seed = join(world.home, "seed");
  mkdirSync(seed);
  git(["init", "--initial-branch=main"], seed);
  writeFileSync(join(seed, "README.md"), "hydra e2e\n");
  git(["add", "README.md"], seed);
  git(["commit", "-m", "one commit"], seed);
  git(["push", bare, "main"], seed);
  git(["clone", "--", bare, checkout], world.home);
  git(["remote", "set-url", "origin", REMOTE], checkout);

  controller = await startController({
    home: state.home,
    binary,
    // The machine's git reads this `HOME`, and nothing of the developer's.
    env: { HOME: gitHome.home, GIT_CONFIG_NOSYSTEM: "1" },
  });
  url = controller.url;

  const completed = await completeSetup({ home: state.home, url, binary });
  expect(completed.code, `${completed.stdout}\n${completed.stderr}`).toBe(0);

  const login = await cli(
    ["login", url, "--username", USERNAME, "--password-stdin", "--name", "e2e-workspace"],
    { home: state.home, binary, stdin: PASSWORD },
  );
  expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);
  apiKey = apiKeyIn(state.home);

  // The controller's own machine, once it has dialled in: a workspace is made
  // on a machine, so there is nothing to test until one is there.
  const deadline = Date.now() + 30_000;
  for (;;) {
    const fleet = ok<{ items: ReadonlyArray<{ id: string; connectivity: string }> }>(
      await hydra(["runner", "list", "--json"]),
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
  state.remove();
  world.remove();
  gitHome.remove();
});

describe("a repo, its main checkout and a thread's worktree, through the CLI", () => {
  /** The resource the whole suite stands on, recorded by the first case. */
  let resourceId = "";

  it("records the repo under the canonical form of the remote it was spelled with", async () => {
    const resource = ok<Resource>(
      await hydra(["resource", "create", "--kind", "repo", "--remote", REMOTE, "--json"]),
    );
    expect(resource.kind).toBe("repo");
    expect(resource.remote).toBe(REMOTE);
    // What a second spelling of this repository would collide on: the scheme
    // and the case are not part of the identity.
    expect(resource.canonicalRemote).toBe("hydra.test/acme/web");
    resourceId = resource.id;
  }, 30_000);

  it("adopts the folder already on the machine as the main checkout, writing nothing into it", async () => {
    const before = git(["status", "--porcelain=v1", "--untracked-files=all"], checkout);
    const head = git(["rev-parse", "HEAD"], checkout);

    const answered = ok<Workspace>(
      await hydra([
        "workspace",
        "provision",
        "--resource",
        resourceId,
        "--runner",
        runnerId,
        "--path",
        checkout,
        "--json",
      ]),
    );
    // The command answers before the machine has done anything: provisioning is
    // the machine's, and the row is what the caller polls.
    expect(answered.status).toBe("provisioning");
    expect(answered.kind).toBe("primary");
    expect(answered.runnerId).toBe(runnerId);

    const workspace = await settled(answered.id);
    expect(workspace.status, workspace.message ?? "").toBe("ready");
    expect(workspace.checkouts).toHaveLength(1);
    const [only] = workspace.checkouts;
    expect(only!.resourceId).toBe(resourceId);
    expect(only!.form).toBe("clone");
    expect(only!.branch).toBe("main");
    expect(only!.branches).toContain("main");

    // Hydra never touches a primary beyond what the user asked for: the folder
    // reads exactly as it did, on the commit it was on.
    expect(git(["status", "--porcelain=v1", "--untracked-files=all"], checkout)).toBe(before);
    expect(git(["rev-parse", "HEAD"], checkout)).toBe(head);
  }, 120_000);

  it("refuses a second main checkout of the same repo on the same machine", async () => {
    const ran = await hydra([
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
      if (!(await anyLoggedIn())) {
        ctx.skip(
          "no machine reports a logged-in provider instance. `session.spawn` resolves an " +
            "instance, a machine and a model catalog before it writes anything, and this build " +
            "carries no provider that answers without a vendor login, so an ephemeral workspace " +
            "cannot be made here. Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN to run it.",
        );
        return;
      }

      // From here the machine has to reach the remote, so the https spelling is
      // pointed at the bare repository on disk.
      appendFileSync(
        join(gitHome.home, ".gitconfig"),
        `[url "file://${bare}"]\n\tinsteadOf = ${REMOTE}\n`,
      );

      const spawned = ok<Session>(
        await hydra(
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

      const workspace = await settled(spawned.workspaceId!);
      expect(workspace.status, workspace.message ?? "").toBe("ready");
      expect(workspace.kind).toBe("ephemeral");
      const [only] = workspace.checkouts;
      expect(only!.form).toBe("worktree");
      // The thread's branch is the session's own, and nothing else's: the tail of
      // the session id is what tells two threads in one repo apart.
      expect(only!.branch).toBe(`hydra/run-${spawned.id.slice(-8)}`);
      // It starts where `main` is, so the worktree came off the cache the adopt
      // seeded rather than from a repository nobody could reach.
      expect(only!.branches).toContain(only!.branch!);
      // The workspace knows which thread is in it: `sessionIds` is what the
      // sidebar groups on and what the reaper reads before disposing anything.
      expect(workspace.sessionIds).toContain(spawned.id);

      // The thread is the test's, so it does not outlive it.
      const stopped = await hydra(["session", "stop", spawned.id, "--json"]);
      expect(stopped.code, `${stopped.stdout}\n${stopped.stderr}`).toBe(0);
    },
    180_000,
  );
});
