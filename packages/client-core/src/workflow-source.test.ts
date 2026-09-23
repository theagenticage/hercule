/**
 * How the browser reads a workflow's text: the one parse of the text, and the
 * place in the text of each problem that the parse or the controller names.
 *
 * The controller names a problem by its path into the definition and never by
 * a position, so that the contract stays free of positions. The editor must
 * find the place in the text itself. Each test of `locateIssues` writes a
 * text, names one kind of path, and checks the characters that the path lands
 * on. `from` and `to` are character offsets into the text. A path that ends at
 * a key lands on the key through its value. A range covers the first line of
 * its place only, and not the line break after it.
 */
import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { parseWorkflowSource, type Issue, type WorkflowDefinition } from "@hercule/contract";
import { decideIssueState, locateIssues, readWorkflowSource } from "@hercule/client-core";

/**
 * A valid workflow, one line for each item, so line N is item N - 1. The
 * comment on the first line puts the definition after the start of the text,
 * so a place that counts from the wrong start shows.
 * Step `review` names an action that does not exist, as a typing author
 * leaves it, and `task.create` in the step before it has the same first
 * characters.
 */
const TEXT = [
  "# Review labelled pull requests.",
  "name: Review",
  "triggers:",
  "  - id: labelled",
  "    kind: start",
  "    source:",
  "      kind: github.pr.labeled",
  "      connectionId: any",
  "      filter: event.payload.number > 3",
  "steps:",
  "  - id: open_task",
  "    kind: action",
  "    action: task.create",
  "    params:",
  "      title: Review the pull request",
  "  - id: review",
  "    kind: action",
  "    action: task.creat",
  "edges:",
  "  - from: open_task",
  "    to: review",
  "",
].join("\n");

/** A step whose kind is a word that is not a kind. The YAML is valid. */
const SHAPE_ERROR_TEXT = [
  "name: Review",
  "steps:",
  "  - id: open_task",
  "    kind: acton",
  "    action: task.create",
  "",
].join("\n");

/** Line 4 holds a mapping inside a compact mapping, which YAML does not allow. */
const SYNTAX_ERROR_TEXT = [
  "name: Review",
  "steps:",
  "  - id: open_task",
  "    kind: action: agent",
  "",
].join("\n");

/**
 * The offset of a fragment that the text holds exactly once. A fragment that
 * occurs twice would make the expected place a guess.
 */
const findUniqueOffset = (text: string, fragment: string): number => {
  const first = text.indexOf(fragment);
  if (first === -1 || text.indexOf(fragment, first + 1) !== -1) {
    throw new Error(`The text does not hold ${JSON.stringify(fragment)} exactly once.`);
  }
  return first;
};

/** The offset just after a fragment that the text holds exactly once. */
const findUniqueEnd = (text: string, fragment: string): number =>
  findUniqueOffset(text, fragment) + fragment.length;

/** The definition that the shared parse gives for a text. A refusal fails the test. */
const parseDefinition = (text: string): WorkflowDefinition => {
  const parsed = parseWorkflowSource(text);
  if (Result.isFailure(parsed)) {
    throw new Error(`The text was refused: ${JSON.stringify(parsed.failure)}`);
  }
  return parsed.success;
};

/** The issues that the shared parse refuses a text with. A text that parses fails the test. */
const listParseIssues = (text: string): ReadonlyArray<Issue> => {
  const parsed = parseWorkflowSource(text);
  if (Result.isSuccess(parsed)) throw new Error("The text parsed, and the test needs a refusal.");
  return parsed.failure;
};

describe("readWorkflowSource", () => {
  it("answers the definition that the shared parse answers, and no issues, for a text that parses", () => {
    const reading = readWorkflowSource(TEXT);

    expect(reading.definition).toEqual(parseDefinition(TEXT));
    expect(reading.issues).toEqual([]);
  });

  it("answers no definition for a shape error, and places the issue from the key through the value it names", () => {
    const reading = readWorkflowSource(SHAPE_ERROR_TEXT);
    const from = findUniqueOffset(SHAPE_ERROR_TEXT, "kind: acton");

    expect(reading.definition).toBeUndefined();
    // The same issue that the controller refuses the text with, because both
    // read the text with the one parse.
    const [refused] = listParseIssues(SHAPE_ERROR_TEXT);
    expect(refused?.path).toEqual(["steps", "0", "kind"]);
    expect(reading.issues).toEqual([
      {
        severity: "error",
        path: ["steps", "0", "kind"],
        message: refused?.message,
        from,
        to: from + "kind: acton".length,
        line: 4,
      },
    ]);
  });

  it("answers no definition for a syntax error, and places the issue on the line the parser names", () => {
    const reading = readWorkflowSource(SYNTAX_ERROR_TEXT);

    expect(reading.definition).toBeUndefined();
    expect(reading.issues.map(({ path, message }) => ({ path, message }))).toEqual(
      listParseIssues(SYNTAX_ERROR_TEXT),
    );
    const [located] = reading.issues;
    expect(located?.severity).toBe("error");
    expect(located?.line).toBe(4);
    // The parser names a position on line 4. The range starts on that line and
    // stays inside the text.
    const lineStart = findUniqueOffset(SYNTAX_ERROR_TEXT, "    kind: action: agent");
    const lineEnd = findUniqueEnd(SYNTAX_ERROR_TEXT, "    kind: action: agent");
    expect(located?.from).toBeGreaterThanOrEqual(lineStart);
    expect(located?.from).toBeLessThanOrEqual(lineEnd);
    expect(located?.to).toBeGreaterThanOrEqual(located?.from ?? Infinity);
    expect(located?.to).toBeLessThanOrEqual(SYNTAX_ERROR_TEXT.length);
  });

  it.each([
    {
      about: "a field that is not known",
      lines: [
        "name: Review",
        "steps:",
        "  - id: open_task",
        "    kind: action",
        "    actoin: task.create",
        "    action: task.create",
        "",
      ],
      key: "actoin",
      path: ["steps", "0", "actoin"],
      line: 5,
    },
    {
      about: "a key that its mapping has twice",
      lines: ["name: Review", "steps: []", "name: Another review", ""],
      key: "name: Another",
      path: ["name"],
      line: 3,
    },
    {
      about: "an output name that an expression cannot read",
      lines: [
        "name: Review",
        "triggers:",
        "  - id: merged",
        "    kind: signal",
        "    source:",
        "      kind: github.pr.merged",
        "      connectionId: any",
        "    correlation:",
        "      event: event.payload.number",
        "      run: inputs.number",
        "    outputs:",
        "      pr-url: event.payload.url",
        "steps: []",
        "",
      ],
      key: "pr-url",
      path: ["triggers", "0", "outputs", "pr-url"],
      line: 12,
    },
  ])(
    "places a problem about $about from the key through its value, on the key's line",
    (example) => {
      const text = example.lines.join("\n");
      const from = findUniqueOffset(text, example.key);

      expect(readWorkflowSource(text).issues).toEqual([
        {
          severity: "error",
          path: example.path,
          message: listParseIssues(text)[0]?.message,
          from,
          to: text.indexOf("\n", from),
          line: example.line,
        },
      ]);
    },
  );
});

describe("locateIssues", () => {
  const message = "The controller's words for the problem.";

  it("places an issue at a scalar value from its key through that value", () => {
    const path = ["steps", "1", "action"];
    const from = findUniqueOffset(TEXT, "action: task.creat\n");

    expect(locateIssues(readWorkflowSource(TEXT), [{ path, message }], "error")).toEqual([
      { severity: "error", path, message, from, to: from + "action: task.creat".length, line: 18 },
    ]);
  });

  it("places an issue at a step, a sequence item, on the first line of that step", () => {
    const path = ["steps", "1"];
    const from = findUniqueOffset(TEXT, "id: review");

    expect(locateIssues(readWorkflowSource(TEXT), [{ path, message }], "error")).toEqual([
      { severity: "error", path, message, from, to: findUniqueEnd(TEXT, "id: review"), line: 16 },
    ]);
  });

  it("places an issue at an edge, a sequence item, on the first line of that edge", () => {
    const path = ["edges", "0"];
    const from = findUniqueOffset(TEXT, "from: open_task");

    expect(locateIssues(readWorkflowSource(TEXT), [{ path, message }], "error")).toEqual([
      {
        severity: "error",
        path,
        message,
        from,
        to: findUniqueEnd(TEXT, "from: open_task"),
        line: 20,
      },
    ]);
  });

  it.each([
    { about: "the steps", path: ["steps"], fragment: "steps:", line: 10 },
    { about: "the edges", path: ["edges"], fragment: "edges:", line: 19 },
    {
      about: "the params of a step",
      path: ["steps", "0", "params"],
      fragment: "params:",
      line: 14,
    },
  ])("places an issue at $about, a key with a list or a mapping, on the key's line", (example) => {
    const from = findUniqueOffset(TEXT, example.fragment);

    expect(
      locateIssues(readWorkflowSource(TEXT), [{ path: example.path, message }], "error"),
    ).toEqual([
      {
        severity: "error",
        path: example.path,
        message,
        from,
        to: from + example.fragment.length,
        line: example.line,
      },
    ]);
  });

  it("places an issue at a nested key from the key through its value, with the severity it is given", () => {
    const path = ["triggers", "0", "source", "filter"];
    const from = findUniqueOffset(TEXT, "filter: event.payload.number > 3");

    expect(locateIssues(readWorkflowSource(TEXT), [{ path, message }], "warning")).toEqual([
      {
        severity: "warning",
        path,
        message,
        from,
        to: from + "filter: event.payload.number > 3".length,
        line: 9,
      },
    ]);
  });

  it("places an issue at a key the author chose, inside params, from the key through its value", () => {
    const path = ["steps", "0", "params", "title"];
    const from = findUniqueOffset(TEXT, "title: Review the pull request");

    expect(locateIssues(readWorkflowSource(TEXT), [{ path, message }], "error")).toEqual([
      {
        severity: "error",
        path,
        message,
        from,
        to: from + "title: Review the pull request".length,
        line: 15,
      },
    ]);
  });

  it("places an issue at a key that the mapping does not have on the first line of the mapping", () => {
    // The step review writes no params, and the controller names the missing
    // params of its action there.
    const path = ["steps", "1", "params"];
    const from = findUniqueOffset(TEXT, "id: review");

    expect(locateIssues(readWorkflowSource(TEXT), [{ path, message }], "error")).toEqual([
      { severity: "error", path, message, from, to: from + "id: review".length, line: 16 },
    ]);
  });

  it("places an issue at a value written as nothing on its key", () => {
    const text = TEXT.replace("action: task.creat\n", "action:\n");
    const path = ["steps", "1", "action"];
    const from = findUniqueOffset(text, "action:\nedges");

    expect(locateIssues(readWorkflowSource(text), [{ path, message }], "error")).toEqual([
      { severity: "error", path, message, from, to: from + "action:".length, line: 18 },
    ]);
  });

  it("places an issue at the empty path at the document start", () => {
    // While the text parses, the one issue that the controller sends with an
    // empty path says how many more problems a long refusal left out. An
    // underline under the whole text would hide each real underline.
    const path: ReadonlyArray<string> = [];

    expect(locateIssues(readWorkflowSource(TEXT), [{ path, message }], "error")).toEqual([
      { severity: "error", path, message, from: 0, to: expect.any(Number) as unknown, line: 1 },
    ]);
  });

  it("places an issue whose path no longer maps at the document start", () => {
    // The text has two steps. A validation that answered before the author
    // removed a step can name a third or a fourth one.
    const path = ["steps", "3", "action"];

    expect(locateIssues(readWorkflowSource(TEXT), [{ path, message }], "error")).toEqual([
      { severity: "error", path, message, from: 0, to: expect.any(Number) as unknown, line: 1 },
    ]);
  });
});

describe("decideIssueState", () => {
  const error: Issue = { path: ["steps", "1", "action"], message: "task.creat is not an action." };
  const warning: Issue = {
    path: ["triggers", "0", "source", "filter"],
    message: "This filter admits every event.",
  };

  it("answers the parse's problems for a text that does not parse, whatever the controller answered", () => {
    const reading = readWorkflowSource(SHAPE_ERROR_TEXT);

    expect(
      decideIssueState(reading, {
        text: SHAPE_ERROR_TEXT,
        issues: { errors: [error], warnings: [warning] },
      }),
    ).toEqual({ status: "checked", issues: reading.issues });
  });

  it("answers the controller's problems about this text at their places, errors first", () => {
    const reading = readWorkflowSource(TEXT);

    expect(
      decideIssueState(reading, { text: TEXT, issues: { errors: [error], warnings: [warning] } }),
    ).toEqual({
      status: "checked",
      issues: [
        ...locateIssues(reading, [error], "error"),
        ...locateIssues(reading, [warning], "warning"),
      ],
    });
  });

  it("does not place the controller's answer about another text on this one", () => {
    const reading = readWorkflowSource(TEXT);
    const earlierText = TEXT.replace("task.creat\n", "task.cre\n");

    expect(decideIssueState(reading, undefined)).toEqual({ status: "checking" });
    expect(
      decideIssueState(reading, { text: earlierText, issues: { errors: [error], warnings: [] } }),
    ).toEqual({ status: "checking" });
    expect(decideIssueState(reading, { text: earlierText, reason: "Offline." })).toEqual({
      status: "checking",
    });
  });

  it("answers why the controller could not check this text, and no problem for it", () => {
    expect(
      decideIssueState(readWorkflowSource(TEXT), {
        text: TEXT,
        reason: "The controller cannot be reached.",
      }),
    ).toEqual({ status: "failed", reason: "The controller cannot be reached." });
  });
});
