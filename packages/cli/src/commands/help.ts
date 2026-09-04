/**
 * `--help`, at any position, written for an agent reading it mid-task.
 *
 * Terse and exact: what the command does not say, it does not have. Static help
 * and 403s that name the missing grant are the two teaching channels, so every
 * verb's help names the grant it needs up front.
 */
import type { Requirement } from "@hydra/contract";
import { isStdinOnly, STDIN_ONLY } from "./args";
import { COMMANDS, ENTITIES, verbsOf, type Command, type Field } from "./tree";

/** The three markers are not grants, so they are rendered as prose. */
export const requirementProse = (requires: Requirement): string => {
  switch (requires) {
    case "unauthenticated":
      return "no credential needed";
    case "setup-token":
      return "the one-time setup token, given as --setup-token <token>";
    case "authenticated":
      return "any authenticated caller";
    default:
      return `grant ${requires}`;
  }
};

const placeholder = (field: Field): string => {
  if (field.choices !== undefined)
    return `<${field.choices.length <= 6 ? field.choices.join("|") : field.name}>`;
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

/** A long list of allowed values, wrapped so no line runs past 96 characters. */
const wrap = (prefix: string, words: ReadonlyArray<string>): ReadonlyArray<string> => {
  const lines: Array<string> = [];
  let line = prefix;
  for (const word of words) {
    const candidate = line === prefix ? `${line}${word}` : `${line}, ${word}`;
    if (candidate.length > 96 && line !== prefix) {
      lines.push(`${line},`);
      line = `      ${word}`;
    } else {
      line = candidate;
    }
  }
  lines.push(line);
  return lines;
};

/**
 * One flag, as two or more lines: the flag itself, then what it takes.
 *
 * `fromStdin` is false for query filters: only a payload field has a
 * `--<field>-stdin` form, because only a payload field carries content.
 */
const flagLine = (command: Command, field: Field, fromStdin: boolean): ReadonlyArray<string> => {
  const notes: Array<string> = [field.optional ? "optional" : "required"];
  if (field.repeated) notes.push("repeatable");

  const head = isStdinOnly(command.id, field.name)
    ? [
        `  --${field.name}-stdin`,
        `      ${notes.join("; ")}; read from stdin, so it is never visible in`,
        `      process lists or shell history. There is no --${field.name} flag.`,
      ]
    : [`  --${field.name} ${placeholder(field)}`, `      ${notes.join("; ")}`];

  const lines = [...head];
  if (field.choices !== undefined && field.choices.length > 6) {
    lines.push(...wrap("      one of: ", field.choices));
  }
  if (
    fromStdin &&
    field.kind === "string" &&
    !field.repeated &&
    !isStdinOnly(command.id, field.name)
  ) {
    lines.push(`      --${field.name}-stdin reads it from stdin instead`);
  }
  return lines;
};

/** `hydra <entity> <verb> --help`. */
export const commandHelp = (command: Command): ReadonlyArray<string> => {
  const positionals = command.positionals.map((field) => `<${field.name}>`).join(" ");
  const lines: Array<string> = [
    `usage: hydra ${command.entity} ${command.verb}${positionals === "" ? "" : ` ${positionals}`} [flags]`,
    "",
    `operation: ${command.id}`,
    `route:     ${command.method} ${command.path}`,
    `requires:  ${requirementProse(command.requires)}`,
  ];

  if (command.positionals.length > 0) {
    const width = Math.max(...command.positionals.map((field) => field.name.length)) + 2;
    lines.push("", "arguments:");
    for (const field of command.positionals) {
      const what =
        field.name === "id"
          ? "a canonical id, or an unambiguous tail of 8 or more characters"
          : field.choices !== undefined
            ? `one of: ${field.choices.join(", ")}`
            : "text";
      lines.push(`  ${`<${field.name}>`.padEnd(width)}  ${what}`);
    }
  }

  const flags = [
    ...command.payload.map((field) => flagLine(command, field, true)),
    ...command.query.map((field) => flagLine(command, field, false)),
  ].flat();
  if (flags.length > 0) lines.push("", "flags:", ...flags);

  // With one field on stdin, stdin is the value. With more than one, it is one
  // line each, and the order is the order the flags are listed above.
  const onStdin = STDIN_ONLY.get(command.id) ?? [];
  if (onStdin.length > 1) {
    lines.push(
      "",
      "stdin:",
      `  ${onStdin.length} lines, one per field, in this order: ${onStdin.join(", then ")}.`,
      "  The order of the --*-stdin flags on the command line does not change it.",
      `  e.g. printf '%s\\n%s\\n' "$OLD" "$NEW" | hydra ${command.entity} ${command.verb} ${onStdin
        .map((name) => `--${name}-stdin`)
        .join(" ")}`,
    );
  }

  if (command.paged) {
    lines.push(
      "",
      "paging:",
      "  --limit <number>   page size, 1 to 500; the default is 50",
      "  --cursor <cursor>  the nextCursor of a previous page",
      "  --sort <field>[:asc|desc]",
      `                     sortable: ${command.sortFields.join(", ")}`,
      "                     omit the direction to keep this operation's own default order",
      "  --all              follow nextCursor to the end and print every item",
    );
  }

  if (command.requires === "setup-token") {
    lines.push("", "  --setup-token <token>  required; from <home>/setup-url");
  }

  lines.push("", "  --json  print the operation's output verbatim; ids stay canonical");

  if (command.paged || command.positionals.some((field) => field.name === "id")) {
    lines.push(
      "",
      "Without --json, ids print as their last 8 characters, which this CLI accepts back",
      "wherever an id is an argument.",
    );
  }
  return lines;
};

/** `hydra <entity> --help`. */
export const entityHelp = (entity: string): ReadonlyArray<string> => {
  const commands = verbsOf(entity);
  const width = Math.max(...commands.map((command) => command.verb.length));
  return [
    `usage: hydra ${entity} <verb> [arguments] [flags]`,
    "",
    "verbs:",
    ...commands.map(
      (command) => `  ${command.verb.padEnd(width)}  ${requirementProse(command.requires)}`,
    ),
    "",
    `run \`hydra ${entity} <verb> --help\` for arguments and flags.`,
  ];
};

/** `hydra --help`. */
export const rootHelp = (): ReadonlyArray<string> => {
  const width = Math.max(...ENTITIES.map((entity) => entity.length));
  return [
    "hydra - the command line for a Hydra controller.",
    "",
    "usage: hydra <entity> <verb> [arguments] [flags]",
    "",
    "Every command is one API operation: `hydra <entity> <verb>` is the operation id",
    "`<entity>.<verb>`, spelled exactly as the contract spells it. There are no aliases.",
    "",
    "entities:",
    ...ENTITIES.map(
      (entity) =>
        `  ${entity.padEnd(width)}  ${COMMANDS.filter((command) => command.entity === entity)
          .map((command) => command.verb)
          .join(", ")}`,
    ),
    "",
    "other commands:",
    "  login <url>  log in with a password and store an API key in <home>/credentials.json",
    "  setup-url    print the one-time setup URL this machine's controller wrote",
    "  serve        run the controller; `hydra runner` runs a runner",
    "",
    "global flags:",
    "  --home <dir>   the Hydra Home; defaults to $HYDRA_HOME, then ~/.hydra",
    "  -c key=value   override a bootstrap config key",
    "  --json         print output, or the error envelope, verbatim",
    "  --help         this help; works at any position on any command",
    "",
    "credential:",
    "  HYDRA_TOKEN with HYDRA_API_URL, else <home>/credentials.json from `hydra login`.",
    "  With HYDRA_SESSION=1 the file is refused outright: the environment token or nothing.",
    "",
    "exit codes:",
    "  0  the operation succeeded",
    "  1  the controller returned an error envelope",
    "  2  the command line was wrong; nothing was sent",
    "  3  no credential, no setup URL, or the controller could not be reached",
  ];
};
