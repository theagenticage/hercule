/**
 * The steps of the first run the room specimen draws, in the order the first
 * run takes them, each with its name in the specimen's `?step=` and in the
 * Bureau book's desktop/first-run.html `?step=`. scripts/room-capture.ts
 * runs on Electron's Node and imports this file by its path, so it imports
 * nothing.
 */
export const ROOM_STEP_NAMES = [
  { name: "welcome", bookName: "welcome" },
  { name: "account", bookName: "account" },
  // The book still calls the providers step by its old name.
  { name: "providers", bookName: "harness" },
  { name: "github", bookName: "github" },
  { name: "project", bookName: "project" },
  { name: "done", bookName: "done" },
] as const;

/** A step's name in the room specimen's `?step=`. */
export type RoomStepName = (typeof ROOM_STEP_NAMES)[number]["name"];
