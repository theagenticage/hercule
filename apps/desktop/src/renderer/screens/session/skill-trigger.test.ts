import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";

import { readSkillTrigger } from "./skill-trigger";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "inline*", group: "block" },
    text: { group: "inline" },
    skill: { group: "inline", inline: true, atom: true, attrs: { name: { default: "" } } },
  },
});

/**
 * Builds the state of a field from a text where `|` marks the caret, a line
 * break starts a paragraph, and `{name}` is a skill chip.
 */
const buildState = (marked: string): EditorState => {
  const paragraphs = marked.replace("|", "\u0000").split("\n");
  let position = 0;
  let caretPosition = 0;
  const content = paragraphs.map((paragraph) => {
    const children = paragraph.split(/(\{[^}]*\})/).flatMap((part) => {
      if (part === "") return [];
      if (part.startsWith("{")) {
        position += 1;
        return [schema.nodes.skill.create({ name: part.slice(1, -1) })];
      }
      const text = part.replace("\u0000", "");
      const markerAt = part.indexOf("\u0000");
      if (markerAt !== -1) caretPosition = position + 1 + markerAt;
      position += text.length;
      return text === "" ? [] : [schema.text(text)];
    });
    position += 2;
    return schema.nodes.paragraph.create(null, children);
  });
  const doc = schema.nodes.doc.create(null, content);
  return EditorState.create({ doc, selection: TextSelection.create(doc, caretPosition) });
};

const readAt = (marked: string) => readSkillTrigger(buildState(marked));

describe("readSkillTrigger", () => {
  it("opens the skills list for a dollar sign and what follows it", () => {
    expect(readAt("$|")).toEqual({ kind: "skills", query: "", from: 1, to: 2 });
    expect(readAt("run $re|")).toEqual({ kind: "skills", query: "re", from: 5, to: 8 });
    expect(readAt("first\n$webshop:rel|")).toEqual({
      kind: "skills",
      query: "webshop:rel",
      from: 8,
      to: 20,
    });
  });

  it("opens the commands list for a slash and leaves out a typed skill: prefix", () => {
    expect(readAt("/skill:re|")).toMatchObject({ kind: "commands", query: "re" });
    expect(readAt("/tmp/x|")).toBeNull();
  });

  it.each(["$2|", "$20|", "$3d|", "$1.5|", "x $3d-mod|"])("opens nothing for %j", (marked) => {
    expect(readAt(marked)).toBeNull();
  });

  it("opens the list for a name that has a letter after a checkout", () => {
    expect(readAt("$webshop:3d|")).toMatchObject({ kind: "skills", query: "webshop:3d" });
  });

  it.each([
    "`$|",
    "`example $re|`",
    "``a ` $re|`` b",
    "`a\n$re|`",
    "```\n$re|",
    "```\n$re|\n```",
    "> ```\n> $re|",
    "- ```\n  $re|\n  ```",
    "    $re|",
  ])("opens nothing in code: %j", (marked) => {
    expect(readAt(marked)).toBeNull();
  });

  it.each([
    "`a` $re|",
    "`example $re|",
    "```\n$a\n```\n$re|",
    "a ` b\n\n$re| `",
    "> ```\n> $a\n> ```\n> $re|",
    "text\n    $re|",
  ])("opens the list outside code: %j", (marked) => {
    expect(readAt(marked)).toMatchObject({ kind: "skills", query: "re" });
  });

  it("counts a chip as text when it looks for code", () => {
    expect(readAt("{review} `x $re|`")).toBeNull();
    expect(readAt("{review} $re|")).toMatchObject({ kind: "skills", query: "re" });
  });

  it("opens nothing for a selection that is not empty", () => {
    const state = buildState("$re|");
    const selected = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 1, state.selection.head)),
    );
    expect(readSkillTrigger(selected)).toBeNull();
  });
});
