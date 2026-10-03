/**
 * Tests the world the Office draws. The tests check that:
 *
 * - the Lounge holds the idle threads, and no working or waiting one;
 * - a thread that changes pose keeps the desk key, so the Office plays the
 *   change on the built office instead of rebuilding it;
 * - a new thread changes the desk key, so the Office is rebuilt.
 */
import { describe, expect, it } from "vitest";
import type { OpenRequest, Session } from "@hercule/contract";
import {
  MOSS,
  OPS_PROJECT,
  PRIMARY,
  THREAD_3F1,
  WEBSHOP_PROJECT,
  buildSession,
} from "@hercule/client-core/threads/testing";
import { buildWorld, computeDeskKey } from "./build-world";

const REQUEST: OpenRequest = {
  requestId: "req-1",
  itemId: "tool-1",
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "git push" },
};

/** Returns the world for `sessions` in the fixture fleet. */
const build = (sessions: readonly Session[]) =>
  buildWorld(
    {
      sessions,
      projects: [WEBSHOP_PROJECT, OPS_PROJECT],
      workspaces: [PRIMARY, THREAD_3F1],
      runners: [MOSS],
      localRunnerId: MOSS.id,
    },
    Date.parse("2026-09-10T10:00:00.000Z"),
  );

const working = buildSession({ id: "s-working", status: "busy", runnerId: MOSS.id });
const idle = buildSession({ id: "s-idle", status: "idle", runnerId: MOSS.id });

describe("buildWorld", () => {
  it("seats the idle threads in the Lounge, and no working or waiting one", () => {
    const waiting = buildSession({
      id: "s-waiting",
      status: "busy",
      runnerId: MOSS.id,
      openRequest: REQUEST,
    });

    expect(build([working, idle, waiting]).lounge).toEqual(["s-idle"]);
  });
});

describe("computeDeskKey", () => {
  it("keeps the key when a thread only changes pose, so the Office does not rebuild", () => {
    const before = build([working, idle]);
    const after = build([
      { ...working, openRequest: REQUEST },
      { ...idle, status: "busy" },
    ]);

    // Desks are in creation order, then by id: s-idle before s-working.
    expect(after.colleagues.map((colleague) => colleague.pose)).toEqual(["working", "waiting"]);
    expect(computeDeskKey(after)).toBe(computeDeskKey(before));
  });

  it("changes the key when a thread gets a desk", () => {
    const another = buildSession({ id: "s-another", status: "busy", runnerId: MOSS.id });

    expect(computeDeskKey(build([working, idle, another]))).not.toBe(
      computeDeskKey(build([working, idle])),
    );
  });
});
