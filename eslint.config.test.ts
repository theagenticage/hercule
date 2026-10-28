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
});
