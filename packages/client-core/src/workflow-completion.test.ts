/**
 * What the editor offers at the cursor in a workflow's source. Each test
 * writes a source with the cursor where the author leaves it while typing: at
 * the end, or on a line above keys that are written already. It reads the
 * offers there. The keys and the fixed values come from the definition's
 * schema, and the ids from the catalog.
 */
import { describe, expect, it } from "vitest";
import {
  listWorkflowCompletions,
  readWorkflowSource,
  type CompletionList,
  type WorkflowCatalog,
} from "@hercule/client-core";

/** An Agent's id, which a step names. */
const AGENT_ID = "0199e0e7-1111-7000-8000-0000000000ab";

const CATALOG: WorkflowCatalog = {
  actions: [{ id: "task.create", displayName: "Create a task", description: "Creates a task." }],
  agents: [{ id: AGENT_ID, name: "Reviewer" }],
  eventKinds: [
    { kind: "cron.tick", description: "A schedule came due.", connectionRequired: false },
  ],
};

/** The offers at the end of a source written as lines. */
const completeAtEnd = (lines: ReadonlyArray<string>): CompletionList | undefined => {
  const source = lines.join("\n");
  return listWorkflowCompletions(readWorkflowSource(source), source.length, CATALOG);
};

/** Marks the cursor in a source that `completeAtMark` reads. It is not a part of the source. */
const CURSOR = "‸";

/** The offers at the cursor mark of a source written as lines, joined with a line break. */
const completeAtMark = (
  lines: ReadonlyArray<string>,
  lineBreak = "\n",
): CompletionList | undefined => {
  const marked = lines.join(lineBreak);
  const source = marked.replace(CURSOR, "");
  return listWorkflowCompletions(readWorkflowSource(source), marked.indexOf(CURSOR), CATALOG);
};

const listLabels = (completions: CompletionList | undefined): ReadonlyArray<string> =>
  (completions?.offers ?? []).map((offer) => offer.label);

/** The keys of an agent step that are not id, kind or agent, in the order of the schema. */
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
  it("offers the fixed values that the schema gives a key, after the key", () => {
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

  it("offers the keys of the mapping that it does not have yet, in the order of the schema", () => {
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

  it("replaces the part of a key that the author typed, which does not count as written", () => {
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
      readWorkflowSource(source),
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

  it("offers the keys of each step kind in a new list item, before the step says its kind", () => {
    const labels = listLabels(completeAtEnd(["name: Review", "steps:", "  - "]));

    expect(labels).toEqual(expect.arrayContaining(["id", "kind", "action", "agent", "prompt"]));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("writes a prompt as a block on the next line, and an expression in double quotes", () => {
    const lines = ["name: Review", "steps:", "  - id: review", "    kind: agent", "    "];
    const completions = completeAtEnd(lines);
    const offers = completions?.offers;

    // A key's offer writes at the cursor and replaces nothing.
    expect(completions?.from).toBe(lines.join("\n").length);
    expect(completions?.to).toBe(lines.join("\n").length);
    expect(offers?.find((offer) => offer.label === "prompt")).toEqual({
      label: "prompt",
      text: "prompt: |\n      ",
    });
    expect(offers?.find((offer) => offer.label === "condition")).toEqual({
      label: "condition",
      text: 'condition: ""',
      cursor: 'condition: "'.length,
    });
    expect(offers?.find((offer) => offer.label === "name")).toEqual({
      label: "name",
      text: "name: ",
    });
  });

  it("writes a schedule and each expression of a trigger in double quotes", () => {
    const listQuotedKeys = (lines: ReadonlyArray<string>) =>
      (completeAtEnd(lines)?.offers ?? [])
        .filter((offer) => offer.text === `${offer.label}: ""`)
        .map((offer) => offer.label);

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
      ])?.offers,
    ).toEqual([{ label: "task.create", detail: "Create a task", text: "task.create" }]);
    expect(
      completeAtEnd(["name: Review", "steps:", "  - id: review", "    kind: agent", "    agent: "])
        ?.offers,
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

  it("tells two agents with one name apart by the tail of each one's id", () => {
    const other = "0199e0e7-1111-7000-8000-0000000000cd";
    const lines = ["name: Review", "steps:", "  - id: review", "    kind: agent", "    agent: "];
    const source = lines.join("\n");

    expect(
      listWorkflowCompletions(readWorkflowSource(source), source.length, {
        ...CATALOG,
        agents: [
          { id: AGENT_ID, name: "Reviewer" },
          { id: other, name: "Reviewer" },
          { id: "0199e0e7-1111-7000-8000-0000000000ef", name: "Fixer" },
        ],
      })?.offers,
    ).toEqual([
      { label: "Reviewer", detail: "000000ab", text: AGENT_ID },
      { label: "Reviewer", detail: "000000cd", text: other },
      { label: "Fixer", text: "0199e0e7-1111-7000-8000-0000000000ef" },
    ]);
  });

  it.each(["", "p", "pr", "con"])(
    "offers the keys that the step does not have, with %j typed on the line above its kind",
    (typed) => {
      // The parser reads a word on the line directly above a key as the first
      // word of that key, so the step's kind is written below the cursor only.
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

  it("counts each key below the cursor as written, however far below", () => {
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

  it("offers a key at the top of the source above the keys written there", () => {
    expect(listLabels(completeAtMark(["name: Review", `st${CURSOR}`, "steps: []", ""]))).toEqual([
      "description",
      "inputs",
      "triggers",
      "edges",
      "workspace",
    ]);
  });

  it("reads a source with \\r\\n line breaks as it reads one with \\n line breaks", () => {
    const lines = ["name: Review", "steps:", "  - id: review", "    kind: agent", `    ${CURSOR}`];

    expect(completeAtMark(lines, "\r\n")?.offers).toEqual(completeAtMark(lines)?.offers);
    expect(listLabels(completeAtMark(lines, "\r\n"))).toContain("agent");
  });

  it("offers nothing inside a value that a line before the cursor started", () => {
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
