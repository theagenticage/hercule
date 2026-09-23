/**
 * Tests the text editor on its own: how it syncs with the text its parent
 * owns, how it keeps the text's line breaks, and how it reports the
 * diagnostics it underlines.
 */
import { createRef, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TextEditor, type TextEditorHandle } from "./text-editor";

type EditorProps = ComponentProps<typeof TextEditor>;

/** Returns the text the editor shows, joining its `.cm-line` elements. */
const readShownText = (): string =>
  Array.from(document.querySelectorAll(".cm-line"), (line) => line.textContent).join("\n");

/** Returns the text of each element with a class, in document order. */
const readClassText = (className: string): ReadonlyArray<string> =>
  Array.from(document.querySelectorAll(`.${className}`), (element) => element.textContent);

/** Builds an editor with a text. Callbacks the test does not pass do nothing. */
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
  it("keeps the author's typing when the parent passes back an older text late, and shows a new text from the parent", async () => {
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

    // A text that the editor did not send replaces the content.
    rerender(renderText("name: z"));
    expect(readShownText()).toBe("name: z");
    expect(sent).toHaveLength(2);
    expect(onTextReplace).toHaveBeenCalledOnce();
  });

  it("starts a new undo history when the parent replaces the text, so undo never restores the old text", async () => {
    const sent: Array<string> = [];
    const renderText = (text: string) =>
      buildEditor({ text, onTextChange: (next) => sent.push(next) });
    const { rerender } = render(renderText("name: a"));
    const user = userEvent.setup();
    await user.click(screen.getByRole("textbox", { name: "Workflow source" }));
    await user.keyboard("{Control>}{End}{/Control}b");
    // The parent passes the typed text back, and undo can still go back past it.
    rerender(renderText("name: ab"));
    await user.keyboard("{Control>}z{/Control}");
    expect(sent).toEqual(["name: ab", "name: a"]);
    rerender(renderText("name: a"));

    // The parent switches to another workflow.
    rerender(renderText("name: other"));
    await user.keyboard("{Control>}z{/Control}{Control>}z{/Control}");

    expect(sent).toEqual(["name: ab", "name: a"]);
    expect(readShownText()).toBe("name: other");
  });

  it("keeps the \\r\\n line breaks of a text, and underlines a diagnostic at its text offsets", async () => {
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

  it("counts lines in a text with mixed line breaks as the parser does, and shows each \\r as a special character", async () => {
    // The parser starts a new line only at \n. The text also holds a U+2028
    // line separator. Not every \n follows a \r, so the editor splits at \n.
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
    // Both \r characters and the U+2028 line separator show as special characters.
    expect(document.querySelectorAll(".cm-specialChar")).toHaveLength(3);
    expect(readClassText("cm-lintRange-error")).toEqual(["acton"]);

    act(() => handle.current?.moveCursorToLine(4));
    const user = userEvent.setup();
    await user.keyboard("#");

    expect(sent.at(-1)).toBe(text.replace("    kind", "#    kind"));
  });

  it("reports each underlined diagnostic at its current position as the underline moves with the text", async () => {
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

    // Typing after the underline moves nothing, so nothing is reported.
    const calls = onDiagnosticsChange.mock.calls.length;
    await user.keyboard("{Control>}{End}{/Control}#");
    expect(onDiagnosticsChange.mock.calls).toHaveLength(calls);
  });
});
