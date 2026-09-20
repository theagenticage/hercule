/**
 * The project picker's rows: enough of what stands under a project to choose
 * on, rather than a name alone.
 */
import { describe, expect, it } from "vitest";
import { projectPickerRows } from "./projects";
import { projectTone } from "./tone";
import {
  INFRA,
  OPS_PROJECT,
  PRIMARY,
  RUN_3F1,
  RUNBOOKS,
  WEBSHOP,
  WEBSHOP_PROJECT,
  project,
  session,
} from "./workspaces.testing";

const SANDBOX = project("p-sandbox", "sandbox");

const rows = projectPickerRows({
  projects: [WEBSHOP_PROJECT, OPS_PROJECT, SANDBOX],
  resources: [WEBSHOP, INFRA, RUNBOOKS],
  workspaces: [PRIMARY, RUN_3F1],
  sessions: [
    session({ id: "s1", projectId: WEBSHOP_PROJECT.id }),
    session({ id: "s2", projectId: WEBSHOP_PROJECT.id }),
    session({ id: "s3", projectId: OPS_PROJECT.id }),
  ],
});

describe("projectPickerRows", () => {
  it("says how much stands under a project, naming its repos", () => {
    expect(rows[0]?.sub).toBe("1 repo · webshop · 2 threads · 1 workspace");
    expect(rows[1]?.sub).toBe("2 repos · ops-infra, ops-runbooks · 1 thread · 0 workspaces");
  });

  it("leaves the names out of a project with no repo rather than an empty gap", () => {
    expect(rows[2]?.sub).toBe("0 repos · 0 threads · 0 workspaces");
  });

  it("leaves the main workspace out of the workspaces there are to join", () => {
    expect(rows[0]?.sub).toContain("1 workspace");
  });

  it("offers a key to the first nine and none past them", () => {
    const many = projectPickerRows({
      projects: Array.from({ length: 10 }, (_, index) =>
        project(`p${String(index)}`, `p${String(index)}`),
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

describe("projectTone", () => {
  const PROJECTS = [WEBSHOP_PROJECT, OPS_PROJECT, SANDBOX];

  // R6: hashing the id gave two projects one hue as often as not; the place in
  // the listing cannot.
  it("gives two projects standing next to each other different hues", () => {
    expect(projectTone(WEBSHOP_PROJECT.id, PROJECTS)).not.toBe(
      projectTone(OPS_PROJECT.id, PROJECTS),
    );
    expect(projectTone(OPS_PROJECT.id, PROJECTS)).not.toBe(projectTone(SANDBOX.id, PROJECTS));
  });

  it("answers the same hue for the same project every time, and the rows agree", () => {
    expect(projectTone(WEBSHOP_PROJECT.id, PROJECTS)).toBe(
      projectTone(WEBSHOP_PROJECT.id, PROJECTS),
    );
    expect(rows.map((row) => row.tone)).toEqual(
      PROJECTS.map((each) => projectTone(each.id, PROJECTS)),
    );
  });

  it("only ever answers one of the two hues the design language fixes", () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      project(`p-${String(index)}`, `p${String(index)}`),
    );
    const tones = new Set(many.map((each) => projectTone(each.id, many)));

    expect([...tones].every((tone) => tone === "hercule" || tone === "ops")).toBe(true);
    expect(tones.size).toBe(2);
  });
});
