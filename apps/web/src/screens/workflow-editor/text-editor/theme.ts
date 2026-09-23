/**
 * The look of the text editor, built from the design tokens and the syntax
 * palette of `@hercule/ui`. Each colour is a CSS variable, so the editor
 * follows the light and the dark theme as the rest of the app does, and the
 * editor library's own colours never show. The popups are the app's menus: the
 * radius of a card, a padding of 6px, and rows with the radius of a control.
 */
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

/**
 * The colour of each part of the YAML text, from the tags that the YAML
 * grammar gives. A plain value has no rule, so it is ink.
 */
export const syntaxHighlightStyle = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.propertyName, color: "var(--syn-key)" },
    { tag: tags.string, color: "var(--syn-string)" },
    { tag: tags.comment, color: "var(--syn-comment)", fontStyle: "italic" },
    // The `|` of a block is punctuation of the text, and not a string.
    { tag: [tags.punctuation, tags.special(tags.string)], color: "var(--syn-punctuation)" },
    // Directives, anchors, aliases and tags. A workflow refuses each of them.
    {
      tag: [tags.keyword, tags.attributeValue, tags.meta, tags.labelName, tags.typeName],
      color: "var(--syn-meta)",
    },
  ]),
);

/** A wavy line under the text of a problem, in the hue of its severity. */
const buildUnderline = (colour: string) => ({
  backgroundImage: "none",
  textDecoration: `underline wavy ${colour} 1px`,
  textUnderlineOffset: "3px",
  textDecorationSkipInk: "none",
});

/** The padding of a popup, and the padding of a row in it, as in the app's menus. */
const POPUP_PADDING = "6px";
const ROW_PADDING = { block: "5px", inline: "8px" };

/**
 * A 6px dot before the message of a problem, in the hue of its severity, on
 * the middle of the message's first line. Colour appears at dot scale only,
 * so the message itself stays in ink.
 */
const buildSeverityDot = (colour: string) => ({
  content: '""',
  position: "absolute",
  left: ROW_PADDING.inline,
  top: `calc(${ROW_PADDING.block} + (1.5em - 6px) / 2)`,
  width: "6px",
  height: "6px",
  borderRadius: "50%",
  backgroundColor: colour,
});

/**
 * How far the completion list moves to the left, so that the labels of its
 * rows start where the text that the author typed starts: the list's border,
 * its padding, and the padding of a row.
 */
const COMPLETION_LABEL_INSET = `calc(-1px - ${POPUP_PADDING} - ${ROW_PADDING.inline})`;

export const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--ink)",
    backgroundColor: "var(--raised)",
    fontSize: "var(--text-meta)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "20px" },
  ".cm-content": { padding: "12px 0", caretColor: "var(--ink)" },
  ".cm-line": { padding: "0 16px 0 12px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ink)" },

  ".cm-gutters": { backgroundColor: "var(--raised)", color: "var(--faint)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "28px",
    padding: "0 4px 0 16px",
    fontVariantNumeric: "tabular-nums",
  },
  // The line of the cursor shows only while the author writes in the editor.
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "transparent" },
  "&.cm-focused .cm-activeLine": { backgroundColor: "var(--line-soft)" },
  "&.cm-focused .cm-activeLineGutter": { color: "var(--muted)" },
  "& .cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "color-mix(in oklch, var(--ink) 14%, transparent)" },

  // A character that is not seen, such as a stray carriage return or a line
  // separator, shows as a sign in the hue of a failure, because the author
  // most likely did not mean to write it.
  ".cm-specialChar": { color: "var(--fail)" },

  ".cm-lintRange-error": buildUnderline("var(--fail)"),
  ".cm-lintRange-warning": buildUnderline("var(--attn)"),
  ".cm-lintRange-active": { backgroundColor: "var(--line-soft)" },
  ".cm-lintPoint-error:after": { borderBottomColor: "var(--fail)" },
  ".cm-lintPoint-warning:after": { borderBottomColor: "var(--attn)" },

  ".cm-tooltip": {
    color: "var(--ink)",
    backgroundColor: "var(--raised)",
    border: "1px solid var(--line)",
    borderRadius: "var(--radius-card)",
    boxShadow: "var(--lift-shadow)",
    overflow: "hidden",
  },
  ".cm-tooltip-lint": { maxWidth: "420px", padding: POPUP_PADDING },
  ".cm-diagnostic": {
    position: "relative",
    padding: `${ROW_PADDING.block} ${ROW_PADDING.inline} ${ROW_PADDING.block} calc(${ROW_PADDING.inline} * 2 + 6px)`,
    border: "none",
    borderRadius: "var(--radius-control)",
    fontFamily: "var(--sans)",
    fontSize: "var(--text-meta)",
    lineHeight: "1.5",
  },
  ".cm-diagnostic-error::before": buildSeverityDot("var(--fail)"),
  ".cm-diagnostic-warning::before": buildSeverityDot("var(--attn)"),

  ".cm-tooltip.cm-tooltip-autocomplete": { marginLeft: COMPLETION_LABEL_INSET },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    minWidth: "200px",
    maxHeight: "240px",
    padding: POPUP_PADDING,
    fontFamily: "var(--mono)",
    fontSize: "var(--text-meta)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    padding: `${ROW_PADDING.block} ${ROW_PADDING.inline}`,
    borderRadius: "var(--radius-control)",
    lineHeight: "1.5",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--line-soft)",
    color: "var(--ink)",
  },
  ".cm-completionLabel": { color: "var(--ink)" },
  ".cm-completionMatchedText": { textDecoration: "none", fontWeight: "var(--w-emph)" },
  ".cm-completionDetail": {
    marginLeft: ROW_PADDING.inline,
    fontFamily: "var(--sans)",
    fontSize: "var(--text-fine)",
    fontStyle: "normal",
    color: "var(--muted)",
  },
});
