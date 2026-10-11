/**
 * Tests subscriptions over HTTP: a session registers one, reads back what the
 * controller stored, sees another session's, and cancels its own.
 *
 * A real fleet is needed because the credential under test is a session token,
 * and a session token is only ever minted in a start frame on the runner
 * socket. The subscriptions a run holds for its signal triggers are the
 * exception: only the user reads and cancels them here, so no fleet is
 * started for them.
 *
 * What the event router does with a stored subscription is not here: this
 * suite runs no router.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { del, get, post, readErrorBody, type ServerHarness } from "../http/testing";
import {
  spawnThreadWithGrants,
  spawnThreadUnder,
  createProfile,
  WAIT_DEADLINE_MS,
  withAgentFleet,
  type Arranged,
} from "../sessions/testing";
import {
  buildCreateStep,
  buildHeldAction,
  buildHeldStep,
  buildLabelSignal,
  insertPendingRun,
  LABEL_INPUT,
  RUN_WATCHER_GRANTS,
  startHeldRun,
  startRun,
  startSentWorkflow,
  waitForRunToFinish,
  withRunFleet,
} from "../runs/testing";
import { createWorkflowOrFail, withSetUpController } from "../workflows/testing";

/** Starting the fleet is the slow part of each case; the timeout allows three waits. */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

/** The External Ref every case here subscribes to, and what it expands into. */
const REF = "github:pr:o/r#87";
const REF_CONDITION = `"${REF}" in event.refs`;

/** A well-formed UUIDv7 that matches no record on this controller. */
const ABSENT_ID = "0192f0a1-0000-7000-8000-00000000dead";

interface Subscription {
  readonly id: string;
  readonly target: unknown;
  readonly condition: string;
  readonly holder: { readonly kind: string; readonly id: string };
  readonly health: { readonly state: string };
  readonly lostWakeUp: unknown;
  readonly createdAt: string;
  readonly endedAt?: string | null;
}

const createSubscription = (
  arranged: Arranged,
  target: unknown,
  token: string,
): Promise<Response> => post(arranged.harness.base, "/api/v1/subscriptions", { target }, token);

/** Registers a subscription and returns its id. Fails the test if the create did not succeed. */
const createSubscriptionOrFail = async (
  arranged: Arranged,
  target: unknown,
  token: string,
): Promise<string> => {
  const response = await createSubscription(arranged, target, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { subscriptionId: string }).subscriptionId;
};

/**
 * Requests one page of subscriptions. The holder goes on the query string in
 * the same `<kind>:<id>` shorthand that targets use.
 */
const listSubscriptions = async (
  arranged: Arranged,
  token: string,
  holder?: string,
): Promise<Response> =>
  get(
    arranged.harness.base,
    `/api/v1/subscriptions${holder === undefined ? "" : `?holder=session:${holder}`}`,
    token,
  );

const listPage = async (
  arranged: Arranged,
  token: string,
  holder?: string,
): Promise<ReadonlyArray<Subscription>> => {
  const response = await listSubscriptions(arranged, token, holder);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<Subscription> }).items;
};

/** One subscription's end, as the row records it. */
interface EndRow {
  readonly ended_at: string | null;
  readonly ended_reason: string | null;
  readonly ended_actor: string | null;
}

/**
 * Reads how a subscription ended from the table rather than from
 * `subscription.query`. Nothing specifies whether a query returns an ended
 * subscription at all, and these tests are about the row the event router
 * reads.
 */
const readEndRow = (harness: ServerHarness, id: string): Promise<ReadonlyArray<EndRow>> =>
  Effect.runPromise(
    Effect.orDie(
      harness.sql<EndRow>`
        SELECT ended_at, ended_reason, ended_actor FROM subscriptions
        WHERE id = unhex(replace(${id}, '-', ''))`,
    ),
  );

/** Returns the condition a run target expands into. */
const buildRunCondition = (runId: string): string =>
  `event.source == "platform" && event.kind.startsWith("run.") && event.payload.runId == "${runId}"`;

/** The id of the pending run a test inserts. A UUIDv7, like every id the controller mints. */
const PENDING_RUN_ID = "0199f0b7-0000-7000-8000-00000000c001";

const cancelSubscription = (arranged: Arranged, id: string, token: string): Promise<Response> =>
  del(arranged.harness.base, `/api/v1/subscriptions/${id}`, token);

describe("subscription.create", () => {
  it("stores the target, its expansion and the calling session, as a live subscription", async () => {
    await withAgentFleet(async (arranged) => {
      const agent = await spawnThreadWithGrants(arranged, "subscribers", [
        "subscription.write",
        "subscription.read",
      ]);
      const subscriptionId = await createSubscriptionOrFail(
        arranged,
        { kind: "ref", ref: REF },
        agent.token,
      );

      const items = await listPage(arranged, agent.token);
      const stored = items.find((one) => one.id === subscriptionId);
      expect(stored, "the subscription it just created").toBeDefined();
      expect(stored!.target).toEqual({ kind: "ref", ref: REF });
      expect(stored!.condition).toBe(REF_CONDITION);
      expect(stored!.holder).toEqual({ kind: "session", id: agent.session.id });
      expect(stored!.health).toEqual({ state: "ok" });
      expect(stored!.lostWakeUp).toBeNull();
      expect(stored!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(stored!.endedAt ?? null).toBeNull();
    });
  });

  it("rejects each target kind it does not accept, and says why", async () => {
    await withAgentFleet(async (arranged) => {
      const agent = await spawnThreadWithGrants(arranged, "subscribers", ["subscription.write"]);
      const cases: ReadonlyArray<readonly [unknown, RegExp]> = [
        // No session.* platform events are emitted yet.
        [{ kind: "session", sessionId: agent.session.id }, /session.*yet/i],
        // permission.request registers the subscription itself.
        [{ kind: "request", requestId: "pr_7" }, /permission\.request/],
      ];
      for (const [target, reason] of cases) {
        const response = await createSubscription(arranged, target, agent.token);
        const refused = await readErrorBody(response);
        expect(response.status, JSON.stringify(target)).toBe(409);
        expect(refused.code, JSON.stringify(target)).toBe("invalid_state");
        expect(refused.message).toMatch(reason);
      }
    });
  });

  it("rejects a user credential, and says a subscription needs a session holder", async () => {
    await withAgentFleet(async (arranged) => {
      const response = await createSubscription(
        arranged,
        { kind: "ref", ref: REF },
        arranged.token,
      );
      const refused = await readErrorBody(response);
      expect(response.status, refused.text).toBe(400);
      expect(refused.code).toBe("validation");
      expect(refused.message).toMatch(/session/i);
    });
  });
});

/**
 * A run emits one event, `run.completed`, `run.failed` or `run.cancelled`,
 * when it ends. So a session may wait on a run that has not ended, and is
 * refused a run that has ended or that does not exist.
 */
describe("subscription.create with a run target", () => {
  it("stores a run target for a running run, with the expansion that matches its ending", async () => {
    const held = buildHeldAction();
    await withRunFleet(
      async (arranged) => {
        try {
          const runId = await startHeldRun(arranged.harness.base, arranged.token, held);
          const agent = await spawnThreadWithGrants(arranged, "run-watchers", RUN_WATCHER_GRANTS);

          const subscriptionId = await createSubscriptionOrFail(
            arranged,
            { kind: "run", runId },
            agent.token,
          );

          const items = await listPage(arranged, agent.token);
          expect(items.map((one) => one.id)).toEqual([subscriptionId]);
          expect(items[0]!.target).toEqual({ kind: "run", runId });
          expect(items[0]!.condition).toBe(buildRunCondition(runId));
          expect(items[0]!.holder).toEqual({ kind: "session", id: agent.session.id });
        } finally {
          held.release();
        }
      },
      [held.plugin],
    );
  });

  it("stores a run target for a pending run", async () => {
    const held = buildHeldAction();
    await withRunFleet(
      async (arranged) => {
        try {
          const definition = { name: "Wait", steps: [buildHeldStep(held, "first")] };
          const workflow = await createWorkflowOrFail(arranged.harness.base, arranged.token, {
            definition,
          });
          // No request can hold a run at pending, so its rows are written directly.
          await insertPendingRun(arranged.harness, {
            id: PENDING_RUN_ID,
            workflowId: workflow.id,
            plan: definition,
            stepId: "first",
          });
          const agent = await spawnThreadWithGrants(arranged, "run-watchers", RUN_WATCHER_GRANTS);

          await createSubscriptionOrFail(
            arranged,
            { kind: "run", runId: PENDING_RUN_ID },
            agent.token,
          );

          const items = await listPage(arranged, agent.token);
          expect(items.map((one) => one.condition)).toEqual([buildRunCondition(PENDING_RUN_ID)]);
        } finally {
          held.release();
        }
      },
      [held.plugin],
    );
  });

  it("rejects a run that has already ended with invalid_state, says so, and stores nothing", async () => {
    await withRunFleet(async (arranged) => {
      const base = arranged.harness.base;
      const workflow = await createWorkflowOrFail(base, arranged.token, {
        definition: { name: "One task", steps: [buildCreateStep("create")] },
      });
      const runId = await startRun(base, arranged.token, workflow.id);
      const ended = await waitForRunToFinish(base, arranged.token, runId);
      expect(ended.status).toBe("completed");
      const agent = await spawnThreadWithGrants(arranged, "run-watchers", RUN_WATCHER_GRANTS);

      const response = await createSubscription(arranged, { kind: "run", runId }, agent.token);

      const refused = await readErrorBody(response);
      expect(response.status, refused.text).toBe(409);
      expect(refused.code).toBe("invalid_state");
      expect(refused.message).toMatch(/already ended/i);
      expect(refused.message).toContain("completed");
      expect(await listPage(arranged, agent.token)).toEqual([]);
    });
  });

  it("rejects a run id that is not a UUID with validation, and stores nothing", async () => {
    await withAgentFleet(async (arranged) => {
      const agent = await spawnThreadWithGrants(arranged, "run-watchers", RUN_WATCHER_GRANTS);

      // The shorthand's prefix written into the id is the likeliest mistake.
      const response = await createSubscription(
        arranged,
        { kind: "run", runId: "run:abc" },
        agent.token,
      );

      const refused = await readErrorBody(response);
      expect(response.status, refused.text).toBe(400);
      expect(refused.code).toBe("validation");
      expect(refused.issues).toEqual([["target", "runId"]]);
      expect(await listPage(arranged, agent.token)).toEqual([]);
    });
  });

  it("returns not_found for a run id that matches no run, and stores nothing", async () => {
    await withAgentFleet(async (arranged) => {
      const agent = await spawnThreadWithGrants(arranged, "run-watchers", RUN_WATCHER_GRANTS);

      const response = await createSubscription(
        arranged,
        { kind: "run", runId: ABSENT_ID },
        agent.token,
      );

      const refused = await readErrorBody(response);
      expect(response.status, refused.text).toBe(404);
      expect(refused.code).toBe("not_found");
      expect(await listPage(arranged, agent.token)).toEqual([]);
    });
  });

  it("rejects a session without run.read with forbidden, names the grant, and stores nothing", async () => {
    const held = buildHeldAction();
    await withRunFleet(
      async (arranged) => {
        try {
          const runId = await startHeldRun(arranged.harness.base, arranged.token, held);
          const agent = await spawnThreadWithGrants(arranged, "subscribers", [
            "subscription.write",
            "subscription.read",
          ]);

          const response = await createSubscription(arranged, { kind: "run", runId }, agent.token);

          const refused = await readErrorBody(response);
          expect(response.status, refused.text).toBe(403);
          expect(refused.code).toBe("forbidden");
          expect(refused.grant).toBe("run.read");
          expect(await listPage(arranged, agent.token)).toEqual([]);
        } finally {
          held.release();
        }
      },
      [held.plugin],
    );
  });
});

describe("subscription.query", () => {
  it("returns only the session's own subscriptions when a session token names no holder", async () => {
    await withAgentFleet(async (arranged) => {
      const profile = await createProfile(arranged, "subscribers", [
        "subscription.write",
        "subscription.read",
      ]);
      const mine = await spawnThreadUnder(arranged, profile);
      const theirs = await spawnThreadUnder(arranged, profile);
      const own = await createSubscriptionOrFail(arranged, { kind: "ref", ref: REF }, mine.token);
      const other = await createSubscriptionOrFail(
        arranged,
        { kind: "ref", ref: "github:pr:o/r#88" },
        theirs.token,
      );

      const items = await listPage(arranged, mine.token);
      expect(items.map((one) => one.id)).toEqual([own]);
      expect(items.map((one) => one.id)).not.toContain(other);
      const only = items[0]!;
      expect(only.target).toEqual({ kind: "ref", ref: REF });
      expect(only.condition).toBe(REF_CONDITION);
      expect(only.health).toEqual({ state: "ok" });
      expect(only.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  it("returns another session's subscriptions when a session token names that holder", async () => {
    await withAgentFleet(async (arranged) => {
      const profile = await createProfile(arranged, "subscribers", [
        "subscription.write",
        "subscription.read",
      ]);
      const mine = await spawnThreadUnder(arranged, profile);
      const theirs = await spawnThreadUnder(arranged, profile);
      await createSubscriptionOrFail(arranged, { kind: "ref", ref: REF }, mine.token);
      const other = await createSubscriptionOrFail(
        arranged,
        { kind: "ref", ref: "github:pr:o/r#88" },
        theirs.token,
      );

      const items = await listPage(arranged, mine.token, theirs.session.id);
      expect(items.map((one) => one.id)).toEqual([other]);
      expect(items[0]!.holder).toEqual({ kind: "session", id: theirs.session.id });
    });
  });

  it("rejects a user credential that names no holder, and says a holder is required", async () => {
    await withAgentFleet(async (arranged) => {
      const response = await listSubscriptions(arranged, arranged.token);
      const refused = await readErrorBody(response);
      expect(response.status, refused.text).toBe(400);
      expect(refused.code).toBe("validation");
      expect(refused.message).toMatch(/holder/i);
    });
  });
});

describe("subscription.cancel", () => {
  it("ends the subscription, and records cancelled as the reason", async () => {
    await withAgentFleet(async (arranged) => {
      const agent = await spawnThreadWithGrants(arranged, "subscribers", [
        "subscription.write",
        "subscription.read",
      ]);
      const subscriptionId = await createSubscriptionOrFail(
        arranged,
        { kind: "ref", ref: REF },
        agent.token,
      );

      const response = await cancelSubscription(arranged, subscriptionId, agent.token);
      expect(response.status, await response.clone().text()).toBe(200);

      const rows = await readEndRow(arranged.harness, subscriptionId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.ended_at).not.toBeNull();
      expect(rows[0]!.ended_reason).toBe("cancelled");
      // The actor is stamped as on every other mutation: the calling session,
      // with the same `session:<id>` stamp its other writes carry.
      expect(rows[0]!.ended_actor).toBe(`session:${agent.session.id}`);
    });
  });

  it("returns not found for a second cancel of the same subscription", async () => {
    await withAgentFleet(async (arranged) => {
      const agent = await spawnThreadWithGrants(arranged, "subscribers", ["subscription.write"]);
      const subscriptionId = await createSubscriptionOrFail(
        arranged,
        { kind: "ref", ref: REF },
        agent.token,
      );
      expect((await cancelSubscription(arranged, subscriptionId, agent.token)).status).toBe(200);

      const again = await cancelSubscription(arranged, subscriptionId, agent.token);
      const refused = await readErrorBody(again);
      expect(again.status, refused.text).toBe(404);
      expect(refused.code).toBe("not_found");
    });
  });

  it("returns not found for an id that matches no subscription", async () => {
    await withAgentFleet(async (arranged) => {
      const agent = await spawnThreadWithGrants(arranged, "subscribers", ["subscription.write"]);
      // One live subscription exists, so the not-found error is about this id
      // and not about an empty table.
      await createSubscriptionOrFail(arranged, { kind: "ref", ref: REF }, agent.token);

      const response = await cancelSubscription(arranged, ABSENT_ID, agent.token);
      const refused = await readErrorBody(response);
      expect(response.status, refused.text).toBe(404);
      expect(refused.code).toBe("not_found");
    });
  });
});

/**
 * A subscription belongs to the session that registered it, and
 * `subscription.cancel` takes only an id. So only the credential can stop one
 * session from cancelling another session's subscription.
 */
describe("whose subscription a session may cancel", () => {
  it("rejects cancelling another session's subscription, keeps it live, and fails as for an unknown id", async () => {
    await withAgentFleet(async (arranged) => {
      const profile = await createProfile(arranged, "subscribers", [
        "subscription.write",
        "subscription.read",
      ]);
      const mine = await spawnThreadUnder(arranged, profile);
      const theirs = await spawnThreadUnder(arranged, profile);
      const other = await createSubscriptionOrFail(
        arranged,
        { kind: "ref", ref: REF },
        theirs.token,
      );

      const response = await cancelSubscription(arranged, other, mine.token);
      const refused = await readErrorBody(response);
      expect(response.status, refused.text).toBe(404);
      expect(refused.code).toBe("not_found");

      // Still live, and its holder can still cancel it.
      expect((await listPage(arranged, theirs.token)).map((one) => one.id)).toEqual([other]);
      expect((await cancelSubscription(arranged, other, theirs.token)).status).toBe(200);
    });
  });

  it("lets the user cancel a session's subscription", async () => {
    await withAgentFleet(async (arranged) => {
      const agent = await spawnThreadWithGrants(arranged, "subscribers", [
        "subscription.write",
        "subscription.read",
      ]);
      const subscriptionId = await createSubscriptionOrFail(
        arranged,
        { kind: "ref", ref: REF },
        agent.token,
      );

      const response = await cancelSubscription(arranged, subscriptionId, arranged.token);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await listPage(arranged, agent.token)).toEqual([]);
      // The user's stamp, not the holder's: the row records who ended the
      // subscription, not who was waiting on it.
      expect((await readEndRow(arranged.harness, subscriptionId))[0]!.ended_actor).toBe("user");
    });
  });
});

describe("a subscription a run holds", () => {
  it("is listed for the run's holder, and refuses a cancel with invalid_state and stays live", async () => {
    // The user is the only caller here, so no fleet is needed.
    await withSetUpController(async ({ harness, base, token }) => {
      const runId = await startSentWorkflow(base, token, {
        definition: {
          name: "Wait for a label",
          inputs: [LABEL_INPUT],
          triggers: [buildLabelSignal()],
          steps: [buildCreateStep("open"), buildCreateStep("follow_up")],
          edges: [{ from: "labeled", to: "follow_up" }],
        },
        inputs: { label: "triage" },
      });
      const listed = await get(base, `/api/v1/subscriptions?holder=run:${runId}`, token);
      expect(listed.status, await listed.clone().text()).toBe(200);
      const { items } = (await listed.json()) as { items: ReadonlyArray<Subscription> };
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        target: { kind: "signal", triggerId: "labeled" },
        holder: { kind: "run", id: runId },
      });

      const response = await del(base, `/api/v1/subscriptions/${items[0]!.id}`, token);

      const refused = await readErrorBody(response);
      expect(response.status, refused.text).toBe(409);
      expect(refused.code).toBe("invalid_state");
      expect(refused.message).toContain("cancel the run instead");
      expect(await readEndRow(harness, items[0]!.id)).toEqual([
        { ended_at: null, ended_reason: null, ended_actor: null },
      ]);
    });
  });
});
