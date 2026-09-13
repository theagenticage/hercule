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
import type { OpenRequest } from "@hydra/contract";
import { approvalCard } from "./approval";

const COMMAND: OpenRequest = {
  requestId: "req-1",
  itemId: "tool-1",
  kind: "command_approval",
  decisions: ["allow", "allow_always", "deny", "cancel"],
  detail: { command: "ls -la" },
};

/** Every string the card carries, whichever line of it they end up on. */
const textIn = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map(textIn).join(" ")
      : typeof value === "object" && value !== null
        ? Object.values(value).map(textIn).join(" ")
        : "";

const wording = (request: OpenRequest): string => textIn(approvalCard(request));

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
    expect(wording(COMMAND)).toContain("ls -la");
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
    expect(wording(request)).toContain("src/auth.test.ts");
  });

  it("names the path a file_read_approval is about", () => {
    expect(
      wording({ ...COMMAND, kind: "file_read_approval", detail: { paths: ["docs/"] } }),
    ).toContain("docs/");
  });

  it("names the tool a tool_approval is about", () => {
    expect(
      wording({ ...COMMAND, kind: "tool_approval", detail: { toolName: "WebFetch" } }),
    ).toContain("WebFetch");
  });

  it("shows a user_input's questions with deny and cancel only, saying answering is not built and to reply in the thread", () => {
    const request: OpenRequest = {
      ...COMMAND,
      kind: "user_input",
      decisions: ["deny", "cancel"],
      detail: { questions: ["Which database should it use?", "Postgres or SQLite?"] },
    };
    const text = wording(request);

    const card = approvalCard(request);

    expect(card.rows.map((row) => row.decision)).toEqual(["deny", "cancel"]);
    // The questions are the agent's own prose, so they are not code, and the
    // note is where the missing answer is explained.
    expect(card.subject).toEqual(["Which database should it use?", "Postgres or SQLite?"]);
    expect(card.code).toBe(false);
    expect(card.note).not.toBeNull();
    expect(text).toContain("Which database should it use?");
    expect(text).toContain("Postgres or SQLite?");
    // Conflict-1: there is nothing an allow could carry, so the card says so
    // rather than leaving the user to guess why no Allow is offered.
    expect(text).toMatch(/not built/i);
    expect(text).toMatch(/reply/i);
  });
});
