/**
 * Tests `decideThreadPose` and `decideThreadRowEnd`, which map a thread's
 * session and its runner to the pose its face shows and to what the end of
 * its sidebar row shows. The rules are checked in order, so each test names
 * the rule it proves, and the tests that combine two rules prove which one
 * wins.
 */
import { describe, expect, it } from "vitest";
import type { OpenRequest, Runner, Session } from "@hercule/contract";
import { decideThreadPose, decideThreadRowEnd, describePose, POSES, type Pose } from "./pose";
import { buildRunner, buildSession } from "./workspaces.testing";

const AT = "2026-09-10T09:00:00.000Z";

const REQUEST: OpenRequest = {
  requestId: "req-1",
  itemId: "tool-1",
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "git push" },
};

const ONLINE = buildRunner("r-moss", "moss");
const OFFLINE: Runner = { ...ONLINE, connectivity: "offline" };
const UNREACHABLE: Runner = { ...ONLINE, connectivity: "unreachable" };

const buildThread = (over: Partial<Session>): Session =>
  buildSession({ id: "s-1", lastActivityAt: AT, ...over });

/** Returns the pose and the row end of a thread together, so each case states both. */
const decideRow = (thread: Session, runner: Runner | undefined) => ({
  pose: decideThreadPose(thread, runner),
  end: decideThreadRowEnd(thread, runner),
});

describe("decideThreadPose and decideThreadRowEnd", () => {
  it("shows a thread with an open request as waiting, with the waiting mark", () => {
    expect(decideRow(buildThread({ status: "busy", openRequests: [REQUEST] }), ONLINE)).toEqual({
      pose: "waiting",
      end: { kind: "mark", mark: "waiting" },
    });
  });

  it("keeps a thread waiting when its runner is offline, because the request comes first", () => {
    expect(decideRow(buildThread({ status: "busy", openRequests: [REQUEST] }), OFFLINE)).toEqual({
      pose: "waiting",
      end: { kind: "mark", mark: "waiting" },
    });
  });

  it("shows a thread as waiting when only one of its subagents asked", () => {
    const asked = buildThread({
      status: "busy",
      openRequests: [{ ...REQUEST, subagentId: "a-1" }],
    });

    expect(decideRow(asked, ONLINE)).toEqual({
      pose: "waiting",
      end: { kind: "mark", mark: "waiting" },
    });
  });

  it("shows a held session as away, with its age", () => {
    expect(
      decideRow(buildThread({ status: "exited", resumable: true, resumeHeld: true }), ONLINE),
    ).toEqual({ pose: "away", end: { kind: "age", at: AT } });
  });

  it("shows an exited session that cannot be resumed as away, with its age and no mark", () => {
    expect(decideRow(buildThread({ status: "exited", resumable: false }), ONLINE)).toEqual({
      pose: "away",
      end: { kind: "age", at: AT },
    });
  });

  it("keeps the age of a thread that cannot be resumed even when its runner is offline", () => {
    expect(decideRow(buildThread({ status: "exited", resumable: false }), OFFLINE)).toEqual({
      pose: "away",
      end: { kind: "age", at: AT },
    });
  });

  it("shows a queued, starting, idle or busy session on a disconnected runner as away, with the word offline", () => {
    // A queued session shows "offline", not "queued": the runner being gone
    // matters more than the runner being full.
    for (const status of ["queued", "starting", "idle", "busy"] as const) {
      for (const runner of [OFFLINE, UNREACHABLE]) {
        expect(
          decideRow(buildThread({ status }), runner),
          `${status} ${runner.connectivity}`,
        ).toEqual({
          pose: "away",
          end: { kind: "word", word: "offline" },
        });
      }
    }
  });

  it("shows an exited resumable session on a disconnected runner as away, with its age", () => {
    for (const runner of [OFFLINE, UNREACHABLE]) {
      expect(decideRow(buildThread({ status: "exited", resumable: true }), runner)).toEqual({
        pose: "away",
        end: { kind: "age", at: AT },
      });
    }
  });

  it("shows an exited resumable session as asleep, with its age", () => {
    expect(decideRow(buildThread({ status: "exited", resumable: true }), ONLINE)).toEqual({
      pose: "asleep",
      end: { kind: "age", at: AT },
    });
  });

  it("shows a queued session as working, with the word queued", () => {
    expect(decideRow(buildThread({ status: "queued" }), ONLINE)).toEqual({
      pose: "working",
      end: { kind: "word", word: "queued" },
    });
  });

  it("shows a starting or busy session as working, with the working mark", () => {
    for (const status of ["starting", "busy"] as const) {
      expect(decideRow(buildThread({ status }), ONLINE)).toEqual({
        pose: "working",
        end: { kind: "mark", mark: "working" },
      });
    }
  });

  it("shows an idle session as idle, with its age", () => {
    expect(decideRow(buildThread({ status: "idle" }), ONLINE)).toEqual({
      pose: "idle",
      end: { kind: "age", at: AT },
    });
  });

  // A runner missing from the runners list is a cache that has not caught up,
  // not evidence that the machine is gone.
  it("treats a runner that is not in the runners list as connected", () => {
    expect(decideRow(buildThread({ status: "busy" }), undefined)).toEqual({
      pose: "working",
      end: { kind: "mark", mark: "working" },
    });
    expect(decideRow(buildThread({ status: "exited", resumable: true }), undefined)).toEqual({
      pose: "asleep",
      end: { kind: "age", at: AT },
    });
  });
});

describe("describePose", () => {
  it("gives every pose the words spec 17's pose table reads to assistive technology", () => {
    const words: Record<Pose, string> = {
      working: "working",
      waiting: "waiting on you",
      idle: "idle",
      asleep: "asleep",
      failed: "failed",
      paused: "paused",
      done: "done",
      away: "can't be reached",
    };
    expect(Object.fromEntries(POSES.map((pose) => [pose, describePose(pose)]))).toEqual(words);
  });
});
