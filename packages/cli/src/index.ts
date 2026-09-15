/**
 * The CLI role: every API-facing verb, spoken over HTTP only.
 *
 * The command tree is the contract's CLI table, so this file walks words,
 * routes and reports, and holds no list of commands.
 *
 * `setup-url` is the one exception and always will be: it is a filesystem read
 * of `<home>/setup-url`, needing no credential, because it is what a user has
 * before they have any credential at all.
 *
 * No Effect code lives past this package's own use of `@hydra/home`: the CLI
 * talks to the API through `client-core`'s promises.
 */
import { readFileSync } from "node:fs";
import { ApiError, ConnectionError, RequestError, createClient } from "@hydra/client-core";
import { parseGlobalOptions, resolveHomePath, setupUrlFileIn } from "@hydra/home";
import { Result } from "effect";
import { parseArguments, said } from "./commands/args";
import { execute } from "./commands/execute";
import { commandHelp, nounHelp, rootHelp, shellExample } from "./commands/help";
import { renderHuman } from "./commands/render";
import { commandAt, wordsAfter, type Command } from "./commands/tree";
import { CredentialError, resolveCredential, resolveUrl, type Env } from "./credentials";
import { EXIT, UsageError } from "./exit";
import { login, loginHelp } from "./login";
import { processIo, type Io } from "./io";

/** What `hydra setup-url` prints, or the reason there is nothing to print. */
export function readSetupUrl(argv: readonly string[], env: Env): Result.Result<string, string> {
  const options = parseGlobalOptions(argv);
  if (Result.isFailure(options)) {
    return Result.fail(`${options.failure.option}: ${options.failure.message}`);
  }
  const file = setupUrlFileIn(resolveHomePath(options.success.home, env));
  try {
    return Result.succeed(readFileSync(file, "utf8").trim());
  } catch {
    // The controller deletes the file the moment setup completes, so an absent
    // file is one of two ordinary states, never a crash.
    return Result.fail(
      `No setup URL in ${file}: either setup is already complete, or \`hydra serve\` has not run yet.`,
    );
  }
}

const wantsHelp = (tokens: ReadonlyArray<string>): boolean =>
  tokens.includes("--help") || tokens.includes("-h");

/**
 * A request the client refused to encode, said as the command line that caused
 * it. Nothing was sent, so this is a usage error and not an API failure: a
 * value - a `--<flag>` carrying JSON, a document piped in - does not fit the
 * field it was written into.
 *
 * The issue's path is the field's path inside the request, so its head names a
 * field of this command, and each is named the way the caller wrote it.
 */
const usageErrorOf = (error: RequestError, command: Command): UsageError => {
  const named = new Map(
    [...command.positionals, ...command.payload, ...command.query].map((field) => [
      field.name,
      said(field),
    ]),
  );
  const refused = error.issues.map((issue) => {
    const label = issue.path[0] === undefined ? undefined : named.get(issue.path[0]);
    return label === undefined ? issue.message : `${label}: ${issue.message}`;
  });
  return new UsageError(refused.join("; "), command.words.join(" "));
};

/**
 * What reads stdin, or the refusal that stands in for it at a terminal.
 *
 * A command whose field is read from stdin must never sit there looking stopped
 * with a cursor blinking: it names the fields it wants and shows the line the
 * caller just wrote, with the pipe it was missing. The refusal is the read
 * itself, so a command that would not have read anything is unaffected.
 */
const stdinOf = (
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
      [asked, ...shellExample(command, tokens, names.map((name) => `<${name}>`).join("\n"))].join(
        "\n",
      ),
      command.words.join(" "),
    );
  };
};

/** Run one operation: parse, resolve a credential, call, print. */
const runOperation = async (
  command: Command,
  tokens: ReadonlyArray<string>,
  home: string,
  io: Io,
): Promise<number> => {
  const args = await parseArguments(command, tokens, stdinOf(command, tokens, io));

  let url: string;
  let token: string | null = null;
  if (command.requires === "unauthenticated") {
    url = resolveUrl(home, io.env);
  } else if (command.requires === "setup-token") {
    if (args.setupToken === undefined) {
      throw new UsageError(
        `${command.id} needs --setup-token <token>; \`hydra setup-url\` prints the URL that carries it`,
        command.words.join(" "),
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
    throw error instanceof RequestError ? usageErrorOf(error, command) : error;
  });

  if (args.json) {
    const value = outcome.kind === "items" ? { items: outcome.items } : outcome.value;
    io.out(JSON.stringify(value, null, 2));
  } else {
    for (const line of renderHuman(outcome, command)) io.out(line);
  }
  return EXIT.ok;
};

/**
 * Where the command's words end and its arguments begin.
 *
 * The longest run of leading words the tree answers to is the command; what is
 * left is its arguments. A run the tree does not answer to is a mistake, and
 * what the tree does answer to at that position is the whole of the help a
 * misspelling needs.
 */
const walk = (
  words: ReadonlyArray<string>,
): { readonly command: Command; readonly taken: number } | { readonly prefix: number } => {
  for (let taken = words.length; taken > 0; taken -= 1) {
    const command = commandAt(words.slice(0, taken));
    if (command !== undefined) return { command, taken };
  }
  let prefix = 0;
  while (prefix < words.length && wordsAfter(words.slice(0, prefix + 1)).length > 0) prefix += 1;
  return { prefix };
};

/** Everything after the global options have been stripped. Returns the exit code. */
const dispatch = async (argv: readonly string[], io: Io): Promise<number> => {
  const options = parseGlobalOptions(argv);
  if (Result.isFailure(options)) {
    io.err(`hydra: ${options.failure.option}: ${options.failure.message}`);
    return EXIT.usage;
  }

  const [head, ...after] = options.success.rest;
  const home = resolveHomePath(options.success.home, io.env);

  if (head === undefined) {
    for (const line of rootHelp()) io.out(line);
    return EXIT.ok;
  }

  if (head === "--help" || head === "-h") {
    for (const line of rootHelp()) io.out(line);
    return EXIT.ok;
  }

  if (head === "setup-url") {
    if (wantsHelp(options.success.rest)) {
      io.out("usage: hydra setup-url");
      io.out("");
      io.out("Prints the one-time setup URL this machine's controller wrote, or says why");
      io.out("there is none. Needs no credential: it is a read of <home>/setup-url.");
      return EXIT.ok;
    }
    const url = readSetupUrl(argv, io.env);
    if (Result.isFailure(url)) {
      // Nothing was sent, so this is not an API failure. It is the same class as
      // a missing credential: the local file this command needs is not there.
      io.err(`hydra: ${url.failure}`);
      return EXIT.connection;
    }
    io.out(url.success);
    return EXIT.ok;
  }

  if (head === "login") {
    const tokens = after;
    if (wantsHelp(tokens)) {
      for (const line of loginHelp()) io.out(line);
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

  // The command's words are the leading tokens before any flag: `--help` and a
  // flag's value never name a word of the tree.
  const rest = options.success.rest;
  const flag = rest.findIndex((token) => token.startsWith("-"));
  const words = flag === -1 ? rest : rest.slice(0, flag);
  if (words.length === 0) {
    throw new UsageError(`unknown command \`${head}\`; there is ${wordsAfter([]).join(", ")}`);
  }
  const found = walk(words);

  if ("command" in found) {
    const tokens = rest.slice(found.taken);
    if (wantsHelp(tokens)) {
      for (const line of commandHelp(found.command)) io.out(line);
      return EXIT.ok;
    }
    return runOperation(found.command, tokens, home, io);
  }

  const valid = wordsAfter(words.slice(0, found.prefix));
  if (found.prefix === words.length) {
    if (wantsHelp(rest)) {
      for (const line of nounHelp(words)) io.out(line);
      return EXIT.ok;
    }
    throw new UsageError(`${words.join(" ")} needs a verb: ${valid.join(", ")}`, words.join(" "));
  }

  const unknown = words[found.prefix]!;
  const under = words.slice(0, found.prefix).join(" ");
  throw new UsageError(
    `unknown command \`${unknown}\`; ${under === "" ? "" : `under \`${under}\` `}there is ${valid.join(", ")}`,
    under === "" ? undefined : under,
  );
};

/**
 * What an error envelope said about the parameters it refused, one line each.
 *
 * A `validation` message is deliberately generic - "the request is not valid" -
 * because the detail is in the issues, and a human rendering that printed only
 * the message told the caller nothing it could act on.
 */
const refusals = (error: ApiError): ReadonlyArray<string> => {
  const issues = (error.details as { issues?: unknown } | undefined)?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.map((issue) => {
    const { path, message } = issue as { path?: ReadonlyArray<string>; message?: string };
    const where = path === undefined || path.length === 0 ? undefined : path.join(".");
    return where === undefined ? String(message) : `${where}: ${String(message)}`;
  });
};

/** Turn whatever went wrong into a message and an exit code. */
const report = (error: unknown, json: boolean, io: Io): number => {
  if (error instanceof UsageError) {
    io.err(`hydra: ${error.message}`);
    io.err(error.help === undefined ? "run `hydra --help`" : `run \`hydra ${error.help} --help\``);
    return EXIT.usage;
  }
  if (error instanceof CredentialError) {
    io.err(`hydra: ${error.message}`);
    return EXIT.connection;
  }
  if (error instanceof ConnectionError) {
    // There is no envelope: nothing answered. `--json` gets the same line.
    io.err(`hydra: ${error.message}`);
    return EXIT.connection;
  }
  if (error instanceof ApiError) {
    if (json) {
      io.err(JSON.stringify(error, null, 2));
    } else {
      io.err(`hydra: ${error.message}`);
      const grant = (error.details as { grant?: unknown } | undefined)?.grant;
      if (typeof grant === "string" && !error.message.includes(grant)) {
        io.err(`missing grant ${grant}`);
      }
      // A validation envelope says which parameter it refused and why, and
      // without this the human rendering printed only "the request is not
      // valid" - true, and no help at all.
      for (const line of refusals(error)) io.err(line);
    }
    return EXIT.api;
  }
  throw error;
};

/** The CLI, as a function of its arguments and its world. Returns the exit code. */
export const main = async (argv: readonly string[], io: Io): Promise<number> => {
  try {
    return await dispatch(argv, io);
  } catch (error) {
    return report(error, argv.includes("--json"), io);
  }
};

export async function run(argv: readonly string[]): Promise<void> {
  process.exitCode = await main(argv, processIo);
}
