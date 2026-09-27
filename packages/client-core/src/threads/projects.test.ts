/**
 * Tests the project picker's rows, which show enough about each project to
 * choose by, not just its name.
 */
import { describe, expect, it } from "vitest";
import { buildProjectPickerRows } from "./projects";
import { pickProjectTone } from "./tone";
import {
  INFRA,
  OPS_PROJECT,
  PRIMARY,
  THREAD_3F1,
  RUNBOOKS,
  WEBSHOP,
  WEBSHOP_PROJECT,
  buildProject,
  buildSession,
} from "./workspaces.testing";

const SANDBOX = buildProject("p-sandbox", "sandbox");

const rows = buildProjectPickerRows({
  projects: [WEBSHOP_PROJECT, OPS_PROJECT, SANDBOX],
  resources: [WEBSHOP, INFRA, RUNBOOKS],
  workspaces: [PRIMARY, THREAD_3F1],
  sessions: [
    buildSession({ id: "s1", projectId: WEBSHOP_PROJECT.id }),
    buildSession({ id: "s2", projectId: WEBSHOP_PROJECT.id }),
    buildSession({ id: "s3", projectId: OPS_PROJECT.id }),
  ],
});

describe("buildProjectPickerRows", () => {
  it("shows the counts of a project's repos, threads and workspaces, and names its repos", () => {
    expect(rows[0]?.sub).toBe("1 repo · webshop · 2 threads · 1 workspace");
    expect(rows[1]?.sub).toBe("2 repos · ops-infra, ops-runbooks · 1 thread · 0 workspaces");
  });

  it("leaves out repo names for a project with no repo rather than an empty gap", () => {
    expect(rows[2]?.sub).toBe("0 repos · 0 threads · 0 workspaces");
  });

  it("does not count the main workspace among the workspaces to join", () => {
    expect(rows[0]?.sub).toContain("1 workspace");
  });

  it("offers a shortcut for the first nine rows and none after", () => {
    const many = buildProjectPickerRows({
      projects: Array.from({ length: 10 }, (_, index) =>
        buildProject(`p${String(index)}`, `p${String(index)}`),
      ),
      resources: [],
      workspaces: [],
      sessions: [],
    });

    expect(many[0]?.shortcut).toBe("⌘1");
    expect(many[8]?.shortcut).toBe("⌘9");
    expect(many[9]?.shortcut).toBeNull();
  });
});

describe("pickProjectTone", () => {
  const PROJECTS = [WEBSHOP_PROJECT, OPS_PROJECT, SANDBOX];

  // Hashing the id gave two projects the same hue about half the time; using
  // the position in the list cannot.
  it("gives two neighbouring projects different hues", () => {
    expect(pickProjectTone(WEBSHOP_PROJECT.id, PROJECTS)).not.toBe(
      pickProjectTone(OPS_PROJECT.id, PROJECTS),
    );
    expect(pickProjectTone(OPS_PROJECT.id, PROJECTS)).not.toBe(
      pickProjectTone(SANDBOX.id, PROJECTS),
    );
  });

  it("returns the same hue for the same project every time, and the rows match", () => {
    expect(pickProjectTone(WEBSHOP_PROJECT.id, PROJECTS)).toBe(
      pickProjectTone(WEBSHOP_PROJECT.id, PROJECTS),
    );
    expect(rows.map((row) => row.tone)).toEqual(
      PROJECTS.map((each) => pickProjectTone(each.id, PROJECTS)),
    );
  });

  it("only returns one of the two hues the design language defines", () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      buildProject(`p-${String(index)}`, `p${String(index)}`),
    );
    const tones = new Set(many.map((each) => pickProjectTone(each.id, many)));

    expect([...tones].every((tone) => tone === "hercule" || tone === "ops")).toBe(true);
    expect(tones.size).toBe(2);
  });
});
