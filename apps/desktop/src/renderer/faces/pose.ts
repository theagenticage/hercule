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

/** The six states that have a mark. Asleep and away have none. */
export type MarkState = Exclude<Pose, "asleep" | "away">;

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
export function describePose(pose: Pose): string {
  return POSE_WORDS[pose];
}
