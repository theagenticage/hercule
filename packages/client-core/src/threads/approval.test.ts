/**
 * `approvalCard(openRequest)` is the whole text of the permission card: its
 * title line, what the request is about, and one row per offered decision
 * ([#70](https://github.com/rogierpennink/hydra/issues/70)); nothing in
 * `apps/web` authors any of it.
 *
 * The fixtures are the five `OpenRequest` shapes the Session row hands out,
 * typed off the contract's own `OpenRequest` so no shape is restated here.
 */
import { describe, expect, it } from "vitest";
import type { OpenRequest } from "@hercule/contract";
import { approvalCard } from "./approval";

const COMMAND: OpenRequest = {
  requestId: "req-1",
  itemId: "tool-1",
  kind: "command_approval",
  decisions: ["allow", "allow_always", "deny", "cancel"],
  detail: { command: "ls -la" },
};

describe("approvalCard", () => {
  it("offers one row per decision the request lists, in that order, each with its own label and describe line", () => {
    const card = approvalCard(COMMAND);

    expect(card.rows.map((row) => row.decision)).toEqual([
      "allow",
      "allow_always",
      "deny",
      "cancel",
    ]);
    expect(card.title.trim()).not.toBe("");
    for (const row of card.rows) {
      expect(row.label.trim(), `${row.decision} has no label`).not.toBe("");
      expect(row.describe.trim(), `${row.decision} has no describe line`).not.toBe("");
    }
    // Four answers that read the same are four answers the user cannot choose
    // between: every label and every describe line is its own.
    expect(new Set(card.rows.map((row) => row.label)).size).toBe(4);
    expect(new Set(card.rows.map((row) => row.describe)).size).toBe(4);
  });

  it("offers no allow-always row where the request does not list that decision", () => {
    const card = approvalCard({ ...COMMAND, decisions: ["allow", "deny", "cancel"] });

    expect(card.rows.map((row) => row.decision)).toEqual(["allow", "deny", "cancel"]);
  });

  it("names the command a command_approval is about, as its subject, and marks it code", () => {
    const card = approvalCard(COMMAND);

    expect(card.subject).toEqual(["ls -la"]);
    expect(card.code).toBe(true);
    expect(card.note).toBeNull();
  });

  it("names every path a file_change_approval is about, in order, as code", () => {
    const request: OpenRequest = {
      ...COMMAND,
      kind: "file_change_approval",
      detail: { paths: ["src/auth.ts", "src/auth.test.ts"] },
    };
    const card = approvalCard(request);

    expect(card.subject).toEqual(["src/auth.ts", "src/auth.test.ts"]);
    expect(card.code).toBe(true);
  });

  it("names the path a file_read_approval is about, as its subject", () => {
    const card = approvalCard({
      ...COMMAND,
      kind: "file_read_approval",
      detail: { paths: ["docs/"] },
    });

    expect(card.subject).toEqual(["docs/"]);
    expect(card.code).toBe(true);
  });

  it("names the tool a tool_approval is about, in its title", () => {
    const card = approvalCard({
      ...COMMAND,
      kind: "tool_approval",
      detail: { toolName: "WebFetch" },
    });

    // The tool names itself in the question, so there is no subject to repeat.
    expect(card.title).toContain("WebFetch");
    expect(card.subject).toEqual([]);
  });

  it("shows a question request's questions with deny and cancel only, saying answering is not built and to reply in the thread", () => {
    const request: OpenRequest = {
      ...COMMAND,
      kind: "question",
      decisions: ["deny", "cancel"],
      detail: {
        questions: [
          {
            question: "Which database should it use?",
            header: "Database",
            options: [
              { label: "SQLite", description: "the one Hercule ships" },
              { label: "Postgres", description: "somebody else's server" },
            ],
            multiSelect: false,
          },
        ],
      },
    };
    const card = approvalCard(request);

    expect(card.rows.map((row) => row.decision)).toEqual(["deny", "cancel"]);
    // A question asks for answers rather than permission, so the title says so
    // rather than borrowing an approval's "Run this?".
    expect(card.title).toBe("The agent needs answers.");
    // The questions carry the whole content, so the subject has nothing to
    // repeat, and a question is the agent's own prose rather than code.
    expect(card.subject).toEqual([]);
    expect(card.code).toBe(false);
    expect(card.questions).toEqual([
      {
        header: "Database",
        question: "Which database should it use?",
        options: [
          { label: "SQLite", description: "the one Hercule ships" },
          { label: "Postgres", description: "somebody else's server" },
        ],
        note: null,
      },
    ]);
    // There is nothing an allow could carry, so the note says so rather than
    // leaving the user to guess why no Allow is offered - and it says to cancel
    // first, because a reply sent while the session is parked queues behind the
    // turn instead of reaching the harness that is asking.
    expect(card.note).toBe(
      "Answering here is not built yet. Cancel the turn, then reply in the thread.",
    );
  });

  it("keeps every question of a multi-question request, and says where more than one answer is allowed", () => {
    const request: OpenRequest = {
      ...COMMAND,
      kind: "question",
      decisions: ["deny", "cancel"],
      detail: {
        questions: [
          {
            question: "Which features?",
            header: "Features",
            options: [{ label: "Rules", description: "" }],
            multiSelect: true,
          },
          {
            question: "Which branch?",
            header: "Branch",
            options: [],
            multiSelect: false,
          },
        ],
      },
    };
    const card = approvalCard(request);

    expect(card.questions.map((one) => one.header)).toEqual(["Features", "Branch"]);
    // No description to show: the label is the whole option.
    expect(card.questions[0]?.options).toEqual([{ label: "Rules", description: "" }]);
    expect(card.questions[0]?.note).toMatch(/more than one/i);
    // One answer is the ordinary case, and a line saying so on every question
    // would be noise.
    expect(card.questions[1]?.note).toBeNull();
  });

  it("gives the other kinds no questions", () => {
    expect(approvalCard(COMMAND).questions).toEqual([]);
  });
});
