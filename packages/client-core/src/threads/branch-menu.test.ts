/** Tests revision choices and unavailable sources in the composer menu. */
import { describe, expect, it } from "vitest";
import { buildBranchField } from "./branch-menu";
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
  it("distinguishes current, local and remote sources even when branch names match", () => {
    const source = {
      ...PRIMARY,
      checkouts: [{ ...PRIMARY.checkouts[0]!, remoteBranches: ["main"] }],
    };
    const field = buildBranchField(pick, { ...around, workspaces: [source] });
    expect(field?.header).toBe("Starting revision");
    expect(field?.rows.map(({ key, startingRevision }) => ({ key, startingRevision }))).toEqual([
      { key: "current", startingRevision: { kind: "current" } },
      { key: "remote:", startingRevision: { kind: "remote" } },
      { key: "local:main", startingRevision: { kind: "local", branch: "main" } },
      { key: "local:release/2.4", startingRevision: { kind: "local", branch: "release/2.4" } },
      {
        key: "local:hercule/thread-3f1",
        startingRevision: { kind: "local", branch: "hercule/thread-3f1" },
      },
      { key: "remote:main", startingRevision: { kind: "remote", branch: "main" } },
    ]);
    expect(field?.rows.every((row) => row.dimmed === null)).toBe(true);
  });

  it("keeps remote creation available without inventing local refs from another runner", () => {
    const field = buildBranchField(pick, {
      workspaces: [{ ...PRIMARY, runnerId: COVE.id }],
      runnerId: MOSS.id,
    });
    expect(field?.rows.map((row) => row.key)).toEqual(["current", "remote:"]);
    expect(field?.rows[0]?.dimmed).not.toBeNull();
    expect(field?.rows[1]?.dimmed).toBeNull();
  });

  it("refuses every source choice when the selected repository is unavailable", () => {
    const field = buildBranchField(pick, {
      ...around,
      workspaces: [{ ...PRIMARY, status: "failed", message: "Restore the attached checkout" }],
    });
    expect(field?.rows.every((row) => row.dimmed === "Restore the attached checkout")).toBe(true);
  });

  it("shows each selected starting revision without offering one menu for several repositories", () => {
    const infra = buildWorkspace({
      id: "ws-infra",
      checkouts: [buildCheckout(INFRA.id, "master", ["master"], "master")],
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
