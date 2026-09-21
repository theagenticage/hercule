/**
 * A session's claim on a future event, over HTTP: the session registers one,
 * reads back what the controller stored, sees another session's, and cancels
 * its own.
 *
 * A real fleet is needed because the credential under test is a session token,
 * and the only place a session token is ever minted is a start frame on the
 * runner socket.
 *
 * What the matcher does with a stored subscription is not here: this suite
 * runs no matcher.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { del, get, post } from "../http/testing";
import {
  agentOn,
  profileOf,
  WAIT_DEADLINE_MS,
  withAgentFleet,
  type Agent,
  type Arranged,
} from "../sessions/testing";

/** The fleet each case stands up first is the slow part; three waits fit inside this. */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

/** The External Ref every case here subscribes to, and what it expands into. */
const REF = "github:pr:o/r#87";
const REF_CONDITION = `"${REF}" in event.refs`;

/** A canonical UUIDv7 that names nothing on this controller. */
const ABSENT_ID = "0192f0a1-0000-7000-8000-00000000dead";

interface Subscription {
  readonly id: string;
  readonly target: unknown;
  readonly condition: string;
  readonly holder: { readonly kind: string; readonly id: string };
  readonly health: { readonly state: string };
  readonly createdAt: string;
  readonly endedAt?: string | null;
}

/** A session on a profile holding exactly these grants. */
const sessionHolding = async (
  arranged: Arranged,
  name: string,
  grants: ReadonlyArray<string>,
): Promise<Agent> => agentOn(arranged, await profileOf(arranged, name, grants));

const createSubscription = (
  arranged: Arranged,
  target: unknown,
  token: string,
): Promise<Response> => post(arranged.harness.base, "/api/v1/subscriptions", { target }, token);

/** Registers one and hands back the id, refusing to continue if it did not take. */
const registered = async (arranged: Arranged, target: unknown, token: string): Promise<string> => {
  const response = await createSubscription(arranged, target, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { subscriptionId: string }).subscriptionId;
};

/**
 * One page of subscriptions. The holder is named on the query string in the
 * `<kind>:<id>` shorthand the target shorthand already uses; see the suite's
 * assumption note in the plan's worklog if the contract spells it as two
 * flat fields instead.
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

const page = async (
  arranged: Arranged,
  token: string,
  holder?: string,
): Promise<ReadonlyArray<Subscription>> => {
  const response = await listSubscriptions(arranged, token, holder);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<Subscription> }).items;
};

const cancel = (arranged: Arranged, id: string, token: string): Promise<Response> =>
  del(arranged.harness.base, `/api/v1/subscriptions/${id}`, token);

/**
 * One refusal, as the code it carries and the text a person reads. It takes
 * anything that answers with a body, because a caller that has already read
 * the text hands over a clone, whose type is not the harness's `Response`.
 */
const refusalOf = async (response: {
  readonly json: () => Promise<unknown>;
}): Promise<{ readonly code: string; readonly message: string }> => {
  const body = (await response.json()) as {
    readonly error?: { readonly code?: string; readonly message?: string };
  };
  return { code: body.error?.code ?? "", message: body.error?.message ?? "" };
};

describe("subscription.create", () => {
  it("stores the target, its expansion, and the session that asked, as live", async () => {
    await withAgentFleet(async (arranged) => {
      const agent = await sessionHolding(arranged, "subscribers", [
        "subscription.write",
        "subscription.read",
      ]);
      const subscriptionId = await registered(arranged, { kind: "ref", ref: REF }, agent.token);

      const items = await page(arranged, agent.token);
      const stored = items.find((one) => one.id === subscriptionId);
      expect(stored, "the subscription it just created").toBeDefined();
      expect(stored!.target).toEqual({ kind: "ref", ref: REF });
      expect(stored!.condition).toBe(REF_CONDITION);
      expect(stored!.holder).toEqual({ kind: "session", id: agent.session.id });
      expect(stored!.health).toEqual({ state: "ok" });
      expect(stored!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(stored!.endedAt ?? null).toBeNull();
    });
  });

  it("refuses each target whose subject this version cannot have, naming it", async () => {
    await withAgentFleet(async (arranged) => {
      const agent = await sessionHolding(arranged, "subscribers", ["subscription.write"]);
      const cases: ReadonlyArray<readonly [unknown, RegExp]> = [
        [{ kind: "run", runId: "r_3" }, /run/i],
        [{ kind: "session", sessionId: agent.session.id }, /session/i],
        [{ kind: "request", requestId: "pr_7" }, /permission request/i],
      ];
      for (const [target, names] of cases) {
        const response = await createSubscription(arranged, target, agent.token);
        const refused = await refusalOf(response.clone());
        expect(response.status, JSON.stringify(target)).toBe(409);
        expect(refused.code, JSON.stringify(target)).toBe("invalid_state");
        expect(refused.message).toMatch(names);
        expect(refused.message, "says the subject does not exist yet").toMatch(/yet/i);
      }
    });
  });

  it("refuses a user credential, saying a subscription needs a session holder", async () => {
    await withAgentFleet(async (arranged) => {
      const response = await createSubscription(
        arranged,
        { kind: "ref", ref: REF },
        arranged.token,
      );
      const refused = await refusalOf(response.clone());
      expect(response.status, await response.clone().text()).toBe(400);
      expect(refused.code).toBe("validation");
      expect(refused.message).toMatch(/session/i);
    });
  });
});

describe("subscription.query", () => {
  it("answers a session token naming no holder with that session's own, and nothing else", async () => {
    await withAgentFleet(async (arranged) => {
      const profile = await profileOf(arranged, "subscribers", [
        "subscription.write",
        "subscription.read",
      ]);
      const mine = await agentOn(arranged, profile);
      const theirs = await agentOn(arranged, profile);
      const own = await registered(arranged, { kind: "ref", ref: REF }, mine.token);
      const other = await registered(
        arranged,
        { kind: "ref", ref: "github:pr:o/r#88" },
        theirs.token,
      );

      const items = await page(arranged, mine.token);
      expect(items.map((one) => one.id)).toEqual([own]);
      expect(items.map((one) => one.id)).not.toContain(other);
      const only = items[0]!;
      expect(only.target).toEqual({ kind: "ref", ref: REF });
      expect(only.condition).toBe(REF_CONDITION);
      expect(only.health).toEqual({ state: "ok" });
      expect(only.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  it("answers a session token naming another session's holder with that holder's", async () => {
    await withAgentFleet(async (arranged) => {
      const profile = await profileOf(arranged, "subscribers", [
        "subscription.write",
        "subscription.read",
      ]);
      const mine = await agentOn(arranged, profile);
      const theirs = await agentOn(arranged, profile);
      await registered(arranged, { kind: "ref", ref: REF }, mine.token);
      const other = await registered(
        arranged,
        { kind: "ref", ref: "github:pr:o/r#88" },
        theirs.token,
      );

      const items = await page(arranged, mine.token, theirs.session.id);
      expect(items.map((one) => one.id)).toEqual([other]);
      expect(items[0]!.holder).toEqual({ kind: "session", id: theirs.session.id });
    });
  });

  it("refuses a user credential that names no holder, saying one must be named", async () => {
    await withAgentFleet(async (arranged) => {
      const response = await listSubscriptions(arranged, arranged.token);
      const refused = await refusalOf(response.clone());
      expect(response.status, await response.clone().text()).toBe(400);
      expect(refused.code).toBe("validation");
      expect(refused.message).toMatch(/holder/i);
    });
  });
});

describe("subscription.cancel", () => {
  it("ends the subscription, with cancelled as the reason on the row", async () => {
    await withAgentFleet(async (arranged) => {
      const agent = await sessionHolding(arranged, "subscribers", [
        "subscription.write",
        "subscription.read",
      ]);
      const subscriptionId = await registered(arranged, { kind: "ref", ref: REF }, agent.token);

      const response = await cancel(arranged, subscriptionId, agent.token);
      expect(response.status, await response.clone().text()).toBe(200);

      // Read from the table rather than from `subscription.query`: whether a
      // query answers an ended subscription at all is not pinned anywhere,
      // and what this criterion is about is the row the matcher reads.
      const rows = await Effect.runPromise(
        Effect.orDie(
          arranged.harness.sql<{
            readonly ended_at: string | null;
            readonly ended_reason: string | null;
          }>`SELECT ended_at, ended_reason FROM subscriptions
             WHERE id = unhex(replace(${subscriptionId}, '-', ''))`,
        ),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.ended_at).not.toBeNull();
      expect(rows[0]!.ended_reason).toBe("cancelled");
    });
  });

  it("answers a second cancel of the same subscription with not found", async () => {
    await withAgentFleet(async (arranged) => {
      const agent = await sessionHolding(arranged, "subscribers", ["subscription.write"]);
      const subscriptionId = await registered(arranged, { kind: "ref", ref: REF }, agent.token);
      expect((await cancel(arranged, subscriptionId, agent.token)).status).toBe(200);

      const again = await cancel(arranged, subscriptionId, agent.token);
      expect(again.status, await again.clone().text()).toBe(404);
      expect((await refusalOf(again)).code).toBe("not_found");
    });
  });

  it("answers an id naming no subscription with not found", async () => {
    await withAgentFleet(async (arranged) => {
      const agent = await sessionHolding(arranged, "subscribers", ["subscription.write"]);
      // One live subscription stands beside it, so not-found is an answer
      // about this id and not about an empty table.
      await registered(arranged, { kind: "ref", ref: REF }, agent.token);

      const response = await cancel(arranged, ABSENT_ID, agent.token);
      expect(response.status, await response.clone().text()).toBe(404);
      expect((await refusalOf(response)).code).toBe("not_found");
    });
  });
});
