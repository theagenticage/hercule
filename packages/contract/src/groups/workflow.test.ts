/**
 * The one parse and the one canonical render of a workflow's YAML source.
 *
 * The controller and the web app both call these two functions, so what a
 * source means and how a definition object is written back as text are
 * decided here and nowhere else. The render is checked as a property over
 * generated definitions, because a rule such as "a string with a newline is a
 * block scalar" is about every string at every place, and a handful of
 * examples would only check the places the examples happen to use.
 *
 * `parseWorkflowSource` answers the definition or the issues. The two helpers
 * below are the only code that reads the shape of that answer.
 */
import { describe, expect, it } from "vitest";
import { Result } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import {
  decodeWorkflowDefinition,
  parseWorkflowSource,
  renderWorkflowSource,
  type Issue,
  type WorkflowDefinition,
} from "../index";

/** The definition a source parses to. A refusal fails the test and shows its issues. */
const parseDefinition = (source: string): WorkflowDefinition => {
  const parsed = parseWorkflowSource(source);
  if (Result.isFailure(parsed)) {
    throw new Error(`the source was refused: ${JSON.stringify(parsed.failure)}\n${source}`);
  }
  return parsed.success;
};

/** The issues the parse refuses a source with. Empty when the source parses. */
const collectIssues = (source: string): ReadonlyArray<Issue> => {
  const parsed = parseWorkflowSource(source);
  return Result.isFailure(parsed) ? parsed.failure : [];
};

const listIssuePaths = (issues: ReadonlyArray<Issue>): ReadonlyArray<ReadonlyArray<string>> =>
  issues.map((issue) => issue.path);

/** The top-level keys, in the order the definition shape declares them. */
const TOP_LEVEL_KEY_ORDER = [
  "name",
  "description",
  "inputs",
  "triggers",
  "steps",
  "edges",
  "workspace",
];

/** A Connection, Agent or Resource id. The parse only reads its shape. */
const ENTITY_ID = "0199e0e7-1111-7000-8000-0000000000ab";

/** Words that YAML reads as plain text, so a line made of them needs no quotes. */
const PLAIN_WORDS = [
  "review",
  "the",
  "pull",
  "request",
  "label",
  "and",
  "open",
  "a",
  "task",
  "fix",
  "tests",
  "say",
  "what",
  "changed",
];

/**
 * Text that YAML reads as something else, or cannot read at all, without
 * quotes: a boolean, a null, a number, an indicator character at the start, a
 * comment marker, a mapping separator, or space at an end. Two of them contain
 * one kind of quote, because a YAML writer that is free to choose picks the
 * other kind of quote for those.
 */
const TEXTS_NEEDING_QUOTES = [
  "true",
  "null",
  "123",
  "1.5",
  "~",
  "- dash",
  "#hash",
  "a: b",
  '"quoted" start',
  "'single' start",
  " leading space",
  "trailing space ",
  "@at",
  "{brace",
  "[bracket",
  "*star",
  "&anchor",
  "!tag",
  "%percent",
  "|pipe",
  ">greater",
  "`tick",
  "text #comment",
];

const CEL_EXPRESSIONS = [
  "event.payload.number > 3",
  '"bug" in event.payload.labels',
  "has(steps.review)",
  'inputs.pr_url != ""',
];

/** A step, trigger or input name: a CEL identifier, because an expression reads it. */
const identifierArbitrary = FastCheck.stringMatching(/^[a-z][a-z0-9_]{0,11}$/);

const plainTextArbitrary = FastCheck.array(FastCheck.constantFrom(...PLAIN_WORDS), {
  minLength: 1,
  maxLength: 5,
}).map((words) => words.join(" "));

const quotedTextArbitrary = FastCheck.constantFrom(...TEXTS_NEEDING_QUOTES);

/** Spaces and tabs a person leaves at the end of a line, or nothing. */
const lineEndArbitrary = FastCheck.constantFrom("", " ", "  ", "\t", " \t ");

/** A line with words, sometimes with whitespace after them. */
const wordsLineArbitrary = FastCheck.tuple(plainTextArbitrary, lineEndArbitrary).map(
  ([words, end]) => words + end,
);

/**
 * Two to five lines. The first and the last hold words; a line between them
 * holds words, nothing, or only whitespace. The text sometimes ends with one
 * or two newlines.
 *
 * No line starts with whitespace here: the property below reads the leading
 * whitespace of every line as indentation. The cases below the property check
 * such lines.
 */
const multilineTextArbitrary = FastCheck.tuple(
  wordsLineArbitrary,
  FastCheck.array(FastCheck.oneof(wordsLineArbitrary, lineEndArbitrary), { maxLength: 3 }),
  wordsLineArbitrary,
  FastCheck.constantFrom("", "\n", "\n\n"),
).map(([first, between, last, end]) => [first, ...between, last].join("\n") + end);

const anyTextArbitrary = FastCheck.oneof(
  plainTextArbitrary,
  quotedTextArbitrary,
  multilineTextArbitrary,
);

/**
 * Only whitespace and line breaks. A block cannot hold such a text, so it is
 * written in double quotes, and it is generated only where the property does
 * not check how a string is written.
 */
const blankLinesArbitrary = FastCheck.array(lineEndArbitrary, { minLength: 2, maxLength: 4 }).map(
  (lines) => lines.join("\n"),
);

/** Any text, or one of only whitespace and line breaks. */
const anyTextOrBlankLinesArbitrary = FastCheck.oneof(anyTextArbitrary, blankLinesArbitrary);

const expressionArbitrary = FastCheck.constantFrom(...CEL_EXPRESSIONS);

/*
 * The contract fixes the order of its own keys. The keys of a map whose keys
 * the author chooses (params, options, schemas, input mappings, outputs) keep
 * the order in which they were sent. `params` has two keys here, in either
 * order, so the property checks that the render keeps that order; the other
 * maps have one key.
 */

const buildSchemaInputArbitrary = (name: string) =>
  FastCheck.record(
    {
      name: FastCheck.constant(name),
      schema: FastCheck.constant({ type: "string" }),
      required: FastCheck.boolean(),
      default: anyTextOrBlankLinesArbitrary,
    },
    { requiredKeys: ["name", "schema", "required"] },
  );

const buildConnectionInputArbitrary = (name: string) =>
  FastCheck.record(
    {
      name: FastCheck.constant(name),
      connection: FastCheck.constant({ type: "github/github" }),
      required: FastCheck.boolean(),
      default: FastCheck.constant(ENTITY_ID),
    },
    { requiredKeys: ["name", "connection", "required"] },
  );

const eventSelectorArbitrary = FastCheck.record(
  {
    kind: FastCheck.constantFrom("cron.tick", "task.created", "github.pr.labeled"),
    connectionId: FastCheck.constantFrom("any", ENTITY_ID),
    filter: expressionArbitrary,
  },
  { requiredKeys: ["kind"] },
);

const buildStartTriggerArbitrary = (id: string) =>
  FastCheck.record(
    {
      id: FastCheck.constant(id),
      kind: FastCheck.constant("start"),
      source: eventSelectorArbitrary,
      inputs: FastCheck.constant({ pr_number: "event.payload.number" }),
      spawnBound: FastCheck.record({
        maxRuns: FastCheck.integer({ min: 1, max: 100 }),
        windowSeconds: FastCheck.integer({ min: 1, max: 86_400 }),
      }),
      schedule: FastCheck.constant("0 9 * * 1-5"),
      timezone: FastCheck.constant("Europe/Amsterdam"),
    },
    { requiredKeys: ["id", "kind", "source"] },
  );

const buildSignalTriggerArbitrary = (id: string) =>
  FastCheck.record(
    {
      id: FastCheck.constant(id),
      kind: FastCheck.constant("signal"),
      source: eventSelectorArbitrary,
      correlation: FastCheck.record({
        event: FastCheck.constant("event.payload.number"),
        run: FastCheck.constant("steps.review.output.number"),
      }),
      outputs: FastCheck.constant({ merged: "event.payload.merged" }),
    },
    { requiredKeys: ["id", "kind", "source", "correlation"] },
  );

const stepCommonKeyArbitraries = {
  name: plainTextArbitrary,
  condition: expressionArbitrary,
  join: FastCheck.constantFrom("any", "all"),
  entry: FastCheck.boolean(),
  terminal: FastCheck.boolean(),
};

const buildActionStepArbitrary = (id: string) =>
  FastCheck.record(
    {
      id: FastCheck.constant(id),
      kind: FastCheck.constant("action"),
      action: FastCheck.constantFrom("task.create", "task.query"),
      params: FastCheck.tuple(
        anyTextOrBlankLinesArbitrary,
        anyTextArbitrary,
        FastCheck.boolean(),
      ).map(([title, description, descriptionFirst]) =>
        descriptionFirst ? { description, title } : { title, description },
      ),
      ...stepCommonKeyArbitraries,
    },
    { requiredKeys: ["id", "kind", "action"] },
  );

const buildAgentStepArbitrary = (id: string) =>
  FastCheck.record(
    {
      id: FastCheck.constant(id),
      kind: FastCheck.constant("agent"),
      agent: FastCheck.constant(ENTITY_ID),
      prompt: anyTextArbitrary,
      model: FastCheck.constant("fast"),
      options: FastCheck.constant({ effort: "high" }),
      accessMode: FastCheck.constantFrom(
        "approval-required",
        "auto-accept-edits",
        "auto",
        "full-access",
      ),
      freshSession: FastCheck.boolean(),
      outputSchema: FastCheck.constant({ type: "object" }),
      ...stepCommonKeyArbitraries,
    },
    { requiredKeys: ["id", "kind", "agent", "prompt"] },
  );

const buildEdgeArbitrary = (from: ReadonlyArray<string>, to: ReadonlyArray<string>) =>
  FastCheck.record(
    {
      from: FastCheck.constantFrom(...from),
      to: FastCheck.constantFrom(...to),
      condition: expressionArbitrary,
      maxTraversals: FastCheck.integer({ min: 1, max: 5 }),
    },
    { requiredKeys: ["from", "to"] },
  );

const workspaceArbitrary = FastCheck.oneof(
  FastCheck.record(
    {
      kind: FastCheck.constant("primary"),
      resourceId: FastCheck.constant(ENTITY_ID),
      branch: FastCheck.constant("main"),
    },
    { requiredKeys: ["kind", "resourceId"] },
  ),
  FastCheck.record({
    kind: FastCheck.constant("ephemeral"),
    checkouts: FastCheck.array(
      FastCheck.record(
        { resourceId: FastCheck.constant(ENTITY_ID), baseBranch: FastCheck.constant("main") },
        { requiredKeys: ["resourceId"] },
      ),
      { minLength: 1, maxLength: 2 },
    ),
  }),
);

/**
 * A definition the parse accepts: every id a CEL identifier, and no id used by
 * two nodes, triggers and steps together. Whether its agents, actions and
 * event kinds exist is the server's question and not the parse's, so they are
 * fixed values here.
 */
const definitionArbitrary = FastCheck.record({
  nodeIds: FastCheck.uniqueArray(identifierArbitrary, { minLength: 1, maxLength: 6 }),
  inputNames: FastCheck.uniqueArray(identifierArbitrary, { maxLength: 2 }),
  triggerCount: FastCheck.integer({ min: 0, max: 3 }),
}).chain(({ nodeIds, inputNames, triggerCount }) => {
  const triggerIds = nodeIds.slice(0, Math.min(triggerCount, nodeIds.length - 1));
  const stepIds = nodeIds.slice(triggerIds.length);
  return FastCheck.record(
    {
      name: FastCheck.oneof(plainTextArbitrary, quotedTextArbitrary),
      description: anyTextArbitrary,
      inputs: FastCheck.tuple(
        ...inputNames.map((name) =>
          FastCheck.oneof(buildSchemaInputArbitrary(name), buildConnectionInputArbitrary(name)),
        ),
      ),
      triggers: FastCheck.tuple(
        ...triggerIds.map((id) =>
          FastCheck.oneof(buildStartTriggerArbitrary(id), buildSignalTriggerArbitrary(id)),
        ),
      ),
      steps: FastCheck.tuple(
        ...stepIds.map((id) =>
          FastCheck.oneof(buildActionStepArbitrary(id), buildAgentStepArbitrary(id)),
        ),
      ),
      edges: FastCheck.array(buildEdgeArbitrary(nodeIds, stepIds), { maxLength: 3 }),
      workspace: workspaceArbitrary,
    },
    { requiredKeys: ["name", "steps"] },
  );
});

/**
 * The fields whose value is a map with keys the author chooses. The author's
 * order of those keys is kept, so `reverseKeys` leaves such a map as it is.
 */
const AUTHOR_KEYED_FIELDS = new Set([
  "params",
  "options",
  "outputSchema",
  "schema",
  "default",
  "inputs",
  "outputs",
]);

/**
 * The same value with the contract's keys of every object written in reverse
 * order. A map with keys the author chooses stays as it is. The top-level
 * `inputs` is a list, so the declarations in it are reversed too.
 */
const reverseKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, item]) => [
        key,
        AUTHOR_KEYED_FIELDS.has(key) && !Array.isArray(item) ? item : reverseKeys(item),
      ]),
  );
};

/** The keys of each step's `params`, in the order the value holds them. */
const listParamsKeys = (definition: unknown): ReadonlyArray<ReadonlyArray<string>> =>
  (definition as { steps: ReadonlyArray<{ params?: object }> }).steps.flatMap((step) =>
    step.params === undefined ? [] : [Object.keys(step.params)],
  );

/** The keys written at the left margin, in the order the text writes them. */
const readTopLevelKeys = (text: string): ReadonlyArray<string> =>
  text.split("\n").flatMap((line) => {
    const key = /^([A-Za-z]+):/.exec(line)?.[1];
    return key === undefined ? [] : [key];
  });

const countMatches = (text: string, pattern: RegExp): number => (text.match(pattern) ?? []).length;

/** A block scalar header: `|`, with an optional chomping and indentation indicator. */
const BLOCK_SCALAR_HEADER = /\|[-+0-9]*$/;

/** The prompts of a definition's agent steps, in step order. */
const collectPrompts = (definition: Record<string, unknown>): ReadonlyArray<string> =>
  (definition["steps"] as ReadonlyArray<Record<string, unknown>>).flatMap((step) =>
    step["kind"] === "agent" ? [step["prompt"] as string] : [],
  );

describe("rendering a definition as canonical YAML", () => {
  it("gives the same bytes for the same object, in contract order, with block and double-quoted scalars, two-space indent, and a parse back to the same definition", () => {
    FastCheck.assert(
      FastCheck.property(definitionArbitrary, (generated) => {
        const definition = generated as unknown as WorkflowDefinition;
        const definitionFields = generated as Record<string, unknown>;
        const source = renderWorkflowSource(definition);

        // The same object gives the same bytes, and so does a copy of it.
        expect(renderWorkflowSource(definition)).toBe(source);
        expect(renderWorkflowSource(structuredClone(definition))).toBe(source);

        // The order the caller wrote the contract's keys in changes nothing.
        expect(renderWorkflowSource(reverseKeys(generated) as WorkflowDefinition)).toBe(source);
        expect(readTopLevelKeys(source)).toEqual(
          TOP_LEVEL_KEY_ORDER.filter((key) => key in definitionFields),
        );
        // The keys the author chooses keep the order in which they were sent.
        expect(listParamsKeys(parseDefinition(source))).toEqual(listParamsKeys(generated));

        // A string with a newline is a block scalar; a string that needs
        // quotes has double quotes; a plain string is written as it is.
        const description = definitionFields["description"];
        if (typeof description === "string") {
          const descriptionLine =
            source.split("\n").find((line) => line.startsWith("description:")) ?? "";
          if (description.includes("\n")) {
            expect(descriptionLine).toMatch(BLOCK_SCALAR_HEADER);
          } else if (TEXTS_NEEDING_QUOTES.includes(description)) {
            expect(descriptionLine).toMatch(/^description: "/);
          } else {
            expect(descriptionLine).toBe(`description: ${description}`);
          }
        }
        const prompts = collectPrompts(definitionFields);
        expect(countMatches(source, /^\s+prompt: \|[-+0-9]*$/gm)).toBe(
          prompts.filter((prompt) => prompt.includes("\n")).length,
        );
        expect(countMatches(source, /^\s+prompt: "/gm)).toBe(
          prompts.filter((prompt) => TEXTS_NEEDING_QUOTES.includes(prompt)).length,
        );
        expect(source).not.toMatch(/^[\s-]*[A-Za-z]+: '/m);

        // Each level of nesting is two spaces deeper than the one around it.
        let previousIndent = 0;
        for (const line of source.split("\n").filter((written) => written.trim() !== "")) {
          const indent = line.length - line.trimStart().length;
          expect(indent % 2, line).toBe(0);
          expect(indent, line).toBeLessThanOrEqual(previousIndent + 2);
          previousIndent = indent;
        }

        expect(parseDefinition(source)).toEqual(generated);
      }),
    );
  });
});

describe("parsing a source that is not valid", () => {
  it("names a YAML syntax error once, with no path, by its line and column", () => {
    // The stray word after the closing quote on line 9 starts at column 20.
    const issues = collectIssues(`# A workflow with one broken line.
name: broken

steps:
  - id: file_task
    kind: action
    action: task.create
    params:
      title: "one" two
      description: body
`);
    expect(listIssuePaths(issues)).toEqual([[]]);
    expect(issues[0]!.message).toMatch(/\b9\b/);
    expect(issues[0]!.message).toMatch(/\b20\b/);
  });

  it("points a field of the wrong shape at that field", () => {
    const issues = collectIssues(`name: wrong kind
steps:
  - id: file_task
    kind: script
    action: task.create
`);
    expect(listIssuePaths(issues)).toEqual([["steps", "0", "kind"]]);
  });

  it("points two steps that share an id at the second one", () => {
    const issues = collectIssues(`name: two steps, one id
steps:
  - id: file_task
    kind: action
    action: task.create
  - id: file_task
    kind: action
    action: task.create
`);
    expect(listIssuePaths(issues)).toEqual([["steps", "1", "id"]]);
  });

  it("points a signal trigger that repeats a start trigger's id at the signal trigger", () => {
    const issues = collectIssues(`name: three triggers, two ids
triggers:
  - id: nightly
    kind: start
    source:
      kind: cron.tick
    schedule: "0 2 * * *"
  - id: on_create
    kind: start
    source:
      kind: task.created
  - id: nightly
    kind: signal
    source:
      kind: task.updated
    correlation:
      event: event.payload.id
      run: steps.file_task.output.id
steps:
  - id: file_task
    kind: action
    action: task.create
`);
    expect(listIssuePaths(issues)).toEqual([["triggers", "2", "id"]]);
  });

  it("points a step that repeats a trigger's id at the step, even where the text writes the steps first", () => {
    // Triggers come before steps in the definition, whatever order the text
    // writes them in, so the step is the second node with the id.
    const issues = collectIssues(`name: a step that reuses a trigger id
steps:
  - id: file_task
    kind: action
    action: task.create
  - id: nightly
    kind: action
    action: task.create
triggers:
  - id: nightly
    kind: start
    source:
      kind: cron.tick
    schedule: "0 2 * * *"
`);
    expect(listIssuePaths(issues)).toEqual([["steps", "1", "id"]]);
  });

  it("points a step id that is not snake_case at it and suggests the snake_case spelling", () => {
    const issues = collectIssues(`name: kebab step
steps:
  - id: open-pr
    kind: action
    action: task.create
`);
    expect(listIssuePaths(issues)).toEqual([["steps", "0", "id"]]);
    expect(issues[0]!.message).toContain("open_pr");
  });

  it("points a trigger id that is not snake_case at it and suggests the snake_case spelling", () => {
    const issues = collectIssues(`name: kebab trigger
triggers:
  - id: checks-failed
    kind: start
    source:
      kind: task.created
steps:
  - id: file_task
    kind: action
    action: task.create
`);
    expect(listIssuePaths(issues)).toEqual([["triggers", "0", "id"]]);
    expect(issues[0]!.message).toContain("checks_failed");
  });
});

/** One action step, the smallest body a case can put a mistake beside. */
const ONE_STEP = `steps:
  - id: file_task
    kind: action
    action: task.create
`;

/** A value nested in lists this many levels deep. */
const nestInLists = (levels: number): unknown =>
  Array.from({ length: levels }).reduce<unknown>((inner) => [inner], "bottom");

describe("parsing a source that copies one part of itself into another", () => {
  it("refuses an alias to an anchor that does not exist, at the alias, and does not throw", () => {
    const issues = collectIssues(`name: dangling alias\nsteps: *nowhere\n`);
    expect(listIssuePaths(issues)).toEqual([["steps"]]);
    expect(issues[0]!.message).toMatch(/anchors or aliases/);
  });

  it("refuses an alias bomb at each anchor, without expanding it", () => {
    const levels = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    const bomb = levels
      .map((level, index) =>
        index === 0
          ? `${level}: &${level} [lol, lol, lol, lol, lol, lol, lol, lol, lol]`
          : `${level}: &${level} [${Array.from({ length: 9 }, () => `*${levels[index - 1]!}`).join(", ")}]`,
      )
      .join("\n");
    const issues = collectIssues(`name: bomb\n${bomb}\n${ONE_STEP}`);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.length).toBeLessThan(100);
    expect(listIssuePaths(issues)).toContainEqual(["a"]);
  });

  it("refuses a plain anchor at its place", () => {
    expect(
      listIssuePaths(
        collectIssues(`name: anchored
steps:
  - &first
    id: file_task
    kind: action
    action: task.create
`),
      ),
    ).toEqual([["steps", "0"]]);
  });

  it("reads << as an ordinary key, as YAML 1.2 does, and merges nothing", () => {
    for (const key of ["<<", '"<<"']) {
      const definition = parseDefinition(`name: merged
steps:
  - id: file_task
    kind: action
    action: task.create
    params:
      ${key}: { title: One }
`);
      expect(definition.steps[0]).toMatchObject({ params: { "<<": { title: "One" } } });
    }
  });
});

describe("parsing text that is not valid Unicode", () => {
  it("refuses half of a surrogate pair in the text, by its line and column", () => {
    const issues = collectIssues(`name: broken\ndescription: a\uD800b\n${ONE_STEP}`);
    expect(listIssuePaths(issues)).toEqual([[]]);
    expect(issues[0]!.message).toContain("line 2, column 15");
  });

  it("refuses half of a surrogate pair written as an escape, at its field", () => {
    const issues = collectIssues(`name: escaped\ndescription: "a\\uD800b"\n${ONE_STEP}`);
    expect(listIssuePaths(issues)).toEqual([["description"]]);
  });

  it("refuses a definition object whose canonical text would hold one", () => {
    const definition = parseDefinition(`name: good\n${ONE_STEP}`);
    const issues = collectIssues(renderWorkflowSource({ ...definition, description: "a\uDC00b" }));
    expect(listIssuePaths(issues)).toEqual([["description"]]);
  });
});

describe("parsing a source with a JSON value nested too deep", () => {
  it("takes 32 levels of mappings and lists in a field, and refuses 33 at that field", () => {
    const withParams = (levels: number) =>
      decodeWorkflowDefinition({
        name: "deep",
        steps: [
          {
            id: "file_task",
            kind: "action",
            action: "task.create",
            // The params mapping is the first level.
            params: { title: nestInLists(levels - 1) },
          },
        ],
      });
    expect(Result.isSuccess(withParams(32))).toBe(true);
    const refused = withParams(33);
    expect(Result.isFailure(refused) ? listIssuePaths(refused.failure) : []).toEqual([
      ["steps", "0", "params"],
    ]);
  });

  it("refuses a value thousands of levels deep without running out of stack", () => {
    const refused = decodeWorkflowDefinition({
      name: "deeper",
      inputs: [{ name: "pr", schema: { a: nestInLists(20_000) }, required: true }],
      steps: [],
    });
    expect(Result.isFailure(refused) ? listIssuePaths(refused.failure) : []).toEqual([
      ["inputs", "0", "schema"],
    ]);
  });
});

describe("what a refusal repeats of the source", () => {
  const longWord = "Open-PR-".repeat(2_000);

  it("quotes at most a short part of a long value in the definition", () => {
    const issues = collectIssues(`name: long
triggers:
  - id: ${longWord}
    kind: start
    source:
      kind: task.created
      connectionId: ${longWord}
  - id: ${longWord}
    kind: start
    source:
      kind: task.created
steps:
  - id: file_task
    kind: ${longWord}
`);
    expect(listIssuePaths(issues)).toEqual([
      ["triggers", "0", "id"],
      ["triggers", "0", "source", "connectionId"],
      ["triggers", "1", "id"],
      ["steps", "0", "kind"],
      ["triggers", "1", "id"],
    ]);
    for (const issue of issues) expect(issue.message.length, issue.message).toBeLessThan(400);
  });

  it("cuts short what the YAML parser repeats of the text", () => {
    const issues = collectIssues(`name: long\ndescription: |${longWord}\n${ONE_STEP}`);
    expect(listIssuePaths(issues)).toEqual([[]]);
    expect(issues[0]!.message.length).toBeLessThan(400);
    // The dots of the cut are not followed by a full stop.
    expect(issues[0]!.message).toContain("...");
    expect(issues[0]!.message).not.toContain("....");
  });

  it("never cuts a quoted value between the two halves of a surrogate pair", () => {
    // The 40th character, the last one a quote keeps, is the first half of a pair.
    const written = `${"a".repeat(39)}${String.fromCodePoint(0x1f600)}${"b".repeat(10)}`;
    const issues = collectIssues(`name: cut
steps:
  - id: ${written}
    kind: action
    action: task.create
`);
    expect(listIssuePaths(issues)).toEqual([["steps", "0", "id"]]);
    expect(issues[0]!.message).toContain(`"${"a".repeat(39)}..."`);
  });
});

describe("parsing a source that says more than its text shows", () => {
  it("refuses a %YAML directive by its line, so no key merges under YAML 1.1", () => {
    const issues = collectIssues(`%YAML 1.1
---
name: merged
steps:
  - id: file_task
    kind: action
    action: task.create
    params:
      <<: { title: One }
`);
    expect(listIssuePaths(issues)).toEqual([[]]);
    expect(issues[0]!.message).toContain("line 1, column 1");
    expect(issues[0]!.message).toContain("directive");
  });

  it("refuses a %TAG directive and the tag it names, each at its place", () => {
    const issues = collectIssues(`# A comment before the directive.
%TAG !e! tag:example.com,2026:
---
name: !e!word tagged
${ONE_STEP}`);
    expect(listIssuePaths(issues)).toEqual([[], ["name"]]);
    expect(issues[0]!.message).toContain("line 2, column 1");
  });

  it("refuses !!str, !!binary, !!omap and a custom tag, each at its place, and says to quote the value", () => {
    const issues = collectIssues(`name: tagged
description: !!str 2026-09-23
steps:
  - id: file_task
    kind: action
    action: task.create
    params:
      title: !!binary aGVsbG8=
      labels: !!omap [ { one: 1 } ]
      owner: !custom me
`);
    expect(listIssuePaths(issues)).toEqual([
      ["description"],
      ["steps", "0", "params", "title"],
      ["steps", "0", "params", "labels"],
      ["steps", "0", "params", "owner"],
    ]);
    for (const issue of issues) expect(issue.message).toContain("in quotes");
  });
});

/** A source whose step params are one mapping with this many keys. */
const buildWideSource = (keyCount: number): string => {
  const keys = Array.from({ length: keyCount }, (_, index) => `k${String(index)}: 0`).join(", ");
  return `name: wide
steps:
  - id: file_task
    kind: action
    action: task.create
    params: { ${keys} }
`;
};

/**
 * The shortest time of five parses of a wide source, for each count of keys.
 * The parses of the counts take turns, so a period of other work on the
 * machine slows each count, and the shortest parse is the one that such work
 * slowed least.
 */
const measureWideParses = (keyCounts: ReadonlyArray<number>): ReadonlyArray<number> => {
  const sources = keyCounts.map(buildWideSource);
  const fastest = keyCounts.map(() => Number.POSITIVE_INFINITY);
  for (let round = 0; round < 5; round += 1) {
    for (const [index, source] of sources.entries()) {
      const started = performance.now();
      parseDefinition(source);
      fastest[index] = Math.min(fastest[index]!, performance.now() - started);
    }
  }
  return fastest;
};

/**
 * How many times longer a parse of four times the keys may take. A check that
 * reads each key once takes about four times as long, and a check that
 * compares each key with every earlier key, as the parser's own check of
 * repeated keys does, takes about sixteen times as long. Eight leaves room for
 * the noise of a machine under load and still refuses the second check.
 */
const MAX_GROWTH_FOR_FOUR_TIMES_THE_KEYS = 8;

describe("parsing a source that writes one key twice in a mapping", () => {
  it('refuses the second of two keys the value spells alike, such as 1 and "1"', () => {
    const issues = collectIssues(`name: twice
steps:
  - id: file_task
    kind: action
    action: task.create
    params: { 1: a, "1": b }
`);
    expect(listIssuePaths(issues)).toEqual([["steps", "0", "params", "1"]]);
  });

  it("refuses a field of the definition written twice at the second one", () => {
    expect(listIssuePaths(collectIssues(`name: first\nname: second\n${ONE_STEP}`))).toEqual([
      ["name"],
    ]);
  });

  it("spells an empty key as the value spells it, so the path leads to a place in the text", () => {
    const issues = collectIssues(`name: empty keys
steps:
  - id: file_task
    kind: action
    action: task.create
    params: { ~: a, "": b }
`);
    expect(listIssuePaths(issues)).toEqual([["steps", "0", "params", ""]]);
  });

  it("refuses a key that is a list, at its mapping", () => {
    const issues = collectIssues(`name: list key
steps:
  - id: file_task
    kind: action
    action: task.create
    params:
      ? [a, b]
      : one
`);
    expect(listIssuePaths(issues)).toEqual([["steps", "0", "params"]]);
  });

  it("checks a mapping in a time that grows as its keys do, and not as their square", () => {
    const [fiveThousand, twentyThousand] = measureWideParses([5_000, 20_000]);
    expect(twentyThousand! / fiveThousand!).toBeLessThan(MAX_GROWTH_FOR_FOUR_TIMES_THE_KEYS);

    const [step] = parseDefinition(buildWideSource(20_000)).steps;
    expect(Object.keys(step?.kind === "action" ? (step.params ?? {}) : {})).toHaveLength(20_000);
  });
});

describe("parsing a list with a great many items", () => {
  it("takes a flow list of 130,000 items, about as many as the longest text holds", () => {
    // V8 cannot pass this many values as the arguments of one call, so a walk
    // of the parsed text that did so would throw in a browser.
    const items = Array.from({ length: 130_000 }, () => "0").join(",");
    const definition = parseDefinition(`name: long list
steps:
  - id: file_task
    kind: action
    action: task.create
    params: { items: [${items}] }
`);
    const [step] = definition.steps;
    expect(step?.kind === "action" ? step.params?.["items"] : undefined).toHaveLength(130_000);
  });
});

describe("a refusal with a great many problems", () => {
  it("names the first hundred, and then how many more there are, for a text and an object alike", () => {
    const unknownKeys = Array.from({ length: 150 }, (_, index) => `unknown_${String(index)}`);
    const fromText = collectIssues(
      `name: noisy\n${unknownKeys.map((key) => `${key}: 1`).join("\n")}\n${ONE_STEP}`,
    );
    const fromObject = decodeWorkflowDefinition({
      name: "noisy",
      steps: [],
      ...Object.fromEntries(unknownKeys.map((key) => [key, 1])),
    });
    for (const issues of [fromText, Result.isFailure(fromObject) ? fromObject.failure : []]) {
      expect(listIssuePaths(issues.slice(0, 100))).toEqual(
        unknownKeys.slice(0, 100).map((key) => [key]),
      );
      expect(issues.slice(100)).toEqual([
        { path: [], message: expect.stringContaining("50 more problems") as unknown },
      ]);
    }
  });
});

describe("the name and the description of a workflow", () => {
  const decodeWithFields = (fields: Record<string, string>) =>
    decodeWorkflowDefinition({ name: "plain", steps: [], ...fields });

  it("refuses a name with a line or paragraph separator, or a text direction mark", () => {
    for (const code of [0x2028, 0x2029, 0x061c, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069]) {
      const refused = decodeWithFields({ name: `a${String.fromCodePoint(code)}b` });
      expect(
        Result.isFailure(refused) ? listIssuePaths(refused.failure) : [],
        code.toString(16),
      ).toEqual([["name"]]);
    }
  });

  it("refuses a description with a NUL or another control character, and keeps tabs and line breaks", () => {
    for (const code of [0x00, 0x07, 0x0b, 0x1b, 0x7f, 0x85]) {
      const refused = decodeWithFields({ description: `a${String.fromCodePoint(code)}b` });
      expect(
        Result.isFailure(refused) ? listIssuePaths(refused.failure) : [],
        code.toString(16),
      ).toEqual([["description"]]);
    }
    expect(Result.isSuccess(decodeWithFields({ description: "a\tb\nc\r\nd" }))).toBe(true);
  });
});

describe("parsing a source with several kinds of mistake", () => {
  it("names a repeated id beside a field of the wrong shape", () => {
    const issues = collectIssues(`name: two mistakes
steps:
  - id: file_task
    kind: action
    action: task.create
    terminal: yes
  - id: file_task
    kind: action
    action: task.create
`);
    expect(listIssuePaths(issues)).toEqual([
      ["steps", "0", "terminal"],
      ["steps", "1", "id"],
    ]);
  });

  it("says what to write where a step is not a mapping", () => {
    const issues = collectIssues(`name: bare word\nsteps: [review]\n`);
    expect(listIssuePaths(issues)).toEqual([["steps", "0"]]);
    expect(issues[0]!.message).toContain("Write a mapping of fields here");
    expect(issues[0]!.message).toContain("action or agent");
  });

  it("refuses a name with a control character in it", () => {
    for (const name of ['"a\\tb"', '"a\\u0000b"', '"a\\nb"']) {
      expect(listIssuePaths(collectIssues(`name: ${name}\n${ONE_STEP}`)), name).toEqual([["name"]]);
    }
  });

  it("refuses a text longer than the longest the API stores, before reading it", () => {
    const issues = collectIssues(`name: long\n${ONE_STEP}# ${"x".repeat(256 * 1024)}\n`);
    expect(listIssuePaths(issues)).toEqual([[]]);
  });
});

describe("a definition object and the same definition as text", () => {
  it("give the same issues, at the same paths, with the same messages", () => {
    const definition = {
      name: "one of each",
      enabled: true,
      steps: [
        { id: "open-pr", kind: "script" },
        { id: "open-pr", kind: "agent", prompt: 3 },
      ],
    };
    const fromObject = decodeWorkflowDefinition(definition);
    const fromText = parseWorkflowSource(`name: one of each
enabled: true
steps:
  - id: open-pr
    kind: script
  - id: open-pr
    kind: agent
    prompt: 3
`);
    expect(Result.isFailure(fromObject) ? fromObject.failure : []).toEqual(
      Result.isFailure(fromText) ? fromText.failure : [],
    );
    expect(Result.isFailure(fromText) ? fromText.failure.length : 0).toBeGreaterThan(3);
  });
});

describe("rendering strings that a block cannot hold as they are", () => {
  const noBreakSpace = String.fromCodePoint(0xa0);
  const lineSeparator = String.fromCodePoint(0x2028);

  it("gives back each one exactly, after the parse", () => {
    for (const text of [
      "  indented\nline",
      "\tstart\nnext",
      "a  \n  b",
      "  \n",
      "\n\n",
      " \t\n ",
      "\r\n",
      " \r\n ",
      `${noBreakSpace}\n`,
      `${lineSeparator}\n`,
    ]) {
      const definition = parseDefinition(`name: strings\n${ONE_STEP}`);
      const withText = { ...definition, description: text };
      expect(parseDefinition(renderWorkflowSource(withText)), JSON.stringify(text)).toEqual(
        withText,
      );
    }
  });

  it("writes a string of no-break spaces and line breaks as a block, because YAML reads a no-break space as text", () => {
    const definition = parseDefinition(`name: strings\n${ONE_STEP}`);
    const withText = { ...definition, description: `${noBreakSpace}\n${noBreakSpace}\n` };
    const source = renderWorkflowSource(withText);
    expect(source).toMatch(/^description: \|/m);
    expect(parseDefinition(source)).toEqual(withText);
  });
});

/**
 * A source with two inputs and a signal trigger with two outputs. The first
 * input and the first output are always readable, so each place the parse
 * refuses is the second one.
 */
const buildNamedValuesSource = (
  inputName: string,
  outputName: string,
): string => `name: named values
inputs:
  - name: prUrl
    schema:
      type: string
    required: false
  - name: ${inputName}
    schema:
      type: string
    required: false
triggers:
  - id: on_create
    kind: start
    source:
      kind: task.created
  - id: pr_merged
    kind: signal
    source:
      kind: task.updated
    correlation:
      event: event.payload.taskId
      run: steps.file_task.output.id
    outputs:
      prUrl: event.payload.url
      ${outputName}: event.payload.url
steps:
  - id: file_task
    kind: action
    action: task.create
`;

describe("parsing the names an expression reads", () => {
  it("points an input name that is not a CEL identifier at the name, saying what an expression can read", () => {
    const issues = collectIssues(buildNamedValuesSource("pr-url", "pr_url"));
    expect(listIssuePaths(issues)).toEqual([["inputs", "1", "name"]]);
    expect(issues[0]!.message).toMatch(/expression/i);
  });

  it("points a signal output name that is not a CEL identifier at its key, saying what an expression can read", () => {
    const issues = collectIssues(buildNamedValuesSource("pr_url", "pr-url"));
    expect(listIssuePaths(issues)).toEqual([["triggers", "1", "outputs", "pr-url"]]);
    expect(issues[0]!.message).toMatch(/expression/i);
  });

  it("accepts prUrl and pr_url as input names and as signal output names", () => {
    const definition = parseDefinition(buildNamedValuesSource("pr_url", "pr_url"));
    expect(definition.inputs?.map((input) => input.name)).toEqual(["prUrl", "pr_url"]);
  });
});

/**
 * A source whose step id, input name and signal output name are the words of
 * a case. The trigger's correlation reads the step, so the step is read as
 * `steps.<id>`.
 */
const buildWordsSource = (stepId: string, inputName: string, outputName: string): string =>
  `name: words
inputs:
  - name: "${inputName}"
    schema:
      type: string
    required: false
triggers:
  - id: pr_merged
    kind: signal
    source:
      kind: task.updated
    correlation:
      event: event.payload.taskId
      run: steps.file_task.output.id
    outputs:
      "${outputName}": event.payload.url
steps:
  - id: "${stepId}"
    kind: action
    action: task.create
`;

describe("parsing a word that an expression cannot read as a field name", () => {
  it.each([
    ["CEL reads as an operator", "in", "in", "in"],
    ["CEL reads as a value", "true", "false", "null"],
    ["a run could not read in its values", "constructor", "constructor", "__proto__"],
  ])(
    "refuses an id, an input name and an output name that %s, at each place, naming the word",
    (_why, stepId, inputName, outputName) => {
      const issues = collectIssues(buildWordsSource(stepId, inputName, outputName));
      expect(listIssuePaths(issues)).toEqual([
        ["inputs", "0", "name"],
        ["triggers", "0", "outputs", outputName],
        ["steps", "0", "id"],
      ]);
      expect(issues[0]!.message).toContain(`"${inputName}"`);
      expect(issues[1]!.message).toContain(`"${outputName}"`);
      expect(issues[2]!.message).toContain(`"${stepId}"`);
      for (const issue of issues) expect(issue.message).toMatch(/Write another (id|name)\.$/);
    },
  );

  it("accepts a word that CEL reserves but reads as a field name, such as if and as", () => {
    const definition = parseDefinition(buildWordsSource("if", "as", "while"));
    expect(definition.steps[0]!.id).toBe("if");
    expect(definition.inputs?.[0]!.name).toBe("as");
  });
});
