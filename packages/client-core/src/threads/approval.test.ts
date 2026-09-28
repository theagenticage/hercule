/**
 * Tests `buildApprovalCard(openRequest)`, which builds all the text of the
 * permission card: its title, what the request is about, and one row per
 * offered decision.
 * No code in `apps/web` writes any of this text.
 *
 * The fixtures are the five kinds of `OpenRequest` a session can have, typed
 * with the contract's `OpenRequest` so no type is repeated here.
 */
import { describe, expect, it } from "vitest";
import type { OpenRequest } from "@hercule/contract";
import { formatDescribeLine } from "../notifications";
import { buildApprovalCard } from "./approval";

const COMMAND: OpenRequest = {
  requestId: "req-1",
  itemId: "tool-1",
  kind: "command_approval",
  decisions: ["allow", "allow_always", "deny", "cancel"],
  detail: { command: "ls -la" },
};

describe("buildApprovalCard", () => {
  it("offers one row per decision the request lists, in order, each with its own label and describe line", () => {
    const card = buildApprovalCard(COMMAND);

    expect(card.rows.map((row) => row.id)).toEqual(["allow", "allow_always", "deny", "cancel"]);
    expect(card.title.trim()).not.toBe("");
    for (const row of card.rows) {
      expect(row.label.trim(), `${row.id} has no label`).not.toBe("");
      expect(
        formatDescribeLine(row.describeLine).trim(),
        `${row.id} has no describe line`,
      ).not.toBe("");
    }
    // The user cannot choose between answers that read the same, so every
    // label and every describe line must be different.
    expect(new Set(card.rows.map((row) => row.label)).size).toBe(4);
    expect(new Set(card.rows.map((row) => formatDescribeLine(row.describeLine))).size).toBe(4);
    // No answer to an approval carries more weight than the others.
    expect(card.rows.every((row) => !row.primary)).toBe(true);
  });

  it("offers no allow-always row when the request does not list that decision", () => {
    const card = buildApprovalCard({ ...COMMAND, decisions: ["allow", "deny", "cancel"] });

    expect(card.rows.map((row) => row.id)).toEqual(["allow", "deny", "cancel"]);
  });

  it("uses a command_approval's command as its subject, and marks it as code", () => {
    const card = buildApprovalCard(COMMAND);

    expect(card.subject).toEqual(["ls -la"]);
    expect(card.code).toBe(true);
    expect(card.note).toBeNull();
  });

  it("uses every path of a file_change_approval as its subject, in order, as code", () => {
    const request: OpenRequest = {
      ...COMMAND,
      kind: "file_change_approval",
      detail: { paths: ["src/auth.ts", "src/auth.test.ts"] },
    };
    const card = buildApprovalCard(request);

    expect(card.subject).toEqual(["src/auth.ts", "src/auth.test.ts"]);
    expect(card.code).toBe(true);
  });

  it("uses a file_read_approval's path as its subject", () => {
    const card = buildApprovalCard({
      ...COMMAND,
      kind: "file_read_approval",
      detail: { paths: ["docs/"] },
    });

    expect(card.subject).toEqual(["docs/"]);
    expect(card.code).toBe(true);
  });

  it("names a tool_approval's tool in its title", () => {
    const card = buildApprovalCard({
      ...COMMAND,
      kind: "tool_approval",
      detail: { toolName: "WebFetch" },
    });

    // The title already names the tool, so there is no subject to repeat.
    expect(card.title).toContain("WebFetch");
    expect(card.subject).toEqual([]);
  });

  it("shows a question request's questions with only deny and cancel, and a note that answering is not built yet", () => {
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
    const card = buildApprovalCard(request);

    expect(card.rows.map((row) => row.id)).toEqual(["deny", "cancel"]);
    // A question asks for answers rather than permission, so its title says
    // that instead of using an approval's "Run this?".
    expect(card.title).toBe("The agent needs answers.");
    // The questions hold all the content, so the subject has nothing to
    // repeat, and a question is the agent's prose rather than code.
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
    // Allow could not send the answers, so the note explains why there is no
    // Allow. It says to cancel first, because a reply sent while the session
    // waits is queued behind the turn instead of reaching the harness.
    expect(card.note).toBe(
      "Answering here is not built yet. Cancel the turn, then reply in the thread.",
    );
  });

  it("keeps every question of a multi-question request, and notes which allow more than one answer", () => {
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
    const card = buildApprovalCard(request);

    expect(card.questions.map((one) => one.header)).toEqual(["Features", "Branch"]);
    // No description to show: the label is the whole option.
    expect(card.questions[0]?.options).toEqual([{ label: "Rules", description: "" }]);
    expect(card.questions[0]?.note).toMatch(/more than one/i);
    // One answer is the usual case, so a note saying so on every question
    // would be noise.
    expect(card.questions[1]?.note).toBeNull();
  });

  it("gives the other kinds no questions", () => {
    expect(buildApprovalCard(COMMAND).questions).toEqual([]);
  });
});
