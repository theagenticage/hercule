/**
 * The two renderings that are not the generic table: what a spawn teaches, and
 * what a transcript reads like.
 */
import { describe, expect, it } from "vitest";
import { renderHuman } from "./render";
import { commandAt, type Command } from "./tree";

const command = (...words: ReadonlyArray<string>): Command => {
  const found = commandAt(words);
  expect(found, words.join(" ")).toBeDefined();
  return found!;
};

const SESSION = "0199e0e7-1111-7000-8000-0000000000ff";

const row = (position: number, event: Record<string, unknown>) => ({
  position,
  at: "2026-09-07T10:00:00.000Z",
  event: { eventId: "e1", sessionId: SESSION, at: "2026-09-07T10:00:00.000Z", ...event },
});

describe("hydra session spawn", () => {
  it("prints the session and teaches the command that reads it back", () => {
    const lines = renderHuman(
      { kind: "value", value: { id: SESSION, status: "starting" } },
      command("session", "spawn"),
    );

    expect(lines[0]).toBe(`id      ${SESSION.slice(-8)}`);
    expect(lines).toContain(
      `read what it says with \`hydra transcript read ${SESSION.slice(-8)}\``,
    );
  });

  it("teaches nothing after an ordinary read", () => {
    const lines = renderHuman(
      { kind: "value", value: { id: SESSION, status: "idle" } },
      command("session", "read"),
    );

    expect(lines.join("\n")).not.toContain("hydra transcript read");
  });
});

describe("hydra transcript read", () => {
  it("prints one line per row: position, instant, tag, and what that tag adds", () => {
    const lines = renderHuman(
      {
        kind: "value",
        value: {
          items: [
            row(1, { _tag: "turn.started", turnId: "t1" }),
            row(2, {
              _tag: "content.delta",
              turnId: "t1",
              itemId: "i1",
              streamKind: "assistant_text",
              delta: "Hello\nthere",
            }),
            row(3, { _tag: "turn.completed", turnId: "t1", state: "completed" }),
          ],
        },
      },
      command("transcript", "read"),
    );

    expect(lines).toEqual([
      "1  2026-09-07T10:00:00.000Z  turn.started",
      "2  2026-09-07T10:00:00.000Z  content.delta  streamKind=assistant_text  delta=Hello there",
      "3  2026-09-07T10:00:00.000Z  turn.completed  state=completed",
    ]);
  });

  it("cuts a long delta rather than wrapping the terminal, and says the rest is a page away", () => {
    const lines = renderHuman(
      {
        kind: "value",
        value: {
          items: [
            row(1, {
              _tag: "content.delta",
              turnId: "t1",
              itemId: "i1",
              streamKind: "command_output",
              delta: "x".repeat(400),
            }),
          ],
          nextCursor: "next",
        },
      },
      command("transcript", "read"),
    );

    expect(lines[0]).toContain("...");
    expect(lines[0]!.length).toBeLessThan(200);
    expect(lines).toContain("more results: --cursor next, or --all");
  });

  it("says so when the session has said nothing yet", () => {
    const lines = renderHuman(
      { kind: "value", value: { items: [] } },
      command("transcript", "read"),
    );

    expect(lines).toEqual(["no results"]);
  });
});
