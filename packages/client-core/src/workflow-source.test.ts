/**
 * How the browser reads a workflow's source: the one parse of the source, and
 * the place in the source of each problem that the parse or the controller
 * names.
 *
 * The controller names a problem by its path into the definition and never by
 * a position, so that the contract stays free of positions. The editor must
 * find the place in the source itself. Each test of `locateIssues` writes a
 * source, names one kind of path, and checks the characters that the path
 * lands on. `from` and `to` are character offsets into the source. A path
 * that ends at a key lands on the key through its value. A range covers the
 * first line of its place only, and not the line break after it.
 */
import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { parseWorkflowSource, type Issue } from "@hercule/contract";
import {
  decideIssueState,
  formatProblemCount,
  locateIssues,
  readWorkflowSource,
} from "@hercule/client-core";
import { findUniqueOffset } from "./workflow-source.testing";

/**
 * A valid workflow, one line for each item, so line N is item N - 1. The
 * comment on the first line puts the definition after the start of the source,
 * so a place that counts from the wrong start shows.
 * Step `review` names an action that does not exist, as a typing author
 * leaves it, and `task.create` in the step before it has the same first
 * characters.
 */
const SOURCE = [
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
const SHAPE_ERROR_SOURCE = [
  "name: Review",
  "steps:",
  "  - id: open_task",
  "    kind: acton",
  "    action: task.create",
  "",
].join("\n");

/** Line 4 holds a mapping inside a compact mapping, which YAML does not allow. */
const SYNTAX_ERROR_SOURCE = [
  "name: Review",
  "steps:",
  "  - id: open_task",
  "    kind: action: agent",
  "",
].join("\n");

/** The offset just after a fragment that the source holds exactly once. */
const findUniqueEnd = (source: string, fragment: string): number =>
  findUniqueOffset(source, fragment) + fragment.length;

/** The issues that the shared parse refuses a source with. A source that parses fails the test. */
const listParseIssues = (source: string): ReadonlyArray<Issue> => {
  const parsed = parseWorkflowSource(source);
  if (Result.isSuccess(parsed)) throw new Error("The source parsed, and the test needs a refusal.");
  return parsed.failure;
};

describe("readWorkflowSource", () => {
  it("answers the definition that the shared parse answers, and no issues, for a source that parses", () => {
    const reading = readWorkflowSource(SOURCE);

    expect(reading.definition).toEqual(Result.getOrThrow(parseWorkflowSource(SOURCE)));
    expect(reading.issues).toEqual([]);
  });

  it("answers no definition for a shape error, and places the issue from the key through the value it names", () => {
    const reading = readWorkflowSource(SHAPE_ERROR_SOURCE);
    const from = findUniqueOffset(SHAPE_ERROR_SOURCE, "kind: acton");

    expect(reading.definition).toBeUndefined();
    // The same issue that the controller refuses the source with, because both
    // read the source with the one parse.
    const [refused] = listParseIssues(SHAPE_ERROR_SOURCE);
    expect(refused?.path).toEqual(["steps", "0", "kind"]);
    expect(reading.issues).toEqual([
      {
        severity: "error",
        path: ["steps", "0", "kind"],
        message: refused?.message,
        from,
        to: from + "kind: acton".length,
      },
    ]);
  });

  it("answers no definition for a syntax error, and places the issue on the line the parser names", () => {
    const reading = readWorkflowSource(SYNTAX_ERROR_SOURCE);

    expect(reading.definition).toBeUndefined();
    expect(reading.issues.map(({ path, message }) => ({ path, message }))).toEqual(
      listParseIssues(SYNTAX_ERROR_SOURCE),
    );
    const [located] = reading.issues;
    expect(located?.severity).toBe("error");
    // The parser names a position on line 4. The range starts on that line and
    // stays inside the source.
    const lineStart = findUniqueOffset(SYNTAX_ERROR_SOURCE, "    kind: action: agent");
    const lineEnd = findUniqueEnd(SYNTAX_ERROR_SOURCE, "    kind: action: agent");
    expect(located?.from).toBeGreaterThanOrEqual(lineStart);
    expect(located?.from).toBeLessThanOrEqual(lineEnd);
    expect(located?.to).toBeGreaterThanOrEqual(located?.from ?? Infinity);
    expect(located?.to).toBeLessThanOrEqual(SYNTAX_ERROR_SOURCE.length);
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
    },
    {
      about: "a key that its mapping has twice",
      lines: ["name: Review", "steps: []", "name: Another review", ""],
      key: "name: Another",
      path: ["name"],
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
    },
  ])(
    "places a problem about $about from the key through its value, on the key's line",
    (example) => {
      const source = example.lines.join("\n");
      const from = findUniqueOffset(source, example.key);

      expect(readWorkflowSource(source).issues).toEqual([
        {
          severity: "error",
          path: example.path,
          message: listParseIssues(source)[0]?.message,
          from,
          to: source.indexOf("\n", from),
        },
      ]);
    },
  );
});

describe("locateIssues", () => {
  const message = "The controller's words for the problem.";

  it("places an issue at a scalar value from its key through that value", () => {
    const path = ["steps", "1", "action"];
    const from = findUniqueOffset(SOURCE, "action: task.creat\n");

    expect(locateIssues(readWorkflowSource(SOURCE), [{ path, message }], "error")).toEqual([
      { severity: "error", path, message, from, to: from + "action: task.creat".length },
    ]);
  });

  it("places an issue at a step, a sequence item, on the first line of that step", () => {
    const path = ["steps", "1"];
    const from = findUniqueOffset(SOURCE, "id: review");

    expect(locateIssues(readWorkflowSource(SOURCE), [{ path, message }], "error")).toEqual([
      { severity: "error", path, message, from, to: findUniqueEnd(SOURCE, "id: review") },
    ]);
  });

  it("places an issue at an edge, a sequence item, on the first line of that edge", () => {
    const path = ["edges", "0"];
    const from = findUniqueOffset(SOURCE, "from: open_task");

    expect(locateIssues(readWorkflowSource(SOURCE), [{ path, message }], "error")).toEqual([
      {
        severity: "error",
        path,
        message,
        from,
        to: findUniqueEnd(SOURCE, "from: open_task"),
      },
    ]);
  });

  it.each([
    { about: "the steps", path: ["steps"], fragment: "steps:" },
    { about: "the edges", path: ["edges"], fragment: "edges:" },
    {
      about: "the params of a step",
      path: ["steps", "0", "params"],
      fragment: "params:",
    },
  ])("places an issue at $about, a key with a list or a mapping, on the key's line", (example) => {
    const from = findUniqueOffset(SOURCE, example.fragment);

    expect(
      locateIssues(readWorkflowSource(SOURCE), [{ path: example.path, message }], "error"),
    ).toEqual([
      {
        severity: "error",
        path: example.path,
        message,
        from,
        to: from + example.fragment.length,
      },
    ]);
  });

  it("places an issue at a nested key from the key through its value, with the severity it is given", () => {
    const path = ["triggers", "0", "source", "filter"];
    const from = findUniqueOffset(SOURCE, "filter: event.payload.number > 3");

    expect(locateIssues(readWorkflowSource(SOURCE), [{ path, message }], "warning")).toEqual([
      {
        severity: "warning",
        path,
        message,
        from,
        to: from + "filter: event.payload.number > 3".length,
      },
    ]);
  });

  it("places an issue at a key the author chose, inside params, from the key through its value", () => {
    const path = ["steps", "0", "params", "title"];
    const from = findUniqueOffset(SOURCE, "title: Review the pull request");

    expect(locateIssues(readWorkflowSource(SOURCE), [{ path, message }], "error")).toEqual([
      {
        severity: "error",
        path,
        message,
        from,
        to: from + "title: Review the pull request".length,
      },
    ]);
  });

  it("places an issue at a key that the mapping does not have on the first line of the mapping", () => {
    // The step review writes no params, and the controller names the missing
    // params of its action there.
    const path = ["steps", "1", "params"];
    const from = findUniqueOffset(SOURCE, "id: review");

    expect(locateIssues(readWorkflowSource(SOURCE), [{ path, message }], "error")).toEqual([
      { severity: "error", path, message, from, to: from + "id: review".length },
    ]);
  });

  it("places an issue at a value written as nothing on its key", () => {
    const source = SOURCE.replace("action: task.creat\n", "action:\n");
    const path = ["steps", "1", "action"];
    const from = findUniqueOffset(source, "action:\nedges");

    expect(locateIssues(readWorkflowSource(source), [{ path, message }], "error")).toEqual([
      { severity: "error", path, message, from, to: from + "action:".length },
    ]);
  });

  it("places an issue at the empty path at the document start", () => {
    // While the source parses, the one issue that the controller sends with an
    // empty path says how many more problems a long refusal left out. An
    // underline under the whole source would hide each real underline.
    const path: ReadonlyArray<string> = [];

    expect(locateIssues(readWorkflowSource(SOURCE), [{ path, message }], "error")).toEqual([
      { severity: "error", path, message, from: 0, to: expect.any(Number) as unknown },
    ]);
  });

  it("places an issue whose path no longer maps at the document start", () => {
    // The source has two steps. A validation that answered before the author
    // removed a step can name a third or a fourth one.
    const path = ["steps", "3", "action"];

    expect(locateIssues(readWorkflowSource(SOURCE), [{ path, message }], "error")).toEqual([
      { severity: "error", path, message, from: 0, to: expect.any(Number) as unknown },
    ]);
  });
});

describe("decideIssueState", () => {
  const error: Issue = { path: ["steps", "1", "action"], message: "task.creat is not an action." };
  const warning: Issue = {
    path: ["triggers", "0", "source", "filter"],
    message: "This filter admits every event.",
  };

  it("answers the parse's problems for a source that does not parse, whatever the controller answered", () => {
    const reading = readWorkflowSource(SHAPE_ERROR_SOURCE);

    expect(
      decideIssueState(reading, {
        source: SHAPE_ERROR_SOURCE,
        issues: { errors: [error], warnings: [warning] },
      }),
    ).toEqual({ status: "validated", issues: reading.issues });
  });

  it("answers the controller's problems about this source at their places, errors first", () => {
    const reading = readWorkflowSource(SOURCE);

    expect(
      decideIssueState(reading, {
        source: SOURCE,
        issues: { errors: [error], warnings: [warning] },
      }),
    ).toEqual({
      status: "validated",
      issues: [
        ...locateIssues(reading, [error], "error"),
        ...locateIssues(reading, [warning], "warning"),
      ],
    });
  });

  it("does not place the controller's answer about another source on this one", () => {
    const reading = readWorkflowSource(SOURCE);
    const earlierSource = SOURCE.replace("task.creat\n", "task.cre\n");

    expect(decideIssueState(reading, undefined)).toEqual({ status: "validating" });
    expect(
      decideIssueState(reading, {
        source: earlierSource,
        issues: { errors: [error], warnings: [] },
      }),
    ).toEqual({ status: "validating" });
    expect(decideIssueState(reading, { source: earlierSource, reason: "Offline." })).toEqual({
      status: "validating",
    });
  });

  it("answers why the controller could not validate this source, and no problem for it", () => {
    expect(
      decideIssueState(readWorkflowSource(SOURCE), {
        source: SOURCE,
        reason: "The controller cannot be reached.",
      }),
    ).toEqual({ status: "failed", reason: "The controller cannot be reached." });
  });
});

describe("formatProblemCount", () => {
  it("says one problem in the singular, and any other count in the plural", () => {
    expect(formatProblemCount(1)).toBe("1 problem");
    expect(formatProblemCount(2)).toBe("2 problems");
    expect(formatProblemCount(12)).toBe("12 problems");
  });
});
