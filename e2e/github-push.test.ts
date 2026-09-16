/**
 * The proof against GitHub: a machine that holds no git credential of its own
 * pushes to a private repository with a token it never sees written down.
 *
 * Opt-in, like `e2e/session.test.ts`: it talks to a real account and leaves a
 * branch behind until it deletes it, so it runs only with
 * `HYDRA_E2E_GITHUB_TOKEN` and `HYDRA_E2E_GITHUB_REPO` (`owner/name`) set.
 *
 * The controller runs under a `HOME` that holds no `.gitconfig` of the
 * developer's, no `.git-credentials` and no `gh` login, so every credential in
 * this suite can only have come from the Connection through Hydra's own helper.
 *
 * Two things are proved. The machine's own clone of the private repository is
 * the read side: `workspace.provision` cannot finish without a credential, so a
 * workspace that reads `ready` is a clone that authenticated. The push is the
 * write side, and it is run by the test rather than by an agent, for the reason
 * written at `pushed` below.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PASSWORD,
  USERNAME,
  apiKeyIn,
  cli,
  completeSetup,
  jsonOf,
  releaseBinary,
  scrubbedHome,
  startController,
  temporaryHome,
  type Controller,
  type Ran,
} from "./harness";

const token = process.env["HYDRA_E2E_GITHUB_TOKEN"];
const repo = process.env["HYDRA_E2E_GITHUB_REPO"];
const wanted = token !== undefined && repo !== undefined;

const state = temporaryHome();
const world = temporaryHome();
const binary = releaseBinary();

const gitHome = join(world.home, "home");
/** The repository the push is made from: an empty one, with the remote's name on it. */
const sender = join(world.home, "sender");

/** The branch this run makes on GitHub, and takes away again. */
const branch = `hydra-e2e/${Math.random().toString(16).slice(2, 10)}`;

const remote = `https://github.com/${repo ?? ""}`;

let controller: Controller;
let url: string;
/** Where the machine's helper answers: `<home>/runner/<storage>/daemon.sock`. */
let socketPath: string;

/** Long enough for a clone of a small repository over the network. */
const PROVISION_DEADLINE_MS = 120_000;

const hydra = (args: ReadonlyArray<string>, stdin?: string): Promise<Ran> =>
  cli(args, { home: state.home, binary, stdin });

const ok = <A>(ran: Ran): A => {
  expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(0);
  return jsonOf(ran) as A;
};

interface Workspace {
  readonly id: string;
  readonly status: string;
  readonly message: string | null;
  readonly checkouts: ReadonlyArray<{ readonly branch: string | null }>;
}

/** GitHub, as the token's owner. Only used to check and undo what the push did. */
const github = (path: string, init?: RequestInit): Promise<Response> =>
  fetch(`https://api.github.com/repos/${repo!}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token!}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });

/** The helper as the machine spells it: the binary, or Bun and the dispatcher. */
const helperCommand = (() => {
  const built = releaseBinary();
  return built === undefined
    ? `${process.execPath} ${join(import.meta.dirname, "..", "packages/hydra/src/main.ts")} git-credential`
    : `${built} git-credential`;
})();

/**
 * git, run by the test with the environment the machine gives a workspace: the
 * helper before every helper the machine might otherwise have, the socket it
 * answers on, and the claim that says who is asking. Built here rather than
 * imported, because what the runner builds is what is under test.
 */
const gitWithHelper = (
  args: ReadonlyArray<string>,
  cwd: string,
  claim: Record<string, string>,
): { readonly code: number; readonly output: string } => {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    // The empty one first: git reads helpers in order, and an inherited helper
    // would otherwise answer with the machine owner's credential.
    ["credential.helper", ""],
    ["credential.helper", helperCommand],
    ["credential.useHttpPath", "true"],
    ["user.name", "Hydra E2E"],
    ["user.email", "e2e@hydra.test"],
  ];
  const ran = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: gitHome,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      HYDRA_RUNNER_SOCKET: socketPath,
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

const workspaceRead = async (id: string): Promise<Workspace> =>
  ok<Workspace>(await hydra(["workspace", "read", id, "--json"]));

beforeAll(async () => {
  if (!wanted) return;
  scrubbedHome(gitHome, "");

  controller = await startController({
    home: state.home,
    binary,
    // No git configuration of the developer's, and no system one either: what
    // authenticates here has to come from Hydra.
    env: { HOME: gitHome, GIT_CONFIG_NOSYSTEM: "1" },
  });
  url = controller.url;

  const completed = await completeSetup({ home: state.home, url, binary });
  expect(completed.code, `${completed.stdout}\n${completed.stderr}`).toBe(0);

  const login = await cli(
    ["login", url, "--username", USERNAME, "--password-stdin", "--name", "e2e-github"],
    { home: state.home, binary, stdin: PASSWORD },
  );
  expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);

  // The repository the push comes from. It is the test's own: the machine's
  // checkout does not exist until provisioning has finished, and the claim the
  // helper can prove only stands while it has not.
  mkdirSync(sender);
  for (const args of [
    ["init", "--initial-branch=main", "."],
    ["remote", "add", "origin", remote],
    ["commit", "--allow-empty", "-m", `hydra e2e ${branch}`],
  ]) {
    const ran = Bun.spawnSync(["git", ...args], {
      cwd: sender,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: gitHome,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Hydra E2E",
        GIT_AUTHOR_EMAIL: "e2e@hydra.test",
        GIT_COMMITTER_NAME: "Hydra E2E",
        GIT_COMMITTER_EMAIL: "e2e@hydra.test",
      },
    });
    expect(ran.exitCode, ran.stderr.toString()).toBe(0);
  }
}, 180_000);

afterAll(async () => {
  if (wanted) {
    // Whatever the run did, the account is left as it was found.
    await github(`/git/refs/heads/${branch}`, { method: "DELETE" }).catch(() => undefined);
  }
  await controller?.stop().catch(() => -1);
  state.remove();
  world.remove();
});

describe.skipIf(!wanted)("a push to GitHub with a credential nothing wrote down", () => {
  it("clones the private repo, pushes a branch with the workspace's own env, and keeps no token", async () => {
    // The account, from the token alone. Creating it asks GitHub who the
    // token belongs to, so a connection that exists is a token that works.
    const connection = ok<{ id: string; displayName: string }>(
      await hydra(
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

    const resource = ok<{ id: string; canonicalRemote: string | null }>(
      await hydra([
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

    const runnerId = ok<{ items: ReadonlyArray<{ id: string; connectivity: string }> }>(
      await hydra(["runner", "list", "--connectivity", "online", "--json"]),
    ).items[0]?.id;
    expect(runnerId, `no machine came online:\n${controller.output()}`).toBeDefined();

    // Where the helper answers on this machine. The storage directory is
    // named at random when the machine joins, so it is read rather than
    // guessed.
    const pin = JSON.parse(readFileSync(join(state.home, "runner", "runner.json"), "utf8")) as {
      readonly storageDirectory: string;
    };
    socketPath = join(state.home, "runner", pin.storageDirectory, "daemon.sock");

    // Asked for over HTTP rather than through another process start: what
    // follows has to happen while this workspace is still being made.
    const answered = (await (
      await fetch(`${url}/api/v1/workspaces`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKeyIn(state.home)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ resourceId: resource.id, runnerId }),
      })
    ).json()) as Workspace;
    expect(answered.status, JSON.stringify(answered)).toBe("provisioning");

    /**
     * The push, with the claim the machine's own git carries while it is
     * making a workspace.
     *
     * A session's claim is its Session Token, which the controller stores
     * hashed and hands to nobody but the machine, so no harness can present
     * it; the workspace claim is the one a test can hold, and it is the same
     * helper, the same socket and the same answer from the controller. What
     * is left to a person is a live agent running `git push` itself, which is
     * the manual half of this proof.
     *
     * It stands only while the workspace reads `provisioning`, which is as
     * long as the clone takes, so the attempt is repeated for as long as that
     * is true rather than fired once into a window nobody measured.
     */
    let pushed = { code: -1, output: "never attempted" };
    for (let attempt = 0; attempt < 8; attempt++) {
      pushed = gitWithHelper(["push", "-u", "origin", `HEAD:refs/heads/${branch}`], sender, {
        HYDRA_WORKSPACE_PROVISIONING: answered.id,
      });
      if (pushed.code === 0) break;
      const now = await workspaceRead(answered.id);
      if (now.status !== "provisioning") {
        throw new Error(
          `the push never landed while the workspace was being made; it reads ${now.status}` +
            `${now.message === null ? "" : ` (${now.message})`} and git said:\n${pushed.output}`,
        );
      }
    }
    expect(pushed.code, pushed.output).toBe(0);

    // The clone the machine was making needed a credential of its own, so a
    // workspace that stands is the read side of the same path.
    const deadline = Date.now() + PROVISION_DEADLINE_MS;
    let workspace = await workspaceRead(answered.id);
    while (workspace.status === "provisioning" && Date.now() < deadline) {
      await Bun.sleep(500);
      workspace = await workspaceRead(answered.id);
    }
    expect(workspace.status, workspace.message ?? "").toBe("ready");
    expect(workspace.checkouts[0]?.branch).not.toBeNull();

    // The branch is on GitHub, and it is the commit this run made.
    const ref = await github(`/git/ref/heads/${branch}`);
    const body = await ref.text();
    expect(ref.status, body).toBe(200);
    expect((JSON.parse(body) as { object: { sha: string } }).object.sha).toBe(
      Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: sender }).stdout.toString().trim(),
    );

    const deleted = await github(`/git/refs/heads/${branch}`, { method: "DELETE" });
    expect(deleted.status, await deleted.text()).toBe(204);

    // Nothing under the Hydra Home holds the token: not the database, not a
    // log, not a git config the machine wrote.
    // grep exits 1 when it finds nothing, which is the answer wanted here, so
    // what it printed is read rather than what it exited with.
    const holding = Bun.spawnSync(["grep", "-rl", "--binary-files=text", "--", token!, state.home])
      .stdout.toString()
      .trim();
    expect(holding, "these files under the Hydra Home hold the token").toBe("");
  }, 300_000);
});
