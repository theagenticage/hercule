/**
 * Tests handing a thing from another system to a workflow, from its card on
 * the Inbox, through the shipped program (spec 11, `externalEntity.handOff`
 * and `externalEntity.undoHandOff`; ADR 0046): `hercule entity hand-off` and
 * `hercule entity undo-hand-off` as the user, against a real controller, with
 * every check going through the CLI's argv and `--json` output. The one read
 * the CLI hides, `task.readAttention`, is called over HTTP the way the
 * desktop app calls it.
 *
 * The journey, in the order of the tests below. Each pull request belongs to
 * one test, so the tests do not depend on each other's rows, except where a
 * test says it continues the one before.
 *
 * - A pull request with a review request and a mention is offered the
 *   workflow. Handing it off makes a Task at `building`, starts one run on
 *   it, ends the review request ("Handed to ...") and leaves the mention open.
 *   The pull request is open, so the shipped `card-in-review` workflow moves
 *   the Task's card to In review a moment later.
 *   A step of the run reads `run.taskId` and records a provenance ref on that
 *   Task.
 * - The same workflow is refused while its run is live. A second workflow is
 *   allowed and lands on the same Task.
 * - Undo after a step started stops the run and keeps the Task (`stopped`),
 *   after the run ended changes nothing (`too-late`), and before the first
 *   step started deletes the Task (`undone`). A repeat returns the first
 *   answer.
 * - Intake's `signal.handOff` still works for a signal on a pull request, and
 *   the card's hand-off to the same workflow is then refused as already
 *   working.
 * - `task.readAttention` is true while a run on a Task has failed, false
 *   after Try again starts a run, and false after Done.
 *
 * GitHub cannot be reached offline, so the entities and signals are written
 * into the scratch database while the controller is stopped, in the shape the
 * GitHub plugin reports them (see `e2e/desktop/inbox.test.ts`, which does the
 * same). The Connection holds no token, so the controller never polls it and
 * the rows stay as written. The invented world is Northwind Market's web shop.
 *
 * No agent runs: the workflows are made of the built-in `wait` and
 * `task.update` actions. The `undone` outcome needs a run whose first step has
 * not started, and nothing in an action-only workflow holds a step back. So
 * that test drains the controller's own runner and hands off a workflow whose
 * first step is a workspace action (`git.commit`), which waits pending for a
 * runner that can take it and never runs.
 *
 * The suite is in vitest's `binary` project, so `pnpm test:binary` runs it and
 * `pnpm test` does not. It runs the release binary if one has been built, and
 * the dispatcher's source otherwise.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  EntityHandOffResult,
  HandOffUndo,
  InboxPage,
  InboxThing,
  Run,
  Signal,
  Task,
} from "../packages/contract/src/index";
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
  assertSucceeded,
  createTemporaryHome,
  findReleaseBinary,
  parseJsonOutputOrFail,
  readApiKey,
  waitForEnrolledRunner,
  type TemporaryHome,
} from "./harness";

let state: TemporaryHome;
const binary = findReleaseBinary();
let controller: Controller;
let runnerId: string;

/** Runs the CLI as the user who set the controller up. */
const runAsUser = (args: ReadonlyArray<string>, stdin?: string): Promise<Ran> =>
  runCli(args, { home: state.home, binary, stdin });

/** Runs the CLI as the user and returns the parsed `--json` output of a command that must succeed. */
const readAsUser = <A>(args: ReadonlyArray<string>, stdin?: string): Promise<A> =>
  runAsUser([...args, "--json"], stdin).then((ran) => parseJsonOutputOrFail<A>(ran));

/** Returns the text a command printed, for a test that checks the words of a refusal. */
const printedBy = (ran: Ran): string => `${ran.stdout}\n${ran.stderr}`;

/** How long a run may take to reach a state a test waits for. */
const WAIT_DEADLINE_MS = 30_000;

/**
 * Calls `read` until `isDone` accepts what it returned, and returns that.
 * Fails, naming `what` and the last value, at the deadline.
 */
const waitFor = async <A>(
  what: string,
  read: () => Promise<A>,
  isDone: (value: A) => boolean,
): Promise<A> => {
  const deadline = Date.now() + WAIT_DEADLINE_MS;
  for (;;) {
    const value = await read();
    if (isDone(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `${what} did not happen in ${String(WAIT_DEADLINE_MS)}ms. Last read:\n` +
          `${JSON.stringify(value)}\n${controller.output()}`,
      );
    }
    await Bun.sleep(100);
  }
};

const readRun = (runId: string): Promise<Run> => readAsUser<Run>(["run", "read", runId]);
const readTask = (taskId: string): Promise<Task> => readAsUser<Task>(["task", "read", taskId]);
const readSignal = (signalId: string): Promise<Signal> =>
  readAsUser<Signal>(["signal", "read", signalId]);

/**
 * Waits until the shipped `card-in-review` workflow has moved the Task's card
 * to In review. Linking an open pull request writes a fact, and the workflow
 * turns it into that move a moment after the hand-off answers.
 */
const waitForCardInReview = (taskId: string): Promise<Task> =>
  waitFor(
    `the card of task ${taskId} moving to In review`,
    () => readTask(taskId),
    (task) => task.stage === "in-review",
  );

/** Waits until the step `stepId` of the run is `running`, and returns the run. */
const waitForStepRunning = (runId: string, stepId: string): Promise<Run> =>
  waitFor(
    `the step ${stepId} of run ${runId} running`,
    () => readRun(runId),
    (run) => run.steps.some((step) => step.stepId === stepId && step.status === "running"),
  );

/** Reads the Inbox row of the pull request with this id, with the offers its set holds. */
const readCard = async (
  entityId: string,
): Promise<{ readonly card: InboxThing; readonly offers: InboxPage["offerSets"][string] }> => {
  const inbox = await readAsUser<InboxPage>(["entity", "list", "--list", "everything"]);
  const card = inbox.things.find((candidate) => candidate.id === entityId);
  if (card === undefined) throw new Error(`the Inbox has no card ${entityId}`);
  return { card, offers: inbox.offerSets[card.offerSetId] ?? [] };
};

/** Hands the pull request to the workflow and returns the result of a handoff that must succeed. */
const handOff = (entityId: string, workflowId: string): Promise<EntityHandOffResult> =>
  readAsUser<EntityHandOffResult>(["entity", "hand-off", entityId, "--workflow", workflowId]);

/** Undoes the handoff that started the run, and returns the answer of an undo that must succeed. */
const undoHandOff = (runId: string): Promise<HandOffUndo> =>
  readAsUser<HandOffUndo>(["entity", "undo-hand-off", runId]);

/** Reads `task.readAttention` over HTTP: true when a live Task has a failed run. */
const readAnyFailure = async (): Promise<boolean> => {
  const response = await fetch(`${controller.url}/api/v1/tasks/attention`, {
    headers: { authorization: `Bearer ${readApiKey(state.home)}` },
  });
  const body = await response.text();
  expect(response.status, body).toBe(200);
  return (JSON.parse(body) as { readonly anyFailure: boolean }).anyFailure;
};

// ---------------------------------------------------------------------------
// The world: workflows, then the rows the GitHub plugin would have written.
// ---------------------------------------------------------------------------

const REVIEW_REQUESTED = "github/review-requested";
const MENTIONED = "github/mentioned";

/** The invented repository every pull request below belongs to. */
const REPOSITORY = "northwind/storefront-web";

/**
 * Returns the source of a workflow with one required `entity` input for pull
 * requests that answers `answers`, followed by `steps` (YAML lines of the
 * `steps:` and `edges:` keys).
 */
const buildEntityWorkflow = (
  name: string,
  answers: ReadonlyArray<string>,
  steps: ReadonlyArray<string>,
): string =>
  [
    `name: ${name}`,
    "inputs:",
    "  - name: pull_request",
    "    entity:",
    "      kinds: [github/pull-request]",
    ...(answers.length === 0 ? [] : [`      answers: [${answers.join(", ")}]`]),
    "    required: true",
    ...steps,
    "",
  ].join("\n");

/** Lines for a step that waits `seconds`, long enough for a test to look at the live run. */
const buildWaitStep = (id: string, seconds: number): ReadonlyArray<string> => [
  `  - id: ${id}`,
  "    kind: action",
  "    action: wait",
  "    params:",
  `      seconds: ${String(seconds)}`,
];

/** Lines for the `steps:` of a workflow that records a pull request on its Task, then waits. */
const RECORDS_THEN_WAITS: ReadonlyArray<string> = [
  "steps:",
  "  - id: record_pull_request",
  "    kind: action",
  "    action: task.update",
  "    params:",
  '      taskId: "{{ run.taskId }}"',
  "      provenance:",
  `        - ref: "github:pr:${REPOSITORY}#6299"`,
  ...buildWaitStep("pause", 120),
  "edges:",
  "  - from: record_pull_request",
  "    to: pause",
];

/** The pull request a step of the Review workflow says it opened, which `run.taskId` lets it record. */
const RECORDED_REF = `github:pr:${REPOSITORY}#6299`;

/** Workflow sources. The names are what the Describe Line and the resolutions say. */
const REVIEW = "Review pull request";
const SECOND_LOOK = "Second look";
const HELD = "Held review";
const BRIDGE = "Review from anywhere";
const DOOMED = "Doomed review";

/** A task id no Task has, so the step that updates it fails. */
const MISSING_TASK_ID = "019a1234-5678-7000-8000-0000000000ff";

const WORKFLOW_SOURCES: Readonly<Record<string, string>> = {
  [REVIEW]: buildEntityWorkflow(REVIEW, [REVIEW_REQUESTED], RECORDS_THEN_WAITS),
  [SECOND_LOOK]: buildEntityWorkflow(SECOND_LOOK, [], ["steps:", ...buildWaitStep("pause", 120)]),
  // Takes a signal (Intake's Hand to an agent) and a pull request (a card's),
  // and neither is required, so each way of handing off fills only its own.
  [BRIDGE]: [
    `name: ${BRIDGE}`,
    "inputs:",
    "  - name: signal",
    "    signal:",
    `      kinds: [${REVIEW_REQUESTED}]`,
    "    required: false",
    "  - name: pull_request",
    "    entity:",
    "      kinds: [github/pull-request]",
    `      answers: [${REVIEW_REQUESTED}]`,
    "    required: false",
    "steps:",
    ...buildWaitStep("pause", 120),
    "",
  ].join("\n"),
  // Waits a moment so that Try again's new run is seen live, then fails.
  [DOOMED]: buildEntityWorkflow(
    DOOMED,
    [],
    [
      "steps:",
      ...buildWaitStep("pause", 2),
      "  - id: break",
      "    kind: action",
      "    action: task.update",
      "    params:",
      `      taskId: "${MISSING_TASK_ID}"`,
      "      title: Never written",
      "edges:",
      "  - from: pause",
      "    to: break",
    ],
  ),
};

/**
 * Returns the source of the held workflow: its only step is a workspace
 * action, so with the runner drained it waits pending for a runner and never
 * starts. The workspace is the main checkout of the repo `resourceId`.
 */
const buildHeldSource = (resourceId: string): string =>
  buildEntityWorkflow(
    HELD,
    [REVIEW_REQUESTED],
    [
      "workspace:",
      "  kind: primary",
      `  resourceId: ${resourceId}`,
      "steps:",
      "  - id: commit",
      "    kind: action",
      "    action: git.commit",
      "    params:",
      "      message: Held",
    ],
  );

/** Records the shop's repo under a new project, and returns the Resource's id. Nothing is cloned until a run needs the checkout. */
const createRepo = async (): Promise<string> => {
  const project = await readAsUser<{ readonly id: string }>([
    "project",
    "create",
    "--name",
    "Storefront",
  ]);
  const resource = await readAsUser<{ readonly id: string }>([
    "resource",
    "create",
    "--kind",
    "repo",
    "--remote",
    `https://github.com/${REPOSITORY}`,
    "--project",
    project.id,
  ]);
  return resource.id;
};

/** Creates a workflow from `source`, enables it, and returns its id. */
const createWorkflow = async (source: string): Promise<string> => {
  const { workflow } = await readAsUser<{ readonly workflow: { readonly id: string } }>(
    ["workflow", "create"],
    source,
  );
  assertSucceeded(await runAsUser(["workflow", "update", workflow.id, "--enabled", "true"]));
  return workflow.id;
};

/** The workflow ids by name, filled in by `beforeAll`. */
const workflowIds: Record<string, string> = {};

const CONNECTION_ID = "019a1234-5678-7000-8000-0000000000a1";
const REPOSITORY_ID = "019a1234-5678-7000-8000-0000000000b1";

/** A pull request to seed, and the signals open on it. */
interface SeededPullRequest {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  /** The signals open on it: the kind and the id the signal gets. */
  readonly signals: ReadonlyArray<{ readonly id: string; readonly kind: string }>;
}

const REVIEWED: SeededPullRequest = {
  id: "019a1234-5678-7000-8000-0000000000b2",
  number: 6241,
  title: "Cache delivery slot lookups for five minutes",
  signals: [
    { id: "019a1234-5678-7000-8000-0000000000c1", kind: REVIEW_REQUESTED },
    { id: "019a1234-5678-7000-8000-0000000000c2", kind: MENTIONED },
  ],
};
const HELD_UP: SeededPullRequest = {
  id: "019a1234-5678-7000-8000-0000000000b3",
  number: 6250,
  title: "Show the delivery fee before checkout",
  signals: [{ id: "019a1234-5678-7000-8000-0000000000c3", kind: REVIEW_REQUESTED }],
};
const FROM_INTAKE: SeededPullRequest = {
  id: "019a1234-5678-7000-8000-0000000000b4",
  number: 6260,
  title: "Round basket totals the same way everywhere",
  signals: [{ id: "019a1234-5678-7000-8000-0000000000c4", kind: REVIEW_REQUESTED }],
};
const FAILING: SeededPullRequest = {
  id: "019a1234-5678-7000-8000-0000000000b5",
  number: 6270,
  title: "Retry the payment webhook once",
  signals: [],
};
const PULL_REQUESTS = [REVIEWED, HELD_UP, FROM_INTAKE, FAILING];

/** Returns the 16-byte form of a UUID, as the database stores an id. */
const toIdBytes = (id: string): Buffer => Buffer.from(id.replaceAll("-", ""), "hex");

const buildPullRequestRef = (pullRequest: SeededPullRequest): string =>
  `github:pr:${REPOSITORY}#${String(pullRequest.number)}`;

/**
 * Writes the Connection, a repository, the pull requests and their signals
 * into the database of the stopped controller. A pull request is open and
 * asks for the user's review, and the Connection reports it with `access:
 * ok`, so the Connection can act on it. The signals are built as the GitHub
 * plugin builds them and the router stores them: an `event` origin that names
 * the pull request's thread. A review request carries the Hand to an agent
 * answer of the bridge workflow, because the controller adds that answer when
 * it raises a signal, and a seeded signal skips that.
 */
const seedWorld = (home: string): void => {
  const database = new Database(join(home, "data", "hercule.db"));
  try {
    const now = new Date().toISOString();
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();

    database
      .query(
        "INSERT INTO connections (id, plugin_id, type, label, display_name, account_id, status, " +
          "status_detail, labels, config, created_at, updated_at, feed_intervals) " +
          "VALUES (?, 'github', 'github/github', 'northwind-bot', 'northwind-bot', " +
          "'northwind-bot', 'needs-reauth', NULL, '[]', '{}', ?, ?, '{}')",
      )
      .run(toIdBytes(CONNECTION_ID), hourAgo, hourAgo);

    const insertEntity = database.query(
      "INSERT INTO external_entities (id, ref, kind, noun, card, pace, patience, caption, home, " +
        "completeness, identifier, title, url, status, lifecycle, person, owner, facts, " +
        "source_updated_at, concerned_since, first_observed_at, updated_at, presented_by, " +
        "arrival_sequence) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'full', ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)",
    );
    insertEntity.run(
      toIdBytes(REPOSITORY_ID),
      `github:repo:${REPOSITORY}`,
      "github/repository",
      "Repository",
      null,
      "context",
      0,
      "GitHub repository",
      null,
      REPOSITORY,
      "storefront-web",
      `https://github.example/${REPOSITORY}`,
      null,
      null,
      null,
      null,
      hourAgo,
      null,
      hourAgo,
      now,
      toIdBytes(CONNECTION_ID),
      null,
    );
    const insertObservation = database.query(
      "INSERT INTO external_entity_observations (ref, connection_id, concerns, owned_by_you, " +
        "access, last_refreshed_at) VALUES (?, ?, ?, 0, 'ok', ?)",
    );
    const insertPartOf = database.query(
      "INSERT INTO external_entity_relation_claims (from_ref, relation, to_ref, claim_type, " +
        "connection_id, evidence_key, state, observed_at) " +
        "VALUES (?, 'part-of', ?, 'source', ?, '', 'current', ?)",
    );
    const insertEvent = database.query(
      "INSERT INTO events (source, connection_id, system, kind, occurred_at, received_at, " +
        "dedup_key, refs, url, payload) VALUES ('github', ?, 'github', ?, ?, ?, ?, ?, ?, '{}')",
    );
    const insertSignal = database.query(
      "INSERT INTO signals (id, kind, origin, title, asker, place, priority, blocks, actions, " +
        "match, status, created_at, connection_id, thread_ref) " +
        "VALUES (?, ?, ?, ?, 'juno-park', ?, 'high', '[]', ?, '{}', 'open', ?, ?, ?)",
    );
    const linkSignalToEvent = database.query(
      "INSERT INTO signal_events (signal_id, event_id) VALUES (?, ?)",
    );

    for (const [index, pullRequest] of PULL_REQUESTS.entries()) {
      const ref = buildPullRequestRef(pullRequest);
      const url = `https://github.example/${REPOSITORY}/pull/${String(pullRequest.number)}`;
      insertEntity.run(
        toIdBytes(pullRequest.id),
        ref,
        "github/pull-request",
        "Pull request",
        "compact",
        "fast",
        24,
        null,
        "github/repository",
        `#${String(pullRequest.number)}`,
        pullRequest.title,
        url,
        JSON.stringify({
          shape: "fork",
          tone: "quiet",
          label: "Open",
          norm: true,
          stage: "in-review",
        }),
        "open",
        JSON.stringify({ name: "juno-park" }),
        "juno-park",
        hourAgo,
        hourAgo,
        hourAgo,
        now,
        toIdBytes(CONNECTION_ID),
        index + 1,
      );
      insertObservation.run(
        ref,
        toIdBytes(CONNECTION_ID),
        JSON.stringify(["review-requested"]),
        now,
      );
      insertPartOf.run(ref, `github:repo:${REPOSITORY}`, toIdBytes(CONNECTION_ID), now);

      for (const signal of pullRequest.signals) {
        const event = insertEvent.run(
          toIdBytes(CONNECTION_ID),
          `github.pr.${signal.kind.slice("github/".length)}`,
          now,
          now,
          `northwind-${signal.id}`,
          JSON.stringify([ref]),
          url,
        );
        const handToBridge =
          signal.kind === REVIEW_REQUESTED && pullRequest === FROM_INTAKE
            ? [
                {
                  id: `hand-to-${workflowIds[BRIDGE]}`,
                  label: `Hand to ${BRIDGE}`,
                  operation: {
                    op: "signal.handOff",
                    input: { signalId: signal.id, workflowId: workflowIds[BRIDGE] },
                  },
                },
              ]
            : [];
        insertSignal.run(
          toIdBytes(signal.id),
          signal.kind,
          JSON.stringify({
            type: "event",
            eventId: Number(event.lastInsertRowid),
            connectionId: CONNECTION_ID,
            threadRef: ref,
          }),
          pullRequest.title,
          `${REPOSITORY}#${String(pullRequest.number)}`,
          JSON.stringify([...handToBridge, { id: "done", label: "Done", operation: null }]),
          now,
          toIdBytes(CONNECTION_ID),
          ref,
        );
        linkSignalToEvent.run(toIdBytes(signal.id), Number(event.lastInsertRowid));
      }
    }
    database.exec(`UPDATE external_entity_arrival_counter SET last = ${PULL_REQUESTS.length}`);
  } finally {
    database.close();
  }
};

beforeAll(async () => {
  state = createTemporaryHome();
  controller = await startController({ home: state.home, binary });
  const completed = await completeSetup({ home: state.home, url: controller.url, binary });
  expect(completed.code, `${completed.stdout}\n${completed.stderr}`).toBe(0);
  const login = await runAsUser(
    [
      "login",
      controller.url,
      "--username",
      USERNAME,
      "--password-stdin",
      "--name",
      "e2e-entity-hand-off",
    ],
    PASSWORD,
  );
  expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);
  runnerId = await waitForEnrolledRunner({ home: state.home, binary });

  for (const [name, source] of Object.entries(WORKFLOW_SOURCES)) {
    workflowIds[name] = await createWorkflow(source);
  }
  workflowIds[HELD] = await createWorkflow(buildHeldSource(await createRepo()));

  // The controller holds its database locked while it runs.
  const { port } = controller;
  expect(await controller.stop()).toBe(0);
  seedWorld(state.home);
  controller = await startController({ home: state.home, binary, port });
  runnerId = await waitForEnrolledRunner({ home: state.home, binary });
}, 150_000);

afterAll(async () => {
  await controller?.stop().catch(() => -1);
  state?.remove();
});

describe("handing a pull request to a workflow from its card", () => {
  // The tests of this block continue each other: each works on the Task and
  // the run the first one made.
  let taskId: string;
  let reviewRunId: string;

  it("is offered the workflow, makes a Task at building with one run, ends the review request and leaves the mention open", async () => {
    const before = await readCard(REVIEWED.id);
    expect(before.card.openKinds).toEqual([MENTIONED, REVIEW_REQUESTED]);
    expect(before.card.actingConnections.map((account) => account.label)).toEqual([
      "northwind-bot",
    ]);
    const offer = before.offers.find((candidate) => candidate.workflowId === workflowIds[REVIEW]);
    expect(offer).toMatchObject({ name: REVIEW, answers: [REVIEW_REQUESTED] });
    expect(offer).not.toHaveProperty("unavailable");

    const handed = await handOff(REVIEWED.id, workflowIds[REVIEW]!);
    taskId = handed.taskId;
    reviewRunId = handed.runId;

    // The Task starts at building, and the shipped workflow then moves its card.
    const task = await waitForCardInReview(taskId);
    expect(task).toMatchObject({ title: REVIEWED.title });
    expect(task.provenance).toContainEqual(
      expect.objectContaining({ ref: buildPullRequestRef(REVIEWED), runId: reviewRunId }),
    );
    expect(await readRun(reviewRunId)).toMatchObject({ taskId });

    const review = await readSignal(REVIEWED.signals[0]!.id);
    expect(review.status).toBe("resolved");
    expect(review.resolution).toMatchObject({
      kind: "decided",
      outcome: `Handed to ${REVIEW}`,
      runId: reviewRunId,
      actor: "user",
    });
    expect(await readSignal(REVIEWED.signals[1]!.id)).toMatchObject({ status: "open" });
    expect((await readCard(REVIEWED.id)).card.taskId).toBe(taskId);
  }, 60_000);

  it("renders run.taskId in a step, which records a provenance ref on the Task", async () => {
    await waitFor(
      "the provenance ref recorded by the run's step",
      () => readTask(taskId),
      (task) => task.provenance.some((entry) => entry.ref === RECORDED_REF),
    );
    const run = await waitForStepRunning(reviewRunId, "pause");
    expect(run.steps.find((step) => step.stepId === "record_pull_request")).toMatchObject({
      status: "completed",
    });
  }, 60_000);

  it("refuses the same workflow while its run is live, and lets a second workflow join the Task", async () => {
    const refused = await runAsUser([
      "entity",
      "hand-off",
      REVIEWED.id,
      "--workflow",
      workflowIds[REVIEW]!,
    ]);
    expect(refused.code).not.toBe(0);
    expect(printedBy(refused)).toContain(`${REVIEW} is already working on this.`);

    const second = await handOff(REVIEWED.id, workflowIds[SECOND_LOOK]!);

    expect(second.taskId).toBe(taskId);
    expect(second.runId).not.toBe(reviewRunId);
    expect(await readRun(second.runId)).toMatchObject({ taskId });
    expect(await readRun(reviewRunId)).toMatchObject({ status: "running" });
    // The second workflow answers no signal, so the mention is still open.
    expect(await readSignal(REVIEWED.signals[1]!.id)).toMatchObject({ status: "open" });

    // The second run has started its step, so Undo is a stop request: the run
    // is cancelled, the Task stays, and the first run is not touched.
    await waitForStepRunning(second.runId, "pause");
    const stopped = await undoHandOff(second.runId);
    expect(stopped).toMatchObject({
      outcome: "stopped",
      stopRequested: true,
      taskRemoved: false,
      stageRestored: false,
    });
    expect(stopped.reason).toBeTruthy();
    expect(await undoHandOff(second.runId)).toEqual(stopped);
    expect(await readRun(second.runId)).toMatchObject({ status: "cancelled" });
    expect(await readRun(reviewRunId)).toMatchObject({ status: "running" });
    expect(await readTask(taskId)).toMatchObject({ stage: "in-review" });
  }, 60_000);

  it("answers too-late to an Undo after the run ended, and changes nothing", async () => {
    assertSucceeded(await runAsUser(["run", "cancel", reviewRunId]));

    const late = await undoHandOff(reviewRunId);

    expect(late).toMatchObject({
      outcome: "too-late",
      stopRequested: false,
      taskRemoved: false,
      stageRestored: false,
      failureRestored: false,
    });
    expect(await readTask(taskId)).toMatchObject({ stage: "in-review" });
    expect(await undoHandOff(reviewRunId)).toEqual(late);
  }, 60_000);
});

describe("taking a handoff back before its first step started", () => {
  it("deletes the Task and cancels the run, keeps the review request ended, and returns the same answer on a repeat", async () => {
    // The only runner is draining, so the held workflow's first step, which
    // needs a runner, waits pending and never starts.
    assertSucceeded(await runAsUser(["runner", "drain", runnerId]));
    try {
      const handed = await handOff(HELD_UP.id, workflowIds[HELD]!);
      // The shipped workflow moves the card before the Undo, so this takes
      // back a Task whose stage a fact has set: that is not a stage decision.
      await waitForCardInReview(handed.taskId);
      expect((await readRun(handed.runId)).steps).toEqual([
        expect.objectContaining({ stepId: "commit", status: "pending" }),
      ]);

      const undone = await undoHandOff(handed.runId);

      expect(undone).toMatchObject({
        outcome: "undone",
        stopRequested: true,
        taskRemoved: true,
        failureRestored: false,
      });
      expect(await undoHandOff(handed.runId)).toEqual(undone);
      expect(await readRun(handed.runId)).toMatchObject({ status: "cancelled" });
      const reading = await runAsUser(["task", "read", handed.taskId, "--json"]);
      expect(reading.code).not.toBe(0);
      expect((await readCard(HELD_UP.id)).card.taskId).toBeUndefined();
      // An undo does not bring ended signals back.
      expect(await readSignal(HELD_UP.signals[0]!.id)).toMatchObject({
        status: "resolved",
        resolution: { outcome: `Handed to ${HELD}` },
      });
    } finally {
      assertSucceeded(await runAsUser(["runner", "undrain", runnerId]));
    }
  }, 60_000);
});

describe("handing off from Intake and from the card", () => {
  it("keeps Intake's Hand to an agent working, and then refuses the card's hand-off to the same workflow as already working", async () => {
    const signalId = FROM_INTAKE.signals[0]!.id;

    const resolved = await readAsUser<Signal>([
      "signal",
      "hand-off",
      signalId,
      "--workflow",
      workflowIds[BRIDGE]!,
    ]);

    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution).toMatchObject({ outcome: `Handed to ${BRIDGE}` });
    const runId = resolved.resolution!.runId!;
    const { taskId } = await readRun(runId);
    expect(taskId).toBeDefined();
    expect((await readCard(FROM_INTAKE.id)).card.taskId).toBe(taskId);

    const refused = await runAsUser([
      "entity",
      "hand-off",
      FROM_INTAKE.id,
      "--workflow",
      workflowIds[BRIDGE]!,
    ]);
    expect(refused.code).not.toBe(0);
    expect(printedBy(refused)).toContain(`${BRIDGE} is already working on this.`);
    // One run on one Task: the refusal started nothing.
    const runs = await readAsUser<{ readonly items: ReadonlyArray<Run> }>([
      "run",
      "list",
      "--workflow",
      workflowIds[BRIDGE]!,
    ]);
    expect(runs.items.map((run) => run.id)).toEqual([runId]);
  }, 60_000);
});

describe("a failure that reaches the user from any screen", () => {
  it("is true while a run on a Task has failed, false after Try again starts a run, and false after Done", async () => {
    expect(await readAnyFailure()).toBe(false);
    const { taskId, runId } = await handOff(FAILING.id, workflowIds[DOOMED]!);

    await waitFor(
      "the run failing",
      () => readRun(runId),
      (run) => run.status === "failed",
    );
    expect(await readAnyFailure()).toBe(true);

    // Try again starts a new run on the same Task, which ends the failure
    // while the run is live. The step that fails comes two seconds later.
    const again = await readAsUser<{ readonly runId: string }>(["run", "rerun", runId]);
    expect(await readRun(again.runId)).toMatchObject({ taskId });
    expect(await readAnyFailure()).toBe(false);

    await waitFor(
      "the new run failing",
      () => readRun(again.runId),
      (run) => run.status === "failed",
    );
    expect(await readAnyFailure()).toBe(true);

    assertSucceeded(await runAsUser(["task", "update", taskId, "--stage", "done"]));
    expect(await readAnyFailure()).toBe(false);
  }, 90_000);
});
