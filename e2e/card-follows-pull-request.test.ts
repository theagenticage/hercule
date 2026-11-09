/**
 * Tests that a card on the Work board follows its pull request (#1035): the
 * Thread's branch finds the pull request, the card moves to In review when
 * the pull request opens and to Landed when it merges, and a card the user
 * drags back stays where it was put.
 *
 * The compiled controller runs against a stand-in for GitHub. The GitHub
 * plugin only sends requests to `https://api.github.com`, so the controller
 * is started with `HTTPS_PROXY` pointing at a small proxy of this test, and
 * with `NODE_EXTRA_CA_CERTS` naming a certificate the test made for that host.
 * The proxy tunnels every request to a local HTTPS server, which answers the
 * few requests the plugin sends (the account, the feeds, and the GraphQL reads
 * of a branch and of a linked pull request) from the state this test sets.
 * Nothing leaves the machine, and the controller itself is the unchanged
 * release binary.
 *
 * The Thread's checkout is written into the scratch database while the
 * controller is stopped, in the shape a runner reports (an ephemeral
 * workspace whose checkout is on a branch that is pushed), because no fake
 * harness ships and a real one spends tokens. The invented world is
 * Northwind Market's web shop.
 *
 * A poll is made to happen by restarting the controller: every feed polls
 * right after it opens. Every wait is on state the API shows, with a
 * deadline.
 *
 * The suite is in vitest's `binary` project, so `pnpm test:binary` runs it and
 * `pnpm test` does not. It requires the built release binary.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PASSWORD,
  USERNAME,
  completeSetup,
  runCli,
  startController,
  type Controller,
  type Ran,
} from "../scripts/controller-process";
import {
  createTemporaryHome,
  findReleaseBinary,
  parseJsonOutputOrFail,
  type TemporaryHome,
} from "./harness";
import { startHttpsStandIn, type StandIn, type StandInAnswer } from "./https-stand-in";

const REPOSITORY = "northwind/market";
const BRANCH = "add-refund-button";
const PULL_REQUEST_NUMBER = 842;
const PULL_REQUEST_REF = `github:pr:${REPOSITORY}#${String(PULL_REQUEST_NUMBER)}`;
const TOKEN = "ghp_northwindMarketTestToken";
const TASK_TITLE = "Add a refund button to Northwind Market's order page";
/** The time every row of the arranged Thread was created at. */
const THREAD_CREATED = "2026-11-01T09:00:00.000Z";

/** How long a state the controller reaches by itself may take, on a slow machine. */
const DEADLINE_MS = 60_000;

let state: TemporaryHome;
const binary = findReleaseBinary();

// ---------------------------------------------------------------------------
// The stand-in for GitHub
// ---------------------------------------------------------------------------

/** What the stand-in says about the pull request on the Thread's branch. */
type PullRequestState = "absent" | "OPEN" | "MERGED";

/** Builds the pull request as GitHub's GraphQL API returns it, for the state the stand-in is in. */
function buildPullRequestNode(pullRequest: "OPEN" | "MERGED") {
  const now = new Date().toISOString();
  return {
    __typename: "PullRequest",
    number: PULL_REQUEST_NUMBER,
    title: "Add a refund button",
    url: `https://github.com/${REPOSITORY}/pull/${String(PULL_REQUEST_NUMBER)}`,
    bodyText: "",
    isDraft: false,
    state: pullRequest,
    // After the Thread's workspace was made, so a merged pull request counts as the Thread's.
    createdAt: "2026-11-02T10:00:00Z",
    updatedAt: now,
    author: { login: "casey-colleague" },
    repository: { nameWithOwner: REPOSITORY, createdAt: "2026-01-05T09:00:00Z" },
    headRefName: BRANCH,
    headRepository: { nameWithOwner: REPOSITORY },
    reviewDecision: null,
    additions: 42,
    deletions: 3,
    changedFiles: 4,
    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
  };
}

/**
 * Answers one GraphQL document the way GitHub does for the reads the GitHub
 * plugin makes: the searches for the user's own concerns, the pull requests
 * whose head is a branch (aliases `b0`, `b1`, ...), and the things a list of
 * refs names (aliases `t0`, `t1`, ...). The one pull request of this test is
 * the answer to every lookup of a pull request. A lookup of an issue finds
 * nothing.
 */
function answerGraphql(query: string, current: PullRequestState): unknown {
  const data: Record<string, unknown> = { viewer: { login: "northwind-dev" } };
  // The searches find nothing: the pull request is a colleague's, so only the
  // branch lookup and the refresh of a linked pull request can find it.
  if (query.includes("search(")) {
    data["search"] = {
      issueCount: 0,
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [],
    };
  }
  const node = current === "absent" ? undefined : buildPullRequestNode(current);
  for (const [, index] of query.matchAll(/\bb(\d+): repository\(/g)) {
    data[`b${index}`] = { pullRequests: { nodes: node === undefined ? [] : [node] } };
  }
  for (const [, index, selection] of query.matchAll(
    /\bt(\d+): repository\([^)]*\) \{ (\.\.\.RepositoryFields|\w+)/g,
  )) {
    data[`t${index}`] =
      selection === "...RepositoryFields"
        ? { nameWithOwner: REPOSITORY, createdAt: "2026-01-05T09:00:00Z" }
        : selection === "issue"
          ? { issue: null }
          : { [selection!]: node ?? null };
  }
  return { data };
}

/** The pull request the stand-in answers with. The test changes it to move the card. */
let currentPullRequest: PullRequestState = "absent";

/** Answers a request to `api.github.com` from `currentPullRequest`. */
function answerGithub(request: { readonly path: string; readonly body: string }): StandInAnswer {
  if (request.path === "/user") {
    return {
      status: 200,
      json: { login: "northwind-dev", id: 4242 },
      headers: { "x-oauth-scopes": "repo, read:org" },
    };
  }
  if (request.path === "/graphql") {
    const { query } = JSON.parse(request.body) as { query: string };
    return { status: 200, json: answerGraphql(query, currentPullRequest) };
  }
  if (request.path === "/search/issues") {
    return { status: 200, json: { total_count: 0, items: [] } };
  }
  // Every other feed (notifications, teams, repositories) has nothing to report.
  return { status: 200, json: [] };
}

/** Returns the GraphQL document of a request the stand-in received, or `undefined` when it is not one. */
function readGraphqlQuery(request: { readonly path: string; readonly body: string }) {
  return request.path === "/graphql"
    ? (JSON.parse(request.body) as { query: string }).query
    : undefined;
}

// ---------------------------------------------------------------------------
// Driving the controller
// ---------------------------------------------------------------------------

let standIn: StandIn;
let controller: Controller | undefined;
let port: number | undefined;

/** Runs a CLI command as the signed-in user and returns its parsed `--json` output. */
async function readJson<A>(args: ReadonlyArray<string>, stdin?: string): Promise<A> {
  const ran: Ran = await runCli([...args, "--json"], { home: state.home, binary, stdin });
  return parseJsonOutputOrFail<A>(ran);
}

/** Starts the controller on the home, reaching GitHub only through the stand-in. */
async function startControllerThroughStandIn(): Promise<Controller> {
  const started = await startController({
    home: state.home,
    binary,
    port,
    env: standIn.controllerEnv,
  });
  port = started.port;
  controller = started;
  return started;
}

/**
 * Stops the controller, calls `whileStopped` (the controller holds the
 * database, so this is when to write to it), and starts it again. Every feed
 * of the Connection polls right after the start.
 */
async function restartController(whileStopped: () => void = () => undefined): Promise<void> {
  expect(await controller!.stop()).toBe(0);
  controller = undefined;
  whileStopped();
  await startControllerThroughStandIn();
}

/** Calls `read` every 250 ms until it returns a value; fails, naming `what`, after `DEADLINE_MS`. */
async function waitUntil<A>(what: string, read: () => Promise<A | undefined>): Promise<A> {
  const deadline = Date.now() + DEADLINE_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(250);
  }
}

interface ReadTask {
  readonly id: string;
  readonly stage: string;
}

interface RunSummary {
  readonly workflowName: string;
  readonly status: string;
}

/** The runs the two shipped workflows make for the Task, once each. */
const IN_REVIEW_RUN: RunSummary = {
  workflowName: "Move a card to In review when its pull request opens",
  status: "completed",
};
const LANDED_RUN: RunSummary = {
  workflowName: "Move a card to Landed when its work is finished",
  status: "completed",
};

/** Waits until the controller's runs, newest first, are exactly `expected`. */
async function waitForRuns(expected: ReadonlyArray<RunSummary>): Promise<void> {
  let last: ReadonlyArray<RunSummary> = [];
  try {
    await waitUntil("the shipped workflows' runs to finish", async () => {
      last = await readRunSummaries();
      return JSON.stringify(last) === JSON.stringify(expected) ? true : undefined;
    });
  } catch (error) {
    throw new Error(`${(error as Error).message} The runs are ${JSON.stringify(last)}.`, {
      cause: error,
    });
  }
}

/** Lists the runs on the controller, newest first, as the workflow they ran and how they ended. */
async function readRunSummaries(): Promise<ReadonlyArray<RunSummary>> {
  const { items } = await readJson<{ items: ReadonlyArray<RunSummary> }>(["run", "list"]);
  return items.map(({ workflowName, status }) => ({ workflowName, status }));
}

/** Reads the stage of the Task. */
async function readStage(taskId: string): Promise<string> {
  return (await readJson<ReadTask>(["task", "read", taskId])).stage;
}

/** Waits until the Task is at `stage`, and fails with the stage it is at when the deadline passes. */
async function waitForStage(taskId: string, stage: string): Promise<void> {
  let last = "";
  try {
    await waitUntil(`the card to reach ${stage}`, async () => {
      last = await readStage(taskId);
      return last === stage ? true : undefined;
    });
  } catch (error) {
    throw new Error(`${(error as Error).message} The card is at ${last}.`, { cause: error });
  }
}

/**
 * Writes the Thread of the Task into the database: a session of the Task in
 * an ephemeral workspace whose checkout is on `BRANCH`, a branch that is
 * pushed, of a GitHub repository. A runner reports exactly this about a
 * workspace. The session has exited, so nothing resumes it, and its lease is
 * held so the sweep leaves the workspace alone.
 */
function arrangeThread(home: string, taskId: string, runnerId: string, profileId: string): void {
  const blob = (id: string) => Buffer.from(id.replaceAll("-", ""), "hex");
  const sessionId = Bun.randomUUIDv7();
  const workspaceId = Bun.randomUUIDv7();
  const resourceId = Bun.randomUUIDv7();
  const spec = JSON.stringify({
    providerAccountId: Bun.randomUUIDv7(),
    workspaceId: null,
    modelSelection: { model: "sonnet", options: {} },
    accessMode: "auto",
    timeouts: { inactivityMs: 60_000, absoluteMs: 3_600_000 },
  });
  const database = new Database(join(home, "data", "hercule.db"));
  try {
    database
      .query(
        `INSERT INTO resources (id, kind, remote, canonical_remote, workspace_include, created_at, updated_at)
         VALUES (?, 'repo', ?, ?, 0, ?, ?)`,
      )
      .run(
        blob(resourceId),
        `https://github.com/${REPOSITORY}`,
        `github.com/${REPOSITORY}`,
        THREAD_CREATED,
        THREAD_CREATED,
      );
    database
      .query(
        `INSERT INTO workspaces (id, runner_id, kind, status, created_at, provisioned_at, last_used_at)
         VALUES (?, ?, 'ephemeral', 'ready', ?, ?, ?)`,
      )
      .run(blob(workspaceId), blob(runnerId), THREAD_CREATED, THREAD_CREATED, THREAD_CREATED);
    database
      .query(
        `INSERT INTO checkouts (id, workspace_id, resource_id, form, branch, branches, default_branch,
                                position, created_at, remote_branches)
         VALUES (?, ?, ?, 'worktree', ?, '[]', 'main', 0, ?, ?)`,
      )
      .run(
        blob(Bun.randomUUIDv7()),
        blob(workspaceId),
        blob(resourceId),
        BRANCH,
        THREAD_CREATED,
        JSON.stringify(["main", BRANCH]),
      );
    database
      .query(
        `INSERT INTO sessions (
           id, title, permission_profile_id, provider_account_id, harness_id, runner_id, workspace_id,
           requested_access_mode, access_mode, spec, model_selection, status,
           created_at, started_at, exited_at, last_activity_at, exit_reason, task_id
         ) VALUES (?, 'Add a refund button', ?, ?, 'claude-code/claude-code', ?, ?, 'auto', 'auto', ?, ?,
                   'exited', ?, ?, ?, ?, 'stopped', ?)`,
      )
      .run(
        blob(sessionId),
        blob(profileId),
        blob(Bun.randomUUIDv7()),
        blob(runnerId),
        blob(workspaceId),
        spec,
        JSON.stringify({ model: "sonnet", options: {} }),
        THREAD_CREATED,
        THREAD_CREATED,
        THREAD_CREATED,
        THREAD_CREATED,
        blob(taskId),
      );
    database
      .query(
        `INSERT INTO workspace_leases (workspace_id, holder_kind, holder_id, acquired_at)
         VALUES (?, 'session', ?, ?)`,
      )
      .run(blob(workspaceId), blob(sessionId), THREAD_CREATED);
  } finally {
    database.close();
  }
}

/** Reads, from the database, when the Connection last read the pull request. Null before any read. */
function readLastRefresh(): string | null {
  const reader = new Database(join(state.home, "data", "hercule.db"), { readonly: true });
  try {
    const row = reader
      .query("SELECT max(last_refreshed_at) AS at FROM external_entity_observations WHERE ref = ?")
      .get(PULL_REQUEST_REF) as { at: string | null } | null;
    return row?.at ?? null;
  } finally {
    reader.close();
  }
}

beforeAll(async () => {
  state = createTemporaryHome();
  standIn = await startHttpsStandIn({ host: "api.github.com", answer: answerGithub });
});

afterAll(async () => {
  await controller?.stop().catch(() => -1);
  await standIn?.stop();
  state?.remove();
});

describe("A card follows its pull request", () => {
  it("moves to In review when the pull request opens, to Landed when it merges, and stays where the user drags it", async () => {
    // Setup: a signed-in controller, a GitHub Connection, and a Task at Building.
    const started = await startControllerThroughStandIn();
    const setup = await completeSetup({ home: state.home, url: started.url, binary });
    expect(setup.code, `${setup.stdout}\n${setup.stderr}`).toBe(0);
    const login = await runCli(
      ["login", started.url, "--username", USERNAME, "--password-stdin", "--name", "e2e-card"],
      { home: state.home, binary, stdin: PASSWORD },
    );
    expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);

    const connection = parseJsonOutputOrFail<{ id: string; status: string }>(
      await runCli(["connection", "create", "--type", "github/github", "--json"], {
        home: state.home,
        binary,
        stdin: JSON.stringify({ pat: TOKEN }),
      }),
    );
    expect(connection.status).toBe("connected");

    const task = parseJsonOutputOrFail<ReadTask>(
      await runCli(["task", "create", "--title", TASK_TITLE, "--stage", "building", "--json"], {
        home: state.home,
        binary,
        stdin: "",
      }),
    );
    expect(task.stage).toBe("building");

    // The Thread: a checkout of the Task on the branch, with no pull request yet.
    const runners = (await readJson<{ items: ReadonlyArray<{ id: string }> }>(["runner", "list"]))
      .items;
    const profiles = (await readJson<{ items: ReadonlyArray<{ id: string }> }>(["profile", "list"]))
      .items;
    await restartController(() =>
      arrangeThread(state.home, task.id, runners[0]!.id, profiles[0]!.id),
    );

    // The first poll looks the branch up and finds nothing, so the card stays.
    await waitUntil("the poll to ask GitHub about the branch", () =>
      Promise.resolve(
        standIn.requests.some((request) => {
          const query = readGraphqlQuery(request);
          return (
            query?.includes("headRefName") === true && query.includes("pullRequests(headRefName")
          );
        })
          ? true
          : undefined,
      ),
    );
    expect(await readStage(task.id)).toBe("building");

    // A pull request with that head opens: the next poll finds it, links it to the
    // Task, and the shipped workflow moves the card to In review.
    currentPullRequest = "OPEN";
    await restartController();
    await waitForStage(task.id, "in-review");
    const linked = await readJson<{ items: ReadonlyArray<{ id: string }> }>([
      "task",
      "list",
      "--ref",
      PULL_REQUEST_REF,
    ]);
    expect(linked.items.map((item) => item.id)).toEqual([task.id]);

    await waitForRuns([IN_REVIEW_RUN]);

    // The pull request merges: the next poll reads the linked pull request again,
    // and the card lands.
    currentPullRequest = "MERGED";
    await restartController();
    await waitForStage(task.id, "landed");
    await waitForRuns([LANDED_RUN, IN_REVIEW_RUN]);

    // The user drags the card back to Building. The next poll reads the same
    // merged pull request and does not move the card again.
    await readJson(["task", "move", task.id, "--stage", "building"]);
    expect(await readStage(task.id)).toBe("building");
    // Two polls read the merged pull request again. A wrong move from the first
    // would show by the end of the second.
    for (let poll = 0; poll < 2; poll++) {
      const refreshedBefore = readLastRefresh();
      await restartController();
      await waitUntil("the poll to read the pull request again", () => {
        const at = readLastRefresh();
        return Promise.resolve(at !== null && at !== refreshedBefore ? at : undefined);
      });
      expect(await readStage(task.id)).toBe("building");
      expect(await readRunSummaries()).toEqual([LANDED_RUN, IN_REVIEW_RUN]);
    }
  }, 240_000);
});
