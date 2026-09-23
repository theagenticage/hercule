/**
 * Each test puts the cursor where an author would be while typing: at the end
 * of the source, or on a line above existing keys. It then checks the
 * completion options at the cursor.
 */
import { describe, expect, it } from "vitest";
import {
  listWorkflowCompletions,
  parseWorkflowSourceWithRanges,
  type CompletionList,
  type WorkflowCatalog,
} from "@hercule/client-core";

/** The id of the Agent in the test catalog. */
const AGENT_ID = "0199e0e7-1111-7000-8000-0000000000ab";

const CATALOG: WorkflowCatalog = {
  actions: [{ id: "task.create", displayName: "Create a task", description: "Creates a task." }],
  agents: [{ id: AGENT_ID, name: "Reviewer" }],
  eventKinds: [
    { kind: "cron.tick", description: "A schedule came due.", connectionRequired: false },
  ],
};

/** Joins `lines` into a source and returns the completions at its end. */
const completeAtEnd = (lines: ReadonlyArray<string>): CompletionList | undefined => {
  const source = lines.join("\n");
  return listWorkflowCompletions(parseWorkflowSourceWithRanges(source), source.length, CATALOG);
};

/** Marks the cursor position in a test source. `completeAtMark` removes it before parsing. */
const CURSOR = "‸";

/** Joins `lines` with `lineBreak` and returns the completions at the `CURSOR` mark. */
const completeAtMark = (
  lines: ReadonlyArray<string>,
  lineBreak = "\n",
): CompletionList | undefined => {
  const marked = lines.join(lineBreak);
  const source = marked.replace(CURSOR, "");
  return listWorkflowCompletions(
    parseWorkflowSourceWithRanges(source),
    marked.indexOf(CURSOR),
    CATALOG,
  );
};

const listLabels = (completions: CompletionList | undefined): ReadonlyArray<string> =>
  (completions?.options ?? []).map((option) => option.label);

/** The keys of an agent step other than id, kind and agent, in schema order. */
const AGENT_STEP_KEYS_AFTER_AGENT = [
  "name",
  "prompt",
  "model",
  "options",
  "accessMode",
  "freshSession",
  "outputSchema",
  "condition",
  "join",
  "entry",
  "terminal",
];

describe("listWorkflowCompletions", () => {
  it("offers the schema's fixed values for a key after the key", () => {
    expect(
      listLabels(completeAtEnd(["name: Review", "triggers:", "  - id: nightly", "    kind: "])),
    ).toEqual(["start", "signal"]);
    expect(
      listLabels(
        completeAtEnd([
          "name: Review",
          "steps:",
          "  - id: open_task",
          "    kind: action",
          "    join: ",
        ]),
      ),
    ).toEqual(["any", "all"]);
    expect(
      listLabels(
        completeAtEnd([
          "name: Review",
          "steps:",
          "  - id: open_task",
          "    kind: action",
          "    entry: ",
        ]),
      ),
    ).toEqual(["true", "false"]);
  });

  it("offers the keys the mapping does not have yet, in schema order", () => {
    expect(listLabels(completeAtEnd(["name: Review", "steps: []", ""]))).toEqual([
      "description",
      "inputs",
      "triggers",
      "edges",
      "workspace",
    ]);
    expect(
      listLabels(completeAtEnd(["name: Review", "steps: []", "edges:", "  - from: a", "    "])),
    ).toEqual(["to", "condition", "maxTraversals"]);
  });

  it("replaces the typed part of a key, and does not count that key as present", () => {
    const lines = ["name: Review", "steps:", "  - id: review", "    kind: agent", "    pro"];
    const completions = completeAtEnd(lines);

    expect(completions?.from).toBe(lines.join("\n").length - "pro".length);
    expect(completions?.to).toBe(lines.join("\n").length);
    expect(listLabels(completions)).toContain("prompt");
  });

  it.each([
    { case: "at the start of a value", line: `    action: ${CURSOR}task.create`, lineBreak: "\n" },
    { case: "inside a value", line: `    action: task.${CURSOR}create`, lineBreak: "\n" },
    { case: "at the end of a value", line: `    action: task.create${CURSOR}`, lineBreak: "\n" },
    {
      case: "before a comment",
      line: `    action: ta${CURSOR}sk.create  # first`,
      lineBreak: "\n",
    },
    { case: "in \\r\\n text", line: `    action: task.cr${CURSOR}eate`, lineBreak: "\r\n" },
  ])("replaces the whole value with the cursor $case", ({ line, lineBreak }) => {
    const lines = ["name: Review", "steps:", "  - id: open_task", "    kind: action", line];
    const marked = [...lines, "  - id: review", "    kind: action", "    action: task.create"].join(
      lineBreak,
    );
    const source = marked.replace(CURSOR, "");
    const completions = listWorkflowCompletions(
      parseWorkflowSourceWithRanges(source),
      marked.indexOf(CURSOR),
      CATALOG,
    );

    expect(listLabels(completions)).toEqual(["task.create"]);
    expect(source.slice(completions?.from, completions?.to)).toBe("task.create");
  });

  it("replaces nothing after the cursor in an empty value, or in a value that is only a comment", () => {
    for (const line of [`    action: ${CURSOR}`, `    action: ${CURSOR}# to do`]) {
      const completions = completeAtMark(["name: Review", "steps:", "  - id: open_task", line]);

      expect(listLabels(completions), line).toEqual(["task.create"]);
      expect(completions?.to, line).toBe(completions?.from);
    }
  });

  it("offers the keys of every step kind in a new list item that has no kind yet", () => {
    const labels = listLabels(completeAtEnd(["name: Review", "steps:", "  - "]));

    expect(labels).toEqual(expect.arrayContaining(["id", "kind", "action", "agent", "prompt"]));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("inserts a prompt as a | block and an expression in double quotes", () => {
    const lines = ["name: Review", "steps:", "  - id: review", "    kind: agent", "    "];
    const completions = completeAtEnd(lines);
    const options = completions?.options;

    // A key option inserts at the cursor and replaces nothing.
    expect(completions?.from).toBe(lines.join("\n").length);
    expect(completions?.to).toBe(lines.join("\n").length);
    expect(options?.find((option) => option.label === "prompt")).toEqual({
      label: "prompt",
      text: "prompt: |\n      ",
    });
    expect(options?.find((option) => option.label === "condition")).toEqual({
      label: "condition",
      text: 'condition: ""',
      cursor: 'condition: "'.length,
    });
    expect(options?.find((option) => option.label === "name")).toEqual({
      label: "name",
      text: "name: ",
    });
  });

  it("inserts a schedule and each trigger expression in double quotes", () => {
    const listQuotedKeys = (lines: ReadonlyArray<string>) =>
      (completeAtEnd(lines)?.options ?? [])
        .filter((option) => option.text === `${option.label}: ""`)
        .map((option) => option.label);

    expect(
      listQuotedKeys([
        "name: Review",
        "steps: []",
        "triggers:",
        "  - id: nightly",
        "    kind: start",
        "    ",
      ]),
    ).toEqual(["schedule"]);
    expect(
      listQuotedKeys([
        "name: Review",
        "steps: []",
        "triggers:",
        "  - id: nightly",
        "    kind: start",
        "    source:",
        "      ",
      ]),
    ).toEqual(["filter"]);
    expect(
      listQuotedKeys([
        "name: Review",
        "steps: []",
        "triggers:",
        "  - id: merged",
        "    kind: signal",
        "    correlation:",
        "      ",
      ]),
    ).toEqual(["event", "run"]);
  });

  it("offers the catalog's ids after action, agent and a trigger source's kind", () => {
    expect(
      completeAtEnd([
        "name: Review",
        "steps:",
        "  - id: open_task",
        "    kind: action",
        "    action: task",
      ])?.options,
    ).toEqual([{ label: "task.create", detail: "Create a task", text: "task.create" }]);
    expect(
      completeAtEnd(["name: Review", "steps:", "  - id: review", "    kind: agent", "    agent: "])
        ?.options,
    ).toEqual([{ label: "Reviewer", text: AGENT_ID }]);
    expect(
      listLabels(
        completeAtEnd([
          "name: Review",
          "triggers:",
          "  - id: nightly",
          "    kind: start",
          "    source:",
          "      kind: ",
        ]),
      ),
    ).toEqual(["cron.tick"]);
  });

  it("shows the end of the id for agents that share a name", () => {
    const other = "0199e0e7-1111-7000-8000-0000000000cd";
    const lines = ["name: Review", "steps:", "  - id: review", "    kind: agent", "    agent: "];
    const source = lines.join("\n");

    expect(
      listWorkflowCompletions(parseWorkflowSourceWithRanges(source), source.length, {
        ...CATALOG,
        agents: [
          { id: AGENT_ID, name: "Reviewer" },
          { id: other, name: "Reviewer" },
          { id: "0199e0e7-1111-7000-8000-0000000000ef", name: "Fixer" },
        ],
      })?.options,
    ).toEqual([
      { label: "Reviewer", detail: "000000ab", text: AGENT_ID },
      { label: "Reviewer", detail: "000000cd", text: other },
      { label: "Fixer", text: "0199e0e7-1111-7000-8000-0000000000ef" },
    ]);
  });

  it.each(["", "p", "pr", "con"])(
    "offers the step's missing keys with %j typed on the line above its kind",
    (typed) => {
      // The parser joins the typed word with the `kind` key on the next line.
      // The step's kind must still be read from that line.
      const completions = completeAtMark([
        "name: Review",
        "steps:",
        "  - id: review",
        `    ${typed}${CURSOR}`,
        "    kind: agent",
        `    agent: ${AGENT_ID}`,
        "  - id: open_task",
        "    kind: action",
        "    action: task.create",
        "",
      ]);

      expect(listLabels(completions)).toEqual(AGENT_STEP_KEYS_AFTER_AGENT);
    },
  );

  it("treats every key below the cursor as present, however far below", () => {
    expect(
      listLabels(
        completeAtMark([
          "name: Review",
          "steps:",
          "  - id: review",
          `    ${CURSOR}`,
          "    kind: agent",
          "    prompt: |",
          "      Review the pull request.",
          `    agent: ${AGENT_ID}`,
          "    join: all",
          "",
        ]),
      ),
    ).toEqual(AGENT_STEP_KEYS_AFTER_AGENT.filter((key) => key !== "prompt" && key !== "join"));
  });

  it("offers top-level keys on a line above existing keys", () => {
    expect(listLabels(completeAtMark(["name: Review", `st${CURSOR}`, "steps: []", ""]))).toEqual([
      "description",
      "inputs",
      "triggers",
      "edges",
      "workspace",
    ]);
  });

  it("handles \\r\\n line breaks the same as \\n", () => {
    const lines = ["name: Review", "steps:", "  - id: review", "    kind: agent", `    ${CURSOR}`];

    expect(completeAtMark(lines, "\r\n")?.options).toEqual(completeAtMark(lines)?.options);
    expect(listLabels(completeAtMark(lines, "\r\n"))).toContain("agent");
  });

  it("offers nothing inside a multi-line value that started on an earlier line", () => {
    expect(
      completeAtEnd([
        "name: Review",
        "steps:",
        "  - id: review",
        "    kind: agent",
        "    prompt: |",
        "      Rev",
      ]),
    ).toBeUndefined();
  });
});
