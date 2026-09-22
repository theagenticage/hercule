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
import { del, get, post, readRefusal } from "../http/testing";
import {
  agentHolding,
  agentOn,
  createProfile,
  WAIT_DEADLINE_MS,
  withAgentFleet,
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
 * `<kind>:<id>` shorthand the target shorthand already uses.
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

/** One subscription's end, as the row records it. */
interface EndRow {
  readonly ended_at: string | null;
  readonly ended_reason: string | null;
  readonly ended_actor: string | null;
}

/**
 * How a subscription ended, read from the table rather than from
 * `subscription.query`: whether a query answers an ended subscription at all
 * is not pinned anywhere, and what these criteria are about is the row the
 * matcher reads.
 */
const readEndRow = (arranged: Arranged, id: string): Promise<ReadonlyArray<EndRow>> =>
  Effect.runPromise(
    Effect.orDie(
      arranged.harness.sql<EndRow>`
        SELECT ended_at, ended_reason, ended_actor FROM subscriptions
        WHERE id = unhex(replace(${id}, '-', ''))`,
    ),
  );

const cancel = (arranged: Arranged, id: string, token: string): Promise<Response> =>
  del(arranged.harness.base, `/api/v1/subscriptions/${id}`, token);

/**
 * One refusal, as the code it carries and the text a person reads. It takes
 * anything that answers with a body, because a caller that has already read
 * the text hands over a clone, whose type is not the harness's `Response`.
 */
describe("subscription.create", () => {
  it("stores the target, its expansion, and the session that asked, as live", async () => {
    await withAgentFleet(async (arranged) => {
      const agent = await agentHolding(arranged, "subscribers", [
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
      const agent = await agentHolding(arranged, "subscribers", ["subscription.write"]);
      const cases: ReadonlyArray<readonly [unknown, RegExp]> = [
        [{ kind: "run", runId: "r_3" }, /run/i],
        [{ kind: "session", sessionId: agent.session.id }, /session/i],
        [{ kind: "request", requestId: "pr_7" }, /permission request/i],
      ];
      for (const [target, names] of cases) {
        const response = await createSubscription(arranged, target, agent.token);
        const refused = await readRefusal(response);
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
      const refused = await readRefusal(response);
      expect(response.status, refused.text).toBe(400);
      expect(refused.code).toBe("validation");
      expect(refused.message).toMatch(/session/i);
    });
  });
});

describe("subscription.query", () => {
  it("answers a session token naming no holder with that session's own, and nothing else", async () => {
    await withAgentFleet(async (arranged) => {
      const profile = await createProfile(arranged, "subscribers", [
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
      const profile = await createProfile(arranged, "subscribers", [
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
      const refused = await readRefusal(response);
      expect(response.status, refused.text).toBe(400);
      expect(refused.code).toBe("validation");
      expect(refused.message).toMatch(/holder/i);
    });
  });
});

describe("subscription.cancel", () => {
  it("ends the subscription, with cancelled as the reason on the row", async () => {
    await withAgentFleet(async (arranged) => {
      const agent = await agentHolding(arranged, "subscribers", [
        "subscription.write",
        "subscription.read",
      ]);
      const subscriptionId = await registered(arranged, { kind: "ref", ref: REF }, agent.token);

      const response = await cancel(arranged, subscriptionId, agent.token);
      expect(response.status, await response.clone().text()).toBe(200);

      const rows = await readEndRow(arranged, subscriptionId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.ended_at).not.toBeNull();
      expect(rows[0]!.ended_reason).toBe("cancelled");
      // Who ended it is stamped like every other mutation: the session that
      // called, by the same `session:<id>` stamp its own writes carry.
      expect(rows[0]!.ended_actor).toBe(`session:${agent.session.id}`);
    });
  });

  it("answers a second cancel of the same subscription with not found", async () => {
    await withAgentFleet(async (arranged) => {
      const agent = await agentHolding(arranged, "subscribers", ["subscription.write"]);
      const subscriptionId = await registered(arranged, { kind: "ref", ref: REF }, agent.token);
      expect((await cancel(arranged, subscriptionId, agent.token)).status).toBe(200);

      const again = await cancel(arranged, subscriptionId, agent.token);
      const refused = await readRefusal(again);
      expect(again.status, refused.text).toBe(404);
      expect(refused.code).toBe("not_found");
    });
  });

  it("answers an id naming no subscription with not found", async () => {
    await withAgentFleet(async (arranged) => {
      const agent = await agentHolding(arranged, "subscribers", ["subscription.write"]);
      // One live subscription stands beside it, so not-found is an answer
      // about this id and not about an empty table.
      await registered(arranged, { kind: "ref", ref: REF }, agent.token);

      const response = await cancel(arranged, ABSENT_ID, agent.token);
      const refused = await readRefusal(response);
      expect(response.status, refused.text).toBe(404);
      expect(refused.code).toBe("not_found");
    });
  });
});

/**
 * Added beside the criteria: a subscription belongs to the session that made
 * it, and `subscription.cancel` carries only an id, so nothing but the
 * credential can keep one session from ending another's claim.
 */
describe("whose subscription a session may cancel", () => {
  it("refuses another session's, leaving it live, and answers as for an unknown id", async () => {
    await withAgentFleet(async (arranged) => {
      const profile = await createProfile(arranged, "subscribers", [
        "subscription.write",
        "subscription.read",
      ]);
      const mine = await agentOn(arranged, profile);
      const theirs = await agentOn(arranged, profile);
      const other = await registered(arranged, { kind: "ref", ref: REF }, theirs.token);

      const response = await cancel(arranged, other, mine.token);
      const refused = await readRefusal(response);
      expect(response.status, refused.text).toBe(404);
      expect(refused.code).toBe("not_found");

      // Still waiting, and still its own holder's to cancel.
      expect((await page(arranged, theirs.token)).map((one) => one.id)).toEqual([other]);
      expect((await cancel(arranged, other, theirs.token)).status).toBe(200);
    });
  });

  it("lets the user cancel a session's subscription", async () => {
    await withAgentFleet(async (arranged) => {
      const agent = await agentHolding(arranged, "subscribers", [
        "subscription.write",
        "subscription.read",
      ]);
      const subscriptionId = await registered(arranged, { kind: "ref", ref: REF }, agent.token);

      const response = await cancel(arranged, subscriptionId, arranged.token);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await page(arranged, agent.token)).toEqual([]);
      // The user's own stamp, not the holder's: the row says who ended it and
      // not merely who was waiting on it.
      expect((await readEndRow(arranged, subscriptionId))[0]!.ended_actor).toBe("user");
    });
  });
});
