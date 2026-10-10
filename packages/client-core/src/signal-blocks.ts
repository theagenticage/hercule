/**
 * A signal's blocks as plain text, for places that draw no layout, such as
 * the CLI. Every client that shows blocks as text uses this one function, so
 * the CLI and an agent's terminal never disagree about what a signal says.
 * Spec 10 §9.5 owns the blocks.
 */
import {
  KNOWN_BLOCK_TYPES,
  type Block,
  type ChangeBlock,
  type CheckRow,
  type ChecksBlock,
  type KnownBlock,
  type MessagesBlock,
  type Person,
  type ThreadMessage,
} from "@hercule/contract";

/**
 * The line shown in place of a block of a type this client does not know,
 * such as one from a newer controller. The line tells the reader that a part
 * was left out, rather than hiding it.
 */
export const UNKNOWN_BLOCK_TEXT = "This part can't be shown here.";

/**
 * Checks whether a block is of a type this version of the contract knows. A
 * decoded block whose type is known always fits that type's schema, because
 * the contract never reads a known type as an unknown block.
 */
const isKnownBlock = (block: Block): block is KnownBlock =>
  (KNOWN_BLOCK_TYPES as ReadonlyArray<string>).includes(block.type);

/** Returns `count` and the noun, made plural when the count is not one: "1 file", "3 files". */
const formatCount = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

/** Formats a person as their name, with their handle in brackets when they have one. */
const formatPerson = (person: Person): string =>
  person.handle === undefined ? person.name : `${person.name} (${person.handle})`;

/**
 * Returns the lines of one message: a heading with the author, the time and
 * where a review comment sits, then the mail's recipients, the text, and the
 * attachments and link when the message has them.
 */
const formatMessage = (message: ThreadMessage): ReadonlyArray<string> => {
  const { location, recipients, attachments } = message;
  const heading = [
    formatPerson(message.author),
    message.at,
    ...(location === undefined
      ? []
      : [location.line === undefined ? location.path : `${location.path}:${location.line}`]),
    ...(message.mentionsYou === true ? ["mentions you"] : []),
  ].join(" · ");
  return [
    heading,
    ...(recipients === undefined
      ? []
      : [
          `to: ${recipients.to.map(formatPerson).join(", ")}`,
          ...(recipients.cc.length === 0
            ? []
            : [`cc: ${recipients.cc.map(formatPerson).join(", ")}`]),
        ]),
    ...(message.text === "" ? [] : message.text.split("\n")),
    ...(message.truncated === true ? ["(the message is cut short here)"] : []),
    ...(attachments === undefined || attachments.length === 0
      ? []
      : [`attachments: ${attachments.map((attachment) => attachment.name).join(", ")}`]),
    ...(message.url === undefined ? [] : [message.url]),
  ];
};

/**
 * Returns the lines of a messages block: how many earlier messages were left
 * out, then each message, oldest first, with an empty line between two.
 */
const formatMessages = (block: MessagesBlock): ReadonlyArray<string> => [
  ...(block.omitted === 0 ? [] : [`${formatCount(block.omitted, "earlier message")} left out`]),
  ...block.messages.flatMap((message, index) => [
    ...(index === 0 ? [] : [""]),
    ...formatMessage(message),
  ]),
];

/**
 * Returns the lines of a change block: the branches as `from -> to`, then
 * its totals, then its checks when it has them.
 */
const formatChange = (block: ChangeBlock): ReadonlyArray<string> => [
  `${block.from} -> ${block.to}`,
  [
    formatCount(block.files, "file"),
    `+${String(block.additions)} -${String(block.deletions)}`,
    ...(block.commits === undefined ? [] : [formatCount(block.commits, "commit")]),
  ].join(", "),
  ...(block.checks === undefined
    ? []
    : [
        `checks: ${String(block.checks.passed)} passed, ${String(block.checks.failed)} failed, ${String(block.checks.pending)} pending`,
      ]),
];

/** Returns the lines of one failed or pending check: its state, name and link, then its log, indented. */
const formatCheckRow = (row: CheckRow): ReadonlyArray<string> => [
  [row.state, row.name, ...(row.url === undefined ? [] : [row.url])].join("  "),
  ...(row.log === undefined ? [] : row.log.split("\n").map((line) => `    ${line}`)),
];

/**
 * Returns the lines of a checks block: a row per failed or pending check,
 * then how many passed and how many failed or pending rows were left out.
 */
const formatChecks = (block: ChecksBlock): ReadonlyArray<string> => [
  ...block.rows.flatMap(formatCheckRow),
  [
    `${String(block.passed)} passed`,
    ...(block.omitted === 0 ? [] : [`${String(block.omitted)} more failed or pending left out`]),
  ].join(", "),
];

/** Returns the lines of one block, or the one line for a block of an unknown type. */
const formatBlock = (block: Block): ReadonlyArray<string> => {
  if (!isKnownBlock(block)) return [UNKNOWN_BLOCK_TEXT];
  switch (block.type) {
    case "text":
      return block.markdown.split("\n");
    case "messages":
      return formatMessages(block);
    case "change":
      return formatChange(block);
    case "checks":
      return formatChecks(block);
  }
};

/**
 * Formats a signal's blocks as plain text, in the order the producer gave
 * them, with an empty line between two blocks. Returns an empty string for a
 * signal with no blocks.
 *
 * A text block is its markdown, unchanged. A block of a type this client does
 * not know is the line `UNKNOWN_BLOCK_TEXT`. Nothing is shortened: every
 * limit is the producer's, and it records what it left out in the block.
 * Times are printed as the record holds them, so the text does not depend on
 * the reader's clock or time zone.
 */
export const formatBlocksAsText = (blocks: ReadonlyArray<Block>): string =>
  blocks.map((block) => formatBlock(block).join("\n")).join("\n\n");
