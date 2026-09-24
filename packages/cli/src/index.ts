/**
 * The CLI role: a command for every public API operation, sent over HTTP only.
 *
 * The command tree comes from the contract's CLI table, so this file matches
 * words to commands, runs them and reports results, but holds no list of
 * commands.
 *
 * `setup-url` is the only exception, and always will be: it reads
 * `<home>/setup-url` from the filesystem and needs no credential, because it
 * is what a user has before they have any credential.
 *
 * Apart from its use of `@hercule/home`, this package writes no Effect code:
 * the CLI calls the API through `client-core`'s promises.
 */
import { readFileSync } from "node:fs";
import {
  ApiError,
  ConnectionError,
  RequestError,
  createClient,
  readValidationIssues,
} from "@hercule/client-core";
import { parseGlobalOptions, resolveHomePath, locateSetupUrlFile } from "@hercule/home";
import { Result } from "effect";
import { parseArguments, formatFieldName } from "./commands/args";
import { formatIssue, type WorkflowIssues } from "@hercule/contract";
import { execute, type Outcome } from "./commands/execute";
import { buildCommandHelp, buildNounHelp, buildRootHelp, buildShellExample } from "./commands/help";
import { renderHuman } from "./commands/render";
import { findCommandByWords, listWordsAfter, type Command } from "./commands/tree";
import { CredentialError, resolveCredential, resolveUrl, type Env } from "./credentials";
import { EXIT, UsageError } from "./exit";
import { login, getLoginHelp } from "./login";
import { processIo, type Io } from "./io";

/** Returns what `hercule setup-url` prints, or fails with the reason there is nothing to print. */
export function readSetupUrl(argv: readonly string[], env: Env): Result.Result<string, string> {
  const options = parseGlobalOptions(argv);
  if (Result.isFailure(options)) {
    return Result.fail(`${options.failure.option}: ${options.failure.message}`);
  }
  const file = locateSetupUrlFile(resolveHomePath(options.success.home, env));
  try {
    return Result.succeed(readFileSync(file, "utf8").trim());
  } catch {
    // The controller deletes the file as soon as setup completes, so a missing
    // file is a normal state, never a crash.
    return Result.fail(
      `No setup URL in ${file}: either setup is already complete, or \`hercule serve\` has not run yet.`,
    );
  }
}

const wantsHelp = (tokens: ReadonlyArray<string>): boolean =>
  tokens.includes("--help") || tokens.includes("-h");

/**
 * Converts a request the client could not encode into a usage error that
 * names the command-line argument that caused it. Nothing was sent, so this is
 * a usage error, not an API error: a value (a `--<flag>` with JSON, or a
 * document piped in) does not match the field it was given for.
 *
 * Each issue's path is the field's path inside the request, so its first
 * segment is a field of this command. The message names that field the way
 * the caller wrote it.
 */
const toUsageError = (error: RequestError, command: Command): UsageError => {
  const named = new Map(
    [...command.positionals, ...command.payload, ...command.query].map((field) => [
      field.name,
      formatFieldName(field),
    ]),
  );
  const refused = error.issues.map((issue) => {
    const label = issue.path[0] === undefined ? undefined : named.get(issue.path[0]);
    return label === undefined ? issue.message : `${label}: ${issue.message}`;
  });
  return new UsageError(refused.join("; "), command.spelling);
};

/**
 * Returns the function that reads stdin. When stdin is a terminal, the
 * function throws a usage error instead.
 *
 * A command that reads a field from stdin must never sit waiting with a
 * blinking cursor, looking stuck. Instead it names the fields it wants and
 * shows the caller's command line with the missing pipe added. The error is
 * thrown only when stdin is read, so a command that would not read stdin is
 * unaffected.
 */
const buildStdinReader = (
  command: Command,
  tokens: ReadonlyArray<string>,
  io: Io,
): (() => Promise<string>) => {
  if (!io.isTty()) return io.stdin;
  return () => {
    const fields = command.payload.filter((field) => field.stdin);
    const names = fields.map((field) => field.name);
    const asked =
      names.length === 1
        ? `${names[0]} is read from stdin, and stdin is a terminal. Pipe it in:`
        : `${names.join(" and ")} are read from stdin, and stdin is a terminal. Pipe them in:`;
    throw new UsageError(
      [
        asked,
        ...buildShellExample(command, tokens, names.map((name) => `<${name}>`).join("\n")),
      ].join("\n"),
      command.spelling,
    );
  };
};

/**
 * Runs one operation: parses the arguments, resolves a credential, calls the
 * API and prints the result. Returns the exit code.
 */
const runOperation = async (
  command: Command,
  tokens: ReadonlyArray<string>,
  home: string,
  io: Io,
): Promise<number> => {
  const args = await parseArguments(command, tokens, buildStdinReader(command, tokens, io));

  let url: string;
  let token: string | null = null;
  if (command.requires === "unauthenticated") {
    url = resolveUrl(home, io.env);
  } else if (command.requires === "setup-token") {
    if (args.setupToken === undefined) {
      throw new UsageError(
        `${command.id} needs --setup-token <token>; \`hercule setup-url\` prints the URL that carries it`,
        command.spelling,
      );
    }
    url = resolveUrl(home, io.env);
    token = args.setupToken;
  } else {
    const credential = resolveCredential(home, io.env);
    url = credential.url;
    token = credential.token;
  }

  const client = createClient({ baseUrl: url, token, fetch: io.fetch });
  const outcome = await execute(client, command, args).catch((error: unknown) => {
    throw error instanceof RequestError ? toUsageError(error, command) : error;
  });

  if (args.json) {
    const value = outcome.kind === "items" ? { items: outcome.items } : outcome.value;
    io.out(JSON.stringify(value, null, 2));
  } else {
    for (const line of renderHuman(outcome, command)) io.out(line);
  }
  return decideExitCode(command, outcome);
};

/**
 * Returns the exit code for an operation the controller completed. When
 * `workflow validate` finds errors, the controller still returns success, but
 * the CLI exits with the same code as a rejected save. This lets a script
 * validate a workflow and stop before saving it. Warnings alone do not block
 * a save, so they do not change the exit code.
 */
const decideExitCode = (command: Command, outcome: Outcome): number =>
  command.id === "workflow.validate" &&
  outcome.kind === "value" &&
  (outcome.value as WorkflowIssues).errors.length > 0
    ? EXIT.api
    : EXIT.ok;

/**
 * Finds where the command's words end and its arguments begin.
 *
 * The longest run of leading words that matches a command in the tree is the
 * command; the rest are its arguments. When no run matches, returns `prefix`:
 * how many leading words do match a path in the tree. The valid words at that
 * position are all the help a misspelling needs.
 */
const findLongestCommand = (
  words: ReadonlyArray<string>,
): { readonly command: Command; readonly taken: number } | { readonly prefix: number } => {
  for (let taken = words.length; taken > 0; taken -= 1) {
    const command = findCommandByWords(words.slice(0, taken));
    if (command !== undefined) return { command, taken };
  }
  let prefix = 0;
  while (prefix < words.length && listWordsAfter(words.slice(0, prefix + 1)).length > 0)
    prefix += 1;
  return { prefix };
};

/** Parses the global options and runs the command. Returns the exit code. */
const dispatch = async (argv: readonly string[], io: Io): Promise<number> => {
  const options = parseGlobalOptions(argv);
  if (Result.isFailure(options)) {
    io.err(`hercule: ${options.failure.option}: ${options.failure.message}`);
    return EXIT.usage;
  }

  const [head, ...after] = options.success.rest;
  const home = resolveHomePath(options.success.home, io.env);

  // `hercule` on its own does the same as `hercule --help`.
  if (head === undefined || head === "--help" || head === "-h") {
    for (const line of buildRootHelp()) io.out(line);
    return EXIT.ok;
  }

  if (head === "setup-url") {
    if (wantsHelp(options.success.rest)) {
      io.out("usage: hercule setup-url");
      io.out("");
      io.out("Prints the one-time setup URL this machine's controller wrote, or says why");
      io.out("there is none. Needs no credential: it reads <home>/setup-url.");
      return EXIT.ok;
    }
    const url = readSetupUrl(argv, io.env);
    if (Result.isFailure(url)) {
      // Nothing was sent, so this is not an API error. It is the same kind of
      // failure as a missing credential: a local file this command needs is
      // not there.
      io.err(`hercule: ${url.failure}`);
      return EXIT.connection;
    }
    io.out(url.success);
    return EXIT.ok;
  }

  if (head === "login") {
    const tokens = after;
    if (wantsHelp(tokens)) {
      for (const line of getLoginHelp()) io.out(line);
      return EXIT.ok;
    }
    const result = await login(tokens, home, io);
    if (result.json) {
      io.out(
        JSON.stringify({ url: result.url, apiKeyId: result.apiKeyId, name: result.name }, null, 2),
      );
    } else {
      io.out(`Wrote the API key "${result.name}" for ${result.url} to ${result.path}.`);
    }
    return EXIT.ok;
  }

  // The command's words are the leading tokens before the first flag: neither
  // `--help` nor a flag's value is ever a word of the tree.
  const rest = options.success.rest;
  const flag = rest.findIndex((token) => token.startsWith("-"));
  const words = flag === -1 ? rest : rest.slice(0, flag);
  if (words.length === 0) {
    throw new UsageError(
      `unknown command \`${head}\`; the commands are ${listWordsAfter([]).join(", ")}`,
    );
  }
  const found = findLongestCommand(words);

  if ("command" in found) {
    const tokens = rest.slice(found.taken);
    if (wantsHelp(tokens)) {
      for (const line of buildCommandHelp(found.command)) io.out(line);
      return EXIT.ok;
    }
    return runOperation(found.command, tokens, home, io);
  }

  const valid = listWordsAfter(words.slice(0, found.prefix));
  if (found.prefix === words.length) {
    if (wantsHelp(rest)) {
      for (const line of buildNounHelp(words)) io.out(line);
      return EXIT.ok;
    }
    throw new UsageError(`${words.join(" ")} needs a verb: ${valid.join(", ")}`, words.join(" "));
  }

  const unknown = words[found.prefix]!;
  const under = words.slice(0, found.prefix).join(" ");
  throw new UsageError(
    `unknown command \`${unknown}\`; the commands ${under === "" ? "" : `under \`${under}\` `}are ${valid.join(", ")}`,
    under === "" ? undefined : under,
  );
};

/**
 * Returns the issues of a `validation` error, one line each.
 *
 * A `validation` message is deliberately generic ("the request is not
 * valid"), because the details are in the issues. Printing only the message
 * would tell the caller nothing they can act on.
 */
const formatValidationIssues = (error: ApiError): ReadonlyArray<string> =>
  (readValidationIssues(error) ?? []).map(formatIssue);

/**
 * Prints an error message for any error, and returns its exit code. Rethrows an
 * error of an unknown type.
 */
const reportError = (error: unknown, json: boolean, io: Io): number => {
  if (error instanceof UsageError) {
    io.err(`hercule: ${error.message}`);
    io.err(
      error.help === undefined ? "run `hercule --help`" : `run \`hercule ${error.help} --help\``,
    );
    return EXIT.usage;
  }
  if (error instanceof CredentialError) {
    io.err(`hercule: ${error.message}`);
    return EXIT.connection;
  }
  if (error instanceof ConnectionError) {
    // There is no envelope, because nothing responded. `--json` prints the same line.
    io.err(`hercule: ${error.message}`);
    return EXIT.connection;
  }
  if (error instanceof ApiError) {
    if (json) {
      io.err(JSON.stringify(error, null, 2));
    } else {
      io.err(`hercule: ${error.message}`);
      const grant = (error.details as { grant?: unknown } | undefined)?.grant;
      if (typeof grant === "string" && !error.message.includes(grant)) {
        io.err(`missing grant ${grant}`);
      }
      // A validation envelope lists which parameter was invalid and why.
      // Without these lines the output would only say "the request is not
      // valid", which is true but no help at all.
      for (const line of formatValidationIssues(error)) io.err(line);
    }
    return EXIT.api;
  }
  throw error;
};

/** Runs the CLI with `argv` and `io`. Returns the exit code. */
export const main = async (argv: readonly string[], io: Io): Promise<number> => {
  try {
    return await dispatch(argv, io);
  } catch (error) {
    return reportError(error, argv.includes("--json"), io);
  }
};

/** Runs the CLI on the real process and sets `process.exitCode`. */
export async function run(argv: readonly string[]): Promise<void> {
  process.exitCode = await main(argv, processIo);
}
