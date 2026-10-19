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
import { findSkillReferences, type SkillReference } from "@hercule/contract";
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

/** A reference in the text of the document, placed in the document: `from` and `to` are positions in it. */
interface PlacedReference {
  readonly from: number;
  readonly to: number;
  readonly name: string;
}

/**
 * Returns the references that lie within a single run of typed text of
 * `doc`, with their positions. A reference that reaches into a chip or
 * across a paragraph is left out. `references` must be in document order, as
 * `findSkillReferences` returns them, and are in the text `readDocumentText`
 * returns. The document and the references are walked together once, so the
 * work grows with the size of both, not with their product.
 */
const placeReferences = (
  doc: ProseMirrorNode,
  references: ReadonlyArray<SkillReference>,
): PlacedReference[] => {
  const placed: PlacedReference[] = [];
  let offset = 0;
  let next = 0;
  doc.forEach((paragraph, paragraphPosition, index) => {
    if (index > 0) offset += 1;
    paragraph.forEach((child, childPosition) => {
      if (!child.isText) {
        offset += readChipText(child).length;
        return;
      }
      const runStart = offset;
      const runEnd = offset + (child.text ?? "").length;
      // References before the end of the run either lie in it or start in a
      // chip or an earlier run, and are passed for good.
      for (; next < references.length && references[next]!.start < runEnd; next += 1) {
        const { start, end, name } = references[next]!;
        if (start < runStart || end > runEnd) continue;
        const from = paragraphPosition + 1 + childPosition + (start - runStart);
        placed.push({ from, to: from + end - start, name });
      }
      offset = runEnd;
    });
  });
  return placed;
};

/** A chip in the document, with its position and its offset in the text `readDocumentText` returns. */
interface ChipPlace {
  readonly position: number;
  readonly offset: number;
  readonly name: string;
}

/** Returns the chips of `doc` in document order. */
const findChips = (doc: ProseMirrorNode): ChipPlace[] => {
  const chips: ChipPlace[] = [];
  let offset = 0;
  doc.forEach((paragraph, paragraphPosition, index) => {
    if (index > 0) offset += 1;
    paragraph.forEach((child, childPosition) => {
      if (!child.isText) {
        chips.push({
          position: paragraphPosition + 1 + childPosition,
          offset,
          name: String(child.attrs.name),
        });
      }
      offset += child.isText ? (child.text ?? "").length : readChipText(child).length;
    });
  });
  return chips;
};

/**
 * Returns the extension that turns each reference to a skill the field knows
 * into a chip. `readSkillNames` returns the names of the skills the field
 * knows, or `undefined` while it does not know them (they are being read, or
 * the read failed). Then no chip is made, and none is dissolved because of
 * its name.
 *
 * The plugin runs after every transaction that changes the document, and
 * after one carrying `CONVERT_ALL_REFERENCES` or `RESCAN_REFERENCES`. It
 * finds the references in the whole text with `findSkillReferences`, so a
 * reference in Markdown code or after a letter stays text, and works in two
 * steps on one appended transaction:
 *
 * 1. A chip that is no longer a reference in the text turns back into plain
 *    `$name` text. That happens when the user types a name character right
 *    after it (`$review` and `er` make `$reviewer`), or any character right
 *    before it (`x$review`), or wraps it in code. It also happens to a chip
 *    whose skill is not among the known names, such as after the thread moved
 *    to a workspace without that skill.
 * 2. Each reference to a known skill becomes a chip. A reference that ends
 *    at the caret is left alone, because the user may still be typing its
 *    name, unless the transaction carries `CONVERT_ALL_REFERENCES`. Step 1
 *    does not change the text, so the references found before it still hold.
 *    Step 2 looks for them in the document step 1 made. That is how `$review`
 *    and `er` become one `reviewer` chip at once, not a chip dissolved into
 *    text that stays text.
 *
 * Both steps share one transaction, because ProseMirror does not run this
 * plugin again on a transaction it appended itself. The transaction joins the
 * undo step of the edit that caused it, and it does not change the text, so
 * the field reports no second change.
 */
export const buildSkillChipExtension = (readSkillNames: () => ReadonlySet<string> | undefined) =>
  Extension.create({
    name: "skillChips",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          appendTransaction: (transactions, _oldState, newState) => {
            const convertAll = transactions.some((tr) => tr.getMeta(CONVERT_ALL_REFERENCES));
            const rescan = transactions.some((tr) => tr.getMeta(RESCAN_REFERENCES));
            if (!convertAll && !rescan && !transactions.some((tr) => tr.docChanged)) return null;
            const text = readDocumentText(newState.doc);
            if (!text.includes("$")) return null;
            const references = findSkillReferences(text);

            // `undefined` while the skills are not known (still being read, or the
            // read failed). The chips stay as they are then: nothing says they
            // are wrong.
            const names = readSkillNames();
            const referenceNames = new Map(
              references.map((reference) => [reference.start, reference.name]),
            );
            const staleChips = findChips(newState.doc).filter(
              (chip) =>
                referenceNames.get(chip.offset) !== chip.name ||
                (names !== undefined && !names.has(chip.name)),
            );
            const tr = newState.tr;
            // Last first, so the positions of the ones before it stay valid.
            for (const { position, name } of staleChips.reverse()) {
              tr.replaceWith(position, position + 1, newState.schema.text(`$${name}`));
            }

            if (names === undefined) return tr.docChanged ? tr : null;
            // `tr.doc` and `tr.selection` include the dissolved chips.
            const caret = tr.selection.empty ? tr.selection.head : null;
            const chip = newState.schema.nodes.skill!;
            const replacements = placeReferences(tr.doc, references).filter(
              ({ to, name }) => names.has(name) && (convertAll || caret !== to),
            );
            // Last first, so the positions of the ones before it stay valid.
            for (const { from, to, name } of replacements.reverse()) {
              tr.replaceWith(from, to, chip.create({ name }));
            }
            return tr.docChanged ? tr : null;
          },
        }),
      ];
    },
  });
