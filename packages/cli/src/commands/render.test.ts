/**
 * The renderings that are not the generic table: what a spawn teaches, what a
 * transcript reads like, and what a workflow read and save print. And one rule
 * of the table: each row stays on one line.
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

describe("hercule session spawn", () => {
  it("prints the session and teaches the command that reads it back", () => {
    const lines = renderHuman(
      { kind: "value", value: { id: SESSION, status: "starting" } },
      command("session", "spawn"),
    );

    expect(lines[0]).toBe(`id      ${SESSION.slice(-8)}`);
    expect(lines).toContain(
      `read what it says with \`hercule transcript read ${SESSION.slice(-8)}\``,
    );
  });

  it("teaches nothing after an ordinary read", () => {
    const lines = renderHuman(
      { kind: "value", value: { id: SESSION, status: "idle" } },
      command("session", "read"),
    );

    expect(lines.join("\n")).not.toContain("hercule transcript read");
  });
});

describe("hercule transcript read", () => {
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

describe("hercule workflow", () => {
  const WORKFLOW = "0199e0e7-2222-7000-8000-0000000000aa";
  const SOURCE = "# Files a task.\nname: File a task\nsteps: []\n";
  const record = {
    id: WORKFLOW,
    enabled: false,
    source: SOURCE,
    createdAt: "2026-09-22T10:00:00.000Z",
    updatedAt: "2026-09-22T10:00:00.000Z",
  };

  it("prints the source of a read as it is, and nothing else", () => {
    expect(renderHuman({ kind: "value", value: record }, command("workflow", "read"))).toEqual([
      SOURCE,
    ]);
  });

  it("ends a read of a CRLF source with a carriage return, so the line printed after it ends in CRLF", () => {
    const crlfSource = SOURCE.replaceAll("\n", "\r\n").slice(0, -"\r\n".length);
    expect(
      renderHuman(
        { kind: "value", value: { ...record, source: crlfSource } },
        command("workflow", "read"),
      ),
    ).toEqual([`${crlfSource}\r`]);
  });

  it("keeps each row of a listing on one line when a description or a filter has several", () => {
    const listed = renderHuman(
      {
        kind: "value",
        value: {
          items: [
            { id: WORKFLOW, name: "File a task", description: "Files one task.\nEvery morning." },
          ],
        },
      },
      command("workflow", "list"),
    );
    expect(listed).toEqual([
      "id        name         description",
      `${WORKFLOW.slice(-8)}  File a task  Files one task. ...`,
    ]);

    const triggers = renderHuman(
      {
        kind: "value",
        value: { items: [{ triggerId: "on_label", filter: "event.a == 1 &&\r\n  event.b == 2" }] },
      },
      command("trigger", "list"),
    );
    expect(triggers).toEqual(["triggerId  filter", "on_label   event.a == 1 && ..."]);
  });

  it("prints the id, whether it is on and one line per warning after a save, and never the source", () => {
    const saved = {
      workflow: record,
      warnings: [
        { path: [], message: "The run can end only when someone cancels it." },
        { path: ["steps", "0"], message: "Nothing starts this step." },
      ],
    };
    for (const verb of ["create", "update"]) {
      expect(renderHuman({ kind: "value", value: saved }, command("workflow", verb))).toEqual([
        `id       ${WORKFLOW.slice(-8)}`,
        "enabled  false",
        "warning: The run can end only when someone cancels it.",
        "warning: steps.0: Nothing starts this step.",
      ]);
    }
  });
});
