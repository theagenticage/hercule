/**
 * The states of the first run the first-run specimen draws, each with the
 * state of the Bureau book's desktop/first-run.html it is compared with.
 * scripts/first-run-capture.ts runs on Electron's Node and imports this file
 * by its path, so it imports nothing.
 *
 * Each entry has:
 *
 * - `step` and `state`: the specimen's `?step=` and `?state=`, and the
 *   capture's file name, `<step>-<state>`;
 * - `book`: the book's `?step=`, `?state=` and any further query, such as
 *   `github=skipped` for a step the user put off, or null when the book
 *   draws no such state.
 *
 * Where the two differ:
 *
 * - The book still calls the providers step by its old name, `harness`.
 * - The app's `providers-waiting`, the step before the runner has joined,
 *   is not in the book.
 * - The app's `welcome-not-installed` is drawn like a start error, so it is
 *   compared with the book's `start-error`.
 * - The book's `already-set-up` and `remote-set-up` have no state in the
 *   app: a controller that is set up opens on the sign-in screen.
 */
export const FIRST_RUN_STATES = [
  { step: "welcome", state: "searching", book: { step: "welcome", state: "searching" } },
  { step: "welcome", state: "fresh", book: { step: "welcome", state: "fresh" } },
  { step: "welcome", state: "starting", book: { step: "welcome", state: "starting" } },
  { step: "welcome", state: "start-failed", book: { step: "welcome", state: "start-failed" } },
  { step: "welcome", state: "start-error", book: { step: "welcome", state: "start-error" } },
  { step: "welcome", state: "not-installed", book: { step: "welcome", state: "start-error" } },
  { step: "welcome", state: "runner", book: { step: "welcome", state: "runner" } },
  { step: "welcome", state: "found", book: { step: "welcome", state: "found" } },
  { step: "welcome", state: "remote", book: { step: "welcome", state: "remote" } },
  {
    step: "welcome",
    state: "remote-not-set-up",
    book: { step: "welcome", state: "remote-not-set-up" },
  },
  { step: "account", state: "default", book: { step: "account", state: "default" } },
  { step: "account", state: "error", book: { step: "account", state: "error" } },
  { step: "account", state: "submitting", book: { step: "account", state: "submitting" } },
  { step: "providers", state: "waiting", book: null },
  { step: "providers", state: "idle", book: { step: "harness", state: "idle" } },
  { step: "providers", state: "claude-paste", book: { step: "harness", state: "claude-paste" } },
  { step: "providers", state: "claude-error", book: { step: "harness", state: "claude-error" } },
  { step: "providers", state: "codex-device", book: { step: "harness", state: "codex-device" } },
  { step: "providers", state: "ready", book: { step: "harness", state: "ready" } },
  { step: "providers", state: "none-found", book: { step: "harness", state: "none-found" } },
  { step: "github", state: "empty", book: { step: "github", state: "empty" } },
  { step: "github", state: "code", book: { step: "github", state: "code" } },
  { step: "github", state: "connected", book: { step: "github", state: "connected" } },
  { step: "github", state: "expired", book: { step: "github", state: "expired" } },
  { step: "github", state: "denied", book: { step: "github", state: "denied" } },
  { step: "github", state: "failed", book: { step: "github", state: "failed" } },
  { step: "github", state: "token", book: { step: "github", state: "token" } },
  { step: "github", state: "token-checking", book: { step: "github", state: "token-checking" } },
  { step: "github", state: "token-refused", book: { step: "github", state: "token-refused" } },
  { step: "project", state: "empty", book: { step: "project", state: "empty" } },
  { step: "project", state: "picked", book: { step: "project", state: "picked" } },
  { step: "project", state: "no-remote", book: { step: "project", state: "no-remote" } },
  { step: "project", state: "not-git", book: { step: "project", state: "not-git" } },
  {
    step: "project",
    state: "picked-without-github",
    book: { step: "project", state: "picked", query: "github=skipped" },
  },
  { step: "done", state: "default", book: { step: "done", state: "default" } },
  {
    step: "done",
    state: "put-off",
    book: { step: "done", state: "default", query: "github=skipped&harness=later" },
  },
] as const;

type FirstRunStateEntry = (typeof FIRST_RUN_STATES)[number];

/**
 * A state's name, `<step>-<state>`, such as `welcome-fresh`. The conditional
 * type runs once per entry, so only the pairs in FIRST_RUN_STATES are names,
 * not every step with every state.
 */
export type FirstRunStateName = FirstRunStateEntry extends infer Entry
  ? Entry extends {
      readonly step: infer Step extends string;
      readonly state: infer State extends string;
    }
    ? `${Step}-${State}`
    : never
  : never;
