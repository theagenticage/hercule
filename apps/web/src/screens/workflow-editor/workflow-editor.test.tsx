/**
 * The workflow editor on its own: the text pane with its completion and its
 * diagnostics, and the graph pane beside it.
 *
 * The tests use the editor as a user does. They focus the text, move the
 * cursor, ask for completions, pick one and type. The graph tests read only
 * the text in the graph region. The tests rely on these facts of CodeMirror
 * and of user-event, because the editor shows its state only through them:
 * - CodeMirror shows each completion as an option, with its label in a
 *   `.cm-completionLabel` element. The option's name also holds the detail.
 * - CodeMirror underlines a diagnostic with `.cm-lintRange-<severity>`
 *   elements, cut at each line break and each coloured word. It marks a
 *   diagnostic with no width with a `.cm-lintPoint-<severity>` element.
 * - CodeMirror puts each line of the text in a `.cm-line` element.
 * - CodeMirror reads the key codes of Escape and Tab to decide if Tab moves
 *   focus out of the editor, and user-event sends no key code. The keyboard
 *   tests add the key code that a browser sends.
 *
 * The parent owns the source and the controller's answer about it, as the
 * workflow screen does. The diagnostics tests give the editor each new source
 * and each answer as the screen does. When the controller validates a
 * source, and which answer the screen hands on, is the screen's to decide,
 * and the screen's tests check it.
 */
import { createRef, useState, type ComponentProps, type Ref } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { findUniqueOffset } from "@hercule/client-core/workflow-source/testing";
import type { Issue } from "@hercule/contract";
import { WorkflowEditor, type WorkflowEditorHandle } from ".";

type EditorProps = ComponentProps<typeof WorkflowEditor>;
type Validation = EditorProps["validation"];
type ReportIssues = EditorProps["onIssuesChange"];
type ReportValidationState = EditorProps["onValidationStateChange"];

const REVIEWER_ID = "0199e0e7-1111-7000-8000-0000000000ab";
const FIXER_ID = "0199e0e7-1111-7000-8000-0000000000ac";

/** What the controller's two catalogs and the agent list answer, as the screen passes them on. */
const CATALOG: EditorProps["catalog"] = {
  actions: [
    { id: "task.create", displayName: "Create a task", description: "Creates a task." },
    { id: "task.update", displayName: "Update a task", description: "Changes a task." },
    { id: "task.query", displayName: "Find tasks", description: "Lists the tasks that match." },
    {
      id: "notes/note.append",
      displayName: "Append a note",
      description: "Appends one line of text to the notes of the run.",
    },
  ],
  agents: [
    { id: REVIEWER_ID, name: "Reviewer" },
    { id: FIXER_ID, name: "Fixer" },
  ],
  eventKinds: [
    { kind: "cron.tick", description: "A schedule came due.", connectionRequired: false },
    { kind: "task.created", description: "A task was created.", connectionRequired: false },
    {
      kind: "github.pr.labeled",
      description: "A label was added to a pull request.",
      connectionRequired: true,
    },
  ],
};

/**
 * A valid workflow whose step `review` names the given action, as the source
 * reads while the author types that action. One line for each item, so line N
 * is item N - 1.
 */
const buildReviewWorkflowSource = (action: string): string =>
  [
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
    "  - id: review",
    "    kind: action",
    `    action: ${action}`,
    "edges:",
    "  - from: open_task",
    "    to: review",
    "",
  ].join("\n");

/** A loop that starts at `implement`, with one capped edge back into it. */
const LOOP_SOURCE = [
  "name: Implement a task",
  "triggers:",
  "  - id: assigned",
  "    kind: start",
  "    source:",
  "      kind: task.updated",
  "  - id: checks_failed",
  "    kind: signal",
  "    source:",
  "      kind: github.checks.failed",
  "      connectionId: any",
  "    correlation:",
  "      event: event.payload.prNumber",
  "      run: steps.open_pr.output.prNumber",
  "  - id: pr_merged",
  "    kind: signal",
  "    source:",
  "      kind: github.pr.merged",
  "      connectionId: any",
  "    correlation:",
  "      event: event.payload.prNumber",
  "      run: steps.open_pr.output.prNumber",
  "steps:",
  "  - id: implement",
  "    kind: agent",
  `    agent: ${FIXER_ID}`,
  "    prompt: Implement the task.",
  "    entry: true",
  "  - id: open_pr",
  "    kind: action",
  "    action: task.update",
  "  - id: review",
  "    kind: agent",
  `    agent: ${REVIEWER_ID}`,
  "    prompt: Review the pull request.",
  "  - id: task_done",
  "    kind: action",
  "    action: task.update",
  "    terminal: true",
  "edges:",
  "  - from: implement",
  "    to: open_pr",
  "  - from: open_pr",
  "    to: review",
  "  - from: review",
  "    to: implement",
  "    condition: steps.review.output.approved == false",
  "    maxTraversals: 3",
  "  - from: checks_failed",
  "    to: implement",
  "  - from: pr_merged",
  "    to: task_done",
  "",
].join("\n");

/** The id of each step and each trigger of `LOOP_SOURCE`. */
const LOOP_NODE_IDS = [
  "assigned",
  "checks_failed",
  "pr_merged",
  "implement",
  "open_pr",
  "review",
  "task_done",
];

/** `LOOP_SOURCE` with a mapping inside a compact mapping on line 28, which YAML does not allow. */
const BROKEN_LOOP_SOURCE = LOOP_SOURCE.replace("    entry: true\n", "    entry: true: yes\n");

/** A workflow of two steps in a line, and a trigger that starts it. */
const LINEAR_SOURCE = [
  "name: Review labelled pull requests",
  "triggers:",
  "  - id: labelled",
  "    kind: start",
  "    source:",
  "      kind: github.pr.labeled",
  "      connectionId: any",
  "steps:",
  "  - id: open_task",
  "    kind: action",
  "    action: task.create",
  "  - id: review",
  "    kind: agent",
  `    agent: ${REVIEWER_ID}`,
  "    prompt: Review the pull request.",
  "edges:",
  "  - from: open_task",
  "    to: review",
  "",
].join("\n");

/**
 * `LINEAR_SOURCE` without its edge. Each step is then an entry step, so the
 * trigger leads into both steps, and the graph is a branch, not a row.
 */
const BRANCHED_SOURCE = LINEAR_SOURCE.replace("edges:\n  - from: open_task\n    to: review\n", "");

/**
 * Where the graph library shows the drawing in the pane: the offset and the
 * zoom of its viewport, as its style gives them.
 */
const readDrawingPlace = (): string =>
  document.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? "";

/** An answer of the controller about `source` that names `issues`. */
const buildAnswer = (
  source: string,
  issues: { readonly errors?: ReadonlyArray<Issue>; readonly warnings?: ReadonlyArray<Issue> },
): Validation => ({
  source,
  issues: { errors: issues.errors ?? [], warnings: issues.warnings ?? [] },
});

/**
 * Mounts the editor as a parent that owns the source and the controller's
 * answer does. `update` gives the editor a new source, a new answer, or both,
 * as the parent does after a keystroke or when an answer arrives.
 */
const renderEditor = (options: {
  readonly source: string;
  readonly validation?: Validation;
  readonly onIssuesChange: ReportIssues;
  readonly onValidationStateChange?: ReportValidationState;
  readonly view: EditorProps["view"];
}) => {
  const shown = { source: options.source, validation: options.validation };
  const buildEditorElement = () => (
    <WorkflowEditor
      source={shown.source}
      onSourceChange={() => {}}
      view={options.view}
      catalog={CATALOG}
      validation={shown.validation}
      onIssuesChange={options.onIssuesChange}
      onValidationStateChange={options.onValidationStateChange ?? (() => {})}
      onNameChange={() => {}}
    />
  );
  const { rerender } = render(buildEditorElement());
  return {
    update: (change: { readonly source?: string; readonly validation?: Validation }) => {
      if (change.source !== undefined) shown.source = change.source;
      if ("validation" in change) shown.validation = change.validation;
      rerender(buildEditorElement());
    },
  };
};

/**
 * The text under the editor's underlines of one severity, in the order of the
 * text. CodeMirror cuts an underline into pieces, so the pieces are joined.
 */
const readUnderlinedText = (severity: "error" | "warning"): string =>
  Array.from(
    document.querySelectorAll(`.cm-lintRange-${severity}`),
    (piece) => piece.textContent,
  ).join("");

/** Whether a line of the text, counted from 1, holds an error underline or an error mark. */
const hasErrorOnLine = (line: number): boolean => {
  const lineElement = document.querySelectorAll(".cm-line")[line - 1];
  return (lineElement?.querySelector(".cm-lintRange-error, .cm-lintPoint-error") ?? null) !== null;
};

/**
 * The editor inside a parent that keeps the source, as the workflow screen
 * does, with a button after the editor for focus to move to. No answer of the
 * controller has come.
 */
function EditorHost(props: {
  readonly initialSource: string;
  readonly onSourceChange: (source: string) => void;
}) {
  const [source, setSource] = useState(props.initialSource);
  return (
    <>
      <WorkflowEditor
        source={source}
        onSourceChange={(next) => {
          setSource(next);
          props.onSourceChange(next);
        }}
        view="yaml"
        catalog={CATALOG}
        validation={undefined}
        onIssuesChange={() => {}}
        onValidationStateChange={() => {}}
        onNameChange={() => {}}
      />
      <button type="button">Save</button>
    </>
  );
}

/** Mounts the editor on a source, focuses it, and puts the cursor at the end of the text. */
const openEditorAtEnd = async (initialSource: string) => {
  const typed = { current: initialSource };
  const user = userEvent.setup();
  render(
    <EditorHost
      initialSource={initialSource}
      onSourceChange={(next) => {
        typed.current = next;
      }}
    />,
  );
  const textbox = screen.getByRole("textbox", { name: "Workflow source" });
  await user.click(textbox);
  await user.keyboard("{Control>}{End}{/Control}");
  return { user, textbox, readSource: () => typed.current };
};

/** Asks for completions at the cursor, as Ctrl+Space does, and waits for the list. */
const requestCompletions = async (user: UserEvent): Promise<ReadonlyArray<HTMLElement>> => {
  await user.keyboard("{Control>} {/Control}");
  return screen.findAllByRole("option");
};

/** What a completion is called in the list, without the detail beside it. */
const readCompletionLabel = (option: HTMLElement): string =>
  option.querySelector(".cm-completionLabel")?.textContent ?? "";

/** The labels of a completion list, in alphabetical order. */
const sortCompletionLabels = (options: ReadonlyArray<HTMLElement>): ReadonlyArray<string> =>
  options.map(readCompletionLabel).sort((a, b) => a.localeCompare(b));

/** The completion with a label. A list without it fails the test and names what it offers. */
const findCompletion = (options: ReadonlyArray<HTMLElement>, label: string): HTMLElement => {
  const found = options.find((option) => readCompletionLabel(option) === label);
  if (found === undefined) {
    throw new Error(
      `No completion is labelled ${label}. The list offers ${sortCompletionLabels(options).join(", ")}.`,
    );
  }
  return found;
};

/**
 * The key codes that a browser sends with Escape and Tab. CodeMirror reads
 * them to decide if Tab moves focus out of the editor. user-event sends a key
 * code of 0.
 */
const BROWSER_KEY_CODES: Readonly<Record<string, number>> = { Escape: 27, Tab: 9 };

/** Gives a key event the key code a browser sends, before a listener in the page reads it. */
const addBrowserKeyCode = (event: KeyboardEvent): void => {
  const keyCode = BROWSER_KEY_CODES[event.key];
  if (keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: keyCode });
};

/** A source that ends where a new key of an agent step starts. */
const AGENT_STEP_AT_NEW_KEY = [
  "name: Review",
  "steps:",
  "  - id: review",
  "    kind: agent",
  `    agent: ${REVIEWER_ID}`,
  "    ",
].join("\n");

/** A source that ends where a new key of an action step starts. */
const ACTION_STEP_AT_NEW_KEY = [
  "name: Review",
  "steps:",
  "  - id: open_task",
  "    kind: action",
  "    action: task.create",
  "    ",
].join("\n");

describe("completion", () => {
  it("offers the two step kinds after kind: in a step", async () => {
    const { user } = await openEditorAtEnd(
      ["name: Review", "steps:", "  - id: review", "    kind: "].join("\n"),
    );

    expect(sortCompletionLabels(await requestCompletions(user))).toEqual(["action", "agent"]);
  });

  it.each([
    {
      kind: "agent",
      source: AGENT_STEP_AT_NEW_KEY,
      // id, kind and agent are written already.
      offered: [
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
      ],
    },
    {
      kind: "action",
      source: ACTION_STEP_AT_NEW_KEY,
      // id, kind and action are written already.
      offered: ["name", "params", "condition", "join", "entry", "terminal"],
    },
  ])("offers the keys of an $kind step that the step does not have yet", async (example) => {
    const { user } = await openEditorAtEnd(example.source);

    expect(sortCompletionLabels(await requestCompletions(user))).toEqual(
      [...example.offered].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("writes prompt as a block, and puts the cursor on the indented line under it", async () => {
    const { user, readSource } = await openEditorAtEnd(AGENT_STEP_AT_NEW_KEY);

    await user.click(findCompletion(await requestCompletions(user), "prompt"));
    await user.keyboard("Review the pull request.");

    const written = /\n( +)prompt: \|\n( +)Review the pull request\.$/.exec(readSource());
    expect(written, readSource()).not.toBeNull();
    // A block's lines are indented more than its key, or YAML reads them as the next key.
    const [, keyIndent = "", lineIndent = ""] = written ?? [];
    expect(keyIndent).toBe("    ");
    expect(lineIndent.length).toBeGreaterThan(keyIndent.length);
  });

  it("writes condition with its quotes, and puts the cursor between them", async () => {
    const { user, readSource } = await openEditorAtEnd(ACTION_STEP_AT_NEW_KEY);

    await user.click(findCompletion(await requestCompletions(user), "condition"));
    await user.keyboard("inputs.urgent");

    expect(readSource()).toBe(`${ACTION_STEP_AT_NEW_KEY}condition: "inputs.urgent"`);
  });

  it("offers the catalog's action ids after action:", async () => {
    const { user } = await openEditorAtEnd(
      ["name: Review", "steps:", "  - id: open_task", "    kind: action", "    action: "].join(
        "\n",
      ),
    );

    expect(sortCompletionLabels(await requestCompletions(user))).toEqual([
      "notes/note.append",
      "task.create",
      "task.query",
      "task.update",
    ]);
  });

  it("replaces the whole value that the cursor is inside with the action id picked", async () => {
    const lines = ["name: Review", "steps:", "  - id: open_task", "    kind: action"];
    const { user, readSource } = await openEditorAtEnd(
      [...lines, "    action: task.create"].join("\n"),
    );
    // The cursor goes between "task." and "create".
    await user.keyboard("{ArrowLeft>6/}");

    await user.click(findCompletion(await requestCompletions(user), "task.update"));

    expect(readSource()).toBe([...lines, "    action: task.update"].join("\n"));
  });

  it("offers the agents by name after agent:, and writes the id of the one picked", async () => {
    const source = [
      "name: Review",
      "steps:",
      "  - id: review",
      "    kind: agent",
      "    agent: ",
    ].join("\n");
    const { user, readSource } = await openEditorAtEnd(source);

    const options = await requestCompletions(user);
    expect(sortCompletionLabels(options)).toEqual(["Fixer", "Reviewer"]);

    await user.click(findCompletion(options, "Reviewer"));
    expect(readSource()).toBe(`${source}${REVIEWER_ID}`);
  });

  it("offers the catalog's event kinds after kind: in a trigger's source", async () => {
    const { user } = await openEditorAtEnd(
      [
        "name: Review",
        "triggers:",
        "  - id: labelled",
        "    kind: start",
        "    source:",
        "      kind: ",
      ].join("\n"),
    );

    expect(sortCompletionLabels(await requestCompletions(user))).toEqual([
      "cron.tick",
      "github.pr.labeled",
      "task.created",
    ]);
  });
});

describe("the keyboard", () => {
  beforeEach(() => {
    window.addEventListener("keydown", addBrowserKeyCode, true);
  });

  afterEach(() => {
    window.removeEventListener("keydown", addBrowserKeyCode, true);
  });

  const TEXT = ["name: Review", "steps:", "  - id: review", "    kind: agent", ""].join("\n");

  it("indents the line with Tab, and keeps focus in the editor", async () => {
    const { user, textbox, readSource } = await openEditorAtEnd(TEXT);

    await user.keyboard("{Tab}");

    // Spaces, because YAML refuses a tab as indentation.
    expect(readSource().startsWith(TEXT)).toBe(true);
    expect(readSource().slice(TEXT.length)).toMatch(/^ +$/);
    expect(document.activeElement).toBe(textbox);
  });

  it("moves focus out with Escape then Tab, and says so in the editor's description", async () => {
    const { user, textbox, readSource } = await openEditorAtEnd(TEXT);

    expect(
      screen.getByRole("textbox", {
        name: "Workflow source",
        description: /Esc(ape)?\W+then\W+Tab/i,
      }),
    ).toBe(textbox);

    await user.keyboard("{Escape}{Tab}");

    expect(textbox.contains(document.activeElement)).toBe(false);
    expect(readSource()).toBe(TEXT);
  });

  it("moves focus out with Escape then Tab while the completion list is open", async () => {
    const { user, textbox, readSource } = await openEditorAtEnd(AGENT_STEP_AT_NEW_KEY);
    await requestCompletions(user);

    await user.keyboard("{Escape}");
    expect(screen.queryAllByRole("option")).toEqual([]);
    await user.keyboard("{Tab}");

    expect(textbox.contains(document.activeElement)).toBe(false);
    expect(readSource()).toBe(AGENT_STEP_AT_NEW_KEY);
  });
});

/**
 * The editor inside a parent that keeps the source, with a handle on the
 * editor, as the workflow screen does.
 */
function HostWithHandle({
  parentSource,
  view,
  onSourceChange,
  validation,
  onIssuesChange,
  onNameChange,
  ref,
}: {
  /** The source that the parent wrote last, in place of the author's. */
  readonly parentSource: string;
  readonly view: EditorProps["view"];
  readonly onSourceChange: (source: string) => void;
  readonly validation: Validation;
  readonly onIssuesChange: ReportIssues;
  readonly onNameChange: EditorProps["onNameChange"];
  readonly ref: Ref<WorkflowEditorHandle>;
}) {
  const [source, setSource] = useState(parentSource);
  const [writtenSource, setWrittenSource] = useState(parentSource);
  if (parentSource !== writtenSource) {
    setWrittenSource(parentSource);
    setSource(parentSource);
  }
  return (
    <WorkflowEditor
      ref={ref}
      source={source}
      onSourceChange={(next) => {
        setSource(next);
        onSourceChange(next);
      }}
      view={view}
      catalog={CATALOG}
      validation={validation}
      onIssuesChange={onIssuesChange}
      onValidationStateChange={() => {}}
      onNameChange={onNameChange}
    />
  );
}

/**
 * Mounts the editor with a handle. `changeView` shows another view, as the
 * screen's control does, and `replaceSource` writes a source in place of the
 * author's, as the screen does when it shows another workflow. The answer of
 * the controller stays as it is given, as while the answer about the next
 * source is to come.
 */
const renderEditorWithHandle = (options: {
  readonly source: string;
  readonly view: EditorProps["view"];
  readonly validation?: Validation;
  readonly onIssuesChange?: ReportIssues;
  readonly onNameChange?: EditorProps["onNameChange"];
}) => {
  const handle = createRef<WorkflowEditorHandle>();
  const typed = { current: options.source };
  const shown = { view: options.view, parentSource: options.source };
  const buildHost = () => (
    <HostWithHandle
      parentSource={shown.parentSource}
      view={shown.view}
      ref={handle}
      onSourceChange={(next) => {
        typed.current = next;
      }}
      validation={options.validation}
      onIssuesChange={options.onIssuesChange ?? (() => {})}
      onNameChange={options.onNameChange ?? (() => {})}
    />
  );
  const { rerender } = render(buildHost());
  return {
    user: userEvent.setup(),
    readSource: () => typed.current,
    moveCursorToLine: (line: number) => {
      act(() => handle.current?.moveCursorToLine(line));
    },
    changeView: (view: EditorProps["view"]) => {
      shown.view = view;
      rerender(buildHost());
    },
    replaceSource: (source: string) => {
      shown.parentSource = source;
      typed.current = source;
      rerender(buildHost());
    },
  };
};

describe("typing", () => {
  it("keeps the marks of the last answer, moving with the text, and tells the parent of them while the answer about the new source is to come", async () => {
    const source = buildReviewWorkflowSource("task.creat");
    const error: Issue = {
      path: ["steps", "1", "action"],
      message: "task.creat is not an action.",
    };
    const onIssuesChange = vi.fn<ReportIssues>();
    // The answer is about the first source, and no answer about a later
    // source comes.
    const { user, readSource, moveCursorToLine } = renderEditorWithHandle({
      source,
      view: "yaml",
      validation: buildAnswer(source, { errors: [error] }),
      onIssuesChange,
    });
    await waitFor(() => {
      expect(readUnderlinedText("error")).toBe("action: task.creat");
    });

    // The author writes a line above the mark, and then finishes the word. A
    // mark placed by path would move onto the new word, and a mark that
    // moves with the text stays where it was, one line lower.
    moveCursorToLine(1);
    await user.keyboard("# More.{Enter}");
    moveCursorToLine(18);
    await user.keyboard("{ArrowLeft}e");

    expect(readSource()).toBe(`# More.\n${buildReviewWorkflowSource("task.create")}`);
    expect(readUnderlinedText("error")).toBe("action: task.creat");
    const from = findUniqueOffset(readSource(), "action: task.create\nedges");
    expect(onIssuesChange.mock.lastCall?.[0]).toEqual([
      { severity: "error", ...error, from, to: from + "action: task.creat".length, line: 17 },
    ]);
  });

  it("clears the marks of the parse once the source parses again, while the answer about it is to come", async () => {
    const source = buildReviewWorkflowSource("task.create");
    const onIssuesChange = vi.fn<ReportIssues>();
    const { user, moveCursorToLine } = renderEditorWithHandle({
      source,
      view: "yaml",
      validation: buildAnswer(source, {}),
      onIssuesChange,
    });

    // The author writes a mapping inside a compact mapping on line 16, which
    // YAML does not allow, and then takes the mapping out again. The source
    // is then another source than the one that the answer is about.
    moveCursorToLine(16);
    await user.keyboard("{End}e: x");
    expect(hasErrorOnLine(16)).toBe(true);
    await user.keyboard("{Backspace}{Backspace}{Backspace}");

    expect(hasErrorOnLine(16)).toBe(false);
    expect(onIssuesChange.mock.lastCall?.[0]).toEqual([]);
  });

  it("keeps each \\r\\n of a source as the author types, and marks its problems at their places", async () => {
    const source = buildReviewWorkflowSource("task.create")
      .replace("  - id: review\n    kind: action", "  - id: review\n    kind: acton")
      .replaceAll("\n", "\r\n");
    const { user, readSource } = await openEditorAtEnd(source);

    expect(readUnderlinedText("error")).toBe("kind: acton");

    await user.keyboard("#{Enter}#");

    expect(readSource().startsWith(`${source}#\r\n`)).toBe(true);
    expect(readSource().replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
    expect(readUnderlinedText("error")).toBe("kind: acton");
  });

  it("moves the cursor to a line when the text shows again, after the graph view hid it", async () => {
    const { user, readSource, moveCursorToLine, changeView } = renderEditorWithHandle({
      source: LINEAR_SOURCE,
      view: "graph",
    });

    moveCursorToLine(3);
    changeView("split");
    await user.keyboard("#");

    expect(readSource().split("\n")[2]).toBe("#  - id: labelled");
  });
});

describe("diagnostics", () => {
  it("underlines each issue that validation answers at its path, and gives the parent the same issues, errors first", () => {
    const source = buildReviewWorkflowSource("task.creat");
    // The warning's place comes before the error's place in the source, so
    // an order by place would put the warning first.
    const error: Issue = {
      path: ["steps", "1", "action"],
      message: "task.creat is not an action. Write one of task.create, task.update, task.query.",
    };
    const warning: Issue = {
      path: ["triggers", "0", "source", "filter"],
      message: "This filter admits every labelled pull request.",
    };
    const onIssuesChange = vi.fn<ReportIssues>();
    const { update } = renderEditor({
      source: buildReviewWorkflowSource("task.cre"),
      onIssuesChange,
      view: "yaml",
    });

    update({ source, validation: buildAnswer(source, { errors: [error], warnings: [warning] }) });

    expect(readUnderlinedText("error")).toBe("action: task.creat");
    expect(readUnderlinedText("warning")).toBe("filter: event.payload.number > 3");
    const actionFrom = findUniqueOffset(source, "action: task.creat\n");
    const filterFrom = findUniqueOffset(source, "filter: event.payload.number > 3");
    expect(onIssuesChange.mock.lastCall?.[0]).toEqual([
      {
        severity: "error",
        ...error,
        from: actionFrom,
        to: actionFrom + "action: task.creat".length,
        line: 16,
      },
      {
        severity: "warning",
        ...warning,
        from: filterFrom,
        to: filterFrom + "filter: event.payload.number > 3".length,
        line: 9,
      },
    ]);
  });

  it("places an issue whose path names nothing in the source at the document start", () => {
    // The source has two steps. A validation that answered before the author
    // removed a step can name a third or a fourth one.
    const source = buildReviewWorkflowSource("task.creat");
    const error: Issue = { path: ["steps", "3", "action"], message: "This action is unknown." };
    const onIssuesChange = vi.fn<ReportIssues>();
    const { update } = renderEditor({
      source: buildReviewWorkflowSource("task.cre"),
      onIssuesChange,
      view: "yaml",
    });

    update({ source, validation: buildAnswer(source, { errors: [error] }) });

    expect(onIssuesChange.mock.lastCall?.[0]).toEqual([
      { severity: "error", ...error, from: 0, to: expect.any(Number) as unknown, line: 1 },
    ]);
    expect(hasErrorOnLine(1)).toBe(true);
  });

  it("underlines a YAML syntax error as soon as the source changes, without waiting for validation", () => {
    const source = buildReviewWorkflowSource("task.create");
    // Line 16 holds a mapping inside a compact mapping, which YAML does not allow.
    const broken = source.replace(
      "    action: task.create\nedges:",
      "    action: task: create\nedges:",
    );
    const onIssuesChange = vi.fn<ReportIssues>();
    // No answer comes: each mark comes from the editor's own parse.
    const { update } = renderEditor({ source, onIssuesChange, view: "yaml" });

    update({ source: broken });

    expect(hasErrorOnLine(16)).toBe(true);
    expect(onIssuesChange.mock.lastCall?.[0]).toEqual([
      {
        severity: "error",
        path: [],
        message: expect.stringContaining("line 16") as unknown,
        from: expect.any(Number) as unknown,
        to: expect.any(Number) as unknown,
        line: 16,
      },
    ]);
  });

  it("underlines a shape error from its key through its value as soon as the source changes, without waiting for validation", () => {
    const source = buildReviewWorkflowSource("task.create");
    const broken = source.replace(
      "  - id: review\n    kind: action",
      "  - id: review\n    kind: acton",
    );
    const onIssuesChange = vi.fn<ReportIssues>();
    const { update } = renderEditor({ source, onIssuesChange, view: "yaml" });

    update({ source: broken });

    expect(readUnderlinedText("error")).toBe("kind: acton");
    const from = findUniqueOffset(broken, "kind: acton");
    expect(onIssuesChange.mock.lastCall?.[0]).toEqual([
      {
        severity: "error",
        path: ["steps", "1", "kind"],
        message: expect.any(String) as unknown,
        from,
        to: from + "kind: acton".length,
        line: 15,
      },
    ]);
  });

  it("reports how far the validation has come: validating until the answer about the source arrives, then validated", () => {
    const source = buildReviewWorkflowSource("task.cre");
    const onValidationStateChange = vi.fn<ReportValidationState>();
    const { update } = renderEditor({
      source,
      onIssuesChange: () => {},
      onValidationStateChange,
      view: "yaml",
    });
    expect(onValidationStateChange.mock.lastCall?.[0]).toEqual({ status: "validating" });

    update({ validation: buildAnswer(source, {}) });
    expect(onValidationStateChange.mock.lastCall?.[0]).toEqual({ status: "validated" });

    // The answer is about the source before.
    update({ source: buildReviewWorkflowSource("task.creat") });
    expect(onValidationStateChange.mock.lastCall?.[0]).toEqual({ status: "validating" });

    // The problems of a source that does not parse are the parse's, known at once.
    update({ source: buildReviewWorkflowSource("task: creat") });
    expect(onValidationStateChange.mock.lastCall?.[0]).toEqual({ status: "validated" });
  });

  it("reports why the controller cannot validate the source apart from the issues, until the source changes", () => {
    const source = buildReviewWorkflowSource("task.creat");
    const onIssuesChange = vi.fn<ReportIssues>();
    const onValidationStateChange = vi.fn<ReportValidationState>();
    const { update } = renderEditor({
      source: buildReviewWorkflowSource("task.cre"),
      onIssuesChange,
      onValidationStateChange,
      view: "yaml",
    });

    update({ source, validation: { source, reason: "The controller cannot be reached." } });

    expect(onValidationStateChange.mock.lastCall?.[0]).toEqual({
      status: "failed",
      reason: "The controller cannot be reached.",
    });
    // A failed validation is not a problem of the source.
    expect(onIssuesChange.mock.lastCall?.[0]).toEqual([]);

    // The failure was about the source before, and the answer about the new
    // source is to come.
    update({ source: buildReviewWorkflowSource("task.create") });

    expect(onValidationStateChange.mock.lastCall?.[0]).toEqual({ status: "validating" });
  });

  it("reports only the issues of the source in hand, and not the answer about an earlier source", () => {
    const source = buildReviewWorkflowSource("task.creat");
    const error: Issue = {
      path: ["steps", "1", "action"],
      message: "task.creat is not an action.",
    };
    const onIssuesChange = vi.fn<ReportIssues>();
    const { update } = renderEditor({
      source: buildReviewWorkflowSource("task.cre"),
      onIssuesChange,
      view: "yaml",
    });
    update({ source, validation: buildAnswer(source, { errors: [error] }) });
    expect(onIssuesChange.mock.lastCall?.[0]).toMatchObject([error]);

    // The author takes the step out, and the answer about the new source is
    // to come. The path of the old answer names nothing now, and it is not
    // placed at the document start either.
    update({
      source: source.replace("  - id: review\n    kind: action\n    action: task.creat\n", ""),
    });

    expect(onIssuesChange.mock.lastCall?.[0]).toEqual([]);
  });
});

describe("the screen's view of the source", () => {
  it("tells the parent the workflow's name, and keeps the last name while the source does not parse", async () => {
    const onNameChange = vi.fn<EditorProps["onNameChange"]>();
    const { user, readSource, moveCursorToLine } = renderEditorWithHandle({
      source: buildReviewWorkflowSource("task.create"),
      view: "yaml",
      onNameChange,
    });
    expect(onNameChange.mock.lastCall?.[0]).toBe("Review");

    moveCursorToLine(2);
    await user.keyboard("{End}ed");
    expect(readSource().split("\n")[1]).toBe("name: Reviewed");
    expect(onNameChange.mock.lastCall?.[0]).toBe("Reviewed");

    // The graph keeps showing the last source that read as a workflow, and so
    // does the name.
    await user.keyboard(": x");
    expect(readSource().split("\n")[1]).toBe("name: Reviewed: x");
    expect(onNameChange.mock.lastCall?.[0]).toBe("Reviewed");
  });
});

describe("the graph", () => {
  const renderGraphOf = (source: string) =>
    renderEditor({ source, onIssuesChange: () => {}, view: "split" });

  it("draws a node for each step and trigger, with each edge's condition and cap", async () => {
    renderGraphOf(LOOP_SOURCE);
    const graph = screen.getByRole("region", { name: "Workflow graph" });

    // findByText refuses two matches, so each id shows once.
    for (const id of LOOP_NODE_IDS) {
      expect(await within(graph).findByText(id)).toBeDefined();
    }
    expect(await within(graph).findByText("steps.review.output.approved == false")).toBeDefined();
    expect(await within(graph).findByText("max 3")).toBeDefined();
  });

  it("redraws when the source changes to another valid workflow", async () => {
    const { update } = renderGraphOf(LOOP_SOURCE);
    const graph = screen.getByRole("region", { name: "Workflow graph" });
    await within(graph).findByText("implement");

    update({ source: LINEAR_SOURCE });

    expect(await within(graph).findByText("open_task")).toBeDefined();
    expect(within(graph).getByText("labelled")).toBeDefined();
    expect(within(graph).getByText("review")).toBeDefined();
    for (const id of [
      "assigned",
      "checks_failed",
      "pr_merged",
      "implement",
      "open_pr",
      "task_done",
    ]) {
      expect(within(graph).queryByText(id)).toBeNull();
    }
    expect(within(graph).queryByText("max 3")).toBeNull();
  });

  it("keeps the last good graph, with a note, while the source does not parse", async () => {
    // The author breaks the source: a source that the parent writes is
    // another source, which the graph of the source before says nothing of.
    const { user, readSource, moveCursorToLine, replaceSource } = renderEditorWithHandle({
      source: LOOP_SOURCE,
      view: "split",
    });
    const graph = screen.getByRole("region", { name: "Workflow graph" });
    await within(graph).findByText("implement");

    moveCursorToLine(29);
    await user.keyboard("{ArrowLeft}: yes");
    expect(readSource()).toBe(BROKEN_LOOP_SOURCE);

    expect(await within(graph).findByText(/last version that did/i)).toBeDefined();
    for (const id of LOOP_NODE_IDS) {
      expect(within(graph).getByText(id)).toBeDefined();
    }
    expect(within(graph).getByText("max 3")).toBeDefined();

    replaceSource(LINEAR_SOURCE);

    expect(await within(graph).findByText("open_task")).toBeDefined();
    expect(within(graph).queryByText(/last version that did/i)).toBeNull();
  });

  it("forgets the last good graph when the parent writes another source that does not parse", async () => {
    const { replaceSource } = renderEditorWithHandle({ source: LOOP_SOURCE, view: "split" });
    const graph = screen.getByRole("region", { name: "Workflow graph" });
    await within(graph).findByText("implement");

    replaceSource(BROKEN_LOOP_SOURCE);

    expect(
      await within(graph).findByText("The graph appears when the text reads as a workflow."),
    ).toBeDefined();
    expect(within(graph).queryByText("implement")).toBeNull();
  });

  it("widens a card to fit a long id, and makes room for it in the layout", async () => {
    // 29 characters, which a card grows to show, and 41, which is past the widest card.
    const longId = "changes_requested_by_reviewer";
    const tooLongId = "open_a_task_for_the_labelled_pull_request";
    renderGraphOf(LINEAR_SOURCE.replaceAll("labelled", longId).replaceAll("open_task", tooLongId));
    const graph = screen.getByRole("region", { name: "Workflow graph" });
    await within(graph).findByText(longId);
    /** The box of a card, as the graph library's style of the node gives it. */
    const readCardBox = (id: string) => {
      const style = graph.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)?.style;
      const [, x = "NaN"] = /translate\(([-\d.]+)px/.exec(style?.transform ?? "") ?? [];
      return { x: Number(x), width: Number.parseFloat(style?.width ?? "NaN") };
    };
    const [trigger, task, review] = [longId, tooLongId, "review"].map(readCardBox);

    expect(review?.width).toBe(136);
    expect(trigger?.width).toBeGreaterThan(136);
    expect(task?.width).toBeGreaterThan(trigger?.width ?? Infinity);
    // Only the id past the widest card is cut, and its title holds the whole id.
    expect(within(graph).getByText(longId).title).toBe("");
    expect(within(graph).getByText(tooLongId).title).toBe(tooLongId);
    // Each card starts to the right of the wide card before it.
    expect((trigger?.x ?? 0) + (trigger?.width ?? 0)).toBeLessThan(task?.x ?? -Infinity);
    expect((task?.x ?? 0) + (task?.width ?? 0)).toBeLessThan(review?.x ?? -Infinity);
  });

  it("draws an edge from a step to itself with its cap", async () => {
    renderGraphOf(
      LINEAR_SOURCE.replace(
        "edges:\n",
        "edges:\n  - from: review\n    to: review\n    condition: steps.review.output.again\n    maxTraversals: 2\n",
      ),
    );
    const graph = screen.getByRole("region", { name: "Workflow graph" });

    expect(await within(graph).findByText("max 2")).toBeDefined();
    expect(within(graph).getByTitle("steps.review.output.again")).toBeDefined();
  });

  it("places the drawing again when an edge changes its shape, as when the source opens", async () => {
    // The graph has three nodes and two edges before the change and after it.
    // Only the nodes that the edges join are different: the branch becomes a row.
    const findGraphNode = (id: string) =>
      within(screen.getByRole("region", { name: "Workflow graph" })).findByText(id);
    renderGraphOf(LINEAR_SOURCE);
    await findGraphNode("open_task");
    const rowPlace = readDrawingPlace();
    cleanup();
    const { update } = renderGraphOf(BRANCHED_SOURCE);
    await findGraphNode("open_task");
    const branchPlace = readDrawingPlace();
    expect(branchPlace).not.toBe(rowPlace);

    update({ source: LINEAR_SOURCE });

    await waitFor(() => {
      expect(readDrawingPlace()).toBe(rowPlace);
    });
  });

  it("keeps the place of the drawing when a step is renamed or a condition changes", async () => {
    const user = userEvent.setup();
    const { update } = renderGraphOf(LOOP_SOURCE);
    const graph = screen.getByRole("region", { name: "Workflow graph" });
    await within(graph).findByText("implement");
    const placed = readDrawingPlace();
    // The author moves the drawing away from the place it opened at.
    await user.click(within(graph).getByRole("button", { name: "Fit to view" }));
    const fitted = readDrawingPlace();
    expect(fitted).not.toBe(placed);

    const renamed = LOOP_SOURCE.replaceAll("open_pr", "open_change");
    update({ source: renamed });
    expect(await within(graph).findByText("open_change")).toBeDefined();
    update({ source: renamed.replace("approved == false", "approved != true") });
    expect(await within(graph).findByText("steps.review.output.approved != true")).toBeDefined();

    expect(readDrawingPlace()).toBe(fitted);
  });
});
