import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL(".", import.meta.url));
const eslint = new ESLint({ cwd: root });

/** The start of the message of the rule that refuses a schema built inside a function. */
const inlineSchemaMessage = "This builds a new schema on every call";

/**
 * Lints `code` as if it were the file at `filePath`, with the repository's real
 * config, and returns the line of each report of the inline schema rule.
 */
const lintInlineSchemaLines = async (code: string, filePath: string): Promise<number[]> => {
  const results = await eslint.lintText(code, { filePath: `${root}${filePath}` });
  return results
    .flatMap((result) => result.messages)
    .filter((message) => message.message.startsWith(inlineSchemaMessage))
    .map((message) => message.line);
};

describe("the inline schema rule", () => {
  const filePath = "apps/controller/src/x.ts";

  it("refuses a schema built in the call, in a function, an arrow and a generator", async () => {
    const code = [
      'import { Schema } from "effect";',
      "export function decodeInFunction(text: string) {",
      "  return Schema.decodeUnknownEffect(Schema.fromJsonString(Shape))(text);",
      "}",
      "export const decodeInArrow = (text: string) =>",
      "  Schema.decodeUnknownEffect(Schema.fromJsonString(Shape))(text);",
      "export const decodeInGenerator = Effect.gen(function* () {",
      "  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Shape))(text);",
      "});",
    ].join("\n");
    expect(await lintInlineSchemaLines(code, filePath)).toEqual([3, 6, 8]);
  });

  it("refuses Schema.is on a schema built in the call", async () => {
    const code = 'export const check = (value: unknown) => Schema.is(Schema.Literal("a"))(value);';
    expect(await lintInlineSchemaLines(code, filePath)).toEqual([1]);
  });

  it("refuses Schema.asserts on a schema built in the call", async () => {
    const code =
      'export const check = (value: unknown) => Schema.asserts(Schema.Literal("a"), value);';
    expect(await lintInlineSchemaLines(code, filePath)).toEqual([1]);
  });

  it("accepts schema builders such as decodeTo in a function, since they compile nothing", async () => {
    const code =
      "export const buildShape = (fields: Fields) => Schema.String.pipe(Schema.decodeTo(Schema.Struct(fields)));";
    expect(await lintInlineSchemaLines(code, filePath)).toEqual([]);
  });

  it("accepts a schema built at module level, and one built once and used in a function", async () => {
    const code = [
      "const decodeShape = Schema.decodeUnknownEffect(Schema.fromJsonString(Shape));",
      "export const decodeWithModuleSchema = (text: string) =>",
      "  Schema.decodeUnknownEffect(Shape)(text);",
      "export const decodeWithModuleDecoder = (text: string) => decodeShape(text);",
    ].join("\n");
    expect(await lintInlineSchemaLines(code, filePath)).toEqual([]);
  });
});

/** The start of the message of the fence around the copy of T3 Code's ACP client. */
const acpFenceMessage = "The copy of T3 Code's ACP client is imported only in";

/**
 * Lints `code` as if it were the file at `filePath`, with the repository's real
 * config, and returns the line of each report of the ACP fence, whose text follows the specifier for a static import.
 */
const lintAcpFenceLines = async (code: string, filePath: string): Promise<number[]> => {
  const results = await eslint.lintText(code, { filePath: `${root}${filePath}` });
  return results
    .flatMap((result) => result.messages)
    .filter((message) => message.message.includes(acpFenceMessage))
    .map((message) => message.line);
};

describe("the fence around the copy of T3 Code's ACP client", () => {
  const vendorPath = "../../packages/acp/vendor/effect-acp/src/client.ts";

  it.each([
    ["a runner file", "apps/runner/src/x.ts", `import { make } from "${vendorPath}";`],
    [
      "a test of the package, with `import type`",
      "packages/acp/src/connection.test.ts",
      'import type { Frame } from "../vendor/effect-acp/src/protocol.ts";',
    ],
    [
      "a web app file, by a path through node_modules",
      "apps/web/src/x.ts",
      'import { make } from "../node_modules/@hercule/acp/vendor/effect-acp/src/client.ts";',
    ],
    [
      "a desktop renderer file, by an absolute path",
      "apps/desktop/src/renderer/x.ts",
      'import { make } from "/repo/packages/acp/vendor/effect-acp/src/client.ts";',
    ],
    [
      "a desktop main file, by a subpath of the package",
      "apps/desktop/src/main/x.ts",
      'import { make } from "@hercule/acp/src/connection.ts";',
    ],
    ["a tooling script, by a re-export", "scripts/x.ts", `export * from "${vendorPath}";`],
    [
      "a controller file, by a dynamic import",
      "apps/controller/src/x.ts",
      `export const load = () => import("${vendorPath}");`,
    ],
    [
      "a controller file, by an import type",
      "apps/controller/src/x.ts",
      `export type Make = typeof import("${vendorPath}").make;`,
    ],
    [
      "a web app file, by require",
      "apps/web/src/x.ts",
      `export const make = require("${vendorPath}");`,
    ],
  ])("refuses %s", async (_, filePath, code) => {
    expect(await lintAcpFenceLines(code, filePath)).toEqual([1]);
  });

  it("allows packages/acp/src/connection.ts to import the copy", async () => {
    const code = [
      'import { make } from "../vendor/effect-acp/src/client.ts";',
      'import type { Frame } from "../vendor/effect-acp/src/protocol.ts";',
      `export const load = () => import("${vendorPath}");`,
    ].join("\n");
    expect(await lintAcpFenceLines(code, "packages/acp/src/connection.ts")).toEqual([]);
  });

  it("allows the package's index and its testing entrypoint to every other file", async () => {
    const code = [
      'import { openAcpConnection } from "@hercule/acp";',
      'import { createFakeHarness } from "@hercule/acp/testing";',
    ].join("\n");
    expect(await lintAcpFenceLines(code, "apps/runner/src/x.ts")).toEqual([]);
    expect(await lintAcpFenceLines(code, "apps/web/src/x.ts")).toEqual([]);
  });
});

/** The part of a flat config block that this test reads. */
interface ConfigBlock {
  readonly files?: readonly unknown[];
  readonly rules?: Readonly<Record<string, unknown>>;
}

/** Returns the message of each selector object among the options of a `no-restricted-syntax` setting. */
const readMessages = (setting: unknown): unknown[] =>
  Array.isArray(setting)
    ? (setting as unknown[]).flatMap((option) =>
        typeof option === "object" && option !== null && "message" in option
          ? [option.message]
          : [],
      )
    : [];

describe("the config", () => {
  // A block's `no-restricted-syntax` options replace the earlier blocks', so a
  // block that lists its own selectors without the inline schema rule would
  // switch the rule off for the files it matches.
  it("keeps the inline schema rule in every block that sets no-restricted-syntax", async () => {
    // The config is plain JavaScript with no declaration file, so the import
    // path is not a literal and the result is cast.
    const configUrl = new URL("eslint.config.js", import.meta.url).href;
    const { default: config } = (await import(configUrl)) as {
      default: readonly ConfigBlock[];
    };
    const blocks = config.filter((block) => block.rules?.["no-restricted-syntax"] !== undefined);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const messages = readMessages(block.rules?.["no-restricted-syntax"]);
      expect(messages, `block for ${JSON.stringify(block.files)}`).toContainEqual(
        expect.stringContaining(inlineSchemaMessage),
      );
    }
  });

  // A block's `no-restricted-imports` options replace the earlier blocks', so
  // a block that lists its own without the ACP fence would switch the fence
  // off for the files it matches. The one file that imports the copy is the
  // only block without it.
  it("keeps the ACP fence in every block that sets no-restricted-imports or no-restricted-syntax", async () => {
    const configUrl = new URL("eslint.config.js", import.meta.url).href;
    const { default: config } = (await import(configUrl)) as {
      default: readonly ConfigBlock[];
    };
    const fenced = (setting: unknown): boolean => JSON.stringify(setting).includes(acpFenceMessage);
    for (const rule of ["no-restricted-imports", "no-restricted-syntax"]) {
      const blocks = config.filter((block) => block.rules?.[rule] !== undefined);
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        const isConnection = JSON.stringify(block.files) === '["packages/acp/src/connection.ts"]';
        expect(fenced(block.rules?.[rule]), `${rule} of ${JSON.stringify(block.files)}`).toBe(
          !isConnection,
        );
      }
    }
  });
});
