/**
 * Tests `buildPermissionRequestCard`, which builds the text of a Permission
 * Request's card, and `buildPermissionRequestDock`, which decides which open
 * Permission Request the dock shows and how it pages.
 */
import { describe, expect, it } from "vitest";
import type { PermissionRequest } from "@hercule/contract";
import { formatDescribeLine } from "../notifications";
import { buildPermissionRequestCard, buildPermissionRequestDock } from "./permission-request";

const REQUEST: PermissionRequest = {
  id: "perm-1",
  grant: "task.delete",
  reason: "The task is a duplicate of #12.",
  operation: { op: "task.delete", input: { id: "task-7" } },
  createdAt: "2026-10-10T10:00:00.000Z",
};

/** Two later requests, which name no operation. */
const SECOND: PermissionRequest = {
  id: "perm-2",
  grant: "run.start",
  reason: "The fix needs the release workflow.",
  createdAt: "2026-10-10T10:01:00.000Z",
};
const THIRD: PermissionRequest = { ...SECOND, id: "perm-3" };

describe("buildPermissionRequestCard", () => {
  it("shows the grant, the reason and the operation, and asks in one line", () => {
    const card = buildPermissionRequestCard(REQUEST, "worker");

    expect(card.title).toBe("Grant this permission?");
    expect(card.grant).toBe("task.delete");
    expect(card.reason).toBe("The task is a duplicate of #12.");
    expect(card.operation).toEqual({ intro: "Wants to call", op: "task.delete" });
    expect(card.question).toBe("Grant task.delete?");
  });

  it("has no operation when the session named none", () => {
    expect(buildPermissionRequestCard(SECOND, "worker").operation).toBeNull();
  });

  it("offers this session, the profile and deny, in the contract's words", () => {
    const card = buildPermissionRequestCard(REQUEST, "worker");

    expect(
      card.rows.map((row) => [row.id, row.label, formatDescribeLine(row.describeLine)]),
    ).toEqual([
      [
        "session",
        "This session only",
        "Lets this session use task.delete; other sessions still ask.",
      ],
      [
        "profile",
        "Add to profile",
        "Adds task.delete to the profile worker; every session on it gains the grant.",
      ],
      ["deny", "Deny", "Refuses task.delete; the agent is told and continues."],
    ]);
    expect(card.rows.every((row) => row.available)).toBe(true);
  });

  it("leaves the profile answer's line empty, and the answer unavailable, while the profile's name is not known", () => {
    const card = buildPermissionRequestCard(REQUEST, null);

    expect(card.rows.map((row) => formatDescribeLine(row.describeLine))).toEqual([
      "Lets this session use task.delete; other sessions still ask.",
      "",
      "Refuses task.delete; the agent is told and continues.",
    ]);
    expect(card.rows.map((row) => [row.id, row.available])).toEqual([
      ["session", true],
      ["profile", false],
      ["deny", true],
    ]);
  });
});

// The paging itself is tested with `locateShownRequest`. These check that
// a Permission Request is told apart by its `id`.
describe("buildPermissionRequestDock", () => {
  it("shows nothing while no Permission Request is open", () => {
    expect(buildPermissionRequestDock([], undefined)).toBeNull();
  });

  it("shows the request paged to, between its neighbours", () => {
    expect(buildPermissionRequestDock([REQUEST, SECOND, THIRD], "perm-2")).toEqual({
      request: SECOND,
      position: { at: 2, of: 3 },
      previousRequestId: "perm-1",
      nextRequestId: "perm-3",
    });
  });
});
