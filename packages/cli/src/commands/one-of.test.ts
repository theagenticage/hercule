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

/**
 * Three shapes of a thing, where `name` is shared by `b` and `c` only and
 * `color` takes the same values in both of them.
 */
const Three = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("a"), a: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("b"),
    b: Schema.String,
    name: Schema.optionalKey(Schema.String),
    color: Schema.optionalKey(Schema.Literals(["red", "green"])),
  }),
  Schema.Struct({
    kind: Schema.Literal("c"),
    c: Schema.String,
    name: Schema.optionalKey(Schema.String),
    color: Schema.optionalKey(Schema.Literals(["red", "green"])),
  }),
]);

const ENTRY_A = {
  help: "Form a:",
  fixed: { kind: "a" },
  flags: { a: { flag: "a", help: "The a." } },
};
const ENTRY_B = {
  help: "Form b:",
  fixed: { kind: "b" },
  flags: {
    b: { flag: "b", help: "The b." },
    name: { flag: "name", help: "The name." },
    color: { flag: "color", help: "The color." },
  },
};
const ENTRY_C = {
  help: "Form c:",
  fixed: { kind: "c" },
  flags: {
    c: { flag: "c", help: "The c." },
    name: { flag: "name", help: "The name." },
    color: { flag: "color", help: "The color." },
  },
};

const buildThreeCommand = (
  union: Schema.Top,
  entries: ReadonlyArray<ObjectFlagsRow & { readonly help: string }>,
) =>
  buildCommand(
    "mcpServer.create",
    {
      command: "thing create",
      help: "Creates a thing.",
      examples: [{ args: ["--a", "x"] }],
      fields: { source: { oneOf: entries } },
    },
    { requires: "mcp.manage", method: "POST", path: "/things" },
    HttpApiEndpoint.post("create", "/things", {
      payload: Schema.Struct({ source: union }),
      success: Schema.Struct({}),
    }),
  );

describe("a flag given that the picked entry does not take", () => {
  const three = buildThreeCommand(Three, [ENTRY_A, ENTRY_B, ENTRY_C]);

  it("is refused, and not dropped, when other entries share it", async () => {
    const refused = parseArguments(three, ["--a", "x", "--name", "work"], refuseStdinRead);
    await expect(refused).rejects.toThrow(UsageError);
    await expect(refused).rejects.toThrow(
      "--name cannot be given with --a: that form has no --name",
    );
  });

  it("is sent when the picked entry declares it", async () => {
    const args = await parseArguments(
      three,
      ["--c", "x", "--name", "work", "--color", "red"],
      refuseStdinRead,
    );
    expect(args.payload).toEqual({ source: { kind: "c", c: "x", name: "work", color: "red" } });
  });
});

describe("a row whose entries cannot be told apart or parsed alike", () => {
  it("is refused when an entry has only flags that other entries declare, so none could pick it", () => {
    expect(() =>
      buildThreeCommand(
        Schema.Union([
          Schema.Struct({ kind: Schema.Literal("a"), name: Schema.String }),
          Schema.Struct({ kind: Schema.Literal("b"), name: Schema.String }),
        ]),
        [
          {
            help: "Form a:",
            fixed: { kind: "a" },
            flags: { name: { flag: "name", help: "The name." } },
          },
          {
            help: "Form b:",
            fixed: { kind: "b" },
            flags: { name: { flag: "name", help: "The name." } },
          },
        ],
      ),
    ).toThrow('the entry "Form a:" has no flag of its own');
  });

  it("is refused when a shared flag allows different values in different entries", () => {
    const Divergent = Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("b"),
        b: Schema.String,
        color: Schema.optionalKey(Schema.Literals(["red", "green"])),
      }),
      Schema.Struct({
        kind: Schema.Literal("c"),
        c: Schema.String,
        color: Schema.optionalKey(Schema.Literals(["red", "blue"])),
      }),
    ]);
    const color = ENTRY_B.flags.color;
    expect(() =>
      buildThreeCommand(Divergent, [
        { ...ENTRY_B, flags: { b: ENTRY_B.flags.b, color } },
        { ...ENTRY_C, flags: { c: ENTRY_C.flags.c, color } },
      ]),
    ).toThrow("--color means something different in different entries");
  });

  it("is refused when a shared flag is a different kind in different entries", () => {
    const Mixed = Schema.Union([
      Schema.Struct({ kind: Schema.Literal("b"), b: Schema.String, size: Schema.String }),
      Schema.Struct({ kind: Schema.Literal("c"), c: Schema.String, size: Schema.Number }),
    ]);
    const size = { flag: "size", help: "The size." };
    expect(() =>
      buildThreeCommand(Mixed, [
        { help: "Form b:", fixed: { kind: "b" }, flags: { b: ENTRY_B.flags.b, size } },
        { help: "Form c:", fixed: { kind: "c" }, flags: { c: ENTRY_C.flags.c, size } },
      ]),
    ).toThrow("--size means something different in different entries");
  });
});
