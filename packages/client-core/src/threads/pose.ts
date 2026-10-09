/**
 * A thread's pose: its state as a face shows it, and what the end of its
 * sidebar row shows (spec 17 §Design system). The mapping from a session to a
 * pose lives here, so every screen that draws a thread agrees on it.
 */
import type { Runner, Session } from "@hercule/contract";
import { isSettled } from "./status";

/** Every pose a face can show, in the order the Bureau book's crew.js lists them. */
export const POSES = [
  "working",
  "waiting",
  "idle",
  "asleep",
  "failed",
  "paused",
  "done",
  "away",
] as const;

/** A colleague's state, as its face shows it. */
export type Pose = (typeof POSES)[number];

/**
 * The poses a session can be in today: every pose but `failed`, `paused` and
 * `done`, which `decideThreadPose` never returns (see there).
 */
export type SessionPose = Exclude<Pose, "failed" | "paused" | "done">;

/** The words for each pose, as the Bureau book's `poseWord` in crew.js spells them. */
const POSE_WORDS: Readonly<Record<Pose, string>> = {
  working: "working",
  waiting: "waiting on you",
  idle: "idle",
  asleep: "asleep",
  failed: "failed",
  paused: "paused",
  done: "done",
  away: "can't be reached",
};

/** Returns the words that describe a pose to assistive technology, such as "waiting on you". */
export const describePose = (pose: Pose): string => POSE_WORDS[pose];

/** The poses of a colleague who is not at work: asleep, or out of reach. */
export type AbsentPose = Extract<Pose, "asleep" | "away">;

/**
 * Checks whether a colleague in `pose` is not at work: true for `asleep` and
 * `away`, false for every other pose. A face in an absent pose shows no
 * mark beside its state, because no mark stands for being gone; the face
 * itself shows it.
 */
export const isAbsentPose = (pose: Pose): pose is AbsentPose =>
  pose === "asleep" || pose === "away";

/**
 * Checks whether the session cannot run again until the user acts:
 *
 * - it has exited and cannot be resumed, so only a new thread can carry on
 *   its work; or
 * - the crash-loop guard holds it. It exited before it started a turn, so it
 *   is not resumed on its own, and the user's next message resumes it
 *   (spec 12 §5.1).
 */
const isStoppedUntilUserActs = (session: Session): boolean =>
  session.resumeHeld || isSettled(session);

/**
 * Checks whether the session's runner is known to be disconnected. A runner
 * missing from the runners list counts as connected, because a list that has
 * not caught up is no evidence that the machine is gone.
 */
const isRunnerDisconnected = (runner: Runner | undefined): boolean =>
  runner !== undefined && runner.connectivity !== "online";

/**
 * Returns the pose of a thread. The first rule that matches decides:
 *
 * - an open Request makes it `waiting`, whichever of the session's agents
 *   asked, even while its own agent is idle. An exited session never has
 *   one, so this never hides an ended thread;
 * - a session that cannot be resumed, or that the crash-loop guard holds, is
 *   `away` ("can't be reached"), because neither runs until the user acts;
 * - a session whose runner is offline or unreachable is `away`, because no
 *   message reaches it until the runner returns;
 * - an exited session that the next message resumes is `asleep`;
 * - an idle session is `idle`;
 * - a queued, starting or busy session is `working`.
 *
 * `failed`, `paused` and `done` are never returned: the session record does
 * not say why a session ended, so a row cannot claim any of them. #278 adds
 * that reason, and `failed` with it.
 */
export const decideThreadPose = (session: Session, runner: Runner | undefined): SessionPose => {
  if (session.openRequests.length > 0) return "waiting";
  if (isStoppedUntilUserActs(session) || isRunnerDisconnected(runner)) return "away";
  if (session.status === "exited") return "asleep";
  if (session.status === "idle") return "idle";
  return "working";
};

/**
 * What the end of a thread's sidebar row shows:
 *
 * - `mark`: the working or the waiting mark;
 * - `word`: a word in place of the age, "queued" or "offline";
 * - `age`: how long ago the thread was last active, formatted from `at` by
 *   `formatAge` with the caller's clock.
 */
export type ThreadRowEnd =
  | { readonly kind: "mark"; readonly mark: Extract<Pose, "working" | "waiting"> }
  | { readonly kind: "word"; readonly word: "queued" | "offline" }
  | { readonly kind: "age"; readonly at: string };

/**
 * Returns what the end of a thread's sidebar row shows, from the same rules as
 * `decideThreadPose`:
 *
 * - a waiting thread shows the waiting mark;
 * - an exited thread shows its age, whatever its runner. It is not running,
 *   so a disconnected runner changes nothing about it until the next message,
 *   and its face already says whether that message can reach it;
 * - a queued, starting, idle or busy thread on an offline or unreachable
 *   runner shows "offline";
 * - a queued thread shows "queued": its runner is connected but full;
 * - a starting or busy thread shows the working mark;
 * - any other thread, idle or held by the crash-loop guard, shows its age.
 */
export const decideThreadRowEnd = (session: Session, runner: Runner | undefined): ThreadRowEnd => {
  const age = { kind: "age", at: session.lastActivityAt } as const;
  switch (decideThreadPose(session, runner)) {
    case "waiting":
      return { kind: "mark", mark: "waiting" };
    case "away":
      return session.status !== "exited" && isRunnerDisconnected(runner)
        ? { kind: "word", word: "offline" }
        : age;
    case "working":
      return session.status === "queued"
        ? { kind: "word", word: "queued" }
        : { kind: "mark", mark: "working" };
    default:
      return age;
  }
};
