/**
 * A prototype MCP server over Hercule's public API, for the CLI-versus-MCP
 * measurement. It speaks MCP over stdio (newline-delimited JSON-RPC) and needs
 * no MCP library.
 *
 * Every tool is derived from the CLI's command tree, which is itself derived
 * from the contract. So the MCP arm and the CLI arm of the measurement expose
 * exactly the same operations, with the same help text per field, and a call
 * is sent by the CLI's own `execute`.
 *
 * `HERCULE_MCP_MODE` picks the shape of the tool list:
 *
 * - `ops` (the default): one tool per operation, such as `task_create`.
 * - `meta`: two tools. `hercule_help` returns the list of operations, or one
 *   operation's input schema. `hercule_call` runs an operation by name.
 *
 * `HERCULE_MCP_NOUNS`, a comma-separated list, limits the `ops` list to those
 * nouns. `HERCULE_API_URL` and `HERCULE_TOKEN` name the controller and the
 * credential, as they do for the CLI.
 *
 * This is a measuring instrument, not the design: the real server would live
 * in the controller, behind the session token.
 */
import { createInterface } from "node:readline";
import { ApiError, RequestError, createClient } from "../../../../packages/client-core/src/index";
import type { SortKey } from "../../../../packages/contract/src/index";
import type { Arguments } from "../../../../packages/cli/src/commands/args";
import { execute } from "../../../../packages/cli/src/commands/execute";
import { COMMANDS, type Command, type Field } from "../../../../packages/cli/src/commands/tree";

const MODE = process.env["HERCULE_MCP_MODE"] ?? "ops";
const NOUNS = process.env["HERCULE_MCP_NOUNS"]?.split(",");
const url = process.env["HERCULE_API_URL"];
const token = process.env["HERCULE_TOKEN"];
if (url === undefined || token === undefined) {
  throw new Error("HERCULE_API_URL and HERCULE_TOKEN must be set");
}
const client = createClient({ baseUrl: url, token, fetch });

/** The operations a session has no use for: first-run setup and the user's own sign-in. */
const LEFT_OUT = new Set(["setup", "auth", "user", "api-key"]);

/** Commands the CLI runs with files on the caller's disk, which a tool call cannot name. */
const takesFiles = (command: Command): boolean =>
  [...command.positionals, ...command.payload].some(
    (field) => field.uploads || field.readsSkillFolder,
  );

const commands = COMMANDS.filter(
  (command) =>
    !LEFT_OUT.has(command.words[0]!) &&
    !takesFiles(command) &&
    (NOUNS === undefined || NOUNS.includes(command.words[0]!)),
);

const buildToolName = (command: Command): string => command.words.join("_").replaceAll("-", "_");

const byToolName = new Map(commands.map((command) => [buildToolName(command), command]));
const bySpelling = new Map(commands.map((command) => [command.spelling, command]));

/** Returns the JSON Schema of one field's value. */
const buildFieldSchema = (field: Field): Record<string, unknown> => {
  const one: Record<string, unknown> =
    field.kind === "number"
      ? { type: "number" }
      : field.kind === "boolean"
        ? { type: "boolean" }
        : field.kind === "json"
          ? {}
          : field.kind === "namedValues"
            ? { type: "object" }
            : field.choices === undefined
              ? { type: "string" }
              : { type: "string", enum: [...field.choices.values()] };
  const value = field.repeated && field.kind !== "namedValues" ? { type: "array", items: one } : one;
  return { ...value, description: field.help };
};

const listFields = (command: Command): ReadonlyArray<Field> => [
  ...command.positionals,
  ...command.payload,
  ...command.query,
];

/** Returns the JSON Schema of an operation's whole input: every field by its API name. */
const buildInputSchema = (command: Command): Record<string, unknown> => {
  const properties: Record<string, unknown> = {};
  const required: Array<string> = [];
  for (const field of listFields(command)) {
    properties[field.name] = buildFieldSchema(field);
    if (!field.optional && field.defaultText === undefined) required.push(field.name);
  }
  if (command.paged) {
    properties["limit"] = { type: "number", description: "The page size." };
    properties["cursor"] = { type: "string", description: "The nextCursor of the page before." };
    properties["all"] = {
      type: "boolean",
      description: "Follow nextCursor to the end and return every item.",
    };
    if (command.sortFields.length > 0) {
      properties["sort"] = {
        type: "array",
        description: "Sort keys, the first one ordering the list.",
        items: {
          type: "object",
          properties: {
            field: { type: "string", enum: command.sortFields },
            direction: { type: "string", enum: ["asc", "desc"] },
          },
          required: ["field"],
        },
      };
    }
  }
  return { type: "object", properties, required };
};

/** Returns the lines that tell what an operation returns, as the CLI help does. */
const describeReturns = (command: Command): string =>
  command.returns.items === undefined
    ? `Returns: ${command.returns.fields.join(", ")}`
    : `Returns: items[] (${command.returns.items.join(", ")}), nextCursor`;

const describeCommand = (command: Command): string =>
  `${command.help}\n${describeReturns(command)}`;

/** Converts a tool call's input into the arguments the CLI's `execute` takes. */
const buildArguments = (command: Command, input: Record<string, unknown>): Arguments => {
  const positionals: Array<string> = [];
  for (const field of command.positionals) {
    const value = input[field.name];
    if (value === undefined) break;
    if (Array.isArray(value)) positionals.push(...value.map(String));
    else positionals.push(String(value));
  }
  const pick = (fields: ReadonlyArray<Field>): Record<string, unknown> =>
    Object.fromEntries(
      fields.filter((field) => input[field.name] !== undefined).map((f) => [f.name, input[f.name]]),
    );
  return {
    positionals,
    payload: pick(command.payload),
    query: pick(command.query),
    limit: input["limit"] as number | undefined,
    cursor: input["cursor"] as string | undefined,
    sort: input["sort"] as ReadonlyArray<SortKey> | undefined,
    all: input["all"] === true,
    json: true,
    setupToken: undefined,
  };
};

interface ToolResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly isError?: boolean;
}

const text = (value: string, isError = false): ToolResult => ({
  content: [{ type: "text", text: value }],
  ...(isError ? { isError: true } : {}),
});

/** Runs one operation and returns its output as JSON, or the error the controller gave. */
const runCommand = async (command: Command, input: Record<string, unknown>): Promise<ToolResult> => {
  const known = new Set([...listFields(command).map((f) => f.name), "limit", "cursor", "sort", "all"]);
  const unknown = Object.keys(input).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    return text(
      `validation: ${command.spelling} has no field ${unknown.join(", ")}. Its fields are ${[...known].join(", ")}.`,
      true,
    );
  }
  try {
    const outcome = await execute(client, command, buildArguments(command, input));
    const value = outcome.kind === "value" ? outcome.value : outcome.kind === "items" ? { items: outcome.items } : outcome;
    return text(JSON.stringify(value ?? { ok: true }));
  } catch (error) {
    if (error instanceof ApiError) return text(JSON.stringify(error.toJSON()), true);
    if (error instanceof RequestError) return text(`validation: ${error.message}`, true);
    return text(error instanceof Error ? error.message : String(error), true);
  }
};

/** The `meta` mode's overview: every noun with its operations, one line each. */
const buildOverview = (): string => {
  const nouns = new Map<string, Array<string>>();
  for (const command of commands) {
    const noun = command.words[0]!;
    nouns.set(noun, [...(nouns.get(noun) ?? []), command.words.slice(1).join(" ")]);
  }
  return [
    "Operations, as `<noun> <verb>`. Call hercule_help with one operation, or with a noun, for its input.",
    ...[...nouns].map(([noun, verbs]) => `${noun}: ${verbs.join(", ")}`),
  ].join("\n");
};

const describeForHelp = (command: Command): string =>
  `${command.spelling}\n${describeCommand(command)}\nInput: ${JSON.stringify(buildInputSchema(command))}`;

const META_TOOLS = [
  {
    name: "hercule_help",
    description:
      "Lists what Hercule can do, or describes one operation. With no topic it lists every noun and its operations. With a noun such as `task` it describes each of that noun's operations in one line. With an operation such as `task create` it returns what the operation does, its input schema and what it returns.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "A noun, or an operation as `<noun> <verb>`." },
      },
    },
  },
  {
    name: "hercule_call",
    description:
      "Runs one Hercule operation and returns its output as JSON. Read the operation's input schema with hercule_help first.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", description: "The operation, as `<noun> <verb>`." },
        input: { type: "object", description: "The operation's input, by field name." },
      },
      required: ["operation"],
    },
  },
];

const runHelp = (topic: string | undefined): ToolResult => {
  if (topic === undefined || topic.trim() === "") return text(buildOverview());
  const exact = bySpelling.get(topic.trim());
  if (exact !== undefined) return text(describeForHelp(exact));
  const under = commands.filter((command) => command.words[0] === topic.trim());
  if (under.length === 0) return text(`No noun or operation is called ${topic}.\n${buildOverview()}`, true);
  return text(
    under.map((command) => `${command.spelling}: ${command.help.split(". ")[0]}.`).join("\n"),
  );
};

const listTools = (): ReadonlyArray<unknown> =>
  MODE === "meta"
    ? META_TOOLS
    : commands.map((command) => ({
        name: buildToolName(command),
        description: describeCommand(command),
        inputSchema: buildInputSchema(command),
        annotations: { readOnlyHint: command.method === "GET" },
      }));

const callTool = async (name: string, input: Record<string, unknown>): Promise<ToolResult> => {
  if (MODE === "meta") {
    if (name === "hercule_help") return runHelp(input["topic"] as string | undefined);
    if (name === "hercule_call") {
      const command = bySpelling.get(String(input["operation"]).trim());
      if (command === undefined) {
        return text(`No operation is called ${String(input["operation"])}. Call hercule_help.`, true);
      }
      return runCommand(command, (input["input"] ?? {}) as Record<string, unknown>);
    }
  }
  const command = byToolName.get(name);
  if (command === undefined) return text(`No tool is called ${name}.`, true);
  return runCommand(command, input);
};

interface Request {
  readonly id?: number | string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

const answer = (id: number | string, result: unknown): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
};

const handle = async (request: Request): Promise<void> => {
  // A message without an id is a notification, which gets no answer.
  if (request.id === undefined) return;
  switch (request.method) {
    case "initialize":
      return answer(request.id, {
        protocolVersion: request.params?.["protocolVersion"] ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "hercule", version: "0.0.0-prototype" },
      });
    case "tools/list":
      return answer(request.id, { tools: listTools() });
    case "tools/call":
      return answer(
        request.id,
        await callTool(
          String(request.params?.["name"]),
          (request.params?.["arguments"] ?? {}) as Record<string, unknown>,
        ),
      );
    case "ping":
      return answer(request.id, {});
    default:
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `no method ${request.method}` } })}\n`,
      );
  }
};

if (process.argv[2] === "--print-tools") {
  // Prints the tool list and exits, so its size can be measured without a harness.
  process.stdout.write(JSON.stringify(listTools()));
} else {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    void handle(JSON.parse(line) as Request);
  });
}
