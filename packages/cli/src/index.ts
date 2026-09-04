/**
 * The CLI role: every API-facing verb, spoken over HTTP only.
 *
 * `hydra <entity> <verb>` is the operation id `<entity>.<verb>`; the whole
 * command tree is derived from the contract, so this file routes and reports
 * and holds no list of commands.
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
import { parseArguments } from "./commands/args";
import { execute } from "./commands/execute";
import { commandHelp, entityHelp, rootHelp } from "./commands/help";
import { renderHuman } from "./commands/render";
import { commandFor, ENTITIES, verbsOf, type Command } from "./commands/tree";
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
 * it. Nothing was sent, so this is a usage error and not an API failure: the
 * value of a flag - a `--<field>` carrying JSON is the way to get here - does
 * not fit the field it is written into.
 *
 * The issue's path is the field's path inside the payload, so its head is the
 * flag's own name.
 */
const usageErrorOf = (error: RequestError, command: Command): UsageError => {
  const flags = new Set([...command.payload, ...command.query].map((field) => field.name));
  const said = error.issues.map((issue) => {
    const head = issue.path[0];
    return head !== undefined && flags.has(head) ? `--${head}: ${issue.message}` : issue.message;
  });
  return new UsageError(said.join("; "), `${command.entity} ${command.verb}`);
};

/** Run one operation: parse, resolve a credential, call, print. */
const runOperation = async (
  entity: string,
  verb: string | undefined,
  tokens: ReadonlyArray<string>,
  home: string,
  io: Io,
): Promise<number> => {
  if (verb === undefined) {
    if (wantsHelp(tokens)) {
      for (const line of entityHelp(entity)) io.out(line);
      return EXIT.ok;
    }
    throw new UsageError(
      `${entity} needs a verb: ${verbsOf(entity)
        .map((command) => command.verb)
        .join(", ")}`,
    );
  }

  const command = commandFor(entity, verb);
  if (command === undefined) {
    throw new UsageError(
      `unknown verb \`${entity} ${verb}\`; ${entity} has ${verbsOf(entity)
        .map((each) => each.verb)
        .join(", ")}`,
    );
  }

  if (wantsHelp(tokens)) {
    for (const line of commandHelp(command)) io.out(line);
    return EXIT.ok;
  }

  const args = await parseArguments(command, tokens, io.stdin);

  let url: string;
  let token: string | null = null;
  if (command.requires === "unauthenticated") {
    url = resolveUrl(home, io.env);
  } else if (command.requires === "setup-token") {
    if (args.setupToken === undefined) {
      throw new UsageError(
        `${command.id} needs --setup-token <token>; \`hydra setup-url\` prints the URL that carries it`,
        `${entity} ${verb}`,
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
    for (const line of renderHuman(outcome)) io.out(line);
  }
  return EXIT.ok;
};

/** Everything after the global options have been stripped. Returns the exit code. */
const dispatch = async (argv: readonly string[], io: Io): Promise<number> => {
  const options = parseGlobalOptions(argv);
  if (Result.isFailure(options)) {
    io.err(`hydra: ${options.failure.option}: ${options.failure.message}`);
    return EXIT.usage;
  }

  const [head, second, ...rest] = options.success.rest;
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
    const tokens = [second, ...rest].filter((token): token is string => token !== undefined);
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

  if (!ENTITIES.includes(head)) {
    throw new UsageError(`unknown command \`${head}\`; entities: ${ENTITIES.join(", ")}`);
  }

  // A flag where the verb should be is not a verb: `hydra profile --help`.
  return second === undefined || second.startsWith("-")
    ? runOperation(
        head,
        undefined,
        [second, ...rest].filter((token) => token !== undefined),
        home,
        io,
      )
    : runOperation(head, second, [...rest], home, io);
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
