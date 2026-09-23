/**
 * The text editor on its own: how it follows the text that its parent owns,
 * how it keeps the text's line breaks, and how it reports the problems that
 * it marks.
 */
import { createRef, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TextEditor, type TextEditorHandle } from "./text-editor";

type EditorProps = ComponentProps<typeof TextEditor>;

/** The text that the editor shows, one `.cm-line` element for each line. */
const readShownText = (): string =>
  Array.from(document.querySelectorAll(".cm-line"), (line) => line.textContent).join("\n");

/** The text of each element that has a class, in the order of the text. */
const readClassText = (className: string): ReadonlyArray<string> =>
  Array.from(document.querySelectorAll(`.${className}`), (element) => element.textContent);

/** The editor with a text, and every callback that the test does not name doing nothing. */
const buildEditor = (props: Partial<EditorProps> & Pick<EditorProps, "text">) => (
  <TextEditor
    onTextChange={() => {}}
    onTextReplace={() => {}}
    diagnostics={[]}
    onDiagnosticsChange={() => {}}
    completionSource={() => undefined}
    {...props}
  />
);

describe("the text editor", () => {
  it("keeps what the author typed when the parent sends an older text late, and shows a text that the parent writes", async () => {
    const sent: Array<string> = [];
    const onTextReplace = vi.fn();
    const renderText = (text: string) =>
      buildEditor({ text, onTextChange: (next) => sent.push(next), onTextReplace });
    const { rerender } = render(renderText("name: a"));
    const user = userEvent.setup();
    await user.click(screen.getByRole("textbox", { name: "Workflow source" }));
    await user.keyboard("{Control>}{End}{/Control}bc");
    expect(sent).toEqual(["name: ab", "name: abc"]);

    // The parent is one keystroke behind.
    rerender(renderText("name: ab"));
    expect(readShownText()).toBe("name: abc");
    rerender(renderText("name: abc"));
    expect(readShownText()).toBe("name: abc");
    expect(onTextReplace).not.toHaveBeenCalled();

    // A text that the editor did not send is the parent's own.
    rerender(renderText("name: z"));
    expect(readShownText()).toBe("name: z");
    expect(sent).toHaveLength(2);
    expect(onTextReplace).toHaveBeenCalledOnce();
  });

  it("starts a new history when the parent replaces the text, so undo never sends the old text up", async () => {
    const sent: Array<string> = [];
    const renderText = (text: string) =>
      buildEditor({ text, onTextChange: (next) => sent.push(next) });
    const { rerender } = render(renderText("name: a"));
    const user = userEvent.setup();
    await user.click(screen.getByRole("textbox", { name: "Workflow source" }));
    await user.keyboard("{Control>}{End}{/Control}b");
    // The parent sends the typed text back, and undo still reaches before it.
    rerender(renderText("name: ab"));
    await user.keyboard("{Control>}z{/Control}");
    expect(sent).toEqual(["name: ab", "name: a"]);
    rerender(renderText("name: a"));

    // Another workflow.
    rerender(renderText("name: other"));
    await user.keyboard("{Control>}z{/Control}{Control>}z{/Control}");

    expect(sent).toEqual(["name: ab", "name: a"]);
    expect(readShownText()).toBe("name: other");
  });

  it("gives back the \\r\\n line breaks of a text, and marks a problem at its offsets in the text", async () => {
    const text = "name: a\r\nsteps:\r\n  - id: x\r\n    kind: acton\r\n";
    const from = text.indexOf("acton");
    const sent: Array<string> = [];
    render(
      buildEditor({
        text,
        onTextChange: (next) => sent.push(next),
        diagnostics: [{ from, to: from + "acton".length, severity: "error", message: "No." }],
      }),
    );

    expect(readClassText("cm-lintRange-error")).toEqual(["acton"]);

    const user = userEvent.setup();
    await user.click(screen.getByRole("textbox", { name: "Workflow source" }));
    await user.keyboard("{Control>}{End}{/Control}#{Enter}#");

    expect(sent.at(-1)?.startsWith(`${text}#\r\n`)).toBe(true);
    expect(sent.at(-1)?.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
  });

  it("counts the lines of a text that mixes line breaks as the parser does, and shows each \\r that is not a part of one", async () => {
    // The parser starts a line at each \n only.
    const text = "name: a\r\nsteps:\n  - id: x \n    kind: acton\r\n";
    const from = text.indexOf("acton");
    const sent: Array<string> = [];
    const handle = createRef<TextEditorHandle>();
    render(
      buildEditor({
        text,
        onTextChange: (next) => sent.push(next),
        diagnostics: [{ from, to: from + "acton".length, severity: "error", message: "No." }],
        ref: handle,
      }),
    );

    expect(document.querySelectorAll(".cm-line")).toHaveLength(text.split("\n").length);
    // Each \r, and the line separator of JavaScript, shows as a special character.
    expect(document.querySelectorAll(".cm-specialChar")).toHaveLength(3);
    expect(readClassText("cm-lintRange-error")).toEqual(["acton"]);

    act(() => handle.current?.moveCursorToLine(4));
    const user = userEvent.setup();
    await user.keyboard("#");

    expect(sent.at(-1)).toBe(text.replace("    kind", "#    kind"));
  });

  it("reports each problem that it marks at the place of its mark, as the mark moves with the text", async () => {
    const text = "name: a\nkind: acton\n";
    const from = text.indexOf("acton");
    const problem = { from, to: from + "acton".length, severity: "error", message: "No." } as const;
    const onDiagnosticsChange = vi.fn<EditorProps["onDiagnosticsChange"]>();
    const handle = createRef<TextEditorHandle>();
    render(buildEditor({ text, diagnostics: [problem], onDiagnosticsChange, ref: handle }));

    expect(onDiagnosticsChange.mock.lastCall?.[0]).toEqual([{ ...problem, line: 2 }]);

    act(() => handle.current?.moveCursorToLine(1));
    const user = userEvent.setup();
    await user.keyboard("{Enter}");

    expect(onDiagnosticsChange.mock.lastCall?.[0]).toEqual([
      { ...problem, from: from + 1, to: from + 1 + "acton".length, line: 3 },
    ]);

    // Text typed after the mark moves nothing, so nothing is reported.
    const calls = onDiagnosticsChange.mock.calls.length;
    await user.keyboard("{Control>}{End}{/Control}#");
    expect(onDiagnosticsChange.mock.calls).toHaveLength(calls);
  });
});
