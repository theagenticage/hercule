import type { CliRow, ObjectFlagsRow } from "@hercule/contract";
import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import { describe, expect, it } from "vitest";
import { UsageError } from "../exit";
import { parseArguments } from "./args";
import { buildCommandHelp } from "./help";
import { buildCommand } from "./tree";

/**
 * A `oneOf` row, tested on commands the test defines: a payload with one
 * field, `source`, that is one of two objects told apart by `kind`. The two
 * objects share `name`.
 */
const Source = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("plugin"),
    contributionId: Schema.String,
    connectionId: Schema.String,
    name: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("url"),
    url: Schema.String,
    name: Schema.optionalKey(Schema.String),
    token: Schema.optionalKey(Schema.String),
  }),
]);

const PLUGIN_ENTRY: ObjectFlagsRow = {
  help: "From a plugin's Connection:",
  selector: "plugin",
  fixed: { kind: "plugin" },
  flags: {
    contributionId: { flag: "plugin", help: "The plugin's contribution." },
    connectionId: { flag: "connection", help: "The Connection to act as." },
    name: { flag: "name", help: "The plugin server's name." },
  },
};

const URL_ENTRY: ObjectFlagsRow = {
  help: "By its address:",
  selector: "url",
  fixed: { kind: "url" },
  flags: {
    url: { flag: "url", help: "The server's address." },
    name: { flag: "name", help: "The address server's name." },
    token: { flag: "token", help: "The token the server expects.", stdin: true },
  },
};

/** Builds a command whose `source` field has the schema and the entries given, and an optional `enabled`. */
const buildThingCommand = (source: Schema.Top, entries: ReadonlyArray<ObjectFlagsRow>) => {
  const row: Exclude<CliRow, { readonly hidden: true }> = {
    command: "thing create",
    help: "Creates a thing.",
    examples: [{ args: ["--url", "https://sentry.example"] }],
    fields: { enabled: { flag: "enabled", help: "On or off." }, source: { oneOf: entries } },
  };
  return buildCommand(
    "mcpServer.create",
    row,
    { requires: "mcp.manage", method: "POST", path: "/things" },
    HttpApiEndpoint.post("create", "/things", {
      payload: Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean), source }),
      success: Schema.Struct({}),
    }),
  );
};

const thing = buildThingCommand(Source, [PLUGIN_ENTRY, URL_ENTRY]);

const refuseStdinRead = () => Promise.reject(new Error("stdin was read"));

describe("a field of several shapes, given on the command line", () => {
  it("sends the entry whose selector is given, with its fixed values and the shared key", async () => {
    const plugin = await parseArguments(
      thing,
      ["--name", "work", "--plugin", "sentry/sentry", "--connection", "1f3a9c2e"],
      refuseStdinRead,
    );
    expect(plugin.payload).toEqual({
      source: {
        kind: "plugin",
        contributionId: "sentry/sentry",
        connectionId: "1f3a9c2e",
        name: "work",
      },
    });

    const url = await parseArguments(
      thing,
      ["--url", "https://sentry.example", "--token-stdin", "--name", "work"],
      () => Promise.resolve("s3cret\n"),
    );
    expect(url.payload).toEqual({
      source: { kind: "url", url: "https://sentry.example", name: "work", token: "s3cret" },
    });
  });

  it("requires the keys of the picked entry only", async () => {
    await expect(
      parseArguments(thing, ["--plugin", "sentry/sentry"], refuseStdinRead),
    ).rejects.toThrow("missing required --connection");
  });

  it("refuses two selectors, before stdin is read, and says what to give", async () => {
    const refused = parseArguments(
      thing,
      ["--url", "https://sentry.example", "--plugin", "sentry/sentry", "--token-stdin"],
      refuseStdinRead,
    );
    await expect(refused).rejects.toThrow(UsageError);
    await expect(refused).rejects.toThrow(
      "--url cannot be given with --plugin: give --plugin and --connection, or --url",
    );
  });

  it("refuses a flag of the other entry, before stdin is read", async () => {
    const refused = parseArguments(
      thing,
      ["--plugin", "sentry/sentry", "--connection", "1f3a9c2e", "--token-stdin"],
      refuseStdinRead,
    );
    await expect(refused).rejects.toThrow(UsageError);
    await expect(refused).rejects.toThrow(
      "--token-stdin is for --url; it cannot be given with --plugin",
    );
  });

  it("refuses a required field when no selector is given, a shared flag alone included", async () => {
    for (const argv of [[], ["--name", "work"]]) {
      await expect(parseArguments(thing, argv, refuseStdinRead)).rejects.toThrow(
        "give --plugin and --connection, or --url",
      );
    }
  });
});

describe("a field of one shape that the request may leave out", () => {
  const optional = buildThingCommand(Schema.optionalKey(Source.members[0]), [PLUGIN_ENTRY]);

  it("sends nothing for it when no flag of it is given", async () => {
    const parsed = await parseArguments(optional, ["--enabled", "true"], refuseStdinRead);

    expect(parsed.payload).toEqual({ enabled: true });
  });

  it("sends it when its selector is given, and refuses another of its flags alone", async () => {
    const parsed = await parseArguments(
      optional,
      ["--plugin", "sentry/sentry", "--connection", "1f3a9c2e"],
      refuseStdinRead,
    );
    expect(parsed.payload).toEqual({
      source: { kind: "plugin", contributionId: "sentry/sentry", connectionId: "1f3a9c2e" },
    });

    await expect(parseArguments(optional, ["--name", "work"], refuseStdinRead)).rejects.toThrow(
      "give --plugin and --connection",
    );
  });
});

describe("the help of a field of several shapes", () => {
  it("lists the flags of each entry under its lead line, with the entry's own help", () => {
    const lines = buildCommandHelp(thing);
    expect(lines.slice(lines.indexOf("flags:"), lines.indexOf("stdin:"))).toEqual([
      "flags:",
      "  --enabled <true|false>  optional",
      "      On or off.",
      "",
      "  From a plugin's Connection:",
      "  --plugin <text>         required",
      "      The plugin's contribution.",
      "  --connection <text>     required",
      "      The Connection to act as.",
      "  --name <text>           optional",
      "      The plugin server's name.",
      "",
      "  By its address:",
      "  --url <text>            required",
      "      The server's address.",
      "  --name <text>           optional",
      "      The address server's name.",
      "  --token-stdin           optional; read from stdin",
      "",
    ]);
    expect(lines.filter((line) => line.includes("The token the server expects."))).toHaveLength(1);
  });
});

describe("a row of several shapes that the table builds wrong", () => {
  it("is refused when a key shared by two entries has a different schema in them", () => {
    const Divergent = Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("plugin"),
        contributionId: Schema.String,
        connectionId: Schema.String,
        name: Schema.optionalKey(Schema.Literals(["red", "green"])),
      }),
      Schema.Struct({
        kind: Schema.Literal("url"),
        url: Schema.String,
        name: Schema.optionalKey(Schema.String),
        token: Schema.optionalKey(Schema.String),
      }),
    ]);
    expect(() => buildThingCommand(Divergent, [PLUGIN_ENTRY, URL_ENTRY])).toThrow(
      "name has a different schema in different entries",
    );
  });

  it("is refused when an entry's selector is not one of its flags", () => {
    expect(() =>
      buildThingCommand(Source, [PLUGIN_ENTRY, { ...URL_ENTRY, selector: "address" }]),
    ).toThrow("the selector --address is not a flag of its entry");
  });
});
