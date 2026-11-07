/** Tests the words of a Thread row in the pane. */
import { describe, expect, it } from "vitest";
import {
  buildApprovalRequest,
  buildDetailSession,
  buildQuestion,
  buildQuestionRequest,
} from "./task-detail.testing";
import { buildTaskThreadRow } from "./task-thread";

describe("a Thread row of the pane", () => {
  it.each([
    ["idle", buildDetailSession("a"), null],
    ["marked Done", buildDetailSession("a", { done: true }), "Done"],
    ["running a turn", buildDetailSession("a", { status: "busy" }), "Working"],
    ["queued for a runner", buildDetailSession("a", { status: "queued" }), "Working"],
    ["Done but still running", buildDetailSession("a", { status: "busy", done: true }), "Working"],
    [
      "asking a question",
      buildDetailSession("a", {
        status: "busy",
        openRequests: [buildQuestionRequest("r", [buildQuestion("Why")])],
      }),
      "Asks",
    ],
    [
      "waiting on an approval",
      buildDetailSession("a", { openRequests: [buildApprovalRequest("r")] }),
      "Waiting",
    ],
    [
      "holding an approval and a question",
      buildDetailSession("a", {
        openRequests: [
          buildApprovalRequest("r1"),
          buildQuestionRequest("r2", [buildQuestion("Why")]),
        ],
      }),
      "Asks",
    ],
  ])("says what a Thread %s is doing", (_, session, state) => {
    expect(buildTaskThreadRow(session).state).toBe(state);
  });

  it.each([
    ["has a role", "  review ", "Review PR", "review"],
    ["has no role", null, "Review PR", "Review PR"],
    ["has a blank role", "  ", "Review PR", "Review PR"],
  ])("names a Thread that %s", (_, role, title, label) => {
    expect(buildTaskThreadRow(buildDetailSession("a", { role, title })).label).toBe(label);
  });
});
