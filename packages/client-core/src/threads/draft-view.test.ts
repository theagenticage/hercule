/**
 * Tests `buildDraftView`, which the draft screen and the sidebar's draft row
 * both read. The tests check the words the lip shows for the workspace and
 * the machine, the sidebar row's words, and the group the row sits in. The
 * row's machine is always the part of its third line that is never cut short:
 *
 * - before any pick, and after one;
 * - when the draft joins a workspace, whose machine the lip names plainly;
 * - when the draft has no project, and so no checkout;
 * - the model's display name on the sidebar row, before and after a model pick.
 */
import { describe, expect, it } from "vitest";
import type { Profile, SettingsState } from "@hercule/contract";
import { buildInstance, buildSnapshot } from "../providers.testing";
import { buildDraftView, type DraftReads } from "./draft-view";
import {
  COVE,
  INFRA,
  MOSS,
  OPS_PROJECT,
  PRIMARY,
  RUNBOOKS,
  THREAD_3F1,
  WEBSHOP,
  WEBSHOP_PROJECT,
} from "./workspaces.testing";

const SETTINGS: SettingsState = { controller: {}, user: {} };

const UNRESTRICTED: Profile = {
  id: "p-unrestricted",
  name: "unrestricted",
  grants: [],
  shipped: true,
  createdAt: "2026-09-05T09:00:00.000Z",
  updatedAt: "2026-09-05T09:00:00.000Z",
};

const CLAUDE = buildInstance("claude-code", "Claude Code", [
  buildSnapshot({
    runnerId: MOSS.id,
    models: [
      {
        slug: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        imageInput: { maxBytes: null },
        isDefault: true,
        options: [],
      },
      {
        slug: "claude-opus-5-5",
        name: "Opus 5.5",
        imageInput: { maxBytes: null },
        isDefault: false,
        options: [],
      },
    ],
  }),
]);

const READS: DraftReads = {
  settings: SETTINGS,
  profiles: [UNRESTRICTED],
  instances: [CLAUDE],
  runners: [MOSS, COVE],
  thisMacRunnerId: MOSS.id,
  projects: [WEBSHOP_PROJECT, OPS_PROJECT],
  resources: [WEBSHOP, INFRA, RUNBOOKS],
  workspaces: [PRIMARY, THREAD_3F1],
  sessions: [],
};

/** Returns the parts of a draft the lip and the sidebar row show. */
const readLabels = (...args: Parameters<typeof buildDraftView>) => {
  const { workspaceLabel, machineLabel, rowWorkspace, place } = buildDraftView(...args);
  return { workspaceLabel, machineLabel, rowWorkspace, place };
};

describe("buildDraftView", () => {
  it("uses a new workspace before any pick", () => {
    expect(readLabels(READS, { projectId: WEBSHOP_PROJECT.id, workspaceId: null }, {})).toEqual({
      workspaceLabel: "New workspace",
      machineLabel: "moss",
      rowWorkspace: { clip: "New workspace", keep: " · moss" },
      place: { projectId: WEBSHOP_PROJECT.id, workspaceId: null, createsWorkspace: true },
    });
  });

  it("follows a pick of a new workspace, which has a group of its own until it exists", () => {
    const view = buildDraftView(
      READS,
      { projectId: WEBSHOP_PROJECT.id, workspaceId: null },
      { workspace: { kind: "ephemeral", checkouts: [{ resourceId: WEBSHOP.id }] } },
    );

    expect(view.base.workspace).toBeNull();
    expect(view.config.workspace).toEqual({
      kind: "ephemeral",
      checkouts: [{ resourceId: WEBSHOP.id }],
    });
    expect(view.rowWorkspace).toEqual({ clip: "New workspace", keep: " · moss" });
    expect(view.place).toEqual({
      projectId: WEBSHOP_PROJECT.id,
      workspaceId: null,
      createsWorkspace: true,
    });
  });

  it("names a main workspace it joins as a started thread's lip does, and its machine by name", () => {
    expect(
      readLabels(READS, { projectId: WEBSHOP_PROJECT.id, workspaceId: PRIMARY.id }, {}),
    ).toEqual({
      workspaceLabel: "Main workspace",
      machineLabel: "moss",
      rowWorkspace: { clip: "Main workspace", keep: " · moss" },
      place: { projectId: WEBSHOP_PROJECT.id, workspaceId: PRIMARY.id, createsWorkspace: false },
    });
  });

  it("names a worktree it joins by its branch, on the machine the worktree is on", () => {
    expect(
      readLabels(READS, { projectId: WEBSHOP_PROJECT.id, workspaceId: THREAD_3F1.id }, {}),
    ).toEqual({
      workspaceLabel: "hercule/thread-3f1",
      machineLabel: "moss",
      rowWorkspace: { clip: "hercule/thread-3f1", keep: " · moss" },
      place: { projectId: WEBSHOP_PROJECT.id, workspaceId: THREAD_3F1.id, createsWorkspace: false },
    });
  });

  it("works without a checkout in no project, and sits with the threads of no project", () => {
    const view = buildDraftView(READS, { projectId: null, workspaceId: null }, {});

    expect(view.rowWorkspace).toEqual({ clip: "No workspace", keep: " · moss" });
    expect(view.branch).toBeNull();
    expect(view.place).toEqual({ projectId: null, workspaceId: null, createsWorkspace: false });
  });

  it("names the model on the sidebar row as the catalog does, and follows a model pick", () => {
    const address = { projectId: WEBSHOP_PROJECT.id, workspaceId: null };

    expect(buildDraftView(READS, address, {}).rowModel).toBe("Claude Sonnet 5");
    expect(buildDraftView(READS, address, { model: "claude-opus-5-5" }).rowModel).toBe("Opus 5.5");
  });
});
