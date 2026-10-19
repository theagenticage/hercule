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
import { redo, undo } from "@tiptap/pm/history";
import {
  buildSkillChipExtension,
  readDocumentText,
  RESCAN_REFERENCES,
  SkillChipNode,
} from "./skill-chip-extension";

const chip = (name: string): JSONContent => ({ type: "skill", attrs: { name } });
const text = (value: string): JSONContent => ({ type: "text", text: value });

const editors: Editor[] = [];

const defaultNames: ReadonlySet<string> = new Set(["review", "reviewer", "implement"]);

/**
 * Returns an editor whose only paragraph holds `content`. It knows the names
 * `readNames` returns, which are `review`, `reviewer` and `implement` unless
 * given.
 */
const buildEditor = (
  content: JSONContent[],
  readNames: () => ReadonlySet<string> | undefined = () => defaultNames,
): Editor => {
  const editor = new Editor({
    extensions: [
      Document,
      Paragraph,
      Text,
      UndoRedo,
      SkillChipNode,
      buildSkillChipExtension(readNames),
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

  describe("when text typed right after a chip changes the name it is part of", () => {
    /** Returns the names of the chips in `editor`, in order. */
    const readChipNames = (editor: Editor): string[] =>
      [...editor.view.dom.querySelectorAll("[data-skill]")].map(
        (element) => element.getAttribute("data-skill") ?? "",
      );

    it("makes one chip of the new, known name at once", () => {
      const editor = buildEditor([chip("review")]);
      editor.view.dispatch(editor.state.tr.insertText("er ", 2));
      expect(readChipNames(editor)).toEqual(["reviewer"]);
      expect(readDocumentText(editor.state.doc)).toBe("$reviewer ");
    });

    it("goes back to the first chip on undo and to the new one on redo", () => {
      const editor = buildEditor([chip("review")]);
      editor.view.dispatch(editor.state.tr.insertText("er ", 2));
      undo(editor.state, editor.view.dispatch);
      expect(readChipNames(editor)).toEqual(["review"]);
      expect(readDocumentText(editor.state.doc)).toBe("$review");
      redo(editor.state, editor.view.dispatch);
      expect(readChipNames(editor)).toEqual(["reviewer"]);
      expect(readDocumentText(editor.state.doc)).toBe("$reviewer ");
    });

    it("leaves plain text when the new name is not a known skill", () => {
      const editor = buildEditor([chip("review")]);
      editor.view.dispatch(editor.state.tr.insertText("ing ", 2));
      expect(readChipNames(editor)).toEqual([]);
      expect(readDocumentText(editor.state.doc)).toBe("$reviewing ");
    });
  });
});

describe("the chips after the known names change", () => {
  /** Dispatches the transaction `MessageField` sends when the names change. */
  const rescan = (editor: Editor): void => {
    editor.view.dispatch(editor.state.tr.setMeta(RESCAN_REFERENCES, true));
  };

  it("turns a chip back into text when the names no longer include its skill", () => {
    let names: ReadonlySet<string> | undefined = new Set(["webshop:release"]);
    const editor = buildEditor([chip("webshop:release"), text(" ")], () => names);
    expect(countChips(editor)).toBe(1);
    names = new Set(["other:release"]);
    rescan(editor);
    expect(countChips(editor)).toBe(0);
    expect(readDocumentText(editor.state.doc)).toBe("$webshop:release ");
  });

  it("keeps a chip whose skill is still known and dissolves only the others", () => {
    let names: ReadonlySet<string> | undefined = new Set(["review", "implement"]);
    const editor = buildEditor(
      [chip("review"), text(" "), chip("implement"), text(" ")],
      () => names,
    );
    names = new Set(["review"]);
    rescan(editor);
    expect(editor.view.dom.querySelectorAll("[data-skill]")).toHaveLength(1);
    expect(readDocumentText(editor.state.doc)).toBe("$review $implement ");
  });

  it("keeps every chip while the names are not known", () => {
    let names: ReadonlySet<string> | undefined = new Set(["review"]);
    const editor = buildEditor([chip("review"), text(" ")], () => names);
    names = undefined;
    rescan(editor);
    expect(countChips(editor)).toBe(1);
  });

  it("makes the chip again when the names include its skill again", () => {
    let names: ReadonlySet<string> | undefined = new Set(["review"]);
    const editor = buildEditor([chip("review"), text(" ")], () => names);
    names = new Set();
    rescan(editor);
    names = new Set(["review"]);
    rescan(editor);
    expect(countChips(editor)).toBe(1);
  });
});

describe("the work of one edit among many chips", () => {
  /** Returns the content of a paragraph of `count` chips, each followed by a space. */
  const buildChips = (count: number): JSONContent[] =>
    Array.from({ length: count }, () => [chip("review"), text(" ")]).flat();

  /**
   * Returns the time, in milliseconds, of one keystroke at the end of a
   * paragraph of `count` chips. It takes the best of several keystrokes, so a
   * pause of the machine does not decide the result.
   */
  const timeKeystroke = (count: number): number => {
    const editor = buildEditor(buildChips(count));
    const timings = Array.from({ length: 7 }, () => {
      const startedAt = performance.now();
      editor.view.dispatch(editor.state.tr.insertText("x", editor.state.doc.content.size - 1));
      return performance.now() - startedAt;
    });
    return Math.min(...timings);
  };

  it("grows with the number of chips, not with its square", () => {
    // The pass over every reference once cost this much more each time the
    // chips doubled: a ratio near 4 where a linear pass gives one near 2.
    expect(timeKeystroke(4_000) / timeKeystroke(2_000)).toBeLessThan(3);
  });
});
