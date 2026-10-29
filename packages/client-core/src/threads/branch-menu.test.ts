/** Tests revision choices and unavailable sources in the composer menu. */
import { describe, expect, it } from "vitest";
import type { ResourceBranches } from "@hercule/contract";
import { buildBranchField, buildBranchListing, buildBranchListRows } from "./branch-menu";
import {
  COVE,
  MOSS,
  PRIMARY,
  WEBSHOP,
  INFRA,
  THREAD_3F1,
  buildWorkspace,
  buildCheckout,
} from "./workspaces.testing";

const pick = { kind: "ephemeral" as const, checkouts: [{ resourceId: WEBSHOP.id }] };
const around = { workspaces: [PRIMARY, THREAD_3F1], runnerId: MOSS.id };

describe("buildBranchField", () => {
  it("offers the current working copy and the remote default, and searches the ready main workspace's runner", () => {
    const field = buildBranchField(pick, around);
    expect(field?.header).toBe("Starting revision");
    expect(field?.rows.map(({ key, startingRevision }) => ({ key, startingRevision }))).toEqual([
      { key: "current", startingRevision: { kind: "current" } },
      { key: "remote:", startingRevision: { kind: "remote" } },
    ]);
    expect(field?.rows.every((row) => row.dimmed === null)).toBe(true);
    expect(field?.search).toEqual({ resourceId: WEBSHOP.id, runnerId: MOSS.id });
  });

  it("keeps remote creation available without inventing local refs from another runner", () => {
    const field = buildBranchField(pick, {
      workspaces: [{ ...PRIMARY, runnerId: COVE.id }],
      runnerId: MOSS.id,
    });
    expect(field?.rows.map((row) => row.key)).toEqual(["current", "remote:"]);
    expect(field?.rows[0]?.dimmed).not.toBeNull();
    expect(field?.rows[1]?.dimmed).toBeNull();
    expect(field?.search).toBeNull();
  });

  it("refuses every source choice when the selected repository is unavailable", () => {
    const field = buildBranchField(pick, {
      ...around,
      workspaces: [{ ...PRIMARY, status: "failed", message: "Restore the attached checkout" }],
    });
    expect(field?.rows.every((row) => row.dimmed === "Restore the attached checkout")).toBe(true);
    // A main workspace that is not ready has no branches to list.
    expect(field?.search).toBeNull();
  });

  it("shows each selected starting revision without offering one menu for several repositories", () => {
    const infra = buildWorkspace({
      id: "ws-infra",
      checkouts: [buildCheckout(INFRA.id, "master", "master")],
    });
    const field = buildBranchField(
      {
        kind: "ephemeral",
        checkouts: [
          { resourceId: WEBSHOP.id, startingRevision: { kind: "local", branch: "release/2.4" } },
          { resourceId: INFRA.id },
        ],
      },
      { workspaces: [PRIMARY, infra], runnerId: MOSS.id },
    );
    expect(field?.label).toBe("local branch release/2.4 · remote default");
    expect(field?.locked).not.toBeNull();
    expect(field?.rows).toEqual([]);
  });

  it("returns no revision picker for joined files or a Thread without a checkout", () => {
    expect(buildBranchField({ kind: "existing", workspaceId: THREAD_3F1.id }, around)).toBeNull();
    expect(buildBranchField({ kind: "none" }, around)).toBeNull();
  });
});

describe("buildBranchListRows", () => {
  const read = (branches: Partial<ResourceBranches>) =>
    ({
      status: "read",
      branches: { local: [], remote: [], more: false, ...branches },
    }) as const;

  it("lists local branches before remote ones, keeping a local and a remote branch of one name apart", () => {
    const listed = buildBranchListRows(
      read({ local: ["fix/login", "main"], remote: ["main"] }),
      "",
    );
    expect(
      listed.rows.map(({ key, label, startingRevision }) => ({ key, label, startingRevision })),
    ).toEqual([
      {
        key: "local:fix/login",
        label: "Local branch: fix/login",
        startingRevision: { kind: "local", branch: "fix/login" },
      },
      {
        key: "local:main",
        label: "Local branch: main",
        startingRevision: { kind: "local", branch: "main" },
      },
      {
        key: "remote:main",
        label: "Remote branch: main",
        startingRevision: { kind: "remote", branch: "main" },
      },
    ]);
    expect(listed.note).toBeNull();
  });

  it("says when more branches match than are shown", () => {
    expect(buildBranchListRows(read({ local: ["main"], more: true }), "").note).toBe(
      "More branches match. Type to narrow the list.",
    );
  });

  it("says when no branch name contains the text", () => {
    expect(buildBranchListRows(read({}), "zzz")).toEqual({
      rows: [],
      note: 'No branch name contains "zzz".',
    });
  });

  it("passes on why the runner could not list branches", () => {
    expect(
      buildBranchListRows(read({ unavailableReason: "The runner `moss` is too old." }), "fix"),
    ).toEqual({ rows: [], note: "The runner `moss` is too old." });
  });

  it("says that the list is being read, or why reading it failed", () => {
    expect(buildBranchListRows({ status: "reading" }, "")).toEqual({
      rows: [],
      note: "Reading branches…",
    });
    expect(buildBranchListRows({ status: "failed", message: "Request timed out" }, "")).toEqual({
      rows: [],
      note: "Branches could not be read: Request timed out",
    });
  });
});

describe("buildBranchListing", () => {
  const answer = { local: ["main"], remote: [], more: false };

  it("keeps an answer, reports a failure with its message, and waits otherwise", () => {
    expect(buildBranchListing(answer, null)).toEqual({ status: "read", branches: answer });
    expect(buildBranchListing(undefined, new Error("Request timed out"))).toEqual({
      status: "failed",
      message: "Request timed out",
    });
    expect(buildBranchListing(undefined, null)).toEqual({ status: "reading" });
  });
});
