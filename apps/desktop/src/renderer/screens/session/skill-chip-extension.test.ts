/**
 * Tests the chip-making plugin on an editor of its own, for the edits that
 * the message field's tests cannot reach in jsdom, such as typing right
 * before a chip.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { UndoRedo } from "@tiptap/extensions/undo-redo";
import { undo } from "@tiptap/pm/history";
import { buildSkillChipExtension, readDocumentText, SkillChipNode } from "./skill-chip-extension";

const chip = (name: string): JSONContent => ({ type: "skill", attrs: { name } });
const text = (value: string): JSONContent => ({ type: "text", text: value });

const editors: Editor[] = [];

/** Returns an editor whose only paragraph holds `content`, and which knows the skills `review` and `implement`. */
const buildEditor = (content: JSONContent[]): Editor => {
  const editor = new Editor({
    extensions: [
      Document,
      Paragraph,
      Text,
      UndoRedo,
      SkillChipNode,
      buildSkillChipExtension(() => new Set(["review", "implement"])),
    ],
    content: { type: "doc", content: [{ type: "paragraph", content }] },
  });
  editors.push(editor);
  return editor;
};

const countChips = (editor: Editor): number =>
  editor.view.dom.querySelectorAll(".skill-chip").length;

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

describe("the chips after an edit around them", () => {
  it("turns a chip back into text when a character is typed right before it", () => {
    const editor = buildEditor([chip("review"), text(" ")]);
    editor.view.dispatch(editor.state.tr.insertText("x", 1));
    expect(countChips(editor)).toBe(0);
    expect(readDocumentText(editor.state.doc)).toBe("x$review ");
  });

  it("brings the chip back when that edit is undone", () => {
    const editor = buildEditor([chip("review"), text(" ")]);
    editor.view.dispatch(editor.state.tr.insertText("x", 1));
    undo(editor.state, editor.view.dispatch);
    expect(countChips(editor)).toBe(1);
    expect(readDocumentText(editor.state.doc)).toBe("$review ");
  });

  it("makes the chip again when the character before it is deleted", () => {
    const editor = buildEditor([chip("review"), text(" ")]);
    editor.view.dispatch(editor.state.tr.insertText("x", 1));
    editor.view.dispatch(editor.state.tr.delete(1, 2));
    expect(countChips(editor)).toBe(1);
    expect(readDocumentText(editor.state.doc)).toBe("$review ");
  });

  it("keeps the first of two chips side by side and turns the second into text", () => {
    const editor = buildEditor([chip("review"), chip("implement"), text(" ")]);
    editor.view.dispatch(editor.state.tr.insertText("!", editor.state.doc.content.size - 1));
    expect(editor.view.dom.querySelectorAll("[data-skill]")).toHaveLength(1);
    expect(readDocumentText(editor.state.doc)).toBe("$review$implement !");
  });
});
