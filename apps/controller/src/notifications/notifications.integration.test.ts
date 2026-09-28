/**
 * Tests the four notification operations over HTTP: the user lists and reads
 * notifications but may not create one, and a session creates a decision and
 * withdraws it.
 *
 * The cases with a session need a real fleet, because a session token is only
 * ever minted in a start frame on the runner socket. The mute key, the
 * run producer and the core's own methods are tested in `service.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import type { Notification, NotificationCreateInput } from "@hercule/contract";
import { completeSetup, get, post, readErrorBody, withServer } from "../http/testing";
import {
  createProfile,
  spawnAgentUnder,
  spawnAgentWithGrants,
  WAIT_DEADLINE_MS,
  withAgentFleet,
  type Arranged,
} from "../sessions/testing";
import type { NotificationPage } from "./index";

/** Gives each case three wait deadlines, plus ten seconds for starting the fleet, the slow part of a case. */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

/** A well-formed UUIDv7 that matches no notification on this controller. */
const ABSENT_ID = "0192f0a1-0000-7000-8000-00000000dead";

const DECISION: NotificationCreateInput = {
  kind: "triage.proposal",
  title: "Start a bugfix run for #42?",
  body: "The issue has a stack trace.",
  actions: [
    { id: "start", label: "Start Bugfix", operation: null, primary: true },
    { id: "dismiss", label: "Dismiss", operation: null },
  ],
};

const INFORMATIONAL: NotificationCreateInput = {
  kind: "triage.fyi",
  title: "Closed three duplicate issues",
};

const requestCreate = (base: string, token: string, input: unknown): Promise<Response> =>
  post(base, "/api/v1/notifications", input, token);

const requestWithdraw = (
  base: string,
  token: string,
  id: string,
  reason: string,
): Promise<Response> => post(base, `/api/v1/notifications/${id}/withdraw`, { reason }, token);

/** Creates a notification and returns its id. Fails the test unless the create succeeds. */
const createOrFail = async (
  base: string,
  token: string,
  input: NotificationCreateInput,
): Promise<string> => {
  const response = await requestCreate(base, token, input);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { notificationId: string }).notificationId;
};

/** Reads one notification. Fails the test unless the read succeeds. */
const readOrFail = async (base: string, token: string, id: string): Promise<Notification> => {
  const response = await get(base, `/api/v1/notifications/${id}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Notification;
};

/** Reads one page of notifications; `query` is the query string without its `?`. */
const listOrFail = async (base: string, token: string, query = ""): Promise<NotificationPage> => {
  const response = await get(
    base,
    `/api/v1/notifications${query === "" ? "" : `?${query}`}`,
    token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as NotificationPage;
};

/** Spawns a session whose profile may read and write notifications. */
const spawnNotifier = (arranged: Arranged) =>
  spawnAgentWithGrants(arranged, "notifiers", ["notification.read", "notification.write"]);

describe("the user", () => {
  it("lists and reads notifications, and is refused a create with 403 and the reason", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);

      expect(await listOrFail(base, token)).toEqual({ items: [] });

      const created = await requestCreate(base, token, INFORMATIONAL);
      const refused = await readErrorBody(created);
      expect(created.status, refused.text).toBe(403);
      expect(refused).toMatchObject({ code: "forbidden", grant: "notification.write" });
      expect(refused.message).toMatch(/message to you/);
      expect(await listOrFail(base, token)).toEqual({ items: [] });

      const missing = await get(base, `/api/v1/notifications/${ABSENT_ID}`, token);
      expect(missing.status).toBe(404);
      expect((await readErrorBody(missing)).code).toBe("not_found");
    });
  });
});

describe("a session", () => {
  it("creates a decision the user reads, and withdraws it once", async () => {
    await withAgentFleet(async (arranged) => {
      const base = arranged.harness.base;
      const agent = await spawnNotifier(arranged);

      const created = await requestCreate(base, agent.token, DECISION);
      expect(created.status, await created.clone().text()).toBe(200);
      // The CLI prints this shape, so it holds the id and nothing else.
      const body = (await created.json()) as { notificationId: string };
      expect(Object.keys(body)).toEqual(["notificationId"]);
      const id = body.notificationId;

      const stored = await readOrFail(base, arranged.token, id);
      expect(stored).toMatchObject({
        id,
        kind: DECISION.kind,
        title: DECISION.title,
        body: DECISION.body,
        producer: { type: "session", sessionId: agent.session.id },
        subject: [],
        actions: DECISION.actions!.map((action) => ({
          ...action,
          describeLine: [{ kind: "text", text: "Does nothing" }],
        })),
        status: "open",
      });
      expect(stored.resolution).toBeUndefined();
      expect(
        (await listOrFail(base, arranged.token, "status=open")).items.map((one) => one.id),
      ).toEqual([id]);

      const withdrawn = await requestWithdraw(base, agent.token, id, "answered in the session");
      expect(withdrawn.status, await withdrawn.clone().text()).toBe(200);
      const resolved = (await withdrawn.json()) as Notification;
      const stamp = `session:${agent.session.id}`;
      // A resolved decision's answers can no longer be taken, so they carry no describe line.
      expect(resolved).toEqual({
        ...stored,
        actions: DECISION.actions,
        status: "resolved",
        resolution: {
          kind: "withdrawn",
          actor: stamp,
          origin: stamp,
          reason: "answered in the session",
          at: resolved.resolution!.at,
        },
      });
      expect(await readOrFail(base, arranged.token, id)).toEqual(resolved);
      expect(await listOrFail(base, arranged.token, "status=open")).toEqual({ items: [] });

      const again = await requestWithdraw(base, agent.token, id, "answered again");
      const refused = await readErrorBody(again);
      expect(again.status, refused.text).toBe(409);
      expect(refused.code).toBe("invalid_state");
    });
  });

  it("pages the list newest first by default, and filters it by kind", async () => {
    await withAgentFleet(async (arranged) => {
      const base = arranged.harness.base;
      const agent = await spawnNotifier(arranged);
      const first = await createOrFail(base, agent.token, INFORMATIONAL);
      // Two creates in one millisecond would share a `createdAt`.
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = await createOrFail(base, agent.token, DECISION);

      const page = await listOrFail(base, arranged.token, "limit=1");
      expect(page.items.map((one) => one.id)).toEqual([second]);
      expect(page.nextCursor).toBeDefined();
      const next = await listOrFail(
        base,
        arranged.token,
        `limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`,
      );
      expect(next.items.map((one) => one.id)).toEqual([first]);
      expect(next.nextCursor).toBeUndefined();

      const oldest = await listOrFail(base, arranged.token, "sort=createdAt:asc");
      expect(oldest.items.map((one) => one.id)).toEqual([first, second]);
      const byKind = await listOrFail(base, arranged.token, `kind=${INFORMATIONAL.kind}`);
      expect(byKind.items.map((one) => one.id)).toEqual([first]);
    });
  });

  it("is refused a core.* kind, with the issue on kind", async () => {
    await withAgentFleet(async (arranged) => {
      const agent = await spawnNotifier(arranged);
      const response = await requestCreate(arranged.harness.base, agent.token, {
        ...INFORMATIONAL,
        kind: "core.run-failed",
      });
      const refused = await readErrorBody(response);
      expect(response.status, refused.text).toBe(400);
      expect(refused.code).toBe("validation");
      expect(refused.issues).toEqual([["kind"]]);
    });
  });

  it("is refused a create without notification.write, and a withdrawal of another session's decision", async () => {
    await withAgentFleet(async (arranged) => {
      const base = arranged.harness.base;
      const profile = await createProfile(arranged, "notifiers", [
        "notification.read",
        "notification.write",
      ]);
      const producer = await spawnAgentUnder(arranged, profile);
      const other = await spawnAgentUnder(arranged, profile);
      const reader = await spawnAgentWithGrants(arranged, "readers", ["notification.read"]);
      const id = await createOrFail(base, producer.token, DECISION);

      const created = await requestCreate(base, reader.token, INFORMATIONAL);
      const noGrant = await readErrorBody(created);
      expect(created.status, noGrant.text).toBe(403);
      expect(noGrant).toMatchObject({ code: "forbidden", grant: "notification.write" });

      const hidden = await requestWithdraw(base, other.token, id, "not mine");
      expect(hidden.status).toBe(404);
      const response = await requestWithdraw(base, arranged.token, id, "not mine");
      const refused = await readErrorBody(response);
      expect(response.status, refused.text).toBe(403);
      expect(refused.code).toBe("forbidden");
      expect(refused.message).toMatch(/only the producer/);
      expect((await readOrFail(base, arranged.token, id)).status).toBe("open");

      const missing = await requestWithdraw(base, producer.token, ABSENT_ID, "gone");
      expect(missing.status).toBe(404);
      expect((await readErrorBody(missing)).code).toBe("not_found");
    });
  });
});
