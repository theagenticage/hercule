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
 * The parent owns the text, as the workflow screen does. The diagnostics
 * tests give the editor each new text as the parent does after a keystroke,
 * so a fake clock can measure the wait before validation. user-event cannot
 * type under a fake clock: Testing Library waits for a timer after each
 * action, and a fake clock never lets that timer fire.
 */
import { createRef, useState, type ComponentProps, type Ref } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { Issue } from "@hercule/contract";
import { WorkflowEditor, type WorkflowEditorHandle } from ".";

type EditorProps = ComponentProps<typeof WorkflowEditor>;
type Validate = EditorProps["validate"];
type ReportIssues = EditorProps["onIssuesChange"];
type ReportCheckState = EditorProps["onCheckStateChange"];

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

/** A validation that finds nothing. */
const answerNoIssues: Validate = () => Promise.resolve({ errors: [], warnings: [] });

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

/**
 * A valid workflow whose step `review` names the given action, as the text
 * reads while the author types that action. One line for each item, so line N
 * is item N - 1.
 */
const buildReviewWorkflowText = (action: string): string =>
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
const LOOP_TEXT = [
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

/** The id of each step and each trigger of `LOOP_TEXT`. */
const LOOP_NODE_IDS = [
  "assigned",
  "checks_failed",
  "pr_merged",
  "implement",
  "open_pr",
  "review",
  "task_done",
];

/** `LOOP_TEXT` with a mapping inside a compact mapping on line 28, which YAML does not allow. */
const BROKEN_LOOP_TEXT = LOOP_TEXT.replace("    entry: true\n", "    entry: true: yes\n");

/** A workflow of two steps in a line, and a trigger that starts it. */
const LINEAR_TEXT = [
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
 * Mounts the editor as a parent that owns the text does. `changeSource` gives
 * the editor a new text, as the parent does after each keystroke.
 */
const renderEditor = (options: {
  readonly source: string;
  readonly validate: Validate;
  readonly onIssuesChange: ReportIssues;
  readonly onCheckStateChange?: ReportCheckState;
  readonly view: EditorProps["view"];
}) => {
  const buildEditorElement = (source: string) => (
    <WorkflowEditor
      source={source}
      onSourceChange={() => {}}
      view={options.view}
      catalog={CATALOG}
      validate={options.validate}
      onIssuesChange={options.onIssuesChange}
      onCheckStateChange={options.onCheckStateChange ?? (() => {})}
    />
  );
  const { rerender } = render(buildEditorElement(options.source));
  return {
    changeSource: (source: string) => {
      rerender(buildEditorElement(source));
    },
  };
};

/** Moves the fake clock on, and lets React and the promises it settles catch up. */
const advanceClock = (milliseconds: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });

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
 * The editor inside a parent that keeps the text, as the workflow screen does,
 * with a button after the editor for focus to move to.
 */
function EditorHost(props: {
  readonly initialSource: string;
  readonly onSourceChange: (source: string) => void;
  readonly validate?: Validate;
  readonly onIssuesChange?: ReportIssues;
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
        validate={props.validate ?? answerNoIssues}
        onIssuesChange={props.onIssuesChange ?? (() => {})}
        onCheckStateChange={() => {}}
      />
      <button type="button">Save</button>
    </>
  );
}

/** Mounts the editor on a text, focuses it, and puts the cursor at the end of the text. */
const openEditorAtEnd = async (
  initialSource: string,
  options: Pick<ComponentProps<typeof EditorHost>, "validate" | "onIssuesChange"> = {},
) => {
  const text = { current: initialSource };
  const user = userEvent.setup();
  render(
    <EditorHost
      initialSource={initialSource}
      onSourceChange={(next) => {
        text.current = next;
      }}
      {...options}
    />,
  );
  const textbox = screen.getByRole("textbox", { name: "Workflow source" });
  await user.click(textbox);
  await user.keyboard("{Control>}{End}{/Control}");
  return { user, textbox, readSource: () => text.current };
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

/** A text that ends where a new key of an agent step starts. */
const AGENT_STEP_AT_NEW_KEY = [
  "name: Review",
  "steps:",
  "  - id: review",
  "    kind: agent",
  `    agent: ${REVIEWER_ID}`,
  "    ",
].join("\n");

/** A text that ends where a new key of an action step starts. */
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
      text: AGENT_STEP_AT_NEW_KEY,
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
      text: ACTION_STEP_AT_NEW_KEY,
      // id, kind and action are written already.
      offered: ["name", "params", "condition", "join", "entry", "terminal"],
    },
  ])("offers the keys of an $kind step that the step does not have yet", async (example) => {
    const { user } = await openEditorAtEnd(example.text);

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

  it("offers the agents by name after agent:, and writes the id of the one picked", async () => {
    const text = [
      "name: Review",
      "steps:",
      "  - id: review",
      "    kind: agent",
      "    agent: ",
    ].join("\n");
    const { user, readSource } = await openEditorAtEnd(text);

    const options = await requestCompletions(user);
    expect(sortCompletionLabels(options)).toEqual(["Fixer", "Reviewer"]);

    await user.click(findCompletion(options, "Reviewer"));
    expect(readSource()).toBe(`${text}${REVIEWER_ID}`);
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
 * The editor inside a parent that keeps the text, with a handle on the
 * editor, as the workflow screen does.
 */
function HostWithHandle({
  parentSource,
  view,
  onSourceChange,
  validate,
  onIssuesChange,
  ref,
}: {
  /** The text that the parent wrote last, in place of the author's. */
  readonly parentSource: string;
  readonly view: EditorProps["view"];
  readonly onSourceChange: (source: string) => void;
  readonly validate: Validate;
  readonly onIssuesChange: ReportIssues;
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
      validate={validate}
      onIssuesChange={onIssuesChange}
      onCheckStateChange={() => {}}
    />
  );
}

/**
 * Mounts the editor with a handle. `changeView` shows another view, as the
 * screen's control does, and `replaceSource` writes a text in place of the
 * author's, as the screen does when it shows another workflow.
 */
const renderEditorWithHandle = (options: {
  readonly source: string;
  readonly view: EditorProps["view"];
  readonly validate?: Validate;
  readonly onIssuesChange?: ReportIssues;
}) => {
  const handle = createRef<WorkflowEditorHandle>();
  const text = { current: options.source };
  const shown = { view: options.view, parentSource: options.source };
  const buildHost = () => (
    <HostWithHandle
      parentSource={shown.parentSource}
      view={shown.view}
      ref={handle}
      onSourceChange={(next) => {
        text.current = next;
      }}
      validate={options.validate ?? answerNoIssues}
      onIssuesChange={options.onIssuesChange ?? (() => {})}
    />
  );
  const { rerender } = render(buildHost());
  return {
    user: userEvent.setup(),
    readSource: () => text.current,
    moveCursorToLine: (line: number) => {
      act(() => handle.current?.moveCursorToLine(line));
    },
    changeView: (view: EditorProps["view"]) => {
      shown.view = view;
      rerender(buildHost());
    },
    replaceSource: (source: string) => {
      shown.parentSource = source;
      text.current = source;
      rerender(buildHost());
    },
  };
};

describe("typing", () => {
  it("keeps the marks of the last answer, moving with the text, and tells the parent of them while the answer about the new text is to come", async () => {
    const text = buildReviewWorkflowText("task.creat");
    const error: Issue = {
      path: ["steps", "1", "action"],
      message: "task.creat is not an action.",
    };
    const onIssuesChange = vi.fn<ReportIssues>();
    const { user, readSource, moveCursorToLine } = renderEditorWithHandle({
      source: text,
      view: "yaml",
      // The answer about the first text comes at once, and the answer about
      // any later text never comes.
      validate: (source) =>
        source === text
          ? Promise.resolve({ errors: [error], warnings: [] })
          : new Promise(() => {}),
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

    expect(readSource()).toBe(`# More.\n${buildReviewWorkflowText("task.create")}`);
    expect(readUnderlinedText("error")).toBe("action: task.creat");
    const from = findUniqueOffset(readSource(), "action: task.create\nedges");
    expect(onIssuesChange.mock.lastCall?.[0]).toEqual([
      { severity: "error", ...error, from, to: from + "action: task.creat".length, line: 17 },
    ]);
  });

  it("keeps each \\r\\n of a text as the author types, and marks its problems at their places", async () => {
    const text = buildReviewWorkflowText("task.create")
      .replace("  - id: review\n    kind: action", "  - id: review\n    kind: acton")
      .replaceAll("\n", "\r\n");
    const { user, readSource } = await openEditorAtEnd(text);

    expect(readUnderlinedText("error")).toBe("kind: acton");

    await user.keyboard("#{Enter}#");

    expect(readSource().startsWith(`${text}#\r\n`)).toBe(true);
    expect(readSource().replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
    expect(readUnderlinedText("error")).toBe("kind: acton");
  });

  it("moves the cursor to a line when the text shows again, after the graph view hid it", async () => {
    const { user, readSource, moveCursorToLine, changeView } = renderEditorWithHandle({
      source: LINEAR_TEXT,
      view: "graph",
    });

    moveCursorToLine(3);
    changeView("split");
    await user.keyboard("#");

    expect(readSource().split("\n")[2]).toBe("#  - id: labelled");
  });
});

describe("diagnostics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** The texts a validation was asked about, in the order it was asked. */
  const listValidatedSources = (validate: Mock<Validate>) =>
    validate.mock.calls.map(([source]) => source);

  it("validates about 400 ms after the text stops changing, with the text as it is then", async () => {
    const validate = vi.fn<Validate>(answerNoIssues);
    const { changeSource } = renderEditor({
      source: buildReviewWorkflowText("task.c"),
      validate,
      onIssuesChange: () => {},
      view: "yaml",
    });

    changeSource(buildReviewWorkflowText("task.cre"));
    await advanceClock(200);
    changeSource(buildReviewWorkflowText("task.creat"));
    await advanceClock(200);

    // The last change was 200 ms ago: the author may still be typing.
    expect(listValidatedSources(validate)).not.toContain(buildReviewWorkflowText("task.cre"));
    expect(listValidatedSources(validate)).not.toContain(buildReviewWorkflowText("task.creat"));

    await advanceClock(800);

    expect(
      listValidatedSources(validate).filter(
        (source) => source === buildReviewWorkflowText("task.creat"),
      ),
    ).toHaveLength(1);
    // The text that stood for only 200 ms is never validated.
    expect(listValidatedSources(validate)).not.toContain(buildReviewWorkflowText("task.cre"));
  });

  it("underlines each issue that validation answers at its path, and gives the parent the same issues, errors first", async () => {
    const text = buildReviewWorkflowText("task.creat");
    // The warning's place comes before the error's place in the text, so an
    // order by place would put the warning first.
    const error: Issue = {
      path: ["steps", "1", "action"],
      message: "task.creat is not an action. Write one of task.create, task.update, task.query.",
    };
    const warning: Issue = {
      path: ["triggers", "0", "source", "filter"],
      message: "This filter admits every labelled pull request.",
    };
    const validate = vi.fn<Validate>(() =>
      Promise.resolve({ errors: [error], warnings: [warning] }),
    );
    const onIssuesChange = vi.fn<ReportIssues>();
    const { changeSource } = renderEditor({
      source: buildReviewWorkflowText("task.cre"),
      validate,
      onIssuesChange,
      view: "yaml",
    });

    changeSource(text);
    await advanceClock(1000);

    expect(listValidatedSources(validate)).toContain(text);
    expect(readUnderlinedText("error")).toBe("action: task.creat");
    expect(readUnderlinedText("warning")).toBe("filter: event.payload.number > 3");
    const actionFrom = findUniqueOffset(text, "action: task.creat\n");
    const filterFrom = findUniqueOffset(text, "filter: event.payload.number > 3");
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

  it("places an issue whose path names nothing in the text at the document start", async () => {
    // The text has two steps. A validation that answered before the author
    // removed a step can name a third or a fourth one.
    const error: Issue = { path: ["steps", "3", "action"], message: "This action is unknown." };
    const onIssuesChange = vi.fn<ReportIssues>();
    const { changeSource } = renderEditor({
      source: buildReviewWorkflowText("task.cre"),
      validate: () => Promise.resolve({ errors: [error], warnings: [] }),
      onIssuesChange,
      view: "yaml",
    });

    changeSource(buildReviewWorkflowText("task.creat"));
    await advanceClock(1000);

    expect(onIssuesChange.mock.lastCall?.[0]).toEqual([
      { severity: "error", ...error, from: 0, to: expect.any(Number) as unknown, line: 1 },
    ]);
    expect(hasErrorOnLine(1)).toBe(true);
  });

  it("underlines a YAML syntax error as soon as the text changes, without waiting for validation", async () => {
    const text = buildReviewWorkflowText("task.create");
    // Line 16 holds a mapping inside a compact mapping, which YAML does not allow.
    const broken = text.replace(
      "    action: task.create\nedges:",
      "    action: task: create\nedges:",
    );
    const onIssuesChange = vi.fn<ReportIssues>();
    // A validation that never answers: each mark comes from the editor's own parse.
    const { changeSource } = renderEditor({
      source: text,
      validate: () => new Promise(() => {}),
      onIssuesChange,
      view: "yaml",
    });

    changeSource(broken);
    await advanceClock(50);

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

  it("underlines a shape error from its key through its value as soon as the text changes, without waiting for validation", async () => {
    const text = buildReviewWorkflowText("task.create");
    const broken = text.replace(
      "  - id: review\n    kind: action",
      "  - id: review\n    kind: acton",
    );
    const onIssuesChange = vi.fn<ReportIssues>();
    const { changeSource } = renderEditor({
      source: text,
      validate: () => new Promise(() => {}),
      onIssuesChange,
      view: "yaml",
    });

    changeSource(broken);
    await advanceClock(50);

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

  it("reports how far the check has come: checking until the answer arrives, then checked", async () => {
    const onCheckStateChange = vi.fn<ReportCheckState>();
    const { changeSource } = renderEditor({
      source: buildReviewWorkflowText("task.cre"),
      validate: answerNoIssues,
      onIssuesChange: () => {},
      onCheckStateChange,
      view: "yaml",
    });
    expect(onCheckStateChange.mock.lastCall?.[0]).toEqual({ status: "checking" });

    await advanceClock(1000);
    expect(onCheckStateChange.mock.lastCall?.[0]).toEqual({ status: "checked" });

    changeSource(buildReviewWorkflowText("task.creat"));
    await advanceClock(50);
    expect(onCheckStateChange.mock.lastCall?.[0]).toEqual({ status: "checking" });

    // The problems of a text that does not parse are the parse's, known at once.
    changeSource(buildReviewWorkflowText("task: creat"));
    await advanceClock(50);
    expect(onCheckStateChange.mock.lastCall?.[0]).toEqual({ status: "checked" });
  });

  it("reports why the controller cannot check the text apart from the issues, until the text changes", async () => {
    const onIssuesChange = vi.fn<ReportIssues>();
    const onCheckStateChange = vi.fn<ReportCheckState>();
    const { changeSource } = renderEditor({
      source: buildReviewWorkflowText("task.cre"),
      validate: () => Promise.reject(new Error("The controller cannot be reached.")),
      onIssuesChange,
      onCheckStateChange,
      view: "yaml",
    });

    changeSource(buildReviewWorkflowText("task.creat"));
    await advanceClock(1000);

    expect(onCheckStateChange.mock.lastCall?.[0]).toEqual({
      status: "failed",
      reason: expect.stringContaining("The controller cannot be reached.") as unknown,
    });
    // A failed check is not a problem of the text.
    expect(onIssuesChange.mock.lastCall?.[0]).toEqual([]);

    // The failure was about the text before, and a new check waits for the author to stop typing.
    changeSource(buildReviewWorkflowText("task.create"));
    await advanceClock(50);

    expect(onCheckStateChange.mock.lastCall?.[0]).toEqual({ status: "checking" });
  });

  it("reports only the issues of the text in hand, and not the answer about an earlier text", async () => {
    const text = buildReviewWorkflowText("task.creat");
    const error: Issue = {
      path: ["steps", "1", "action"],
      message: "task.creat is not an action.",
    };
    // The answer about the first text comes at once. The answer about any
    // later text never comes.
    const validate = vi.fn<Validate>((source) =>
      source === text ? Promise.resolve({ errors: [error], warnings: [] }) : new Promise(() => {}),
    );
    const onIssuesChange = vi.fn<ReportIssues>();
    const { changeSource } = renderEditor({
      source: buildReviewWorkflowText("task.cre"),
      validate,
      onIssuesChange,
      view: "yaml",
    });
    changeSource(text);
    await advanceClock(1000);
    expect(onIssuesChange.mock.lastCall?.[0]).toMatchObject([error]);

    // The author takes the step out. The path of the old answer names
    // nothing now, and it is not placed at the document start either.
    changeSource(text.replace("  - id: review\n    kind: action\n    action: task.creat\n", ""));
    await advanceClock(1000);

    expect(onIssuesChange.mock.lastCall?.[0]).toEqual([]);
  });
});

describe("the graph", () => {
  const renderGraphOf = (source: string) =>
    renderEditor({ source, validate: answerNoIssues, onIssuesChange: () => {}, view: "split" });

  it("draws a node for each step and trigger, with each edge's condition and cap", async () => {
    renderGraphOf(LOOP_TEXT);
    const graph = screen.getByRole("region", { name: "Workflow graph" });

    // findByText refuses two matches, so each id shows once.
    for (const id of LOOP_NODE_IDS) {
      expect(await within(graph).findByText(id)).toBeDefined();
    }
    expect(await within(graph).findByText("steps.review.output.approved == false")).toBeDefined();
    expect(await within(graph).findByText("max 3")).toBeDefined();
  });

  it("redraws when the text changes to another valid workflow", async () => {
    const { changeSource } = renderGraphOf(LOOP_TEXT);
    const graph = screen.getByRole("region", { name: "Workflow graph" });
    await within(graph).findByText("implement");

    changeSource(LINEAR_TEXT);

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

  it("keeps the last good graph, with a note, while the text does not parse", async () => {
    // The author breaks the text: a text that the parent writes is another
    // text, which the graph of the text before says nothing of.
    const { user, readSource, moveCursorToLine, replaceSource } = renderEditorWithHandle({
      source: LOOP_TEXT,
      view: "split",
    });
    const graph = screen.getByRole("region", { name: "Workflow graph" });
    await within(graph).findByText("implement");

    moveCursorToLine(29);
    await user.keyboard("{ArrowLeft}: yes");
    expect(readSource()).toBe(BROKEN_LOOP_TEXT);

    expect(await within(graph).findByText(/last version that did/i)).toBeDefined();
    for (const id of LOOP_NODE_IDS) {
      expect(within(graph).getByText(id)).toBeDefined();
    }
    expect(within(graph).getByText("max 3")).toBeDefined();

    replaceSource(LINEAR_TEXT);

    expect(await within(graph).findByText("open_task")).toBeDefined();
    expect(within(graph).queryByText(/last version that did/i)).toBeNull();
  });

  it("forgets the last good graph when the parent writes another text that does not parse", async () => {
    const { replaceSource } = renderEditorWithHandle({ source: LOOP_TEXT, view: "split" });
    const graph = screen.getByRole("region", { name: "Workflow graph" });
    await within(graph).findByText("implement");

    replaceSource(BROKEN_LOOP_TEXT);

    expect(
      await within(graph).findByText("The graph appears when the text reads as a workflow."),
    ).toBeDefined();
    expect(within(graph).queryByText("implement")).toBeNull();
  });

  it("draws an edge from a step to itself with its cap", async () => {
    renderGraphOf(
      LINEAR_TEXT.replace(
        "edges:\n",
        "edges:\n  - from: review\n    to: review\n    condition: steps.review.output.again\n    maxTraversals: 2\n",
      ),
    );
    const graph = screen.getByRole("region", { name: "Workflow graph" });

    expect(await within(graph).findByText("max 2")).toBeDefined();
    expect(within(graph).getByTitle("steps.review.output.again")).toBeDefined();
  });
});
