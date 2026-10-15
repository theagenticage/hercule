/**
 * Tests `groupByProject`, which groups the Discussion and Wiki Page lists by
 * project. The tests check that:
 *
 * - a project with one repository shows its name only, and one with several
 *   shows a sub-heading per repository;
 * - a repository in several projects shows under each, and one in no project,
 *   or deleted, shows under "No project", last;
 * - groups follow the sidebar's order, and groups with no items are not shown;
 * - appending an older page keeps the keys and the order of what was listed.
 */
import { describe, expect, it } from "vitest";
import { groupByProject, type ProjectGroupEntry, type RepositoryRecord } from "./project-groups";
import { buildProject, buildRepo } from "./threads/workspaces.testing";

const WEB_PROJECT = buildProject("p-web", "webshop");
const OPS_PROJECT = buildProject("p-ops", "ops");
const DOCS_PROJECT = buildProject("p-docs", "docs");
const GUIDES_PROJECT = buildProject("p-guides", "guides");
const EMPTY_PROJECT = buildProject("p-empty", "empty");

const WEB = buildRepo("r-web", null, "github.com/acme/web", [WEB_PROJECT.id]);
const INFRA = buildRepo("r-infra", null, "github.com/acme/infra", [OPS_PROJECT.id]);
const RUNBOOKS = buildRepo("r-runbooks", null, "gitlab.com/ops/team/runbooks", [OPS_PROJECT.id]);
// A repository with no item is never listed, but it still makes ops a project with several.
const QUIET = buildRepo("r-quiet", null, "github.com/acme/quiet", [OPS_PROJECT.id]);
const SHARED = buildRepo("r-shared", null, "github.com/acme/shared", [
  DOCS_PROJECT.id,
  GUIDES_PROJECT.id,
]);
const LOOSE = buildRepo("r-loose", null, "github.com/acme/loose", []);

const buildRecord = (id: string, resourceId: string, repository: string): RepositoryRecord => ({
  id,
  resourceId,
  repository,
});

/** Lists each entry as a short word, so a test reads the grouping top to bottom. */
const describeEntries = (entries: readonly ProjectGroupEntry<RepositoryRecord>[]): string[] =>
  entries.map((entry) => {
    switch (entry.kind) {
      case "project":
        return `# ${entry.name ?? "No project"}`;
      case "repository":
        return `## ${entry.name}`;
      case "item":
        return entry.item.id;
    }
  });

const group = (
  overrides: Partial<Parameters<typeof groupByProject<RepositoryRecord>>[0]> & {
    readonly items: readonly RepositoryRecord[];
  },
) =>
  groupByProject({
    resources: [WEB, INFRA, RUNBOOKS, QUIET, SHARED, LOOSE],
    projects: [WEB_PROJECT, OPS_PROJECT, DOCS_PROJECT, GUIDES_PROJECT, EMPTY_PROJECT],
    projectOrder: [],
    ...overrides,
  });

describe("groupByProject", () => {
  it("shows a project with one repository by its name only", () => {
    const entries = group({
      items: [
        buildRecord("d2", WEB.id, "github.com/acme/web"),
        buildRecord("d1", WEB.id, "github.com/acme/web"),
      ],
    });

    expect(describeEntries(entries)).toEqual(["# webshop", "d2", "d1"]);
    expect(entries[0]).toEqual({
      kind: "project",
      key: "project:p-web",
      projectId: WEB_PROJECT.id,
      name: "webshop",
    });
  });

  it("shows a project with several repositories as its name, then a sub-heading per repository", () => {
    const entries = group({
      items: [
        buildRecord("d3", INFRA.id, "github.com/acme/infra"),
        buildRecord("d2", RUNBOOKS.id, "gitlab.com/ops/team/runbooks"),
        buildRecord("d1", INFRA.id, "github.com/acme/infra"),
      ],
    });

    expect(describeEntries(entries)).toEqual([
      "# ops",
      "## acme/infra",
      "d3",
      "d1",
      "## ops/team/runbooks",
      "d2",
    ]);
  });

  it("counts every repository of the project for its sub-headings, not only those with items", () => {
    // ops holds three repositories, so the one with items is still named.
    const entries = group({ items: [buildRecord("d1", INFRA.id, "github.com/acme/infra")] });

    expect(describeEntries(entries)).toEqual(["# ops", "## acme/infra", "d1"]);
  });

  it("shows a repository in several projects under each of them", () => {
    const entries = group({
      items: [buildRecord("d1", SHARED.id, "github.com/acme/shared")],
      projectOrder: [GUIDES_PROJECT.id, DOCS_PROJECT.id],
    });

    expect(describeEntries(entries)).toEqual(["# guides", "d1", "# docs", "d1"]);
    const keys = entries.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("puts a repository in no project under No project, last, with a sub-heading", () => {
    const entries = group({
      items: [
        buildRecord("d2", LOOSE.id, "github.com/acme/loose"),
        buildRecord("d1", WEB.id, "github.com/acme/web"),
      ],
    });

    expect(describeEntries(entries)).toEqual([
      "# webshop",
      "d1",
      "# No project",
      "## acme/loose",
      "d2",
    ]);
    expect(entries.at(-3)).toEqual({
      kind: "project",
      key: "project:none",
      projectId: null,
      name: null,
    });
  });

  it("puts a deleted repository under No project, named from its record", () => {
    const entries = group({
      items: [
        buildRecord("d2", "r-deleted", "github.com/acme/gone"),
        buildRecord("d1", WEB.id, "github.com/acme/web"),
      ],
    });

    expect(describeEntries(entries)).toEqual([
      "# webshop",
      "d1",
      "# No project",
      "## acme/gone",
      "d2",
    ]);
  });

  it("puts a repository whose projects are all unlisted under No project", () => {
    const entries = group({
      items: [buildRecord("d1", WEB.id, "github.com/acme/web")],
      projects: [OPS_PROJECT],
    });

    expect(describeEntries(entries)).toEqual(["# No project", "## acme/web", "d1"]);
  });

  it("orders groups by the project order, then by project id, then No project", () => {
    const items = [
      buildRecord("d4", LOOSE.id, "github.com/acme/loose"),
      buildRecord("d3", WEB.id, "github.com/acme/web"),
      buildRecord("d2", SHARED.id, "github.com/acme/shared"),
      buildRecord("d1", INFRA.id, "github.com/acme/infra"),
    ];
    const headings = (projectOrder: readonly string[]) =>
      describeEntries(group({ items, projectOrder })).filter((line) => line.startsWith("# "));

    // docs and ops are in the order; guides and webshop are not, so they follow by id.
    expect(headings([OPS_PROJECT.id, DOCS_PROJECT.id])).toEqual([
      "# ops",
      "# docs",
      "# guides",
      "# webshop",
      "# No project",
    ]);
    // With no order at all, every project is ordered by its id.
    expect(headings([])).toEqual(["# docs", "# guides", "# ops", "# webshop", "# No project"]);
    // An id that is not listed, or listed twice, changes nothing.
    expect(headings(["p-gone", WEB_PROJECT.id, WEB_PROJECT.id])).toEqual([
      "# webshop",
      "# docs",
      "# guides",
      "# ops",
      "# No project",
    ]);
  });

  it("does not show a project with no items, or a repository with no items", () => {
    const entries = group({ items: [buildRecord("d1", INFRA.id, "github.com/acme/infra")] });

    expect(describeEntries(entries)).not.toContain("# empty");
    expect(describeEntries(entries)).not.toContain("# webshop");
    expect(describeEntries(entries)).not.toContain("## acme/quiet");
    expect(group({ items: [] })).toEqual([]);
  });

  it("orders a project's repositories by their first item, and keeps the items' order", () => {
    const entries = group({
      items: [
        buildRecord("d4", RUNBOOKS.id, "gitlab.com/ops/team/runbooks"),
        buildRecord("d3", INFRA.id, "github.com/acme/infra"),
        buildRecord("d2", RUNBOOKS.id, "gitlab.com/ops/team/runbooks"),
        buildRecord("d1", INFRA.id, "github.com/acme/infra"),
      ],
    });

    expect(describeEntries(entries)).toEqual([
      "# ops",
      "## ops/team/runbooks",
      "d4",
      "d2",
      "## acme/infra",
      "d3",
      "d1",
    ]);
  });

  it("keeps the keys and the order of what was listed when an older page is appended", () => {
    const firstPage = [
      buildRecord("d6", INFRA.id, "github.com/acme/infra"),
      buildRecord("d5", WEB.id, "github.com/acme/web"),
      buildRecord("d4", INFRA.id, "github.com/acme/infra"),
    ];
    const olderPage = [
      buildRecord("d3", RUNBOOKS.id, "gitlab.com/ops/team/runbooks"),
      buildRecord("d2", WEB.id, "github.com/acme/web"),
      buildRecord("d1", LOOSE.id, "github.com/acme/loose"),
    ];
    const projectOrder = [OPS_PROJECT.id, WEB_PROJECT.id];

    const before = group({ items: firstPage, projectOrder });
    const after = group({ items: [...firstPage, ...olderPage], projectOrder });

    const keysBefore = before.map((entry) => entry.key);
    const keysAfter = after.map((entry) => entry.key);
    expect(new Set(keysAfter).size).toBe(keysAfter.length);
    // Every key already listed is still there, and in the same relative order.
    expect(keysAfter.filter((key) => keysBefore.includes(key))).toEqual(keysBefore);
    // An older item of an existing repository joins its repository: it is
    // listed under its group, after the items that were already there.
    expect(describeEntries(after)).toEqual([
      "# ops",
      "## acme/infra",
      "d6",
      "d4",
      "## ops/team/runbooks",
      "d3",
      "# webshop",
      "d5",
      "d2",
      "# No project",
      "## acme/loose",
      "d1",
    ]);
  });

  it("keys a group, a repository and an item by their group and their own id", () => {
    const keys = group({ items: [buildRecord("d1", INFRA.id, "github.com/acme/infra")] }).map(
      (entry) => entry.key,
    );

    expect(keys).toEqual(["project:p-ops", "repository:p-ops:r-infra", "item:p-ops:d1"]);
  });
});
