/**
 * `threadRows(sessions, mode)` turns sessions into the rows the sidebar and
 * All sessions render, sorted most-recently-active first.
 */
import { describe, expect, it } from "vitest";
import type { Session, SessionStatus } from "@hydra/contract";
import { instance, snapshot } from "../providers.testing";
import { threadRows } from "./rows";

/** The one instance a row's model is named from, offering two models. */
const CLAUDE = instance("claude-code", "Claude Code", [
  snapshot({
    models: [
      { slug: "default", name: "Default (recommended)", options: [] },
      { slug: "claude-opus-5", name: "Claude Opus 5", options: [] },
    ],
  }),
]);

type Mark = "working" | "idle" | "exited";

const BASE: Session = {
  id: "s0",
  title: "Fix the login bug",
  status: "idle",
  resumable: false,
  permissionProfileId: "profile-unrestricted",
  instanceId: "instance-claude-code",
  runnerId: "runner-1",
  workspaceId: null,
  projectId: null,
  requestedAccessMode: "approval-required",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-sonnet-5", options: {} },
  parentSessionId: null,
  openRequest: null,
  createdAt: "2026-09-08T09:00:00.000Z",
  startedAt: "2026-09-08T09:00:01.000Z",
  exitedAt: null,
  lastActivityAt: "2026-09-08T09:05:00.000Z",
};

const session = (overrides: Partial<Session> & { id: string }): Session => ({
  ...BASE,
  ...overrides,
});

describe("threadRows", () => {
  it.each<[SessionStatus, Mark]>([
    ["busy", "working"],
    ["starting", "working"],
    ["queued", "working"],
    ["idle", "idle"],
    ["exited", "exited"],
  ])("marks a %s session as %s", (status, mark) => {
    const rows = threadRows([session({ id: "s1", status })], "plain");
    expect(rows[0]).toMatchObject({ id: "s1", mark });
  });

  it("marks an exited session that can be resumed as idle, and one that cannot as exited", () => {
    const resumable = threadRows(
      [session({ id: "s1", status: "exited", resumable: true, nativeSessionId: "n" })],
      "plain",
    );
    expect(resumable[0]).toMatchObject({ id: "s1", mark: "idle" });

    const gone = threadRows([session({ id: "s2", status: "exited", resumable: false })], "plain");
    expect(gone[0]).toMatchObject({ id: "s2", mark: "exited" });
  });

  it("carries the session's title and lastActivityAt through as activityAt, raw and unformatted", () => {
    const rows = threadRows(
      [
        session({
          id: "s1",
          title: "Fix the login bug",
          lastActivityAt: "2026-09-08T09:05:00.000Z",
        }),
      ],
      "plain",
    );
    expect(rows[0]).toMatchObject({
      id: "s1",
      title: "Fix the login bug",
      activityAt: "2026-09-08T09:05:00.000Z",
    });
  });

  it("names the model on the second line as the catalog names it, in meta mode", () => {
    const rows = threadRows(
      [
        session({
          id: "s1",
          instanceId: CLAUDE.id,
          modelSelection: { model: "claude-opus-5", options: {} },
        }),
      ],
      "meta",
      [CLAUDE],
    );
    expect(rows[0]!.secondLine).toBe("Claude Opus 5");
  });

  it("names the provider's own default by its display name rather than the word default", () => {
    const rows = threadRows(
      [
        session({
          id: "s1",
          instanceId: CLAUDE.id,
          modelSelection: { model: "default", options: {} },
        }),
      ],
      "meta",
      [CLAUDE],
    );
    expect(rows[0]!.secondLine).toBe("Default (recommended)");
  });

  it("falls back to the slug for a model no catalog on offer holds", () => {
    const rows = threadRows(
      [
        session({
          id: "s1",
          instanceId: CLAUDE.id,
          modelSelection: { model: "claude-opus-4-8", options: {} },
        }),
      ],
      "meta",
      [CLAUDE],
    );
    expect(rows[0]!.secondLine).toBe("claude-opus-4-8");
  });

  it("has no second line in plain mode", () => {
    const rows = threadRows(
      [session({ id: "s1", modelSelection: { model: "claude-opus-5", options: {} } })],
      "plain",
    );
    expect(rows[0]!.secondLine).toBeNull();
  });

  it("sorts rows by lastActivityAt, most recently active first", () => {
    const older = session({ id: "older", lastActivityAt: "2026-09-08T09:00:00.000Z" });
    const newest = session({ id: "newest", lastActivityAt: "2026-09-08T11:00:00.000Z" });
    const middle = session({ id: "middle", lastActivityAt: "2026-09-08T10:00:00.000Z" });

    const rows = threadRows([older, newest, middle], "plain");

    expect(rows.map((row) => row.id)).toEqual(["newest", "middle", "older"]);
  });
});
