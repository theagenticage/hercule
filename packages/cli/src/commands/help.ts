/**
 * Builds `--help` output at every level, written for an agent reading it in
 * the middle of a task.
 *
 * There are three levels, each built from the contract's CLI table and the
 * operation's schemas:
 *
 * - the root lists the nouns, and the conventions that apply everywhere;
 * - a noun lists its verbs;
 * - a command says what it does, shows a working example, then describes
 *   every argument, what it returns and what each error means.
 *
 * The sections are always the same and in the same order, so a reader can
 * skip to the one it wants.
 *
 * Help text and 403 errors that name the missing grant are the two ways a
 * caller learns about grants, so every help page names the grant a command
 * needs.
 */
import {
  NOUNS,
  type ErrorCode,
  type Grant,
  type NounRow,
  type Requirement,
} from "@hercule/contract";
import { COMMANDS, listCommandsUnder, findMentions, type Command, type Field } from "./tree";

/** The maximum line width before a line is wrapped. */
const WIDTH = 94;

/**
 * Returns the grant an operation needs, or `undefined` for one of the three
 * requirements that are not grants.
 */
const findRequiredGrant = (requires: Requirement): Grant | undefined =>
  requires === "unauthenticated" || requires === "setup-token" || requires === "authenticated"
    ? undefined
    : requires;

/**
 * Returns a requirement as text. The three requirements that are not grants are
 * described in words.
 */
const describeRequirement = (requires: Requirement): string => {
  const grant = findRequiredGrant(requires);
  if (grant !== undefined) return `grant ${grant}`;
  switch (requires) {
    case "setup-token":
      return "the one-time setup token, as --setup-token <token>";
    case "authenticated":
      return "any authenticated caller";
    // Only "unauthenticated" is left: a grant returned above.
    default:
      return "no credential needed";
  }
};

/**
 * Splits text into the units a line may break between: words, except that a
 * code span in backticks stays one unit, so a command a reader may copy is
 * never split across two lines.
 */
const splitIntoBreakableUnits = (text: string): ReadonlyArray<string> => {
  const units: Array<string> = [];
  let inCode = false;
  for (const word of text.split(/\s+/).filter((each) => each !== "")) {
    if (inCode) units[units.length - 1] += ` ${word}`;
    else units.push(word);
    if ((word.split("`").length - 1) % 2 === 1) inCode = !inCode;
  }
  return units;
};

/** Returns the length of a line made of the indent and the units joined by spaces. */
const measureLine = (indent: string, units: ReadonlyArray<string>): number =>
  indent.length + units.join(" ").length;

/**
 * Wraps one paragraph at spaces so no line is longer than the width, and
 * returns the lines, each starting with the indent. A code span longer than a
 * line is the one exception: it stays whole and runs past the width.
 *
 * The last line never holds a single word when the line before it can spare
 * one: a lone word at the end of a paragraph reads as if it were left over. A
 * code span with spaces in it is long enough to stand on its own line.
 */
const wrapParagraph = (text: string, indent: string): ReadonlyArray<string> => {
  const lines: Array<Array<string>> = [];
  let line: Array<string> = [];
  for (const unit of splitIntoBreakableUnits(text)) {
    if (line.length > 0 && measureLine(indent, [...line, unit]) > WIDTH) {
      lines.push(line);
      line = [unit];
    } else {
      line.push(unit);
    }
  }
  if (line.length > 0) lines.push(line);

  const last = lines.at(-1);
  const before = lines.at(-2);
  if (
    last !== undefined &&
    before !== undefined &&
    last.length === 1 &&
    !last[0]!.includes(" ") &&
    before.length > 1 &&
    measureLine(indent, [before.at(-1)!, ...last]) <= WIDTH
  ) {
    last.unshift(before.pop()!);
  }
  return lines.map((units) => `${indent}${units.join(" ")}`);
};

/** Formats a label and its text, indenting wrapped lines of the text past the label. */
const formatLabelledText = (label: string, width: number, text: string): ReadonlyArray<string> => {
  const indent = " ".repeat(width + 4);
  const [first = "", ...rest] = wrapParagraph(text, indent);
  // With no text, the label stands alone, with no padding after it.
  return [`  ${label.padEnd(width)}  ${first.trimStart()}`.trimEnd(), ...rest];
};

/**
 * Returns the text up to and including the first `.`, `!` or `?` that ends a
 * sentence, or the whole text when there is none.
 */
const extractFirstSentence = (text: string): string => /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;

/** Quotes a shell argument, but only when a shell would need quotes. */
const quoteShellArg = (text: string): string => {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return text.includes('"') ? `'${text}'` : `"${text}"`;
};

/**
 * Returns one command invocation as lines a reader can paste. Used by the help
 * examples, and by the error shown when a command would read stdin from a
 * terminal. The stdin value decides the form:
 *
 * - a one-line value is piped in with `echo`;
 * - a value with a newline needs a heredoc. Its body and terminator stay at
 *   the left margin, because a shell takes the body literally and ends it
 *   only on a line that is exactly `EOF`.
 */
export const buildShellExample = (
  command: Command,
  args: ReadonlyArray<string>,
  stdin: string | undefined,
): ReadonlyArray<string> => {
  const invocation = ["hercule", ...command.words, ...args.map(quoteShellArg)].join(" ");
  if (stdin === undefined) return [`  ${invocation}`];
  if (!stdin.includes("\n")) return [`  echo ${quoteShellArg(stdin)} | ${invocation}`];
  return [`  ${invocation} <<'EOF'`, ...stdin.split("\n"), "EOF"];
};

const buildPlaceholder = (field: Field): string => {
  if (field.uploads) return "<path>";
  if (field.choices !== undefined) return `<${field.spelling}>`;
  // A field that takes a shorthand word shows `<word>`, whatever type its
  // decoded value has: `<json>` would make the reader think it needs braces.
  if (field.decodeShorthand !== undefined) return "<word>";
  switch (field.kind) {
    case "string":
      return "<text>";
    case "number":
      return "<number>";
    case "boolean":
      return "<true|false>";
    case "json":
      return "<json>";
  }
};

/**
 * What each error code means, used when the command's CLI row gives no more
 * specific meaning. A validation error on a command that writes also says that
 * nothing was written; `describeGenericError` adds that.
 */
const GENERIC: Record<ErrorCode, string> = {
  unauthenticated: "no credential, or one this operation does not accept",
  forbidden: "you lack the grant this operation needs",
  validation: "an argument does not fit its field",
  not_found: "no such record, or none this credential may see",
  conflict: "it collides with something that already exists",
  invalid_state: "the record is in a state that does not allow this",
  cap_exceeded: "a size or count cap was exceeded",
  internal: "the controller failed",
};

/**
 * Returns the generic meaning of an error code for one command. Only a command
 * that can write says "nothing was written" on a validation error: on a GET,
 * which never writes, the words would suggest that something could have been.
 */
const describeGenericError = (command: Command, code: ErrorCode): string =>
  code === "validation" && command.method !== "GET"
    ? `${GENERIC.validation}; nothing was written`
    : GENERIC[code];

/** Returns the other commands a command's help text mentions, in order of first mention. */
const listMentionedCommands = (command: Command): ReadonlyArray<string> => {
  const found: Array<string> = [];
  for (const mention of findMentions(command.help)) {
    const named = mention.command?.spelling;
    if (named === undefined || named === command.spelling || found.includes(named)) continue;
    found.push(named);
  }
  return found;
};

/** Builds the help of one command: `hercule <noun>... <verb> --help`. */
export const buildCommandHelp = (command: Command): ReadonlyArray<string> => {
  const flags = [...command.payload.filter((field) => !field.stdin), ...command.query];
  const onStdin = command.payload.filter((field) => field.stdin);
  const shape = command.positionals.map((field) => `<${field.spelling}>`).join(" ");
  const lines: Array<string> = [...wrapParagraph(command.help, "")];

  const takesFlags = flags.length > 0 || command.paged || command.requires === "setup-token";
  lines.push(
    "",
    ["usage: hercule", command.spelling, shape, takesFlags ? "[flags]" : ""]
      .filter((part) => part !== "")
      .join(" "),
  );

  lines.push("", "examples:");
  for (const example of command.examples) {
    lines.push(...buildShellExample(command, example.args, example.stdin));
  }

  if (command.positionals.length > 0) {
    const width = Math.max(...command.positionals.map((field) => field.spelling.length)) + 2;
    lines.push("", "arguments:");
    for (const field of command.positionals) {
      const closed = field.choices === undefined ? "" : ` One of: ${field.choices.join(", ")}.`;
      lines.push(...formatLabelledText(`<${field.spelling}>`, width, `${field.help}${closed}`));
    }
  }

  if (takesFlags) {
    // Collect every row before printing any, so the label column is exactly as
    // wide as the widest label shown.
    const rows: Array<{ label: string; notes: string; help?: string }> = flags.map((field) => {
      const notes = [field.optional ? "optional" : "required"];
      if (field.repeated) notes.push("repeatable");
      if (field.choices !== undefined) notes.push(`one of: ${field.choices.join(", ")}`);
      if (field.nullable) notes.push("`null` clears it");
      return {
        label: `--${field.spelling} ${buildPlaceholder(field)}`,
        notes: notes.join("; "),
        help: field.help,
      };
    });
    if (command.requires === "setup-token") {
      rows.push({
        label: "--setup-token <token>",
        notes: "required",
        help: "The one-time token `hercule setup-url` prints.",
      });
    }
    if (command.paged) {
      // A list with one sort field never offers a repeat: the API refuses a
      // field named twice, so a second --sort could only fail.
      const canRepeatSort = command.sortFields.length > 1;
      rows.push(
        { label: "--limit <number>", notes: "optional; the page size" },
        { label: "--cursor <cursor>", notes: "optional; the nextCursor of the page before" },
        {
          label: "--sort <field>[:asc|desc]",
          notes: [
            "optional",
            ...(canRepeatSort ? ["repeatable"] : []),
            `one of: ${command.sortFields.join(", ")}`,
          ].join("; "),
          help: canRepeatSort
            ? "Repeat to break ties: the first --sort orders the list, and each later one orders only the rows the ones before it leave equal. No direction means asc."
            : "No direction means asc.",
        },
        {
          label: "--all",
          notes: "optional; follow nextCursor to the end and print every item",
        },
      );
    }

    const width = Math.max(...rows.map((row) => row.label.length));
    lines.push("", "flags:");
    for (const row of rows) {
      lines.push(...formatLabelledText(row.label, width, row.notes));
      if (row.help !== undefined) lines.push(...wrapParagraph(row.help, "      "));
    }
  }

  if (onStdin.length > 0) {
    // First the field's own help, then the rule for reading it, so each is
    // said once. For a single field, "There is no --<flag> flag" gets a line of
    // its own, so wrapping can never split it.
    const one = onStdin.length === 1 ? onStdin[0]! : undefined;
    const upload = command.payload.find((field) => field.uploads);
    const rule =
      one !== undefined
        ? one.optional
          ? `Read only with --${one.spelling}-stdin: the whole of stdin, with one trailing newline removed.`
          : upload === undefined
            ? "Required, always read: the whole of stdin, with one trailing newline removed."
            : `Required, always read: the whole of stdin, with one trailing newline removed. With --${upload.spelling} it may be empty, and when stdin is a terminal it is not read and the text is empty.`
        : `${onStdin.length} lines, one per field, in this order: ${onStdin
            .map((field) => field.name)
            .join(", then ")}. The markers ${onStdin
            .map((field) => `--${field.spelling}-stdin`)
            .join(" and ")} are accepted and do not change the order.`;
    lines.push("", "stdin:");
    for (const field of onStdin) lines.push(...wrapParagraph(field.help, "  "));
    lines.push(...wrapParagraph(rule, "  "));
    if (one !== undefined) lines.push(`  There is no --${one.spelling} flag.`);
  }

  if (command.paged) {
    lines.push(
      "",
      "paging:",
      ...wrapParagraph(
        "One page at a time, in the command's default order unless --sort says otherwise. The response includes nextCursor while more pages remain; pass it back as --cursor, or use --all to follow it to the end.",
        "  ",
      ),
    );
  }

  lines.push("", "returns:");
  const { fields, items } = command.returns;
  if (items === undefined) {
    lines.push(...wrapParagraph(fields.join(", ") || "only the status", "  "));
  } else {
    // A page has an `items` field; a small fixed list is returned as a bare array.
    const said = fields.includes("items")
      ? `items[] (${items.join(", ")})`
      : `a list of (${items.join(", ")})`;
    const [head = "", ...more] = wrapParagraph(said, "  ");
    lines.push(head, ...more.map((line) => `  ${line}`));
    for (const name of fields.filter((field) => field !== "items")) lines.push(`  ${name}`);
  }

  lines.push("", "errors:");
  const width = Math.max(...command.codes.map((code) => code.length));
  const grant = findRequiredGrant(command.requires);
  for (const code of command.codes) {
    // The row's own meaning comes first: for an operation only the user may
    // call, requesting the grant cannot help, and the row says so.
    const meaning =
      command.meanings[code] ??
      (code === "forbidden" && grant !== undefined
        ? `you lack ${grant}; ask with \`hercule permission request ${grant}\``
        : describeGenericError(command, code));
    lines.push(...formatLabelledText(code, width, meaning));
  }

  const next = listMentionedCommands(command);
  if (next.length > 0) {
    lines.push("", "next:");
    for (const named of next) lines.push(`  hercule ${named}`);
  }

  lines.push(
    "",
    `operation ${command.id} · ${command.method} ${command.path} · ${describeRequirement(command.requires)}`,
  );
  return lines;
};

/** The daemon forms of `hercule runner`, which are not operations and have no CLI rows. */
const DAEMON_FORMS = [
  "daemon forms (this machine's own runner, not the fleet):",
  "  hercule runner",
  "  hercule runner --local",
  "  hercule runner join <controller-url> --token <token> [--reserved] [--no-service]",
  "  hercule runner set-controller <controller-url>",
];

/** Builds the help of a noun, or a nested noun: `hercule <noun> --help`. */
export const buildNounHelp = (prefix: ReadonlyArray<string>): ReadonlyArray<string> => {
  const noun = prefix.join(" ");
  const commands = listCommandsUnder(prefix);
  const buildUsageShape = (command: Command): string =>
    [
      ...command.words.slice(prefix.length),
      ...command.positionals.map((field) => `<${field.spelling}>`),
    ].join(" ");
  // Only a root noun has a summary; a nested noun is described by its parent.
  const noted: NounRow | undefined =
    prefix.length === 1 ? NOUNS[prefix[0] as keyof typeof NOUNS] : undefined;

  const lines: Array<string> = [`usage: hercule ${noun} <verb> [arguments] [flags]`];
  if (noted !== undefined) lines.push("", ...wrapParagraph(noted.summary, ""));
  if (noun === "runner") lines.push("", ...DAEMON_FORMS);

  const width = Math.max(...commands.map((command) => buildUsageShape(command).length));
  lines.push("", "verbs:");
  for (const command of commands) {
    lines.push(
      `  ${buildUsageShape(command).padEnd(width)}  ${describeRequirement(command.requires)}`,
    );
    lines.push(...wrapParagraph(extractFirstSentence(command.help), "      "));
  }

  if (noted?.flow !== undefined) lines.push("", "flow:", ...wrapParagraph(noted.flow, "  "));
  lines.push("", `run \`hercule ${noun} <verb> --help\` for one command's arguments and examples.`);
  return lines;
};

/** Returns every root noun in the contract's order, with its verbs and nested nouns. */
const listRootNouns = (): ReadonlyArray<{
  readonly noun: string;
  readonly verbs: ReadonlyArray<string>;
  readonly nested: ReadonlyArray<readonly [string, ReadonlyArray<string>]>;
}> => {
  const order: Array<string> = [];
  for (const command of COMMANDS) {
    if (!order.includes(command.words[0]!)) order.push(command.words[0]!);
  }
  return order.map((noun) => {
    const under = listCommandsUnder([noun]);
    const nested = new Map<string, Array<string>>();
    for (const command of under.filter((each) => each.words.length > 2)) {
      const child = command.words[1]!;
      nested.set(child, [...(nested.get(child) ?? []), command.words[2]!]);
    }
    return {
      noun,
      verbs: under.filter((each) => each.words.length === 2).map((each) => each.words[1]!),
      nested: [...nested].map(([child, verbs]) => [child, verbs] as const),
    };
  });
};

/**
 * The conventions that apply to every command, each a label and its
 * paragraphs. The exit codes are one paragraph each, so a code is never
 * separated from its meaning by a line break.
 */
const CONVENTIONS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  [
    "ids",
    [
      "An id in full, or its last eight or more characters where a command's help says a list resolves them. Human output prints the last eight; --json prints them in full.",
    ],
  ],
  ["--json", ["Prints the operation's output, or the error envelope, verbatim."]],
  [
    "stdin",
    [
      "A description, a prompt, a password, a config or a workflow's source is piped in, never passed as a flag. A required one is always read from stdin; an optional one only when its --<flag>-stdin flag is given.",
    ],
  ],
  [
    "paging",
    [
      "A list takes --limit, --cursor and --sort, and --all follows nextCursor to the end. Where a list sorts on more than one field, --sort may be repeated: each later --sort orders only the rows the ones before it leave equal.",
    ],
  ],
  [
    "exit",
    [
      "0 succeeded.",
      "1 an error envelope came back, or `hercule workflow validate` found errors.",
      "2 the command line was wrong, and nothing was sent.",
      "3 no credential, or no controller.",
      "`hercule service` works on this machine, and exits 1 when its verb failed there.",
    ],
  ],
  [
    "403",
    [
      "A forbidden envelope names the grant you lack. Ask the user for it with `hercule permission request <grant>`, unless the command's help says only the user may make the call: no grant allows that, so ask the user to run it.",
    ],
  ],
];

/** Builds the root help: `hercule --help`. */
export const buildRootHelp = (): ReadonlyArray<string> => {
  const nouns = listRootNouns();
  const width = Math.max(...nouns.map((each) => each.noun.length));
  const indent = " ".repeat(width + 4);
  const lines: Array<string> = [
    "hercule - the command line for a Hercule controller.",
    "",
    "usage: hercule <noun> <verb> [arguments] [flags]",
    "",
    "nouns:",
  ];

  for (const { noun, verbs, nested } of nouns) {
    lines.push(...formatLabelledText(noun, width, verbs.join(" ")));
    for (const [child, children] of nested) {
      lines.push(...wrapParagraph(`${child}: ${children.join(" ")}`, indent));
    }
    lines.push(...wrapParagraph(NOUNS[noun as keyof typeof NOUNS].summary, indent));
  }

  lines.push(
    "",
    "other commands:",
    ...wrapParagraph(
      "hercule login <url>, hercule setup-url, hercule service <verb>, hercule serve, and the daemon forms of hercule runner.",
      "  ",
    ),
    "",
    "conventions:",
  );
  const labelWidth = Math.max(...CONVENTIONS.map(([label]) => label.length));
  for (const [label, [first = "", ...more]] of CONVENTIONS) {
    lines.push(...formatLabelledText(label, labelWidth, first));
    for (const paragraph of more) {
      lines.push(...wrapParagraph(paragraph, " ".repeat(labelWidth + 4)));
    }
  }
  lines.push(
    "",
    "run `hercule <noun> --help` for a noun's verbs, `hercule <noun> <verb> --help` for a command.",
  );
  return lines;
};
