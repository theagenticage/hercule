/**
 * The controller reports each problem with a path into the definition and no
 * text offset, so the editor must convert paths to text ranges itself. Each
 * `locateIssues` test takes one kind of path and checks the range it converts
 * to. `from` and `to` are character offsets into the source.
 */
import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { parseWorkflowSource, type Issue } from "@hercule/contract";
import {
  decideIssueState,
  formatProblemCount,
  locateIssues,
  parseWorkflowSourceWithRanges,
} from "@hercule/client-core";
import { findUniqueOffset } from "./workflow-source.testing";

/**
 * A valid workflow. Line N is array item N - 1.
 *
 * - The comment on the first line makes the definition start after offset 0,
 *   so an offset computed from the wrong start fails the test.
 * - Step `review` has an unknown action, `task.creat`, as if the author were
 *   still typing it. The step before it uses `task.create`, which starts with
 *   the same characters.
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

/** Valid YAML, but a step has an unknown kind, `acton`. */
const SHAPE_ERROR_SOURCE = [
  "name: Review",
  "steps:",
  "  - id: open_task",
  "    kind: acton",
  "    action: task.create",
  "",
].join("\n");

/** Invalid YAML: line 4 has a mapping inside a compact mapping. */
const SYNTAX_ERROR_SOURCE = [
  "name: Review",
  "steps:",
  "  - id: open_task",
  "    kind: action: agent",
  "",
].join("\n");

/** Returns the offset just after `fragment`, which must occur exactly once in `source`. */
const findUniqueEnd = (source: string, fragment: string): number =>
  findUniqueOffset(source, fragment) + fragment.length;

/** Returns the errors from the contract's parse of `source`. Throws if the source parses. */
const listParseIssues = (source: string): ReadonlyArray<Issue> => {
  const parsed = parseWorkflowSource(source);
  if (Result.isSuccess(parsed)) throw new Error("The source parsed, but the test needs errors.");
  return parsed.failure;
};

describe("parseWorkflowSourceWithRanges", () => {
  it("returns the same definition as the contract's parse, and no issues, for a valid source", () => {
    const parsed = parseWorkflowSourceWithRanges(SOURCE);

    expect(parsed.definition).toEqual(Result.getOrThrow(parseWorkflowSource(SOURCE)));
    expect(parsed.issues).toEqual([]);
  });

  it("returns no definition for a schema error, and a range from the key through its value", () => {
    const parsed = parseWorkflowSourceWithRanges(SHAPE_ERROR_SOURCE);
    const from = findUniqueOffset(SHAPE_ERROR_SOURCE, "kind: acton");

    expect(parsed.definition).toBeUndefined();
    // The controller would fail the source with this same issue, because it
    // runs the same parse.
    const [refused] = listParseIssues(SHAPE_ERROR_SOURCE);
    expect(refused?.path).toEqual(["steps", "0", "kind"]);
    expect(parsed.issues).toEqual([
      {
        severity: "error",
        path: ["steps", "0", "kind"],
        message: refused?.message,
        from,
        to: from + "kind: acton".length,
      },
    ]);
  });

  it("returns no definition for a YAML syntax error, and a range on the line the parser reports", () => {
    const parsed = parseWorkflowSourceWithRanges(SYNTAX_ERROR_SOURCE);

    expect(parsed.definition).toBeUndefined();
    expect(parsed.issues.map(({ path, message }) => ({ path, message }))).toEqual(
      listParseIssues(SYNTAX_ERROR_SOURCE),
    );
    const [located] = parsed.issues;
    expect(located?.severity).toBe("error");
    // The parser reports a position on line 4. The range must start on that
    // line and end inside the source.
    const lineStart = findUniqueOffset(SYNTAX_ERROR_SOURCE, "    kind: action: agent");
    const lineEnd = findUniqueEnd(SYNTAX_ERROR_SOURCE, "    kind: action: agent");
    expect(located?.from).toBeGreaterThanOrEqual(lineStart);
    expect(located?.from).toBeLessThanOrEqual(lineEnd);
    expect(located?.to).toBeGreaterThanOrEqual(located?.from ?? Infinity);
    expect(located?.to).toBeLessThanOrEqual(SYNTAX_ERROR_SOURCE.length);
  });

  it.each([
    {
      about: "an unknown field",
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
      about: "a duplicate key",
      lines: ["name: Review", "steps: []", "name: Another review", ""],
      key: "name: Another",
      path: ["name"],
    },
    {
      about: "an output name that expressions cannot reference",
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
  ])("locates $about from the key through its value, on the key's line", (example) => {
    const source = example.lines.join("\n");
    const from = findUniqueOffset(source, example.key);

    expect(parseWorkflowSourceWithRanges(source).issues).toEqual([
      {
        severity: "error",
        path: example.path,
        message: listParseIssues(source)[0]?.message,
        from,
        to: source.indexOf("\n", from),
      },
    ]);
  });
});

describe("locateIssues", () => {
  const message = "The controller's error message.";

  it("locates a scalar value from its key through the value", () => {
    const path = ["steps", "1", "action"];
    const from = findUniqueOffset(SOURCE, "action: task.creat\n");

    expect(
      locateIssues(parseWorkflowSourceWithRanges(SOURCE), [{ path, message }], "error"),
    ).toEqual([{ severity: "error", path, message, from, to: from + "action: task.creat".length }]);
  });

  it("locates a step (a sequence item) on the step's first line", () => {
    const path = ["steps", "1"];
    const from = findUniqueOffset(SOURCE, "id: review");

    expect(
      locateIssues(parseWorkflowSourceWithRanges(SOURCE), [{ path, message }], "error"),
    ).toEqual([
      { severity: "error", path, message, from, to: findUniqueEnd(SOURCE, "id: review") },
    ]);
  });

  it("locates an edge (a sequence item) on the edge's first line", () => {
    const path = ["edges", "0"];
    const from = findUniqueOffset(SOURCE, "from: open_task");

    expect(
      locateIssues(parseWorkflowSourceWithRanges(SOURCE), [{ path, message }], "error"),
    ).toEqual([
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
  ])("locates $about, a key whose value is a list or mapping, on the key's line", (example) => {
    const from = findUniqueOffset(SOURCE, example.fragment);

    expect(
      locateIssues(
        parseWorkflowSourceWithRanges(SOURCE),
        [{ path: example.path, message }],
        "error",
      ),
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

  it("locates a nested key from the key through its value, with the given severity", () => {
    const path = ["triggers", "0", "source", "filter"];
    const from = findUniqueOffset(SOURCE, "filter: event.payload.number > 3");

    expect(
      locateIssues(parseWorkflowSourceWithRanges(SOURCE), [{ path, message }], "warning"),
    ).toEqual([
      {
        severity: "warning",
        path,
        message,
        from,
        to: from + "filter: event.payload.number > 3".length,
      },
    ]);
  });

  it("locates a user-defined key inside params from the key through its value", () => {
    const path = ["steps", "0", "params", "title"];
    const from = findUniqueOffset(SOURCE, "title: Review the pull request");

    expect(
      locateIssues(parseWorkflowSourceWithRanges(SOURCE), [{ path, message }], "error"),
    ).toEqual([
      {
        severity: "error",
        path,
        message,
        from,
        to: from + "title: Review the pull request".length,
      },
    ]);
  });

  it("locates a missing key on the first line of its parent mapping", () => {
    // Step `review` has no params. The controller reports the missing params
    // at this path.
    const path = ["steps", "1", "params"];
    const from = findUniqueOffset(SOURCE, "id: review");

    expect(
      locateIssues(parseWorkflowSourceWithRanges(SOURCE), [{ path, message }], "error"),
    ).toEqual([{ severity: "error", path, message, from, to: from + "id: review".length }]);
  });

  it("locates an empty value on its key", () => {
    const source = SOURCE.replace("action: task.creat\n", "action:\n");
    const path = ["steps", "1", "action"];
    const from = findUniqueOffset(source, "action:\nedges");

    expect(
      locateIssues(parseWorkflowSourceWithRanges(source), [{ path, message }], "error"),
    ).toEqual([{ severity: "error", path, message, from, to: from + "action:".length }]);
  });

  it("locates the empty path at the start of the document", () => {
    // The only issue the controller sends with an empty path is the summary
    // that counts the problems left out of a long list. Underlining the whole
    // source would hide every other underline.
    const path: ReadonlyArray<string> = [];

    expect(
      locateIssues(parseWorkflowSourceWithRanges(SOURCE), [{ path, message }], "error"),
    ).toEqual([{ severity: "error", path, message, from: 0, to: expect.any(Number) as unknown }]);
  });

  it("locates a path that is no longer in the source at the start of the document", () => {
    // The source has two steps. A validation result from before the author
    // removed some steps can still refer to a third or fourth step.
    const path = ["steps", "3", "action"];

    expect(
      locateIssues(parseWorkflowSourceWithRanges(SOURCE), [{ path, message }], "error"),
    ).toEqual([{ severity: "error", path, message, from: 0, to: expect.any(Number) as unknown }]);
  });
});

describe("decideIssueState", () => {
  const error: Issue = { path: ["steps", "1", "action"], message: "task.creat is not an action." };
  const warning: Issue = {
    path: ["triggers", "0", "source", "filter"],
    message: "This filter admits every event.",
  };

  it("returns the local parse errors when there are any, ignoring the controller's result", () => {
    const parsed = parseWorkflowSourceWithRanges(SHAPE_ERROR_SOURCE);

    expect(
      decideIssueState(parsed, {
        source: SHAPE_ERROR_SOURCE,
        issues: { errors: [error], warnings: [warning] },
      }),
    ).toEqual({ status: "validated", issues: parsed.issues });
  });

  it("returns the controller's issues for this source with their ranges, errors first", () => {
    const parsed = parseWorkflowSourceWithRanges(SOURCE);

    expect(
      decideIssueState(parsed, {
        source: SOURCE,
        issues: { errors: [error], warnings: [warning] },
      }),
    ).toEqual({
      status: "validated",
      issues: [
        ...locateIssues(parsed, [error], "error"),
        ...locateIssues(parsed, [warning], "warning"),
      ],
    });
  });

  it("ignores a controller result for a different source", () => {
    const parsed = parseWorkflowSourceWithRanges(SOURCE);
    const earlierSource = SOURCE.replace("task.creat\n", "task.cre\n");

    expect(decideIssueState(parsed, undefined)).toEqual({ status: "validating" });
    expect(
      decideIssueState(parsed, {
        source: earlierSource,
        issues: { errors: [error], warnings: [] },
      }),
    ).toEqual({ status: "validating" });
    expect(decideIssueState(parsed, { source: earlierSource, reason: "Offline." })).toEqual({
      status: "validating",
    });
  });

  it("returns the reason when the controller could not validate this source", () => {
    expect(
      decideIssueState(parseWorkflowSourceWithRanges(SOURCE), {
        source: SOURCE,
        reason: "The controller cannot be reached.",
      }),
    ).toEqual({ status: "failed", reason: "The controller cannot be reached." });
  });
});

describe("formatProblemCount", () => {
  it("uses the singular for one problem and the plural for any other count", () => {
    expect(formatProblemCount(1)).toBe("1 problem");
    expect(formatProblemCount(2)).toBe("2 problems");
    expect(formatProblemCount(12)).toBe("12 problems");
  });
});
