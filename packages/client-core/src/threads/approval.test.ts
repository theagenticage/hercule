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

const IDENTITY = { requestId: "req-1", itemId: "tool-1" };

const COMMAND: OpenRequest = {
  ...IDENTITY,
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
    expect(card).not.toHaveProperty("note");
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

  it("shows a question request's questions with no decisions, and no note", () => {
    const request: OpenRequest = {
      ...IDENTITY,
      kind: "question",
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

    // A question takes answers only. The user turns it down by stopping the
    // turn, not with a decision.
    expect(card.rows).toEqual([]);
    // A question asks for answers rather than permission, so its title says
    // that instead of using an approval's "Run this?".
    expect(card.title).toBe("The agent needs answers.");
    // The questions hold all the content, so the subject has nothing to
    // repeat, and a question is the agent's prose rather than code.
    expect(card.subject).toEqual([]);
    expect(card.code).toBe(false);
    expect(card.questions).toHaveLength(1);
    expect(card.questions[0]).toMatchObject({
      header: "Database",
      question: "Which database should it use?",
      options: [
        { label: "SQLite", description: "the one Hercule ships" },
        { label: "Postgres", description: "somebody else's server" },
      ],
      multiSelect: false,
      secretWarning: null,
    });
    // The questions are answered in the dock itself, so nothing is missing
    // that a note would have to explain.
    expect(card).not.toHaveProperty("note");
  });

  it("keeps every question of a multi-question request, and notes which allow more than one answer", () => {
    const request: OpenRequest = {
      ...IDENTITY,
      kind: "question",
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
    // The dock offers several choices or one, so each question says which.
    expect(card.questions.map((one) => one.multiSelect)).toEqual([true, false]);
    // No description to show: the label is the whole option.
    expect(card.questions[0]?.options).toEqual([{ label: "Rules", description: "" }]);
    expect(card.questions[0]?.note).toMatch(/more than one/i);
    // One answer is the usual case, so a note saying so on every question
    // would be noise.
    expect(card.questions[1]?.note).toBeNull();
  });

  it("warns that the answer to a question the harness marked secret is stored like any other", () => {
    const card = buildApprovalCard({
      ...IDENTITY,
      kind: "question",
      detail: {
        questions: [
          {
            question: "Which token?",
            header: "Token",
            options: [],
            multiSelect: false,
            secret: true,
          },
        ],
      },
    });

    expect(card.questions[0]?.secretWarning).toBe(
      "The agent asked to keep this answer secret. It is stored in the thread like any other answer.",
    );
  });

  it("gives the other kinds no questions", () => {
    expect(buildApprovalCard(COMMAND).questions).toEqual([]);
  });
});
