/**
 * Tests the output that is not the generic table: the hint after a spawn, the
 * transcript, the output of workflow read, create, update and validate, and
 * the two catalogs used to write a workflow. Also tests one rule of the
 * table: each row stays on one line.
 */
import { describe, expect, it } from "vitest";
import { renderHuman } from "./render";
import { findCommandByWords, type Command } from "./tree";

const lookUpCommand = (...words: ReadonlyArray<string>): Command => {
  const found = findCommandByWords(words);
  expect(found, words.join(" ")).toBeDefined();
  return found!;
};

const SESSION = "0199e0e7-1111-7000-8000-0000000000ff";

const buildTranscriptRow = (position: number, event: Record<string, unknown>) => ({
  position,
  at: "2026-09-07T10:00:00.000Z",
  event: { eventId: "e1", sessionId: SESSION, at: "2026-09-07T10:00:00.000Z", ...event },
});

describe("hercule session spawn", () => {
  it("prints the session and a hint with the command that reads its transcript", () => {
    const lines = renderHuman(
      { kind: "value", value: { id: SESSION, status: "starting" } },
      lookUpCommand("session", "spawn"),
    );

    expect(lines[0]).toBe(`id      ${SESSION.slice(-8)}`);
    expect(lines).toContain(
      `read what it has done so far with \`hercule transcript read ${SESSION.slice(-8)}\``,
    );
  });

  it("prints no hint after an ordinary read", () => {
    const lines = renderHuman(
      { kind: "value", value: { id: SESSION, status: "idle" } },
      lookUpCommand("session", "read"),
    );

    expect(lines.join("\n")).not.toContain("hercule transcript read");
  });
});

describe("hercule transcript read", () => {
  it("prints one line per row: position, time, tag, and the event's own fields", () => {
    const lines = renderHuman(
      {
        kind: "value",
        value: {
          items: [
            buildTranscriptRow(1, { _tag: "turn.started", turnId: "t1" }),
            buildTranscriptRow(2, {
              _tag: "content.delta",
              turnId: "t1",
              itemId: "i1",
              streamKind: "assistant_text",
              delta: "Hello\nthere",
            }),
            buildTranscriptRow(3, { _tag: "turn.completed", turnId: "t1", state: "completed" }),
          ],
        },
      },
      lookUpCommand("transcript", "read"),
    );

    expect(lines).toEqual([
      "1  2026-09-07T10:00:00.000Z  turn.started",
      "2  2026-09-07T10:00:00.000Z  content.delta  streamKind=assistant_text  delta=Hello there",
      "3  2026-09-07T10:00:00.000Z  turn.completed  state=completed",
    ]);
  });

  it("truncates a long delta rather than wrapping, and shows how to get the next page", () => {
    const lines = renderHuman(
      {
        kind: "value",
        value: {
          items: [
            buildTranscriptRow(1, {
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
      lookUpCommand("transcript", "read"),
    );

    expect(lines[0]).toContain("...");
    expect(lines[0]!.length).toBeLessThan(200);
    expect(lines).toContain("more results: --cursor next, or --all");
  });

  it("prints no results when the transcript is empty", () => {
    const lines = renderHuman(
      { kind: "value", value: { items: [] } },
      lookUpCommand("transcript", "read"),
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

  it("prints the source of a read unchanged, and nothing else", () => {
    expect(
      renderHuman({ kind: "value", value: record }, lookUpCommand("workflow", "read")),
    ).toEqual([SOURCE]);
  });

  it("adds a carriage return after a CRLF source, so its last line ends in CRLF when printed", () => {
    const crlfSource = SOURCE.replaceAll("\n", "\r\n").slice(0, -"\r\n".length);
    expect(
      renderHuman(
        { kind: "value", value: { ...record, source: crlfSource } },
        lookUpCommand("workflow", "read"),
      ),
    ).toEqual([`${crlfSource}\r`]);
  });

  it("keeps each row of a list on one line when a description or a filter has several lines", () => {
    const listed = renderHuman(
      {
        kind: "value",
        value: {
          items: [
            { id: WORKFLOW, name: "File a task", description: "Files one task.\nEvery morning." },
          ],
        },
      },
      lookUpCommand("workflow", "list"),
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
      lookUpCommand("trigger", "list"),
    );
    expect(triggers).toEqual(["triggerId  filter", "on_label   event.a == 1 && ..."]);
  });

  it("prints one line per error and per warning after validate, or one line when there are none", () => {
    const validate = lookUpCommand("workflow", "validate");
    expect(
      renderHuman(
        {
          kind: "value",
          value: {
            errors: [{ path: ["steps", "1", "action"], message: "task.creat is not an action." }],
            warnings: [{ path: ["steps"], message: "A run can end only when someone cancels it." }],
          },
        },
        validate,
      ),
    ).toEqual([
      "error: steps.1.action: task.creat is not an action.",
      "warning: steps: A run can end only when someone cancels it.",
    ]);
    expect(renderHuman({ kind: "value", value: { errors: [], warnings: [] } }, validate)).toEqual([
      "valid: no errors and no warnings",
    ]);
  });

  it("prints the id, whether it is enabled and one line per warning after a save, and never the source", () => {
    const saved = {
      workflow: record,
      warnings: [
        { path: [], message: "The run can end only when someone cancels it." },
        { path: ["steps", "0"], message: "Nothing starts this step." },
      ],
    };
    for (const verb of ["create", "update"]) {
      expect(renderHuman({ kind: "value", value: saved }, lookUpCommand("workflow", verb))).toEqual(
        [
          `id       ${WORKFLOW.slice(-8)}`,
          "enabled  false",
          "warning: The run can end only when someone cancels it.",
          "warning: steps.0: Nothing starts this step.",
        ],
      );
    }
  });
});

describe("a catalog query that returns a plain array", () => {
  it("prints the event kinds as a table, like a page", () => {
    expect(
      renderHuman(
        {
          kind: "value",
          value: [
            { kind: "cron.tick", description: "A schedule came due.", connectionRequired: false },
            { kind: "github.pr.labeled", description: "Labels changed.", connectionRequired: true },
          ],
        },
        lookUpCommand("event-kind", "list"),
      ),
    ).toEqual([
      "kind               description           connectionRequired",
      "cron.tick          A schedule came due.  false",
      "github.pr.labeled  Labels changed.       true",
    ]);
  });

  it("lists the params of each workflow action by name, marking optional ones, instead of their schema", () => {
    expect(
      renderHuman(
        {
          kind: "value",
          value: [
            {
              id: "task.create",
              displayName: "Create a task",
              description: "Creates one Task.",
              inputSchema: {
                type: "object",
                properties: { title: {}, description: {}, labels: {} },
                required: ["title", "description"],
              },
            },
          ],
        },
        lookUpCommand("workflow-action", "list"),
      ),
    ).toEqual([
      "id           params                     description",
      "task.create  title description labels?  Creates one Task.",
    ]);
  });
});
