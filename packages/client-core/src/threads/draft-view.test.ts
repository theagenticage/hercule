/**
 * Tests `buildDraftView`, which the draft screen and the sidebar's draft row
 * both read. The tests check the words the lip shows for the workspace and
 * the machine, the sidebar row's words, and the group the row sits in. The
 * row's second line follows a started thread's row, so it is checked:
 *
 * - before any pick, and after one, when the draft starts a new workspace;
 * - when the draft joins a workspace, whose machine the lip names plainly;
 * - when the draft has no project, and so no checkout.
 */
import { describe, expect, it } from "vitest";
import type { Profile, SettingsState } from "@hercule/contract";
import { buildInstance, buildSnapshot, CLAUDE_CODE_IDENTITY } from "../providers.testing";
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

const CLAUDE = buildInstance(CLAUDE_CODE_IDENTITY, [
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
  const { workspaceLabel, machineLabel, rowPlaceLabel, place } = buildDraftView(...args);
  return { workspaceLabel, machineLabel, rowPlaceLabel, place };
};

describe("buildDraftView", () => {
  // A new workspace's branch is one the controller names, so the row names
  // the machine, as the thread's row will once it starts.
  it("uses a new workspace before any pick, and names only its machine on the row", () => {
    expect(readLabels(READS, { projectId: WEBSHOP_PROJECT.id, workspaceId: null }, {})).toEqual({
      workspaceLabel: "New workspace",
      machineLabel: "moss",
      rowPlaceLabel: { clip: "moss", keep: "" },
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
    expect(view.resolved.config.workspace).toEqual({
      kind: "ephemeral",
      checkouts: [{ resourceId: WEBSHOP.id }],
    });
    expect(view.rowPlaceLabel).toEqual({ clip: "moss", keep: "" });
    expect(view.place).toEqual({
      projectId: WEBSHOP_PROJECT.id,
      workspaceId: null,
      createsWorkspace: true,
    });
  });

  it("names a main workspace it joins as a started thread's lip does, and by its branch on the row", () => {
    expect(
      readLabels(READS, { projectId: WEBSHOP_PROJECT.id, workspaceId: PRIMARY.id }, {}),
    ).toEqual({
      workspaceLabel: "Main workspace",
      machineLabel: "moss",
      rowPlaceLabel: { clip: "", keep: "main" },
      place: { projectId: WEBSHOP_PROJECT.id, workspaceId: PRIMARY.id, createsWorkspace: false },
    });
  });

  it("names a worktree it joins by its branch on the lip, and only by its machine on the row when the branch was generated", () => {
    expect(
      readLabels(READS, { projectId: WEBSHOP_PROJECT.id, workspaceId: THREAD_3F1.id }, {}),
    ).toEqual({
      workspaceLabel: "hercule/thread-3f1",
      machineLabel: "moss",
      rowPlaceLabel: { clip: "moss", keep: "" },
      place: { projectId: WEBSHOP_PROJECT.id, workspaceId: THREAD_3F1.id, createsWorkspace: false },
    });
  });

  it("works without a checkout in no project, and sits with the threads of no project", () => {
    const view = buildDraftView(READS, { projectId: null, workspaceId: null }, {});

    expect(view.rowPlaceLabel).toEqual({ clip: "moss", keep: "" });
    expect(view.branch).toBeNull();
    expect(view.place).toEqual({ projectId: null, workspaceId: null, createsWorkspace: false });
  });
});
