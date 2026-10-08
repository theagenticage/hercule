/**
 * Tests `buildThreadRows(sessions, mode, runners)`, which turns sessions into
 * the rows the sidebar and All sessions render, most recently active first.
 */
import { describe, expect, it } from "vitest";
import type { Runner, Session, SessionStatus } from "@hercule/contract";
import { buildInstance, buildSnapshot } from "../providers.testing";
import { buildThreadRows } from "./rows";
import { buildRunner } from "./workspaces.testing";

/** The instance whose catalog gives rows their model names. It offers two models. */
const CLAUDE = buildInstance("claude-code", "Claude Code", [
  buildSnapshot({
    models: [
      { slug: "default", name: "Default (recommended)", acceptsImages: true, options: [] },
      { slug: "claude-opus-5", name: "Claude Opus 5", acceptsImages: true, options: [] },
    ],
  }),
]);

type Mark = "working" | "idle" | "exited";

const BASE: Session = {
  id: "s0",
  title: "Fix the login bug",
  status: "idle",
  resumable: false,
  resumeHeld: false,
  permissionProfileId: "profile-unrestricted",
  agentId: null,
  conversationId: null,
  runId: null,
  stepId: null,
  instanceId: "instance-claude-code",
  runnerId: "runner-1",
  workspaceId: null,
  projectId: null,
  requestedAccessMode: "approval-required",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-sonnet-5", options: {} },
  parentSessionId: null,
  openRequests: [],
  createdAt: "2026-09-08T09:00:00.000Z",
  startedAt: "2026-09-08T09:00:01.000Z",
  exitedAt: null,
  lastActivityAt: "2026-09-08T09:05:00.000Z",
  unenforced: [],
};

const buildSession = (overrides: Partial<Session> & { id: string }): Session => ({
  ...BASE,
  ...overrides,
});

describe("buildThreadRows", () => {
  it.each<[SessionStatus, Mark]>([
    ["busy", "working"],
    ["starting", "working"],
    ["queued", "working"],
    ["idle", "idle"],
    ["exited", "exited"],
  ])("marks a %s session as %s", (status, mark) => {
    const rows = buildThreadRows([buildSession({ id: "s1", status })], "plain", []);
    expect(rows[0]).toMatchObject({ id: "s1", mark });
  });

  it("marks an exited session that can be resumed as idle, and one that cannot as exited", () => {
    const resumable = buildThreadRows(
      [buildSession({ id: "s1", status: "exited", resumable: true, nativeSessionId: "n" })],
      "plain",
      [],
    );
    expect(resumable[0]).toMatchObject({ id: "s1", mark: "idle" });

    const gone = buildThreadRows(
      [buildSession({ id: "s2", status: "exited", resumable: false })],
      "plain",
      [],
    );
    expect(gone[0]).toMatchObject({ id: "s2", mark: "exited" });
  });

  it("passes the session's title through, and lastActivityAt unformatted as activityAt", () => {
    const rows = buildThreadRows(
      [
        buildSession({
          id: "s1",
          title: "Fix the login bug",
          lastActivityAt: "2026-09-08T09:05:00.000Z",
        }),
      ],
      "plain",
      [],
    );
    expect(rows[0]).toMatchObject({
      id: "s1",
      title: "Fix the login bug",
      activityAt: "2026-09-08T09:05:00.000Z",
    });
  });

  it("shows the model's catalog name on the second line in meta mode", () => {
    const rows = buildThreadRows(
      [
        buildSession({
          id: "s1",
          instanceId: CLAUDE.id,
          modelSelection: { model: "claude-opus-5", options: {} },
        }),
      ],
      "meta",
      [],
      [CLAUDE],
    );
    expect(rows[0]!.secondLine).toBe("Claude Opus 5");
  });

  it("shows the provider's default model by its display name rather than the word default", () => {
    const rows = buildThreadRows(
      [
        buildSession({
          id: "s1",
          instanceId: CLAUDE.id,
          modelSelection: { model: "default", options: {} },
        }),
      ],
      "meta",
      [],
      [CLAUDE],
    );
    expect(rows[0]!.secondLine).toBe("Default (recommended)");
  });

  it("falls back to the slug for a model that no catalog offers", () => {
    const rows = buildThreadRows(
      [
        buildSession({
          id: "s1",
          instanceId: CLAUDE.id,
          modelSelection: { model: "claude-opus-4-8", options: {} },
        }),
      ],
      "meta",
      [],
      [CLAUDE],
    );
    expect(rows[0]!.secondLine).toBe("claude-opus-4-8");
  });

  it("has no second line in plain mode", () => {
    const rows = buildThreadRows(
      [buildSession({ id: "s1", modelSelection: { model: "claude-opus-5", options: {} } })],
      "plain",
      [],
    );
    expect(rows[0]!.secondLine).toBeNull();
  });

  it("sorts rows by lastActivityAt, most recently active first", () => {
    const older = buildSession({ id: "older", lastActivityAt: "2026-09-08T09:00:00.000Z" });
    const newest = buildSession({ id: "newest", lastActivityAt: "2026-09-08T11:00:00.000Z" });
    const middle = buildSession({ id: "middle", lastActivityAt: "2026-09-08T10:00:00.000Z" });

    const rows = buildThreadRows([older, newest, middle], "plain", []);

    expect(rows.map((row) => row.id)).toEqual(["newest", "middle", "older"]);
  });

  it("sorts rows active at the same moment by session id, whatever order they come in", () => {
    const at = "2026-09-08T09:00:00.000Z";
    const sessions = ["s-c", "s-a", "s-b"].map((id) => buildSession({ id, lastActivityAt: at }));

    expect(buildThreadRows(sessions, "plain", []).map((row) => row.id)).toEqual([
      "s-a",
      "s-b",
      "s-c",
    ]);
    expect(buildThreadRows(sessions.toReversed(), "plain", []).map((row) => row.id)).toEqual([
      "s-a",
      "s-b",
      "s-c",
    ]);
  });

  it("ends a queued row in queued, and any row on a disconnected runner in offline", () => {
    const offline: Runner = { ...buildRunner("runner-2", "moss"), connectivity: "offline" };
    const rows = buildThreadRows(
      [
        buildSession({
          id: "queued",
          status: "queued",
          lastActivityAt: "2026-09-08T11:00:00.000Z",
        }),
        buildSession({ id: "busy", status: "busy", lastActivityAt: "2026-09-08T10:00:00.000Z" }),
        buildSession({ id: "away", status: "busy", runnerId: "runner-2" }),
      ],
      "plain",
      [offline],
    );

    expect(rows.map((row) => [row.id, row.end])).toEqual([
      ["queued", { kind: "word", word: "queued" }],
      ["busy", { kind: "mark", mark: "working" }],
      ["away", { kind: "word", word: "offline" }],
    ]);
  });
});
