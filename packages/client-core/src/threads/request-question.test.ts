/**
 * Tests `formatRequestQuestion`, which formats the one-line question a
 * Waiting on you row shows for each kind of open request.
 */
import { describe, expect, it } from "vitest";
import type { OpenRequest } from "@hercule/contract";
import { formatRequestQuestion } from "./request-question";

const COMMON = { requestId: "req-1", itemId: "tool-1", decisions: ["allow", "deny"] } as const;

const buildCommand = (command: string): OpenRequest => ({
  ...COMMON,
  kind: "command_approval",
  detail: { command },
});

describe("formatRequestQuestion", () => {
  it("asks to run a command", () => {
    expect(formatRequestQuestion(buildCommand("git push"))).toBe("Run git push?");
  });

  it("asks to run only the first non-empty line of a multi-line command", () => {
    expect(formatRequestQuestion(buildCommand("\n  cat <<EOF > notes.txt\nhello\nEOF\n"))).toBe(
      "Run cat <<EOF > notes.txt?",
    );
  });

  it("asks to run this command when the harness sent none", () => {
    expect(formatRequestQuestion(buildCommand(" \n"))).toBe("Run this command?");
  });

  it("names the one file a change touches, by its file name", () => {
    expect(
      formatRequestQuestion({
        ...COMMON,
        kind: "file_change_approval",
        detail: { paths: ["src/checkout/secure.ts"] },
      }),
    ).toBe("Change secure.ts?");
  });

  it("counts the files a change touches when there are several", () => {
    expect(
      formatRequestQuestion({
        ...COMMON,
        kind: "file_change_approval",
        detail: { paths: ["a.ts", "b/c.ts", "d.ts"] },
      }),
    ).toBe("Change 3 files?");
  });

  it("asks about files in general when the harness named none", () => {
    expect(
      formatRequestQuestion({ ...COMMON, kind: "file_change_approval", detail: { paths: [] } }),
    ).toBe("Change files?");
  });

  it("names the one file a read touches, or counts several", () => {
    expect(
      formatRequestQuestion({
        ...COMMON,
        kind: "file_read_approval",
        detail: { paths: ["/etc/hosts"] },
      }),
    ).toBe("Read hosts?");
    expect(
      formatRequestQuestion({
        ...COMMON,
        kind: "file_read_approval",
        detail: { paths: ["a.md", "b.md"] },
      }),
    ).toBe("Read 2 files?");
  });

  it("names a directory by its last part, and the root by its whole path", () => {
    const readOne = (path: string) =>
      formatRequestQuestion({ ...COMMON, kind: "file_read_approval", detail: { paths: [path] } });

    expect(readOne("/Users/x/src/")).toBe("Read src?");
    expect(readOne("src//")).toBe("Read src?");
    expect(readOne("/")).toBe("Read /?");
  });

  it("asks to run a tool by its name", () => {
    expect(
      formatRequestQuestion({ ...COMMON, kind: "tool_approval", detail: { toolName: "WebFetch" } }),
    ).toBe("Run WebFetch?");
  });

  it("uses the first question, in the agent's words", () => {
    expect(
      formatRequestQuestion({
        ...COMMON,
        kind: "question",
        detail: {
          questions: [
            {
              header: "Region",
              question: "Which region should the rollout start in?",
              options: [],
              multiSelect: false,
            },
            { header: "Time", question: "When?", options: [], multiSelect: false },
          ],
        },
      }),
    ).toBe("Which region should the rollout start in?");
  });
});
