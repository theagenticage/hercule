/**
 * Tests `parseWorkflowSource` and `renderWorkflowSource`.
 *
 * The controller and the web app both call these two functions, so these
 * tests fix how YAML source is parsed and how a definition object is
 * converted to YAML. The render is tested as a property over generated
 * definitions, because a rule such as "a string with a newline is a block
 * scalar" applies to every string in every field. A handful of examples would
 * only test the fields those examples happen to use.
 *
 * `parseWorkflowSource` returns the definition or the issues. The two helpers
 * below are the only code that reads that result.
 */
import { describe, expect, it } from "vitest";
import { Result } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import { nestInLists } from "@hercule/protocol/testing";
import {
  decodeWorkflowDefinition,
  parseWorkflowSource,
  renderWorkflowSource,
  type Issue,
  type WorkflowDefinition,
} from "../index";

/** Parses a source and returns the definition. Throws with the issues if the parse fails. */
const parseDefinition = (source: string): WorkflowDefinition => {
  const parsed = parseWorkflowSource(source);
  if (Result.isFailure(parsed)) {
    throw new Error(`the source failed to parse: ${JSON.stringify(parsed.failure)}\n${source}`);
  }
  return parsed.success;
};

/** Parses a source and returns its issues, or an empty list if it parses. */
const collectIssues = (source: string): ReadonlyArray<Issue> => {
  const parsed = parseWorkflowSource(source);
  return Result.isFailure(parsed) ? parsed.failure : [];
};

const listIssuePaths = (issues: ReadonlyArray<Issue>): ReadonlyArray<ReadonlyArray<string>> =>
  issues.map((issue) => issue.path);

/** The top-level keys, in the order the definition schema declares them. */
const TOP_LEVEL_KEY_ORDER = [
  "name",
  "description",
  "inputs",
  "triggers",
  "steps",
  "edges",
  "workspace",
];

/** A Connection, Agent or Resource id. The parse only checks its format. */
const ENTITY_ID = "0199e0e7-1111-7000-8000-0000000000ab";

/** Words that YAML parses as plain text, so a line made of them needs no quotes. */
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
 * Text that YAML parses as something else, or fails to parse, unless it is
 * quoted: a boolean, a null, a number, an indicator character at the start, a
 * comment marker, a mapping separator, or a space at either end. Two of them
 * contain one kind of quote, because a YAML writer that can choose would use
 * the other kind of quote for those.
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

/** The ids and names the contract rejects, copied here because the contract does not export them. */
const UNREADABLE_FIELD_NAMES = new Set(["in", "true", "false", "null", "constructor", "__proto__"]);

/**
 * A step id, trigger id or input name: a CEL identifier, because expressions
 * refer to it, and not one of the words an expression cannot use as a field
 * name.
 */
const identifierArbitrary = FastCheck.stringMatching(/^[a-z][a-z0-9_]{0,11}$/).filter(
  (word) => !UNREADABLE_FIELD_NAMES.has(word),
);

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
 * Two to five lines. The first and last lines have words; a line in between
 * has words, nothing, or only whitespace. The text sometimes ends with one or
 * two newlines.
 *
 * No line starts with whitespace here, because the property below treats the
 * leading whitespace of every line as indentation. Separate tests after the
 * property cover such lines.
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
 * Only whitespace and line breaks. A block scalar cannot hold such text, so it
 * is written in double quotes. It is generated only for fields where the
 * property does not check the YAML style of a string.
 */
const blankLinesArbitrary = FastCheck.array(lineEndArbitrary, { minLength: 2, maxLength: 4 }).map(
  (lines) => lines.join("\n"),
);

/** Any text, including text of only whitespace and line breaks. */
const anyTextOrBlankLinesArbitrary = FastCheck.oneof(anyTextArbitrary, blankLinesArbitrary);

const expressionArbitrary = FastCheck.constantFrom(...CEL_EXPRESSIONS);

/*
 * The contract sets the order of its own keys. The keys of a map whose keys
 * the author chooses (params, options, schemas, input mappings, outputs) keep
 * the order in which they were sent. `params` has two keys here, in either
 * order, so the property checks that the render keeps that order. The other
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
    kind: FastCheck.constantFrom("task.created", "github.pr.labeled"),
    connectionId: FastCheck.constantFrom("any", ENTITY_ID),
    filter: expressionArbitrary,
  },
  { requiredKeys: ["kind"] },
);

const scheduleArbitrary = FastCheck.record(
  {
    schedule: FastCheck.constant("0 9 * * 1-5"),
    timezone: FastCheck.constant("Europe/Amsterdam"),
  },
  { requiredKeys: ["schedule"] },
);

const buildStartTriggerArbitrary = (id: string) =>
  FastCheck.record(
    {
      id: FastCheck.constant(id),
      kind: FastCheck.constant("start"),
      on: FastCheck.oneof(eventSelectorArbitrary, scheduleArbitrary),
      inputs: FastCheck.constant({ pr_number: "event.payload.number" }),
      spawnBound: FastCheck.record({
        maxRuns: FastCheck.integer({ min: 1, max: 100 }),
        windowSeconds: FastCheck.integer({ min: 1, max: 86_400 }),
      }),
    },
    { requiredKeys: ["id", "kind", "on"] },
  );

const buildSignalTriggerArbitrary = (id: string) =>
  FastCheck.record(
    {
      id: FastCheck.constant(id),
      kind: FastCheck.constant("signal"),
      on: eventSelectorArbitrary,
      correlation: FastCheck.record({
        event: FastCheck.constant("event.payload.number"),
        run: FastCheck.constant("steps.review.output.number"),
      }),
      outputs: FastCheck.constant({ merged: "event.payload.merged" }),
    },
    { requiredKeys: ["id", "kind", "on", "correlation"] },
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
 * A definition the parse accepts: every id is a CEL identifier, and no id is
 * used twice across triggers and steps. Whether its agents, actions and event
 * kinds exist is checked by the controller, not the parse, so they are fixed
 * values here.
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
 * The fields whose value is a map with keys the author chooses. The render
 * keeps the author's order of those keys, so `reverseKeys` leaves such a map
 * unchanged.
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
 * Returns a copy of the value with the contract's keys of every object in
 * reverse order. A map with keys the author chooses is left unchanged. The
 * top-level `inputs` is a list, so the keys of each declaration in it are
 * reversed too.
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

/** Returns the keys of each step's `params`, in their order in the value. */
const listParamsKeys = (definition: unknown): ReadonlyArray<ReadonlyArray<string>> =>
  (definition as { steps: ReadonlyArray<{ params?: object }> }).steps.flatMap((step) =>
    step.params === undefined ? [] : [Object.keys(step.params)],
  );

/** Returns the keys written at the left margin, in the order they appear in the text. */
const readTopLevelKeys = (text: string): ReadonlyArray<string> =>
  text.split("\n").flatMap((line) => {
    const key = /^([A-Za-z]+):/.exec(line)?.[1];
    return key === undefined ? [] : [key];
  });

const countMatches = (text: string, pattern: RegExp): number => (text.match(pattern) ?? []).length;

/** A block scalar header: `|`, with an optional chomping and indentation indicator. */
const BLOCK_SCALAR_HEADER = /\|[-+0-9]*$/;

/** Returns the prompts of a definition's agent steps, in step order. */
const collectPrompts = (definition: Record<string, unknown>): ReadonlyArray<string> =>
  (definition["steps"] as ReadonlyArray<Record<string, unknown>>).flatMap((step) =>
    step["kind"] === "agent" ? [step["prompt"] as string] : [],
  );

describe("rendering a definition as canonical YAML", () => {
  it("is deterministic, uses contract key order, block and double-quoted scalars and two-space indent, and parses back to the same definition", () => {
    FastCheck.assert(
      FastCheck.property(definitionArbitrary, (generated) => {
        const definition = generated as unknown as WorkflowDefinition;
        const definitionFields = generated as Record<string, unknown>;
        const source = renderWorkflowSource(definition);

        // The same object, or a copy of it, renders to the same bytes.
        expect(renderWorkflowSource(definition)).toBe(source);
        expect(renderWorkflowSource(structuredClone(definition))).toBe(source);

        // The order of the contract's keys in the input does not matter.
        expect(renderWorkflowSource(reverseKeys(generated) as WorkflowDefinition)).toBe(source);
        expect(readTopLevelKeys(source)).toEqual(
          TOP_LEVEL_KEY_ORDER.filter((key) => key in definitionFields),
        );
        // The keys the author chooses keep the order in which they were sent.
        expect(listParamsKeys(parseDefinition(source))).toEqual(listParamsKeys(generated));

        // A string with a newline is a block scalar, a string that needs
        // quotes gets double quotes, and a plain string is written unquoted.
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

        // Each level of nesting is indented two spaces more than its parent.
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

describe("parsing an invalid source", () => {
  it("reports a YAML syntax error once, with an empty path, giving its line and column", () => {
    // The extra word after the closing quote on line 9 starts at column 20.
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

  it("counts the column of a YAML syntax error in characters, so an emoji is one column", () => {
    // The extra x after the closing quote is the 12th character of line 1,
    // and the 14th UTF-16 code unit.
    const issues = collectIssues('name: "😀😀" x: y\nsteps: []\n');
    expect(issues.map((issue) => issue.message)).toContainEqual(
      expect.stringContaining("line 1, column 12."),
    );
  });

  it("reports a field with the wrong type at that field's path", () => {
    const issues = collectIssues(`name: wrong kind
steps:
  - id: file_task
    kind: script
    action: task.create
`);
    expect(listIssuePaths(issues)).toEqual([["steps", "0", "kind"]]);
  });

  it("gives the kind of value that a key with no value takes", () => {
    const issues = collectIssues(`name:
steps:
  - id: file_task
    kind: action
    action:
    join:
    entry: ~
edges:
  - from: file_task
    to: file_task
    maxTraversals:
`);
    expect(issues).toEqual([
      { path: ["name"], message: "name has no value. It takes text." },
      { path: ["steps", "0", "action"], message: "action has no value. It takes text." },
      { path: ["steps", "0", "join"], message: "join has no value. It takes any or all." },
      {
        path: ["steps", "0", "entry"],
        message: "entry has no value. It takes true or false.",
      },
      {
        path: ["edges", "0", "maxTraversals"],
        message: "maxTraversals has no value. It takes a number.",
      },
    ]);
  });

  it("asks whether an input is required when its declaration leaves required out", () => {
    const issues = collectIssues(`name: input with a default
inputs:
  - name: title
    schema: { type: string }
    default: Fix login
steps:
  - id: file_task
    kind: action
    action: task.create
`);
    expect(issues).toEqual([
      {
        path: ["inputs", "0", "required"],
        message: "Say whether this input is required: add required: true or required: false.",
      },
    ]);
  });

  it("reports an agent that is not an id at its path, with a message on how to find Agent ids", () => {
    const issues = collectIssues(`name: agent by name
steps:
  - id: file_task
    kind: action
    action: task.create
  - id: review
    kind: agent
    agent: nobody
    prompt: Review the pull request.
`);
    expect(issues).toEqual([
      {
        path: ["steps", "1", "agent"],
        message:
          '"nobody" is not an Agent id. Write the id of an Agent. ' +
          "Run hercule agent list to see the id of each Agent.",
      },
    ]);
  });

  it("reports two steps that share an id at the second one", () => {
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

  it("reports a signal trigger that repeats a start trigger's id at the signal trigger", () => {
    const issues = collectIssues(`name: three triggers, two ids
triggers:
  - id: nightly
    kind: start
    on:
      schedule: "0 2 * * *"
  - id: on_create
    kind: start
    on:
      kind: task.created
  - id: nightly
    kind: signal
    on:
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

  it("reports a step that repeats a trigger's id at the step, even when the source lists steps first", () => {
    // Triggers count as earlier than steps, whatever order the source lists
    // them in, so the step is the second one with the id.
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
    on:
      schedule: "0 2 * * *"
`);
    expect(listIssuePaths(issues)).toEqual([["steps", "1", "id"]]);
  });

  it("reports a step id that is not snake_case at its path and suggests the snake_case spelling", () => {
    const issues = collectIssues(`name: kebab step
steps:
  - id: open-pr
    kind: action
    action: task.create
`);
    expect(listIssuePaths(issues)).toEqual([["steps", "0", "id"]]);
    expect(issues[0]!.message).toContain("open_pr");
  });

  it("reports a trigger id that is not snake_case at its path and suggests the snake_case spelling", () => {
    const issues = collectIssues(`name: kebab trigger
triggers:
  - id: checks-failed
    kind: start
    on:
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

/** One action step: the smallest valid `steps` list, for tests that add a mistake elsewhere. */
const ONE_STEP = `steps:
  - id: file_task
    kind: action
    action: task.create
`;

/** A source with one trigger, whose lines are `trigger`, and one action step. */
const buildTriggerSource = (trigger: string): string =>
  `name: one trigger\ntriggers:\n  - id: t\n${trigger}${ONE_STEP}`;

/** The sentence that ends each error about a start trigger's `on` that fits neither shape. */
const TRIGGER_ON_CHOICES =
  "Write kind, with connectionId and filter if needed, to accept events of that kind, " +
  "or write schedule, with timezone if needed, to fire on a schedule.";

describe("parsing what a trigger fires on", () => {
  it("accepts a start trigger on events and a start trigger on a schedule", () => {
    const definition = parseDefinition(`name: two triggers
triggers:
  - id: labeled
    kind: start
    on:
      kind: github.pr.labeled
      connectionId: any
      filter: event.payload.label == "ready"
  - id: weekdays
    kind: start
    on:
      schedule: "0 9 * * 1-5"
      timezone: Europe/Amsterdam
${ONE_STEP}`);
    expect(definition.triggers?.map((trigger) => trigger.on)).toEqual([
      { kind: "github.pr.labeled", connectionId: "any", filter: 'event.payload.label == "ready"' },
      { schedule: "0 9 * * 1-5", timezone: "Europe/Amsterdam" },
    ]);
  });

  it("refuses the shape before on, and says where each of its keys goes now", () => {
    const issues = collectIssues(
      buildTriggerSource(`    kind: start
    source:
      kind: task.created
    schedule: "0 2 * * *"
    timezone: Europe/Amsterdam
`),
    );
    // The error that on is missing is left out: renaming source fixes it.
    expect(issues).toEqual([
      {
        path: ["triggers", "0", "source"],
        message: "source is now called on. Rename source to on.",
      },
      {
        path: ["triggers", "0", "schedule"],
        message: "A schedule goes under on, in place of an event kind. Move schedule under on.",
      },
      {
        path: ["triggers", "0", "timezone"],
        message: "A timezone goes under on, beside the schedule. Move timezone under on.",
      },
    ]);
  });

  it("reports one error at on when it names both an event kind and a schedule", () => {
    const issues = collectIssues(
      buildTriggerSource(`    kind: start
    on:
      kind: task.created
      schedule: "0 2 * * *"
`),
    );
    expect(issues).toEqual([
      {
        path: ["triggers", "0", "on"],
        message: `on accepts events or fires on a schedule, not both. ${TRIGGER_ON_CHOICES}`,
      },
    ]);
  });

  it("reports one error at on when it is empty or has no value", () => {
    expect(collectIssues(buildTriggerSource("    kind: start\n    on: {}\n"))).toEqual([
      { path: ["triggers", "0", "on"], message: `on is empty. ${TRIGGER_ON_CHOICES}` },
    ]);
    expect(collectIssues(buildTriggerSource("    kind: start\n    on:\n"))).toEqual([
      { path: ["triggers", "0", "on"], message: `on has no value. ${TRIGGER_ON_CHOICES}` },
    ]);
  });

  it("reports only the schedule's error when a schedule has a filter, not that kind is missing", () => {
    const issues = collectIssues(
      buildTriggerSource(`    kind: start
    on:
      schedule: "0 2 * * *"
      filter: event.payload.urgent
`),
    );
    expect(issues).toEqual([
      {
        path: ["triggers", "0", "on", "filter"],
        message:
          "A schedule has no filter, because the schedule already sets when the trigger fires. Remove filter.",
      },
    ]);
  });

  it("refuses a timezone beside an event kind", () => {
    const issues = collectIssues(
      buildTriggerSource(`    kind: start
    on:
      kind: task.created
      timezone: Europe/Amsterdam
`),
    );
    expect(issues).toEqual([
      {
        path: ["triggers", "0", "on", "timezone"],
        message: "Only a schedule has a timezone. Remove timezone.",
      },
    ]);
  });

  it("reports only the event selector's error when an event trigger has a bad Connection id", () => {
    const issues = collectIssues(
      buildTriggerSource(`    kind: start
    on:
      kind: task.created
      connectionId: nope
`),
    );
    expect(listIssuePaths(issues)).toEqual([["triggers", "0", "on", "connectionId"]]);
  });

  it("refuses a schedule on a signal trigger, which accepts only events", () => {
    const issues = collectIssues(
      buildTriggerSource(`    kind: signal
    on:
      schedule: "0 2 * * *"
    correlation:
      event: event.payload.id
      run: steps.file_task.output.id
`),
    );
    expect(issues).toEqual([
      {
        path: ["triggers", "0", "on", "schedule"],
        message:
          "A signal trigger resumes a run when an event arrives, so it cannot fire on a schedule. " +
          "Write kind in place of schedule, with connectionId and filter if needed.",
      },
    ]);
  });

  it("tells a signal trigger whose on has both kind and schedule to remove the schedule", () => {
    const issues = collectIssues(
      buildTriggerSource(`    kind: signal
    on:
      kind: task.created
      schedule: "0 2 * * *"
    correlation:
      event: event.payload.id
      run: steps.file_task.output.id
`),
    );
    expect(issues).toEqual([
      {
        path: ["triggers", "0", "on", "schedule"],
        message:
          "A signal trigger resumes a run when an event arrives, so it cannot fire on a schedule. " +
          "Remove schedule.",
      },
    ]);
  });

  it("reports one error at on when it has neither kind nor schedule, naming the keys written", () => {
    const issues = collectIssues(
      buildTriggerSource(`    kind: start
    on:
      schedul: "0 2 * * *"
`),
    );
    expect(issues).toEqual([
      {
        path: ["triggers", "0", "on"],
        message: `on has neither kind nor schedule, only "schedul". ${TRIGGER_ON_CHOICES}`,
      },
    ]);
  });

  it("reads a timezone alone as a schedule and a filter alone as an event selector", () => {
    expect(
      collectIssues(buildTriggerSource("    kind: start\n    on:\n      timezone: UTC\n")),
    ).toEqual([
      { path: ["triggers", "0", "on", "schedule"], message: "Add schedule. It is required here." },
    ]);
    expect(
      collectIssues(buildTriggerSource('    kind: start\n    on:\n      filter: "true"\n')),
    ).toEqual([
      { path: ["triggers", "0", "on", "kind"], message: "Add kind. It is required here." },
    ]);
  });

  it("tells a trigger that writes both source and on to remove source, and still checks on", () => {
    const issues = collectIssues(
      buildTriggerSource(`    kind: start
    source:
      kind: task.created
    on:
      kind: task.created
      timezone: UTC
`),
    );
    expect(issues).toEqual([
      {
        path: ["triggers", "0", "on", "timezone"],
        message: "Only a schedule has a timezone. Remove timezone.",
      },
      {
        path: ["triggers", "0", "source"],
        message: "on is already written, and source is its old name. Remove source.",
      },
    ]);
  });

  it("tells a trigger to remove an old top-level schedule or timezone that on cannot take", () => {
    const signal = collectIssues(
      buildTriggerSource(`    kind: signal
    on:
      kind: task.created
    schedule: "0 2 * * *"
    correlation:
      event: event.payload.id
      run: steps.file_task.output.id
`),
    );
    expect(signal).toEqual([
      {
        path: ["triggers", "0", "schedule"],
        message:
          "A signal trigger resumes a run when an event arrives, so it cannot fire on a schedule. " +
          "Remove schedule.",
      },
    ]);
    const event = collectIssues(
      buildTriggerSource(`    kind: start
    on:
      kind: task.created
    timezone: UTC
`),
    );
    expect(event).toEqual([
      {
        path: ["triggers", "0", "timezone"],
        message: "Only a schedule has a timezone. Remove timezone.",
      },
    ]);
  });
});

describe("parsing a source with YAML anchors and aliases", () => {
  it("rejects an alias to an anchor that does not exist at the alias, without throwing", () => {
    const issues = collectIssues(`name: dangling alias\nsteps: *nowhere\n`);
    expect(listIssuePaths(issues)).toEqual([["steps"]]);
    expect(issues[0]!.message).toMatch(/anchors or aliases/);
  });

  it("rejects an alias bomb at each anchor, without expanding it", () => {
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

  it("rejects a plain anchor at its path", () => {
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

  it("parses << as an ordinary key, as YAML 1.2 does, and merges nothing", () => {
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
  it("rejects a lone surrogate in the text, giving its line and column", () => {
    const issues = collectIssues(`name: broken\ndescription: a\uD800b\n${ONE_STEP}`);
    expect(listIssuePaths(issues)).toEqual([[]]);
    expect(issues[0]!.message).toContain("line 2, column 15");
  });

  it("rejects a lone surrogate written as an escape, at its field", () => {
    const issues = collectIssues(`name: escaped\ndescription: "a\\uD800b"\n${ONE_STEP}`);
    expect(listIssuePaths(issues)).toEqual([["description"]]);
  });

  it("rejects a definition object whose rendered YAML would contain one", () => {
    const definition = parseDefinition(`name: good\n${ONE_STEP}`);
    const issues = collectIssues(renderWorkflowSource({ ...definition, description: "a\uDC00b" }));
    expect(listIssuePaths(issues)).toEqual([["description"]]);
  });
});

describe("parsing a source with a JSON value nested too deep", () => {
  it("accepts 32 levels of mappings and lists in a field, and rejects 33 at that field", () => {
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

  it("rejects a value thousands of levels deep without a stack overflow", () => {
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

describe("how much of the source an error message repeats", () => {
  const longWord = "Open-PR-".repeat(2_000);

  it("quotes only a short part of a long value", () => {
    const issues = collectIssues(`name: long
triggers:
  - id: ${longWord}
    kind: start
    on:
      kind: task.created
      connectionId: ${longWord}
  - id: ${longWord}
    kind: start
    on:
      kind: task.created
steps:
  - id: file_task
    kind: ${longWord}
`);
    expect(listIssuePaths(issues)).toEqual([
      ["triggers", "0", "id"],
      ["triggers", "0", "on", "connectionId"],
      ["triggers", "1", "id"],
      ["steps", "0", "kind"],
      ["triggers", "1", "id"],
    ]);
    for (const issue of issues) expect(issue.message.length, issue.message).toBeLessThan(400);
  });

  it("truncates the source text that a YAML parser error repeats", () => {
    const issues = collectIssues(`name: long\ndescription: |${longWord}\n${ONE_STEP}`);
    expect(listIssuePaths(issues)).toEqual([[]]);
    expect(issues[0]!.message.length).toBeLessThan(400);
    // No full stop is added after the "..." of the cut.
    expect(issues[0]!.message).toContain("...");
    expect(issues[0]!.message).not.toContain("....");
  });

  it("never truncates a quoted value between the two halves of a surrogate pair", () => {
    // The 40th character, the last one a quote keeps, is the first half of a surrogate pair.
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

describe("parsing a source with directives and tags", () => {
  it("rejects a %YAML directive, giving its line, so no key is merged as in YAML 1.1", () => {
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

  it("rejects a %TAG directive and the tag it defines, each at its own path", () => {
    const issues = collectIssues(`# A comment before the directive.
%TAG !e! tag:example.com,2026:
---
name: !e!word tagged
${ONE_STEP}`);
    expect(listIssuePaths(issues)).toEqual([[], ["name"]]);
    expect(issues[0]!.message).toContain("line 2, column 1");
  });

  it("rejects !!str, !!binary, !!omap and a custom tag, each at its own path, with a message to quote the value", () => {
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

/** Builds a source whose step params are one mapping with `keyCount` keys. */
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

/** Returns the CPU time this process has used so far, user and system together, in milliseconds. */
const readCpuMilliseconds = (): number => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

/**
 * Returns, for each key count, the least CPU time of five parses of a wide
 * source, in milliseconds.
 *
 * CPU time, not wall-clock time, because a busy machine pauses this process to
 * run others, and a pause lengthens the wall-clock time of a long parse far
 * more than that of a short one. A paused process uses no CPU time, so the
 * ratio between the two parses stays the same however busy the machine is.
 * The parses for the different counts take turns, and the least of five is
 * kept, so a garbage collection that lands in one parse does not count either.
 */
const measureWideParses = (keyCounts: ReadonlyArray<number>): ReadonlyArray<number> => {
  const sources = keyCounts.map(buildWideSource);
  const least = keyCounts.map(() => Number.POSITIVE_INFINITY);
  for (let round = 0; round < 5; round += 1) {
    for (const [index, source] of sources.entries()) {
      const started = readCpuMilliseconds();
      parseDefinition(source);
      least[index] = Math.min(least[index]!, readCpuMilliseconds() - started);
    }
  }
  return least;
};

/**
 * How many times more CPU time a parse of sixteen times as many keys may take.
 *
 * - A linear check takes about sixteen times as long. Measured on Bun and on
 *   Node, with the fixed cost of a parse and garbage collection included, it
 *   is 13 to 24 times.
 * - A check that compares each key with every earlier key, as the YAML
 *   parser's own duplicate-key check does, takes about 256 times as long.
 *   Measured, it is 100 to 160 times.
 *
 * Fifty is more than twice the highest linear ratio measured and half the
 * lowest quadratic one. The larger source is close to the longest a workflow
 * may be, so the gap cannot be widened by adding keys.
 */
const MAX_GROWTH_FOR_SIXTEEN_TIMES_THE_KEYS = 50;

describe("parsing a source with a duplicate key in a mapping", () => {
  it('rejects the second of two keys that are equal as strings, such as 1 and "1"', () => {
    const issues = collectIssues(`name: twice
steps:
  - id: file_task
    kind: action
    action: task.create
    params: { 1: a, "1": b }
`);
    expect(listIssuePaths(issues)).toEqual([["steps", "0", "params", "1"]]);
  });

  it("rejects a definition field written twice at the second one", () => {
    expect(listIssuePaths(collectIssues(`name: first\nname: second\n${ONE_STEP}`))).toEqual([
      ["name"],
    ]);
  });

  it("writes an empty key in the path as the parsed value has it, so the path points into the text", () => {
    const issues = collectIssues(`name: empty keys
steps:
  - id: file_task
    kind: action
    action: task.create
    params: { ~: a, "": b }
`);
    expect(listIssuePaths(issues)).toEqual([["steps", "0", "params", ""]]);
  });

  it("rejects a key that is a list, at its mapping", () => {
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

  it("checks a mapping in time linear in its key count, not quadratic", () => {
    const [narrow, wide] = measureWideParses([1_250, 20_000]);
    expect(wide! / narrow!).toBeLessThan(MAX_GROWTH_FOR_SIXTEEN_TIMES_THE_KEYS);

    const [step] = parseDefinition(buildWideSource(20_000)).steps;
    expect(Object.keys(step?.kind === "action" ? (step.params ?? {}) : {})).toHaveLength(20_000);
  });
});

describe("parsing a very long list", () => {
  it("accepts a flow list of 130,000 items, about as many as the longest allowed source holds", () => {
    // V8 cannot pass this many arguments to one function call, so code that
    // spread the parsed list into a call would throw in a browser.
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

describe("an error response with many problems", () => {
  it("lists the first hundred, then how many more there are, for YAML source and a definition object alike", () => {
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

describe("a workflow's name and description", () => {
  const decodeWithFields = (fields: Record<string, string>) =>
    decodeWorkflowDefinition({ name: "plain", steps: [], ...fields });

  it("rejects a name with a line or paragraph separator, or a text direction mark", () => {
    for (const code of [0x2028, 0x2029, 0x061c, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069]) {
      const refused = decodeWithFields({ name: `a${String.fromCodePoint(code)}b` });
      expect(
        Result.isFailure(refused) ? listIssuePaths(refused.failure) : [],
        code.toString(16),
      ).toEqual([["name"]]);
    }
  });

  it("rejects a description with a NUL or another control character, and accepts tabs and line breaks", () => {
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

describe("parsing a source with several kinds of error", () => {
  it("reports a repeated id and a field with the wrong type together", () => {
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

  it("explains what to write when a step is not a mapping", () => {
    const issues = collectIssues(`name: bare word\nsteps: [review]\n`);
    expect(listIssuePaths(issues)).toEqual([["steps", "0"]]);
    expect(issues[0]!.message).toContain("Write a mapping of fields here");
    expect(issues[0]!.message).toContain("action or agent");
  });

  it("rejects a name with a control character in it", () => {
    for (const name of ['"a\\tb"', '"a\\u0000b"', '"a\\nb"']) {
      expect(listIssuePaths(collectIssues(`name: ${name}\n${ONE_STEP}`)), name).toEqual([["name"]]);
    }
  });

  it("rejects a source longer than the API stores, before parsing it", () => {
    const issues = collectIssues(`name: long\n${ONE_STEP}# ${"x".repeat(256 * 1024)}\n`);
    expect(listIssuePaths(issues)).toEqual([[]]);
  });
});

describe("a definition object and the same definition as YAML", () => {
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

describe("rendering strings that a block scalar cannot hold exactly", () => {
  const noBreakSpace = String.fromCodePoint(0xa0);
  const lineSeparator = String.fromCodePoint(0x2028);

  it("parses each one back exactly", () => {
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

  it("writes a string of no-break spaces and line breaks as a block, because YAML treats a no-break space as text", () => {
    const definition = parseDefinition(`name: strings\n${ONE_STEP}`);
    const withText = { ...definition, description: `${noBreakSpace}\n${noBreakSpace}\n` };
    const source = renderWorkflowSource(withText);
    expect(source).toMatch(/^description: \|/m);
    expect(parseDefinition(source)).toEqual(withText);
  });
});

/**
 * Builds a source with two inputs and a signal trigger with two outputs. The
 * first input and the first output always have valid names, so any error is
 * at the second one.
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
    on:
      kind: task.created
  - id: pr_merged
    kind: signal
    on:
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

describe("parsing input and output names", () => {
  it("reports an input name that is not a CEL identifier at the name, and explains why", () => {
    const issues = collectIssues(buildNamedValuesSource("pr-url", "pr_url"));
    expect(listIssuePaths(issues)).toEqual([["inputs", "1", "name"]]);
    expect(issues[0]!.message).toMatch(/expression/i);
  });

  it("reports a signal output name that is not a CEL identifier at its key, and explains why", () => {
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
 * Builds a source with the given step id, input name and signal output name.
 * The trigger's correlation refers to the step, so the step id is used as
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
    on:
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

describe("parsing a word that an expression cannot use as a field name", () => {
  it.each([
    ["CEL parses as an operator", "in", "in", "in"],
    ["CEL parses as a literal value", "true", "false", "null"],
    ["a run could not read", "constructor", "constructor", "__proto__"],
  ])(
    "rejects an id, an input name and an output name that %s, at each path, quoting the word",
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
      for (const issue of issues) expect(issue.message).toMatch(/Choose another (id|name)\.$/);
    },
  );

  it("accepts a word that CEL reserves but allows as a field name, such as if and as", () => {
    const definition = parseDefinition(buildWordsSource("if", "as", "while"));
    expect(definition.steps[0]!.id).toBe("if");
    expect(definition.inputs?.[0]!.name).toBe("as");
  });
});
