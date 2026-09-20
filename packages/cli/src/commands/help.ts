/**
 * `--help`, at any position, written for an agent reading it mid-task.
 *
 * Three levels, each rendered from the contract's CLI table and the operation's
 * schemas: the root lists the nouns and the conventions that hold everywhere, a
 * noun lists its verbs, and a command says what it does, shows a working
 * invocation, then describes every argument, what comes back and what each
 * failure means. The sections are always the same and always in the same order,
 * so a reader can skip to the one it wants.
 *
 * Static help and 403s that name the missing grant are the two teaching
 * channels, so every screen names the grant a command needs.
 */
import {
  NOUNS,
  type ErrorCode,
  type Grant,
  type NounRow,
  type Requirement,
} from "@hercule/contract";
import { COMMANDS, commandsUnder, mentionsIn, type Command, type Field } from "./tree";

/** How wide a line is allowed to be before it is wrapped. */
const WIDTH = 94;

/** The grant an operation needs, or `undefined` for one of the three markers. */
const grantOf = (requires: Requirement): Grant | undefined =>
  requires === "unauthenticated" || requires === "setup-token" || requires === "authenticated"
    ? undefined
    : requires;

/** The three markers are not grants, so they are rendered as prose. */
const requirementProse = (requires: Requirement): string => {
  const grant = grantOf(requires);
  if (grant !== undefined) return `grant ${grant}`;
  switch (requires) {
    case "setup-token":
      return "the one-time setup token, as --setup-token <token>";
    case "authenticated":
      return "any authenticated caller";
    // Only "unauthenticated" is left: a grant was answered above.
    default:
      return "no credential needed";
  }
};

/** One paragraph, broken at spaces so nothing runs past the width. */
const wrap = (text: string, indent: string): ReadonlyArray<string> => {
  const lines: Array<string> = [];
  let line = indent;
  for (const word of text.split(/\s+/).filter((each) => each !== "")) {
    const candidate = line === indent ? `${line}${word}` : `${line} ${word}`;
    if (candidate.length > WIDTH && line !== indent) {
      lines.push(line);
      line = `${indent}${word}`;
    } else {
      line = candidate;
    }
  }
  return line === indent ? lines : [...lines, line];
};

/** A label and its prose, the prose hanging under the label when it wraps. */
const labelled = (label: string, width: number, text: string): ReadonlyArray<string> => {
  const indent = " ".repeat(width + 4);
  const [first = "", ...rest] = wrap(text, indent);
  return [`  ${label.padEnd(width)}  ${first.trimStart()}`, ...rest];
};

/** What the help says before the first full stop. */
const firstSentence = (text: string): string => /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;

/** One token of a shell line, quoted only where a shell would need it. */
const shellArg = (text: string): string => {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return text.includes('"') ? `'${text}'` : `"${text}"`;
};

/**
 * One invocation as lines a reader can paste, used both by the examples and by
 * the refusal a terminal gets in place of a read. What is piped in decides the
 * shape: a one-line value goes through `echo`, and anything with a newline in
 * it needs a heredoc, whose body and terminator stay at the left margin because
 * a shell takes the body literally and ends it only on a bare `EOF`.
 */
export const shellExample = (
  command: Command,
  args: ReadonlyArray<string>,
  stdin: string | undefined,
): ReadonlyArray<string> => {
  const invocation = ["hercule", ...command.words, ...args.map(shellArg)].join(" ");
  if (stdin === undefined) return [`  ${invocation}`];
  if (!stdin.includes("\n")) return [`  echo ${shellArg(stdin)} | ${invocation}`];
  return [`  ${invocation} <<'EOF'`, ...stdin.split("\n"), "EOF"];
};

const placeholder = (field: Field): string => {
  if (field.choices !== undefined) return `<${field.spelling}>`;
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

/** What a code means when the row says nothing more particular. */
const GENERIC: Record<ErrorCode, string> = {
  unauthenticated: "no credential, or one this operation does not accept",
  forbidden: "you lack the grant this operation needs",
  validation: "an argument does not fit its field; nothing was written",
  not_found: "no such record, or none this credential may see",
  conflict: "it collides with something that already exists",
  invalid_state: "the record is in a state that does not allow this",
  cap_exceeded: "a size or count cap was exceeded",
  internal: "the controller failed",
};

/** The commands a help text names, in the order it names them, itself excluded. */
const mentioned = (command: Command): ReadonlyArray<string> => {
  const found: Array<string> = [];
  for (const mention of mentionsIn(command.help)) {
    const named = mention.command?.spelling;
    if (named === undefined || named === command.spelling || found.includes(named)) continue;
    found.push(named);
  }
  return found;
};

/** `hercule <noun>... <verb> --help`. */
export const commandHelp = (command: Command): ReadonlyArray<string> => {
  const flags = [...command.payload.filter((field) => !field.stdin), ...command.query];
  const onStdin = command.payload.filter((field) => field.stdin);
  const shape = command.positionals.map((field) => `<${field.spelling}>`).join(" ");
  const lines: Array<string> = [...wrap(command.help, "")];

  const takesFlags = flags.length > 0 || command.paged || command.requires === "setup-token";
  lines.push(
    "",
    ["usage: hercule", command.spelling, shape, takesFlags ? "[flags]" : ""]
      .filter((part) => part !== "")
      .join(" "),
  );

  lines.push("", "examples:");
  for (const example of command.examples) {
    lines.push(...shellExample(command, example.args, example.stdin));
  }

  if (command.positionals.length > 0) {
    const width = Math.max(...command.positionals.map((field) => field.spelling.length)) + 2;
    lines.push("", "arguments:");
    for (const field of command.positionals) {
      const closed = field.choices === undefined ? "" : ` One of: ${field.choices.join(", ")}.`;
      lines.push(...labelled(`<${field.spelling}>`, width, `${field.help}${closed}`));
    }
  }

  if (takesFlags) {
    // Every row is collected before any is printed, so the label column is as
    // wide as what is actually shown and no wider.
    const rows: Array<{ label: string; notes: string; help?: string }> = flags.map((field) => {
      const notes = [field.optional ? "optional" : "required"];
      if (field.repeated) notes.push("repeatable");
      if (field.choices !== undefined) notes.push(`one of: ${field.choices.join(", ")}`);
      if (field.nullable) notes.push("`null` clears it");
      return {
        label: `--${field.spelling} ${placeholder(field)}`,
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
      rows.push(
        { label: "--limit <number>", notes: "optional; the page size" },
        { label: "--cursor <cursor>", notes: "optional; the nextCursor of the page before" },
        {
          label: "--sort <field>[:asc|desc]",
          notes: `optional; one of: ${command.sortFields.join(", ")}`,
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
      lines.push(...labelled(row.label, width, row.notes));
      if (row.help !== undefined) lines.push(...wrap(row.help, "      "));
    }
  }

  if (onStdin.length > 0) {
    // The row's own line first, then the rule the CLI applies to it, so the
    // field is said once and the mechanics once. The one-field rule keeps
    // "there is no --<flag> flag" on a line of its own, where nothing can wrap
    // it in half.
    const one = onStdin.length === 1 ? onStdin[0]! : undefined;
    const rule =
      one !== undefined
        ? one.optional
          ? `Read only with --${one.spelling}-stdin: the whole of stdin, one trailing newline removed.`
          : "Required, read unasked: the whole of stdin, one trailing newline removed."
        : `${onStdin.length} lines, one per field, in this order: ${onStdin
            .map((field) => field.name)
            .join(", then ")}. The markers ${onStdin
            .map((field) => `--${field.spelling}-stdin`)
            .join(" and ")} are accepted and do not change the order.`;
    lines.push("", "stdin:");
    for (const field of onStdin) lines.push(...wrap(field.help, "  "));
    lines.push(...wrap(rule, "  "));
    if (one !== undefined) lines.push(`  There is no --${one.spelling} flag.`);
  }

  if (command.paged) {
    lines.push(
      "",
      "paging:",
      ...wrap(
        "One page at a time, newest first unless --sort says otherwise. The answer carries nextCursor while more remain; pass it back as --cursor, or let --all follow it to the end.",
        "  ",
      ),
    );
  }

  lines.push("", "returns:");
  const { fields, items } = command.returns;
  if (items === undefined) {
    lines.push(...wrap(fields.join(", ") || "nothing but the status", "  "));
  } else {
    // A page names its items; a small fixed listing answers with the bare list.
    const said = fields.includes("items")
      ? `items[] (${items.join(", ")})`
      : `a list of (${items.join(", ")})`;
    const [head = "", ...more] = wrap(said, "  ");
    lines.push(head, ...more.map((line) => `  ${line}`));
    for (const name of fields.filter((field) => field !== "items")) lines.push(`  ${name}`);
  }

  lines.push("", "errors:");
  const width = Math.max(...command.codes.map((code) => code.length));
  const grant = grantOf(command.requires);
  for (const code of command.codes) {
    const meaning =
      code === "forbidden" && grant !== undefined
        ? `you lack ${grant}; ask with \`hercule permission request ${grant}\``
        : (command.meanings[code] ?? GENERIC[code]);
    lines.push(...labelled(code, width, meaning));
  }

  const next = mentioned(command);
  if (next.length > 0) {
    lines.push("", "next:");
    for (const named of next) lines.push(`  hercule ${named}`);
  }

  lines.push(
    "",
    `operation ${command.id} · ${command.method} ${command.path} · ${requirementProse(command.requires)}`,
  );
  return lines;
};

/** The daemon forms of `hercule runner`, which are not operations and have no rows. */
const DAEMON_FORMS = [
  "daemon forms (this machine's own runner, not the fleet):",
  "  hercule runner",
  "  hercule runner --local",
  "  hercule runner join <controller-url> --token <token> [--reserved]",
  "  hercule runner set-controller <controller-url>",
];

/** `hercule <noun> --help`, and the same for a nested noun. */
export const nounHelp = (prefix: ReadonlyArray<string>): ReadonlyArray<string> => {
  const noun = prefix.join(" ");
  const commands = commandsUnder(prefix);
  const shapeOf = (command: Command): string =>
    [
      ...command.words.slice(prefix.length),
      ...command.positionals.map((field) => `<${field.spelling}>`),
    ].join(" ");
  // Only a root noun is introduced; a nested one is introduced by its parent.
  const noted: NounRow | undefined =
    prefix.length === 1 ? NOUNS[prefix[0] as keyof typeof NOUNS] : undefined;

  const lines: Array<string> = [`usage: hercule ${noun} <verb> [arguments] [flags]`];
  if (noted !== undefined) lines.push("", ...wrap(noted.summary, ""));
  if (noun === "runner") lines.push("", ...DAEMON_FORMS);

  const width = Math.max(...commands.map((command) => shapeOf(command).length));
  lines.push("", "verbs:");
  for (const command of commands) {
    lines.push(`  ${shapeOf(command).padEnd(width)}  ${requirementProse(command.requires)}`);
    lines.push(...wrap(firstSentence(command.help), "      "));
  }

  if (noted?.flow !== undefined) lines.push("", "flow:", ...wrap(noted.flow, "  "));
  lines.push("", `run \`hercule ${noun} <verb> --help\` for one command's arguments and examples.`);
  return lines;
};

/** Every noun at the root, in the contract's order, with what sits under it. */
const nounsOfTheRoot = (): ReadonlyArray<{
  readonly noun: string;
  readonly verbs: ReadonlyArray<string>;
  readonly nested: ReadonlyArray<readonly [string, ReadonlyArray<string>]>;
}> => {
  const order: Array<string> = [];
  for (const command of COMMANDS) {
    if (!order.includes(command.words[0]!)) order.push(command.words[0]!);
  }
  return order.map((noun) => {
    const under = commandsUnder([noun]);
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

/** `hercule --help`. */
export const rootHelp = (): ReadonlyArray<string> => {
  const nouns = nounsOfTheRoot();
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
    lines.push(`  ${noun.padEnd(width)}  ${verbs.join(" ")}`.trimEnd());
    for (const [child, children] of nested) {
      lines.push(`${indent}${child}: ${children.join(" ")}`);
    }
    lines.push(...wrap(NOUNS[noun as keyof typeof NOUNS].summary, indent));
  }

  lines.push(
    "",
    "other commands:",
    "  hercule login <url>, hercule setup-url, hercule serve, and the daemon forms of hercule runner.",
    "",
    "conventions:",
    "  ids       An id in full, or its last eight characters or more where a command's help",
    "            says a listing resolves them. Human output prints the last eight; --json",
    "            prints them whole.",
    "  --json    Prints the operation's output, or the error envelope, verbatim.",
    "  stdin     A description, a prompt, a password or a config is piped in, never written",
    "            as a flag. Required, it is read unasked; optional, only with its",
    "            --<flag>-stdin marker.",
    "  paging    A listing takes --limit, --cursor and --sort; --all follows nextCursor to",
    "            the end.",
    "  exit      0 succeeded, 1 the controller answered with an error envelope, 2 the command",
    "            line was wrong and nothing was sent, 3 no credential or no controller.",
    "  403       A forbidden envelope names the grant you lack. Ask the user for it with",
    "            `hercule permission request <grant>`.",
    "",
    "run `hercule <noun> --help` for a noun's verbs, `hercule <noun> <verb> --help` for one command.",
  );
  return lines;
};
