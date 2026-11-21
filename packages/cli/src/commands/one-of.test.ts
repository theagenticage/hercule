import type { CliRow, ObjectFlagsRow } from "@hercule/contract";
import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import { describe, expect, it } from "vitest";
import { UsageError } from "../exit";
import { parseArguments } from "./args";
import { buildCommandHelp } from "./help";
import { buildCommand } from "./tree";

/**
 * A `oneOf` row, tested on a command the test defines: a payload with one
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

const endpoint = HttpApiEndpoint.post("create", "/things", {
  payload: Schema.Struct({ source: Source }),
  success: Schema.Struct({}),
});

const PLUGIN_ENTRY = {
  help: "From a plugin's Connection:",
  fixed: { kind: "plugin" },
  flags: {
    contributionId: { flag: "plugin", help: "The plugin's contribution." },
    connectionId: { flag: "connection", help: "The Connection to act as." },
    name: { flag: "name", help: "The server's name." },
  },
};

const URL_ENTRY = {
  help: "By its address:",
  fixed: { kind: "url" },
  flags: {
    url: { flag: "url", help: "The server's address." },
    name: { flag: "name", help: "The server's name." },
    token: { flag: "token", help: "The token the server expects.", stdin: true },
  },
} satisfies ObjectFlagsRow & { help: string };

/** Builds the command from the entries of the `source` row. Throws when they do not fit `Source`. */
const buildThingCommand = (entries: ReadonlyArray<ObjectFlagsRow & { readonly help: string }>) => {
  const row: Exclude<CliRow, { readonly hidden: true }> = {
    command: "thing create",
    help: "Creates a thing.",
    examples: [{ args: ["--url", "https://sentry.example"] }],
    fields: { source: { oneOf: entries } },
  };
  return buildCommand(
    "mcpServer.create",
    row,
    { requires: "mcp.manage", method: "POST", path: "/things" },
    endpoint,
  );
};

const thing = buildThingCommand([PLUGIN_ENTRY, URL_ENTRY]);

const refuseStdinRead = () => Promise.reject(new Error("stdin was read"));

describe("a field of several shapes, given on the command line", () => {
  it("sends the entry whose own flags are given, with its fixed values", async () => {
    const plugin = await parseArguments(
      thing,
      ["--plugin", "sentry/sentry", "--connection", "1f3a9c2e"],
      refuseStdinRead,
    );
    expect(plugin.payload).toEqual({
      source: { kind: "plugin", contributionId: "sentry/sentry", connectionId: "1f3a9c2e" },
    });

    const url = await parseArguments(thing, ["--url", "https://sentry.example"], refuseStdinRead);
    expect(url.payload).toEqual({ source: { kind: "url", url: "https://sentry.example" } });
  });

  it("sends a flag that both entries declare in the entry that was picked", async () => {
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
      ["--url", "https://sentry.example", "--name", "work"],
      refuseStdinRead,
    );
    expect(url.payload).toEqual({
      source: { kind: "url", url: "https://sentry.example", name: "work" },
    });
  });

  it("requires the keys of the picked entry only", async () => {
    await expect(
      parseArguments(thing, ["--plugin", "sentry/sentry"], refuseStdinRead),
    ).rejects.toThrow("missing required --connection");
    await expect(
      parseArguments(thing, ["--token-stdin"], () => Promise.resolve("s3cret")),
    ).rejects.toThrow("missing required --url");
  });

  it("reads a stdin flag of the picked entry, and only when its marker is given", async () => {
    const marked = await parseArguments(
      thing,
      ["--url", "https://sentry.example", "--token-stdin"],
      () => Promise.resolve("s3cret\n"),
    );
    expect(marked.payload).toEqual({
      source: { kind: "url", url: "https://sentry.example", token: "s3cret" },
    });

    // Without the marker the pipe is not read, and the other entry has no stdin flag to read.
    const unmarked = await parseArguments(
      thing,
      ["--url", "https://sentry.example"],
      refuseStdinRead,
    );
    expect(unmarked.payload).toEqual({ source: { kind: "url", url: "https://sentry.example" } });
  });

  it("refuses the flags of two entries together, and says what to give", async () => {
    const refused = parseArguments(
      thing,
      ["--url", "https://sentry.example", "--plugin", "sentry/sentry", "--connection", "1f3a9c2e"],
      refuseStdinRead,
    );
    await expect(refused).rejects.toThrow(UsageError);
    await expect(refused).rejects.toThrow(
      "--url cannot be given with --plugin or --connection: give --plugin and --connection, or --url",
    );
  });

  it("refuses a command line whose flags pick no entry, a shared flag alone included", async () => {
    for (const argv of [[], ["--name", "work"]]) {
      const refused = parseArguments(thing, argv, refuseStdinRead);
      await expect(refused).rejects.toThrow(UsageError);
      await expect(refused).rejects.toThrow(
        "no flag says which form to use: give --plugin and --connection, or --url",
      );
    }
  });
});

describe("the help of a field of several shapes", () => {
  it("lists the flags of each entry under its lead line, a shared flag in both", () => {
    const lines = buildCommandHelp(thing);
    const from = lines.indexOf("flags:");
    const to = lines.indexOf("stdin:");
    expect(lines.slice(from, to)).toEqual([
      "flags:",
      "  From a plugin's Connection:",
      "  --plugin <text>      required",
      "      The plugin's contribution.",
      "  --connection <text>  required",
      "      The Connection to act as.",
      "  --name <text>        optional",
      "      The server's name.",
      "",
      "  By its address:",
      "  --url <text>         required",
      "      The server's address.",
      "  --name <text>        optional",
      "      The server's name.",
      "  --token-stdin        optional; read from stdin",
      "",
    ]);
  });

  it("describes the stdin flag once, in the stdin section", () => {
    const lines = buildCommandHelp(thing);
    expect(lines.filter((line) => line.includes("The token the server expects."))).toHaveLength(1);
    expect(lines).toContain("  There is no --token flag.");
  });
});

describe("a row of several shapes that does not fit its schema", () => {
  it("is refused when a member of the union has no entry", () => {
    expect(() => buildThingCommand([PLUGIN_ENTRY])).toThrow(
      'no entry stands for the member {"kind":"url"}',
    );
  });

  it("is refused when an entry's fixed values are the literal keys of no member", () => {
    expect(() =>
      buildThingCommand([PLUGIN_ENTRY, URL_ENTRY, { ...URL_ENTRY, fixed: { kind: "ftp" } }]),
    ).toThrow('the fixed values {"kind":"ftp"} are the literal keys of no member');
  });

  it("is refused when two entries stand for one member", () => {
    expect(() => buildThingCommand([PLUGIN_ENTRY, URL_ENTRY, URL_ENTRY])).toThrow(
      "two entries stand for one member",
    );
  });

  it("is refused when an entry names a key its member does not have", () => {
    const entry = {
      ...PLUGIN_ENTRY,
      flags: { ...PLUGIN_ENTRY.flags, url: { flag: "url", help: "x" } },
    };
    expect(() => buildThingCommand([entry, URL_ENTRY])).toThrow("url is not a key of the object");
  });

  it("is refused when an entry gives a required key of its member no flag", () => {
    const flags = {
      contributionId: PLUGIN_ENTRY.flags.contributionId,
      name: PLUGIN_ENTRY.flags.name,
    };
    expect(() => buildThingCommand([{ ...PLUGIN_ENTRY, flags }, URL_ENTRY])).toThrow(
      "connectionId is required by the object",
    );
  });

  it("is refused when one flag means different keys in different entries", () => {
    const entry = {
      ...URL_ENTRY,
      flags: { ...URL_ENTRY.flags, url: { flag: "plugin", help: "x" } },
    };
    expect(() => buildThingCommand([PLUGIN_ENTRY, entry])).toThrow(
      "--plugin means something different in different entries",
    );
  });

  it("is refused when the entries read different flags from stdin", () => {
    const entry = {
      ...PLUGIN_ENTRY,
      flags: {
        ...PLUGIN_ENTRY.flags,
        connectionId: { flag: "connection", help: "x", stdin: true },
      },
    } satisfies ObjectFlagsRow & { help: string };
    expect(() => buildThingCommand([entry, URL_ENTRY])).toThrow(
      "the entries read different flags from stdin",
    );
  });
});
