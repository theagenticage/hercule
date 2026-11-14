/**
 * The block of text that tells an agent about things (External Entities) at
 * the start of its prompt, and the reading of that block back out of a prompt.
 *
 * When a user starts a Thread on things, the controller appends a short
 * description of each thing after the user's words. The prompt the agent gets
 * is stored as it is, so the transcript later has only text to show. A client
 * that wants to draw the block as cards, not as a wall of text, finds it again
 * with `splitPromptContext`. Both directions live here so the prompt has one
 * spelling: the controller writes it with `appendPromptContext`, and clients
 * read it with `splitPromptContext`.
 *
 * The block looks like this, after a blank line that ends the user's words:
 *
 *     From your linked group “Show the delivery cost” (2 things)
 *     1. linear:issue:northwind/SHOP-142 · “Show the delivery cost” · In Progress · priority High · <id>
 *     2. github:pull-request:northwind/web#6244 · “Add delivery cost” · Open · priority High · <id>
 *     They share: priority High
 *     Read any of them in full: hercule entity read <id>
 *
 * Every text that came from outside Hercule (a title, a status, a field) is
 * collapsed to one line first, so none of it can start a line of its own and
 * pass for another part of the block. The typographic double quotes “ and ”
 * in it become a plain `"`, so the quotes around a title and a group label
 * always mark where the text ends, and a status can never pass for a title.
 * Every other character stays as it was written: apostrophes, plain quotes,
 * backticks and semicolons are part of what a thing says.
 */
import { flattenToOneLine } from "./agent-text";
import type { EntityFieldValue } from "./groups/external-entity";
import { MAX_CONTEXT_REFERENCES } from "./groups/session";
import { ExternalRef, isId } from "./ids";
import { Schema } from "effect";

/** The longest title written in the block, in characters. A longer title is cut and ends with an ellipsis. */
const MAX_TITLE_LENGTH = 200;

/** The longest field value written in the block, in characters. A longer value is cut and ends with an ellipsis. */
const MAX_FIELD_VALUE_LENGTH = 80;

/** The longest status written in the block, in characters. A longer status is cut and ends with an ellipsis. */
const MAX_STATUS_LENGTH = 100;

/**
 * The most characters one entry spends between its ref and its id, on the
 * title, the status and the fields together. It keeps a block of 50 things far
 * below the prompt size limit. The agent can always read a thing in full.
 */
const MAX_ENTRY_DETAIL_LENGTH = 400;

/** What marks an entry or a list of fields as cut short. */
const ELLIPSIS = "…";

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

/** One thing in the block. `title`, `status` and every field may be absent for a thing seen only through a signal. */
export interface PromptContextThing {
  readonly entityId: string;
  /** The thing's External Ref, such as `linear:issue:northwind/SHOP-142`. */
  readonly ref: string;
  readonly title?: string;
  /** The label of the thing's status, such as `In Progress`. */
  readonly status?: string;
  /** The thing's declared field values, written into its entry and compared for the share line. */
  readonly fields: readonly EntityFieldValue[];
}

/** Everything `appendPromptContext` needs to write a block. `things` holds one thing for `one`, and 2 or more for the other origins. */
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
   * The things the block names, in order. `title` is the thing's title as the
   * block wrote it (cut if it was long), for a card to show when reading the
   * live thing fails. It is absent when the thing had no title.
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

/**
 * Returns text from outside Hercule as one line, with the typographic double
 * quotes “ and ” replaced by a plain `"`, cut at `maxLength` characters with
 * an ellipsis. The block writes those two quotes itself around a title and a
 * group label, so text from outside must not hold them.
 */
const prepareExternalText = (text: string, maxLength: number): string =>
  cutWithEllipsis(flattenToOneLine(text).replace(/[“”]/g, '"'), maxLength);

/**
 * Returns a field's value as the text the prompt shows next to its label.
 * Numbers are written plainly, money as `<amount> <currency>`, an age as the
 * ISO time it counts from (an agent cannot use a relative "3d" that goes stale
 * in a transcript), and a flag as `yes` or `no`.
 */
const writeFieldValue = (field: EntityFieldValue): string => {
  switch (field.type) {
    case "text":
    case "person":
    case "enum":
      return field.text;
    case "number":
      return String(field.number);
    case "money":
      return `${String(field.amount)} ${field.currency}`;
    case "age":
      return field.since;
    case "bool":
      return field.value ? "yes" : "no";
  }
};

const writeField = (field: EntityFieldValue): string =>
  `${prepareExternalText(field.label, MAX_TITLE_LENGTH)} ${prepareExternalText(writeFieldValue(field), MAX_FIELD_VALUE_LENGTH)}`;

const hasValue = (field: EntityFieldValue): boolean =>
  flattenToOneLine(writeFieldValue(field)).length > 0;

/**
 * Returns what makes two fields the same field for the share line: the key,
 * the type, and then the ref the field points at, or else its value. Labels
 * alone never decide it, because two different fields can have the same
 * label. A text field that names another thing is compared by that thing's
 * ref, because its value is only the title and two unrelated things can have
 * the same title. The tag keeps a ref and a plain value apart, because a text
 * value may look exactly like a ref.
 */
const buildFieldIdentity = (field: EntityFieldValue): string =>
  JSON.stringify([
    field.key,
    field.type,
    ...(field.type === "text" && field.ref !== undefined
      ? ["ref", field.ref]
      : ["value", writeFieldValue(field)]),
  ]);

/**
 * Returns the title, status and fields of one thing as the parts between its
 * ref and its id. The parts add up to at most `MAX_ENTRY_DETAIL_LENGTH`
 * characters, separators included. Fields are written in order until the next
 * one would not fit, and then a single ellipsis stands for the rest.
 */
const writeEntryDetails = (thing: PromptContextThing): string[] => {
  const title = prepareExternalText(thing.title ?? "", MAX_TITLE_LENGTH);
  const status = prepareExternalText(thing.status ?? "", MAX_STATUS_LENGTH);
  const parts = [title.length > 0 ? `“${title}”` : "", status].filter((part) => part.length > 0);
  const fieldTexts = thing.fields.filter(hasValue).map(writeField);

  const fits = (text: string): boolean =>
    [...parts, text].join(PART_SEPARATOR).length <= MAX_ENTRY_DETAIL_LENGTH;
  const written: string[] = [];
  for (const text of fieldTexts) {
    const next = [...written, text].join(", ");
    if (fits(next)) {
      written.push(text);
      continue;
    }
    // Keep room for the ellipsis that replaces this field and the ones after it.
    while (written.length > 0 && !fits(`${written.join(", ")}, ${ELLIPSIS}`)) written.pop();
    written.push(ELLIPSIS);
    break;
  }
  return written.length > 0 ? [...parts, written.join(", ")] : parts;
};

const writeEntry = (thing: PromptContextThing, number: number): string =>
  `${String(number)}. ${[thing.ref, ...writeEntryDetails(thing), thing.entityId].join(PART_SEPARATOR)}`;

/**
 * Returns the text of the share line: the fields that at least two of the
 * things hold with the same key and type, and the same ref (or the same
 * value, for a field with no ref; see `buildFieldIdentity`). Returns `undefined` when the things share
 * nothing. Fields come in the order they first appear.
 */
const writeSharedFields = (things: readonly PromptContextThing[]): string | undefined => {
  const shared = new Map<string, { holders: Set<string>; text: string }>();
  for (const thing of things)
    for (const field of thing.fields) {
      if (!hasValue(field)) continue;
      const identity = buildFieldIdentity(field);
      const entry = shared.get(identity) ?? { holders: new Set(), text: writeField(field) };
      entry.holders.add(thing.entityId);
      shared.set(identity, entry);
    }
  const texts = [...shared.values()].filter((entry) => entry.holders.size >= 2).map((e) => e.text);
  return texts.length === 0 ? undefined : texts.join(", ");
};

const writeOriginLine = (origin: PromptContextOrigin, count: number): string => {
  switch (origin.kind) {
    case "group":
      return `From your linked group “${prepareExternalText(origin.label, MAX_TITLE_LENGTH)}” (${String(count)} things)`;
    case "selection":
      return `From your selection (${String(count)} things)`;
    case "one":
      return ONE_ORIGIN_LINE;
  }
};

/**
 * Returns the text of the block that tells an agent about things: an origin
 * line, one numbered entry per thing, a line with what the things share when
 * there is something, and a line that tells the agent how to read a thing in
 * full. The lines are joined by line feeds, with no blank line and no trailing
 * line feed.
 *
 * Each entry is `<n>. <ref> · “<title>” · <status> · <label value, ...> · <id>`.
 * A part with no text is left out, so a thing with no title has no quoted
 * part.
 *
 * - The typographic quotes “ and ” in the title, the status, the labels, the
 *   values and the group label become a plain `"`, so the closing quote of a
 *   title is always the first one.
 * - The title is cut at 200 characters, the status at 100 and each field
 *   value at 80. An ellipsis marks a cut.
 * - Everything between the ref and the id adds up to at most 400 characters.
 *   Fields are written in order until the next one would not fit, and then
 *   one `…` stands for the rest. The ref and the id always stay.
 * - The share line lists the fields that two or more things hold with the
 *   same key and type, and the same ref (or value, when there is no ref).
 *
 * The origin must match the things: one thing for `one`, and two or more for
 * `group` and `selection`. `splitPromptContext` refuses a block that does not
 * match.
 */
const formatPromptContext = (input: PromptContextInput): string => {
  const lines = [
    writeOriginLine(input.origin, input.things.length),
    ...input.things.map((thing, index) => writeEntry(thing, index + 1)),
  ];
  const shared = writeSharedFields(input.things);
  if (shared !== undefined) lines.push(`${SHARE_LINE_PREFIX}${shared}`);
  lines.push(READ_LINE);
  return lines.join("\n");
};

/** What ends the user's words and starts the block. */
const BLOCK_SEPARATOR = "\n\n";

/**
 * Returns the prompt an agent gets: the user's `words`, a blank line, and the
 * block that describes the things of `input` (see `formatPromptContext` for
 * the block's shape). When `words` is empty the prompt is only the block.
 * `splitPromptContext` takes the result apart again into the same words and
 * block.
 *
 * Words that end in line feeds are kept as they are: the blank line goes after
 * them. The caller checks the length of the result against
 * `MAX_PROMPT_LENGTH`.
 */
export const appendPromptContext = (words: string, input: PromptContextInput): string => {
  const block = formatPromptContext(input);
  return words === "" ? block : `${words}${BLOCK_SEPARATOR}${block}`;
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
 * line is not entry number `number`.
 *
 * - The line must start with its number and a valid External Ref, and end
 *   with an id.
 * - The title is read only when the part after the ref starts with an opening
 *   quote. It ends at the first closing quote, which is exact because the
 *   block's title holds no typographic quotes.
 * - The rest of the text between the ref and the id is not read.
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
  const details = idStart > refEnd ? rest.slice(refEnd + PART_SEPARATOR.length, idStart) : "";
  const titleEnd = details.indexOf("”");
  const title = details.startsWith("“") && titleEnd > 1 ? details.slice(1, titleEnd) : undefined;
  return title === undefined ? { entityId, ref } : { entityId, ref, title };
};

/**
 * Splits a prompt into the user's words and the block that tells the agent
 * about things. It never fails: a text with no block comes back as `words`
 * with no `context`.
 *
 * It finds the block only as the whole last paragraph (the text after the
 * last blank line), or as the whole text when the text is only a block. The
 * block must be exactly what `appendPromptContext` writes:
 *
 * - an origin line that announces N things;
 * - exactly N entries, numbered 1 to N, each starting with a valid External
 *   Ref and ending with an id, with no id twice;
 * - an N that is at most `MAX_CONTEXT_REFERENCES`, the most things a Thread
 *   can start on;
 * - a share line, only when N is at least 2;
 * - the read line, last.
 *
 * Anything else keeps the whole text as `words`: a wrong count, too many
 * things, a repeated id, a bad ref or id, a missing read line, or a block
 * that is not last. The match is for showing the block nicely, never for
 * trusting it: a user who types a block by hand gets it shown the same way,
 * and nothing else changes.
 *
 * `words` is the text before the blank line, without that blank line, and is
 * empty when the text is only a block.
 */
export const splitPromptContext = (
  text: string,
): { readonly words: string; readonly context?: PromptContextBlock } => {
  const blankLine = text.lastIndexOf(BLOCK_SEPARATOR);
  const block = blankLine < 0 ? text : text.slice(blankLine + BLOCK_SEPARATOR.length);
  const lines = block.split("\n");
  const count = readOriginCount(lines[0] ?? "");
  if (count === undefined || count > MAX_CONTEXT_REFERENCES) return { words: text };

  const things: PromptContextBlock["things"][number][] = [];
  for (let number = 1; number <= count; number++) {
    const thing = readEntry(lines[number] ?? "", number);
    if (thing === undefined) return { words: text };
    things.push(thing);
  }
  if (new Set(things.map((thing) => thing.entityId)).size !== things.length) return { words: text };

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
