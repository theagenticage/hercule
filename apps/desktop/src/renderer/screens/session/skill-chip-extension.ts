/**
 * How the message field holds a Skill Reference. In the document a reference
 * to a known skill is a chip, an inline node that cannot be edited letter by
 * letter. In the text the field reads and writes it is `$name`, so the text
 * of a message is the same whether a reference is a chip or not, and the
 * chips are only a way of drawing it.
 */
import { Extension, Node } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { findSkillReferences } from "@hercule/contract";
import { buildSkillChipSpec } from "./skill-chip-markup";

/**
 * The meta key of a transaction that put text into the field which the user
 * did not type. The chip-making plugin turns every reference in it into a
 * chip, also one at the caret: nobody is in the middle of typing it.
 */
export const CONVERT_ALL_REFERENCES = "convertAllReferences";

/**
 * The meta key of a transaction that changes the names the field knows, and
 * nothing else. The chip-making plugin scans the document after it, as after
 * an edit: a reference at the caret stays text, because the user may be
 * typing it.
 */
export const RESCAN_REFERENCES = "rescanReferences";

/** Returns the text of a chip node: `$` and the skill's name. */
const readChipText = (chip: ProseMirrorNode): string => `$${String(chip.attrs.name)}`;

/** The chip: an inline node that holds the name of a skill, drawn as `buildSkillChipSpec` draws it. */
export const SkillChipNode = Node.create({
  name: "skill",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { name: { default: "" } };
  },
  renderHTML: ({ node }) => buildSkillChipSpec(String(node.attrs.name)),
  // The text of copied chips, which is how they are pasted into another field.
  renderText: ({ node }) => readChipText(node),
});

/**
 * Returns the text of `doc` up to position `end`, which is the whole
 * document when it is left out: the text of each paragraph, joined by
 * newlines, with each chip written as `$name`.
 */
export const readDocumentText = (doc: ProseMirrorNode, end = doc.content.size): string =>
  doc.textBetween(0, end, "\n", readChipText);

/**
 * Returns the position in `doc` of the text offset `start`, when the text
 * from `start` to `end` lies in a single run of typed text. Returns `null`
 * when it reaches into a chip or across a paragraph. Offsets are in the text
 * `readDocumentText` returns.
 */
const findTextRunPosition = (doc: ProseMirrorNode, start: number, end: number): number | null => {
  let offset = 0;
  let found: number | null = null;
  doc.forEach((paragraph, paragraphPosition, index) => {
    if (index > 0) offset += 1;
    paragraph.forEach((child, childPosition) => {
      const text = child.isText ? (child.text ?? "") : readChipText(child);
      if (child.isText && start >= offset && end <= offset + text.length) {
        found = paragraphPosition + 1 + childPosition + (start - offset);
      }
      offset += text.length;
    });
  });
  return found;
};

/**
 * Returns the extension that turns each reference to a skill the field knows
 * into a chip. `readSkillNames` returns the names of the skills the field
 * knows.
 *
 * The plugin runs after every transaction that changes the document, and
 * after one carrying `CONVERT_ALL_REFERENCES` or `RESCAN_REFERENCES`. It finds the references in the
 * whole text with `findSkillReferences`, so a reference in Markdown code or
 * after a letter stays text, and replaces each reference to a known skill
 * with a chip. It leaves alone a reference that ends at the caret, because
 * the user may still be typing its name, unless the transaction carries
 * `CONVERT_ALL_REFERENCES`.
 *
 * The replacement is an appended transaction. It joins the undo step of the
 * edit that caused it, and it does not change the text, so the field reports
 * no second change.
 */
export const buildSkillChipExtension = (readSkillNames: () => ReadonlySet<string>) =>
  Extension.create({
    name: "skillChips",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          appendTransaction: (transactions, _oldState, newState) => {
            const convertAll = transactions.some((tr) => tr.getMeta(CONVERT_ALL_REFERENCES));
            const rescan = transactions.some((tr) => tr.getMeta(RESCAN_REFERENCES));
            if (!convertAll && !rescan && !transactions.some((tr) => tr.docChanged)) return null;
            const names = readSkillNames();
            if (names.size === 0) return null;
            const { doc, selection } = newState;
            const text = readDocumentText(doc);
            if (!text.includes("$")) return null;
            const chip = newState.schema.nodes.skill!;
            const replacements: { from: number; to: number; name: string }[] = [];
            for (const reference of findSkillReferences(text)) {
              if (!names.has(reference.name)) continue;
              const from = findTextRunPosition(doc, reference.start, reference.end);
              if (from === null) continue;
              const to = from + reference.end - reference.start;
              if (!convertAll && selection.empty && selection.head === to) continue;
              replacements.push({ from, to, name: reference.name });
            }
            if (replacements.length === 0) return null;
            const tr = newState.tr;
            // Last first, so the positions of the ones before it stay valid.
            for (const { from, to, name } of replacements.reverse()) {
              tr.replaceWith(from, to, chip.create({ name }));
            }
            return tr;
          },
        }),
      ];
    },
  });
