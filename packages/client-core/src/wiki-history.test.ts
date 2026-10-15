/**
 * Tests `buildWikiHistory`, which reads a Wiki Page's history for the
 * History list, and `describeUnlistedRevisions`, which counts what the list
 * leaves out. The tests check that:
 *
 * - the newest revision is the current one;
 * - a revision that changed the title is marked with its new title, and the
 *   oldest listed revision never is;
 * - the count of older revisions left out of the list follows from the
 *   newest revision's number;
 * - the line that counts them is singular for one revision.
 */
import { describe, expect, it } from "vitest";
import type { WikiRevision } from "@hercule/contract";
import { buildWikiHistory, describeUnlistedRevisions } from "./wiki-history";

/** Returns revision `revision` of a page titled `title`, written by the user. */
const buildRevision = (revision: number, title: string): WikiRevision => ({
  revision,
  title,
  summary: "How a cart becomes an order.",
  at: `2026-10-0${String(revision)}T09:00:00.000Z`,
  actor: "user",
});

describe("buildWikiHistory", () => {
  it("takes the newest revision as the current one and lists every revision, newest first", () => {
    const history = buildWikiHistory([
      buildRevision(3, "Checkout"),
      buildRevision(2, "Checkout"),
      buildRevision(1, "Checkout"),
    ]);
    expect(history.currentRevision).toBe(3);
    expect(history.rows.map((row) => row.revision)).toEqual([3, 2, 1]);
    expect(history.unlistedCount).toBe(0);
  });

  it("marks a revision that changed the title with its new title", () => {
    const history = buildWikiHistory([
      buildRevision(3, "Checkout architecture"),
      buildRevision(2, "Checkout flow"),
      buildRevision(1, "Checkout flow"),
    ]);
    expect(history.rows.map((row) => row.renamedTo)).toEqual(["Checkout architecture", null, null]);
  });

  it("does not mark the oldest listed revision, whose previous title is not known", () => {
    const history = buildWikiHistory([buildRevision(52, "Checkout"), buildRevision(51, "Billing")]);
    expect(history.rows.map((row) => row.renamedTo)).toEqual(["Checkout", null]);
  });

  it("counts the older revisions the list leaves out", () => {
    const listed = Array.from({ length: 50 }, (_, index) => buildRevision(93 - index, "Checkout"));
    expect(buildWikiHistory(listed).unlistedCount).toBe(43);
  });
});

describe("describeUnlistedRevisions", () => {
  it("counts the revisions, singular for one", () => {
    expect(describeUnlistedRevisions(1)).toBe("And 1 older revision");
    expect(describeUnlistedRevisions(43)).toBe("And 43 older revisions");
  });
});
