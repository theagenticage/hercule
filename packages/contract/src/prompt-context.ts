/**
 * The block of text that tells an agent about things (External Entities) at
 * the start of its prompt, and the reading of that block back out of a prompt.
 *
 * When a user starts a Thread on things, the controller appends a short
 * description of each thing after the user's words. The prompt the agent gets
 * is stored as it is, so the transcript later has only text to show. A client
 * that wants to draw the block as cards, not as a wall of text, finds it again
 * with `splitPromptContext`. Both directions live here so the block has one
 * spelling: the controller writes it with `formatPromptContext`, and clients
 * read it with `splitPromptContext`.
 *
 * The block looks like this, after a blank line that ends the user's words:
 *
 *     From your linked group “Show the delivery cost” (2 things)
 *     1. linear:issue:northwind/SHOP-142 · Show the delivery cost · In Progress · priority High · <id>
 *     2. github:pull-request:northwind/web#6244 · Add delivery cost · Open · priority High · <id>
 *     They share: priority High
 *     Read any of them in full: hercule entity read <id>
 *
 * Every text that came from outside Hercule (a title, a status, a field) is
 * collapsed to one line first, so none of it can start a line of its own and
 * pass for another part of the block.
 */
import { flattenToOneLine } from "./agent-text";
import { ExternalRef, isId } from "./ids";
import { Schema } from "effect";

/** The longest title written in the block, in characters. A longer title is cut and ends with an ellipsis. */
const MAX_TITLE_LENGTH = 200;

/** The longest field value written in the block, in characters. A longer value is cut and ends with an ellipsis. */
const MAX_FIELD_VALUE_LENGTH = 80;

/** What separates the parts of one entry. */
const PART_SEPARATOR = " · ";

const READ_LINE = "Read any of them in full: hercule entity read <id>";
/** The start of the line that lists what the things share. */
const SHARE_LINE_PREFIX = "They share: ";
const GROUP_ORIGIN_PATTERN = /^From your linked group “(.*)” \((\d+) things\)$/;
const SELECTION_ORIGIN_PATTERN = /^From your selection \((\d+) things\)$/;
const ONE_ORIGIN_LINE = "From your Inbox (1 thing)";

const isExternalRef = Schema.is(ExternalRef);

/**
 * Where the things came from, which decides the block's first line:
 *
 * - `group`: the things are exactly the members of one linked group in the
 *   Inbox, and `label` is the group's label. Needs at least 2 things;
 * - `selection`: 2 or more things the user picked that are not exactly one
 *   group;
 * - `one`: a single thing, from the Inbox.
 */
export type PromptContextOrigin =
  | { readonly kind: "group"; readonly label: string }
  | { readonly kind: "selection" }
  | { readonly kind: "one" };

/**
 * One declared field of a thing. `key` and `type` say which field it is, and
 * `value` is the field's text as it is shown. Two things share a field when
 * they hold the same `key`, `type` and `value`; labels alone never decide it,
 * because two different fields can have the same label.
 */
export interface PromptContextField {
  readonly key: string;
  readonly type: string;
  readonly label: string;
  readonly value: string;
}

/** One thing in the block. `title`, `status` and every field may be absent for a thing seen only through a signal. */
export interface PromptContextThing {
  readonly entityId: string;
  /** The thing's External Ref, such as `linear:issue:northwind/SHOP-142`. */
  readonly ref: string;
  readonly title?: string;
  /** The label of the thing's status, such as `In Progress`. */
  readonly status?: string;
  readonly fields: readonly PromptContextField[];
}

/** Everything `formatPromptContext` needs to write a block. `things` holds one thing for `one`, and 2 or more for the other origins. */
export interface PromptContextInput {
  readonly origin: PromptContextOrigin;
  readonly things: readonly PromptContextThing[];
}

/** A block found in a prompt by `splitPromptContext`. */
export interface PromptContextBlock {
  /** The block exactly as it was sent, lines joined by line feeds. */
  readonly text: string;
  /** How many lines `text` has. */
  readonly lineCount: number;
  /**
   * The things the block names, in order. `title` is what a card can show
   * when reading the live thing fails. It is the first part after the ref
   * and before the id, so it is the status or a field when the thing had no
   * title: use it as a fallback only.
   */
  readonly things: readonly {
    readonly entityId: string;
    readonly ref: string;
    readonly title?: string;
  }[];
}

/** Cuts text to at most `maxLength` characters, counting whole characters, and ends a cut text with an ellipsis. */
const cutWithEllipsis = (text: string, maxLength: number): string => {
  const characters = Array.from(text);
  return characters.length <= maxLength ? text : `${characters.slice(0, maxLength).join("")}…`;
};

const describeField = (field: PromptContextField): string =>
  `${flattenToOneLine(field.label)} ${cutWithEllipsis(flattenToOneLine(field.value), MAX_FIELD_VALUE_LENGTH)}`;

const writeEntry = (thing: PromptContextThing, number: number): string => {
  const title = flattenToOneLine(thing.title ?? "");
  const status = flattenToOneLine(thing.status ?? "");
  const fields = thing.fields
    .filter((field) => flattenToOneLine(field.value).length > 0)
    .map(describeField)
    .join(", ");
  const parts = [
    thing.ref,
    title.length > 0 ? cutWithEllipsis(title, MAX_TITLE_LENGTH) : "",
    status,
    fields,
    thing.entityId,
  ].filter((part) => part.length > 0);
  return `${String(number)}. ${parts.join(PART_SEPARATOR)}`;
};

/**
 * Returns the fields that at least two of the things hold with the same key,
 * type and value, written as the share line's text, or `undefined` when the
 * things share nothing. Fields come in the order they first appear.
 */
const writeSharedFields = (things: readonly PromptContextThing[]): string | undefined => {
  const shared = new Map<string, { holders: Set<string>; text: string }>();
  for (const thing of things)
    for (const field of thing.fields) {
      if (flattenToOneLine(field.value).length === 0) continue;
      const identity = JSON.stringify([field.key, field.type, field.value]);
      const entry = shared.get(identity) ?? { holders: new Set(), text: describeField(field) };
      entry.holders.add(thing.entityId);
      shared.set(identity, entry);
    }
  const texts = [...shared.values()].filter((entry) => entry.holders.size >= 2).map((e) => e.text);
  return texts.length === 0 ? undefined : texts.join(", ");
};

const writeOriginLine = (origin: PromptContextOrigin, count: number): string => {
  switch (origin.kind) {
    case "group":
      return `From your linked group “${flattenToOneLine(origin.label)}” (${String(count)} things)`;
    case "selection":
      return `From your selection (${String(count)} things)`;
    case "one":
      return ONE_ORIGIN_LINE;
  }
};

/**
 * Returns the text of the block that tells an agent about things: an origin
 * line, one numbered entry per thing, a line with what the things share when
 * there is something, and a line telling the agent how to read a thing in
 * full. The lines are joined by line feeds, with no blank line and no trailing
 * line feed.
 *
 * Each entry is `<n>. <ref> · <title> · <status> · <label value, ...> · <id>`.
 * A part with no text is left out. The title is cut at 200 characters and each
 * field value at 80, and an ellipsis marks a cut. The share line lists the
 * fields that two or more things hold with the same key, type and value.
 *
 * The caller puts the block after the user's words and a blank line. The
 * caller must pass the origin that matches the things: one thing for `one`,
 * and two or more for `group` and `selection`; `splitPromptContext` refuses a
 * block that does not match.
 */
export const formatPromptContext = (input: PromptContextInput): string => {
  const lines = [
    writeOriginLine(input.origin, input.things.length),
    ...input.things.map((thing, index) => writeEntry(thing, index + 1)),
  ];
  const shared = writeSharedFields(input.things);
  if (shared !== undefined) lines.push(`${SHARE_LINE_PREFIX}${shared}`);
  lines.push(READ_LINE);
  return lines.join("\n");
};

/** Returns how many things the origin line announces, or `undefined` when the line is not an origin line. */
const readOriginCount = (line: string): number | undefined => {
  if (line === ONE_ORIGIN_LINE) return 1;
  const count = GROUP_ORIGIN_PATTERN.exec(line)?.[2] ?? SELECTION_ORIGIN_PATTERN.exec(line)?.[1];
  const parsed = count === undefined ? undefined : Number(count);
  return parsed !== undefined && parsed >= 2 ? parsed : undefined;
};

/**
 * Reads one entry line as the thing it names, or returns `undefined` when the
 * line is not entry number `number`. The line must start with its number and a
 * valid External Ref and end with an id. Only those two ends are checked,
 * because the text between them came from outside and may hold the separator.
 */
const readEntry = (
  line: string,
  number: number,
): PromptContextBlock["things"][number] | undefined => {
  const numberPrefix = `${String(number)}. `;
  if (!line.startsWith(numberPrefix)) return undefined;
  const rest = line.slice(numberPrefix.length);
  const refEnd = rest.indexOf(PART_SEPARATOR);
  const idStart = rest.lastIndexOf(PART_SEPARATOR);
  if (refEnd < 0) return undefined;
  const ref = rest.slice(0, refEnd);
  const entityId = rest.slice(idStart + PART_SEPARATOR.length);
  if (!isExternalRef(ref) || !isId(entityId)) return undefined;
  const title =
    idStart > refEnd
      ? rest.slice(refEnd + PART_SEPARATOR.length, idStart).split(PART_SEPARATOR)[0]
      : undefined;
  return title === undefined || title.length === 0 ? { entityId, ref } : { entityId, ref, title };
};

/**
 * Splits a prompt into the user's words and the block that tells the agent
 * about things. It never fails: a text with no block comes back as `words`
 * with no `context`.
 *
 * It finds the block only as the whole last paragraph (the text after the last
 * blank line), or as the whole text when the text is only a block. The block
 * must be exactly what `formatPromptContext` writes:
 *
 * - an origin line that announces N things;
 * - exactly N entries, numbered 1 to N, each starting with a valid External
 *   Ref and ending with an id;
 * - a share line, only when N is at least 2;
 * - the read line, last.
 *
 * Anything else, such as a wrong count, a bad ref or id, a missing read line
 * or a block that is not last, keeps the whole text as `words`. The match is
 * for showing the block nicely, never for trusting it: a user who types a
 * block by hand gets it shown the same way, and nothing else changes.
 *
 * `words` is the text before the blank line, without that blank line, and is
 * empty when the text is only a block.
 */
export const splitPromptContext = (
  text: string,
): { readonly words: string; readonly context?: PromptContextBlock } => {
  const blankLine = text.lastIndexOf("\n\n");
  const block = blankLine < 0 ? text : text.slice(blankLine + 2);
  const lines = block.split("\n");
  const count = readOriginCount(lines[0] ?? "");
  if (count === undefined) return { words: text };

  const things: PromptContextBlock["things"][number][] = [];
  for (let number = 1; number <= count; number++) {
    const thing = readEntry(lines[number] ?? "", number);
    if (thing === undefined) return { words: text };
    things.push(thing);
  }

  // After the entries come an optional share line (only for 2 or more things) and the read line.
  const tail = lines.slice(count + 1);
  const shareLine = tail.length === 2 && count >= 2 ? tail[0] : undefined;
  const hasValidShareLine = shareLine?.startsWith(SHARE_LINE_PREFIX) === true;
  const tailMatches = tail.length === 1 || (tail.length === 2 && hasValidShareLine);
  if (!tailMatches || tail.at(-1) !== READ_LINE) return { words: text };

  return {
    words: blankLine < 0 ? "" : text.slice(0, blankLine),
    context: { text: block, lineCount: lines.length, things },
  };
};
