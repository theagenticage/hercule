/**
 * Tests `decideRelatedReads`, which decides whether a change in the thread
 * list means the projects, or the workspaces and resources, must be read
 * again for the sidebar's labels.
 */
import { describe, expect, it } from "vitest";
import type { Session, Workspace } from "@hercule/contract";
import { decideRelatedReads } from "./related-reads";
import {
  OPS_PROJECT,
  PRIMARY,
  THREAD_3F1,
  WEBSHOP_PROJECT,
  buildSession,
  buildWorkspace,
} from "./workspaces.testing";

const PROJECTS = [WEBSHOP_PROJECT];
const PROVISIONING: Workspace = buildWorkspace({ id: "ws-new", status: "provisioning" });
const WORKSPACES = [PRIMARY, THREAD_3F1, PROVISIONING];

const IN_PRIMARY = buildSession({
  id: "s-primary",
  projectId: WEBSHOP_PROJECT.id,
  workspaceId: PRIMARY.id,
});
const IN_PROVISIONING = buildSession({
  id: "s-setting-up",
  status: "starting",
  projectId: WEBSHOP_PROJECT.id,
  workspaceId: PROVISIONING.id,
});
const THREADS: readonly Session[] = [IN_PRIMARY, IN_PROVISIONING];

const NO_READS = { projects: false, workspaces: false };

describe("decideRelatedReads", () => {
  it("reads nothing when every thread's project and workspace are known and nothing changed", () => {
    expect(decideRelatedReads(THREADS, THREADS, PROJECTS, WORKSPACES)).toEqual(NO_READS);
  });

  it("reads nothing for a first list whose projects and workspaces are known", () => {
    expect(decideRelatedReads(undefined, THREADS, PROJECTS, WORKSPACES)).toEqual(NO_READS);
  });

  it("reads the projects when a thread names a project the list does not hold", () => {
    const next = [...THREADS, buildSession({ id: "s-ops", projectId: OPS_PROJECT.id })];

    expect(decideRelatedReads(THREADS, next, PROJECTS, WORKSPACES)).toEqual({
      projects: true,
      workspaces: false,
    });
  });

  it("reads the projects for an unknown project on the first list", () => {
    const first = [...THREADS, buildSession({ id: "s-ops", projectId: OPS_PROJECT.id })];

    expect(decideRelatedReads(undefined, first, PROJECTS, WORKSPACES).projects).toBe(true);
  });

  // A deleted project is never listed again, but its threads keep its id.
  // Reading the projects on every change would never bring it back.
  it("does not read the projects again for an unknown project the previous list named", () => {
    const withDeleted = [...THREADS, buildSession({ id: "s-ops", projectId: OPS_PROJECT.id })];
    const next = withDeleted.map((each) =>
      each.id === IN_PRIMARY.id ? { ...each, status: "busy" as const } : each,
    );

    expect(decideRelatedReads(withDeleted, next, PROJECTS, WORKSPACES)).toEqual(NO_READS);
  });

  it("reads the workspaces when a thread names a workspace the list does not hold", () => {
    const next = [...THREADS, buildSession({ id: "s-fresh", workspaceId: "ws-unknown" })];

    expect(decideRelatedReads(THREADS, next, PROJECTS, WORKSPACES)).toEqual({
      projects: false,
      workspaces: true,
    });
  });

  it("reads the workspaces when a thread in a provisioning workspace changed status", () => {
    const next = [IN_PRIMARY, { ...IN_PROVISIONING, status: "idle" as const }];

    expect(decideRelatedReads(THREADS, next, PROJECTS, WORKSPACES)).toEqual({
      projects: false,
      workspaces: true,
    });
  });

  it("reads the workspaces when a new thread appears in a provisioning workspace", () => {
    const next = [...THREADS, { ...IN_PROVISIONING, id: "s-joined" }];

    expect(decideRelatedReads(THREADS, next, PROJECTS, WORKSPACES).workspaces).toBe(true);
  });

  it("does not read the workspaces when a thread in a ready workspace changed status", () => {
    const next = [{ ...IN_PRIMARY, status: "busy" as const }, IN_PROVISIONING];

    expect(decideRelatedReads(THREADS, next, PROJECTS, WORKSPACES)).toEqual(NO_READS);
  });

  it("does not read the workspaces when a thread in a failed, deleted or lost workspace changed status", () => {
    for (const status of ["failed", "deleted", "lost"] as const) {
      const gone: Workspace = { ...PROVISIONING, status };
      const next = [IN_PRIMARY, { ...IN_PROVISIONING, status: "exited" as const }];

      expect(decideRelatedReads(THREADS, next, PROJECTS, [PRIMARY, THREAD_3F1, gone])).toEqual(
        NO_READS,
      );
    }
  });
});
