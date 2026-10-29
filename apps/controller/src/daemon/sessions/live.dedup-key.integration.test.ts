/**
 * Tests the `dedupKey` of `session.input`, over HTTP against a real controller
 * and one fake runner. A caller that retries after a timeout sends the same key
 * again, and must not send the message twice:
 *
 * - a repeat returns the first call's input id, stores nothing and sends
 *   nothing to the runner;
 * - what the repeat answers follows the input: `queued` while it waits, its
 *   delivery once the runner took it, and `invalid_state` after it was
 *   cancelled;
 * - a key belongs to the actor, not to the input's owner or the target session;
 * - a repeat is checked after the operation's grant (`session.steer`, which `session.input` needs).
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionInput } from "@hercule/protocol";
import type { Grant, Session } from "@hercule/contract";
import { post, readErrorBody, send } from "../../http/testing";
import {
  WAIT_DEADLINE_MS,
  createProfile,
  listFrames,
  listInputs,
  reportTurnCompleted,
  spawnThreadUnder,
  spawnThreadWithGrants,
  waitForSession,
  waitUntil,
  withAgentFleet,
  type Arranged,
} from "../../sessions/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

const KEY = "retry-1";

interface InputAnswer {
  readonly inputId: string;
  readonly result: string;
}

/** Sends a keyed input to a session as the holder of `token`, queued behind the session's running turn. */
const sendKeyed = (
  arranged: Arranged,
  sessionId: string,
  token: string,
  fields: Record<string, unknown> = {},
): Promise<Response> =>
  post(
    arranged.harness.base,
    `/api/v1/sessions/${sessionId}/input`,
    { text: "rebase now", steer: false, dedupKey: KEY, ...fields },
    token,
  );

/** Sends a keyed input and returns the answer, failing the test on any refusal. */
const sendKeyedOrFail = async (
  arranged: Arranged,
  sessionId: string,
  token: string = arranged.token,
  fields: Record<string, unknown> = {},
): Promise<InputAnswer> => {
  const response = await sendKeyed(arranged, sessionId, token, fields);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as InputAnswer;
};

/** Spawns a Thread that is busy with its prompt's turn, which ends at sequence number 2. */
const spawnBusyThread = async (arranged: Arranged): Promise<Session> =>
  (await spawnThreadWithGrants(arranged, `target-${crypto.randomUUID()}`, [])).session;

describe("session.input with a dedupKey", () => {
  it("returns the first input and sends nothing to the runner on a repeat", async () => {
    await withAgentFleet(async (arranged) => {
      const target = await spawnBusyThread(arranged);
      reportTurnCompleted(arranged, target.id, 2);
      await waitForSession(arranged, target.id, (one) => one.status === "idle");

      const first = await sendKeyedOrFail(arranged, target.id, arranged.token, { steer: true });
      const repeat = await sendKeyedOrFail(arranged, target.id, arranged.token, { steer: true });

      expect(first.result).toBe("opened");
      expect(repeat).toEqual(first);
      expect(listFrames<SessionInput>(arranged.wire, "sessionInput")).toHaveLength(1);
      // The prompt, and the one input.
      expect(await listInputs(arranged, target.id)).toHaveLength(2);
    });
  });

  it("answers queued while the input waits, and its delivery once the runner took it", async () => {
    await withAgentFleet(async (arranged) => {
      const target = await spawnBusyThread(arranged);
      const first = await sendKeyedOrFail(arranged, target.id);
      expect(first.result).toBe("queued");

      expect(await sendKeyedOrFail(arranged, target.id)).toEqual(first);
      expect(listFrames<SessionInput>(arranged.wire, "sessionInput")).toHaveLength(0);

      reportTurnCompleted(arranged, target.id, 2);
      await waitUntil("delivered the queued input", async () =>
        (await listInputs(arranged, target.id)).find(
          (one) => one.id === first.inputId && one.status === "delivered",
        ),
      );

      expect(await sendKeyedOrFail(arranged, target.id)).toEqual({
        inputId: first.inputId,
        result: "opened",
      });
      expect(listFrames<SessionInput>(arranged.wire, "sessionInput")).toHaveLength(1);
    });
  });

  it("fails a repeat of a cancelled input with invalid_state, naming the input", async () => {
    await withAgentFleet(async (arranged) => {
      const target = await spawnBusyThread(arranged);
      const first = await sendKeyedOrFail(arranged, target.id);
      const cancelled = await send(
        "DELETE",
        arranged.harness.base,
        `/api/v1/sessions/${target.id}/inputs/${first.inputId}`,
        { token: arranged.token },
      );
      expect(cancelled.status, await cancelled.clone().text()).toBe(200);

      const repeat = await sendKeyed(arranged, target.id, arranged.token);

      expect(repeat.status).toBe(409);
      const refused = await readErrorBody(repeat);
      expect(refused.code).toBe("invalid_state");
      expect(refused.message).toContain(first.inputId);
      expect(await listInputs(arranged, target.id)).toHaveLength(2);
    });
  });

  it("sends a second input for the same key from another actor", async () => {
    await withAgentFleet(async (arranged) => {
      const target = await spawnBusyThread(arranged);
      const sender = await spawnThreadWithGrants(arranged, "messenger", ["session.steer"]);

      const byUser = await sendKeyedOrFail(arranged, target.id);
      const bySession = await sendKeyedOrFail(arranged, target.id, sender.token);

      expect(bySession.inputId).not.toBe(byUser.inputId);
      // The prompt, and one input per actor.
      expect(await listInputs(arranged, target.id)).toHaveLength(3);
    });
  });

  it("keeps the key when a user edits the queued input, which rewrites its actor", async () => {
    await withAgentFleet(async (arranged) => {
      const target = await spawnBusyThread(arranged);
      const sender = await spawnThreadWithGrants(arranged, "messenger", ["session.steer"]);
      const first = await sendKeyedOrFail(arranged, target.id, sender.token);

      const edited = await send(
        "PATCH",
        arranged.harness.base,
        `/api/v1/sessions/${target.id}/inputs/${first.inputId}`,
        { token: arranged.token, body: { text: "rebase tomorrow" } },
      );
      expect(edited.status, await edited.clone().text()).toBe(200);
      const stored = (await listInputs(arranged, target.id)).find(
        (one) => one.id === first.inputId,
      );
      expect(stored?.actor).toBe("user");

      expect(await sendKeyedOrFail(arranged, target.id, sender.token)).toEqual(first);
      expect(await listInputs(arranged, target.id)).toHaveLength(2);
    });
  });

  it("returns the first input for a repeat that names another session", async () => {
    await withAgentFleet(async (arranged) => {
      const first = await spawnBusyThread(arranged);
      const other = await spawnBusyThread(arranged);

      const answer = await sendKeyedOrFail(arranged, first.id);
      const repeat = await sendKeyedOrFail(arranged, other.id);

      expect(repeat).toEqual(answer);
      // The other session got its prompt only.
      expect(await listInputs(arranged, other.id)).toHaveLength(1);
    });
  });

  it("refuses a repeat from a caller whose session.steer grant is gone", async () => {
    await withAgentFleet(async (arranged) => {
      const target = await spawnBusyThread(arranged);
      const grants: ReadonlyArray<Grant> = ["session.steer"];
      const profile = await createProfile(arranged, "messengers", grants);
      const sender = await spawnThreadUnder(arranged, profile);
      await sendKeyedOrFail(arranged, target.id, sender.token);

      const edited = await send("PATCH", arranged.harness.base, `/api/v1/profiles/${profile.id}`, {
        body: { grants: ["task.read"] },
        token: arranged.token,
      });
      expect(edited.status, await edited.clone().text()).toBe(200);
      const repeat = await sendKeyed(arranged, target.id, sender.token);

      expect(repeat.status).toBe(403);
      expect(await readErrorBody(repeat)).toMatchObject({
        code: "forbidden",
        grant: "session.steer",
      });
    });
  });
});
