/**
 * The text helpers that the markdown parser and its embedded HTML reader
 * share: character references, link and image addresses, and plain text.
 */

import { decodeNamedCharacterReference } from "decode-named-character-reference";
import type { MarkdownInline } from "./markdown-tree";

/**
 * Matches one character reference as CommonMark defines it: a decimal one of 1
 * to 7 digits, a hexadecimal one of 1 to 6 digits, or a name of at most 32
 * letters and digits.
 */
const CHARACTER_REFERENCE =
  /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{0,31}));/g;

/** The character CommonMark uses for a code point that is not a valid character. */
const REPLACEMENT_CHARACTER = "�";

/**
 * Checks whether a code point written as `&#...;` is a valid character.
 * Control characters, surrogates, noncharacters and code points past U+10FFFF
 * are not, which is the rule of the `micromark` parser behind react-markdown.
 */
const isValidCodePoint = (codePoint: number): boolean =>
  !(
    codePoint < 9 ||
    codePoint === 11 ||
    (codePoint > 13 && codePoint < 32) ||
    (codePoint > 126 && codePoint < 160) ||
    (codePoint > 0xd7ff && codePoint < 0xe000) ||
    (codePoint > 0xfdcf && codePoint < 0xfdf0) ||
    codePoint % 0x10000 >= 0xfffe ||
    codePoint > 0x10ffff
  );

/**
 * Returns `text` with its character references replaced by the characters
 * they stand for, as CommonMark requires: `AT&amp;T` becomes `AT&T`. A name
 * that does not exist, such as `&foo;`, stays as written. A number that is not
 * a valid character becomes U+FFFD.
 *
 * Only a name that matched `CHARACTER_REFERENCE` reaches
 * `decodeNamedCharacterReference`. The package's browser build decodes by
 * writing `&name;` into the `innerHTML` of a detached element, so the name must
 * never carry markup.
 */
export const decodeCharacterReferences = (text: string): string =>
  text.replace(
    CHARACTER_REFERENCE,
    (match, decimal?: string, hexadecimal?: string, name?: string) => {
      if (name !== undefined) return decodeNamedCharacterReference(name) || match;
      const codePoint = decimal !== undefined ? Number(decimal) : parseInt(hexadecimal ?? "", 16);
      return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : REPLACEMENT_CHARACTER;
    },
  );

/**
 * The text nodes whose characters the source did not write as they are: a
 * character reference (`&#36;`) or a backslash escape (`\$`). A skill chip
 * must not be built from them, because the runner reads the source and finds
 * no `$` there. The parser and the embedded HTML reader both create such
 * nodes, and every step that rebuilds a text node must keep the mark, see
 * `createTextCutFrom`.
 */
const unwrittenTexts = new WeakSet<MarkdownInline>();

/** Returns a text node for `text` that the source wrote as a character reference or an escape. */
export const createUnwrittenText = (text: string): MarkdownInline => {
  const node: MarkdownInline = { type: "text", text };
  unwrittenTexts.add(node);
  return node;
};

/** Checks whether `inline` is a text node that the source wrote as a character reference or an escape. */
export const isUnwrittenText = (inline: MarkdownInline): boolean => unwrittenTexts.has(inline);

/**
 * Returns a text node for `text`, which is cut from the text of `original`
 * (trimmed or collapsed). The result is unwritten when `original` is.
 */
export const createTextCutFrom = (original: MarkdownInline, text: string): MarkdownInline =>
  isUnwrittenText(original) ? createUnwrittenText(text) : { type: "text", text };

/** A stretch of source text: written as is, or a character reference that was decoded. */
export interface DecodedPiece {
  /** The text, with a character reference replaced by the character it stands for. */
  readonly text: string;
  /** Whether the text is a character reference in the source, so its characters are not the ones written. */
  readonly isReference: boolean;
}

/**
 * Splits `text` into the stretches written as is and the character references,
 * which are decoded as `decodeCharacterReferences` decodes them. Returns the
 * pieces in order, and none for an empty text.
 */
export const decodeCharacterReferencePieces = (text: string): DecodedPiece[] => {
  const pieces: DecodedPiece[] = [];
  let cursor = 0;
  for (const match of text.matchAll(CHARACTER_REFERENCE)) {
    if (match.index > cursor) {
      pieces.push({ text: text.slice(cursor, match.index), isReference: false });
    }
    pieces.push({ text: decodeCharacterReferences(match[0]), isReference: true });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor), isReference: false });
  return pieces;
};

/**
 * Matches what `normalizeAddress` must encode: a `%` that does not start a
 * percent-escape, and every character except ASCII letters, digits and
 * ``!#$%&'()*+,-./:;=?@_~``. The `u` flag makes a surrogate pair one match.
 */
const ADDRESS_CHARACTER_TO_ENCODE = /%(?![0-9A-Za-z]{2})|[^0-9A-Za-z!#$%&'()*+,\-./:;=?@_~]/gu;

/**
 * Returns `address` with every character that a URL should not hold
 * percent-encoded, the way `micromark-util-sanitize-uri` does for
 * react-markdown. A `%` that starts a percent-escape is kept, so an address
 * that is already encoded is not encoded twice. A lone surrogate becomes
 * U+FFFD.
 */
export const normalizeAddress = (address: string): string =>
  address.replace(ADDRESS_CHARACTER_TO_ENCODE, (character) => {
    if (character === "%") return "%25";
    const isLoneSurrogate =
      character.length === 1 && character >= "\uD800" && character <= "\uDFFF";
    return encodeURIComponent(isLoneSurrogate ? REPLACEMENT_CHARACTER : character);
  });

/** The schemes a link or an image may have besides none, the same list react-markdown allows. */
const SAFE_SCHEME = /^(https?|ircs?|mailto|xmpp)$/i;

/**
 * Checks whether a link or image address is safe to draw. It is safe when it
 * has no scheme (a relative address, a `?` or a `#` link) or when its scheme is
 * `http`, `https`, `irc`, `ircs`, `mailto` or `xmpp`. Any other scheme, such
 * as `javascript:`, is unsafe.
 *
 * This is react-markdown's `defaultUrlTransform`. It does not use `new URL`,
 * which throws on a relative address. Call it with the decoded and normalized
 * address, so that `javascript&#58;alert(1)` is caught.
 */
export const isSafeAddress = (address: string): boolean => {
  const colon = address.indexOf(":");
  const endsOfPath = [address.indexOf("/"), address.indexOf("?"), address.indexOf("#")];
  return (
    colon === -1 ||
    endsOfPath.some((end) => end !== -1 && colon > end) ||
    SAFE_SCHEME.test(address.slice(0, colon))
  );
};

/** Returns `text` without the line breaks at its end, in time linear in its length. */
export const trimTrailingNewlines = (text: string): string => {
  let end = text.length;
  while (end > 0 && text[end - 1] === "\n") end--;
  return text.slice(0, end);
};

/**
 * Returns the text that `inlines` show, without their markup. It is an image's
 * alt text. A line break is `breakText`, which is empty unless given.
 */
export const extractPlainText = (inlines: ReadonlyArray<MarkdownInline>, breakText = ""): string =>
  inlines
    .map((inline) => {
      switch (inline.type) {
        case "text":
        case "inlineCode":
          return inline.text;
        case "image":
          return inline.alt;
        case "strong":
        case "emphasis":
        case "strikethrough":
        case "link":
          return extractPlainText(inline.children, breakText);
        case "break":
          return breakText;
        case "skill":
          return `$${inline.name}`;
        case "checkbox":
        case "footnoteReference":
        case "footnoteBackReference":
          return "";
      }
    })
    .join("");

/** Returns `inlines` with each link in them replaced by its children, as a link holds no link. */
export const removeNestedLinks = (inlines: ReadonlyArray<MarkdownInline>): MarkdownInline[] =>
  inlines.flatMap((inline): MarkdownInline[] => {
    switch (inline.type) {
      case "link":
        return removeNestedLinks(inline.children);
      case "strong":
      case "emphasis":
      case "strikethrough":
        return [{ ...inline, children: removeNestedLinks(inline.children) }];
      default:
        return [inline];
    }
  });
